// /api/auth: Steam sign in for the owner, and nothing else. There is no public
// account system: a successful Steam login only becomes a session when the
// SteamID is listed in ADMIN_STEAM_IDS. Everyone else is told no and gets
// nothing stored about them.
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import { AnyObject } from '../common.js';
import type { HttpDeps } from '../deps.js';
import { clientIp, userAgent, type Guard } from '../auth/guard.js';
import {
  cookieName,
  cookieOptions,
  createSession,
  newStateToken,
  revokeSession,
  safeEqual,
  SESSION_COOKIE,
  STATE_COOKIE,
} from '../auth/sessions.js';
import { buildLoginUrl, verifyCallback } from '../auth/steam-openid.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  guard: Guard,
): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const cfg = deps.cfg;
  const sessionCookie = cookieName(SESSION_COOKIE, cfg.isDev);
  const stateCookie = cookieName(STATE_COOKIE, cfg.isDev);
  const realm = cfg.PUBLIC_BASE_URL;
  const callbackBase = `${cfg.PUBLIC_BASE_URL}/api/auth/steam/callback`;

  /** Who am I. Used by the admin page to decide whether to show itself. */
  api.get(
    '/auth/me',
    { schema: { tags: ['admin'], summary: 'The current session', response: { 200: AnyObject } } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const s = await guard.session(req);
      if (!s) return { authenticated: false, admin: false };
      return {
        authenticated: true,
        admin: true,
        steamId: s.steamId,
        expiresAt: s.expiresAt.toISOString(),
        csrfToken: guard.csrfFor(s),
      };
    },
  );

  // Not registered at all when there is no panel, so the endpoints do not exist
  // on an instance that has no owner configured.
  if (!guard.enabled) return;

  api.get(
    '/auth/steam/login',
    { schema: { tags: ['admin'], summary: 'Start a Steam sign in', hide: true } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const state = newStateToken();
      // The state travels inside return_to, which Steam signs, and is compared
      // with this cookie on the way back: a login cannot be started elsewhere.
      reply.setCookie(stateCookie, state, cookieOptions(cfg.isDev, 600));
      const returnTo = `${callbackBase}?state=${encodeURIComponent(state)}`;
      return reply.redirect(buildLoginUrl(realm, returnTo), 302);
    },
  );

  api.get(
    '/auth/steam/callback',
    {
      schema: {
        tags: ['admin'],
        summary: 'Steam sign in callback',
        hide: true,
        querystring: Type.Object({ state: Type.String({ minLength: 8, maxLength: 64 }) }),
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const fail = (why: string) => {
        deps.log.warn('steam sign in refused', { reason: why, ip: clientIp(req) });
        reply.clearCookie(stateCookie, { path: '/' });
        return reply.redirect(`/admin?error=${encodeURIComponent(why)}`, 302);
      };
      const cookies = req.cookies as Record<string, string | undefined> | undefined;
      const expectedState = cookies?.[stateCookie];
      const state = req.query.state;
      if (!expectedState || !safeEqual(expectedState, state)) return fail('login expired');

      const params: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
        if (typeof v === 'string') params[k] = v;
      }
      const result = await verifyCallback(params, {
        expectedReturnTo: `${callbackBase}?state=${encodeURIComponent(state)}`,
        logger: deps.log,
      });
      if (!result.ok) return fail(result.retryable ? 'steam unreachable' : 'verification failed');

      // The identity is proven. Being the owner is a separate question, and the
      // answer is only ever what the environment says.
      if (!cfg.ADMIN_STEAM_IDS.includes(result.steamId)) {
        deps.log.warn('steam sign in by a non admin', {
          steamId: result.steamId,
          ip: clientIp(req),
        });
        reply.clearCookie(stateCookie, { path: '/' });
        return reply.redirect('/admin?error=not+an+admin', 302);
      }

      const session = await createSession({
        db: deps.dbApp!,
        secret: cfg.APP_SECRET!,
        steamId: result.steamId,
        ttlHours: cfg.SESSION_TTL_HOURS,
        ip: clientIp(req),
        userAgent: userAgent(req),
      });
      reply.clearCookie(stateCookie, { path: '/' });
      reply.setCookie(
        sessionCookie,
        session.token,
        cookieOptions(cfg.isDev, cfg.SESSION_TTL_HOURS * 3600),
      );
      deps.log.info('admin signed in', { steamId: result.steamId, ip: clientIp(req) });
      await guard.audit(
        { id: session.id, steamId: result.steamId, expiresAt: session.expiresAt },
        req,
        'sign-in',
      );
      return reply.redirect('/admin', 302);
    },
  );

  api.post(
    '/auth/logout',
    { schema: { tags: ['admin'], summary: 'End the current session', hide: true } },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      await revokeSession(deps.dbApp!, s.id);
      await guard.audit(s, req, 'sign-out');
      reply.clearCookie(sessionCookie, { path: '/' });
      return { ok: true };
    },
  );
}
