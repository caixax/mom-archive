// /api/users: search, detail with history, runs, follow events.
import { Type } from '@sinclair/typebox';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { users } from '../../db/schema.js';
import { BanName, flagNames, RoleName, steamAvatarUrl } from '../../momentum/enums.js';
import { steamId64ToSteam2, steamId64ToSteam3 } from '../../momentum/steamid.js';
import {
  AnyObject,
  GamemodeQuery,
  IdParam,
  offsetOf,
  PageQuery,
  paged,
  SearchText,
  StyleQuery,
  TakeQuery,
  toIso,
} from '../common.js';
import type { HttpDeps } from '../deps.js';
import { execRows } from '../../db/index.js';

export function userSummary(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    steamId: u.steamId,
    alias: u.alias,
    country: u.country,
    avatarHash: u.avatarHash,
    avatarUrl: u.avatarHash ? `/api/avatars/${u.avatarHash}` : null,
    roles: u.roles,
    roleNames: flagNames(u.roles, RoleName),
    bans: u.bans,
    banNames: flagNames(u.bans, BanName),
    isDeleted: u.isDeleted,
    momentumCreatedAt: toIso(u.momentumCreatedAt),
    firstSeenAt: toIso(u.firstSeenAt),
    lastSeenAt: toIso(u.lastSeenAt),
    lastRunAt: toIso(u.lastRunAt),
  };
}

