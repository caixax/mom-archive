// The traffic rollup: page views, visitors, bots and top lists come out of the raw
// request log as counts, with no IP and no user agent copied anywhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { execRows } from '../src/db/index.js';
import type { PollerContext } from '../src/poller/context.js';
import { botName, browserOf, deviceOf, osOf, rollupDay } from '../src/poller/jobs/traffic.js';
import { createTestDb, type TestDb } from './db-helper.js';

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let t: TestDb;
let ctx: PollerContext;
const day = '2026-10-20';

async function hit(
  at: string,
  ip: string,
  path: string,
  ua: string | null,
  opts: { query?: string; status?: number; country?: string; admin?: boolean } = {},
) {
  await execRows(
    t.db,
    sql`insert into request_log (at, ip, country, method, path, route, query, status, ms, user_agent, admin)
        values (${at}::timestamptz, ${ip}, ${opts.country ?? null}, 'GET', ${path}, ${path.replace(/\/\d+/g, '/:id')},
                ${opts.query ?? null}, ${opts.status ?? 204}, 12, ${ua}, ${opts.admin ?? false})`,
  );
}

beforeAll(async () => {
  t = await createTestDb();
  ctx = {
    db: t.db,
    cfg: { PUBLIC_BASE_URL: 'https://momarchive.org' },
  } as unknown as PollerContext;
  await hit(`${day}T10:00:00Z`, '1.1.1.1', '/api/pv', FIREFOX, {
    query: 'r=https%3A%2F%2Fwww.reddit.com%2Fr%2Fmomentummod',
    country: 'ES',
  });
  await hit(`${day}T10:00:05Z`, '1.1.1.1', '/api/pv/users/14991', FIREFOX, { country: 'ES' });
  await hit(`${day}T10:00:09Z`, '2.2.2.2', '/api/pv/users/14991', IPHONE, { country: 'US' });
  await hit(`${day}T10:01:00Z`, '2.2.2.2', '/api/pv/maps/bhop_arcane', IPHONE, {
    query: 'r=https%3A%2F%2Fmomarchive.org%2F',
    country: 'US',
  });
  await hit(`${day}T10:02:00Z`, '2.2.2.2', '/api/search', IPHONE, {
    query: 'q=Mochi+Nushi',
    status: 200,
  });
  await hit(`${day}T10:03:00Z`, '9.9.9.9', '/api/pv/users/1', GOOGLEBOT);
  await hit(`${day}T10:04:00Z`, '9.9.9.9', '/api/users/1', GOOGLEBOT, { status: 200 });
  await hit(`${day}T10:05:00Z`, '3.3.3.3', '/api/admin/stats', FIREFOX, {
    status: 200,
    admin: true,
  });
  // The day after does not leak into this one.
  await hit('2026-10-21T00:00:01Z', '4.4.4.4', '/api/pv', FIREFOX);
});

afterAll(async () => {
  await t.close();
});

describe('traffic rollup', () => {
  it('counts pages, visitors and bots for one UTC day, panel traffic left out', async () => {
    await rollupDay(ctx, day);
    const [d] = (await execRows(
      t.db,
      sql`select * from traffic_days where day = ${day}`,
    )) as unknown as Record<string, number>[];
    expect(d).toMatchObject({
      pageviews: 4,
      visitors: 2,
      bot_requests: 2,
      requests: 7,
      api_clients: 3,
    });
  });

  it('builds the top lists, with own site referrers dropped', async () => {
    const rows = (await execRows(
      t.db,
      sql`select kind, key, n, uniq from traffic_day_keys where day = ${day} order by kind, key`,
    )) as unknown as { kind: string; key: string; n: number; uniq: number }[];
    const get = (kind: string) => rows.filter((r) => r.kind === kind);
    expect(get('user')).toEqual([{ kind: 'user', key: '14991', n: 2, uniq: 2 }]);
    expect(get('map').map((r) => r.key)).toEqual(['bhop_arcane']);
    expect(get('page').map((r) => [r.key, r.n])).toEqual([
      ['/', 1],
      ['/maps/:id', 1],
      ['/users/:id', 2],
    ]);
    expect(get('referrer').map((r) => r.key)).toEqual(['reddit.com']);
    expect(get('search')).toEqual([{ kind: 'search', key: 'mochi nushi', n: 1, uniq: 1 }]);
    expect(get('device').map((r) => r.key)).toEqual(['desktop', 'mobile']);
    expect(get('bot').map((r) => r.key)).toEqual(['Googlebot']);
    expect(get('country').map((r) => r.key)).toEqual(['ES', 'US']);
    for (const r of rows) expect(r.key).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('is idempotent', async () => {
    await rollupDay(ctx, day);
    const [n] = (await execRows(
      t.db,
      sql`select count(*)::int as n from traffic_day_keys where day = ${day} and kind = 'user'`,
    )) as unknown as { n: number }[];
    expect(n?.n).toBe(1);
  });

  it('names browsers, systems, devices and bots', () => {
    expect([browserOf(FIREFOX), osOf(FIREFOX), deviceOf(FIREFOX)]).toEqual([
      'Firefox',
      'Linux',
      'desktop',
    ]);
    expect([browserOf(IPHONE), osOf(IPHONE), deviceOf(IPHONE)]).toEqual([
      'Safari',
      'iOS',
      'mobile',
    ]);
    expect(botName(GOOGLEBOT)).toBe('Googlebot');
    expect(botName('curl/8.0')).toBe('curl');
    expect(botName(null)).toBe('(no user agent)');
  });
});
