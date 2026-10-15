// Maintenance commands. Usage: pnpm --filter backend cli <command> [args]
//   sync                                    catch up now: backfill, pick up new runs, then drain the queues
//   backfill [--phase runs|users|maps|leaderboards|beta-runs] [--only <phase>]
//   reprocess-raw <prefix> [--limit n]      re-ingest raw API snapshots from S3 (runs, maps, users)
//   verify-replays [--limit n]              re-download nothing; re-hash stored replays against their key
//   requeue-replays [--include-404]         put failed replay downloads back in the queue
//   refresh-user <id> | refresh-map <id> | refresh-leaderboard <mapId:gm:tt:tn:style>
//   job <name>                              run one scheduler job now
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { bootstrap } from '../bootstrap.js';
import { replays } from '../db/schema.js';
import { runMigrations } from '../db/migrate.js';
import { getLogger, errMsg, type Logger } from '../logger.js';
import {
  parseLeaderboardKey,
  type MomMap,
  type MomPastRun,
  type MomUser,
  type Paged,
} from '../momentum/types.js';
import type { PollerContext } from '../poller/context.js';
import { registerJobs } from '../poller/index.js';
import { runBackfill, type BackfillPhase } from '../poller/jobs/backfill.js';
import {
  fetchAndObserveMap,
  fetchAndObserveUser,
  refreshLeaderboard,
} from '../poller/jobs/helpers.js';
import { refreshWorker } from '../poller/jobs/refresh.js';
import { replayWorker, requeueFailedReplays } from '../poller/jobs/replays.js';
import { ingestRuns, runsIncremental, type IngestStats } from '../poller/jobs/runs.js';
import { refreshQueueDepth, replayQueueStats } from '../poller/queue.js';
import { observeMap, observeUser } from '../poller/observe.js';
import { execRows } from '../db/index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) {
    console.log(
      'commands: sync, backfill, reprocess-raw, verify-replays, requeue-replays, refresh-user, refresh-map, refresh-leaderboard, job',
    );
    process.exit(2);
  }
  const rt = bootstrap();
  const log = getLogger('cli');
  const ctx = rt.poller;
  await runMigrations(rt.pools.rw);
  registerJobs(ctx);
  const abort = new AbortController();
  process.on('SIGINT', () => {
    log.warn('interrupted, finishing current step');
    abort.abort();
  });

  try {
    switch (cmd) {
      case 'sync': {
        // Catch up now: run the (resumable) backfill, pick up runs submitted while it ran,
        // then keep the replay and refresh workers going until both queues are empty.
        // Safe to run with the pm2 backend up or down; the queues use row locks.
        const c = await runBackfill(ctx, { signal: abort.signal });
        if (!abort.signal.aborted) {
          const inc = await runsIncremental(ctx);
          log.info('sync incremental runs', { seen: inc.seen ?? 0, new: inc.new ?? 0 });
        }
        if (!abort.signal.aborted) await drainQueues(ctx, log, abort.signal);
        log.info('sync done', { phase: c.phase, aborted: abort.signal.aborted });
        break;
      }
      case 'backfill': {
        const c = await runBackfill(ctx, {
          phase: arg('phase') as BackfillPhase | undefined,
          only: arg('only') as BackfillPhase | undefined,
          signal: abort.signal,
        });
        log.info('backfill state', {
          phase: c.phase,
          runsSkip: c.runsSkip,
          usersNextId: c.usersNextId,
        });
        break;
      }
      case 'reprocess-raw': {
        const prefix = process.argv[3];
        if (!prefix) throw new Error('usage: reprocess-raw <raw/prefix> [--limit n]');
        const limit = Number(arg('limit') ?? '0');
        let n = 0;
        const stats: IngestStats = { seen: 0, stored: 0, newRuns: 0, newReplays: 0, maxId: 0 };
        for await (const obj of rt.storage.listKeys(prefix)) {
          if (abort.signal.aborted) break;
          const bytes = await rt.storage.getBytes(obj.key);
          if (!bytes) continue;
          const body = JSON.parse(gunzipSync(bytes).toString('utf8')) as unknown;
          const observedAt = new Date();
          if (obj.key.startsWith('raw/runs/')) {
            const page = body as Paged<MomPastRun>;
            await ingestRuns(ctx, page.data ?? [], stats);
          } else if (obj.key.startsWith('raw/maps/')) {
            const data = (body as Paged<MomMap>).data ?? [body as MomMap];
            for (const m of data)
              if (m && typeof m.id === 'number')
                await observeMap(ctx.db, m, observedAt, ctx.cfg.ARCHIVE_GAMEMODES);
          } else if (obj.key.startsWith('raw/users/')) {
            const data = (body as Paged<MomUser>).data ?? [body as MomUser];
            for (const u of data)
              if (u && typeof u.id === 'number') await observeUser(ctx.db, u, observedAt);
          }
          n += 1;
          if (n % 100 === 0) log.info('reprocess progress', { files: n, runs: stats.stored });
          if (limit > 0 && n >= limit) break;
        }
        log.info('reprocess done', { files: n, runsSeen: stats.seen, runsStored: stats.stored });
        break;
      }
      case 'verify-replays': {
        const limit = Number(arg('limit') ?? '0');
        const rows = await ctx.db
          .select({ sha1: replays.sha1, s3Key: replays.s3Key, bytes: replays.bytes })
          .from(replays)
          .orderBy(replays.downloadedAt);
        let ok = 0;
        let bad = 0;
        let missing = 0;
        for (const r of rows) {
          if (abort.signal.aborted) break;
          const bytes = await rt.storage.getBytes(r.s3Key);
          if (!bytes) {
            missing += 1;
            log.error('replay object missing', { sha1: r.sha1 });
            continue;
          }
          const h = createHash('sha1').update(bytes).digest('hex');
          if (h !== r.sha1 || bytes.length !== r.bytes) {
            bad += 1;
            log.error('replay corrupted', {
              sha1: r.sha1,
              got: h,
              bytes: bytes.length,
              expected: r.bytes,
            });
          } else ok += 1;
          if (limit > 0 && ok + bad + missing >= limit) break;
        }
        log.info('verify done', { ok, bad, missing });
        break;
      }
      case 'requeue-replays': {
        const n = await requeueFailedReplays(ctx, flag('include-404'));
        log.info('requeued', { n });
        break;
      }
      case 'refresh-user': {
        const r = await fetchAndObserveUser(ctx, Number(process.argv[3]));
        log.info('refresh-user', { result: r });
        break;
      }
      case 'refresh-map': {
        const r = await fetchAndObserveMap(ctx, Number(process.argv[3]));
        log.info('refresh-map', { result: r });
        break;
      }
      case 'refresh-leaderboard': {
        const key = parseLeaderboardKey(process.argv[3] ?? '');
        if (!key)
          throw new Error('usage: refresh-leaderboard <mapId:gamemode:trackType:trackNum:style>');
        const r = await refreshLeaderboard(ctx, key);
        log.info('refresh-leaderboard', {
          ...(r ?? { result: 'unreachable' }),
          newHashes: r?.newHashes.length ?? 0,
        });
        break;
      }
      case 'job': {
        const name = process.argv[3];
        if (!name) throw new Error('usage: job <name>');
        const ran = await rt.scheduler.trigger(name);
        log.info('job', { name, ran });
        break;
      }
      case 'sql-check': {
        const [r] = (await execRows(ctx.db, sql`select version() as v`)) as unknown as {
          v: string;
        }[];
        log.info('database', { version: r?.v });
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } catch (e) {
    log.error('command failed', { error: errMsg(e) });
    process.exitCode = 1;
  } finally {
    await rt.pools.close();
  }
}

/** Runs the replay and refresh workers until both queues are empty, then stops them. */
async function drainQueues(ctx: PollerContext, log: Logger, signal: AbortSignal): Promise<void> {
  const done = new AbortController();
  const onAbort = () => done.abort();
  signal.addEventListener('abort', onAbort);
  const supervise = async (name: string, run: (s: AbortSignal) => Promise<void>) => {
    while (!done.signal.aborted) {
      try {
        await run(done.signal);
      } catch (e) {
        log.error(`${name} worker crashed, restarting in 5s`, { error: errMsg(e) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  const workers = [
    supervise('replay', (s) => replayWorker(ctx, s)),
    supervise('refresh', (s) => refreshWorker(ctx, s)),
  ];
  for (;;) {
    if (signal.aborted) break;
    try {
      const rq = await replayQueueStats(ctx.db);
      const depth = await refreshQueueDepth(ctx.db);
      const refreshLeft = Object.values(depth).reduce((a, b) => a + b, 0);
      const replaysLeft = rq.pending + rq.inFlight;
      if (replaysLeft === 0 && refreshLeft === 0) break;
      log.info('sync draining', { replays: replaysLeft, failed: rq.failed, refresh: refreshLeft });
    } catch (e) {
      log.warn('drain check failed, retrying', { error: errMsg(e) });
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  done.abort();
  signal.removeEventListener('abort', onAbort);
  await Promise.allSettled(workers);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
