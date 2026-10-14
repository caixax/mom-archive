// Applies the SQL migrations under backend/drizzle with the read-write role.
// Usable as a library (main.ts runs it on boot) and as a script (pnpm migrate).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Works from src (tsx) and from dist (compiled). */
export function migrationsFolder(): string {
  const candidates = [join(here, '..', '..', 'drizzle'), join(here, '..', 'drizzle')];
  for (const c of candidates) if (existsSync(join(c, 'meta', '_journal.json'))) return c;
  throw new Error('drizzle migrations folder not found');
}

/** Number of migrations in the journal, reported by /api/health as the schema version. */
export function schemaVersion(): number {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [{ config }, { createPools }, { getLogger }] = await Promise.all([
    import('../config.js'),
    import('./index.js'),
    import('../logger.js'),
  ]);
  const cfg = config();
  const log = getLogger('migrate');
  const pools = createPools({ rw: cfg.DATABASE_URL_RW, ro: cfg.DATABASE_URL_RO });
  try {
    await runMigrations(pools.rw);
    log.info('migrations applied', { schema: schemaVersion() });
  } finally {
    await pools.close();
  }
}
