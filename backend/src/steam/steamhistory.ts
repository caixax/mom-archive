// SteamHistory.net client. One public endpoint: SourceBans lookups, 100 ids per call.
import type { Logger } from '../logger.js';
import { errMsg } from '../logger.js';
import { RateLimiter } from '../momentum/client.js';
import type { RawSink } from '../momentum/client.js';

export interface SourceBan {
  SteamID: string;
  Name: string | null;
  CurrentState: 'Permanent' | 'Temp-Ban' | 'Expired' | 'Unbanned' | string;
  BanReason: string | null;
  UnbanReason: string | null;
  /** unix seconds */
  BanTimestamp: number;
  /** unix seconds, 0 when permanent or unknown */
  UnbanTimestamp: number;
  Server: string;
}

export interface SteamHistoryOptions {
  apiKey: string;
  userAgent: string;
  rawSink?: RawSink;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface SteamHistoryStats {
  lastCallAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  callsTotal: number;
}

export class SteamHistoryClient {
  private readonly limiter = new RateLimiter(1, 60);
  private readonly fetchImpl: typeof fetch;
  private lastCallAt: Date | null = null;
  private lastStatus: number | null = null;
  private lastError: string | null = null;
  private callsTotal = 0;

  constructor(private readonly opts: SteamHistoryOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  stats(): SteamHistoryStats {
    return {
      lastCallAt: this.lastCallAt,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      callsTotal: this.callsTotal,
    };
  }

  /** Returns a map steamID64 -> bans[] for the requested ids. Ids with no bans are absent. */
  async getSourceBans(steamIds: string[]): Promise<Map<string, SourceBan[]>> {
    const out = new Map<string, SourceBan[]>();
    if (steamIds.length === 0) return out;
    if (steamIds.length > 100) throw new Error('max 100 steam ids per call');
    const url = new URL('https://steamhistory.net/api/sourcebans');
    url.searchParams.set('key', this.opts.apiKey);
    url.searchParams.set('steamids', steamIds.join(','));
    url.searchParams.set('shouldkey', '1');
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.limiter.acquire();
      this.callsTotal += 1;
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
        if (attempt >= 3) throw new Error(`steamhistory network error: ${errMsg(e)}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      this.lastStatus = res.status;
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status === 429 || res.status >= 500) {
        this.lastError = `HTTP ${res.status}`;
        if (attempt >= 3) throw new Error(`steamhistory HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 10_000 * attempt));
        continue;
      }
      if (!res.ok) {
        this.lastError = `HTTP ${res.status}`;
        throw new Error(`steamhistory HTTP ${res.status}`);
      }
      this.lastError = null;
      if (this.opts.rawSink) {
        try {
          await this.opts.rawSink.put('steamhistory-sourcebans', body, {
            url: 'steamhistory/sourcebans',
            status: res.status,
          });
        } catch (e) {
          this.opts.logger.warn('raw snapshot failed', {
            endpoint: 'sourcebans',
            error: errMsg(e),
          });
        }
      }
      const parsed = JSON.parse(body.toString('utf8')) as {
        response?: Record<string, SourceBan[]> | SourceBan[];
      };
      const resp = parsed.response ?? {};
      if (Array.isArray(resp)) {
        for (const b of resp) {
          const list = out.get(b.SteamID) ?? [];
          list.push(b);
          out.set(b.SteamID, list);
        }
      } else {
        for (const [id, list] of Object.entries(resp)) out.set(id, Array.isArray(list) ? list : []);
      }
      return out;
    }
  }
}
