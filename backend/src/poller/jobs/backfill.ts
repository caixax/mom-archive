// One time, resumable backfill (CLI: pnpm backfill). Phases:
//   runs:         ascending walk of /runs from skip 0 (all gamemodes come back; archived ones are stored)
//   users:        GET /users?userIDs=1..N in batches of 100, until a long run of unknown ids past the max seen
//   maps:         maps-sweep + maps-walk
//   leaderboards: enqueue a refresh for every archived leaderboard
//   beta-runs:    per map walk for non approved maps
// Cursor lives in sync_state 'backfill'. Safe to interrupt and re-run.
import { sql } from 'drizzle-orm';
import { errMsg } from '../../logger.js';
import type { MomPastRun } from '../../momentum/types.js';
import type { PollerContext } from '../context.js';
import { observeUser } from '../observe.js';
import { getCursor, identityFromUser, setCursor, ensureAvatarArchived } from './helpers.js';
import { betaRuns, ingestRuns, type IngestStats } from './runs.js';
import { leaderboardsSweep, mapsSweep, mapsWalk } from './sweeps.js';
import { execRows } from '../../db/index.js';

export type BackfillPhase = 'runs' | 'users' | 'maps' | 'leaderboards' | 'beta-runs' | 'done';

export interface BackfillCursor extends Record<string, unknown> {
  phase: BackfillPhase;
  runsSkip: number;
  runsTotal: number | null;
  runsSeen: number;
  usersNextId: number;
  usersMaxId: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const PHASES: BackfillPhase[] = ['runs', 'users', 'maps', 'leaderboards', 'beta-runs', 'done'];

export async function loadBackfillCursor(ctx: PollerContext): Promise<BackfillCursor> {
  const c = await getCursor<BackfillCursor>(ctx.db, 'backfill');
  return (
    c ?? {
      phase: 'runs',
      runsSkip: 0,
      runsTotal: null,
      runsSeen: 0,
      usersNextId: 1,
      usersMaxId: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    }
  );
}

async function save(ctx: PollerContext, c: BackfillCursor): Promise<void> {
  c.updatedAt = new Date().toISOString();
  await setCursor(ctx.db, 'backfill', c);
}

export interface BackfillOptions {
  /** Start from a given phase regardless of the cursor */
  phase?: BackfillPhase;
  /** Stop after this phase */
  only?: BackfillPhase;
  signal?: AbortSignal;
}

export async function runBackfill(
  ctx: PollerContext,
  opts: BackfillOptions = {},
): Promise<BackfillCursor> {
  const log = ctx.log.child({ module: 'backfill' });
  const c = await loadBackfillCursor(ctx);
  if (opts.phase) {
    c.phase = opts.phase;
    if (opts.phase === 'runs') c.runsSkip = 0;
    if (opts.phase === 'users') c.usersNextId = 1;
    c.finishedAt = null;
  }
  const signal = opts.signal ?? ctx.scheduler.signal;
  log.info('backfill starting', {
    phase: c.phase,
    runsSkip: c.runsSkip,
    usersNextId: c.usersNextId,
  });

  for (;;) {
    if (signal.aborted) break;
    if (c.phase === 'done') {
      c.finishedAt = c.finishedAt ?? new Date().toISOString();
      await save(ctx, c);
      break;
    }
    switch (c.phase) {
      case 'runs':
        await backfillRuns(ctx, c, signal);
        break;
      case 'users':
        await backfillUsers(ctx, c, signal);
        break;
      case 'maps': {
        const s = await mapsSweep(ctx);
        log.info('backfill maps sweep done', { seen: s.seen, new: s.new });
        const w = await mapsWalk(ctx);
        log.info('backfill maps walk done', { seen: w.seen, found: w.new, note: w.note });
        break;
      }
      case 'leaderboards': {
        const r = await leaderboardsSweep(ctx);
        log.info('backfill leaderboards queued', { queued: r.new });
        break;
      }
      case 'beta-runs': {
        const r = await betaRuns(ctx);
        log.info('backfill beta runs done', { seen: r.seen, new: r.new, note: r.note });
        break;
      }
      default:
        break;
    }
    if (signal.aborted) break;
    if (opts.only && c.phase === opts.only) {
      await save(ctx, c);
      break;
    }
    c.phase = PHASES[PHASES.indexOf(c.phase) + 1] ?? 'done';
    await save(ctx, c);
  }
  log.info('backfill stopped', { phase: c.phase, aborted: signal.aborted });
  return c;
}

async function backfillRuns(
  ctx: PollerContext,
  c: BackfillCursor,
  signal: AbortSignal,
): Promise<void> {
  const log = ctx.log.child({ module: 'backfill' });
  const stats: IngestStats = { seen: 0, stored: 0, newRuns: 0, newReplays: 0, maxId: 0 };
  let lastLog = Date.now();
  for await (const { page, skip } of ctx.mom.pages<MomPastRun>(
    '/runs',
    { orderBy: 'createdAt', order: 'asc', expand: 'user,map,leaderboardRun' },
    { startSkip: c.runsSkip },
  )) {
    if (signal.aborted) return;
    c.runsTotal = page.totalCount;
    await ingestRuns(ctx, page.data, stats);
    c.runsSkip = skip + page.returnCount;
    c.runsSeen += page.returnCount;
    if (c.runsSkip % 1000 === 0 || page.returnCount < 100) await save(ctx, c);
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      log.info('backfill runs progress', {
        skip: c.runsSkip,
        total: c.runsTotal,
        pct: c.runsTotal ? Math.floor((c.runsSkip / c.runsTotal) * 1000) / 10 : null,
        stored: stats.stored,
        newRuns: stats.newRuns,
        replays: stats.newReplays,
      });
    }
  }
  await save(ctx, c);
  log.info('backfill runs done', {
    seen: stats.seen,
    stored: stats.stored,
    newRuns: stats.newRuns,
    replays: stats.newReplays,
  });
}

