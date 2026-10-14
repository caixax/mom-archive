// /api/runs: single run, feed (including the deleted runs feed).
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  AnyObject,
  BigIdParam,
  GamemodeQuery,
  offsetOf,
  PageQuery,
  paged,
  StyleQuery,
  TakeQuery,
  toIso,
} from '../common.js';
import type { HttpDeps } from '../deps.js';
import { runRow } from './users.js';
import { execRows } from '../../db/index.js';

export async function registerRunRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/runs',
    {
      schema: {
        tags: ['runs'],
        summary:
          'Run feed. removed=true gives runs whose leaderboard entry or run was deleted upstream.',
        querystring: Type.Object({
          gamemode: Type.Optional(GamemodeQuery),
          style: Type.Optional(StyleQuery),
          mapId: Type.Optional(Type.Integer({ minimum: 1 })),
          userId: Type.Optional(Type.Integer({ minimum: 1 })),
          removed: Type.Optional(Type.Boolean()),
          pbOnly: Type.Optional(Type.Boolean()),
          page: PageQuery,
          take: TakeQuery,
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { gamemode, style, mapId, userId, removed, pbOnly, page, take } = req.query;
      const order = removed ? sql`r.removed_at desc` : sql`r.momentum_created_at desc`;
      const rows = (await execRows(
        db,
        sql`
        select r.id, r.user_id, u.alias as user_alias, r.map_id, m.name as map_name, r.gamemode, r.track_type, r.track_num, r.style, r.time, r.flags, r.is_pb,
               r.replay_hash, r.momentum_created_at, r.first_seen_at, r.removed_at, r.removal_kind,
               r.observed_alias, r.observed_avatar_hash, r.observed_steam_name,
               (select rank from leaderboard_entries e where e.past_run_id = r.id limit 1) as rank,
               (select 1 from replays p where p.sha1 = r.replay_hash) is not null as replay_archived,
               count(*) over() as total
        from runs r join maps m on m.id = r.map_id left join users u on u.id = r.user_id
        where (${gamemode ?? null}::int is null or r.gamemode = ${gamemode ?? null})
          and (${style ?? null}::int is null or r.style = ${style ?? null})
          and (${mapId ?? null}::int is null or r.map_id = ${mapId ?? null})
          and (${userId ?? null}::int is null or r.user_id = ${userId ?? null})
          and (${removed ?? null}::boolean is null or (r.removed_at is not null) = ${removed ?? null})
          and (${pbOnly ?? null}::boolean is null or r.is_pb = ${pbOnly ?? null})
        order by ${order} limit ${take} offset ${offsetOf(page, take)}
      `,
      )) as unknown as Record<string, unknown>[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(total, page, take, rows.map(runRow));
    },
  );

  api.get(
    '/runs/:id',
    {
      schema: {
        tags: ['runs'],
        summary: 'Run detail with replay metadata',
        params: BigIdParam,
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const rows = (await execRows(
        db,
        sql`
        select r.*, u.alias as user_alias, u.avatar_hash as user_avatar_hash, u.steam_id, m.name as map_name, m.status as map_status,
               (select rank from leaderboard_entries e where e.past_run_id = r.id limit 1) as rank,
               (select removed_at from leaderboard_entries e where e.past_run_id = r.id limit 1) as entry_removed_at,
               (select 1 from replays p where p.sha1 = r.replay_hash) is not null as replay_archived
        from runs r join maps m on m.id = r.map_id left join users u on u.id = r.user_id where r.id = ${req.params.id}
      `,
      )) as unknown as Record<string, unknown>[];
      const r = rows[0];
      if (!r) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const replay = r.replay_hash
        ? (
            (await execRows(
              db,
              sql`
            select sha1, bytes, downloaded_at, header, header_ok, header_issues, header_player_name, observed_alias, observed_steam_name
            from replays where sha1 = ${r.replay_hash as string}
          `,
            )) as unknown as Record<string, unknown>[]
          )[0]
        : undefined;
      const failure =
        r.replay_hash && !replay
          ? (
              (await execRows(
                db,
                sql`select attempts, last_status, last_error, gave_up, last_failed_at from replay_fetch_failures where sha1 = ${r.replay_hash as string}`,
              )) as unknown as Record<string, unknown>[]
            )[0]
          : undefined;
      const raw = (r.raw as Record<string, unknown> | null) ?? {};
      return {
        ...runRow(r),
        userAvatarHash: r.user_avatar_hash,
        steamId: r.steam_id,
        mapStatus: r.map_status,
        entryRemovedAt: toIso(r.entry_removed_at as Date | null),
        lastSeenAt: toIso(r.last_seen_at as Date),
        splits: (raw.leaderboardRun as Record<string, unknown> | undefined)?.splits ?? null,
        replay: replay
          ? {
              sha1: replay.sha1,
              bytes: replay.bytes,
              downloadedAt: toIso(replay.downloaded_at as Date),
              header: replay.header,
              headerOk: replay.header_ok,
              headerIssues: replay.header_issues ?? [],
              headerPlayerName: replay.header_player_name,
              downloadUrl: `/api/replays/${replay.sha1}/download`,
            }
          : null,
        replayFailure: failure
          ? {
              attempts: failure.attempts,
              lastStatus: failure.last_status,
              lastError: failure.last_error,
              gaveUp: failure.gave_up,
              lastFailedAt: toIso(failure.last_failed_at as Date),
            }
          : null,
        links: {
          momentumMap: `https://momentum-mod.org/maps/${r.map_name}`,
          momentumUser: `https://momentum-mod.org/profile/${r.user_id}`,
        },
      };
    },
  );
}
