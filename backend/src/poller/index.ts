// Registers every job on the scheduler. Intervals come from config.
import type { PollerContext } from './context.js';
import { betaRuns, runsIncremental } from './jobs/runs.js';
import { replayWorker } from './jobs/replays.js';
import { refreshWorker } from './jobs/refresh.js';
import {
  avatarsFetch,
  leaderboardsSweep,
  mapsSweep,
  mapsWalk,
  queueUnfetchedUsers,
  usersSweep,
} from './jobs/sweeps.js';
import { steamHistoryRefresh, steamRefresh } from './jobs/steam.js';
import { housekeeping, searchRefresh, storageSummary } from './jobs/maintenance.js';
import { runBackfill, type BackfillPhase } from './jobs/backfill.js';

const MIN = 60_000;
const HOUR = 3600_000;

export function registerJobs(ctx: PollerContext): void {
  const s = ctx.scheduler;
  const cfg = ctx.cfg;

  s.register({
    name: 'runs-incremental',
    intervalMs: cfg.POLL_RUNS_MINUTES * MIN,
    initialDelayMs: 5_000,
    run: () => runsIncremental(ctx),
  });
  s.register({
    name: 'beta-runs',
    intervalMs: cfg.POLL_RUNS_MINUTES * MIN,
    initialDelayMs: 2 * MIN,
    run: (signal, progress) => betaRuns(ctx, signal, progress),
  });
  s.register({
    name: 'replay-download',
    intervalMs: 0,
    worker: true,
    run: (signal) => replayWorker(ctx, signal),
  });
  s.register({
    name: 'refresh-worker',
    intervalMs: 0,
    worker: true,
    run: (signal) => refreshWorker(ctx, signal),
  });
  s.register({
    name: 'users-sweep',
    intervalMs: cfg.POLL_USERS_SWEEP_HOURS * HOUR,
    initialDelayMs: 30 * MIN,
    run: (signal, progress) => usersSweep(ctx, signal, progress),
  });
  s.register({
    name: 'users-unfetched',
    intervalMs: 15 * MIN,
    initialDelayMs: 3 * MIN,
    run: () => queueUnfetchedUsers(ctx),
  });
  s.register({
    name: 'maps-sweep',
    intervalMs: cfg.POLL_MAPS_HOURS * HOUR,
    initialDelayMs: 1 * MIN,
    run: (signal, progress) => mapsSweep(ctx, signal, progress),
  });
  s.register({
    name: 'leaderboards-full-sweep',
    intervalMs: cfg.POLL_LEADERBOARDS_SWEEP_HOURS * HOUR,
    initialDelayMs: 10 * MIN,
    run: () => leaderboardsSweep(ctx),
  });
  s.register({
    name: 'maps-walk',
    intervalMs: cfg.POLL_MAPS_WALK_HOURS * HOUR,
    initialDelayMs: 20 * MIN,
    run: (signal, progress) => mapsWalk(ctx, signal, progress),
  });
  s.register({
    name: 'avatars-fetch',
    intervalMs: 5 * MIN,
    initialDelayMs: 4 * MIN,
    run: (signal, progress) => avatarsFetch(ctx, signal, progress),
  });
  s.register({
    name: 'steam-refresh',
    intervalMs: 30 * MIN,
    initialDelayMs: 6 * MIN,
    run: (signal, progress) => steamRefresh(ctx, signal, progress),
  });
  s.register({
    name: 'steamhistory-refresh',
    intervalMs: 60 * MIN,
    initialDelayMs: 8 * MIN,
    run: (signal, progress) => steamHistoryRefresh(ctx, signal, progress),
  });
  s.register({
    name: 'search-refresh',
    intervalMs: 10 * MIN,
    initialDelayMs: 7 * MIN,
    run: () => searchRefresh(ctx),
  });
  s.register({
    name: 'storage-summary',
    intervalMs: 24 * HOUR,
    initialDelayMs: 15 * MIN,
    run: () => storageSummary(ctx),
  });
  s.register({
    name: 'housekeeping',
    intervalMs: 24 * HOUR,
    initialDelayMs: 60 * MIN,
    run: () => housekeeping(ctx),
  });
  // The one time catch up, startable from the owner's panel. Resumable like the CLI one.
  s.register({
    name: 'backfill',
    intervalMs: 0,
    manual: true,
    run: async (signal, progress, args) => {
      const c = await runBackfill(ctx, {
        phase: args?.phase as BackfillPhase | undefined,
        only: args?.only as BackfillPhase | undefined,
        signal,
        progress,
      });
      return { note: `phase=${c.phase}` };
    },
  });
}
