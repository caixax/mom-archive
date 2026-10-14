// Same-origin JSON client. Never an absolute backend URL.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Params = Record<string, string | number | boolean | null | undefined>;

export async function api<T>(path: string, params: Params = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.pathname + url.search, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

export interface Paged<T> {
  total: number;
  page: number;
  take: number;
  data: T[];
}

export interface UserSummary {
  id: number;
  steamId: string | null;
  alias: string | null;
  country: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  roles: number;
  roleNames: string[];
  bans: number;
  banNames: string[];
  isDeleted: boolean;
  momentumCreatedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastRunAt: string | null;
  matchedOn?: string;
  matchedText?: string;
}

export interface RunRow {
  id: number;
  userId?: number;
  userAlias?: string | null;
  mapId: number;
  mapName: string;
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
  time: number;
  flags: number[] | null;
  isPb: boolean;
  rank: number | null;
  replayHash: string | null;
  replayArchived: boolean;
  momentumCreatedAt: string;
  firstSeenAt: string;
  removedAt: string | null;
  removalKind: string | null;
  observedAlias: string | null;
  observedAvatarHash: string | null;
  observedSteamName: string | null;
}

export interface LeaderboardEntry {
  userId: number;
  time: number;
  rank: number | null;
  replayHash: string | null;
  replayArchived: boolean;
  pastRunId: number | null;
  momentumCreatedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  removedAt: string | null;
  observedAlias: string | null;
  observedAvatarHash: string | null;
  currentAlias: string | null;
  currentAvatarHash: string | null;
  steamId: string | null;
}

export interface MapSummary {
  id: number;
  name: string;
  status: number;
  statusName: string;
  bucket: 'released' | 'beta' | 'other';
  submitterId: number | null;
  submitterAlias: string | null;
  currentVersionId: string | null;
  thumbnailId: string | null;
  thumbnailUrl: string | null;
  imageIds: string[];
  nativeGamemodes: number[];
  nativeGamemodeNames: string[];
  archived: boolean;
  momentumCreatedAt: string | null;
  momentumUpdatedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRefreshedAt: string | null;
  notFoundAt: string | null;
  leaderboardTypes: number[] | null;
}

export interface ChangeRow {
  type: string;
  userId: number | null;
  userAlias: string | null;
  userAvatarHash: string | null;
  mapId: number | null;
  mapName: string | null;
  runId: number | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  at: string;
}

export interface StatusComponent {
  name: string;
  ok: boolean;
  level: 'ok' | 'warn' | 'error';
  checkedAt: string;
  detail: string;
  data?: Record<string, unknown>;
}

export function avatarSrc(hash: string | null | undefined): string | null {
  return hash ? `/api/avatars/${hash}` : null;
}
