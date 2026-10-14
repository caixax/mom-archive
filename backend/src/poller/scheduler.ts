// Interval scheduler with a per job mutex. A failing tick never blocks the next one.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { pollLog } from '../db/schema.js';
import { errMsg, type Logger } from '../logger.js';
import type { MomentumClient } from '../momentum/client.js';

export interface JobResult {
  seen?: number;
  new?: number;
  /** Short note appended to the summary log line */
  note?: string;
}

export type JobFn = (signal: AbortSignal) => Promise<JobResult | void>;

export interface JobDefinition {
  name: string;
  /** Interval between runs in ms. 0 means manual/continuous (workers). */
  intervalMs: number;
  /** Delay before the first run, ms */
  initialDelayMs?: number;
  run: JobFn;
  /** Workers run forever; the scheduler only starts them and reports health. */
  worker?: boolean;
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  running: boolean;
  lastStartAt: Date | null;
  lastSuccessAt: Date | null;
  lastFinishAt: Date | null;
  lastError: string | null;
  lastItemsSeen: number;
  lastItemsNew: number;
  lastDurationMs: number | null;
  nextRunAt: Date | null;
  runs: number;
  failures: number;
}

export class Scheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly status = new Map<string, JobStatus>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly mom: MomentumClient,
    private readonly log: Logger,
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  register(def: JobDefinition): void {
    this.jobs.set(def.name, def);
    this.status.set(def.name, {
      name: def.name,
      intervalMs: def.intervalMs,
      running: false,
      lastStartAt: null,
      lastSuccessAt: null,
      lastFinishAt: null,
      lastError: null,
      lastItemsSeen: 0,
      lastItemsNew: 0,
      lastDurationMs: null,
      nextRunAt: null,
      runs: 0,
      failures: 0,
    });
  }

  start(): void {
    for (const def of this.jobs.values()) {
      if (def.worker) {
        void this.runWorker(def);
        continue;
      }
      const delay = def.initialDelayMs ?? 0;
      this.status.get(def.name)!.nextRunAt = new Date(Date.now() + delay);
      this.timers.set(
        def.name,
        setTimeout(() => void this.tick(def), delay),
      );
    }
    this.log.info('scheduler started', { jobs: this.jobs.size });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && [...this.status.values()].some((s) => s.running)) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Runs a job now if it is not already running. Returns false when skipped. */
  async trigger(name: string): Promise<boolean> {
    const def = this.jobs.get(name);
    if (!def) throw new Error(`unknown job ${name}`);
    const st = this.status.get(name)!;
    if (st.running) return false;
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    await this.tick(def);
    return true;
  }

  statuses(): JobStatus[] {
    return [...this.status.values()].map((s) => ({ ...s }));
  }

  private async runWorker(def: JobDefinition): Promise<void> {
    const st = this.status.get(def.name)!;
    st.running = true;
    st.lastStartAt = new Date();
    while (!this.stopped) {
      try {
        await def.run(this.abort.signal);
        st.lastSuccessAt = new Date();
        st.lastError = null;
      } catch (e) {
        st.failures += 1;
        st.lastError = errMsg(e);
        this.log.error(`${def.name} worker crashed, restarting in 10s`, { error: errMsg(e) });
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 1000));
    }
    st.running = false;
  }

  private async tick(def: JobDefinition): Promise<void> {
    if (this.stopped) return;
    const st = this.status.get(def.name)!;
    if (st.running) return;
    st.running = true;
    st.runs += 1;
    const startedAt = new Date();
    st.lastStartAt = startedAt;
    st.nextRunAt = null;
    const callsBefore = this.mom.stats().callsTotal;
    let logId: number | null = null;
    try {
      const [row] = await this.db
        .insert(pollLog)
        .values({ job: def.name, startedAt })
        .returning({ id: pollLog.id });
      logId = row?.id ?? null;
    } catch (e) {
      this.log.warn('poll_log insert failed', { job: def.name, error: errMsg(e) });
    }
    let ok = false;
    let error: string | null = null;
    let result: JobResult = {};
    try {
      result = (await def.run(this.abort.signal)) ?? {};
      ok = true;
    } catch (e) {
      error = errMsg(e);
    }
    const finishedAt = new Date();
    const apiCalls = this.mom.stats().callsTotal - callsBefore;
    st.running = false;
    st.lastFinishAt = finishedAt;
    st.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
    st.lastItemsSeen = result.seen ?? 0;
    st.lastItemsNew = result.new ?? 0;
    if (ok) {
      st.lastSuccessAt = finishedAt;
      st.lastError = null;
      this.log.info(`${def.name} done`, {
        seen: result.seen ?? 0,
        new: result.new ?? 0,
        apiCalls,
        ms: st.lastDurationMs,
        ...(result.note ? { note: result.note } : {}),
      });
    } else {
      st.failures += 1;
      st.lastError = error;
      this.log.error(`${def.name} failed`, { error, apiCalls, ms: st.lastDurationMs });
    }
    if (logId !== null) {
      try {
        await this.db
          .update(pollLog)
          .set({
            finishedAt,
            ok,
            itemsSeen: result.seen ?? 0,
            itemsNew: result.new ?? 0,
            apiCalls,
            error,
          })
          .where(eq(pollLog.id, logId));
      } catch (e) {
        this.log.warn('poll_log update failed', { job: def.name, error: errMsg(e) });
      }
    }
    if (!this.stopped && def.intervalMs > 0) {
      st.nextRunAt = new Date(Date.now() + def.intervalMs);
      this.timers.set(
        def.name,
        setTimeout(() => void this.tick(def), def.intervalMs),
      );
    }
  }
}
