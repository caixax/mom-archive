// Rate limited HTTP client for the Momentum Mod API and CDN.
// Momentum enforces 20 requests/second and 200 requests/minute per IP; two token
// buckets keep every call under both limits.
import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import { errMsg } from '../logger.js';
import type {
  LeaderboardKey,
  MomActivity,
  MomFollow,
  MomLeaderboardRun,
  MomLeaderboardStats,
  MomMap,
  MomPastRun,
  MomUser,
  Paged,
} from './types.js';

export class MomApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = 'MomApiError';
  }
  get notFound(): boolean {
    return this.status === 404;
  }
}

/** Something that stores raw response bodies (gzipped JSON in S3). */
export interface RawSink {
  put(endpoint: string, body: Buffer, meta: { url: string; status: number }): Promise<void>;
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    initialTokens?: number,
  ) {
    this.tokens = Math.min(capacity, initialTokens ?? capacity);
  }
  /** Milliseconds to wait before one token is available, 0 when available now. */
  wait(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }
  take(): void {
    this.refill();
    this.tokens -= 1;
  }
  private refill(): void {
    const now = Date.now();
    const delta = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.refillPerSec);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Serialises acquisitions so that concurrent callers cannot overshoot the buckets. */
export class RateLimiter {
  private readonly buckets: TokenBucket[];
  private chain: Promise<void> = Promise.resolve();
  constructor(rps: number, rpm: number) {
    // Capacity 1 on the per second bucket avoids bursts that the server would count in one second.
    // The per minute bucket starts partially full so that a process restart cannot burst past
    // the server's minute window on top of what the previous process already spent.
    this.buckets = [
      new TokenBucket(Math.max(1, Math.floor(rps)), rps),
      new TokenBucket(rpm, rpm / 60, Math.ceil(rpm / 6)),
    ];
  }
  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const wait = Math.max(...this.buckets.map((b) => b.wait()));
        if (wait <= 0) break;
        await sleep(wait);
      }
      for (const b of this.buckets) b.take();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export interface ClientStats {
  lastCallAt: Date | null;
  lastOkAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  callsLastHour: number;
  callsTotal: number;
  budgetPerHour: number;
}

export interface MomentumClientOptions {
  baseUrl: string;
  cdnUrl: string;
  userAgent: string;
  rps: number;
  rpm: number;
  token?: string;
  rawSink?: RawSink;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  status: number;
  bytes: Buffer;
  contentType: string | null;
  sha1: string;
}

