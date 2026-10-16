// Builds the shared runtime: config, logger, database pools, storage, API clients, scheduler.
import { config, type Config } from './config.js';
import { createPools, type DbPools } from './db/index.js';
import { createRootLogger, getLogger, type Logger } from './logger.js';
import { MomentumClient } from './momentum/client.js';
import type { PollerContext } from './poller/context.js';
import { Scheduler } from './poller/scheduler.js';
import { SteamClient } from './steam/steam.js';
import { SteamHistoryClient } from './steam/steamhistory.js';
import { RawStore } from './storage/raw.js';
import { Storage } from './storage/s3.js';

export interface Runtime {
  cfg: Config;
  log: Logger;
  pools: DbPools;
  storage: Storage;
  mom: MomentumClient;
  steam: SteamClient | null;
  steamHistory: SteamHistoryClient | null;
  scheduler: Scheduler;
  poller: PollerContext;
  close(): Promise<void>;
}

export function bootstrap(): Runtime {
  const cfg = config();
  createRootLogger({
    level: cfg.LOG_LEVEL,
    dev: cfg.isDev,
    dir: cfg.LOG_DIR,
    file: cfg.NODE_ENV !== 'test',
  });
  const log = getLogger('app');
  const pools = createPools({
    rw: cfg.DATABASE_URL_RW,
    ro: cfg.DATABASE_URL_RO,
    app: cfg.adminEnabled ? cfg.DATABASE_URL_APP : undefined,
  });
  const storage = new Storage({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    bucket: cfg.S3_BUCKET,
    accessKey: cfg.S3_ACCESS_KEY,
    secretKey: cfg.S3_SECRET_KEY,
  });
  const raw = new RawStore(storage);
  const mom = new MomentumClient({
    baseUrl: cfg.MOMENTUM_API,
    cdnUrl: cfg.MOMENTUM_CDN,
    userAgent: cfg.USER_AGENT,
    rps: cfg.RATE_LIMIT_RPS,
    rpm: cfg.RATE_LIMIT_RPM,
    token: cfg.MOMENTUM_TOKEN || undefined,
    rawSink: raw,
    logger: getLogger('momentum'),
  });
  const steam = cfg.steamEnabled
    ? new SteamClient({
        apiKey: cfg.STEAM_API_KEY,
        userAgent: cfg.USER_AGENT,
        rawSink: raw,
        logger: getLogger('steam'),
      })
    : null;
  const steamHistory = cfg.steamHistoryEnabled
    ? new SteamHistoryClient({
        apiKey: cfg.STEAMHISTORY_API_KEY,
        userAgent: cfg.USER_AGENT,
        rawSink: raw,
        logger: getLogger('steamhistory'),
      })
    : null;
  const scheduler = new Scheduler(pools.rw, mom, getLogger('scheduler'));
  const poller: PollerContext = {
    cfg,
    db: pools.rw,
    storage,
    mom,
    steam,
    steamHistory,
    log: getLogger('poller'),
    scheduler,
  };
  return {
    cfg,
    log,
    pools,
    storage,
    mom,
    steam,
    steamHistory,
    scheduler,
    poller,
    async close() {
      await scheduler.stop();
      await pools.close();
    },
  };
}
