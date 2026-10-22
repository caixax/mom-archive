// /api/admin: the owner's panel. Everything here needs a live admin session,
// every write needs the Origin and CSRF checks on top, and every write is
// audited. Reads go through the read only pool; writes go through the app role,
// which can only touch the five admin tables.
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { execRows } from '../../db/index.js';
import { adminSessions, announcements, userNotices } from '../../db/schema.js';
import { AnyObject, toIso } from '../common.js';
import type { HttpDeps } from '../deps.js';
import type { Guard } from '../auth/guard.js';
import { revokeSession } from '../auth/sessions.js';
import { REFRESH_KINDS, validRefreshKey } from '../../poller/control.js';

const Level = Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('critical')]);
const Scope = Type.Union([Type.Literal('home'), Type.Literal('all')]);
const Body = Type.String({ minLength: 1, maxLength: 2000 });
const IdParam = Type.Object({ id: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) });
const Hours = Type.Integer({ minimum: 1, maximum: 24 * 90, default: 24 });
const JobName = Type.String({ pattern: '^[a-z][a-z-]{0,39}$' });
const Phase = Type.Union(
  ['runs', 'users', 'maps', 'leaderboards', 'beta-runs'].map((p) => Type.Literal(p)),
);
const startedAt = new Date();

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  guard: Guard,
): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  // Nothing under /api/admin exists on an instance with no owner configured.
  if (!guard.enabled) return;
  const write = deps.dbApp!;

  // Announcements

  api.get(
    '/admin/announcements',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const rows = await db.select().from(announcements).orderBy(desc(announcements.createdAt));
      return { data: rows.map(announcementRow) };
    },
  );

  api.post(
    '/admin/announcements',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        body: Type.Object({
          body: Body,
          level: Type.Optional(Level),
          scope: Type.Optional(Scope),
          startsAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
          endsAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
          active: Type.Optional(Type.Boolean()),
        }),
        response: { 200: AnyObject, 400: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const now = new Date();
      const starts = parseDate(req.body.startsAt);
      const ends = parseDate(req.body.endsAt);
      if (starts && ends && starts > ends) {
        return reply
          .code(400)
          .send({ error: 'bad_request', statusCode: 400, message: 'startsAt is after endsAt' });
      }
      const [row] = await write
        .insert(announcements)
        .values({
          body: req.body.body.trim(),
          level: req.body.level ?? 'info',
          scope: req.body.scope ?? 'home',
          startsAt: starts,
          endsAt: ends,
          active: req.body.active ?? true,
          createdAt: now,
          updatedAt: now,
          createdBy: s.steamId,
        })
        .returning();
      await guard.audit(s, req, 'announcement.create', row!.id, { scope: row!.scope });
      return { data: announcementRow(row!) };
    },
  );

  api.patch(
    '/admin/announcements/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        body: Type.Object({
          body: Type.Optional(Body),
          level: Type.Optional(Level),
          scope: Type.Optional(Scope),
          startsAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
          endsAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
          active: Type.Optional(Type.Boolean()),
        }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body.body !== undefined) patch.body = req.body.body.trim();
      if (req.body.level !== undefined) patch.level = req.body.level;
      if (req.body.scope !== undefined) patch.scope = req.body.scope;
      if (req.body.startsAt !== undefined) patch.startsAt = parseDate(req.body.startsAt);
      if (req.body.endsAt !== undefined) patch.endsAt = parseDate(req.body.endsAt);
      if (req.body.active !== undefined) patch.active = req.body.active;
      const [row] = await write
        .update(announcements)
        .set(patch)
        .where(eq(announcements.id, req.params.id))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      await guard.audit(s, req, 'announcement.update', row.id, { fields: Object.keys(patch) });
      return { data: announcementRow(row) };
    },
  );

  api.delete(
    '/admin/announcements/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const rows = await write
        .delete(announcements)
        .where(eq(announcements.id, req.params.id))
        .returning({ id: announcements.id });
      if (rows.length === 0) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      await guard.audit(s, req, 'announcement.delete', req.params.id);
      return { ok: true };
    },
  );

  // Notices pinned to an archived user's page

  api.get(
    '/admin/notices',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({
          userId: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const rows = (await execRows(
        db,
        sql`select n.*, u.alias from user_notices n left join users u on u.id = n.user_id
            where (${req.query.userId ?? null}::int is null or n.user_id = ${req.query.userId ?? null})
            order by n.created_at desc limit 500`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((r) => ({
          id: Number(r.id),
          userId: Number(r.user_id),
          alias: r.alias ?? null,
          body: r.body,
          level: r.level,
          active: r.active,
          createdAt: toIso(r.created_at as Date),
          updatedAt: toIso(r.updated_at as Date),
        })),
      };
    },
  );

  api.post(
    '/admin/notices',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        body: Type.Object({
          userId: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
          body: Body,
          level: Type.Optional(Level),
          active: Type.Optional(Type.Boolean()),
        }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const known = (await execRows(
        db,
        sql`select id from users where id = ${req.body.userId} limit 1`,
      )) as unknown as { id: number }[];
      if (known.length === 0) {
        return reply
          .code(404)
          .send({ error: 'not_found', statusCode: 404, message: 'no such archived user' });
      }
      const now = new Date();
      const [row] = await write
        .insert(userNotices)
        .values({
          userId: req.body.userId,
          body: req.body.body.trim(),
          level: req.body.level ?? 'info',
          active: req.body.active ?? true,
          createdAt: now,
          updatedAt: now,
          createdBy: s.steamId,
        })
        .returning();
      await guard.audit(s, req, 'notice.create', row!.id, { userId: req.body.userId });
      return {
        data: { ...row, createdAt: toIso(row!.createdAt), updatedAt: toIso(row!.updatedAt) },
      };
    },
  );

  api.patch(
    '/admin/notices/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        body: Type.Object({
          body: Type.Optional(Body),
          level: Type.Optional(Level),
          active: Type.Optional(Type.Boolean()),
        }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body.body !== undefined) patch.body = req.body.body.trim();
      if (req.body.level !== undefined) patch.level = req.body.level;
      if (req.body.active !== undefined) patch.active = req.body.active;
      const [row] = await write
        .update(userNotices)
        .set(patch)
        .where(eq(userNotices.id, req.params.id))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      await guard.audit(s, req, 'notice.update', row.id, { fields: Object.keys(patch) });
      return { data: { ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) } };
    },
  );

  api.delete(
    '/admin/notices/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const rows = await write
        .delete(userNotices)
        .where(eq(userNotices.id, req.params.id))
        .returning({ id: userNotices.id });
      if (rows.length === 0) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      await guard.audit(s, req, 'notice.delete', req.params.id);
      return { ok: true };
    },
  );

  // Traffic

  api.get(
    '/admin/requests/summary',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({ hours: Hours }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const h = req.query.hours;
      const [totals] = (await execRows(
        db,
        sql`select count(*)::int as requests, count(distinct ip)::int as unique_ips,
                   count(distinct user_agent)::int as unique_agents,
                   coalesce(round(avg(ms))::int, 0) as avg_ms,
                   coalesce(max(ms), 0)::int as max_ms,
                   coalesce(sum(bytes), 0)::bigint as bytes,
                   count(*) filter (where status >= 500)::int as errors,
                   count(*) filter (where status = 429)::int as rate_limited,
                   count(*) filter (where status >= 400 and status < 500)::int as client_errors,
                   count(*) filter (where admin)::int as admin_requests
            from request_log where at > now() - make_interval(hours => ${h})`,
      )) as unknown as Record<string, unknown>[];
      const series = (await execRows(
        db,
        sql`select date_trunc('hour', at) as hour, count(*)::int as requests,
                   count(distinct ip)::int as ips,
                   count(*) filter (where status >= 400)::int as errors
            from request_log where at > now() - make_interval(hours => ${h})
            group by 1 order by 1`,
      )) as unknown as Record<string, unknown>[];
      const statuses = (await execRows(
        db,
        sql`select status, count(*)::int as n from request_log
            where at > now() - make_interval(hours => ${h}) group by status order by n desc limit 20`,
      )) as unknown as { status: number; n: number }[];
      const [retention] = (await execRows(
        db,
        sql`select min(at) as oldest, count(*)::bigint as rows from request_log`,
      )) as unknown as Record<string, unknown>[];
      return {
        hours: h,
        totals: numbers(totals ?? {}),
        series: series.map((s) => ({
          hour: toIso(s.hour as Date),
          requests: Number(s.requests),
          ips: Number(s.ips),
          errors: Number(s.errors),
        })),
        statuses,
        log: {
          oldest: toIso((retention?.oldest as Date | null) ?? null),
          rows: Number(retention?.rows ?? 0),
          retentionDays: deps.cfg.REQUEST_LOG_DAYS,
          enabled: deps.cfg.REQUEST_LOG_ENABLED,
        },
      };
    },
  );

  api.get(
    '/admin/requests/top',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({
          hours: Hours,
          by: Type.Union([
            Type.Literal('ip'),
            Type.Literal('route'),
            Type.Literal('agent'),
            Type.Literal('country'),
          ]),
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const { hours, by, limit } = req.query;
      const col =
        by === 'ip'
          ? sql`ip`
          : by === 'route'
            ? sql`route`
            : by === 'agent'
              ? sql`user_agent`
              : sql`country`;
      const rows = (await execRows(
        db,
        sql`select ${col} as key, count(*)::int as requests, max(at) as last_seen,
                   count(distinct route)::int as routes,
                   coalesce(round(avg(ms))::int, 0) as avg_ms,
                   count(*) filter (where status >= 400)::int as errors,
                   (array_agg(distinct country) filter (where country is not null))[1:3] as countries,
                   (array_agg(user_agent order by at desc))[1] as agent
            from request_log
            where at > now() - make_interval(hours => ${hours}) and ${col} is not null
            group by ${col} order by requests desc limit ${limit}`,
      )) as unknown as Record<string, unknown>[];
      return {
        by,
        hours,
        data: rows.map((r) => ({
          key: r.key,
          requests: Number(r.requests),
          lastSeen: toIso(r.last_seen as Date),
          routes: Number(r.routes),
          avgMs: Number(r.avg_ms),
          errors: Number(r.errors),
          countries: r.countries ?? [],
          agent: r.agent ?? null,
        })),
      };
    },
  );

  api.get(
    '/admin/requests',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({
          hours: Hours,
          ip: Type.Optional(Type.String({ maxLength: 64 })),
          route: Type.Optional(Type.String({ maxLength: 200 })),
          status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
          method: Type.Optional(Type.String({ maxLength: 10 })),
          agent: Type.Optional(Type.String({ maxLength: 200 })),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 200 }),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const q = req.query;
      const rows = (await execRows(
        db,
        sql`select at, ip, country, method, path, route, query, status, ms, bytes, user_agent, referer, admin
            from request_log
            where at > now() - make_interval(hours => ${q.hours})
              and (${q.ip ?? null}::text is null or ip = ${q.ip ?? null})
              and (${q.route ?? null}::text is null or route = ${q.route ?? null})
              and (${q.status ?? null}::int is null or status = ${q.status ?? null})
              and (${q.method ?? null}::text is null or method = upper(${q.method ?? null}))
              and (${q.agent ?? null}::text is null or user_agent ilike '%' || ${q.agent ?? ''} || '%')
            order by at desc limit ${q.limit}`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((r) => ({
          at: toIso(r.at as Date),
          ip: r.ip,
          country: r.country,
          method: r.method,
          path: r.path,
          route: r.route,
          query: r.query,
          status: Number(r.status),
          ms: Number(r.ms),
          bytes: r.bytes === null ? null : Number(r.bytes),
          userAgent: r.user_agent,
          referer: r.referer,
          admin: r.admin,
        })),
      };
    },
  );

  // Everything, counted

  api.get(
    '/admin/stats',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const [counts] = (await execRows(
        db,
        sql`select
          (select count(*)::bigint from users) as users,
          (select count(*)::bigint from users where is_deleted) as users_hidden,
          (select count(*)::bigint from users where bans <> 0) as users_banned,
          (select count(*)::bigint from users where profile_fetched) as users_fetched,
          (select count(*)::bigint from maps) as maps,
          (select count(*)::bigint from maps where archived) as maps_archived,
          (select count(*)::bigint from map_versions) as map_versions,
          (select count(*)::bigint from map_images) as map_images,
          (select count(*)::bigint from runs) as runs,
          (select count(*)::bigint from runs where removed_at is not null) as runs_removed,
          (select count(*)::bigint from leaderboards) as leaderboards,
          (select count(*)::bigint from leaderboard_entries) as leaderboard_entries,
          (select count(*)::bigint from leaderboard_observations) as leaderboard_observations,
          (select count(*)::bigint from leaderboard_snapshots) as leaderboard_snapshots,
          (select count(*)::bigint from replays) as replays,
          (select coalesce(sum(bytes), 0)::bigint from replays) as replay_bytes,
          (select count(*)::bigint from replays where not header_ok) as replays_header_bad,
          (select count(*)::bigint from replay_fetch_failures where gave_up) as replays_lost,
          (select count(*)::bigint from replay_queue) as replay_queue,
          (select count(*)::bigint from refresh_queue) as refresh_queue,
          (select count(*)::bigint from avatars) as avatars,
          (select count(*)::bigint from user_field_changes) as user_changes,
          (select count(*)::bigint from map_field_changes) as map_changes,
          (select count(*)::bigint from steam_field_changes) as steam_changes,
          (select count(*)::bigint from steam_profiles) as steam_profiles,
          (select count(*)::bigint from steam_sourcebans) as sourcebans,
          (select count(*)::bigint from steam_name_history) as names,
          (select count(*)::bigint from activities) as activities,
          (select count(*)::bigint from follows where removed_at is null) as follows,
          (select count(*)::bigint from follow_events) as follow_events,
          (select count(*)::bigint from announcements) as announcements,
          (select count(*)::bigint from user_notices) as notices,
          (select count(*)::bigint from request_log) as request_log,
          (select count(*)::bigint from admin_audit) as audit_rows`,
      )) as unknown as Record<string, unknown>[];
      const jobs = (await execRows(
        db,
        sql`select distinct on (job) job, started_at, finished_at, ok, items_seen, items_new, api_calls, error
            from poll_log order by job, started_at desc`,
      )) as unknown as Record<string, unknown>[];
      const failures = (await execRows(
        db,
        sql`select job, count(*)::int as failures, max(started_at) as last_failure
            from poll_log where ok = false and started_at > now() - interval '7 days'
            group by job order by failures desc`,
      )) as unknown as Record<string, unknown>[];
      const growth = (await execRows(
        db,
        sql`select date_trunc('day', first_seen_at) as day, count(*)::int as runs
            from runs where first_seen_at > now() - interval '30 days' group by 1 order by 1`,
      )) as unknown as Record<string, unknown>[];
      const storage = (
        (await execRows(
          db,
          sql`select value, updated_at from kv where key = 'storage-summary'`,
        )) as unknown as { value: Record<string, unknown>; updated_at: Date }[]
      )[0];
      const cursors = (await execRows(
        db,
        sql`select job, cursor, updated_at from sync_state order by job`,
      )) as unknown as Record<string, unknown>[];
      return {
        counts: numbers(counts ?? {}),
        jobs: jobs.map((j) => ({
          job: j.job,
          startedAt: toIso(j.started_at as Date),
          finishedAt: toIso(j.finished_at as Date | null),
          ok: j.ok,
          itemsSeen: j.items_seen,
          itemsNew: j.items_new,
          apiCalls: j.api_calls,
          error: j.error,
        })),
        failures: failures.map((f) => ({
          job: f.job,
          failures: Number(f.failures),
          lastFailure: toIso(f.last_failure as Date),
        })),
        runsPerDay: growth.map((g) => ({ day: toIso(g.day as Date), runs: Number(g.runs) })),
        storage: storage ? { ...storage.value, updatedAt: toIso(storage.updated_at) } : null,
        cursors: cursors.map((c) => ({
          job: c.job,
          cursor: c.cursor,
          updatedAt: toIso(c.updated_at as Date),
        })),
      };
    },
  );

  // Poller: what every job is doing right now, and the levers to start, stop and queue work.

  api.get(
    '/admin/poller',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const st = deps.status;
      const recent = (await execRows(
        db,
        sql`select job, count(*)::int as runs,
                   count(*) filter (where ok = false)::int as failures,
                   coalesce(round(avg(extract(epoch from finished_at - started_at) * 1000)
                     filter (where finished_at is not null))::int, 0) as avg_ms,
                   coalesce(sum(api_calls), 0)::int as api_calls
            from poll_log where started_at > now() - interval '24 hours' group by job`,
      )) as unknown as Record<string, unknown>[];
      const byJob = new Map(recent.map((r) => [r.job as string, r]));
      const refresh = (await execRows(
        db,
        sql`select kind, count(*) filter (where started_at is null)::int as pending,
                   count(*) filter (where started_at is not null)::int as in_flight,
                   count(*) filter (where priority <= 1)::int as urgent,
                   max(attempts)::int as max_attempts, min(enqueued_at) as oldest
            from refresh_queue group by kind order by kind`,
      )) as unknown as Record<string, unknown>[];
      const [replay] = (await execRows(
        db,
        sql`select count(*) filter (where state = 'pending')::int as pending,
                   count(*) filter (where state = 'in_flight')::int as in_flight,
                   count(*) filter (where state = 'failed')::int as failed,
                   min(enqueued_at) filter (where state = 'pending') as oldest
            from replay_queue`,
      )) as unknown as Record<string, unknown>[];
      const [lost] = (await execRows(
        db,
        sql`select count(*) filter (where gave_up)::int as gave_up,
                   count(*) filter (where gave_up and last_status = 404)::int as gone_404,
                   count(*) filter (where not gave_up)::int as retrying
            from replay_fetch_failures`,
      )) as unknown as Record<string, unknown>[];
      const replayFailures = (await execRows(
        db,
        sql`select sha1, attempts, last_status, last_error, last_failed_at, gave_up
            from replay_fetch_failures order by last_failed_at desc limit 20`,
      )) as unknown as Record<string, unknown>[];
      const fetchFailures = (await execRows(
        db,
        sql`select kind, count(*)::int as n, count(*) filter (where gave_up)::int as gave_up,
                   max(last_at) as last_at
            from fetch_failures group by kind order by n desc`,
      )) as unknown as Record<string, unknown>[];
      const cursors = (await execRows(
        db,
        sql`select job, cursor, updated_at from sync_state where job in ('backfill', 'maps-walk')`,
      )) as unknown as { job: string; cursor: Record<string, unknown>; updated_at: Date }[];
      const mem = process.memoryUsage();
      const mom = st.momentum();
      const steam = st.steam();
      const sh = st.steamHistory();
      return {
        pollerEnabled: st.pollerEnabled,
        controllable: Boolean(deps.control?.enabled),
        process: {
          startedAt: toIso(startedAt),
          uptimeS: Math.round(process.uptime()),
          node: process.version,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          schema: deps.schemaVersion,
          gamemodes: deps.cfg.ARCHIVE_GAMEMODES,
        },
        jobs: st.jobs().map((j) => {
          const r = byJob.get(j.name);
          return {
            name: j.name,
            worker: j.worker,
            manual: j.manual,
            running: j.running,
            cancelRequested: j.cancelRequested,
            progress: j.progress ? { ...j.progress, at: toIso(j.progress.at) } : null,
            intervalMs: j.intervalMs,
            lastStartAt: toIso(j.lastStartAt),
            lastFinishAt: toIso(j.lastFinishAt),
            lastSuccessAt: toIso(j.lastSuccessAt),
            lastError: j.lastError,
            lastItemsSeen: j.lastItemsSeen,
            lastItemsNew: j.lastItemsNew,
            lastDurationMs: j.lastDurationMs,
            nextRunAt: toIso(j.nextRunAt),
            runs: j.runs,
            failures: j.failures,
            day: {
              runs: Number(r?.runs ?? 0),
              failures: Number(r?.failures ?? 0),
              avgMs: Number(r?.avg_ms ?? 0),
              apiCalls: Number(r?.api_calls ?? 0),
            },
          };
        }),
        clients: {
          momentum: {
            ...mom,
            lastCallAt: toIso(mom.lastCallAt),
            lastOkAt: toIso(mom.lastOkAt),
            rps: deps.cfg.RATE_LIMIT_RPS,
            rpm: deps.cfg.RATE_LIMIT_RPM,
          },
          steam: steam ? { ...steam, lastCallAt: toIso(steam.lastCallAt) } : null,
          steamHistory: sh ? { ...sh, lastCallAt: toIso(sh.lastCallAt) } : null,
        },
        queues: {
          refresh: refresh.map((r) => ({
            kind: r.kind,
            pending: Number(r.pending),
            inFlight: Number(r.in_flight),
            urgent: Number(r.urgent),
            maxAttempts: Number(r.max_attempts),
            oldest: toIso(r.oldest as Date | null),
          })),
          replay: {
            pending: Number(replay?.pending ?? 0),
            inFlight: Number(replay?.in_flight ?? 0),
            failed: Number(replay?.failed ?? 0),
            oldest: toIso((replay?.oldest as Date | null) ?? null),
            gaveUp: Number(lost?.gave_up ?? 0),
            gone404: Number(lost?.gone_404 ?? 0),
            retrying: Number(lost?.retrying ?? 0),
          },
          replayFailures: replayFailures.map((f) => ({
            sha1: f.sha1,
            attempts: Number(f.attempts),
            lastStatus: f.last_status === null ? null : Number(f.last_status),
            lastError: f.last_error,
            lastFailedAt: toIso(f.last_failed_at as Date),
            gaveUp: f.gave_up,
          })),
          fetchFailures: fetchFailures.map((f) => ({
            kind: f.kind,
            n: Number(f.n),
            gaveUp: Number(f.gave_up),
            lastAt: toIso(f.last_at as Date),
          })),
        },
        cursors: Object.fromEntries(
          cursors.map((c) => [c.job, { ...c.cursor, updatedAt: toIso(c.updated_at) }]),
        ),
      };
    },
  );

  api.get(
    '/admin/poller/history',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({
          job: Type.Optional(JobName),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const job = req.query.job ?? null;
      const rows = (await execRows(
        db,
        sql`select id, job, started_at, finished_at, ok, items_seen, items_new, api_calls, error
            from poll_log where (${job}::text is null or job = ${job})
            order by started_at desc limit ${req.query.limit}`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((r) => ({
          id: Number(r.id),
          job: r.job,
          startedAt: toIso(r.started_at as Date),
          finishedAt: toIso(r.finished_at as Date | null),
          ok: r.ok,
          itemsSeen: Number(r.items_seen),
          itemsNew: Number(r.items_new),
          apiCalls: Number(r.api_calls),
          error: r.error,
        })),
      };
    },
  );

  const noPoller = (reply: FastifyReply) =>
    reply.code(409).send({
      error: 'poller_disabled',
      statusCode: 409,
      message: 'POLLER_ENABLED is false in this process, so there is nothing to start.',
    });

  api.post(
    '/admin/poller/jobs/:name/start',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: Type.Object({ name: JobName }),
        body: Type.Object(
          { phase: Type.Optional(Phase), only: Type.Optional(Phase) },
          { additionalProperties: false },
        ),
        response: { 202: AnyObject, 400: AnyObject, 404: AnyObject, 409: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const control = deps.control;
      if (!control?.enabled) return noPoller(reply);
      const name = req.params.name;
      const args = name === 'backfill' ? { ...req.body } : undefined;
      const r = await control.start(name, args);
      if (r === 'unknown') return reply.code(404).send({ error: 'unknown_job', statusCode: 404 });
      if (r === 'worker') {
        return reply.code(400).send({
          error: 'worker',
          statusCode: 400,
          message: 'This is a continuous worker; it is always running.',
        });
      }
      if (r !== 'started') {
        const message =
          r === 'running'
            ? 'Already running.'
            : r === 'busy-elsewhere'
              ? 'The backfill cursor moved in the last few minutes from another process (pnpm sync?).'
              : 'The scheduler is shutting down.';
        return reply.code(409).send({ error: r, statusCode: 409, message });
      }
      await guard.audit(s, req, 'poller.start', name, args);
      return reply.code(202).send({ ok: true, job: name });
    },
  );

  api.post(
    '/admin/poller/jobs/:name/cancel',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: Type.Object({ name: JobName }),
        response: { 200: AnyObject, 409: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      if (!deps.control?.enabled) return noPoller(reply);
      if (!deps.control.cancel(req.params.name)) {
        return reply
          .code(409)
          .send({ error: 'not_running', statusCode: 409, message: 'That job is not running.' });
      }
      await guard.audit(s, req, 'poller.cancel', req.params.name);
      return { ok: true };
    },
  );

  api.post(
    '/admin/poller/refresh',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        body: Type.Object(
          {
            kind: Type.Union(REFRESH_KINDS.map((k) => Type.Literal(k))),
            key: Type.String({ minLength: 1, maxLength: 40 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 400: AnyObject, 409: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      if (!deps.control) return noPoller(reply);
      const { kind } = req.body;
      const key = req.body.key.trim();
      if (!validRefreshKey(kind, key)) {
        return reply.code(400).send({
          error: 'bad_request',
          statusCode: 400,
          message:
            kind === 'leaderboard'
              ? 'A leaderboard key is mapId:gamemode:trackType:trackNum:style.'
              : 'The key is a positive integer id.',
        });
      }
      await deps.control.refresh(kind, key);
      await guard.audit(s, req, 'poller.refresh', `${kind}:${key}`);
      return { ok: true, kind, key };
    },
  );

  api.post(
    '/admin/poller/replays/requeue',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        body: Type.Object(
          { include404: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 409: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      if (!deps.control) return noPoller(reply);
      const include404 = req.body.include404 ?? false;
      const n = await deps.control.requeueReplays(include404);
      await guard.audit(s, req, 'poller.requeue-replays', null, { include404, requeued: n });
      return { ok: true, requeued: n };
    },
  );

  // Audit and sessions

  api.get(
    '/admin/audit',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const rows = (await execRows(
        db,
        sql`select at, steam_id, action, target, details, ip, user_agent from admin_audit
            order by at desc limit ${req.query.limit}`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((r) => ({
          at: toIso(r.at as Date),
          steamId: r.steam_id,
          action: r.action,
          target: r.target,
          details: r.details,
          ip: r.ip,
          userAgent: r.user_agent,
        })),
      };
    },
  );

  api.get(
    '/admin/sessions',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      const me = await guard.requireAdmin(req, reply);
      if (!me) return reply;
      const rows = await db
        .select({
          id: adminSessions.id,
          steamId: adminSessions.steamId,
          createdAt: adminSessions.createdAt,
          lastSeenAt: adminSessions.lastSeenAt,
          expiresAt: adminSessions.expiresAt,
          revokedAt: adminSessions.revokedAt,
          ip: adminSessions.ip,
          userAgent: adminSessions.userAgent,
        })
        .from(adminSessions)
        .orderBy(desc(adminSessions.createdAt))
        .limit(100);
      return {
        data: rows.map((r) => ({
          id: r.id,
          steamId: r.steamId,
          createdAt: toIso(r.createdAt),
          lastSeenAt: toIso(r.lastSeenAt),
          expiresAt: toIso(r.expiresAt),
          revokedAt: toIso(r.revokedAt),
          ip: r.ip,
          userAgent: r.userAgent,
          current: r.id === me.id,
        })),
      };
    },
  );

  api.delete(
    '/admin/sessions/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: Type.Object({ id: Type.String({ pattern: '^[0-9a-f]{32}$' }) }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      await revokeSession(write, req.params.id);
      await guard.audit(s, req, 'session.revoke', req.params.id);
      return { ok: true };
    },
  );

  api.post(
    '/admin/sessions/revoke-others',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const rows = await write
        .update(adminSessions)
        .set({ revokedAt: new Date() })
        .where(and(sql`${adminSessions.id} <> ${s.id}`, isNull(adminSessions.revokedAt)))
        .returning({ id: adminSessions.id });
      await guard.audit(s, req, 'session.revoke-others', null, { count: rows.length });
      return { ok: true, revoked: rows.length };
    },
  );
}

function announcementRow(a: typeof announcements.$inferSelect) {
  return {
    id: a.id,
    body: a.body,
    level: a.level,
    scope: a.scope,
    startsAt: toIso(a.startsAt),
    endsAt: toIso(a.endsAt),
    active: a.active,
    createdAt: toIso(a.createdAt),
    updatedAt: toIso(a.updatedAt),
  };
}

function parseDate(v: string | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Postgres hands bigint counts back as strings; the panel wants numbers. */
function numbers(row: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? Number(v) : Number(v);
  return out;
}
