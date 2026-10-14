// Pure diffing helpers. No database access here so it is easy to unit test.
import { createHash } from 'node:crypto';
import { Ban, STEAM_MISSING_AVATAR } from '../momentum/enums.js';
import { avatarHashFromUrl } from '../momentum/steamid.js';
import type { MomMap, MomUser } from '../momentum/types.js';

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Stable JSON: object keys sorted recursively so hashes do not depend on key order. */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function stableHash(v: unknown): string {
  return createHash('sha1').update(stableStringify(v)).digest('hex');
}

/** Text form used in *_field_changes. null for null/undefined, JSON for objects. */
export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  return stableStringify(v);
}

/**
 * Compares the fields that are present in `next` (not undefined) against `prev`.
 * A missing `prev` means first observation: nothing to diff.
 */
export function diffFields(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
  fields?: string[],
): FieldChange[] {
  if (!prev) return [];
  const out: FieldChange[] = [];
  const keys = fields ?? Object.keys(next);
  for (const field of keys) {
    const n = next[field];
    if (n === undefined) continue;
    const a = toText(prev[field]);
    const b = toText(n);
    if (a !== b) out.push({ field, oldValue: a, newValue: b });
  }
  return out;
}

// Users

export interface UserObservation {
  id: number;
  steamId: string | null;
  momentumCreatedAt: Date | null;
  /** Flat field map; only present fields are compared and written */
  fields: Record<string, unknown>;
  /** True when profile and userStats were included (GET /users/:id) */
  full: boolean;
  avatarHash: string | null;
  alias: string | null;
}

export const USER_SUMMARY_FIELDS = [
  'alias',
  'country',
  'avatar',
  'avatar_hidden',
  'roles',
  'bans',
] as const;
export const USER_STATS_FIELDS = [
  'cosXP',
  'level',
  'mapsCompleted',
  'runsSubmitted',
  'totalJumps',
  'totalStrafes',
] as const;

export function normalizeUser(u: MomUser): UserObservation {
  const avatarHash = avatarHashFromUrl(u.avatarURL);
  const fields: Record<string, unknown> = {
    alias: u.alias ?? null,
    country: u.country ?? null,
    avatar: avatarHash,
    avatar_hidden: (u.bans & Ban.AVATAR) !== 0 || avatarHash === STEAM_MISSING_AVATAR,
    roles: u.roles ?? 0,
    bans: u.bans ?? 0,
  };
  const full = u.profile !== undefined && u.userStats !== undefined;
  if (u.profile !== undefined) {
    fields.bio = u.profile.bio ?? '';
    const socials = u.profile.socials ?? {};
    fields.socials = socials;
    for (const [k, v] of Object.entries(socials)) fields[`social:${k}`] = v ?? null;
  }
  if (u.userStats !== undefined) {
    for (const f of USER_STATS_FIELDS) fields[f] = u.userStats[f] ?? null;
  }
  return {
    id: u.id,
    steamId: u.steamID ?? null,
    momentumCreatedAt: u.createdAt ? new Date(u.createdAt) : null,
    fields,
    full,
    avatarHash,
    alias: u.alias ?? null,
  };
}

/** Flat field map from a stored users row, matching normalizeUser keys. */
export function userRowToFields(row: {
  alias: string | null;
  country: string | null;
  avatarHash: string | null;
  roles: number;
  bans: number;
  bio: string | null;
  socials: Record<string, string> | null;
  cosXp: number | null;
  level: number | null;
  mapsCompleted: number | null;
  runsSubmitted: number | null;
  totalJumps: number | null;
  totalStrafes: number | null;
  profileFetched: boolean;
}): Record<string, unknown> {
  const f: Record<string, unknown> = {
    alias: row.alias,
    country: row.country,
    avatar: row.avatarHash,
    avatar_hidden: (row.bans & Ban.AVATAR) !== 0 || row.avatarHash === STEAM_MISSING_AVATAR,
    roles: row.roles,
    bans: row.bans,
  };
  if (row.profileFetched) {
    f.bio = row.bio ?? '';
    f.socials = row.socials ?? {};
    for (const [k, v] of Object.entries(row.socials ?? {})) f[`social:${k}`] = v;
    f.cosXP = row.cosXp;
    f.level = row.level;
    f.mapsCompleted = row.mapsCompleted;
    f.runsSubmitted = row.runsSubmitted;
    f.totalJumps = row.totalJumps;
    f.totalStrafes = row.totalStrafes;
  }
  return f;
}

