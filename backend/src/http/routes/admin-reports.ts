// /api/admin/reports and /api/admin/privacy: answering reports and hiding parts
// of a profile on request. Reports are read and written through the app role
// (the read only role cannot see them at all). Replies are signed "Admin" to the
// reporter; which owner wrote them is only in the audit table.
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { execRows } from '../../db/index.js';
import { members, privacyHides, reportMessages, reports } from '../../db/schema.js';
import { memberCode } from '../auth/members.js';
import type { Guard } from '../auth/guard.js';
import { AnyObject, toIso } from '../common.js';
import type { HttpDeps } from '../deps.js';
import { LIMITS, REPORT_CATEGORIES } from './member.js';

const IdParam = Type.Object({ id: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) });
const Status = Type.Union([Type.Literal('open'), Type.Literal('answered'), Type.Literal('closed')]);
const MemberKey = Type.String({ pattern: '^[0-9a-f]{64}$' });

export async function registerAdminReportRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  guard: Guard,
): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  if (!guard.enabled) return;
  const db = deps.db;
  const write = deps.dbApp!;

  /** Who an identified reporter is in the archive. Anonymous reporters stay a code. */
  async function usersBySteam(
    ids: string[],
  ): Promise<Map<string, { id: number; alias: string | null }>> {
    const out = new Map<string, { id: number; alias: string | null }>();
    if (!ids.length) return out;
    const rows = (await execRows(
      db,
      sql`select distinct on (steam_id) steam_id, id, alias from users where steam_id in ${ids}
          order by steam_id, last_seen_at desc`,
    )) as unknown as { steam_id: string; id: number; alias: string | null }[];
    for (const r of rows) out.set(r.steam_id, { id: Number(r.id), alias: r.alias });
    return out;
  }

  /** A readable name for what a report is about. */
  async function subjectLabel(kind: string | null, id: string | null): Promise<string | null> {
    if (!kind || !id || !/^\d+$/.test(id)) return null;
    const q =
      kind === 'user'
        ? sql`select alias as label from users where id = ${Number(id)}`
        : kind === 'map'
          ? sql`select name as label from maps where id = ${Number(id)}`
          : sql`select coalesce(u.alias, r.observed_alias) || ' on ' || coalesce(m.name, '?') as label
                from runs r left join users u on u.id = r.user_id left join maps m on m.id = r.map_id
                where r.id = ${Number(id)}`;
    const [r] = (await execRows(db, q)) as unknown as { label: string | null }[];
    return r?.label ?? null;
  }

  api.get(
    '/admin/reports',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        querystring: Type.Object({
          status: Type.Optional(Type.Union([Status, Type.Literal('active')])),
          category: Type.Optional(Type.String({ maxLength: 20 })),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const { status, category } = req.query;
      const rows = (await execRows(
        write,
        sql`select r.*, m.blocked_at, m.reports_total,
                   (select count(*)::int from report_messages x where x.report_id = r.id) as messages
            from reports r left join members m on m.member_key = r.member_key
            where (${status ?? null}::text is null
                   or (${status ?? null} = 'active' and r.status <> 'closed')
                   or r.status = ${status ?? null})
              and (${category ?? null}::text is null or r.category = ${category ?? null})
            order by (r.admin_seen_at is null or r.admin_seen_at < r.last_member_message_at) desc,
                     r.last_message_at desc
            limit 300`,
      )) as unknown as Record<string, unknown>[];
      const people = await usersBySteam(
        rows.filter((r) => r.reporter_steam_id).map((r) => r.reporter_steam_id as string),
      );
      const [counts] = (await execRows(
        write,
        sql`select count(*) filter (where status <> 'closed')::int as active,
                   count(*) filter (where last_member_message_at is not null
                     and (admin_seen_at is null or admin_seen_at < last_member_message_at))::int as unread,
                   count(*)::int as total
            from reports`,
      )) as unknown as Record<string, number>[];
      return {
        counts: counts ?? {},
        categories: REPORT_CATEGORIES,
        data: rows.map((r) => {
          const who = r.reporter_steam_id ? people.get(r.reporter_steam_id as string) : undefined;
          return {
            id: Number(r.id),
            publicId: r.public_id,
            category: r.category,
            subjectKind: r.subject_kind,
            subjectId: r.subject_id,
            title: r.title,
            status: r.status,
            identified: r.identified,
            reporter: {
              code: memberCode(r.member_key as string),
              key: r.member_key,
              blocked: r.blocked_at !== null,
              reportsTotal: Number(r.reports_total ?? 0),
              steamId: r.identified ? r.reporter_steam_id : null,
              userId: who?.id ?? null,
              alias: who?.alias ?? null,
            },
            messages: Number(r.messages),
            createdAt: toIso(r.created_at as Date),
            lastMessageAt: toIso(r.last_message_at as Date),
            unread: Boolean(
              r.last_member_message_at &&
              (!r.admin_seen_at ||
                new Date(r.admin_seen_at as Date) < new Date(r.last_member_message_at as Date)),
            ),
          };
        }),
      };
    },
  );

  api.get(
    '/admin/reports/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const [r] = await write.select().from(reports).where(eq(reports.id, req.params.id));
      if (!r) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const [m] = await write.select().from(members).where(eq(members.memberKey, r.memberKey));
      const msgs = await write
        .select()
        .from(reportMessages)
        .where(eq(reportMessages.reportId, r.id))
        .orderBy(asc(reportMessages.createdAt), asc(reportMessages.id));
      await write.update(reports).set({ adminSeenAt: new Date() }).where(eq(reports.id, r.id));
      const who = r.reporterSteamId
        ? (await usersBySteam([r.reporterSteamId])).get(r.reporterSteamId)
        : undefined;
      const [hide] = who
        ? await write.select().from(privacyHides).where(eq(privacyHides.userId, who.id))
        : [];
      return {
        data: {
          id: r.id,
          publicId: r.publicId,
          category: r.category,
          subjectKind: r.subjectKind,
          subjectId: r.subjectId,
          subjectLabel: await subjectLabel(r.subjectKind, r.subjectId),
          title: r.title,
          status: r.status,
          identified: r.identified,
          createdAt: toIso(r.createdAt),
          reporter: {
            code: memberCode(r.memberKey),
            key: r.memberKey,
            blocked: m?.blockedAt !== null && m?.blockedAt !== undefined,
            blockedNote: m?.blockedNote ?? null,
            reportsTotal: m?.reportsTotal ?? 0,
            firstSeenAt: toIso(m?.firstSeenAt ?? null),
            steamId: r.identified ? r.reporterSteamId : null,
            userId: who?.id ?? null,
            alias: who?.alias ?? null,
            privacy: hide
              ? {
                  hideBio: hide.hideBio,
                  hideSocials: hide.hideSocials,
                  hideAvatars: hide.hideAvatars,
                }
              : null,
          },
          messages: msgs.map((x) => ({
            id: x.id,
            author: x.author,
            body: x.body,
            createdAt: toIso(x.createdAt),
          })),
        },
      };
    },
  );

  api.post(
    '/admin/reports/:id/messages',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        body: Type.Object(
          {
            body: Type.String({ minLength: 1, maxLength: LIMITS.body }),
            close: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const [r] = await write
        .select({ id: reports.id })
        .from(reports)
        .where(eq(reports.id, req.params.id));
      if (!r) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const now = new Date();
      await write.transaction(async (tx) => {
        await tx
          .insert(reportMessages)
          .values({ reportId: r.id, author: 'admin', body: req.body.body.trim(), createdAt: now });
        await tx
          .update(reports)
          .set({
            status: req.body.close ? 'closed' : 'answered',
            updatedAt: now,
            lastMessageAt: now,
            lastAdminMessageAt: now,
            adminSeenAt: now,
          })
          .where(eq(reports.id, r.id));
      });
      await guard.audit(s, req, 'report.reply', r.id, { close: req.body.close ?? false });
      return { ok: true };
    },
  );

  api.patch(
    '/admin/reports/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        body: Type.Object({ status: Status }, { additionalProperties: false }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const rows = await write
        .update(reports)
        .set({ status: req.body.status, updatedAt: new Date() })
        .where(eq(reports.id, req.params.id))
        .returning({ id: reports.id });
      if (!rows.length) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      await guard.audit(s, req, 'report.status', req.params.id, { status: req.body.status });
      return { ok: true };
    },
  );

  api.post(
    '/admin/members/:key/block',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: Type.Object({ key: MemberKey }),
        body: Type.Object(
          { blocked: Type.Boolean(), note: Type.Optional(Type.String({ maxLength: 300 })) },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const rows = await write
        .update(members)
        .set({
          blockedAt: req.body.blocked ? new Date() : null,
          blockedNote: req.body.blocked ? req.body.note?.trim() || null : null,
        })
        .where(eq(members.memberKey, req.params.key))
        .returning({ key: members.memberKey });
      if (!rows.length) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      await guard.audit(
        s,
        req,
        req.body.blocked ? 'reporter.block' : 'reporter.unblock',
        memberCode(req.params.key),
      );
      return { ok: true };
    },
  );

  // Privacy hides

  api.get(
    '/admin/privacy',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const rows = (await execRows(
        db,
        sql`select p.*, u.alias from privacy_hides p left join users u on u.id = p.user_id order by p.updated_at desc`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((r) => ({
          userId: Number(r.user_id),
          alias: r.alias ?? null,
          hideBio: r.hide_bio,
          hideSocials: r.hide_socials,
          hideAvatars: r.hide_avatars,
          note: r.note ?? null,
          reportId: r.report_id === null ? null : Number(r.report_id),
          updatedAt: toIso(r.updated_at as Date),
        })),
      };
    },
  );

  api.put(
    '/admin/privacy/:id',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        body: Type.Object(
          {
            hideBio: Type.Boolean(),
            hideSocials: Type.Boolean(),
            hideAvatars: Type.Boolean(),
            note: Type.Optional(Type.String({ maxLength: 300 })),
            reportId: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const known = (await execRows(
        db,
        sql`select id from users where id = ${req.params.id}`,
      )) as unknown as unknown[];
      if (!known.length) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const b = req.body;
      const now = new Date();
      const values = {
        hideBio: b.hideBio,
        hideSocials: b.hideSocials,
        hideAvatars: b.hideAvatars,
        note: b.note?.trim() || null,
        reportId: b.reportId ?? null,
        updatedAt: now,
      };
      if (!b.hideBio && !b.hideSocials && !b.hideAvatars) {
        await write.delete(privacyHides).where(eq(privacyHides.userId, req.params.id));
      } else {
        await write
          .insert(privacyHides)
          .values({ userId: req.params.id, createdAt: now, ...values })
          .onConflictDoUpdate({ target: privacyHides.userId, set: values });
      }
      await guard.audit(s, req, 'privacy.set', req.params.id, {
        bio: b.hideBio,
        socials: b.hideSocials,
        avatars: b.hideAvatars,
      });
      return { ok: true };
    },
  );
}
