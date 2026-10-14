// runs-incremental: walk /runs newest first until the stored cursor id is reached.
// beta-runs: the global feed only lists runs on approved maps, so every known
// non-approved map gets its own /runs?mapID=X incremental walk.
//
// Note: the live API ignores the gamemode filter on /runs (verified against the
// backend source: PastRunsService.getAll never applies it), so the archive filters
// by ARCHIVE_GAMEMODES client side and keeps the raw pages for everything.
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { maps } from '../../db/schema.js';
import type { MomPastRun, MomUserSummary } from '../../momentum/types.js';
import type { PollerContext } from '../context.js';
import {
  enqueueReplayFor,
  freshSteamName,
  observeMap,
  observeRun,
  observeUsers,
  upsertLeaderboardEntry,
} from '../observe.js';
import { enqueueLeaderboardRefresh, enqueueRefresh, PRIORITY } from '../queue.js';
import type { JobResult } from '../scheduler.js';
import { ensureAvatarArchived, getCursor, identityFromUser, setCursor } from './helpers.js';
import { execRows } from '../../db/index.js';

export interface IngestStats {
  seen: number;
  stored: number;
  newRuns: number;
  newReplays: number;
  maxId: number;
}

/** Store one page of PastRuns. Returns counters. Non archived gamemodes are skipped. */
export async function ingestRuns(
  ctx: PollerContext,
  page: MomPastRun[],
  stats: IngestStats,
): Promise<void> {
  const observedAt = new Date();
  const archived = new Set(ctx.cfg.ARCHIVE_GAMEMODES);
  // Only runs in archived gamemodes get their embedded user and map observed. The global
  // feed is 99 percent other gamemodes; writing all of those users makes the backfill
  // database bound for no gain, and the users phase and the sweeps cover everyone anyway.
  const embeddedUsers: MomUserSummary[] = [];
  for (const r of page) if (r.user && archived.has(r.gamemode)) embeddedUsers.push(r.user);
  await observeUsers(ctx.db, embeddedUsers, observedAt);

  const seenMaps = new Set<number>();
  for (const r of page) {
    stats.seen += 1;
    if (r.id > stats.maxId) stats.maxId = r.id;
    if (!archived.has(r.gamemode)) continue;
    if (r.map && !seenMaps.has(r.map.id)) {
      seenMaps.add(r.map.id);
      await observeMap(ctx.db, r.map, observedAt, ctx.cfg.ARCHIVE_GAMEMODES);
    }
    const id = identityFromUser(r.user);
    const steamName = await freshSteamName(ctx.db, id.steamId);
    const isNew = await observeRun(ctx.db, r, observedAt, {
      alias: id.alias,
      avatarHash: id.avatarHash,
      steamName,
    });
    stats.stored += 1;
    if (!isNew) continue;
    stats.newRuns += 1;
    const key = {
      mapId: r.mapID,
      gamemode: r.gamemode,
      trackType: r.trackType,
      trackNum: r.trackNum,
      style: r.style,
    };
    if (r.leaderboardRun) {
      await upsertLeaderboardEntry(
        ctx.db,
        key,
        { ...r.leaderboardRun, userID: r.userID, pastRunID: r.id },
        observedAt,
        id,
      );
      if (r.leaderboardRun.replayHash) {
        const queued = await enqueueReplayFor(
          ctx.db,
          key,
          { ...r.leaderboardRun, userID: r.userID, pastRunID: r.id },
          r.map?.name ?? null,
          {
            ...id,
            steamName,
          },
        );
        if (queued) stats.newReplays += 1;
      }
    }
    await enqueueRefresh(ctx.db, 'user', r.userID, PRIORITY.normal);
    await enqueueLeaderboardRefresh(ctx.db, key, PRIORITY.normal);
    await ensureAvatarArchived(ctx, id.avatarHash, 'momentum');
  }
  // Maps we only know from the embedded summary get a full detail fetch.
  if (seenMaps.size > 0) {
    const rows = await ctx.db
      .select({ id: maps.id })
      .from(maps)
      .where(and(sql`${maps.id} in ${[...seenMaps]}`, eq(maps.detailFetched, false)));
    for (const m of rows) await enqueueRefresh(ctx.db, 'map', m.id, PRIORITY.high);
  }
}

