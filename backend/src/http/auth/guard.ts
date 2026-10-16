// The gate in front of everything under /api/admin. Three independent checks have
// to pass for a write: a live session, an Origin that is this site, and a CSRF
// token derived from that session. Every write is written to the audit table.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/index.js';
import { adminAudit } from '../../db/schema.js';
import type { Config } from '../../config.js';
import type { Logger } from '../../logger.js';
import {
  cookieName,
  csrfToken,
  lookupSession,
  safeEqual,
  SESSION_COOKIE,
  type SessionRecord,
} from './sessions.js';

export interface AuthDeps {
  cfg: Config;
  dbApp: Db | null;
  log: Logger;
}

export interface Guard {
  enabled: boolean;
  /** The session behind this request, or null. Never throws. */
  session(req: FastifyRequest): Promise<SessionRecord | null>;
  /** Session or an answered reply. Returns null when it already answered. */
  requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<SessionRecord | null>;
  /** Same, plus the CSRF and Origin checks a state changing request needs. */
  requireWrite(req: FastifyRequest, reply: FastifyReply): Promise<SessionRecord | null>;
  csrfFor(session: SessionRecord): string;
  audit(
    session: SessionRecord,
    req: FastifyRequest,
    action: string,
    target?: string | number | null,
    details?: Record<string, unknown>,
  ): Promise<void>;
}

/** Client IP as nginx hands it over (CF-Connecting-IP), trimmed to something storable. */
export function clientIp(req: FastifyRequest): string | null {
  const ip = req.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip.slice(0, 64) : null;
}

export function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 400) : null;
}

export function createGuard(deps: AuthDeps): Guard {
  const { cfg, dbApp, log } = deps;
  const enabled = cfg.adminEnabled && dbApp !== null;
  const secret = cfg.APP_SECRET ?? '';
  const cookie = cookieName(SESSION_COOKIE, cfg.isDev);

  const session = async (req: FastifyRequest): Promise<SessionRecord | null> => {
    if (!enabled) return null;
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[cookie];
    if (!token) return null;
    try {
      return await lookupSession({
        db: dbApp!,
        secret,
        token,
        idleHours: cfg.SESSION_IDLE_HOURS,
        admins: cfg.ADMIN_STEAM_IDS,
      });
    } catch (e) {
      log.error('session lookup failed', { error: String((e as Error).name) });
      return null;
    }
  };

  const requireAdmin = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionRecord | null> => {
    reply.header('cache-control', 'no-store');
    // When there is no panel configured there is nothing to find here.
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

  const requireWrite = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionRecord | null> => {
    const s = await requireAdmin(req, reply);
    if (!s) return null;
    // A cross site form or fetch cannot set these two, and SameSite=Lax already
    // keeps the cookie off cross site POSTs.
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== cfg.PUBLIC_BASE_URL) {
      if (!(cfg.isDev && typeof origin === 'string' && origin.startsWith('http://localhost'))) {
        await reply.code(403).send({ error: 'bad_origin', statusCode: 403 });
        return null;
      }
    }
    const given = req.headers['x-csrf-token'];
    if (typeof given !== 'string' || !safeEqual(given, csrfToken(secret, s.id))) {
      await reply.code(403).send({ error: 'bad_csrf_token', statusCode: 403 });
      return null;
    }
    return s;
  };

  const audit: Guard['audit'] = async (s, req, action, target, details) => {
    if (!dbApp) return;
    try {
      await dbApp.insert(adminAudit).values({
        at: new Date(),
        steamId: s.steamId,
        action,
        target: target === null || target === undefined ? null : String(target).slice(0, 200),
        details: details ?? null,
        ip: clientIp(req),
        userAgent: userAgent(req),
      });
    } catch (e) {
      // An action that happened but could not be audited is worth shouting about.
      log.error('audit write failed', { action, error: String((e as Error).message) });
    }
  };

  return {
    enabled,
    session,
    requireAdmin,
    requireWrite,
    csrfFor: (s) => csrfToken(secret, s.id),
    audit,
  };
}
