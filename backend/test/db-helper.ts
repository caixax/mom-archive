// In-process Postgres (PGlite) with the real migrations applied, for integration tests.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { migrationsFolder } from '../src/db/migrate.js';

export interface TestDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return {
    db: db as unknown as Db,
    client,
    close: () => client.close(),
  };
}
