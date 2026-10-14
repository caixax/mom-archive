// search-refresh: rebuild the search_index materialized view.
// storage-summary: count objects and bytes per prefix once a day for /api/status and /api/stats.
import { sql } from 'drizzle-orm';
import { kv } from '../../db/schema.js';
import { errMsg } from '../../logger.js';
import type { PollerContext } from '../context.js';
import type { JobResult } from '../scheduler.js';
import { execRows } from '../../db/index.js';

export async function searchRefresh(ctx: PollerContext): Promise<JobResult> {
  const t = Date.now();
  try {
    await execRows(ctx.db, sql`refresh materialized view concurrently search_index`);
  } catch (e) {
    // CONCURRENTLY needs the view to be populated once; fall back on the first run.
    ctx.log.debug('concurrent refresh failed, trying plain refresh', { error: errMsg(e) });
    await execRows(ctx.db, sql`refresh materialized view search_index`);
  }
  const [row] = (await execRows(
    ctx.db,
    sql`select count(*)::int as n from search_index`,
  )) as unknown as { n: number }[];
  return { seen: row?.n ?? 0, note: `ms=${Date.now() - t}` };
}

export async function setKv(
  ctx: PollerContext,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .insert(kv)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export async function storageSummary(ctx: PollerContext): Promise<JobResult> {
  const prefixes = ['replays/', 'avatars/', 'maps/images/', 'maps/bsp/', 'raw/'];
  const out: Record<string, { count: number; bytes: number }> = {};
  let total = 0;
  let bytes = 0;
  for (const p of prefixes) {
    const s = await ctx.storage.summarize(p);
    out[p] = s;
    total += s.count;
    bytes += s.bytes;
  }
  await setKv(ctx, 'storage-summary', {
    prefixes: out,
    total,
    bytes,
    at: new Date().toISOString(),
  });
  return { seen: total, note: `bytes=${bytes}` };
}

/** Removes refresh items that keep failing and poll_log rows older than 90 days. */
export async function housekeeping(ctx: PollerContext): Promise<JobResult> {
  const a = (await execRows(
    ctx.db,
    sql`delete from poll_log where started_at < now() - interval '90 days' returning id`,
  )) as unknown as unknown[];
  const b = (await execRows(
    ctx.db,
    sql`delete from refresh_queue where attempts >= 8 returning id`,
  )) as unknown as unknown[];
  return { seen: a.length + b.length, note: `poll_log=${a.length} refresh=${b.length}` };
}