/** Socials need a union of keys so removed socials show as a change to null. */
export function diffUserFields(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): FieldChange[] {
  if (!prev) return [];
  const keys = new Set<string>();
  for (const k of Object.keys(next)) if (k !== 'socials') keys.add(k);
  if (next.socials !== undefined) {
    for (const k of Object.keys(prev)) if (k.startsWith('social:')) keys.add(k);
    for (const k of keys) {
      if (k.startsWith('social:') && next[k] === undefined) next[k] = null;
    }
  }
  return diffFields(prev, next, [...keys]);
}

// Maps

export interface MapObservation {
  id: number;
  name: string;
  status: number;
  fields: Record<string, unknown>;
  /** True when info, stats, leaderboards etc were included */
  full: boolean;
  imageIds: string[];
  thumbnailId: string | null;
}

export function leaderboardFieldKey(lb: {
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
}): string {
  return `${lb.gamemode}:${lb.trackType}:${lb.trackNum}:${lb.style}`;
}

export function normalizeMap(m: MomMap): MapObservation {
  const fields: Record<string, unknown> = {
    name: m.name,
    status: m.status,
    submitterID: m.submitterID ?? null,
    currentVersionID: m.currentVersionID ?? null,
    images: (m.images ?? []).map((i) => i.id),
  };
  const full = m.info !== undefined && m.leaderboards !== undefined;
  if (m.info) {
    fields.description = m.info.description ?? '';
    fields.youtubeID = m.info.youtubeID ?? null;
    fields.creationDate = m.info.creationDate ?? null;
    fields.approvedDate = m.info.approvedDate ?? null;
    fields.requiredGames = m.info.requiredGames ?? [];
  }
  if (m.stats) {
    for (const [k, v] of Object.entries(m.stats)) fields[`stats.${k}`] = v;
  }
  if (m.leaderboards) {
    const sorted = [...m.leaderboards].sort((a, b) =>
      leaderboardFieldKey(a).localeCompare(leaderboardFieldKey(b)),
    );
    fields.leaderboards = sorted.map(leaderboardFieldKey);
    for (const lb of sorted) {
      const k = leaderboardFieldKey(lb);
      fields[`leaderboard:${k}:tier`] = lb.tier ?? null;
      fields[`leaderboard:${k}:tags`] = [...(lb.tags ?? [])].sort((a, b) => a - b);
      fields[`leaderboard:${k}:type`] = lb.type;
      fields[`leaderboard:${k}:linear`] = lb.linear;
    }
  }
  if (m.credits) {
    fields.credits = [...m.credits]
      .map((c) => ({ type: c.type, userID: c.userID, description: c.description ?? null }))
      .sort((a, b) => a.type - b.type || a.userID - b.userID);
  }
  if (m.versions) {
    fields.versions = [...m.versions].sort((a, b) => a.versionNum - b.versionNum).map((v) => v.id);
  }
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    fields,
    full,
    imageIds: (m.images ?? []).map((i) => i.id),
    thumbnailId: m.thumbnail?.id ?? null,
  };
}

/** Leaderboard fields need a union of keys so removed leaderboards show as changes. */
export function diffMapFields(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): FieldChange[] {
  if (!prev) return [];
  const keys = new Set<string>(Object.keys(next));
  if (next.leaderboards !== undefined) {
    for (const k of Object.keys(prev)) {
      if (k.startsWith('leaderboard:') && next[k] === undefined) {
        keys.add(k);
        next[k] = null;
      }
    }
  }
  return diffFields(prev, next, [...keys]);
}

// Leaderboards

export interface BoardEntryLike {
  userId: number;
  time: number;
  rank: number | null;
  replayHash: string | null;
  pastRunId: number | null;
}

export function boardHash(entries: BoardEntryLike[]): string {
  const sorted = [...entries].sort((a, b) => a.userId - b.userId);
  return stableHash(sorted.map((e) => [e.userId, e.time, e.rank, e.replayHash, e.pastRunId]));
}

export interface BoardDiff<A extends BoardEntryLike, B extends BoardEntryLike = A> {
  added: B[];
  removed: A[];
  improved: { before: A; after: B }[];
  unchanged: number;
}

export function diffBoards<A extends BoardEntryLike, B extends BoardEntryLike = A>(
  before: A[],
  after: B[],
): BoardDiff<A, B> {
  const prev = new Map(before.map((e) => [e.userId, e]));
  const out: BoardDiff<A, B> = { added: [], removed: [], improved: [], unchanged: 0 };
  for (const e of after) {
    const p = prev.get(e.userId);
    if (!p) out.added.push(e);
    else if (
      p.replayHash !== e.replayHash ||
      Math.abs(p.time - e.time) > 1e-9 ||
      p.pastRunId !== e.pastRunId
    ) {
      out.improved.push({ before: p, after: e });
    } else out.unchanged += 1;
    prev.delete(e.userId);
  }
  out.removed = [...prev.values()];
  return out;
}
