// /api/member: players sign in with Steam to file reports and follow their
// answers. A report is private between its author and the archive owner, and its
// author is a pseudonym to the owner unless they chose a category that needs to
// say who they are (a request about their own data, or a reply to a case).
// None of these routes is written to the request log.
import { randomBytes } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { execRows, type Db } from '../../db/index.js';
import { members, reportMessages, reports } from '../../db/schema.js';
import { BanName, flagNames } from '../../momentum/enums.js';
import {
  createMemberGuard,
  createMemberSession,
  memberCode,
  MEMBER_STATE_COOKIE,
  type MemberSession,
} from '../auth/members.js';
import { cookieName, cookieOptions, newStateToken, safeEqual } from '../auth/sessions.js';
import { buildLoginUrl, verifyCallback } from '../auth/steam-openid.js';
import { AnyObject, toIso } from '../common.js';
import type { HttpDeps } from '../deps.js';

export const REPORT_CATEGORIES = {
  cheating: { identified: false, label: 'Suspected cheating' },
  data_error: { identified: false, label: 'Something in the archive is wrong' },
  other: { identified: false, label: 'Something else' },
  about_me: { identified: true, label: 'This is about me (reply to a case or a record)' },
  privacy: { identified: true, label: 'Hide parts of my profile' },
} as const;
export type ReportCategory = keyof typeof REPORT_CATEGORIES;

export const LIMITS = {
  newPerDay: 3,
  openAtOnce: 5,
  messagesPerDay: 30,
  title: 120,
  body: 4000,
};

const Category = Type.Union([
  Type.Literal('cheating'),
  Type.Literal('data_error'),
  Type.Literal('other'),
  Type.Literal('about_me'),
  Type.Literal('privacy'),
]);
const PublicId = Type.String({ pattern: '^[A-Za-z0-9_-]{12}$' });
const Body = Type.String({ minLength: 1, maxLength: LIMITS.body });

export interface Eligibility {
  inArchive: boolean;
  userId: number | null;
  alias: string | null;
  mapsCompleted: number | null;
  banNames: string[];
  /** Can file the anonymous categories */
  anonymous: boolean;
  /** Can file the signed categories */
  identified: boolean;
  reason: string | null;
}

export async function eligibility(db: Db, steamId: string, minMaps: number): Promise<Eligibility> {
  const [u] = (await execRows(
    db,
    sql`select id, alias, maps_completed, bans from users
        where steam_id = ${steamId} and not is_deleted order by last_seen_at desc limit 1`,
  )) as unknown as {
    id: number;
    alias: string | null;
    maps_completed: number | null;
    bans: number;
  }[];
  if (!u)
    return {
      inArchive: false,
      userId: null,
      alias: null,
      mapsCompleted: null,
      banNames: [],
      anonymous: false,
      identified: false,
      reason:
        'This Steam account is not in the archive. Only Momentum Mod players the archive has seen can send reports.',
    };
  const banNames = flagNames(Number(u.bans ?? 0), BanName);
  const maps = u.maps_completed === null ? null : Number(u.maps_completed);
  let reason: string | null = null;
  if (banNames.length)
    reason = 'Accounts with a Momentum ban can only send requests about themselves.';
  else if (maps === null || maps < minMaps)
    reason = `Anonymous reports need at least ${minMaps} completed maps on Momentum${maps === null ? ' (the archive has not fetched your stats yet)' : ` (you have ${maps})`}. Requests about yourself are open to you.`;
  return {
    inArchive: true,
    userId: Number(u.id),
    alias: u.alias,
    mapsCompleted: maps,
    banNames,
    anonymous: reason === null,
    identified: true,
    reason,
  };
}

