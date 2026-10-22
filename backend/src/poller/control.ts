// What the owner's panel may ask of the poller, and nothing more. The HTTP layer
// never receives the read write pool: it gets this object, which can start or stop
// a registered job by name, queue a fresh look at one user, map or leaderboard, and
// put failed replay downloads back in the queue. None of it takes data from the
// request to write into the archive; it only makes the poller ask Momentum again.
import { getCursor } from './jobs/helpers.js';
import type { BackfillCursor } from './jobs/backfill.js';
import { requeueFailedReplays } from './jobs/replays.js';
import type { PollerContext } from './context.js';
import { enqueueRefresh, PRIORITY, type RefreshKind } from './queue.js';
import type { StartResult } from './scheduler.js';

export const REFRESH_KINDS = [
  'user',
  'map',
  'leaderboard',
  'follows',
  'activities',
  'run-verify',
] as const satisfies readonly RefreshKind[];

export type ControlStartResult = StartResult | 'busy-elsewhere';

export interface PollerControl {
  /** False when POLLER_ENABLED=false: nothing is registered in this process. */
  enabled: boolean;
  start(job: string, args?: Record<string, unknown>): Promise<ControlStartResult>;
  cancel(job: string): boolean;
  refresh(kind: RefreshKind, key: string): Promise<void>;
  requeueReplays(includeNotFound: boolean): Promise<number>;
}

const LEADERBOARD_KEY = /^\d{1,9}:\d{1,3}:\d{1,3}:\d{1,3}:\d{1,3}$/;
const INT_KEY = /^[1-9]\d{0,9}$/;

export function validRefreshKey(kind: RefreshKind, key: string): boolean {
  return kind === 'leaderboard' ? LEADERBOARD_KEY.test(key) : INT_KEY.test(key);
}

/** A backfill cursor written this recently, by something other than this process, means `pnpm sync` is walking. */
const FOREIGN_BACKFILL_WINDOW_MS = 3 * 60_000;

export function createPollerControl(ctx: PollerContext, enabled: boolean): PollerControl {
  const scheduler = ctx.scheduler;
  return {
    enabled,
    async start(job, args) {
      const running = scheduler.statuses().find((s) => s.name === job)?.running;
      if (job === 'backfill' && scheduler.has(job) && !running) {
        const c = await getCursor<BackfillCursor>(ctx.db, 'backfill');
        const mine = scheduler.statuses().find((s) => s.name === 'backfill')?.lastFinishAt;
        const at = c?.updatedAt ? new Date(c.updatedAt).getTime() : 0;
        if (
          Date.now() - at < FOREIGN_BACKFILL_WINDOW_MS &&
          (!mine || at > mine.getTime()) &&
          c?.phase !== 'done'
        ) {
          return 'busy-elsewhere';
        }
      }
      return scheduler.start(job, args);
    },
    cancel: (job) => scheduler.cancel(job),
    async refresh(kind, key) {
      if (!validRefreshKey(kind, key)) throw new Error('invalid refresh key');
      await enqueueRefresh(ctx.db, kind, key, PRIORITY.urgent);
    },
    requeueReplays: (includeNotFound) => requeueFailedReplays(ctx, includeNotFound),
  };
}
