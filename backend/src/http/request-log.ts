// Request log. Every answered request is appended to an in memory buffer and
// flushed in batches, so logging never sits in the request path. Rows are pruned
// by the housekeeping job, so the log is a rolling window, not a permanent record.
import type { Db } from '../db/index.js';
import { requestLog } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { errMsg } from '../logger.js';

export interface RequestLogRow {
  at: Date;
  ip: string | null;
  country: string | null;
  method: string;
  path: string;
  route: string;
  query: string | null;
  status: number;
  ms: number;
  bytes: number | null;
  userAgent: string | null;
  referer: string | null;
  admin: boolean;
}

export interface RequestLoggerOptions {
  db: Db;
  log: Logger;
  flushMs?: number;
  /** Rows kept in memory before a flush is forced. */
  maxBuffer?: number;
}

export class RequestLogger {
  private buffer: RequestLogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private dropped = 0;
  private readonly maxBuffer: number;

  constructor(private readonly opts: RequestLoggerOptions) {
    this.maxBuffer = opts.maxBuffer ?? 2000;
    this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 5000);
    this.timer.unref();
  }

  add(row: RequestLogRow): void {
    if (this.buffer.length >= this.maxBuffer) {
      // Never grow without bound: drop and say so once per flush.
      this.dropped += 1;
      return;
    }
    this.buffer.push(row);
    if (this.buffer.length >= this.maxBuffer / 2) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    const dropped = this.dropped;
    this.dropped = 0;
    try {
      for (let i = 0; i < batch.length; i += 500) {
        await this.opts.db.insert(requestLog).values(batch.slice(i, i + 500));
      }
      if (dropped > 0) this.opts.log.warn('request log buffer overflowed', { dropped });
    } catch (e) {
      this.opts.log.warn('request log flush failed', { rows: batch.length, error: errMsg(e) });
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/**
 * Collapses a path so the log groups: ids, hashes and names become a placeholder.
 * Without this the top paths view is one row per user.
 */
export function normalizePath(path: string): string {
  const clean = path.split('?')[0] ?? '';
  return (
    clean
      .split('/')
      .map((seg) => {
        if (seg.length === 0) return seg;
        if (/^\d+$/.test(seg)) return ':id';
        if (/^[0-9a-f]{40}$/i.test(seg)) return ':sha1';
        if (/^[0-9a-f-]{36}$/i.test(seg)) return ':uuid';
        return seg;
      })
      .join('/')
      .slice(0, 200) || '/'
  );
}
