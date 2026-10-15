// Steam Web API client: GetPlayerSummaries and GetPlayerBans, 100 ids per call.
import type { Logger } from '../logger.js';
import { errMsg } from '../logger.js';
import { RateLimiter } from '../momentum/client.js';
import type { RawSink } from '../momentum/client.js';

export interface SteamSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  avatarhash: string;
  profilestate?: number;
  communityvisibilitystate?: number;
  timecreated?: number;
  loccountrycode?: string;
  personastate?: number;
}

export interface SteamBans {
  SteamId: string;
  CommunityBanned: boolean;
  VACBanned: boolean;
  NumberOfVACBans: number;
  DaysSinceLastBan: number;
  NumberOfGameBans: number;
  EconomyBan: string;
}

export interface SteamClientOptions {
  apiKey: string;
  userAgent: string;
  rawSink?: RawSink;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface SteamStats {
  lastCallAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  callsToday: number;
  dailyQuota: number;
}

const DAILY_QUOTA = 100_000;

export class SteamClient {
  private readonly limiter = new RateLimiter(4, 200);
  private readonly fetchImpl: typeof fetch;
  private lastCallAt: Date | null = null;
  private lastStatus: number | null = null;
  private lastError: string | null = null;
  private dayKey = '';
  private callsToday = 0;

  constructor(private readonly opts: SteamClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  stats(): SteamStats {
    this.rollDay();
    return {
      lastCallAt: this.lastCallAt,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      callsToday: this.callsToday,
      dailyQuota: DAILY_QUOTA,
    };
  }

  /** True when there is still budget today, leaving a safety margin. */
  hasBudget(): boolean {
    this.rollDay();
    return this.callsToday < DAILY_QUOTA * 0.9;
  }

  private rollDay(): void {
    const k = new Date().toISOString().slice(0, 10);
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.callsToday = 0;
    }
  }

  private async call<T>(
    iface: string,
    method: string,
    version: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`https://api.steampowered.com/${iface}/${method}/${version}/`);
    url.searchParams.set('key', this.opts.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.limiter.acquire();
      this.rollDay();
      this.callsToday += 1;
      this.lastCallAt = new Date();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'user-agent': this.opts.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        this.lastError = errMsg(e);
        this.lastStatus = null;
        if (attempt >= 3) throw new Error(`steam api network error: ${errMsg(e)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      this.lastStatus = res.status;
      let body: Buffer;
      try {
        body = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        this.lastError = errMsg(e);
        if (attempt >= 3) throw new Error(`steam api body read error: ${errMsg(e)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        this.lastError = `HTTP ${res.status}`;
        if (attempt >= 3) throw new Error(`steam api HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      if (!res.ok) {
        this.lastError = `HTTP ${res.status}`;
        throw new Error(`steam api HTTP ${res.status}`);
      }
      this.lastError = null;
      if (this.opts.rawSink) {
        try {
          await this.opts.rawSink.put(`steam-${method}`, body, {
            url: `${iface}/${method}`,
            status: res.status,
          });
        } catch (e) {
          this.opts.logger.warn('raw snapshot failed', { endpoint: method, error: errMsg(e) });
        }
      }
      return JSON.parse(body.toString('utf8')) as T;
    }
  }

  async getPlayerSummaries(steamIds: string[]): Promise<SteamSummary[]> {
    if (steamIds.length === 0) return [];
    if (steamIds.length > 100) throw new Error('max 100 steam ids per call');
    const r = await this.call<{ response: { players: SteamSummary[] } }>(
      'ISteamUser',
      'GetPlayerSummaries',
      'v2',
      {
        steamids: steamIds.join(','),
      },
    );
    return r.response?.players ?? [];
  }

  async getPlayerBans(steamIds: string[]): Promise<SteamBans[]> {
    if (steamIds.length === 0) return [];
    if (steamIds.length > 100) throw new Error('max 100 steam ids per call');
    const r = await this.call<{ players: SteamBans[] }>('ISteamUser', 'GetPlayerBans', 'v1', {
      steamids: steamIds.join(','),
    });
    return r.players ?? [];
  }
}
