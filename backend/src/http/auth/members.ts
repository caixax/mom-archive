// Player sign in, for reports. Kept apart from the owner's sessions in every way:
// another table, another cookie, another CSRF derivation, and nothing here can
// ever answer the admin guard.
//
// What is stored about a signed in player is a pseudonym, not an identity:
//   member_key  HMAC(APP_SECRET, "member:" + SteamID64). Stable, so the owner can
//               see that two reports came from the same person and block them,
//               but it does not say who that is.
//   steam_id_enc  The SteamID, AES-256-GCM encrypted, in the session row only, so
//               eligibility can be checked and a report the player chooses to sign
//               can carry it. Sessions expire and are pruned.
// No IP and no user agent are stored, and /api/member/ is left out of the request
// log. This keeps reporters unknown to the panel and to a copy of the database;
// it does not make them unknowable to someone who holds APP_SECRET and goes
// looking, and the About page says so.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { members, memberSessions } from '../../db/schema.js';
import { cookieName, newToken, safeEqual } from './sessions.js';

export const MEMBER_COOKIE = 'ma_member';
export const MEMBER_STATE_COOKIE = 'ma_mlogin';
const TTL_HOURS = 24 * 30;
const IDLE_HOURS = 24 * 7;

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function memberKey(secret: string, steamId: string): string {
  return hmac(secret, `member:${steamId}`);
}

/** The short code the panel shows for a reporter. */
export function memberCode(key: string): string {
  return key.slice(0, 6).toUpperCase();
}

function encKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('member-steamid-key').digest();
}

export function sealSteamId(secret: string, steamId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(secret), iv);
  const body = Buffer.concat([c.update(steamId, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function openSteamId(secret: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const d = createDecipheriv('aes-256-gcm', encKey(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    return /^7656119\d{10}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export interface MemberSession {
  id: string;
  memberKey: string;
  steamId: string;
  expiresAt: Date;
  blocked: boolean;
}

export async function createMemberSession(
  db: Db,
  secret: string,
  steamId: string,
): Promise<{ token: string; id: string; expiresAt: Date; memberKey: string }> {
  const key = memberKey(secret, steamId);
  const { token, hash } = newToken(secret);
  const id = randomBytes(16).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_HOURS * 3600_000);
  await db
    .insert(members)
    .values({ memberKey: key, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: members.memberKey, set: { lastSeenAt: now } });
  await db.insert(memberSessions).values({
    id,
    tokenHash: hash,
    memberKey: key,
    steamIdEnc: sealSteamId(secret, steamId),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  return { token, id, expiresAt, memberKey: key };
}

export function memberCsrf(secret: string, sessionId: string): string {
  return hmac(secret, `member-csrf:${sessionId}`);
}

export interface MemberGuard {
  enabled: boolean;
  cookie: string;
  session(req: FastifyRequest): Promise<MemberSession | null>;
  require(req: FastifyRequest, reply: FastifyReply): Promise<MemberSession | null>;
  requireWrite(req: FastifyRequest, reply: FastifyReply): Promise<MemberSession | null>;
  csrfFor(s: MemberSession): string;
  revoke(id: string): Promise<void>;
}

export function createMemberGuard(cfg: Config, db: Db | null): MemberGuard {
  const enabled = cfg.reportsEnabled && db !== null;
  const secret = cfg.APP_SECRET ?? '';
  const cookie = cookieName(MEMBER_COOKIE, cfg.isDev);

  const session = async (req: FastifyRequest): Promise<MemberSession | null> => {
    if (!enabled) return null;
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[cookie];
    if (!token || token.length > 100) return null;
    const hash = hmac(secret, token);
    const [s] = await db!
      .select({
        id: memberSessions.id,
        tokenHash: memberSessions.tokenHash,
        memberKey: memberSessions.memberKey,
        steamIdEnc: memberSessions.steamIdEnc,
        expiresAt: memberSessions.expiresAt,
        lastSeenAt: memberSessions.lastSeenAt,
        blockedAt: members.blockedAt,
      })
      .from(memberSessions)
      .leftJoin(members, eq(members.memberKey, memberSessions.memberKey))
      .where(and(eq(memberSessions.tokenHash, hash), isNull(memberSessions.revokedAt)))
      .limit(1);
    if (!s || !safeEqual(s.tokenHash, hash)) return null;
    const now = Date.now();
    if (s.expiresAt.getTime() <= now) return null;
    if (now - s.lastSeenAt.getTime() > IDLE_HOURS * 3600_000) return null;
    const steamId = openSteamId(secret, s.steamIdEnc);
    if (!steamId || memberKey(secret, steamId) !== s.memberKey) return null;
    if (now - s.lastSeenAt.getTime() > 60_000) {
      await db!
        .update(memberSessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(memberSessions.id, s.id));
    }
    return {
      id: s.id,
      memberKey: s.memberKey,
      steamId,
      expiresAt: s.expiresAt,
      blocked: s.blockedAt !== null,
    };
  };

  const require = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!enabled) {
      await reply.code(404).send({ error: 'not_found', statusCode: 404 });
      return null;
    }
    const s = await session(req);
    if (!s) {
      await reply.code(401).send({ error: 'unauthorized', statusCode: 401 });
      return null;
    }
    return s;
  };

  const requireWrite = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await require(req, reply);
    if (!s) return null;
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== cfg.PUBLIC_BASE_URL) {
      if (!(cfg.isDev && typeof origin === 'string' && origin.startsWith('http://localhost'))) {
        await reply.code(403).send({ error: 'bad_origin', statusCode: 403 });
        return null;
      }
    }
    const given = req.headers['x-csrf-token'];
    if (typeof given !== 'string' || !safeEqual(given, memberCsrf(secret, s.id))) {
      await reply.code(403).send({ error: 'bad_csrf_token', statusCode: 403 });
      return null;
    }
    return s;
  };

  return {
    enabled,
    cookie,
    session,
    require,
    requireWrite,
    csrfFor: (s) => memberCsrf(secret, s.id),
    revoke: async (id) => {
      await db!
        .update(memberSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(memberSessions.id, id), isNull(memberSessions.revokedAt)));
    },
  };
}

/** Drops member sessions long past their expiry. */
export async function pruneMemberSessions(db: Db): Promise<number> {
  const rows = await db
    .delete(memberSessions)
    .where(sql`${memberSessions.expiresAt} < now() - interval '1 day'`)
    .returning({ id: memberSessions.id });
  return rows.length;
}
