// Periodic sweeps: users (batched), maps, leaderboards, maps-walk (id probing), avatars.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { leaderboards, users } from '../../db/schema.js';
import { errMsg } from '../../logger.js';
import { MomApiError } from '../../momentum/client.js';
import type { MomMap } from '../../momentum/types.js';
import type { PollerContext } from '../context.js';
import { observeMap, observeUser } from '../observe.js';
import { enqueueRefresh, enqueueRefreshMany, PRIORITY } from '../queue.js';
import type { JobResult } from '../scheduler.js';
import {
  ensureAvatarArchived,
  ensureBspArchived,
  ensureMapImageArchived,
  fetchAndObserveMap,
  getCursor,
  identityFromUser,
  setCursor,
} from './helpers.js';
import { execRows } from '../../db/index.js';

/**
 * users-sweep: refresh every known user via GET /users?userIDs=...&expand=profile,userStats
 * (100 per call). Follows are re-fetched only for users active in the last 30 days.
 */
export async function usersSweep(ctx: PollerContext): Promise<JobResult> {
  const all = await ctx.db
    .select({ id: users.id, lastRunAt: users.lastRunAt })
    .from(users)
    .where(eq(users.isDeleted, false))
    .orderBy(asc(users.id));
  let seen = 0;
  let changed = 0;
  let missing = 0;
  const activeCutoff = Date.now() - 30 * 86400_000;
  const activeIds: number[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const ids = chunk.map((u) => u.id);
    let page;
    try {
      page = await ctx.mom.getUsersPage({ skip: 0, take: 100, userIDs: ids });
    } catch (e) {
      ctx.log.warn('users batch failed', {
        from: ids[0],
        to: ids[ids.length - 1],
        error: errMsg(e),
      });
      continue;
    }
    const observedAt = new Date();
    const returned = new Set<number>();
    for (const u of page.data) {
      returned.add(u.id);
      seen += 1;
      const r = await observeUser(ctx.db, u, observedAt);
      if (r.changes.length > 0) {
        changed += 1;
        ctx.log.info('user changed', {
          userId: u.id,
          fields: r.changes.map((c) => c.field).join(','),
        });
      }
      await ensureAvatarArchived(ctx, identityFromUser(u).avatarHash, 'momentum');
    }
    for (const u of chunk) {
      if (!returned.has(u.id)) {
        missing += 1;
        // Confirm with the single endpoint before flagging; the batch endpoint may cap results.
        await enqueueRefresh(ctx.db, 'user', u.id, PRIORITY.low);
      } else if (u.lastRunAt && u.lastRunAt.getTime() > activeCutoff) {
        activeIds.push(u.id);
      }
    }
  }
  await enqueueRefreshMany(ctx.db, 'follows', activeIds, PRIORITY.low);
  await enqueueRefreshMany(ctx.db, 'activities', activeIds, PRIORITY.low);
  return { seen, new: changed, note: `missing=${missing} follows_queued=${activeIds.length}` };
}

async function sweepMapsFrom(
  ctx: PollerContext,
  pages: AsyncGenerator<{ page: { data: MomMap[] } }>,
  stats: { seen: number; changed: number; newMaps: number },
): Promise<void> {
  for await (const { page } of pages) {
    const observedAt = new Date();
    for (const m of page.data) {
      stats.seen += 1;
      if (m.submitter) await observeUser(ctx.db, m.submitter, observedAt);
      for (const c of m.credits ?? []) if (c.user) await observeUser(ctx.db, c.user, observedAt);
      const r = await observeMap(ctx.db, m, observedAt, ctx.cfg.ARCHIVE_GAMEMODES);
      if (r.isNew) stats.newMaps += 1;
      if (r.changes.length > 0) {
        stats.changed += 1;
        ctx.log.info('map changed', {
          mapId: m.id,
          name: m.name,
          fields: r.changes
            .map((c) => c.field)
            .slice(0, 10)
            .join(','),
        });
      }
      for (const id of r.newImageIds) await ensureMapImageArchived(ctx, id);
      for (const id of r.newVersionIds) await ensureBspArchived(ctx, id);
    }
  }
}

/** maps-sweep: GET /maps?gamemode=G for each archived gamemode, plus /maps/submissions with a token. */
export async function mapsSweep(ctx: PollerContext): Promise<JobResult> {
  const stats = { seen: 0, changed: 0, newMaps: 0 };
  for (const gm of ctx.cfg.ARCHIVE_GAMEMODES) {
    await sweepMapsFrom(
      ctx,
      ctx.mom.pages<MomMap>('/maps', {
        gamemode: gm,
        expand: 'info,stats,leaderboards,currentVersion,versions,credits,submitter',
      }),
      stats,
    );
  }
  let submissions = 0;
  if (ctx.mom.hasToken) {
    try {
      const before = stats.seen;
      await sweepMapsFrom(
        ctx,
        ctx.mom.pages<MomMap>(
          '/maps/submissions',
          { expand: 'info,stats,leaderboards,currentVersion,versions,credits,submitter' },
          { auth: true },
        ),
        stats,
      );
      submissions = stats.seen - before;
    } catch (e) {
      ctx.log.warn('maps/submissions failed (token expired?)', { error: errMsg(e) });
    }
  }
  // Images that are still missing from storage (earlier failures, restarts)
  const pending = (await execRows(
    ctx.db,
    sql`select id from map_images where s3_key is null and removed_at is null and fetch_failed = false limit 200`,
  )) as unknown as { id: string }[];
  for (const p of pending) await ensureMapImageArchived(ctx, p.id);
  return {
    seen: stats.seen,
    new: stats.newMaps,
    note: `changed=${stats.changed} submissions=${submissions}`,
  };
}

