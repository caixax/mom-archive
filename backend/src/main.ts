// One process: migrations, HTTP API (read-only pool) and the poller (read-write pool).
import { bootstrap } from './bootstrap.js';
import { runMigrations, schemaVersion } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { getLogger, errMsg } from './logger.js';
import { registerJobs } from './poller/index.js';

async function main(): Promise<void> {
  const rt = bootstrap();
  const log = getLogger('main');
  const cfg = rt.cfg;

  log.info('starting', {
    env: cfg.NODE_ENV,
    gamemodes: cfg.ARCHIVE_GAMEMODES.join(','),
    poller: cfg.POLLER_ENABLED,
    steam: cfg.steamEnabled,
    steamhistory: cfg.steamHistoryEnabled,
    admin: cfg.adminEnabled ? cfg.ADMIN_STEAM_IDS.length : false,
  });

  await runMigrations(rt.pools.rw);
  const schema = schemaVersion();
  log.info('database ready', { schema });

  try {
    const ms = await rt.storage.headBucket();
    log.info('storage ready', { bucket: cfg.S3_BUCKET, ms });
  } catch (e) {
    log.error('storage not reachable, refusing to start', { error: errMsg(e) });
    await rt.close();
    process.exit(1);
  }

  const app = await buildApp({
    cfg,
    db: rt.pools.ro,
    dbApp: rt.pools.app,
    dbSql: rt.pools.roSql,
    storage: rt.storage,
    schemaVersion: schema,
    log: getLogger('http'),
    status: {
      pollerEnabled: cfg.POLLER_ENABLED,
      jobs: () => rt.scheduler.statuses(),
      momentum: () => rt.mom.stats(),
      steam: () => rt.steam?.stats() ?? null,
      steamHistory: () => rt.steamHistory?.stats() ?? null,
    },
  });

  await app.listen({ port: cfg.PORT, host: cfg.BIND_HOST });
  log.info('http listening', { host: cfg.BIND_HOST, port: cfg.PORT });

  if (cfg.POLLER_ENABLED) {
    registerJobs(rt.poller);
    rt.scheduler.start();
  } else {
    log.warn('poller disabled (POLLER_ENABLED=false)');
  }

  if (process.send) process.send('ready');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const timer = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 28_000);
    try {
      await app.close();
      await rt.close();
      clearTimeout(timer);
      log.info('bye');
      process.exit(0);
    } catch (e) {
      log.error('shutdown error', { error: errMsg(e) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errMsg(e) }));
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { error: errMsg(e), stack: e.stack });
    void shutdown('uncaughtException');
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
