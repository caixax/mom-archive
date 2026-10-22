// /api/pv/<page path>: the page view beacon. The single page app calls it once per
// navigation so the owner's traffic numbers count pages people opened, not API
// calls. It sets no cookie and stores nothing of its own: the request log row this
// request leaves behind is the whole record, and that log rolls over after
// REQUEST_LOG_DAYS. The query may carry r, the external referrer of a visit.
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HttpDeps } from '../deps.js';

export async function registerPageViewRoutes(app: FastifyInstance, _deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const schema = {
    hide: true,
    querystring: Type.Object({ r: Type.Optional(Type.String({ maxLength: 300 })) }),
  };
  const answer = async (_req: unknown, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    return reply.code(204).send();
  };
  api.get('/pv', { schema }, answer);
  api.get('/pv/*', { schema }, answer);
}
