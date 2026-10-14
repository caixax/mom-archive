// Shared pieces used by several jobs: cursors, binary archiving, full fetch + observe flows.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import {
  avatars,
  fetchFailures,
  mapImages,
  mapVersions,
  maps,
  runs,
  syncState,
  users,
} from '../../db/schema.js';
import { errMsg } from '../../logger.js';
import { MomApiError } from '../../momentum/client.js';
import { steamAvatarUrl, STEAM_MISSING_AVATAR } from '../../momentum/enums.js';
import { avatarHashFromUrl } from '../../momentum/steamid.js';
import type {
  LeaderboardKey,
  MomActivity,
  MomFollow,
  MomLeaderboardRun,
  MomUser,
  MomUserSummary,
} from '../../momentum/types.js';
import { keys } from '../../storage/s3.js';
import type { PollerContext } from '../context.js';
import {
  enqueueReplayFor,
  freshSteamName,
  observeActivities,
  observeFollows,
  observeLeaderboard,
  observeMap,
  observeUser,
  observeUsers,
  type BoardObserveResult,
} from '../observe.js';
import { enqueueRefresh, PRIORITY } from '../queue.js';
import { execRows } from '../../db/index.js';

export interface Identity {
  alias: string | null;
  avatarHash: string | null;
  steamId: string | null;
}

export function identityFromUser(u: MomUserSummary | undefined | null): Identity {
  if (!u) return { alias: null, avatarHash: null, steamId: null };
  return {
    alias: u.alias ?? null,
    avatarHash: avatarHashFromUrl(u.avatarURL),
    steamId: u.steamID ?? null,
  };
}

// Cursors

export async function getCursor<T extends Record<string, unknown>>(
  db: Db,
  job: string,
): Promise<T | null> {
  const [row] = await db
    .select({ cursor: syncState.cursor })
    .from(syncState)
    .where(eq(syncState.job, job));
  return (row?.cursor as T | undefined) ?? null;
}

export async function setCursor(
  db: Db,
  job: string,
  cursor: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(syncState)
    .values({ job, cursor, updatedAt: new Date() })
    .onConflictDoUpdate({ target: syncState.job, set: { cursor, updatedAt: new Date() } });
}

// Binary archiving with failure bookkeeping

export type FetchKind = 'avatar' | 'map-image' | 'bsp';

async function fetchAllowed(db: Db, kind: FetchKind, key: string): Promise<boolean> {
  const [f] = await db
    .select({
      attempts: fetchFailures.attempts,
      gaveUp: fetchFailures.gaveUp,
      lastAt: fetchFailures.lastAt,
    })
    .from(fetchFailures)
    .where(and(eq(fetchFailures.kind, kind), eq(fetchFailures.key, key)));
  if (!f) return true;
  if (f.gaveUp) return false;
  // exponential spacing between retries: 1h, 2h, 4h ...
  const wait = 3600_000 * 2 ** (f.attempts - 1);
  return Date.now() - f.lastAt.getTime() > wait;
}

async function recordFetchFailure(
  db: Db,
  kind: FetchKind,
  key: string,
  status: number | null,
  error: string | null,
): Promise<void> {
  await db
    .insert(fetchFailures)
    .values({
      kind,
      key,
      attempts: 1,
      lastStatus: status,
      lastError: error,
      lastAt: new Date(),
      gaveUp: status === 404,
    })
    .onConflictDoUpdate({
      target: [fetchFailures.kind, fetchFailures.key],
      set: {
        attempts: sql`${fetchFailures.attempts} + 1`,
        lastStatus: status,
        lastError: error,
        lastAt: new Date(),
        gaveUp: sql`${fetchFailures.gaveUp} or ${status === 404} or ${fetchFailures.attempts} + 1 >= 5`,
      },
    });
}