export async function registerUserRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'List or search users by current or past alias',
        querystring: Type.Object({
          q: Type.Optional(SearchText),
          page: PageQuery,
          take: TakeQuery,
          sort: Type.Optional(
            Type.Union([Type.Literal('recent'), Type.Literal('alias'), Type.Literal('id')]),
          ),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { q, page, take, sort } = req.query;
      const off = offsetOf(page, take);
      if (q && q.trim().length > 0) {
        const term = q.trim();
        const rows = (await execRows(
          db,
          sql`
          with hits as (
            select entity_id as id, min(case when source = 'alias' then 0 else 1 end) as prio,
                   (array_agg(source order by case when source = 'alias' then 0 else 1 end))[1] as matched_on,
                   (array_agg(text order by case when source = 'alias' then 0 else 1 end))[1] as matched_text
            from search_index
            where kind = 'user' and text ilike '%' || ${term} || '%'
            group by entity_id
          )
          select u.*, h.matched_on, h.matched_text, count(*) over() as total
          from hits h join users u on u.id = h.id
          order by h.prio, (lower(u.alias) = lower(${term})) desc, u.last_run_at desc nulls last
          limit ${take} offset ${off}
        `,
        )) as unknown as (typeof users.$inferSelect & {
          matched_on: string;
          matched_text: string;
          total: number;
        })[];
        const total = rows[0]?.total ? Number(rows[0].total) : 0;
        return paged(
          total,
          page,
          take,
          rows.map((r) => ({
            ...userSummary(rowToUser(r)),
            matchedOn: r.matched_on,
            matchedText: r.matched_text,
          })),
        );
      }
      const order =
        sort === 'alias'
          ? sql`lower(alias) asc nulls last`
          : sort === 'id'
            ? sql`id asc`
            : sql`last_run_at desc nulls last, id desc`;
      const rows = (await execRows(
        db,
        sql`select *, count(*) over() as total from users order by ${order} limit ${take} offset ${off}`,
      )) as unknown as (typeof users.$inferSelect & { total: number })[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(
        total,
        page,
        take,
        rows.map((r) => userSummary(rowToUser(r))),
      );
    },
  );

  api.get(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'User detail: current state, Steam side, history, alias and avatar timelines',
        params: IdParam,
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const [u] = await db.select().from(users).where(eq(users.id, id));
      if (!u) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const steamId = u.steamId;

      const [steam] = steamId
        ? ((await execRows(
            db,
            sql`select * from steam_profiles where steam_id = ${steamId}`,
          )) as unknown as Record<string, unknown>[])
        : [];
      const history = (await execRows(
        db,
        sql`
        select 'momentum' as source, field, old_value, new_value, observed_at from user_field_changes where user_id = ${id}
        union all
        select 'steam', field, old_value, new_value, observed_at from steam_field_changes where steam_id = ${steamId ?? ''}
        order by observed_at desc limit 500
      `,
      )) as unknown as {
        source: string;
        field: string;
        old_value: string | null;
        new_value: string | null;
        observed_at: Date;
      }[];

      const aliases = steamId
        ? ((await execRows(
            db,
            sql`
            select name, source, first_seen, last_seen from steam_name_history where steam_id = ${steamId}
            order by last_seen desc, first_seen desc limit 200
          `,
          )) as unknown as { name: string; source: string; first_seen: Date; last_seen: Date }[])
        : [];

      const avatarsRows = steamId
        ? ((await execRows(
            db,
            sql`
            select h.avatar_hash, h.source, h.first_seen, h.last_seen, a.s3_key is not null as archived
            from steam_avatar_history h left join avatars a on a.hash = h.avatar_hash
            where h.steam_id = ${steamId} order by h.last_seen desc limit 100
          `,
          )) as unknown as {
            avatar_hash: string;
            source: string;
            first_seen: Date;
            last_seen: Date;
            archived: boolean;
          }[])
        : [];

      const [counts] = (await execRows(
        db,
        sql`
        select
          (select count(*)::int from follows where followed_id = ${id} and removed_at is null) as followers,
          (select count(*)::int from follows where follower_id = ${id} and removed_at is null) as following,
          (select count(*)::int from runs where user_id = ${id}) as runs,
          (select count(*)::int from runs where user_id = ${id} and removed_at is not null) as removed_runs,
          (select count(*)::int from replays where user_id = ${id}) as replays,
          (select count(*)::int from leaderboard_entries where user_id = ${id} and removed_at is null) as leaderboard_entries,
          (select count(*)::int from leaderboard_entries where user_id = ${id} and removed_at is null and rank = 1) as world_records
      `,
      )) as unknown as Record<string, number>[];

      const sourcebans = steamId
        ? ((await execRows(
            db,
            sql`
            select server, ban_timestamp, unban_timestamp, current_state, ban_reason, unban_reason, name_at_ban
            from steam_sourcebans where steam_id = ${steamId} order by ban_timestamp desc limit 200
          `,
          )) as unknown as Record<string, unknown>[])
        : [];

      const snapshots = (await execRows(
        db,
        sql`
        select observed_at, data->>'cosXp' as cos_xp, data->>'level' as level, data->>'mapsCompleted' as maps_completed,
               data->>'runsSubmitted' as runs_submitted, data->>'totalJumps' as total_jumps, data->>'totalStrafes' as total_strafes
        from user_snapshots where user_id = ${id} and data->>'profileFetched' = 'true' order by observed_at desc limit 100
      `,
      )) as unknown as Record<string, unknown>[];

      const credits = (await execRows(
        db,
        sql`
        select c.map_id, m.name as map_name, c.type, c.description from map_credits c join maps m on m.id = c.map_id
        where c.user_id = ${id} and c.removed_at is null order by c.type, m.name
      `,
      )) as unknown as Record<string, unknown>[];

      return {
        ...userSummary(u),
        steamId3: steamId ? steamId64ToSteam3(steamId) : null,
        steamId2: steamId ? steamId64ToSteam2(steamId) : null,
        bio: u.bio,
        socials: u.socials ?? {},
        stats: {
          cosXp: u.cosXp,
          level: u.level,
          mapsCompleted: u.mapsCompleted,
          runsSubmitted: u.runsSubmitted,
          totalJumps: u.totalJumps,
          totalStrafes: u.totalStrafes,
        },
        profileFetched: u.profileFetched,
        lastRefreshedAt: toIso(u.lastRefreshedAt),
        links: {
          momentum: `https://momentum-mod.org/profile/${u.id}`,
          steam: steamId ? `https://steamcommunity.com/profiles/${steamId}` : null,
        },
        steam: steam
          ? {
              personaName: steam.persona_name,
              avatarHash: steam.avatar_hash,
              avatarUrl: steam.avatar_hash ? `/api/avatars/${steam.avatar_hash}` : null,
              profileUrl: steam.profile_url,
              profileState: steam.profile_state,
              communityVisibilityState: steam.community_visibility_state,
              timeCreated: toIso(steam.time_created as Date | null),
              locCountryCode: steam.loc_country_code,
              vacBanned: steam.vac_banned,
              numberOfVacBans: steam.number_of_vac_bans,
              numberOfGameBans: steam.number_of_game_bans,
              communityBanned: steam.community_banned,
              economyBan: steam.economy_ban,
              daysSinceLastBan: steam.days_since_last_ban,
              lastRefreshedAt: toIso(steam.last_refreshed_at as Date | null),
              lastSourcebansRefreshAt: toIso(steam.last_sourcebans_refresh_at as Date | null),
            }
          : null,
        counts,
        history: history.map((h) => ({
          source: h.source,
          field: h.field,
          oldValue: h.old_value,
          newValue: h.new_value,
          observedAt: toIso(h.observed_at),
        })),
        aliases: aliases.map((a) => ({
          name: a.name,
          source: a.source,
          firstSeen: toIso(a.first_seen),
          lastSeen: toIso(a.last_seen),
        })),
        avatars: avatarsRows.map((a) => ({
          hash: a.avatar_hash,
          source: a.source,
          firstSeen: toIso(a.first_seen),
          lastSeen: toIso(a.last_seen),
          archived: a.archived,
          url: a.archived ? `/api/avatars/${a.avatar_hash}` : steamAvatarUrl(a.avatar_hash),
        })),
        statsHistory: snapshots.map((s) => ({
          observedAt: toIso(s.observed_at as Date),
          cosXp: num(s.cos_xp),
          level: num(s.level),
          mapsCompleted: num(s.maps_completed),
          runsSubmitted: num(s.runs_submitted),
          totalJumps: num(s.total_jumps),
          totalStrafes: num(s.total_strafes),
        })),
        sourcebans: sourcebans.map((b) => ({
          server: b.server,
          banTimestamp: toIso(b.ban_timestamp as Date),
          unbanTimestamp: toIso(b.unban_timestamp as Date | null),
          currentState: b.current_state,
          banReason: b.ban_reason,
          unbanReason: b.unban_reason,
          nameAtBan: b.name_at_ban,
        })),
        credits,
      };
    },
  );

  api.get(
    '/users/:id/runs',
    {
      schema: {
        tags: ['users'],
        summary: 'All archived runs of a user, including removed ones',
        params: IdParam,
        querystring: Type.Object({
          gamemode: Type.Optional(GamemodeQuery),
          style: Type.Optional(StyleQuery),
          mapId: Type.Optional(Type.Integer({ minimum: 1 })),
          removed: Type.Optional(Type.Boolean()),
          page: PageQuery,
          take: TakeQuery,
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { gamemode, style, mapId, removed, page, take } = req.query;
      const off = offsetOf(page, take);
      const rows = (await execRows(
        db,
        sql`
        select r.id, r.map_id, m.name as map_name, r.gamemode, r.track_type, r.track_num, r.style, r.time, r.flags, r.is_pb,
               r.replay_hash, r.momentum_created_at, r.first_seen_at, r.removed_at, r.removal_kind,
               r.observed_alias, r.observed_avatar_hash, r.observed_steam_name,
               (select rank from leaderboard_entries e where e.past_run_id = r.id limit 1) as rank,
               (select 1 from replays p where p.sha1 = r.replay_hash) is not null as replay_archived,
               count(*) over() as total
        from runs r join maps m on m.id = r.map_id
        where r.user_id = ${req.params.id}
          and (${gamemode ?? null}::int is null or r.gamemode = ${gamemode ?? null})
          and (${style ?? null}::int is null or r.style = ${style ?? null})
          and (${mapId ?? null}::int is null or r.map_id = ${mapId ?? null})
          and (${removed ?? null}::boolean is null or (r.removed_at is not null) = ${removed ?? null})
        order by r.momentum_created_at desc limit ${take} offset ${off}
      `,
      )) as unknown as Record<string, unknown>[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(total, page, take, rows.map(runRow));
    },
  );

  api.get(
    '/users/:id/follow-events',
    {
      schema: {
        tags: ['users'],
        summary: 'Follow and unfollow events involving the user',
        params: IdParam,
        querystring: Type.Object({ page: PageQuery, take: TakeQuery }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { page, take } = req.query;
      const id = req.params.id;
      const rows = (await execRows(
        db,
        sql`
        select e.id, e.follower_id, a.alias as follower_alias, e.followed_id, b.alias as followed_alias, e.event, e.observed_at, count(*) over() as total
        from follow_events e left join users a on a.id = e.follower_id left join users b on b.id = e.followed_id
        where e.follower_id = ${id} or e.followed_id = ${id}
        order by e.observed_at desc limit ${take} offset ${offsetOf(page, take)}
      `,
      )) as unknown as Record<string, unknown>[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(
        total,
        page,
        take,
        rows.map((r) => ({
          id: Number(r.id),
          followerId: r.follower_id,
          followerAlias: r.follower_alias,
          followedId: r.followed_id,
          followedAlias: r.followed_alias,
          event: r.event,
          observedAt: toIso(r.observed_at as Date),
        })),
      );
    },
  );

  api.get(
    '/users/:id/follows',
    {
      schema: {
        tags: ['users'],
        summary: 'Current followers and follows',
        params: IdParam,
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const id = req.params.id;
      const followers = (await execRows(
        db,
        sql`
        select f.follower_id as id, u.alias, u.avatar_hash, f.momentum_created_at, f.first_seen_at from follows f left join users u on u.id = f.follower_id
        where f.followed_id = ${id} and f.removed_at is null order by f.momentum_created_at desc nulls last limit 500
      `,
      )) as unknown as Record<string, unknown>[];
      const following = (await execRows(
        db,
        sql`
        select f.followed_id as id, u.alias, u.avatar_hash, f.momentum_created_at, f.first_seen_at from follows f left join users u on u.id = f.followed_id
        where f.follower_id = ${id} and f.removed_at is null order by f.momentum_created_at desc nulls last limit 500
      `,
      )) as unknown as Record<string, unknown>[];
      const map = (r: Record<string, unknown>) => ({
        id: r.id,
        alias: r.alias,
        avatarHash: r.avatar_hash,
        since: toIso(r.momentum_created_at as Date | null),
        firstSeenAt: toIso(r.first_seen_at as Date),
      });
      return { followers: followers.map(map), following: following.map(map) };
    },
  );
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToUser(r: Record<string, unknown>): typeof users.$inferSelect {
  return {
    id: r.id as number,
    steamId: (r.steam_id as string) ?? null,
    alias: (r.alias as string) ?? null,
    country: (r.country as string) ?? null,
    avatarHash: (r.avatar_hash as string) ?? null,
    avatarUrl: (r.avatar_url as string) ?? null,
    roles: (r.roles as number) ?? 0,
    bans: (r.bans as number) ?? 0,
    bio: (r.bio as string) ?? null,
    socials: (r.socials as Record<string, string>) ?? null,
    cosXp: num(r.cos_xp),
    level: num(r.level),
    mapsCompleted: num(r.maps_completed),
    runsSubmitted: num(r.runs_submitted),
    totalJumps: num(r.total_jumps),
    totalStrafes: num(r.total_strafes),
    momentumCreatedAt: (r.momentum_created_at as Date) ?? null,
    firstSeenAt: r.first_seen_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    lastRefreshedAt: (r.last_refreshed_at as Date) ?? null,
    profileFetched: Boolean(r.profile_fetched),
    isDeleted: Boolean(r.is_deleted),
    lastRunAt: (r.last_run_at as Date) ?? null,
    followsObservedAt: (r.follows_observed_at as Date) ?? null,
    activitiesObservedAt: (r.activities_observed_at as Date) ?? null,
  };
}

export function runRow(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    userId: r.user_id !== undefined ? Number(r.user_id) : undefined,
    userAlias: r.user_alias,
    mapId: r.map_id,
    mapName: r.map_name,
    gamemode: r.gamemode,
    trackType: r.track_type,
    trackNum: r.track_num,
    style: r.style,
    time: r.time,
    flags: r.flags,
    isPb: r.is_pb,
    rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
    replayHash: r.replay_hash,
    replayArchived: Boolean(r.replay_archived),
    momentumCreatedAt: toIso(r.momentum_created_at as Date),
    firstSeenAt: toIso(r.first_seen_at as Date),
    removedAt: toIso(r.removed_at as Date | null),
    removalKind: r.removal_kind ?? null,
    observedAlias: r.observed_alias,
    observedAvatarHash: r.observed_avatar_hash,
    observedSteamName: r.observed_steam_name,
  };
}