/** leaderboards-full-sweep: enqueue a refresh for every archived leaderboard. */
export async function leaderboardsSweep(ctx: PollerContext): Promise<JobResult> {
  const rows = await ctx.db
    .select({
      mapId: leaderboards.mapId,
      gamemode: leaderboards.gamemode,
      trackType: leaderboards.trackType,
      trackNum: leaderboards.trackNum,
      style: leaderboards.style,
    })
    .from(leaderboards)
    .where(
      and(
        inArray(leaderboards.gamemode, ctx.cfg.ARCHIVE_GAMEMODES),
        isNull(leaderboards.removedAt),
      ),
    );
  const n = await enqueueRefreshMany(
    ctx.db,
    'leaderboard',
    rows.map((r) => `${r.mapId}:${r.gamemode}:${r.trackType}:${r.trackNum}:${r.style}`),
    PRIORITY.low,
  );
  return { seen: rows.length, new: n };
}

interface WalkCursor extends Record<string, unknown> {
  nextId: number;
  maxId: number;
  startedAt: string;
}

/** maps-walk: probe GET /maps/{id} for 1..max(known)+200 to find beta and unranked maps. */
export async function mapsWalk(ctx: PollerContext): Promise<JobResult> {
  const [mx] = (await execRows(
    ctx.db,
    sql`select coalesce(max(id), 0)::int as max from maps`,
  )) as unknown as { max: number }[];
  const upper = (mx?.max ?? 0) + 200;
  let cursor = await getCursor<WalkCursor>(ctx.db, 'maps-walk');
  if (!cursor || cursor.nextId > cursor.maxId)
    cursor = { nextId: 1, maxId: upper, startedAt: new Date().toISOString() };
  cursor.maxId = Math.max(cursor.maxId, upper);
  let seen = 0;
  let found = 0;
  let notFound = 0;
  for (let id = cursor.nextId; id <= cursor.maxId; id++) {
    if (ctx.scheduler.signal.aborted) break;
    seen += 1;
    try {
      const r = await fetchAndObserveMap(ctx, id);
      if (r === 'ok') found += 1;
      else notFound += 1;
    } catch (e) {
      if (e instanceof MomApiError && e.status === 404) notFound += 1;
      else ctx.log.warn('maps-walk probe failed', { mapId: id, error: errMsg(e) });
    }
    if (id % 50 === 0) await setCursor(ctx.db, 'maps-walk', { ...cursor, nextId: id + 1 });
  }
  await setCursor(ctx.db, 'maps-walk', { ...cursor, nextId: cursor.maxId + 1 });
  return { seen, new: found, note: `notFound=${notFound} range=1..${cursor.maxId}` };
}

/** avatars-fetch: archive any avatar hash we know about but have not stored yet. */
export async function avatarsFetch(ctx: PollerContext): Promise<JobResult> {
  const rows = (await execRows(
    ctx.db,
    sql`
    select h.hash, h.source from (
      select avatar_hash as hash, 'momentum' as source from users where avatar_hash is not null
      union
      select avatar_hash, 'steam' from steam_profiles where avatar_hash is not null
      union
      select avatar_hash, source from steam_avatar_history
    ) h
    where not exists (select 1 from avatars a where a.hash = h.hash)
      and not exists (select 1 from fetch_failures f where f.kind = 'avatar' and f.key = h.hash and (f.gave_up or f.last_at > now() - interval '1 hour'))
    limit 500
  `,
  )) as unknown as { hash: string; source: 'momentum' | 'steam' }[];
  for (const r of rows) {
    if (ctx.scheduler.signal.aborted) break;
    await ensureAvatarArchived(ctx, r.hash, r.source === 'steam' ? 'steam' : 'momentum');
  }
  const [count] = (await execRows(
    ctx.db,
    sql`select count(*)::int as n from avatars`,
  )) as unknown as { n: number }[];
  return { seen: rows.length, new: rows.length, note: `archived_total=${count?.n ?? 0}` };
}

/** Users seen embedded but never fetched in full get queued. */
export async function queueUnfetchedUsers(ctx: PollerContext): Promise<JobResult> {
  const rows = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.profileFetched, false), eq(users.isDeleted, false)))
    .limit(2000);
  const n = await enqueueRefreshMany(
    ctx.db,
    'user',
    rows.map((r) => r.id),
    PRIORITY.low,
  );
  return { seen: rows.length, new: n };
}
