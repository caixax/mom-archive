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

export interface JobProgress {
  done: number;
  total: number | null;
  note?: string;
}

/** Long jobs call this as they go so the owner's panel can show how far they got. */
export type ProgressFn = (p: JobProgress) => void;

export type JobFn = (
  signal: AbortSignal,
  progress: ProgressFn,
  args?: Record<string, unknown>,
) => Promise<JobResult | void>;

export interface JobDefinition {
  name: string;
  /** Interval between runs in ms. 0 means manual/continuous (workers). */
  intervalMs: number;
  /** Delay before the first run, ms */
  initialDelayMs?: number;
  run: JobFn;
  /** Workers run forever; the scheduler only starts them and reports health. */
  worker?: boolean;
  /** Never scheduled; runs only when started by hand (CLI or the owner's panel). */
  manual?: boolean;
}

export type StartResult = 'started' | 'running' | 'unknown' | 'worker' | 'stopped';

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
  worker: boolean;
  manual: boolean;
  progress: (JobProgress & { at: Date }) | null;
  cancelRequested: boolean;
}

export class Scheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly status = new Map<string, JobStatus>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, AbortController>();
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
      worker: def.worker ?? false,
      manual: def.manual ?? false,
      progress: null,
      cancelRequested: false,
    });
  }

  begin(): void {
    for (const def of this.jobs.values()) {
      if (def.worker) {
        void this.runWorker(def);
        continue;
      }
      if (def.manual) continue;
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
  async trigger(name: string, args?: Record<string, unknown>): Promise<boolean> {
    const def = this.jobs.get(name);
    if (!def) throw new Error(`unknown job ${name}`);
    const st = this.status.get(name)!;
    if (st.running) return false;
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    await this.tick(def, args);
    return true;
  }

  /** Starts a job in the background and answers at once; the next scheduled tick moves to after it. */
  start(name: string, args?: Record<string, unknown>): StartResult {
    const def = this.jobs.get(name);
    if (!def) return 'unknown';
    if (def.worker) return 'worker';
    if (this.stopped) return 'stopped';
    if (this.status.get(name)!.running) return 'running';
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    void this.tick(def, args);
    return 'started';
  }

  /** Asks a running job to stop. Jobs check their signal between batches, so it ends soon, not instantly. */
  cancel(name: string): boolean {
    const ac = this.running.get(name);
    if (!ac) return false;
    this.status.get(name)!.cancelRequested = true;
    ac.abort();
    return true;
  }

  has(name: string): boolean {
    return this.jobs.has(name);
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
        await def.run(this.abort.signal, () => {});
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

  private async tick(def: JobDefinition, args?: Record<string, unknown>): Promise<void> {
    if (this.stopped) return;
    const st = this.status.get(def.name)!;
    if (st.running) return;
    st.running = true;
    st.progress = null;
    st.cancelRequested = false;
    const ac = new AbortController();
    const onStop = () => ac.abort();
    this.abort.signal.addEventListener('abort', onStop);
    this.running.set(def.name, ac);
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
      const progress: ProgressFn = (p) => {
        st.progress = { ...p, at: new Date() };
      };
      result = (await def.run(ac.signal, progress, args)) ?? {};
      ok = true;
    } catch (e) {
      error = errMsg(e);
    } finally {
      this.running.delete(def.name);
      this.abort.signal.removeEventListener('abort', onStop);
    }
    if (st.cancelRequested && ok)
      result.note = [result.note, 'cancelled'].filter(Boolean).join(' ');
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
    if (!this.stopped && def.intervalMs > 0 && !def.manual) {
      st.nextRunAt = new Date(Date.now() + def.intervalMs);
      this.timers.set(
        def.name,
        setTimeout(() => void this.tick(def), def.intervalMs),
      );
    }
  }
}
