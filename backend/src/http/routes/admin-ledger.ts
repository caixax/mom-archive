// /api/admin/ledger: writing the Ledger. Same rules as the rest of the panel: a
// live owner session for everything, Origin and CSRF on top for writes, every
// write audited, writes through the app role only. Editing a published post saves
// the text it replaces as a revision, so a post is never silently rewritten.
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { execRows, type Db } from '../../db/index.js';
import { ledgerPosts, ledgerRevisions } from '../../db/schema.js';
import { BanName, flagNames } from '../../momentum/enums.js';
import type { Guard } from '../auth/guard.js';
import { AnyObject, toIso } from '../common.js';
import type { HttpDeps } from '../deps.js';
import { SLUG } from './ledger.js';

const Kind = Type.Union([
  Type.Literal('case'),
  Type.Literal('news'),
  Type.Literal('concern'),
  Type.Literal('changelog'),
]);
const IdParam = Type.Object({ id: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) });
const Fields = {
  kind: Kind,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  slug: Type.String({ pattern: SLUG, maxLength: 80 }),
  summary: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  body: Type.String({ maxLength: 100_000 }),
  pinned: Type.Boolean(),
  subjectUserId: Type.Union([Type.Integer({ minimum: 1, maximum: 2_147_483_647 }), Type.Null()]),
  publishedAt: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
};
/** Posts can be long; the app default body limit is 16 KB. */
const BODY_LIMIT = 256 * 1024;

export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72)
      .replace(/-+$/g, '') || 'post'
  );
}