export async function registerMemberRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const cfg = deps.cfg;
  const guard = createMemberGuard(cfg, deps.dbApp ?? null);

  api.get(
    '/member/me',
    { schema: { tags: ['reports'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!guard.enabled) return { enabled: false, authenticated: false };
      const s = await guard.session(req);
      if (!s) return { enabled: true, authenticated: false, minMaps: cfg.REPORTS_MIN_MAPS };
      const el = await eligibility(deps.db, s.steamId, cfg.REPORTS_MIN_MAPS);
      const [unread] = (await execRows(
        deps.dbApp!,
        sql`select count(*)::int as n from reports
            where member_key = ${s.memberKey} and last_admin_message_at is not null
              and (member_seen_at is null or member_seen_at < last_admin_message_at)`,
      )) as unknown as { n: number }[];
      return {
        enabled: true,
        authenticated: true,
        code: memberCode(s.memberKey),
        blocked: s.blocked,
        // The player's own account, shown back to them only. Not stored with reports.
        account: { userId: el.userId, alias: el.alias, mapsCompleted: el.mapsCompleted },
        canReport: {
          anonymous: el.anonymous && !s.blocked,
          identified: el.identified && !s.blocked,
        },
        reason: s.blocked ? 'Reports from this account are closed.' : el.reason,
        unread: unread?.n ?? 0,
        minMaps: cfg.REPORTS_MIN_MAPS,
        csrfToken: guard.csrfFor(s),
        expiresAt: s.expiresAt.toISOString(),
      };
    },
  );

  if (!guard.enabled) return;
  const write = deps.dbApp!;
  const stateCookie = cookieName(MEMBER_STATE_COOKIE, cfg.isDev);
  const callbackBase = `${cfg.PUBLIC_BASE_URL}/api/member/callback`;

  api.get(
    '/member/login',
    {
      schema: {
        tags: ['reports'],
        hide: true,
        querystring: Type.Object({
          next: Type.Optional(Type.String({ pattern: '^/[A-Za-z0-9/?=&_.%-]{0,200}$' })),
        }),
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const state = newStateToken();
      const next = req.query.next && !req.query.next.startsWith('//') ? req.query.next : '/reports';
      reply.setCookie(stateCookie, `${state}|${next}`, cookieOptions(cfg.isDev, 600));
      return reply.redirect(
        buildLoginUrl(cfg.PUBLIC_BASE_URL, `${callbackBase}?state=${encodeURIComponent(state)}`),
        302,
      );
    },
  );

  api.get(
    '/member/callback',
    {
      schema: {
        tags: ['reports'],
        hide: true,
        querystring: Type.Object({ state: Type.String({ minLength: 8, maxLength: 64 }) }),
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const cookies = req.cookies as Record<string, string | undefined> | undefined;
      const [expected, next] = (cookies?.[stateCookie] ?? '').split('|');
      reply.clearCookie(stateCookie, { path: '/' });
      const fail = (why: string) => reply.redirect(`/report?error=${encodeURIComponent(why)}`, 302);
      if (!expected || !safeEqual(expected, req.query.state)) return fail('sign in expired');
      const params: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.query as Record<string, unknown>))
        if (typeof v === 'string') params[k] = v;
      const result = await verifyCallback(params, {
        expectedReturnTo: `${callbackBase}?state=${encodeURIComponent(req.query.state)}`,
        logger: deps.log,
        fetchImpl: deps.openidFetch,
      });
      if (!result.ok) return fail(result.retryable ? 'steam unreachable' : 'verification failed');
      const s = await createMemberSession(write, cfg.APP_SECRET!, result.steamId);
      reply.setCookie(guard.cookie, s.token, cookieOptions(cfg.isDev, 30 * 86400));
      return reply.redirect(
        next && next.startsWith('/') && !next.startsWith('//') ? next : '/reports',
        302,
      );
    },
  );

  api.post('/member/logout', { schema: { tags: ['reports'], hide: true } }, async (req, reply) => {
    const s = await guard.requireWrite(req, reply);
    if (!s) return reply;
    await guard.revoke(s.id);
    reply.clearCookie(guard.cookie, { path: '/' });
    return { ok: true };
  });

  const own = async (s: MemberSession, publicId: string) =>
    (
      await write
        .select()
        .from(reports)
        .where(and(eq(reports.publicId, publicId), eq(reports.memberKey, s.memberKey)))
        .limit(1)
    )[0] ?? null;

  const refuse = (reply: FastifyReply, code: number, error: string, message: string) =>
    reply.code(code).send({ error, statusCode: code, message });

  api.get(
    '/member/reports',
    { schema: { tags: ['reports'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      const s = await guard.require(req, reply);
      if (!s) return reply;
      const rows = await write
        .select()
        .from(reports)
        .where(eq(reports.memberKey, s.memberKey))
        .orderBy(desc(reports.lastMessageAt))
        .limit(100);
      return { data: rows.map(memberReport) };
    },
  );

  api.post(
    '/member/reports',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['reports'],
        hide: true,
        body: Type.Object(
          {
            category: Category,
            title: Type.String({ minLength: 3, maxLength: LIMITS.title }),
            body: Body,
            subjectKind: Type.Optional(
              Type.Union([
                Type.Literal('user'),
                Type.Literal('run'),
                Type.Literal('map'),
                Type.Null(),
              ]),
            ),
            subjectId: Type.Optional(
              Type.Union([
                Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
                Type.Null(),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 403: AnyObject, 429: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      if (s.blocked) return refuse(reply, 403, 'blocked', 'Reports from this account are closed.');
      const b = req.body;
      const cat = REPORT_CATEGORIES[b.category];
      const el = await eligibility(deps.db, s.steamId, cfg.REPORTS_MIN_MAPS);
      if (cat.identified ? !el.identified : !el.anonymous)
        return refuse(reply, 403, 'not_eligible', el.reason ?? 'Not allowed.');
      const [counts] = (await execRows(
        write,
        sql`select count(*) filter (where created_at > now() - interval '1 day')::int as today,
                   count(*) filter (where status <> 'closed')::int as open
            from reports where member_key = ${s.memberKey}`,
      )) as unknown as { today: number; open: number }[];
      if ((counts?.today ?? 0) >= LIMITS.newPerDay)
        return refuse(reply, 429, 'too_many', `At most ${LIMITS.newPerDay} new reports a day.`);
      if ((counts?.open ?? 0) >= LIMITS.openAtOnce)
        return refuse(
          reply,
          429,
          'too_many_open',
          `At most ${LIMITS.openAtOnce} open reports at once. Close one you no longer need.`,
        );
      const now = new Date();
      const subjectKind = b.subjectKind && b.subjectId ? b.subjectKind : null;
      const report = await write.transaction(async (tx) => {
        const [r] = await tx
          .insert(reports)
          .values({
            publicId: randomBytes(9).toString('base64url'),
            memberKey: s.memberKey,
            category: b.category,
            subjectKind,
            subjectId: subjectKind ? String(b.subjectId) : null,
            title: b.title.trim(),
            identified: cat.identified,
            reporterSteamId: cat.identified ? s.steamId : null,
            createdAt: now,
            updatedAt: now,
            lastMessageAt: now,
            lastMemberMessageAt: now,
            memberSeenAt: now,
          })
          .returning();
        await tx
          .insert(reportMessages)
          .values({ reportId: r!.id, author: 'member', body: b.body.trim(), createdAt: now });
        await tx
          .update(members)
          .set({ reportsTotal: sql`${members.reportsTotal} + 1`, lastSeenAt: now })
          .where(eq(members.memberKey, s.memberKey));
        return r!;
      });
      return { data: memberReport(report) };
    },
  );

  api.get(
    '/member/reports/:publicId',
    {
      schema: {
        tags: ['reports'],
        hide: true,
        params: Type.Object({ publicId: PublicId }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.require(req, reply);
      if (!s) return reply;
      const r = await own(s, req.params.publicId);
      if (!r) return refuse(reply, 404, 'not_found', 'No such report on this account.');
      const msgs = await write
        .select()
        .from(reportMessages)
        .where(eq(reportMessages.reportId, r.id))
        .orderBy(asc(reportMessages.createdAt), asc(reportMessages.id));
      await write.update(reports).set({ memberSeenAt: new Date() }).where(eq(reports.id, r.id));
      return {
        data: {
          ...memberReport(r),
          messages: msgs.map((m) => ({
            id: m.id,
            author: m.author === 'admin' ? 'admin' : 'you',
            body: m.body,
            createdAt: toIso(m.createdAt),
          })),
        },
      };
    },
  );

  api.post(
    '/member/reports/:publicId/messages',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['reports'],
        hide: true,
        params: Type.Object({ publicId: PublicId }),
        body: Type.Object({ body: Body }, { additionalProperties: false }),
        response: {
          200: AnyObject,
          403: AnyObject,
          404: AnyObject,
          409: AnyObject,
          429: AnyObject,
        },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      if (s.blocked) return refuse(reply, 403, 'blocked', 'Reports from this account are closed.');
      const r = await own(s, req.params.publicId);
      if (!r) return refuse(reply, 404, 'not_found', 'No such report on this account.');
      if (r.status === 'closed') return refuse(reply, 409, 'closed', 'This report is closed.');
      const [n] = (await execRows(
        write,
        sql`select count(*)::int as n from report_messages m join reports r on r.id = m.report_id
            where r.member_key = ${s.memberKey} and m.author = 'member' and m.created_at > now() - interval '1 day'`,
      )) as unknown as { n: number }[];
      if ((n?.n ?? 0) >= LIMITS.messagesPerDay)
        return refuse(reply, 429, 'too_many', `At most ${LIMITS.messagesPerDay} messages a day.`);
      const now = new Date();
      await write.transaction(async (tx) => {
        await tx
          .insert(reportMessages)
          .values({ reportId: r.id, author: 'member', body: req.body.body.trim(), createdAt: now });
        await tx
          .update(reports)
          .set({
            status: 'open',
            updatedAt: now,
            lastMessageAt: now,
            lastMemberMessageAt: now,
            memberSeenAt: now,
          })
          .where(eq(reports.id, r.id));
      });
      return { ok: true };
    },
  );

  api.post(
    '/member/reports/:publicId/close',
    {
      schema: {
        tags: ['reports'],
        hide: true,
        params: Type.Object({ publicId: PublicId }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const r = await own(s, req.params.publicId);
      if (!r) return refuse(reply, 404, 'not_found', 'No such report on this account.');
      await write
        .update(reports)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(eq(reports.id, r.id));
      return { ok: true };
    },
  );
}

function memberReport(r: typeof reports.$inferSelect) {
  return {
    publicId: r.publicId,
    category: r.category,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    title: r.title,
    status: r.status,
    identified: r.identified,
    createdAt: toIso(r.createdAt),
    lastMessageAt: toIso(r.lastMessageAt),
    unread: Boolean(
      r.lastAdminMessageAt && (!r.memberSeenAt || r.memberSeenAt < r.lastAdminMessageAt),
    ),
  };
}
