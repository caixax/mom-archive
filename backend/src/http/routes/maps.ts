// /api/maps: list with filters, detail with history, leaderboard (current or as of a date), diff.
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { GamemodeName, LeaderboardTypeName, MapStatusName } from '../../momentum/enums.js';
import { diffBoards } from '../../poller/diff.js';
import {
  AnyObject,
  GamemodeQuery,
  IdParam,
  IsoDate,
  offsetOf,
  PageQuery,
  paged,
  SearchText,
  StyleQuery,
  TakeQuery,
  toIso,
  TrackNumQuery,
  TrackTypeQuery,
} from '../common.js';
import type { HttpDeps } from '../deps.js';
import { execRows } from '../../db/index.js';

type MapRow = Record<string, unknown>;

function mapSummary(m: MapRow) {
  const status = Number(m.status);
  return {
    id: m.id,
    name: m.name,
    status,
    statusName: MapStatusName[status] ?? String(status),
    bucket: status === 0 ? 'released' : status === 3 || status === 4 ? 'beta' : 'other',
    submitterId: m.submitter_id,
    submitterAlias: m.submitter_alias ?? null,
    currentVersionId: m.current_version_id,
    thumbnailId: m.thumbnail_id,
    thumbnailUrl: m.thumbnail_id ? `/api/maps/images/${m.thumbnail_id}` : null,
    imageIds: m.image_ids ?? [],
    nativeGamemodes: (m.native_gamemodes as number[] | null) ?? [],
    nativeGamemodeNames: ((m.native_gamemodes as number[] | null) ?? []).map(
      (g) => GamemodeName[g] ?? String(g),
    ),
    archived: m.archived,
    momentumCreatedAt: toIso(m.momentum_created_at as Date | null),
    momentumUpdatedAt: toIso(m.momentum_updated_at as Date | null),
    firstSeenAt: toIso(m.first_seen_at as Date),
    lastSeenAt: toIso(m.last_seen_at as Date),
    lastRefreshedAt: toIso(m.last_refreshed_at as Date | null),
    notFoundAt: toIso(m.not_found_at as Date | null),
    leaderboardTypes: m.leaderboard_types ?? null,
  };
}

function entryRow(e: Record<string, unknown>) {
  return {
    userId: e.user_id,
    time: e.time,
    rank: e.rank === null || e.rank === undefined ? null : Number(e.rank),
    replayHash: e.replay_hash,
    replayArchived: Boolean(e.replay_archived),
    pastRunId: e.past_run_id === null || e.past_run_id === undefined ? null : Number(e.past_run_id),
    momentumCreatedAt: toIso(e.momentum_created_at as Date | null),
    firstSeenAt: toIso(e.first_seen_at as Date | null),
    lastSeenAt: toIso(e.last_seen_at as Date | null),
    removedAt: toIso(e.removed_at as Date | null),
    observedAlias: e.observed_alias,
    observedAvatarHash: e.observed_avatar_hash,
    currentAlias: e.current_alias,
    currentAvatarHash: e.current_avatar_hash,
    steamId: e.steam_id,
  };
}