/** Walk user ids 1..N in batches of 100 via /users?userIDs. Stops after 2000 consecutive unknown ids past the max id seen. */
async function backfillUsers(
  ctx: PollerContext,
  c: BackfillCursor,
  signal: AbortSignal,
): Promise<void> {
  const log = ctx.log.child({ module: 'backfill' });
  const [mx] = (await execRows(
    ctx.db,
    sql`select coalesce(max(id), 0)::int as max from users`,
  )) as unknown as { max: number }[];
  c.usersMaxId = Math.max(c.usersMaxId, mx?.max ?? 0);
  let consecutiveMissing = 0;
  let seen = 0;
  let id = c.usersNextId;
  let lastLog = Date.now();
  for (;;) {
    if (signal.aborted) return;
    const ids = Array.from({ length: 100 }, (_, i) => id + i);
    let page;
    try {
      page = await ctx.mom.getUsersPage({ skip: 0, take: 100, userIDs: ids });
    } catch (e) {
      log.warn('users batch failed', { from: id, error: errMsg(e) });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const observedAt = new Date();
    for (const u of page.data) {
      seen += 1;
      await observeUser(ctx.db, u, observedAt);
      await ensureAvatarArchived(ctx, identityFromUser(u).avatarHash, 'momentum');
      if (u.id > c.usersMaxId) c.usersMaxId = u.id;
    }
    consecutiveMissing = page.data.length === 0 ? consecutiveMissing + 100 : 0;
    id += 100;
    c.usersNextId = id;
    if (id % 1000 === 0) await save(ctx, c);
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      log.info('backfill users progress', { nextId: id, maxId: c.usersMaxId, seen });
    }
    if (id > c.usersMaxId && consecutiveMissing >= 2000) break;
  }
  await save(ctx, c);
  log.info('backfill users done', { seen, maxId: c.usersMaxId });
}
