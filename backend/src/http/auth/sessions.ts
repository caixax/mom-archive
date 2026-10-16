// Admin sessions. The browser holds a random 256 bit token; the database holds
// only its HMAC, so a dump of the table cannot be replayed as a login. Tokens
// are compared in constant time, and every session has both an idle and an
// absolute deadline.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { adminSessions } from '../../db/schema.js';

export const SESSION_COOKIE = 'ma_session';
/** Set on the state cookie of a login in flight. */
export const STATE_COOKIE = 'ma_login';

export interface SessionRecord {
  id: string;
  steamId: string;
  expiresAt: Date;
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Cookie name with the __Host- prefix in production, where it is enforceable. */
export function cookieName(base: string, dev: boolean): string {
  return dev ? base : `__Host-${base}`;
}

export function cookieOptions(dev: boolean, maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    secure: !dev,
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds,
  };
}

/** A token for the browser plus the hash to store. */
export function newToken(secret: string): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hmac(secret, token) };
}

export function newStateToken(): string {
  return randomBytes(16).toString('base64url');
}

/** CSRF token bound to the session. Derived, so nothing extra has to be stored. */
export function csrfToken(secret: string, sessionId: string): string {
  return hmac(secret, `csrf:${sessionId}`);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface CreateSessionInput {
  db: Db;
  secret: string;
  steamId: string;
  ttlHours: number;
  ip: string | null;
  userAgent: string | null;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const { token, hash } = newToken(input.secret);
  const id = randomBytes(16).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlHours * 3600_000);
  await input.db.insert(adminSessions).values({
    id,
    tokenHash: hash,
    steamId: input.steamId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
  });
  return { token, id, expiresAt };
}

export interface LookupInput {
  db: Db;
  secret: string;
  token: string;
  idleHours: number;
  /** SteamIDs still allowed in. A session for anyone else is treated as dead. */
  admins: readonly string[];
}

/**
 * Resolves a cookie token to a live session, refreshing its idle clock.
 * Returns null for anything expired, revoked, unknown or no longer an admin.
 */
export async function lookupSession(input: LookupInput): Promise<SessionRecord | null> {
  if (!input.token || input.token.length > 100) return null;
  const hash = hmac(input.secret, input.token);
  const rows = await input.db
    .select({
      id: adminSessions.id,
      steamId: adminSessions.steamId,
      expiresAt: adminSessions.expiresAt,
      lastSeenAt: adminSessions.lastSeenAt,
      tokenHash: adminSessions.tokenHash,
    })
    .from(adminSessions)
    .where(and(eq(adminSessions.tokenHash, hash), isNull(adminSessions.revokedAt)))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  // The lookup was by hash already; this is belt and braces against a bad index hit.
  if (!safeEqual(s.tokenHash, hash)) return null;
  const now = Date.now();
  if (s.expiresAt.getTime() <= now) return null;
  if (now - s.lastSeenAt.getTime() > input.idleHours * 3600_000) return null;
  if (!input.admins.includes(s.steamId)) return null;
  // Only touch the row when the clock moved enough to matter.
  if (now - s.lastSeenAt.getTime() > 60_000) {
    await input.db
      .update(adminSessions)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(adminSessions.id, s.id));
  }
  return { id: s.id, steamId: s.steamId, expiresAt: s.expiresAt };
}

export async function revokeSession(db: Db, id: string): Promise<void> {
  await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)));
}

export async function revokeAllSessions(db: Db, steamId: string): Promise<number> {
  const rows = await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminSessions.steamId, steamId), isNull(adminSessions.revokedAt)))
    .returning({ id: adminSessions.id });
  return rows.length;
}

/** Drops sessions that are long dead, so the table does not grow forever. */
export async function pruneSessions(db: Db): Promise<void> {
  await db.delete(adminSessions).where(sql`expires_at < now() - interval '30 days'`);
}
