// Environment parsing. Fails fast with a readable message when something is missing.
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? 'false').trim().toLowerCase() === 'true');

const intList = z
  .string()
  .default('3')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10)),
  )
  .pipe(z.array(z.number().int().min(1).max(13)).min(1));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_DIR: z.string().default('logs'),

  DATABASE_URL_RW: z.string().url().startsWith('postgres'),
  DATABASE_URL_RO: z.string().url().startsWith('postgres'),
  /**
   * Role the HTTP side writes with. It may only touch the admin tables (sessions,
   * announcements, user notices, audit, request log), never the archive itself.
   * Falls back to the read-only URL, which disables everything that writes.
   */
  DATABASE_URL_APP: z.string().url().startsWith('postgres').optional(),

  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),

  MOMENTUM_API: z.string().url().default('https://api.momentum-mod.org/v1'),
  MOMENTUM_CDN: z.string().url().default('https://cdn.momentum-mod.org'),
  MOMENTUM_TOKEN: z.string().optional().default(''),
  ARCHIVE_GAMEMODES: intList,
  ARCHIVE_BSPS: bool,

  POLL_RUNS_MINUTES: z.coerce.number().int().min(1).default(10),
  POLL_MAPS_HOURS: z.coerce.number().min(0.1).default(6),
  POLL_USERS_SWEEP_HOURS: z.coerce.number().min(0.1).default(24),
  POLL_LEADERBOARDS_SWEEP_HOURS: z.coerce.number().min(0.1).default(24),
  POLL_MAPS_WALK_HOURS: z.coerce.number().min(0.1).default(24),
  REPLAY_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  POLLER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? 'true').trim().toLowerCase() !== 'false'),

  RATE_LIMIT_RPS: z.coerce.number().min(0.1).max(20).default(15),
  RATE_LIMIT_RPM: z.coerce.number().min(1).max(200).default(180),
  USER_AGENT: z
    .string()
    .min(1)
    .default('mom-archive/1.0 (+https://momarchive.org; contact: westlargo@proton.me)'),

  STEAM_API_KEY: z.string().optional().default(''),
  STEAMHISTORY_API_KEY: z.string().optional().default(''),
  STEAMHISTORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? 'true').trim().toLowerCase() !== 'false'),

  /**
   * Secret for session token hashing and CSRF tokens. Rotating it logs every
   * admin session out, which is the point. 32 characters minimum.
   */
  APP_SECRET: z.string().min(32).optional(),
  /** SteamID64s allowed into /admin. Comma separated. Empty disables the panel. */
  ADMIN_STEAM_IDS: z
    .string()
    .optional()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^7656119\d{10}$/.test(s)),
    ),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
  /** Idle timeout: a session unused for this long is dead even inside its TTL. */
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
  REQUEST_LOG_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? 'true').trim().toLowerCase() !== 'false'),
  REQUEST_LOG_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  PORT: z.coerce.number().int().min(1).max(65535).default(5771),
  BIND_HOST: z.string().default('127.0.0.1'),
  ALLOW_PUBLIC_BIND: bool,
  PUBLIC_BASE_URL: z.string().url().default('https://momarchive.org'),
});

export type Config = z.infer<typeof schema> & {
  isDev: boolean;
  steamEnabled: boolean;
  steamHistoryEnabled: boolean;
  /** True when the admin panel can work: an app role, a secret and at least one admin. */
  adminEnabled: boolean;
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  if (!LOOPBACK.has(c.BIND_HOST) && !c.ALLOW_PUBLIC_BIND) {
    throw new Error(
      `BIND_HOST=${c.BIND_HOST} is not loopback. The backend must sit behind nginx. Set ALLOW_PUBLIC_BIND=true if you really mean it.`,
    );
  }
  const adminEnabled = Boolean(
    c.DATABASE_URL_APP && c.APP_SECRET && c.APP_SECRET.length >= 32 && c.ADMIN_STEAM_IDS.length > 0,
  );
  if (!adminEnabled && (c.APP_SECRET || c.ADMIN_STEAM_IDS.length > 0 || c.DATABASE_URL_APP)) {
    throw new Error(
      'The admin panel needs all three of DATABASE_URL_APP, APP_SECRET (32+ chars) and ADMIN_STEAM_IDS (SteamID64). Leave all three empty to run without it.',
    );
  }
  return {
    ...c,
    isDev: c.NODE_ENV === 'development',
    steamEnabled: c.STEAM_API_KEY.length > 0,
    steamHistoryEnabled: c.STEAMHISTORY_ENABLED && c.STEAMHISTORY_API_KEY.length > 0,
    adminEnabled,
  };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
