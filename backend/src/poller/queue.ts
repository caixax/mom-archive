// Persistent work queues in Postgres: refresh_queue (users, leaderboards, maps,
// activities, run verification) and replay_queue (replay downloads).
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { refreshQueue, replayQueue, replays } from '../db/schema.js';
import { leaderboardKeyString, type LeaderboardKey } from '../momentum/types.js';

export type RefreshKind = 'user' | 'leaderboard' | 'map' | 'activities' | 'run-verify' | 'follows';

export interface RefreshItem {
  id: number;
  kind: RefreshKind;
  key: string;
  priority: number;
  attempts: number;
  payload: Record<string, unknown> | null;
}

/** Lower number runs first. */
export const PRIORITY = { urgent: 1, high: 3, normal: 5, low: 8 } as const;

export async function enqueueRefresh(
  db: Db,
  kind: RefreshKind,
  key: string | number,
  priority: number = PRIORITY.normal,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(refreshQueue)
    .values({ kind, key: String(key), priority, enqueuedAt: new Date(), payload: payload ?? null })
    .onConflictDoUpdate({
      target: [refreshQueue.kind, refreshQueue.key],
      set: { priority: sql`least(${refreshQueue.priority}, ${priority})` },
    });
}

export async function enqueueRefreshMany(
  db: Db,
  kind: RefreshKind,
  keys: Iterable<string | number>,
  priority: number = PRIORITY.normal,
): Promise<number> {
  const unique = [...new Set([...keys].map(String))];
  if (unique.length === 0) return 0;
  const now = new Date();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    await db
      .insert(refreshQueue)
      .values(chunk.map((key) => ({ kind, key, priority, enqueuedAt: now })))
      .onConflictDoUpdate({
        target: [refreshQueue.kind, refreshQueue.key],
        set: { priority: sql`least(${refreshQueue.priority}, ${priority})` },
      });
  }
  return unique.length;
}

export function enqueueLeaderboardRefresh(
  db: Db,
  key: LeaderboardKey,
  priority: number = PRIORITY.normal,
) {
  return enqueueRefresh(db, 'leaderboard', leaderboardKeyString(key), priority);
}

/** Claims up to `limit` items. Items started more than 15 minutes ago are considered stale and reclaimed. */
export async function claimRefresh(
  db: Db,
  limit: number,
  kinds?: RefreshKind[],
): Promise<RefreshItem[]> {
  const stale = new Date(Date.now() - 15 * 60_000);
  const rows = await db.transaction(async (tx) => {
    const cond = and(
      or(isNull(refreshQueue.startedAt), lt(refreshQueue.startedAt, stale)),
      kinds ? sql`${refreshQueue.kind} in ${kinds}` : undefined,
    );
    const picked = await tx
      .select({ id: refreshQueue.id })
      .from(refreshQueue)
      .where(cond)
      .orderBy(asc(refreshQueue.priority), asc(refreshQueue.enqueuedAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (picked.length === 0) return [];
    const ids = picked.map((p) => p.id);
    return tx
      .update(refreshQueue)
      .set({ startedAt: new Date(), attempts: sql`${refreshQueue.attempts} + 1` })
      .where(sql`${refreshQueue.id} in ${ids}`)
      .returning({
        id: refreshQueue.id,
        kind: refreshQueue.kind,
        key: refreshQueue.key,
        priority: refreshQueue.priority,
        attempts: refreshQueue.attempts,
        payload: refreshQueue.payload,
      });
  });
  return rows as RefreshItem[];
}

export async function completeRefresh(db: Db, id: number): Promise<void> {
  await db.delete(refreshQueue).where(eq(refreshQueue.id, id));
}

/** Puts an item back for a later retry, or drops it after too many attempts. */
export async function failRefresh(db: Db, item: RefreshItem, maxAttempts = 5): Promise<boolean> {
  if (item.attempts >= maxAttempts) {
    await db.delete(refreshQueue).where(eq(refreshQueue.id, item.id));
    return false;
  }
  await db
    .update(refreshQueue)
    .set({ startedAt: null, priority: PRIORITY.low })
    .where(eq(refreshQueue.id, item.id));
  return true;
}

export async function refreshQueueDepth(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: refreshQueue.kind, n: sql<number>`count(*)::int` })
    .from(refreshQueue)
    .groupBy(refreshQueue.kind);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

// Replay queue

export interface ReplayJob {
  sha1: string;
  pastRunId: number | null;
  userId: number | null;
  mapId: number | null;
  mapName: string | null;
  gamemode: number | null;
  trackType: number | null;
  trackNum: number | null;
  style: number | null;
  runTime: number | null;
  steamId: string | null;
  observedAlias: string | null;
  observedAvatarHash: string | null;
  observedSteamName: string | null;
}

export async function enqueueReplay(db: Db, job: ReplayJob): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(job.sha1)) return false;
  const have = await db
    .select({ sha1: replays.sha1 })
    .from(replays)
    .where(eq(replays.sha1, job.sha1))
    .limit(1);
  if (have.length > 0) return false;
  const now = new Date();
  const res = await db
    .insert(replayQueue)
    .values({ ...job, state: 'pending', attempts: 0, nextAttemptAt: now, enqueuedAt: now })
    .onConflictDoNothing()
    .returning({ sha1: replayQueue.sha1 });
  return res.length > 0;
}

export async function claimReplays(db: Db, limit: number): Promise<ReplayJob[]> {
  const now = new Date();
  const stale = new Date(now.getTime() - 20 * 60_000);
  return db.transaction(async (tx) => {
    const picked = await tx
      .select({ sha1: replayQueue.sha1 })
      .from(replayQueue)
      .where(
        or(
          and(eq(replayQueue.state, 'pending'), lt(replayQueue.nextAttemptAt, now)),
          and(eq(replayQueue.state, 'in_flight'), lt(replayQueue.startedAt, stale)),
        ),
      )
      .orderBy(asc(replayQueue.enqueuedAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (picked.length === 0) return [];
    const ids = picked.map((p) => p.sha1);
    const rows = await tx
      .update(replayQueue)
      .set({ state: 'in_flight', startedAt: now, attempts: sql`${replayQueue.attempts} + 1` })
      .where(sql`${replayQueue.sha1} in ${ids}`)
      .returning();
    return rows.map((r) => ({
      sha1: r.sha1,
      pastRunId: r.pastRunId,
      userId: r.userId,
      mapId: r.mapId,
      mapName: r.mapName,
      gamemode: r.gamemode,
      trackType: r.trackType,
      trackNum: r.trackNum,
      style: r.style,
      runTime: r.runTime,
      steamId: r.steamId,
      observedAlias: r.observedAlias,
      observedAvatarHash: r.observedAvatarHash,
      observedSteamName: r.observedSteamName,
    }));
  });
}

export async function replayQueueStats(
  db: Db,
): Promise<{ pending: number; inFlight: number; failed: number }> {
  const rows = await db
    .select({ state: replayQueue.state, n: sql<number>`count(*)::int` })
    .from(replayQueue)
    .groupBy(replayQueue.state);
  const out = { pending: 0, inFlight: 0, failed: 0 };
  for (const r of rows) {
    if (r.state === 'pending') out.pending = r.n;
    else if (r.state === 'in_flight') out.inFlight = r.n;
    else if (r.state === 'failed') out.failed = r.n;
  }
  return out;
}
