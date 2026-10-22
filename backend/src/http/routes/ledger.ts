// /api/ledger: the owner's published posts (cases, news, concerns, site changelog).
// Bodies are Markdown source; the frontend parses them and renders the result as
// components, never as HTML. Earlier versions of an edited post stay readable.
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { execRows } from '../../db/index.js';
import { AnyObject, toIso } from '../common.js';
import type { HttpDeps } from '../deps.js';
import { BanName, flagNames } from '../../momentum/enums.js';

export const LEDGER_KINDS = ['case', 'news', 'concern', 'changelog'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const SLUG = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

const Kind = Type.Union(LEDGER_KINDS.map((k) => Type.Literal(k)));
const Slug = Type.String({ pattern: SLUG, maxLength: 80 });

/** Visible to the public: published, and its publication time has come. */
const visible = sql`p.status = 'published' and p.published_at is not null and p.published_at <= now()`;

export function postSummary(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    slug: r.slug as string,
    kind: r.kind as string,
    title: r.title as string,
    summary: (r.summary as string | null) ?? null,
    pinned: Boolean(r.pinned),
    subjectUserId: r.subject_user_id === null ? null : Number(r.subject_user_id),
    subjectAlias: (r.subject_alias as string | null) ?? null,
    publishedAt: toIso(r.published_at as Date | null),
    editedAt: toIso(r.edited_at as Date | null),
  };
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function registerLedgerRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/ledger',
    {
      schema: {
        tags: ['ledger'],
        summary: 'Published Ledger posts, pinned first, newest first',
        querystring: Type.Object({
          kind: Type.Optional(Kind),
          subject: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
          page: Type.Integer({ minimum: 1, maximum: 1000, default: 1 }),
          take: Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const { kind, subject, page, take } = req.query;
      const where = sql`${visible}
        and (${kind ?? null}::text is null or p.kind = ${kind ?? null})
        and (${subject ?? null}::int is null or p.subject_user_id = ${subject ?? null})`;
      const rows = (await execRows(
        db,
        sql`select p.id, p.slug, p.kind, p.title, p.summary, p.pinned, p.subject_user_id,
                   u.alias as subject_alias, p.published_at, p.edited_at
            from ledger_posts p left join users u on u.id = p.subject_user_id
            where ${where}
            order by p.pinned desc, p.published_at desc
            limit ${take} offset ${(page - 1) * take}`,
      )) as unknown as Record<string, unknown>[];
      const [count] = (await execRows(
        db,
        sql`select count(*)::int as n from ledger_posts p where ${where}`,
      )) as unknown as { n: number }[];
      return { total: count?.n ?? 0, page, take, data: rows.map(postSummary) };
    },
  );

  // Everything the [[user:..]], [[map:..]], [[run:..]] and [[replay:..]] references
  // in one post need, in one request.
  const idList = (max: number) =>
    Type.Optional(Type.String({ pattern: `^[0-9]{1,10}(,[0-9]{1,10}){0,${max - 1}}$` }));
  api.get(
    '/refs',
    {
      schema: {
        tags: ['ledger'],
        summary: 'Short descriptions of users, maps, runs and replays, for references in posts',
        querystring: Type.Object({
          users: idList(200),
          maps: Type.Optional(Type.String({ maxLength: 4000 })),
          runs: idList(200),
          replays: Type.Optional(Type.String({ pattern: '^[0-9a-f]{40}(,[0-9a-f]{40}){0,199}$' })),
        }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const q = req.query;
      const ints = (v?: string) => (v ? [...new Set(v.split(',').map(Number))] : []);
      const users = ints(q.users);
      const runs = ints(q.runs);
      const replays = q.replays ? [...new Set(q.replays.split(','))] : [];
      const mapKeys = q.maps ? [...new Set(q.maps.split(','))].slice(0, 200) : [];
      const mapIds = mapKeys.filter((k) => /^[0-9]{1,10}$/.test(k)).map(Number);
      const mapNames = mapKeys.filter((k) => !/^[0-9]+$/.test(k) && k.length <= 100);
      const out: Record<string, unknown> = { users: {}, maps: {}, runs: {}, replays: {} };
      if (users.length) {
        const rows = (await execRows(
          db,
          sql`select id, alias, avatar_hash, bans, is_deleted from users where id in ${users}`,
        )) as unknown as Record<string, unknown>[];
        for (const r of rows)
          (out.users as Record<string, unknown>)[String(r.id)] = {
            id: Number(r.id),
            alias: r.alias ?? null,
            avatarHash: r.avatar_hash ?? null,
            banNames: flagNames(Number(r.bans ?? 0), BanName),
            isDeleted: Boolean(r.is_deleted),
          };
      }
      if (mapIds.length || mapNames.length) {
        const rows = (await execRows(
          db,
          sql`select id, name from maps
              where id in ${mapIds.length ? mapIds : [-1]} or name in ${mapNames.length ? mapNames : ['']}`,
        )) as unknown as { id: number; name: string }[];
        for (const r of rows) {
          const v = { id: Number(r.id), name: r.name };
          (out.maps as Record<string, unknown>)[String(r.id)] = v;
          (out.maps as Record<string, unknown>)[r.name] = v;
        }
      }
      if (runs.length) {
        const rows = (await execRows(
          db,
          sql`select r.id, r.user_id, coalesce(u.alias, r.observed_alias) as alias, r.map_id, m.name as map_name,
                     r.time, r.style, r.track_type, r.track_num, r.removed_at, r.removal_kind, r.replay_hash,
                     (select e.rank from leaderboard_entries e where e.past_run_id = r.id limit 1) as rank,
                     exists (select 1 from replays p where p.sha1 = r.replay_hash) as replay_archived
              from runs r left join users u on u.id = r.user_id left join maps m on m.id = r.map_id
              where r.id in ${runs}`,
        )) as unknown as Record<string, unknown>[];
        for (const r of rows)
          (out.runs as Record<string, unknown>)[String(r.id)] = {
            id: Number(r.id),
            userId: Number(r.user_id),
            alias: r.alias ?? null,
            mapId: Number(r.map_id),
            mapName: r.map_name ?? null,
            time: Number(r.time),
            rank: r.rank === null ? null : Number(r.rank),
            removedAt: toIso(r.removed_at as Date | null),
            removalKind: r.removal_kind ?? null,
            replayHash: r.replay_hash ?? null,
            replayArchived: Boolean(r.replay_archived),
          };
      }
      if (replays.length) {
        const rows = (await execRows(
          db,
          sql`select p.sha1, p.run_time, coalesce(u.alias, p.observed_alias) as alias, p.user_id, m.name as map_name
              from replays p left join users u on u.id = p.user_id left join maps m on m.id = p.map_id
              where p.sha1 in ${replays}`,
        )) as unknown as Record<string, unknown>[];
        for (const r of rows)
          (out.replays as Record<string, unknown>)[r.sha1 as string] = {
            sha1: r.sha1,
            time: r.run_time === null ? null : Number(r.run_time),
            alias: r.alias ?? null,
            userId: r.user_id === null ? null : Number(r.user_id),
            mapName: r.map_name ?? null,
          };
      }
      return out;
    },
  );

  api.get(
    '/ledger/feed.xml',
    { schema: { tags: ['ledger'], summary: 'RSS feed of the Ledger' } },
    async (_req, reply) => {
      const rows = (await execRows(
        db,
        sql`select p.slug, p.kind, p.title, p.summary, p.published_at from ledger_posts p
            where ${visible} order by p.published_at desc limit 50`,
      )) as unknown as Record<string, unknown>[];
      const base = deps.cfg.PUBLIC_BASE_URL;
      const items = rows
        .map((r) => {
          const link = `${base}/ledger/${r.slug as string}`;
          return `<item><title>${xml(r.title as string)}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid><category>${xml(r.kind as string)}</category><pubDate>${new Date(r.published_at as Date).toUTCString()}</pubDate>${r.summary ? `<description>${xml(r.summary as string)}</description>` : ''}</item>`;
        })
        .join('');
      reply.header('content-type', 'application/rss+xml; charset=utf-8');
      reply.header('cache-control', 'public, max-age=300');
      return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>mom-archive Ledger</title><link>${xml(`${base}/ledger`)}</link><description>Cases, news, concerns and site changes from the Momentum Mod archive.</description>${items}</channel></rss>`;
    },
  );

  api.get(
    '/ledger/:slug',
    {
      schema: {
        tags: ['ledger'],
        summary: 'One published post with its Markdown body and its earlier versions',
        params: Type.Object({ slug: Slug }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const [row] = (await execRows(
        db,
        sql`select p.*, u.alias as subject_alias
            from ledger_posts p left join users u on u.id = p.subject_user_id
            where p.slug = ${req.params.slug} and ${visible}`,
      )) as unknown as Record<string, unknown>[];
      if (!row) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      const revisions = (await execRows(
        db,
        sql`select id, valid_from, valid_to, note from ledger_revisions
            where post_id = ${Number(row.id)} order by valid_to desc`,
      )) as unknown as Record<string, unknown>[];
      return {
        data: {
          ...postSummary(row),
          body: row.body as string,
          revisions: revisions.map((r) => ({
            id: Number(r.id),
            validFrom: toIso(r.valid_from as Date),
            validTo: toIso(r.valid_to as Date),
            note: (r.note as string | null) ?? null,
          })),
        },
      };
    },
  );

  api.get(
    '/ledger/:slug/revisions/:id',
    {
      schema: {
        tags: ['ledger'],
        summary: 'The text a post had before an edit',
        params: Type.Object({ slug: Slug, id: Type.Integer({ minimum: 1 }) }),
        response: { 200: AnyObject, 404: AnyObject },
      },
    },
    async (req, reply) => {
      const [row] = (await execRows(
        db,
        sql`select r.id, r.title, r.summary, r.body, r.valid_from, r.valid_to, r.note
            from ledger_revisions r join ledger_posts p on p.id = r.post_id
            where p.slug = ${req.params.slug} and r.id = ${req.params.id} and ${visible}`,
      )) as unknown as Record<string, unknown>[];
      if (!row) return reply.code(404).send({ error: 'not_found', statusCode: 404 });
      return {
        data: {
          id: Number(row.id),
          title: row.title,
          summary: row.summary ?? null,
          body: row.body,
          validFrom: toIso(row.valid_from as Date),
          validTo: toIso(row.valid_to as Date),
          note: row.note ?? null,
        },
      };
    },
  );
}
