// /api/health, /api/stats, /api/changes, /api/status, /api/about
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { GamemodeName } from '../../momentum/enums.js';
import {
  AnyObject,
  archiveSince,
  GamemodeQuery,
  offsetOf,
  PageQuery,
  paged,
  StyleQuery,
  TakeQuery,
  toIso,
  TrackTypeQuery,
  TtlCache,
} from '../common.js';
import type { HttpDeps } from '../deps.js';
import { execRows } from '../../db/index.js';

const CHANGE_TYPES = [
  'alias',
  'avatar',
  'ban',
  'role',
  'removed_run',
  'steam_name',
  'steam_avatar',
  'vac',
  'new_wr',
  'deleted_user',
  'map',
] as const;

export async function registerMiscRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: 'Liveness',
        response: { 200: Type.Object({ ok: Type.Boolean(), schema: Type.Integer() }) },
      },
    },
    async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return { ok: true, schema: deps.schemaVersion };
    },
  );

  const statsCache = new TtlCache<Record<string, unknown>>(60_000);
  api.get(
    '/stats',
    { schema: { tags: ['meta'], summary: 'Archive totals', response: { 200: AnyObject } } },
    async () => {
      return statsCache.get(async () => {
        const [c] = (await execRows(
          db,
          sql`
        select
          (select count(*)::int from users) as users,
          (select count(*)::int from maps) as maps,
          (select count(*)::int from maps where archived) as archived_maps,
          (select count(*)::bigint from runs) as runs,
          (select count(*)::int from runs where removed_at is not null) as removed_runs,
          (select count(*)::int from replays) as replays,
          (select coalesce(sum(bytes), 0)::bigint from replays) as replay_bytes,
          (select count(*)::int from replay_fetch_failures where gave_up) as replays_lost,
          (select count(*)::int from leaderboard_entries where removed_at is null) as leaderboard_entries,
          (select count(*)::int from leaderboards where removed_at is null) as leaderboards,
          (select count(*)::int from user_field_changes) as user_changes,
          (select count(*)::int from steam_field_changes) as steam_changes,
          (select count(*)::int from avatars) as avatars,
          (select count(*)::int from steam_sourcebans) as sourcebans,
          (select count(*)::int from activities) as activities
      `,
        )) as unknown as Record<string, unknown>[];
        const last = (await execRows(
          db,
          sql`
        select distinct on (job) job, finished_at, ok, items_seen, items_new, api_calls from poll_log where ok = true order by job, finished_at desc
      `,
        )) as unknown as Record<string, unknown>[];
        const [calls] = (await execRows(
          db,
          sql`select coalesce(sum(api_calls), 0)::int as n from poll_log where started_at > now() - interval '1 hour'`,
        )) as unknown as { n: number }[];
        const storage = (
          (await execRows(
            db,
            sql`select value, updated_at from kv where key = 'storage-summary'`,
          )) as unknown as { value: Record<string, unknown>; updated_at: Date }[]
        )[0];
        const perGamemode = (await execRows(
          db,
          sql`select gamemode, count(*)::int as runs from runs group by gamemode order by gamemode`,
        )) as unknown as { gamemode: number; runs: number }[];
        return {
          since: await archiveSince(db),
          gamemodes: deps.cfg.ARCHIVE_GAMEMODES.map((g) => ({
            id: g,
            name: GamemodeName[g] ?? String(g),
          })),
          totals: Object.fromEntries(
            Object.entries(c ?? {}).map(([k, v]) => [k, typeof v === 'string' ? Number(v) : v]),
          ),
          runsPerGamemode: perGamemode.map((r) => ({
            gamemode: r.gamemode,
            name: GamemodeName[r.gamemode] ?? String(r.gamemode),
            runs: r.runs,
          })),
          lastSuccessfulTick: last.map((l) => ({
            job: l.job,
            finishedAt: toIso(l.finished_at as Date),
            itemsSeen: l.items_seen,
            itemsNew: l.items_new,
            apiCalls: l.api_calls,
          })),
          apiCallsLastHour: calls?.n ?? 0,
          storage: storage ? { ...storage.value, updatedAt: toIso(storage.updated_at) } : null,
        };
      });
    },
  );

  api.get(
    '/changes',
    {
      schema: {
        tags: ['meta'],
        summary: 'Global recent changes feed',
        querystring: Type.Object({
          type: Type.Optional(Type.Union(CHANGE_TYPES.map((t) => Type.Literal(t)))),
          page: PageQuery,
          take: TakeQuery,
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { type, page, take } = req.query;
      const t = type ?? null;
      const rows = (await execRows(
        db,
        sql`
        with feed as (
          select case c.field when 'alias' then 'alias' when 'avatar' then 'avatar' when 'avatar_hidden' then 'avatar' when 'bans' then 'ban' when 'roles' then 'role' when 'deleted' then 'deleted_user' else null end as type,
                 c.user_id, null::int as map_id, c.field, c.old_value, c.new_value, c.observed_at as at, null::bigint as run_id
          from user_field_changes c where c.field in ('alias','avatar','avatar_hidden','bans','roles','deleted')
          union all
          select case s.field when 'personaname' then 'steam_name' when 'avatarhash' then 'steam_avatar' else 'vac' end,
                 u.id, null, s.field, s.old_value, s.new_value, s.observed_at, null
          from steam_field_changes s join users u on u.steam_id = s.steam_id
          where s.field in ('personaname','avatarhash','vac_banned','number_of_vac_bans','number_of_game_bans','community_banned')
          union all
          select 'removed_run', e.user_id, e.map_id, 'leaderboard_entry', e.time::text, null, e.removed_at, e.past_run_id
          from leaderboard_entries e where e.removed_at is not null
          union all
          select 'new_wr', e.user_id, e.map_id, 'rank', null, e.time::text, coalesce(e.momentum_created_at, e.first_seen_at), e.past_run_id
          from leaderboard_entries e where e.rank = 1 and e.removed_at is null and e.gamemode in ${deps.cfg.ARCHIVE_GAMEMODES}
          union all
          select 'map', null, m.map_id, m.field, m.old_value, m.new_value, m.observed_at, null
          from map_field_changes m where m.field in ('status','name','currentVersionID')
        )
        select f.*, u.alias as user_alias, u.avatar_hash as user_avatar_hash, m.name as map_name, count(*) over() as total
        from feed f left join users u on u.id = f.user_id left join maps m on m.id = f.map_id
        where (${t}::text is null or f.type = ${t}) and f.type is not null
        order by f.at desc limit ${take} offset ${offsetOf(page, take)}
      `,
      )) as unknown as Record<string, unknown>[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(
        total,
        page,
        take,
        rows.map((r) => ({
          type: r.type,
          userId: r.user_id,
          userAlias: r.user_alias,
          userAvatarHash: r.user_avatar_hash,
          mapId: r.map_id,
          mapName: r.map_name,
          runId: r.run_id === null || r.run_id === undefined ? null : Number(r.run_id),
          field: r.field,
          oldValue: r.old_value,
          newValue: r.new_value,
          at: toIso(r.at as Date),
        })),
      );
    },
  );

  api.get(
    '/records',
    {
      schema: {
        tags: ['meta'],
        summary: 'Current world records (first place of every leaderboard), newest first',
        querystring: Type.Object({
          gamemode: Type.Optional(GamemodeQuery),
          trackType: Type.Optional(TrackTypeQuery),
          style: Type.Optional(StyleQuery),
          mapId: Type.Optional(Type.Integer({ minimum: 1 })),
          page: PageQuery,
          take: TakeQuery,
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { gamemode, trackType, style, mapId, page, take } = req.query;
      const rows = (await execRows(
        db,
        sql`
        select e.user_id, u.alias as user_alias, u.avatar_hash as user_avatar_hash,
               e.map_id, m.name as map_name, e.past_run_id as run_id,
               e.gamemode, e.track_type, e.track_num, e.style, e.time, e.replay_hash,
               (select 1 from replays r where r.sha1 = e.replay_hash) is not null as replay_archived,
               coalesce(e.momentum_created_at, e.first_seen_at) as at,
               count(*) over() as total
        from leaderboard_entries e
        join maps m on m.id = e.map_id
        left join users u on u.id = e.user_id
        where e.rank = 1 and e.removed_at is null
          and e.gamemode in ${deps.cfg.ARCHIVE_GAMEMODES}
          and (${gamemode ?? null}::int is null or e.gamemode = ${gamemode ?? null})
          and (${trackType ?? null}::int is null or e.track_type = ${trackType ?? null})
          and (${style ?? null}::int is null or e.style = ${style ?? null})
          and (${mapId ?? null}::int is null or e.map_id = ${mapId ?? null})
        order by at desc limit ${take} offset ${offsetOf(page, take)}
      `,
      )) as unknown as Record<string, unknown>[];
      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      return paged(
        total,
        page,
        take,
        rows.map((r) => ({
          userId: r.user_id,
          userAlias: r.user_alias,
          userAvatarHash: r.user_avatar_hash,
          mapId: r.map_id,
          mapName: r.map_name,
          runId: r.run_id === null || r.run_id === undefined ? null : Number(r.run_id),
          gamemode: r.gamemode,
          trackType: r.track_type,
          trackNum: r.track_num,
          style: r.style,
          time: r.time,
          replayHash: r.replay_hash,
          replayArchived: Boolean(r.replay_archived),
          at: toIso(r.at as Date),
        })),
      );
    },
  );

  const statusCache = new TtlCache<Record<string, unknown>>(15_000);
  api.get(
    '/status',
    {
      schema: {
        tags: ['meta'],
        summary: 'Component status for the /status page',
        response: { 200: AnyObject },
      },
    },
    async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=15');
      return statusCache.get(() => buildStatus(deps));
    },
  );

  api.get(
    '/about',
    {
      schema: { tags: ['meta'], summary: 'What this archive covers', response: { 200: AnyObject } },
    },
    async () => ({
      since: await archiveSince(db),
      gamemodes: deps.cfg.ARCHIVE_GAMEMODES.map((g) => ({
        id: g,
        name: GamemodeName[g] ?? String(g),
      })),
      pollIntervalMinutes: deps.cfg.POLL_RUNS_MINUTES,
      steamEnabled: deps.cfg.steamEnabled,
      steamHistoryEnabled: deps.cfg.steamHistoryEnabled,
      bspsArchived: deps.cfg.ARCHIVE_BSPS,
      publicBaseUrl: deps.cfg.PUBLIC_BASE_URL,
    }),
  );
}

interface Component {
  name: string;
  ok: boolean;
  level: 'ok' | 'warn' | 'error';
  checkedAt: string;
  detail: string;
  data?: Record<string, unknown>;
}

async function buildStatus(deps: HttpDeps): Promise<Record<string, unknown>> {
  const now = new Date();
  const nowIso = now.toISOString();
  const components: Component[] = [];
  const st = deps.status;

  // momentum api
  const mom = st.momentum();
  const ageMin = mom.lastOkAt ? (now.getTime() - mom.lastOkAt.getTime()) / 60_000 : null;
  components.push({
    name: 'momentum_api',
    ok: !st.pollerEnabled || (ageMin !== null && ageMin < 30),
    level: !st.pollerEnabled ? 'warn' : ageMin === null ? 'warn' : ageMin < 30 ? 'ok' : 'error',
    checkedAt: nowIso,
    detail: st.pollerEnabled
      ? `last successful call ${mom.lastOkAt ? mom.lastOkAt.toISOString() : 'never'}, last status ${mom.lastStatus ?? 'none'}, ${mom.callsLastHour} calls in the last hour (budget ${mom.budgetPerHour})`
      : 'poller disabled in this process',
    data: {
      lastOkAt: toIso(mom.lastOkAt),
      lastStatus: mom.lastStatus,
      lastError: mom.lastError,
      callsLastHour: mom.callsLastHour,
      budgetPerHour: mom.budgetPerHour,
    },
  });

  // database
  try {
    const t = Date.now();
    await deps.dbSql`select 1`;
    const ms = Date.now() - t;
    components.push({
      name: 'database',
      ok: true,
      level: ms < 500 ? 'ok' : 'warn',
      checkedAt: nowIso,
      detail: `select 1 in ${ms} ms, schema version ${deps.schemaVersion}`,
      data: { latencyMs: ms, schema: deps.schemaVersion },
    });
  } catch (e) {
    components.push({
      name: 'database',
      ok: false,
      level: 'error',
      checkedAt: nowIso,
      detail: 'query failed',
      data: { error: (e as Error).name },
    });
  }

  // storage
  try {
    const ms = await deps.storage.headBucket();
    const summary = (
      (await execRows(
        deps.db,
        sql`select value, updated_at from kv where key = 'storage-summary'`,
      )) as unknown as { value: Record<string, unknown>; updated_at: Date }[]
    )[0];
    components.push({
      name: 'storage',
      ok: true,
      level: ms < 1000 ? 'ok' : 'warn',
      checkedAt: nowIso,
      detail: summary
        ? `bucket reachable in ${ms} ms, ${summary.value.total} objects, ${formatBytes(Number(summary.value.bytes))} (counted ${toIso(summary.updated_at)})`
        : `bucket reachable in ${ms} ms, no inventory yet`,
      data: {
        latencyMs: ms,
        objects: summary?.value.total ?? null,
        bytes: summary?.value.bytes ?? null,
        prefixes: summary?.value.prefixes ?? null,
        countedAt: toIso(summary?.updated_at ?? null),
      },
    });
  } catch (e) {
    components.push({
      name: 'storage',
      ok: false,
      level: 'error',
      checkedAt: nowIso,
      detail: 'bucket not reachable',
      data: { error: (e as Error).name },
    });
  }

  // watcher jobs
  const jobs = st.jobs();
  const jobData = jobs.map((j) => ({
    name: j.name,
    running: j.running,
    lastStartAt: toIso(j.lastStartAt),
    lastSuccessAt: toIso(j.lastSuccessAt),
    lastError: j.lastError,
    lastItemsSeen: j.lastItemsSeen,
    lastItemsNew: j.lastItemsNew,
    lastDurationMs: j.lastDurationMs,
    nextRunAt: toIso(j.nextRunAt),
    intervalMs: j.intervalMs,
    runs: j.runs,
    failures: j.failures,
  }));
  const failing = jobs.filter(
    (j) => j.lastError && (!j.lastSuccessAt || (j.lastStartAt && j.lastSuccessAt < j.lastStartAt)),
  );
  components.push({
    name: 'watcher',
    ok: st.pollerEnabled && failing.length === 0,
    level: !st.pollerEnabled
      ? 'warn'
      : failing.length === 0
        ? 'ok'
        : failing.length < 3
          ? 'warn'
          : 'error',
    checkedAt: nowIso,
    detail: st.pollerEnabled
      ? failing.length === 0
        ? `${jobs.length} jobs registered, all healthy`
        : `${failing.length} job(s) failing: ${failing.map((j) => j.name).join(', ')}`
      : 'poller disabled',
    data: { jobs: jobData },
  });

  // replay queue
  const rq =
    (
      (await execRows(
        deps.db,
        sql`
    select
      (select count(*)::int from replay_queue where state = 'pending') as pending,
      (select count(*)::int from replay_queue where state = 'in_flight') as in_flight,
      (select count(*)::int from replay_queue where state = 'failed') as failed,
      (select count(*)::int from replay_fetch_failures where gave_up) as gave_up,
      (select count(*)::int from replay_fetch_failures where gave_up and last_status = 404) as gone_404,
      (select count(*)::int from refresh_queue) as refresh_pending
  `,
      )) as unknown as Record<string, number>[]
    )[0] ?? {};
  components.push({
    name: 'replay_queue',
    ok: (rq.failed ?? 0) === 0,
    level: (rq.pending ?? 0) > 5000 ? 'warn' : 'ok',
    checkedAt: nowIso,
    detail: `${rq.pending ?? 0} pending, ${rq.in_flight ?? 0} in flight, ${rq.failed ?? 0} failed, ${rq.gave_up ?? 0} gave up (${rq.gone_404 ?? 0} were already deleted upstream), ${rq.refresh_pending ?? 0} refresh items queued`,
    data: rq,
  });

  // steam api
  const steam = st.steam();
  components.push({
    name: 'steam_api',
    ok: deps.cfg.steamEnabled,
    level: deps.cfg.steamEnabled ? (steam?.lastError ? 'warn' : 'ok') : 'warn',
    checkedAt: nowIso,
    detail:
      deps.cfg.steamEnabled && steam
        ? `key present, last call ${steam.lastCallAt ? steam.lastCallAt.toISOString() : 'never'}, ${steam.callsToday} of ${steam.dailyQuota} daily calls used`
        : 'no STEAM_API_KEY configured, Steam side disabled',
    data: steam
      ? {
          lastCallAt: toIso(steam.lastCallAt),
          lastStatus: steam.lastStatus,
          lastError: steam.lastError,
          callsToday: steam.callsToday,
          dailyQuota: steam.dailyQuota,
        }
      : undefined,
  });

  // steamhistory
  const sh = st.steamHistory();
  components.push({
    name: 'steamhistory',
    ok: deps.cfg.steamHistoryEnabled,
    level: deps.cfg.steamHistoryEnabled ? (sh?.lastError ? 'warn' : 'ok') : 'warn',
    checkedAt: nowIso,
    detail:
      deps.cfg.steamHistoryEnabled && sh
        ? `key present, last call ${sh.lastCallAt ? sh.lastCallAt.toISOString() : 'never'}, last status ${sh.lastStatus ?? 'none'}`
        : 'no STEAMHISTORY_API_KEY configured or disabled, SourceBans off',
    data: sh
      ? { lastCallAt: toIso(sh.lastCallAt), lastStatus: sh.lastStatus, lastError: sh.lastError }
      : undefined,
  });

  // backfill
  const bf = (
    (await execRows(
      deps.db,
      sql`select cursor, updated_at from sync_state where job = 'backfill'`,
    )) as unknown as { cursor: Record<string, unknown>; updated_at: Date }[]
  )[0];
  components.push({
    name: 'backfill',
    ok: true,
    level: 'ok',
    checkedAt: nowIso,
    detail: bf
      ? bf.cursor.phase === 'done'
        ? `finished ${toIso(bf.cursor.finishedAt as string | null)}`
        : `phase ${bf.cursor.phase}, runs ${bf.cursor.runsSkip}/${bf.cursor.runsTotal ?? '?'}, users next id ${bf.cursor.usersNextId}, updated ${toIso(bf.updated_at)}`
      : 'never run',
    data: bf ? { ...bf.cursor, updatedAt: toIso(bf.updated_at) } : undefined,
  });

  return { checkedAt: nowIso, since: await archiveSince(deps.db), components };
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