async function freeSlug(db: Db, base: string, exceptId?: number): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 76)}-${i}`;
    const rows = (await execRows(
      db,
      sql`select id from ledger_posts where slug = ${slug} and (${exceptId ?? null}::int is null or id <> ${exceptId ?? null})`,
    )) as unknown as unknown[];
    if (rows.length === 0) return slug;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function adminPost(r: typeof ledgerPosts.$inferSelect) {
  return {
    id: r.id,
    slug: r.slug,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    body: r.body,
    status: r.status,
    pinned: r.pinned,
    subjectUserId: r.subjectUserId,
    publishedAt: toIso(r.publishedAt),
    editedAt: toIso(r.editedAt),
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

const fmtDay = (d: Date | string | null) =>
  d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown';

/**
 * The first draft of a case: everything the archive observed about one player,
 * as Markdown with live references. Facts only; the owner writes the context.
 */
export async function buildCaseDraft(
  db: Db,
  userId: number,
): Promise<{ title: string; summary: string; body: string } | null> {
  const [u] = (await execRows(
    db,
    sql`select id, alias, steam_id, country, bans, first_seen_at, momentum_created_at, maps_completed, runs_submitted
        from users where id = ${userId}`,
  )) as unknown as Record<string, unknown>[];
  if (!u) return null;
  const alias = (u.alias as string | null) ?? `user ${userId}`;
  const changes = (await execRows(
    db,
    sql`select field, old_value, new_value, observed_at from user_field_changes
        where user_id = ${userId} and field in ('alias', 'bans', 'roles', 'deleted')
        order by observed_at`,
  )) as unknown as Record<string, unknown>[];
  const removed = (await execRows(
    db,
    sql`select r.id, r.removed_at, r.removal_kind, r.replay_hash,
               (select e.rank from leaderboard_entries e where e.past_run_id = r.id limit 1) as rank,
               exists (select 1 from replays p where p.sha1 = r.replay_hash) as archived
        from runs r
        where r.user_id = ${userId} and r.removed_at is not null
        order by r.removed_at, r.id limit 200`,
  )) as unknown as Record<string, unknown>[];
  const [counts] = (await execRows(
    db,
    sql`select count(*)::int as runs, count(*) filter (where removed_at is not null)::int as removed
        from runs where user_id = ${userId}`,
  )) as unknown as { runs: number; removed: number }[];
  const steamId = u.steam_id as string | null;
  const sourcebans = steamId
    ? ((await execRows(
        db,
        sql`select server, ban_timestamp, ban_reason, current_state, name_at_ban from steam_sourcebans
            where steam_id = ${steamId} order by ban_timestamp`,
      )) as unknown as Record<string, unknown>[])
    : [];
  const [steam] = steamId
    ? ((await execRows(
        db,
        sql`select vac_banned, number_of_vac_bans, number_of_game_bans, days_since_last_ban from steam_profiles
            where steam_id = ${steamId}`,
      )) as unknown as Record<string, unknown>[])
    : [];

  const banChanges = changes.filter((c) => c.field === 'bans');
  const lastBan = banChanges[banChanges.length - 1];
  const banNames = flagNames(Number(u.bans ?? 0), BanName);
  const banWhen = lastBan ? fmtDay(lastBan.observed_at as Date) : null;

  const lines: string[] = [];
  lines.push('## Summary', '');
  lines.push(
    banNames.length
      ? `Since ${banWhen ?? 'a date the archive did not see'}, Momentum's public data shows [[user:${userId}]] with ${banNames.length === 1 ? (/^[AEIOU]/.test(banNames[0]!) ? 'an ' : 'a ') : ''}**${banNames.join(', ')}** ban${banNames.length === 1 ? '' : 's'}. ${counts?.removed ? `${counts.removed} of their ${counts.runs} archived runs were removed from Momentum.` : ''}`.trim()
      : `[[user:${userId}]] currently has no ban flags in Momentum's public data.`,
    '',
    '_Describe here what happened and why it matters. Keep what the records show apart from what you think of it._',
    '',
  );

  lines.push('## Timeline', '');
  lines.push(
    `- **${fmtDay(u.first_seen_at as Date)}**: first seen by the archive as **${alias}**.`,
  );
  if (u.momentum_created_at)
    lines.push(`- Momentum account created ${fmtDay(u.momentum_created_at as Date)}.`);
  for (const c of changes) {
    const when = fmtDay(c.observed_at as Date);
    if (c.field === 'alias')
      lines.push(
        `- **${when}**: alias changed from **${c.old_value ?? '?'}** to **${c.new_value ?? '?'}**.`,
      );
    else if (c.field === 'bans') {
      const from = flagNames(Number(c.old_value ?? 0), BanName);
      const to = flagNames(Number(c.new_value ?? 0), BanName);
      lines.push(
        `- **${when}**: ban flags changed from ${from.join(', ') || 'none'} to ${to.join(', ') || 'none'}.`,
      );
    } else if (c.field === 'deleted')
      lines.push(
        `- **${when}**: the account was ${c.new_value === 'true' ? 'deleted' : 'restored'}.`,
      );
    else if (c.field === 'roles') lines.push(`- **${when}**: roles changed.`);
  }
  const byDay = new Map<string, number>();
  for (const r of removed) {
    const d = fmtDay(r.removed_at as Date).slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  for (const [d, n] of byDay)
    lines.push(`- **${d}**: ${n} run${n === 1 ? '' : 's'} removed from Momentum.`);
  lines.push('');

  if (removed.length) {
    lines.push('## Removed runs', '');
    lines.push('| Run | Rank before | Removed | Replay |', '| --- | --- | --- | --- |');
    for (const r of removed) {
      const replay = r.replay_hash
        ? r.archived
          ? `[[replay:${r.replay_hash as string}]]`
          : 'not saved'
        : 'none';
      lines.push(
        `| [[run:${r.id as number}]] | ${r.rank ?? '?'} | ${fmtDay(r.removed_at as Date).slice(0, 10)} (${r.removal_kind ?? 'unknown'}) | ${replay} |`,
      );
    }
    lines.push('');
  }

  if (sourcebans.length || (steam && (steam.vac_banned || Number(steam.number_of_game_bans) > 0))) {
    lines.push('## Elsewhere', '');
    if (steam?.vac_banned || Number(steam?.number_of_game_bans ?? 0) > 0)
      lines.push(
        `- Steam reports ${Number(steam!.number_of_vac_bans ?? 0)} VAC ban(s) and ${Number(steam!.number_of_game_bans ?? 0)} game ban(s), the last ${steam!.days_since_last_ban ?? '?'} days before the archive checked.`,
      );
    for (const b of sourcebans)
      lines.push(
        `- SourceBans: banned on **${(b.server as string) ?? '?'}** ${fmtDay(b.ban_timestamp as Date).slice(0, 10)}${b.ban_reason ? `, reason "${b.ban_reason as string}"` : ''}${b.name_at_ban ? `, name at the time "${b.name_at_ban as string}"` : ''}.`,
      );
    lines.push('');
  }

  lines.push('## Sources', '');
  lines.push(
    `Every line above links to the archive's own record. The archive only knows what it observed from ${fmtDay(u.first_seen_at as Date).slice(0, 10)} on; nothing earlier is claimed.`,
  );

  return {
    title: banNames.length ? `${alias}: ${banNames.join(', ').toLowerCase()} ban` : `${alias}`,
    summary: banNames.length
      ? `${alias} was banned${banWhen ? ` around ${banWhen.slice(0, 10)}` : ''}${counts?.removed ? ` and ${counts.removed} run(s) were removed` : ''}, with no public word from Momentum. What the archive recorded.`
      : `What the archive recorded about ${alias}.`,
    body: lines.join('\n'),
  };
}

