// replay-download worker: continuous queue, concurrency REPLAY_CONCURRENCY.
// Downloads from the CDN, verifies sha1, parses the header, stores in S3, records the row.
import { eq, sql } from 'drizzle-orm';
import { replayFetchFailures, replayQueue, replays } from '../../db/schema.js';
import { errMsg } from '../../logger.js';
import { MomApiError } from '../../momentum/client.js';
import { checkHeader, readHeader, ReplayReadError } from '../../momentum/replay-header.js';
import { keys } from '../../storage/s3.js';
import type { PollerContext } from '../context.js';
import { claimReplays, type ReplayJob } from '../queue.js';
import { execRows } from '../../db/index.js';

const MAX_ATTEMPTS = 4;
const CLOUDFLARE_LIMIT = 100 * 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function replayWorker(ctx: PollerContext, signal: AbortSignal): Promise<void> {
  const log = ctx.log.child({ module: 'replays' });
  while (!signal.aborted) {
    const jobs = await claimReplays(ctx.db, ctx.cfg.REPLAY_CONCURRENCY);
    if (jobs.length === 0) {
      await sleep(2000);
      continue;
    }
    await Promise.all(
      jobs.map((j) =>
        processReplay(ctx, j).catch((e) =>
          log.error('replay job crashed', { sha1: j.sha1, error: errMsg(e) }),
        ),
      ),
    );
  }
}

async function processReplay(ctx: PollerContext, job: ReplayJob): Promise<void> {
  const log = ctx.log.child({ module: 'replays' });
  const url = ctx.mom.replayUrl(job.sha1);
  const [state] = await ctx.db
    .select({ attempts: replayQueue.attempts })
    .from(replayQueue)
    .where(eq(replayQueue.sha1, job.sha1));
  const attempts = state?.attempts ?? 1;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const r = await ctx.mom.download(url, 512 * 1024 * 1024);
    status = r.status;
    if (r.status === 404) {
      error = 'not found on cdn';
    } else if (r.status !== 200) {
      error = `HTTP ${r.status}`;
    } else if (r.sha1 !== job.sha1) {
      error = `sha1 mismatch: got ${r.sha1}`;
    } else {
      let header: ReturnType<typeof readHeader> | null = null;
      let issues: string[] = [];
      try {
        header = readHeader(r.bytes);
        issues = checkHeader(header, {
          gamemode: job.gamemode ?? header.gamemode,
          trackType: job.trackType ?? header.trackType,
          trackNum: job.trackNum ?? header.trackNum,
          style: job.style ?? header.style,
          runTime: job.runTime ?? undefined,
          steamId: job.steamId ?? undefined,
          mapName: job.mapName ?? undefined,
        });
      } catch (e) {
        issues = [e instanceof ReplayReadError ? e.message : errMsg(e)];
      }
      const s3Key = keys.replay(job.sha1);
      await ctx.storage.put(s3Key, r.bytes, 'application/octet-stream', { sha1: job.sha1 });
      await ctx.db
        .insert(replays)
        .values({
          sha1: job.sha1,
          s3Key,
          bytes: r.bytes.length,
          downloadedAt: new Date(),
          header: header ? { ...header } : null,
          headerOk: header !== null && issues.length === 0,
          headerIssues: issues,
          headerPlayerName: header?.playerName ?? null,
          pastRunId: job.pastRunId,
          userId: job.userId,
          mapId: job.mapId,
          gamemode: job.gamemode,
          trackType: job.trackType,
          trackNum: job.trackNum,
          style: job.style,
          runTime: job.runTime,
          observedAlias: job.observedAlias,
          observedAvatarHash: job.observedAvatarHash,
          observedSteamName: job.observedSteamName,
          sourceUrl: url,
        })
        .onConflictDoNothing();
      await ctx.db.delete(replayQueue).where(eq(replayQueue.sha1, job.sha1));
      await ctx.db.delete(replayFetchFailures).where(eq(replayFetchFailures.sha1, job.sha1));
      if (r.bytes.length > CLOUDFLARE_LIMIT) {
        log.warn('replay larger than cloudflare response limit', {
          sha1: job.sha1,
          bytes: r.bytes.length,
        });
      }
      if (issues.length > 0) {
        log.warn('replay header mismatch', {
          sha1: job.sha1,
          runId: job.pastRunId,
          issues: issues.join('; '),
        });
      } else {
        log.info('replay archived', {
          sha1: job.sha1,
          runId: job.pastRunId,
          map: job.mapName,
          bytes: r.bytes.length,
        });
      }
      return;
    }
  } catch (e) {
    status = e instanceof MomApiError ? e.status : null;
    error = errMsg(e);
  }

  // failure path
  const giveUp = attempts >= MAX_ATTEMPTS || (status === 404 && attempts >= 3);
  const backoffMs = status === 404 ? 5 * 60_000 : 60_000 * 2 ** attempts;
  await ctx.db
    .insert(replayFetchFailures)
    .values({
      sha1: job.sha1,
      attempts,
      lastStatus: status,
      lastError: error,
      firstFailedAt: new Date(),
      lastFailedAt: new Date(),
      gaveUp: giveUp,
      context: {
        pastRunId: job.pastRunId,
        userId: job.userId,
        mapId: job.mapId,
        mapName: job.mapName,
        gamemode: job.gamemode,
      },
    })
    .onConflictDoUpdate({
      target: replayFetchFailures.sha1,
      set: {
        attempts,
        lastStatus: status,
        lastError: error,
        lastFailedAt: new Date(),
        gaveUp: giveUp,
      },
    });
  if (giveUp) {
    await ctx.db.update(replayQueue).set({ state: 'failed' }).where(eq(replayQueue.sha1, job.sha1));
    if (status === 404) {
      log.warn('replay gone before archive could fetch it', {
        sha1: job.sha1,
        runId: job.pastRunId,
        map: job.mapName,
      });
    } else {
      log.error('replay download gave up', { sha1: job.sha1, runId: job.pastRunId, status, error });
    }
  } else {
    await ctx.db
      .update(replayQueue)
      .set({ state: 'pending', nextAttemptAt: new Date(Date.now() + backoffMs) })
      .where(eq(replayQueue.sha1, job.sha1));
    log.warn('replay download retry scheduled', {
      sha1: job.sha1,
      attempt: attempts,
      status,
      error,
      inMs: backoffMs,
    });
  }
}

/** Re-queue failed replays whose failure was transient (for the CLI). */
export async function requeueFailedReplays(
  ctx: PollerContext,
  includeNotFound = false,
): Promise<number> {
  const rows = await execRows(
    ctx.db,
    sql`update replay_queue q set state = 'pending', attempts = 0, next_attempt_at = now()
        from replay_fetch_failures f
        where f.sha1 = q.sha1 and q.state = 'failed' and (${includeNotFound} or f.last_status is distinct from 404)
        returning q.sha1`,
  );
  return (rows as unknown as unknown[]).length;
}
