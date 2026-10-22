// traffic-rollup: folds request_log into per day totals and per day top lists
// (traffic_days, traffic_day_keys). Today and yesterday are recomputed on every
// tick, and any older day still in the log without a rollup is filled in, so the
// first run after deploy covers the whole retention window. Nothing identifying
// is copied: IPs only ever become distinct counts, user agents only ever become
// a browser, OS, device or bot name.
import { sql } from 'drizzle-orm';
import { execRows } from '../../db/index.js';
import { trafficDayKeys, trafficDays } from '../../db/schema.js';
import type { PollerContext } from '../context.js';
import type { JobResult, ProgressFn } from '../scheduler.js';

/** Anything that announces itself as automated, plus the usual HTTP libraries. */
export const BOT_UA =
  'bot|crawl|spider|slurp|scrape|curl|wget|python|httpx|aiohttp|go-http|okhttp|java/|libwww|axios|node-fetch|undici|headless|phantom|lighthouse|preview|facebookexternalhit|embedly|discord|telegram|whatsapp|monitor|uptime|feed|rss|postman|insomnia';

const TOP_PER_KIND = 200;

interface KeyRow {
  kind: string;
  key: string;
  n: number;
  uniq: number;
}

export function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}

export function osOf(ua: string): string {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}

export function deviceOf(ua: string): string {
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod/.test(ua)) return 'mobile';
  return 'desktop';
}

/** A short family name for a bot user agent: the product token that gave it away. */
export function botName(ua: string | null): string {
  if (!ua) return '(no user agent)';
  const m = /([A-Za-z][A-Za-z0-9._-]*(?:bot|crawler|spider|Slurp))/i.exec(ua);
  if (m) return m[1]!.slice(0, 40);
  const first = /^([A-Za-z][A-Za-z0-9._-]*)/.exec(ua);
  return (first?.[1] ?? 'other').slice(0, 40);
}