export async function registerMapRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/maps',
    {
      schema: {
        tags: ['maps'],
        summary: 'List maps with filters',
        querystring: Type.Object({
          q: Type.Optional(SearchText),
          gamemode: Type.Optional(GamemodeQuery),
          bucket: Type.Optional(
            Type.Union([Type.Literal('released'), Type.Literal('beta'), Type.Literal('other')]),
          ),
          lbType: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
          native: Type.Optional(GamemodeQuery),
          archived: Type.Optional(Type.Boolean()),
          sort: Type.Optional(
            Type.Union([Type.Literal('name'), Type.Literal('recent'), Type.Literal('id')]),
          ),
          page: PageQuery,
          take: TakeQuery,
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { q, gamemode, bucket, lbType, native, archived, sort, page, take } = req.query;
      const gm = gamemode ?? deps.cfg.ARCHIVE_GAMEMODES[0]!;
      const bucketCond =
        bucket === 'released'
          ? sql`m.status = 0`
          : bucket === 'beta'
            ? sql`m.status in (3,4)`
            : bucket === 'other'
              ? sql`m.status not in (0,3,4)`
              : sql`true`;
      const order =
        sort === 'name'
          ? sql`lower(m.name) asc`
          : sort === 'id'
            ? sql`m.id desc`
            : sql`m.last_seen_at desc, m.id desc`;
      const rows = (await execRows(
        db,
        sql`
        select m.*, u.alias as submitter_alias,
          (select json_agg(distinct l.type) from leaderboards l where l.map_id = m.id and l.gamemode = ${gm} and l.removed_at is null) as leaderboard_types,
          count(*) over() as total
        from maps m left join users u on u.id = m.submitter_id
        where (${q ?? null}::text is null or m.name ilike '%' || ${q ?? ''} || '%')
          and ${bucketCond}
          and (${archived ?? null}::boolean is null or m.archived = ${archived ?? null})
          and (${native ?? null}::int is null or m.native_gamemodes @> to_jsonb(array[${native ?? 0}]::int[]))
          and (${lbType ?? null}::int is null or exists (select 1 from leaderboards l where l.map_id = m.id and l.gamemode = ${gm} and l.type = ${lbType ?? null} and l.removed_at is null))
        order by ${order} limit ${take} offset ${offsetOf(page, take)}
      `,
      )) as unknown as MapRow[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(total, page, take, rows.map(mapSummary));
    },
  );

  api.get(
    '/maps/images/:id',
    {
      schema: {
        tags: ['maps'],
        summary: 'Archived large map image',
        params: Type.Object({ id: Type.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      },
    },
    async (req, reply) => {
      const rows = (await execRows(
        db,
        sql`select s3_key from map_images where id = ${req.params.id}`,
      )) as unknown as { s3_key: string | null }[];
      const key = rows[0]?.s3_key;
      if (!key) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const obj = await deps.storage.getStream(key);
      if (!obj) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      reply.header('cache-control', 'public, max-age=86400, immutable');
      reply.header('content-type', 'image/jpeg');
      if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
      return reply.send(obj.body);
    },
  );

  api.get(
    '/maps/:idOrName',
    {
      schema: {
        tags: ['maps'],
        summary: 'Map detail with leaderboards, versions, images, credits and change history',
        params: Type.Object({
          idOrName: Type.String({ minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_.-]+$' }),
        }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const p = req.params.idOrName;
      const byId = /^\d{1,9}$/.test(p);
      const rows = (await execRows(
        db,
        sql`
        select m.*, u.alias as submitter_alias from maps m left join users u on u.id = m.submitter_id
        where ${byId ? sql`m.id = ${Number(p)}` : sql`lower(m.name) = lower(${p})`} limit 1
      `,
      )) as unknown as MapRow[];
      const m = rows[0];
      if (!m) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const id = Number(m.id);
      const lbs = (await execRows(
        db,
        sql`
        select l.*, (select count(*)::int from leaderboard_entries e where e.map_id = l.map_id and e.gamemode = l.gamemode and e.track_type = l.track_type and e.track_num = l.track_num and e.style = l.style and e.removed_at is null) as current_entries
        from leaderboards l where l.map_id = ${id} order by l.gamemode, l.track_type, l.track_num, l.style
      `,
      )) as unknown as Record<string, unknown>[];
      const versions = (await execRows(
        db,
        sql`
        select v.*, u.alias as submitter_alias from map_versions v left join users u on u.id = v.submitter_id where v.map_id = ${id} order by v.version_num
      `,
      )) as unknown as Record<string, unknown>[];
      const images = (await execRows(
        db,
        sql`select id, s3_key is not null as archived, first_seen_at, removed_at from map_images where map_id = ${id} order by first_seen_at`,
      )) as unknown as Record<string, unknown>[];
      const credits = (await execRows(
        db,
        sql`
        select c.user_id, u.alias, c.type, c.description, c.removed_at from map_credits c left join users u on u.id = c.user_id where c.map_id = ${id} order by c.type, u.alias
      `,
      )) as unknown as Record<string, unknown>[];
      const history = (await execRows(
        db,
        sql`select field, old_value, new_value, observed_at from map_field_changes where map_id = ${id} order by observed_at desc limit 300`,
      )) as unknown as Record<string, unknown>[];
      const [counts] = (await execRows(
        db,
        sql`
        select (select count(*)::int from runs where map_id = ${id}) as runs,
               (select count(*)::int from runs where map_id = ${id} and removed_at is not null) as removed_runs,
               (select count(*)::int from replays where map_id = ${id}) as replays
      `,
      )) as unknown as Record<string, number>[];
      return {
        ...mapSummary(m),
        description: m.description,
        youtubeId: m.youtube_id,
        creationDate: toIso(m.creation_date as Date | null),
        approvedDate: toIso(m.approved_date as Date | null),
        requiredGames: m.required_games ?? [],
        stats: {
          reviews: m.stats_reviews,
          subscriptions: m.stats_subscriptions,
          plays: m.stats_plays,
          favorites: m.stats_favorites,
          completions: m.stats_completions,
          uniqueCompletions: m.stats_unique_completions,
          timePlayed: m.stats_time_played,
        },
        links: { momentum: `https://momentum-mod.org/maps/${m.name}` },
        counts,
        leaderboards: lbs.map((l) => ({
          gamemode: l.gamemode,
          gamemodeName: GamemodeName[Number(l.gamemode)] ?? String(l.gamemode),
          trackType: l.track_type,
          trackNum: l.track_num,
          style: l.style,
          tier: l.tier,
          tags: l.tags ?? [],
          type: l.type,
          typeName:
            l.type === null ? null : (LeaderboardTypeName[Number(l.type)] ?? String(l.type)),
          linear: l.linear,
          entryCount: l.entry_count,
          currentEntries: l.current_entries,
          lastRefreshedAt: toIso(l.last_refreshed_at as Date | null),
          removedAt: toIso(l.removed_at as Date | null),
        })),
        versions: versions.map((v) => ({
          id: v.id,
          versionNum: v.version_num,
          changelog: v.changelog,
          bspHash: v.bsp_hash,
          zoneHash: v.zone_hash,
          downloadUrl: v.download_url,
          submitterId: v.submitter_id,
          submitterAlias: v.submitter_alias,
          momentumCreatedAt: toIso(v.momentum_created_at as Date | null),
          firstSeenAt: toIso(v.first_seen_at as Date),
          bspArchived: Boolean(v.bsp_s3_key),
        })),
        images: images.map((i) => ({
          id: i.id,
          archived: i.archived,
          url: i.archived ? `/api/maps/images/${i.id}` : null,
          firstSeenAt: toIso(i.first_seen_at as Date),
          removedAt: toIso(i.removed_at as Date | null),
        })),
        credits: credits.map((c) => ({
          userId: c.user_id,
          alias: c.alias,
          type: c.type,
          description: c.description,
          removedAt: toIso(c.removed_at as Date | null),
        })),
        history: history.map((h) => ({
          field: h.field,
          oldValue: h.old_value,
          newValue: h.new_value,
          observedAt: toIso(h.observed_at as Date),
        })),
      };
    },
  );

  const lbQuery = Type.Object({
    gamemode: Type.Optional(GamemodeQuery),
    trackType: Type.Optional(TrackTypeQuery),
    trackNum: Type.Optional(TrackNumQuery),
    style: Type.Optional(StyleQuery),
    at: Type.Optional(IsoDate),
    includeRemoved: Type.Optional(Type.Boolean({ default: true })),
    page: PageQuery,
    take: TakeQuery,
  });

  api.get(
    '/maps/:id/leaderboard',
    {
      schema: {
        tags: ['maps'],
        summary: 'Leaderboard now, or as it was at a given time (reconstructed from snapshots)',
        params: IdParam,
        querystring: lbQuery,
        response: { 200: AnyObject, 400: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const gm = req.query.gamemode ?? deps.cfg.ARCHIVE_GAMEMODES[0]!;
      const tt = req.query.trackType ?? 0;
      const tn = req.query.trackNum ?? 1;
      const st = req.query.style ?? 0;
      const { page, take } = req.query;
      const off = offsetOf(page, take);
      const includeRemoved = req.query.includeRemoved ?? true;
      if (req.query.at) {
        const at = new Date(req.query.at);
        if (Number.isNaN(at.getTime()))
          return reply.code(400).send({ error: 'bad_request', statusCode: 400 });
        const obs = (await execRows(
          db,
          sql`
          select id, observed_at, last_confirmed_at, entry_count from leaderboard_observations
          where map_id = ${id} and gamemode = ${gm} and track_type = ${tt} and track_num = ${tn} and style = ${st} and observed_at <= ${at.toISOString()}::timestamptz
          order by observed_at desc limit 1
        `,
        )) as unknown as {
          id: number;
          observed_at: Date;
          last_confirmed_at: Date;
          entry_count: number;
        }[];
        const o = obs[0];
        if (!o) {
          return {
            mapId: id,
            gamemode: gm,
            trackType: tt,
            trackNum: tn,
            style: st,
            at: at.toISOString(),
            observation: null,
            total: 0,
            page,
            take,
            data: [],
            note: 'No observation of this leaderboard at or before that time.',
          };
        }
        const rows = (await execRows(
          db,
          sql`
          select s.user_id, s.time, s.rank, s.replay_hash, s.past_run_id, s.momentum_created_at, s.observed_alias, s.observed_avatar_hash,
                 u.alias as current_alias, u.avatar_hash as current_avatar_hash, u.steam_id,
                 e.removed_at, e.first_seen_at, e.last_seen_at,
                 (select 1 from replays r where r.sha1 = s.replay_hash) is not null as replay_archived,
                 count(*) over() as total
          from leaderboard_snapshots s
          left join users u on u.id = s.user_id
          left join leaderboard_entries e on e.map_id = s.map_id and e.gamemode = s.gamemode and e.track_type = s.track_type and e.track_num = s.track_num and e.style = s.style and e.user_id = s.user_id
          where s.observation_id = ${o.id}
          order by s.rank asc nulls last, s.time asc limit ${take} offset ${off}
        `,
        )) as unknown as Record<string, unknown>[];
        const total = rows[0]?.total ? Number(rows[0].total) : 0;
        return {
          mapId: id,
          gamemode: gm,
          trackType: tt,
          trackNum: tn,
          style: st,
          at: at.toISOString(),
          observation: {
            id: Number(o.id),
            observedAt: toIso(o.observed_at),
            validUntil: toIso(o.last_confirmed_at),
            entryCount: o.entry_count,
          },
          total,
          page,
          take,
          data: rows.map(entryRow),
        };
      }
      const rows = (await execRows(
        db,
        sql`
        select e.*, u.alias as current_alias, u.avatar_hash as current_avatar_hash, u.steam_id,
               (select 1 from replays r where r.sha1 = e.replay_hash) is not null as replay_archived,
               count(*) over() as total
        from leaderboard_entries e left join users u on u.id = e.user_id
        where e.map_id = ${id} and e.gamemode = ${gm} and e.track_type = ${tt} and e.track_num = ${tn} and e.style = ${st}
          and (${includeRemoved} or e.removed_at is null)
        order by (e.removed_at is not null), e.rank asc nulls last, e.time asc limit ${take} offset ${off}
      `,
      )) as unknown as Record<string, unknown>[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      const lb = (await execRows(
        db,
        sql`
        select last_refreshed_at, entry_count, tier, type, tags from leaderboards where map_id = ${id} and gamemode = ${gm} and track_type = ${tt} and track_num = ${tn} and style = ${st}
      `,
      )) as unknown as Record<string, unknown>[];
      return {
        mapId: id,
        gamemode: gm,
        trackType: tt,
        trackNum: tn,
        style: st,
        at: null,
        leaderboard: lb[0]
          ? {
              lastRefreshedAt: toIso(lb[0].last_refreshed_at as Date | null),
              entryCount: lb[0].entry_count,
              tier: lb[0].tier,
              type: lb[0].type,
              tags: lb[0].tags,
            }
          : null,
        total,
        page,
        take,
        data: rows.map(entryRow),
      };
    },
  );

  api.get(
    '/maps/:id/leaderboard/observations',
    {
      schema: {
        tags: ['maps'],
        summary: 'Distinct observations (points in time) available for a leaderboard',
        params: IdParam,
        querystring: Type.Object({
          gamemode: Type.Optional(GamemodeQuery),
          trackType: Type.Optional(TrackTypeQuery),
          trackNum: Type.Optional(TrackNumQuery),
          style: Type.Optional(StyleQuery),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const id = req.params.id;
      const gm = req.query.gamemode ?? deps.cfg.ARCHIVE_GAMEMODES[0]!;
      const rows = (await execRows(
        db,
        sql`
        select id, observed_at, last_confirmed_at, entry_count from leaderboard_observations
        where map_id = ${id} and gamemode = ${gm} and track_type = ${req.query.trackType ?? 0} and track_num = ${req.query.trackNum ?? 1} and style = ${req.query.style ?? 0}
        order by observed_at desc limit 500
      `,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((o) => ({
          id: Number(o.id),
          observedAt: toIso(o.observed_at as Date),
          validUntil: toIso(o.last_confirmed_at as Date),
          entryCount: o.entry_count,
        })),
      };
    },
  );

  api.get(
    '/maps/:id/leaderboard/diff',
    {
      schema: {
        tags: ['maps'],
        summary: 'Entries added, removed and improved between two times',
        params: IdParam,
        querystring: Type.Object({
          gamemode: Type.Optional(GamemodeQuery),
          trackType: Type.Optional(TrackTypeQuery),
          trackNum: Type.Optional(TrackNumQuery),
          style: Type.Optional(StyleQuery),
          from: IsoDate,
          to: Type.Optional(IsoDate),
        }),
        response: { 200: AnyObject, 400: AnyObject },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const gm = req.query.gamemode ?? deps.cfg.ARCHIVE_GAMEMODES[0]!;
      const tt = req.query.trackType ?? 0;
      const tn = req.query.trackNum ?? 1;
      const st = req.query.style ?? 0;
      const from = new Date(req.query.from);
      const to = req.query.to ? new Date(req.query.to) : new Date();
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        return reply
          .code(400)
          .send({ error: 'bad_request', statusCode: 400, message: 'from must be before to' });
      }
      const load = async (at: Date) => {
        const obs = (await execRows(
          db,
          sql`
          select id, observed_at from leaderboard_observations
          where map_id = ${id} and gamemode = ${gm} and track_type = ${tt} and track_num = ${tn} and style = ${st} and observed_at <= ${at.toISOString()}::timestamptz
          order by observed_at desc limit 1
        `,
        )) as unknown as { id: number; observed_at: Date }[];
        const o = obs[0];
        if (!o) return { observation: null, entries: [] as Record<string, unknown>[] };
        const entries = (await execRows(
          db,
          sql`
          select s.user_id, s.time, s.rank, s.replay_hash, s.past_run_id, s.observed_alias, s.observed_avatar_hash, s.momentum_created_at, u.alias as current_alias
          from leaderboard_snapshots s left join users u on u.id = s.user_id where s.observation_id = ${o.id}
        `,
        )) as unknown as Record<string, unknown>[];
        return { observation: { id: Number(o.id), observedAt: toIso(o.observed_at) }, entries };
      };
      const a = await load(from);
      const b = await load(to);
      const norm = (e: Record<string, unknown>) => ({
        userId: Number(e.user_id),
        time: Number(e.time),
        rank: e.rank === null ? null : Number(e.rank),
        replayHash: (e.replay_hash as string | null) ?? null,
        pastRunId: e.past_run_id === null ? null : Number(e.past_run_id),
        observedAlias: e.observed_alias,
        currentAlias: e.current_alias,
        momentumCreatedAt: toIso(e.momentum_created_at as Date | null),
      });
      const d = diffBoards(a.entries.map(norm), b.entries.map(norm));
      return {
        mapId: id,
        gamemode: gm,
        trackType: tt,
        trackNum: tn,
        style: st,
        from: { at: from.toISOString(), observation: a.observation, entries: a.entries.length },
        to: { at: to.toISOString(), observation: b.observation, entries: b.entries.length },
        added: d.added,
        removed: d.removed,
        improved: d.improved,
        unchanged: d.unchanged,
      };
    },
  );
}