export class MomentumClient {
  private readonly limiter: RateLimiter;
  private readonly cdnLimiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly calls: number[] = [];
  private callsTotal = 0;
  private lastCallAt: Date | null = null;
  private lastOkAt: Date | null = null;
  private lastStatus: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: MomentumClientOptions) {
    this.limiter = new RateLimiter(opts.rps, opts.rpm);
    // The CDN is a different host with no documented limit; stay polite anyway.
    this.cdnLimiter = new RateLimiter(8, 400);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get hasToken(): boolean {
    return Boolean(this.opts.token);
  }

  stats(): ClientStats {
    this.pruneCalls();
    return {
      lastCallAt: this.lastCallAt,
      lastOkAt: this.lastOkAt,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      callsLastHour: this.calls.length,
      callsTotal: this.callsTotal,
      budgetPerHour: Math.floor(this.opts.rpm * 60),
    };
  }

  private pruneCalls(): void {
    const cutoff = Date.now() - 3600_000;
    while (this.calls.length > 0 && this.calls[0]! < cutoff) this.calls.shift();
  }

  private record(status: number | null, error: string | null): void {
    const now = new Date();
    this.lastCallAt = now;
    this.lastStatus = status;
    this.lastError = error;
    if (status !== null && status >= 200 && status < 300) this.lastOkAt = now;
    this.calls.push(now.getTime());
    this.callsTotal += 1;
    if (this.calls.length > 20_000) this.pruneCalls();
  }

  buildUrl(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): string {
    const url = new URL(this.opts.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** GET a JSON endpoint. Throws MomApiError on 4xx (404 included) and after retries on 5xx. */
  async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { auth?: boolean } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const headers: Record<string, string> = {
      'user-agent': this.opts.userAgent,
      accept: 'application/json',
    };
    if (options.auth && this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        this.record(null, errMsg(e));
        if (attempt >= 4) throw new MomApiError(0, url, `network error: ${errMsg(e)}`);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      // The body read can die mid stream (ECONNRESET); treat that as a network error too.
      let body: Buffer;
      try {
        body = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        this.record(null, errMsg(e));
        if (attempt >= 4) throw new MomApiError(0, url, `body read error: ${errMsg(e)}`);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        this.record(res.status, `HTTP ${res.status}`);
        if (attempt >= 5)
          throw new MomApiError(res.status, url, `HTTP ${res.status} after ${attempt} attempts`);
        const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        const wait = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : res.status === 429
            ? 5000
            : 1000 * 2 ** attempt;
        this.opts.logger.warn('momentum api retry', {
          status: res.status,
          attempt,
          waitMs: wait,
          path,
        });
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        this.record(res.status, res.status === 404 ? null : `HTTP ${res.status}`);
        throw new MomApiError(
          res.status,
          url,
          `HTTP ${res.status}: ${body.toString('utf8').slice(0, 200)}`,
        );
      }
      this.record(res.status, null);
      if (this.opts.rawSink) {
        try {
          await this.opts.rawSink.put(endpointKey(path), body, { url, status: res.status });
        } catch (e) {
          this.opts.logger.warn('raw snapshot failed', { path, error: errMsg(e) });
        }
      }
      try {
        return JSON.parse(body.toString('utf8')) as T;
      } catch (e) {
        throw new MomApiError(res.status, url, `invalid json: ${errMsg(e)}`);
      }
    }
  }

  /** Iterate every page of a paged endpoint, ascending skip. */
  async *pages<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    opts: { take?: number; startSkip?: number; auth?: boolean } = {},
  ): AsyncGenerator<{ page: Paged<T>; skip: number }> {
    const take = opts.take ?? 100;
    let skip = opts.startSkip ?? 0;
    for (;;) {
      const page = await this.get<Paged<T>>(path, { ...params, skip, take }, { auth: opts.auth });
      yield { page, skip };
      if (page.returnCount < take || page.data.length === 0) return;
      skip += page.returnCount;
    }
  }

  // Runs

  getRunsPage(params: {
    skip: number;
    take?: number;
    order: 'asc' | 'desc';
    mapID?: number;
    userID?: number;
    gamemode?: number;
  }): Promise<Paged<MomPastRun>> {
    return this.get<Paged<MomPastRun>>('/runs', {
      skip: params.skip,
      take: params.take ?? 100,
      orderBy: 'createdAt',
      order: params.order,
      mapID: params.mapID,
      userID: params.userID,
      gamemode: params.gamemode,
      expand: 'user,map,leaderboardRun',
    });
  }

  getRun(id: number): Promise<MomPastRun> {
    return this.get<MomPastRun>(`/runs/${id}`, { expand: 'user' });
  }

  // Maps

  static readonly MAP_EXPAND = 'info,stats,leaderboards,currentVersion,versions,credits,submitter';

  getMap(idOrName: number | string): Promise<MomMap> {
    return this.get<MomMap>(`/maps/${encodeURIComponent(String(idOrName))}`, {
      expand: MomentumClient.MAP_EXPAND,
    });
  }

  getMapsPage(params: {
    gamemode?: number;
    skip: number;
    take?: number;
    search?: string;
  }): Promise<Paged<MomMap>> {
    return this.get<Paged<MomMap>>('/maps', {
      gamemode: params.gamemode,
      skip: params.skip,
      take: params.take ?? 100,
      search: params.search,
      expand: MomentumClient.MAP_EXPAND,
    });
  }

  /** Requires MOMENTUM_TOKEN. Lists maps in submission (beta). */
  getMapSubmissionsPage(params: { skip: number; take?: number }): Promise<Paged<MomMap>> {
    return this.get<Paged<MomMap>>(
      '/maps/submissions',
      { skip: params.skip, take: params.take ?? 100, expand: MomentumClient.MAP_EXPAND },
      { auth: true },
    );
  }

  getLeaderboardPage(
    key: LeaderboardKey,
    skip: number,
    take = 100,
  ): Promise<Paged<MomLeaderboardRun>> {
    return this.get<Paged<MomLeaderboardRun>>(`/maps/${key.mapId}/leaderboard`, {
      gamemode: key.gamemode,
      trackType: key.trackType,
      trackNum: key.trackNum,
      style: key.style,
      skip,
      take,
    });
  }

  getLeaderboardStats(mapId: number): Promise<MomLeaderboardStats[]> {
    return this.get<MomLeaderboardStats[]>(`/maps/${mapId}/leaderboardStats`);
  }

  // Users

  getUser(id: number): Promise<MomUser> {
    return this.get<MomUser>(`/users/${id}`, { expand: 'profile,userStats' });
  }

  getUsersPage(params: {
    skip: number;
    take?: number;
    search?: string;
    steamIDs?: string[];
    userIDs?: number[];
  }): Promise<Paged<MomUser>> {
    return this.get<Paged<MomUser>>('/users', {
      skip: params.skip,
      take: params.take ?? 100,
      search: params.search,
      steamIDs: params.steamIDs?.join(','),
      userIDs: params.userIDs?.join(','),
      expand: 'profile,userStats',
    });
  }

  getUserActivitiesPage(userId: number, skip: number, take = 100): Promise<Paged<MomActivity>> {
    return this.get<Paged<MomActivity>>(`/users/${userId}/activities`, { skip, take });
  }

  getUserFollowersPage(userId: number, skip: number, take = 100): Promise<Paged<MomFollow>> {
    return this.get<Paged<MomFollow>>(`/users/${userId}/followers`, { skip, take });
  }

  getUserFollowsPage(userId: number, skip: number, take = 100): Promise<Paged<MomFollow>> {
    return this.get<Paged<MomFollow>>(`/users/${userId}/follows`, { skip, take });
  }

  // CDN and other binary downloads

  replayUrl(replayHash: string): string {
    return `${this.opts.cdnUrl.replace(/\/$/, '')}/runs/${replayHash}`;
  }

  mapImageUrl(imageId: string, size: 'small' | 'medium' | 'large' | 'xl' = 'large'): string {
    return `${this.opts.cdnUrl.replace(/\/$/, '')}/img/${imageId}-${size}.jpg`;
  }

  /** Download a binary file (replay, image, bsp). Does not throw on 404; check status. */
  async download(url: string, maxBytes = 200 * 1024 * 1024): Promise<DownloadResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.cdnLimiter.acquire();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'user-agent': this.opts.userAgent },
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        if (attempt >= 3) throw new MomApiError(0, url, `network error: ${errMsg(e)}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 3)
          throw new MomApiError(res.status, url, `HTTP ${res.status} after ${attempt} attempts`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        return { status: res.status, bytes: Buffer.alloc(0), contentType: null, sha1: '' };
      }
      const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new MomApiError(res.status, url, `file too large: ${declared} bytes`);
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (attempt >= 3) throw new MomApiError(0, url, `body read error: ${errMsg(e)}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (bytes.length > maxBytes)
        throw new MomApiError(res.status, url, `file too large: ${bytes.length} bytes`);
      return {
        status: res.status,
        bytes,
        contentType: res.headers.get('content-type'),
        sha1: createHash('sha1').update(bytes).digest('hex'),
      };
    }
  }
}

/** Collapses a request path into a stable folder name for raw snapshots. */
export function endpointKey(path: string): string {
  return (
    path
      .replace(/^\//, '')
      .split('/')
      .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{36}$/.test(seg) ? '_' : seg))
      .filter((seg) => seg !== '_')
      .join('-')
      .replace(/[^a-zA-Z0-9-]/g, '_') || 'root'
  );
}
