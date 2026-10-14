// Shared schema pieces and helpers for routes.
import { Type, type Static } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { execRows } from '../db/index.js';

export const PageQuery = Type.Integer({ minimum: 1, maximum: 100_000, default: 1 });
export const TakeQuery = Type.Integer({ minimum: 1, maximum: 100, default: 50 });
export const IdParam = Type.Object({ id: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) });
export const BigIdParam = Type.Object({
  id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export const Sha1Param = Type.Object({
  sha1: Type.String({ pattern: '^[0-9a-f]{40}$', minLength: 40, maxLength: 40 }),
});
export const IsoDate = Type.String({ format: 'date-time', minLength: 10, maxLength: 40 });
export const GamemodeQuery = Type.Integer({ minimum: 1, maximum: 13 });
export const TrackTypeQuery = Type.Integer({ minimum: 0, maximum: 2 });
export const TrackNumQuery = Type.Integer({ minimum: 1, maximum: 255 });
export const StyleQuery = Type.Integer({ minimum: 0, maximum: 9 });
export const SearchText = Type.String({ minLength: 1, maxLength: 100 });

export const Paged = <T extends ReturnType<typeof Type.Object>>(item: T) =>
  Type.Object({
    total: Type.Integer(),
    page: Type.Integer(),
    take: Type.Integer(),
    data: Type.Array(item),
  });

export type PagedResult<T> = { total: number; page: number; take: number; data: T[] };

export function paged<T>(total: number, page: number, take: number, data: T[]): PagedResult<T> {
  return { total, page, take, data };
}

export function offsetOf(page: number, take: number): number {
  return (page - 1) * take;
}

export const AnyObject = Type.Record(Type.String(), Type.Unknown());

export type Static_<T extends ReturnType<typeof Type.Object>> = Static<T>;

/** Date the archive started watching: earliest first_seen_at in runs. Cached for a minute. */
let sinceCache: { at: number; value: string | null } | null = null;
export async function archiveSince(db: Db): Promise<string | null> {
  if (sinceCache && Date.now() - sinceCache.at < 60_000) return sinceCache.value;
  const rows = (await execRows(
    db,
    sql`select min(first_seen_at) as since from runs`,
  )) as unknown as { since: Date | string | null }[];
  const v = rows[0]?.since ?? null;
  const value = v ? new Date(v).toISOString() : null;
  sinceCache = { at: Date.now(), value };
  return value;
}

/** Simple in-process TTL cache for expensive read endpoints. */
export class TtlCache<T> {
  private value: T | null = null;
  private at = 0;
  private pending: Promise<T> | null = null;
  constructor(private readonly ttlMs: number) {}
  async get(loader: () => Promise<T>): Promise<T> {
    if (this.value !== null && Date.now() - this.at < this.ttlMs) return this.value;
    if (this.pending) return this.pending;
    this.pending = loader()
      .then((v) => {
        this.value = v;
        this.at = Date.now();
        return v;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

/** Builds an ASCII safe download filename plus an RFC 5987 UTF-8 variant. */
export function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\r\n"\\/]/g, '_').slice(0, 180);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

export function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** Format run time (seconds) as m:ss.mmm for filenames. */
export function formatTimeForFile(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}m${s.toFixed(3).padStart(6, '0')}s`;
}
