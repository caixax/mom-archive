// /api/replays/:sha1 metadata and download (streamed from S3 with Range support), /api/avatars/:hash.
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AnyObject, contentDisposition, formatTimeForFile, Sha1Param, toIso } from '../common.js';
import type { HttpDeps } from '../deps.js';
import { execRows } from '../../db/index.js';

const RANGE = /^bytes=\d*-\d*$/;

export async function registerReplayRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/replays/:sha1',
    {
      schema: {
        tags: ['replays'],
        summary: 'Replay metadata',
        params: Sha1Param,
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const rows = (await execRows(
        db,
        sql`
        select r.*, m.name as map_name, u.alias as current_alias from replays r left join maps m on m.id = r.map_id left join users u on u.id = r.user_id where r.sha1 = ${req.params.sha1}
      `,
      )) as unknown as Record<string, unknown>[];
      const r = rows[0];
      if (!r) {
        const f = (
          (await execRows(
            db,
            sql`select * from replay_fetch_failures where sha1 = ${req.params.sha1}`,
          )) as unknown as Record<string, unknown>[]
        )[0];
        if (f) {
          return reply.code(404).send({
            error: 'not_archived',
            statusCode: 404,
            failure: {
              attempts: f.attempts,
              lastStatus: f.last_status,
              lastError: f.last_error,
              gaveUp: f.gave_up,
              lastFailedAt: toIso(f.last_failed_at as Date),
            },
          });
        }
        return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      }
      return {
        sha1: r.sha1,
        bytes: r.bytes,
        downloadedAt: toIso(r.downloaded_at as Date),
        header: r.header,
        headerOk: r.header_ok,
        headerIssues: r.header_issues ?? [],
        headerPlayerName: r.header_player_name,
        pastRunId: r.past_run_id === null ? null : Number(r.past_run_id),
        userId: r.user_id,
        currentAlias: r.current_alias,
        mapId: r.map_id,
        mapName: r.map_name,
        gamemode: r.gamemode,
        trackType: r.track_type,
        trackNum: r.track_num,
        style: r.style,
        runTime: r.run_time,
        observedAlias: r.observed_alias,
        observedAvatarHash: r.observed_avatar_hash,
        observedSteamName: r.observed_steam_name,
        downloadUrl: `/api/replays/${r.sha1}/download`,
      };
    },
  );

  api.get(
    '/replays/:sha1/download',
    {
      schema: {
        tags: ['replays'],
        summary: 'Download the .momtv file. Supports Range requests.',
        params: Sha1Param,
      },
    },
    async (req, reply) => {
      const sha1 = req.params.sha1;
      const rows = (await execRows(
        db,
        sql`
        select r.s3_key, r.bytes, r.run_time, r.observed_alias, m.name as map_name from replays r left join maps m on m.id = r.map_id where r.sha1 = ${sha1}
      `,
      )) as unknown as {
        s3_key: string;
        bytes: number;
        run_time: number | null;
        observed_alias: string | null;
        map_name: string | null;
      }[];
      const r = rows[0];
      if (!r) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const rangeHeader = req.raw.headers.range;
      const range =
        typeof rangeHeader === 'string' && RANGE.test(rangeHeader) ? rangeHeader : undefined;
      let obj;
      try {
        obj = await deps.storage.getStream(r.s3_key, range);
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 416) {
          reply.header('content-range', `bytes */${r.bytes}`);
          return reply.code(416).send();
        }
        throw e;
      }
      if (!obj) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const filename = `${r.map_name ?? 'map'}_${r.observed_alias ?? 'player'}_${formatTimeForFile(r.run_time ?? 0)}.momtv`;
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-disposition', contentDisposition(filename));
      reply.header('x-content-type-options', 'nosniff');
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
      if (obj.contentRange) {
        reply.header('content-range', obj.contentRange);
        reply.code(206);
      }
      if (r.bytes > 100 * 1024 * 1024)
        deps.log.warn('replay above cloudflare limit served', { sha1, bytes: r.bytes });
      return reply.send(obj.body);
    },
  );

  api.get(
    '/avatars/:hash',
    {
      schema: {
        tags: ['users'],
        summary: 'Archived Steam avatar image',
        params: Type.Object({ hash: Type.String({ pattern: '^[0-9a-f]{40}$' }) }),
      },
    },
    async (req, reply) => {
      const rows = (await execRows(
        db,
        sql`select s3_key, content_type from avatars where hash = ${req.params.hash}`,
      )) as unknown as { s3_key: string; content_type: string | null }[];
      const a = rows[0];
      if (!a) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const obj = await deps.storage.getStream(a.s3_key);
      if (!obj) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      reply.header(
        'content-type',
        a.content_type?.startsWith('image/') ? a.content_type : 'image/jpeg',
      );
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
      return reply.send(obj.body);
    },
  );
}
