// refresh worker: drains refresh_queue (user, leaderboard, map, activities, run-verify, follows).
import { errMsg } from '../../logger.js';
import { parseLeaderboardKey } from '../../momentum/types.js';
import type { PollerContext } from '../context.js';
import { claimRefresh, completeRefresh, failRefresh, type RefreshItem } from '../queue.js';
import {
  fetchAndObserveMap,
  fetchAndObserveUser,
  refreshActivities,
  refreshFollows,
  refreshLeaderboard,
  verifyRun,
} from './helpers.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function refreshWorker(ctx: PollerContext, signal: AbortSignal): Promise<void> {
  const log = ctx.log.child({ module: 'refresh' });
  while (!signal.aborted) {
    const items = await claimRefresh(ctx.db, 4);
    if (items.length === 0) {
      await sleep(1500);
      continue;
    }
    await Promise.all(
      items.map(async (item) => {
        try {
          await handle(ctx, item);
          await completeRefresh(ctx.db, item.id);
        } catch (e) {
          const retry = await failRefresh(ctx.db, item);
          log.warn('refresh item failed', {
            kind: item.kind,
            key: item.key,
            attempt: item.attempts,
            retry,
            error: errMsg(e),
          });
        }
      }),
    );
  }
}

async function handle(ctx: PollerContext, item: RefreshItem): Promise<void> {
  const log = ctx.log.child({ module: 'refresh' });
  switch (item.kind) {
    case 'user': {
      await fetchAndObserveUser(ctx, Number(item.key), true);
      return;
    }
    case 'follows': {
      await refreshFollows(ctx, Number(item.key));
      return;
    }
    case 'leaderboard': {
      const key = parseLeaderboardKey(item.key);
      if (!key) return;
      const r = await refreshLeaderboard(ctx, key);
      if (r && (r.added || r.removed || r.improved)) {
        log.info('leaderboard changed', {
          key: item.key,
          total: r.total,
          added: r.added,
          improved: r.improved,
          removed: r.removed,
          replays: r.newHashes.length,
        });
      }
      return;
    }
    case 'map': {
      await fetchAndObserveMap(ctx, Number(item.key));
      return;
    }
    case 'activities': {
      await refreshActivities(ctx, Number(item.key));
      return;
    }
    case 'run-verify': {
      await verifyRun(ctx, Number(item.key));
      return;
    }
    default:
      log.warn('unknown refresh kind', { kind: item.kind });
  }
}
