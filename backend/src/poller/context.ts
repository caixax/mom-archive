// Everything a poller job needs, built once in main.ts.
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { MomentumClient } from '../momentum/client.js';
import type { SteamClient } from '../steam/steam.js';
import type { SteamHistoryClient } from '../steam/steamhistory.js';
import type { Storage } from '../storage/s3.js';
import type { Scheduler } from './scheduler.js';

export interface PollerContext {
  cfg: Config;
  db: Db;
  storage: Storage;
  mom: MomentumClient;
  steam: SteamClient | null;
  steamHistory: SteamHistoryClient | null;
  log: Logger;
  scheduler: Scheduler;
}

/** Per job counters returned to the scheduler for poll_log. */
export class JobCounters {
  seen = 0;
  new = 0;
  apiCallsStart = 0;
}