function decodeTerm(raw: string): string | null {
  try {
    const t = decodeURIComponent(raw.replace(/\+/g, ' ')).trim().toLowerCase().replace(/\s+/g, ' ');
    return t.length > 0 ? t.slice(0, 100) : null;
  } catch {
    return null;
  }
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Adds rows into a kind:key map, summing counts. */
function merge(into: Map<string, KeyRow>, kind: string, key: string, n: number, uniq: number) {
  const id = `${kind}\u0000${key}`;
  const r = into.get(id);
  if (r) {
    r.n += n;
    r.uniq += uniq;
  } else into.set(id, { kind, key, n, uniq });
}

export async function rollupDay(ctx: PollerContext, day: string): Promise<{ pageviews: number }> {
  const db = ctx.db;
  const range = sql`r.at >= (${day}::date)::timestamp at time zone 'UTC'
    and r.at < ((${day}::date) + 1)::timestamp at time zone 'UTC' and not r.admin`;
  const bot = sql`(r.user_agent is null or r.user_agent ~* ${BOT_UA})`;
  const pv = sql`r.path like '/api/pv%' and r.status < 400`;

  const [t] = (await execRows(
    db,
    sql`select count(*)::int as requests,
               count(*) filter (where not ${bot})::int as human_requests,
               count(*) filter (where ${bot})::int as bot_requests,
               count(distinct r.ip)::int as api_clients,
               count(distinct r.ip) filter (where ${pv} and not ${bot})::int as visitors,
               count(*) filter (where ${pv} and not ${bot})::int as pageviews,
               count(*) filter (where r.status >= 500)::int as errors,
               count(*) filter (where r.status = 429)::int as rate_limited,
               coalesce(sum(r.bytes), 0)::bigint as bytes,
               coalesce(round(avg(r.ms)), 0)::int as avg_ms,
               coalesce(round(percentile_cont(0.95) within group (order by r.ms)), 0)::int as p95_ms
        from request_log r where ${range}`,
  )) as unknown as Record<string, number | string>[];

  const keys = new Map<string, KeyRow>();
  const add = (rows: Record<string, unknown>[], kind?: string) => {
    for (const r of rows)
      merge(keys, kind ?? String(r.kind), String(r.key), Number(r.n), Number(r.uniq));
  };

  // Pages and the things on them, straight from the beacon path.
  add(
    (await execRows(
      db,
      sql`select k.kind, k.key, count(*)::int as n, count(distinct r.ip)::int as uniq
          from request_log r
          cross join lateral (values
            ('page', coalesce(nullif(regexp_replace(rtrim(substr(r.path, 8), '/'),
              '^/(maps|users|runs|watch|ledger|reports)/[^/]+', '/\\1/:id'), ''), '/')),
            ('user', substring(r.path from '^/api/pv/users/([0-9]+)')),
            ('map', substring(r.path from '^/api/pv/maps/([^/]+)')),
            ('run', substring(r.path from '^/api/pv/runs/([0-9]+)')),
            ('watch', substring(r.path from '^/api/pv/watch/([0-9a-f]{40})')),
            ('ledger', substring(r.path from '^/api/pv/ledger/([a-z0-9-]+)')),
            ('country', r.country)
          ) as k(kind, key)
          where ${range} and ${pv} and not ${bot} and k.key is not null
          group by 1, 2`,
    )) as unknown as Record<string, unknown>[],
  );

  // Referrers: the beacon carries document.referrer on the first page of a visit.
  const own = new URL(ctx.cfg.PUBLIC_BASE_URL).hostname;
  const refs = (await execRows(
    db,
    sql`select substring(r.query from '(?:^|&)r=([^&]*)') as raw, count(*)::int as n,
               count(distinct r.ip)::int as uniq
        from request_log r where ${range} and ${pv} and not ${bot} and r.query like '%r=%'
        group by 1`,
  )) as unknown as { raw: string | null; n: number; uniq: number }[];
  for (const r of refs) {
    if (!r.raw) continue;
    let host: string | null = null;
    try {
      host = new URL(decodeURIComponent(r.raw)).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      host = null;
    }
    if (!host || host === own || host.endsWith(`.${own}`)) continue;
    merge(keys, 'referrer', host.slice(0, 100), r.n, r.uniq);
  }

  // Browsers, systems and devices of people who loaded pages.
  const agents = (await execRows(
    db,
    sql`select r.user_agent as ua, count(*)::int as n, count(distinct r.ip)::int as uniq
        from request_log r where ${range} and ${pv} and not ${bot} group by 1`,
  )) as unknown as { ua: string; n: number; uniq: number }[];
  for (const a of agents) {
    merge(keys, 'browser', browserOf(a.ua), a.n, a.uniq);
    merge(keys, 'os', osOf(a.ua), a.n, a.uniq);
    merge(keys, 'device', deviceOf(a.ua), a.n, a.uniq);
  }

  // Bots, by the name they give.
  const bots = (await execRows(
    db,
    sql`select r.user_agent as ua, count(*)::int as n, count(distinct r.ip)::int as uniq
        from request_log r where ${range} and ${bot} group by 1 order by 2 desc limit 2000`,
  )) as unknown as { ua: string | null; n: number; uniq: number }[];
  for (const b of bots) merge(keys, 'bot', botName(b.ua), b.n, b.uniq);

  // What people type in the search boxes.
  const searches = (await execRows(
    db,
    sql`select substring(r.query from '(?:^|&)q=([^&]*)') as raw, count(*)::int as n,
               count(distinct r.ip)::int as uniq
        from request_log r
        where ${range} and not ${bot} and r.status = 200 and r.route in ('/api/search', '/api/users')
          and r.query like '%q=%'
        group by 1`,
  )) as unknown as { raw: string | null; n: number; uniq: number }[];
  for (const s of searches) {
    const term = s.raw ? decodeTerm(s.raw) : null;
    if (term) merge(keys, 'search', term, s.n, s.uniq);
  }

  // API usage by route and by status, the beacon left out.
  add(
    (await execRows(
      db,
      sql`select 'route' as kind, r.route as key, count(*)::int as n, count(distinct r.ip)::int as uniq
          from request_log r where ${range} and r.path not like '/api/pv%' group by 2
          union all
          select 'status', r.status::text, count(*)::int, count(distinct r.ip)::int
          from request_log r where ${range} group by 2`,
    )) as unknown as Record<string, unknown>[],
  );

  // Keep the top of each list; the long tail is noise.
  const byKind = new Map<string, KeyRow[]>();
  for (const r of keys.values()) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  const rows: KeyRow[] = [];
  for (const list of byKind.values()) {
    list.sort((a, b) => b.n - a.n);
    rows.push(...list.slice(0, TOP_PER_KIND));
  }

  const totals = t ?? {};
  await db.transaction(async (tx) => {
    await tx.delete(trafficDayKeys).where(sql`${trafficDayKeys.day} = ${day}`);
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(trafficDayKeys)
        .values(rows.slice(i, i + 500).map((r) => ({ day, ...r, key: r.key.slice(0, 200) })));
    }
    const values = {
      requests: Number(totals.requests ?? 0),
      humanRequests: Number(totals.human_requests ?? 0),
      botRequests: Number(totals.bot_requests ?? 0),
      apiClients: Number(totals.api_clients ?? 0),
      visitors: Number(totals.visitors ?? 0),
      pageviews: Number(totals.pageviews ?? 0),
      errors: Number(totals.errors ?? 0),
      rateLimited: Number(totals.rate_limited ?? 0),
      bytes: Number(totals.bytes ?? 0),
      avgMs: Number(totals.avg_ms ?? 0),
      p95Ms: Number(totals.p95_ms ?? 0),
      computedAt: new Date(),
    };
    await tx
      .insert(trafficDays)
      .values({ day, ...values })
      .onConflictDoUpdate({ target: trafficDays.day, set: values });
  });
  return { pageviews: Number(totals.pageviews ?? 0) };
}

export async function trafficRollup(
  ctx: PollerContext,
  signal: AbortSignal = ctx.scheduler.signal,
  progress: ProgressFn = () => {},
): Promise<JobResult> {
  const now = new Date();
  const today = utcDay(now);
  const yesterday = utcDay(new Date(now.getTime() - 86400_000));
  // Older days still in the raw log that were never rolled up (first run, or the
  // poller was down at midnight).
  const missing = (await execRows(
    ctx.db,
    sql`select d::date::text as day
        from generate_series(
          (select coalesce(min(at), now()) from request_log)::date,
          (${yesterday}::date) - 1, interval '1 day') as d
        where not exists (select 1 from traffic_days t where t.day = d::date)`,
  )) as unknown as { day: string }[];
  const days = [...missing.map((m) => m.day), yesterday, today];
  let pageviews = 0;
  for (const [i, day] of days.entries()) {
    if (signal.aborted) break;
    progress({ done: i, total: days.length, note: day });
    const r = await rollupDay(ctx, day);
    if (day === today) pageviews = r.pageviews;
  }
  return { seen: days.length, note: `today_pageviews=${pageviews}` };
}
