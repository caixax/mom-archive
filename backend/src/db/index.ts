// Two connection pools: rw for the poller and migrations, ro for the HTTP API.
import type { SQL } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbPools {
  rw: Db;
  ro: Db;
  /** Narrow write role for the admin tables. Null when the admin panel is off. */
  app: Db | null;
  rwSql: Sql;
  roSql: Sql;
  close(): Promise<void>;
}

export function createPools(urls: { rw: string; ro: string; app?: string }): DbPools {
  const rwSql = postgres(urls.rw, {
    max: 16,
    idle_timeout: 60,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => undefined,
  });
  const roSql = postgres(urls.ro, {
    max: 16,
    idle_timeout: 60,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => undefined,
  });
  const appSql = urls.app
    ? postgres(urls.app, {
        max: 8,
        idle_timeout: 60,
        connect_timeout: 10,
        prepare: true,
        onnotice: () => undefined,
      })
    : null;
  return {
    rw: drizzle(rwSql, { schema }),
    ro: drizzle(roSql, { schema }),
    app: appSql ? drizzle(appSql, { schema }) : null,
    rwSql,
    roSql,
    async close() {
      await Promise.all([
        rwSql.end({ timeout: 5 }),
        roSql.end({ timeout: 5 }),
        ...(appSql ? [appSql.end({ timeout: 5 })] : []),
      ]);
    },
  };
}

/** Minimal executor interface shared by the postgres-js pool, transactions and the PGlite test driver. */
export interface Executor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Runs a raw SQL query and returns its rows. postgres-js returns the row array directly,
 * PGlite (used in tests) returns { rows }. This hides the difference.
 */
export async function execRows<T = Record<string, unknown>>(
  db: Executor,
  query: SQL,
): Promise<T[]> {
  const r = (await db.execute(query)) as unknown;
  if (Array.isArray(r)) return r as T[];
  const obj = r as { rows?: unknown };
  return (Array.isArray(obj?.rows) ? obj.rows : []) as T[];
}

export { schema };