export async function registerAdminLedgerRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  guard: Guard,
): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  if (!guard.enabled) return;
  const db = deps.db;
  const write = deps.dbApp!;

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found', statusCode: 404 });

  api.get(
    '/admin/ledger',
    { schema: { tags: ['admin'], hide: true, response: { 200: AnyObject } } },
    async (req, reply) => {
      if (!(await guard.requireAdmin(req, reply))) return reply;
      const rows = (await execRows(
        db,
        sql`select p.id, p.slug, p.kind, p.title, p.status, p.pinned, p.subject_user_id, u.alias as subject_alias,
                   p.published_at, p.edited_at, p.updated_at, length(p.body)::int as chars,
                   (select count(*)::int from ledger_revisions r where r.post_id = p.id) as revisions
            from ledger_posts p left join users u on u.id = p.subject_user_id
            order by (p.status = 'draft') desc, coalesce(p.published_at, p.updated_at) desc`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: rows.map((r) => ({
          id: Number(r.id),
          slug: r.slug,
          kind: r.kind,
          title: r.title,
          status: r.status,
          pinned: r.pinned,
          subjectUserId: r.subject_user_id === null ? null : Number(r.subject_user_id),
          subjectAlias: r.subject_alias ?? null,
          publishedAt: toIso(r.published_at as Date | null),
          editedAt: toIso(r.edited_at as Date | null),
          updatedAt: toIso(r.updated_at as Date),
          chars: Number(r.chars),
          revisions: Number(r.revisions),
        })),
      };
    },
  );

  api.get(
    '/admin/ledger/:id',
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
      const [row] = await db.select().from(ledgerPosts).where(eq(ledgerPosts.id, req.params.id));
      if (!row) return notFound(reply);
      const revisions = await db
        .select({
          id: ledgerRevisions.id,
          validFrom: ledgerRevisions.validFrom,
          validTo: ledgerRevisions.validTo,
          note: ledgerRevisions.note,
        })
        .from(ledgerRevisions)
        .where(eq(ledgerRevisions.postId, row.id))
        .orderBy(desc(ledgerRevisions.validTo));
      return {
        data: {
          ...adminPost(row),
          revisions: revisions.map((r) => ({
            ...r,
            validFrom: toIso(r.validFrom),
            validTo: toIso(r.validTo),
          })),
        },
      };
    },
  );

  api.post(
    '/admin/ledger',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        tags: ['admin'],
        hide: true,
        body: Type.Object(
          {
            kind: Fields.kind,
            title: Fields.title,
            slug: Type.Optional(Fields.slug),
            summary: Type.Optional(Fields.summary),
            body: Type.Optional(Fields.body),
            pinned: Type.Optional(Fields.pinned),
            subjectUserId: Type.Optional(Fields.subjectUserId),
          },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const b = req.body;
      const now = new Date();
      const slug = await freeSlug(db, b.slug ?? slugify(b.title));
      const [row] = await write
        .insert(ledgerPosts)
        .values({
          slug,
          kind: b.kind,
          title: b.title.trim(),
          summary: b.summary?.trim() || null,
          body: b.body ?? '',
          pinned: b.pinned ?? false,
          subjectUserId: b.subjectUserId ?? null,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
          createdBy: s.steamId,
        })
        .returning();
      await guard.audit(s, req, 'ledger.create', row!.id, { slug, kind: b.kind });
      return { data: adminPost(row!) };
    },
  );

  api.post(
    '/admin/ledger/draft-case',
    {
      schema: {
        tags: ['admin'],
        hide: true,
        body: Type.Object(
          { userId: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const draft = await buildCaseDraft(db, req.body.userId);
      if (!draft) return notFound(reply);
      const now = new Date();
      const slug = await freeSlug(db, slugify(draft.title));
      const [row] = await write
        .insert(ledgerPosts)
        .values({
          slug,
          kind: 'case',
          title: draft.title,
          summary: draft.summary,
          body: draft.body,
          subjectUserId: req.body.userId,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
          createdBy: s.steamId,
        })
        .returning();
      await guard.audit(s, req, 'ledger.draft-case', row!.id, { userId: req.body.userId });
      return { data: adminPost(row!) };
    },
  );

  api.patch(
    '/admin/ledger/:id',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        tags: ['admin'],
        hide: true,
        params: IdParam,
        body: Type.Object(
          {
            kind: Type.Optional(Fields.kind),
            title: Type.Optional(Fields.title),
            slug: Type.Optional(Fields.slug),
            summary: Type.Optional(Fields.summary),
            body: Type.Optional(Fields.body),
            pinned: Type.Optional(Fields.pinned),
            subjectUserId: Type.Optional(Fields.subjectUserId),
            publishedAt: Type.Optional(Fields.publishedAt),
            status: Type.Optional(Type.Union([Type.Literal('draft'), Type.Literal('published')])),
            /** Shown next to the revision this edit creates, on a published post */
            note: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: AnyObject, 404: AnyObject, 409: AnyObject },
      },
    },
    async (req, reply) => {
      const s = await guard.requireWrite(req, reply);
      if (!s) return reply;
      const b = req.body;
      const [cur] = await db.select().from(ledgerPosts).where(eq(ledgerPosts.id, req.params.id));
      if (!cur) return notFound(reply);
      const now = new Date();
      const patch: Partial<typeof ledgerPosts.$inferInsert> = { updatedAt: now };
      if (b.kind !== undefined) patch.kind = b.kind;
      if (b.title !== undefined) patch.title = b.title.trim();
      if (b.summary !== undefined) patch.summary = b.summary?.trim() || null;
      if (b.body !== undefined) patch.body = b.body;
      if (b.pinned !== undefined) patch.pinned = b.pinned;
      if (b.subjectUserId !== undefined) patch.subjectUserId = b.subjectUserId;
      if (b.slug !== undefined && b.slug !== cur.slug) {
        if (cur.status === 'published')
          return reply.code(409).send({
            error: 'slug_locked',
            statusCode: 409,
            message: 'A published post keeps its address; links to it are out there.',
          });
        const free = await freeSlug(db, b.slug, cur.id);
        if (free !== b.slug)
          return reply
            .code(409)
            .send({ error: 'slug_taken', statusCode: 409, message: `Taken. ${free} is free.` });
        patch.slug = b.slug;
      }
      if (b.publishedAt !== undefined) patch.publishedAt = parseDate(b.publishedAt);
      if (b.status !== undefined) {
        patch.status = b.status;
        if (b.status === 'published' && !(patch.publishedAt ?? cur.publishedAt))
          patch.publishedAt = now;
      }

      // A published post that changes text keeps what it said before.
      const textChanged =
        (patch.title !== undefined && patch.title !== cur.title) ||
        (patch.summary !== undefined && patch.summary !== cur.summary) ||
        (patch.body !== undefined && patch.body !== cur.body);
      const wasLive = cur.status === 'published' && cur.publishedAt && cur.publishedAt <= now;
      const row = await write.transaction(async (tx) => {
        if (wasLive && textChanged) {
          await tx.insert(ledgerRevisions).values({
            postId: cur.id,
            title: cur.title,
            summary: cur.summary,
            body: cur.body,
            validFrom: cur.editedAt ?? cur.publishedAt!,
            validTo: now,
            note: b.note?.trim() || null,
          });
          patch.editedAt = now;
        }
        const [r] = await tx
          .update(ledgerPosts)
          .set(patch)
          .where(eq(ledgerPosts.id, cur.id))
          .returning();
        return r!;
      });
      const action =
        b.status && b.status !== cur.status
          ? b.status === 'published'
            ? 'ledger.publish'
            : 'ledger.unpublish'
          : 'ledger.update';
      await guard.audit(s, req, action, row.id, {
        fields: Object.keys(b),
        revision: Boolean(wasLive && textChanged),
      });
      return { data: adminPost(row) };
    },
  );

  api.delete(
    '/admin/ledger/:id',
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
      const rows = await write.transaction(async (tx) => {
        await tx.delete(ledgerRevisions).where(eq(ledgerRevisions.postId, req.params.id));
        return tx
          .delete(ledgerPosts)
          .where(eq(ledgerPosts.id, req.params.id))
          .returning({ slug: ledgerPosts.slug, status: ledgerPosts.status });
      });
      if (rows.length === 0) return notFound(reply);
      await guard.audit(s, req, 'ledger.delete', req.params.id, { ...rows[0] });
      return { ok: true };
    },
  );
}