interface RunsCursor extends Record<string, unknown> {
  lastMaxId: number;
}

export async function runsIncremental(ctx: PollerContext): Promise<JobResult> {
  const cursor = await getCursor<RunsCursor>(ctx.db, 'runs-incremental');
  const lastMaxId = cursor?.lastMaxId ?? 0;
  const stats: IngestStats = { seen: 0, stored: 0, newRuns: 0, newReplays: 0, maxId: lastMaxId };
  let pages = 0;
  const maxPages = lastMaxId === 0 ? 5 : 2000;
  for await (const { page } of ctx.mom.pages<MomPastRun>('/runs', {
    orderBy: 'createdAt',
    order: 'desc',
    expand: 'user,map,leaderboardRun',
  })) {
    pages += 1;
    const fresh = page.data.filter((r) => r.id > lastMaxId);
    await ingestRuns(ctx, fresh, stats);
    if (fresh.length < page.data.length || pages >= maxPages) break;
  }
  if (stats.maxId > lastMaxId)
    await setCursor(ctx.db, 'runs-incremental', { lastMaxId: stats.maxId });
  return {
    seen: stats.seen,
    new: stats.newRuns,
    note: `replays=${stats.newReplays} pages=${pages}`,
  };
}

interface BetaCursor extends Record<string, unknown> {
  perMap: Record<string, number>;
}

/** Per map incremental walk for maps that are not approved (beta, testing, disabled). */
export async function betaRuns(ctx: PollerContext): Promise<JobResult> {
  const cursor = (await getCursor<BetaCursor>(ctx.db, 'beta-runs')) ?? { perMap: {} };
  const betaMaps = await ctx.db
    .select({ id: maps.id })
    .from(maps)
    .where(and(ne(maps.status, 0), eq(maps.archived, true), isNull(maps.notFoundAt)));
  const stats: IngestStats = { seen: 0, stored: 0, newRuns: 0, newReplays: 0, maxId: 0 };
  for (const m of betaMaps) {
    const lastMaxId = cursor.perMap[String(m.id)] ?? 0;
    let maxId = lastMaxId;
    let pages = 0;
    try {
      for await (const { page } of ctx.mom.pages<MomPastRun>('/runs', {
        mapID: m.id,
        orderBy: 'createdAt',
        order: 'desc',
        expand: 'user,map,leaderboardRun',
      })) {
        pages += 1;
        const fresh = page.data.filter((r) => r.id > lastMaxId);
        const local: IngestStats = { seen: 0, stored: 0, newRuns: 0, newReplays: 0, maxId };
        await ingestRuns(ctx, fresh, local);
        stats.seen += local.seen;
        stats.newRuns += local.newRuns;
        stats.newReplays += local.newReplays;
        maxId = Math.max(maxId, local.maxId);
        if (fresh.length < page.data.length || pages >= 500) break;
      }
    } catch (e) {
      ctx.log.warn('beta runs walk failed for map', { mapId: m.id, error: (e as Error).message });
      continue;
    }
    cursor.perMap[String(m.id)] = maxId;
    await setCursor(ctx.db, 'beta-runs', cursor);
  }
  return {
    seen: stats.seen,
    new: stats.newRuns,
    note: `maps=${betaMaps.length} replays=${stats.newReplays}`,
  };
}

/** Replays referenced by current leaderboard entries that are neither archived nor queued nor failed. */
export async function missingReplayCount(ctx: PollerContext): Promise<number> {
  const rows = (await execRows(
    ctx.db,
    sql`
    select count(*)::int as n from leaderboard_entries e
    where e.removed_at is null and e.replay_hash is not null
      and not exists (select 1 from replays r where r.sha1 = e.replay_hash)
      and not exists (select 1 from replay_queue q where q.sha1 = e.replay_hash)
  `,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}