/** Downloads an avatar once per hash into avatars/{hash}.jpg. Safe to call repeatedly. */
export async function ensureAvatarArchived(
  ctx: PollerContext,
  hash: string | null,
  source: 'momentum' | 'steam',
): Promise<void> {
  if (!hash || hash === STEAM_MISSING_AVATAR) return;
  const [have] = await ctx.db
    .select({ hash: avatars.hash })
    .from(avatars)
    .where(eq(avatars.hash, hash));
  if (have) return;
  if (!(await fetchAllowed(ctx.db, 'avatar', hash))) return;
  const url = steamAvatarUrl(hash);
  try {
    const r = await ctx.mom.download(url, 10 * 1024 * 1024);
    if (r.status !== 200 || r.bytes.length === 0) {
      await recordFetchFailure(ctx.db, 'avatar', hash, r.status, null);
      ctx.log.warn('avatar fetch failed', { hash, status: r.status });
      return;
    }
    const s3Key = keys.avatar(hash);
    await ctx.storage.put(s3Key, r.bytes, r.contentType ?? 'image/jpeg');
    await ctx.db
      .insert(avatars)
      .values({
        hash,
        s3Key,
        bytes: r.bytes.length,
        contentType: r.contentType ?? 'image/jpeg',
        source,
        firstSeenAt: new Date(),
      })
      .onConflictDoNothing();
    await ctx.db
      .delete(fetchFailures)
      .where(and(eq(fetchFailures.kind, 'avatar'), eq(fetchFailures.key, hash)));
  } catch (e) {
    await recordFetchFailure(
      ctx.db,
      'avatar',
      hash,
      e instanceof MomApiError ? e.status : null,
      errMsg(e),
    );
    ctx.log.warn('avatar fetch error', { hash, error: errMsg(e) });
  }
}

/** Downloads the large variant of a map image once per image id. */
export async function ensureMapImageArchived(ctx: PollerContext, imageId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ s3Key: mapImages.s3Key })
    .from(mapImages)
    .where(eq(mapImages.id, imageId));
  if (!row || row.s3Key) return;
  if (!(await fetchAllowed(ctx.db, 'map-image', imageId))) return;
  const url = ctx.mom.mapImageUrl(imageId, 'large');
  try {
    const r = await ctx.mom.download(url, 50 * 1024 * 1024);
    if (r.status !== 200 || r.bytes.length === 0) {
      await recordFetchFailure(ctx.db, 'map-image', imageId, r.status, null);
      await ctx.db
        .update(mapImages)
        .set({ fetchFailed: r.status === 404 })
        .where(eq(mapImages.id, imageId));
      return;
    }
    const s3Key = keys.mapImage(imageId);
    await ctx.storage.put(s3Key, r.bytes, r.contentType ?? 'image/jpeg');
    await ctx.db
      .update(mapImages)
      .set({ s3Key, bytes: r.bytes.length, fetchFailed: false })
      .where(eq(mapImages.id, imageId));
  } catch (e) {
    await recordFetchFailure(
      ctx.db,
      'map-image',
      imageId,
      e instanceof MomApiError ? e.status : null,
      errMsg(e),
    );
    ctx.log.warn('map image fetch error', { imageId, error: errMsg(e) });
  }
}

/** Optional: archive a map version's BSP (ARCHIVE_BSPS=true). */
export async function ensureBspArchived(ctx: PollerContext, versionId: string): Promise<void> {
  if (!ctx.cfg.ARCHIVE_BSPS) return;
  const [v] = await ctx.db
    .select({ s3Key: mapVersions.bspS3Key, url: mapVersions.downloadUrl })
    .from(mapVersions)
    .where(eq(mapVersions.id, versionId));
  if (!v || v.s3Key || !v.url) return;
  if (!(await fetchAllowed(ctx.db, 'bsp', versionId))) return;
  try {
    const r = await ctx.mom.download(v.url, 2 * 1024 * 1024 * 1024);
    if (r.status !== 200 || r.bytes.length === 0) {
      await recordFetchFailure(ctx.db, 'bsp', versionId, r.status, null);
      return;
    }
    const s3Key = keys.bsp(versionId);
    await ctx.storage.put(s3Key, r.bytes, 'application/octet-stream');
    await ctx.db
      .update(mapVersions)
      .set({ bspS3Key: s3Key, bspBytes: r.bytes.length })
      .where(eq(mapVersions.id, versionId));
    ctx.log.info('bsp archived', { versionId, bytes: r.bytes.length });
  } catch (e) {
    await recordFetchFailure(
      ctx.db,
      'bsp',
      versionId,
      e instanceof MomApiError ? e.status : null,
      errMsg(e),
    );
    ctx.log.warn('bsp fetch error', { versionId, error: errMsg(e) });
  }
}

