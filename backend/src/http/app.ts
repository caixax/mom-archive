// Fastify app: read only JSON API under /api with security plugins from the start.
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { errMsg } from '../logger.js';
import type { HttpDeps } from './deps.js';
import { registerMapRoutes } from './routes/maps.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerReplayRoutes } from './routes/replays.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerUserRoutes } from './routes/users.js';

export type App = FastifyInstance;

export async function buildApp(deps: HttpDeps): Promise<App> {
  const app = Fastify({
    logger: false,
    // nginx on loopback forwards the Cloudflare client IP in X-Forwarded-For / X-Real-IP
    trustProxy: '127.0.0.1,::1',
    bodyLimit: 16 * 1024,
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    ignoreTrailingSlash: true,
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        useDefaults: true,
        removeAdditional: false,
        allErrors: false,
        strict: false,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      useDefaults: false,
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: false, // terminated at Cloudflare and nginx
    xPoweredBy: false,
  });

  const origins = [deps.cfg.PUBLIC_BASE_URL];
  if (deps.cfg.isDev) origins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  await app.register(cors, { origin: origins, methods: ['GET', 'HEAD'], maxAge: 600 });

  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    errorResponseBuilder: (_req, ctx) => ({
      error: 'rate_limited',
      message: `Too many requests, retry in ${ctx.after}`,
      statusCode: 429,
    }),
  });

  await app.register(etag, { weak: true });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'mom-archive API',
        version: '1.0.0',
        description:
          'Public, read only archive of Momentum Mod leaderboard data, replays and user history.',
      },
      servers: [{ url: deps.cfg.PUBLIC_BASE_URL }],
    },
    hideUntagged: false,
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply.header('allow', 'GET, HEAD');
      return reply.code(405).send({ error: 'method_not_allowed', statusCode: 405 });
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('cache-control'))
      reply.header('cache-control', 'public, max-age=30, stale-while-revalidate=60');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-request-id', req.id);
    return payload;
  });

  app.setNotFoundHandler((req, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.code(404).send({ error: 'not_found', statusCode: 404, requestId: req.id });
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; validation?: unknown; message?: string; code?: string };
    reply.header('cache-control', 'no-store');
    if (e.validation) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Invalid query or parameters',
        statusCode: 400,
        requestId: req.id,
      });
    }
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    if (status === 500) {
      deps.log.error('request failed', {
        requestId: req.id,
        url: req.url.split('?')[0],
        error: errMsg(err),
      });
    }
    const body: Record<string, unknown> = {
      error: status === 500 ? 'internal_error' : 'request_error',
      statusCode: status,
      requestId: req.id,
    };
    if (status === 429) body.error = 'rate_limited';
    if (status !== 500 && e.message && e.code !== 'FST_ERR_VALIDATION')
      body.message = e.message.slice(0, 200);
    return reply.code(status).send(body);
  });

  await app.register(
    async (api) => {
      api.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
        reply.header('cache-control', 'public, max-age=3600');
        return app.swagger();
      });
      await registerMiscRoutes(api, deps);
      await registerUserRoutes(api, deps);
      await registerMapRoutes(api, deps);
      await registerRunRoutes(api, deps);
      await registerReplayRoutes(api, deps);
      await registerSearchRoutes(api, deps);
    },
    { prefix: '/api' },
  );

  return app;
}
