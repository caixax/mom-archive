// Dependencies injected into the HTTP app. The API only ever receives the read-only pool.
import type { Sql } from 'postgres';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { ClientStats } from '../momentum/client.js';
import type { PollerControl } from '../poller/control.js';
import type { JobStatus } from '../poller/scheduler.js';
import type { SteamStats } from '../steam/steam.js';
import type { SteamHistoryStats } from '../steam/steamhistory.js';
import type { Storage } from '../storage/s3.js';

export interface StatusSource {
  pollerEnabled: boolean;
  jobs(): JobStatus[];
  momentum(): ClientStats;
  steam(): SteamStats | null;
  steamHistory(): SteamHistoryStats | null;
}

export interface HttpDeps {
  cfg: Config;
  /** read-only pool */
  db: Db;
  /**
   * Narrow write pool for the admin tables only (sessions, announcements, user
   * notices, audit, request log). Null when the admin panel is not configured.
   */
  dbApp?: Db | null;
  dbSql: Sql;
  storage: Storage;
  status: StatusSource;
  /**
   * What the owner's panel may ask of the poller in this process: start or stop a
   * job, queue a refresh, requeue failed replays. Never a database handle.
   */
  control?: PollerControl | null;
  schemaVersion: number;
  log: Logger;
}