// Full fetch and observe flows

export async function fetchFullLeaderboard(
  ctx: PollerContext,
  key: LeaderboardKey,
): Promise<MomLeaderboardRun[]> {
  const all: MomLeaderboardRun[] = [];
  for await (const { page } of ctx.mom.pages<MomLeaderboardRun>(`/maps/${key.mapId}/leaderboard`, {
    gamemode: key.gamemode,
    trackType: key.trackType,
    trackNum: key.trackNum,
    style: key.style,
  })) {
    all.push(...page.data);
    if (all.length > 50_000) break;
  }
  return all;
}

/** Fetch a whole leaderboard, observe embedded users, diff the board, enqueue new replays. */
export async function refreshLeaderboard(
  ctx: PollerContext,
  key: LeaderboardKey,
): Promise<BoardObserveResult | null> {
  let entries: MomLeaderboardRun[];
  try {
    entries = await fetchFullLeaderboard(ctx, key);
  } catch (e) {
    if (e instanceof MomApiError && (e.status === 404 || e.status === 400 || e.status === 403)) {
      ctx.log.warn('leaderboard not reachable', {
        key: `${key.mapId}:${key.gamemode}:${key.trackType}:${key.trackNum}:${key.style}`,
        status: e.status,
      });
      return null;
    }
    throw e;
  }
  const observedAt = new Date();
  await observeUsers(
    ctx.db,
    entries.map((e) => e.user).filter((u): u is MomUserSummary => Boolean(u)),
    observedAt,
  );
  const identities = new Map<number, { alias: string | null; avatarHash: string | null }>();
  for (const e of entries) {
    const id = identityFromUser(e.user);
    identities.set(e.userID, { alias: id.alias, avatarHash: id.avatarHash });
  }
  const result = await observeLeaderboard(ctx.db, key, entries, observedAt, identities);
  if (result.newHashes.length > 0) {
    const [m] = await ctx.db.select({ name: maps.name }).from(maps).where(eq(maps.id, key.mapId));
    const want = new Set(result.newHashes);
    for (const e of entries) {
      if (!e.replayHash || !want.has(e.replayHash)) continue;
      const id = identityFromUser(e.user);
      const steamName = await freshSteamName(ctx.db, id.steamId);
      await enqueueReplayFor(ctx.db, key, e, m?.name ?? null, { ...id, steamName });
    }
  }
  for (const e of entries) {
    const id = identityFromUser(e.user);
    await ensureAvatarArchived(ctx, id.avatarHash, 'momentum');
  }
  return result;
}

export async function fetchAndObserveMap(
  ctx: PollerContext,
  mapId: number,
): Promise<'ok' | 'notfound'> {
  let m;
  try {
    m = await ctx.mom.getMap(mapId);
  } catch (e) {
    if (e instanceof MomApiError && (e.status === 404 || e.status === 403)) {
      await ctx.db
        .update(maps)
        .set({ notFoundAt: sql`coalesce(${maps.notFoundAt}, now())` })
        .where(eq(maps.id, mapId));
      return 'notfound';
    }
    throw e;
  }
  const observedAt = new Date();
  if (m.submitter) await observeUser(ctx.db, m.submitter, observedAt);
  for (const c of m.credits ?? []) if (c.user) await observeUser(ctx.db, c.user, observedAt);
  const r = await observeMap(ctx.db, m, observedAt, ctx.cfg.ARCHIVE_GAMEMODES);
  await ctx.db.update(maps).set({ notFoundAt: null }).where(eq(maps.id, mapId));
  for (const id of r.newImageIds) await ensureMapImageArchived(ctx, id);
  for (const id of r.newVersionIds) await ensureBspArchived(ctx, id);
  if (r.changes.length > 0) {
    ctx.log.info('map changed', {
      mapId,
      name: m.name,
      fields: r.changes
        .map((c) => c.field)
        .slice(0, 10)
        .join(','),
    });
  }
  return 'ok';
}

/** Full user refresh: profile + stats, then follows, then activities enqueue. */
export async function fetchAndObserveUser(
  ctx: PollerContext,
  userId: number,
  withFollows = true,
): Promise<'ok' | 'notfound'> {
  let u: MomUser;
  try {
    u = await ctx.mom.getUser(userId);
  } catch (e) {
    if (e instanceof MomApiError && e.status === 404) {
      await markUserDeleted(ctx, userId);
      return 'notfound';
    }
    throw e;
  }
  const observedAt = new Date();
  const r = await observeUser(ctx.db, u, observedAt);
  if (r.changes.length > 0) {
    ctx.log.info('user changed', { userId, fields: r.changes.map((c) => c.field).join(',') });
  }
  await ensureAvatarArchived(ctx, avatarHashFromUrl(u.avatarURL), 'momentum');
  if (withFollows) await refreshFollows(ctx, userId);
  await enqueueRefresh(ctx.db, 'activities', userId, PRIORITY.low);
  return 'ok';
}

export async function markUserDeleted(ctx: PollerContext, userId: number): Promise<void> {
  const [prev] = await ctx.db
    .select({ isDeleted: users.isDeleted })
    .from(users)
    .where(eq(users.id, userId));
  if (!prev || prev.isDeleted) return;
  await ctx.db
    .update(users)
    .set({ isDeleted: true, lastRefreshedAt: new Date() })
    .where(eq(users.id, userId));
  await execRows(
    ctx.db,
    sql`insert into user_field_changes (user_id, field, old_value, new_value, observed_at) values (${userId}, 'deleted', 'false', 'true', now())`,
  );
  ctx.log.warn('user no longer visible', { userId });
}

export async function refreshFollows(ctx: PollerContext, userId: number): Promise<void> {
  const followers = [];
  const following = [];
  for await (const { page } of ctx.mom.pages<MomFollow>(`/users/${userId}/followers`, {})) {
    followers.push(...page.data);
  }
  for await (const { page } of ctx.mom.pages<MomFollow>(`/users/${userId}/follows`, {})) {
    following.push(...page.data);
  }
  const observedAt = new Date();
  const embedded: MomUser[] = [];
  for (const f of followers) if (f.followee) embedded.push(f.followee);
  for (const f of following) if (f.followed) embedded.push(f.followed);
  await observeUsers(ctx.db, embedded, observedAt);
  const r = await observeFollows(ctx.db, userId, followers, following, observedAt);
  if (r.followed || r.unfollowed)
    ctx.log.info('follows changed', { userId, followed: r.followed, unfollowed: r.unfollowed });
}

/** Page activities newest first until a known id shows up. */
export async function refreshActivities(ctx: PollerContext, userId: number): Promise<number> {
  const [latest] = (await execRows(
    ctx.db,
    sql`select max(id)::bigint as max_id from activities where user_id = ${userId}`,
  )) as unknown as { max_id: string | null }[];
  const knownMax = latest?.max_id ? Number(latest.max_id) : 0;
  let total = 0;
  let pagesSeen = 0;
  for await (const { page } of ctx.mom.pages<MomActivity>(`/users/${userId}/activities`, {})) {
    pagesSeen += 1;
    const fresh = page.data.filter((a) => a.id > knownMax);
    total += await observeActivities(ctx.db, fresh, new Date());
    if (fresh.length < page.data.length || pagesSeen > 200) break;
  }
  await ctx.db.update(users).set({ activitiesObservedAt: new Date() }).where(eq(users.id, userId));
  return total;
}

/** GET /runs/:id to find out whether a run still exists after its leaderboard entry vanished. */
export async function verifyRun(ctx: PollerContext, runId: number): Promise<'exists' | 'deleted'> {
  try {
    const r = await ctx.mom.getRun(runId);
    await ctx.db
      .update(runs)
      .set({ removalKind: 'leaderboard', isPb: Boolean(r.isPB), lastSeenAt: new Date() })
      .where(eq(runs.id, runId));
    return 'exists';
  } catch (e) {
    if (e instanceof MomApiError && (e.status === 404 || e.status === 403)) {
      await ctx.db
        .update(runs)
        .set({ removalKind: 'deleted', removedAt: sql`coalesce(${runs.removedAt}, now())` })
        .where(eq(runs.id, runId));
      ctx.log.warn('run deleted upstream', { runId, status: e.status });
      return 'deleted';
    }
    throw e;
  }
}
