// /api/search: one box for users (current and past names, steam ids, momentum id) and maps.
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { parseSteamId } from '../../momentum/steamid.js';
import { AnyObject, SearchText } from '../common.js';
import type { HttpDeps } from '../deps.js';
import { execRows } from '../../db/index.js';

interface Hit {
  id: number;
  alias: string | null;
  avatar_hash: string | null;
  steam_id: string | null;
  matched_on: string;
  matched_text: string;
}

export async function registerSearchRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const db = deps.db;

  api.get(
    '/search',
    {
      schema: {
        tags: ['search'],
        summary:
          'Search users by any current or past name, SteamID (64, 3 or 2) or Momentum id, and maps by name',
        querystring: Type.Object({ q: SearchText }),
        response: { 200: AnyObject },
      },
    },
    async (req) => {
      const q = req.query.q.trim();
      const users: Record<string, unknown>[] = [];
      const maps: Record<string, unknown>[] = [];
      const seenUsers = new Set<number>();
      const pushUser = (h: Hit) => {
        if (seenUsers.has(h.id)) return;
        seenUsers.add(h.id);
        users.push({
          id: h.id,
          alias: h.alias,
          avatarHash: h.avatar_hash,
          steamId: h.steam_id,
          matchedOn: h.matched_on,
          matchedText: h.matched_text,
        });
      };

      const steamId = parseSteamId(q);
      if (steamId) {
        const rows = (await execRows(
          db,
          sql`
          select id, alias, avatar_hash, steam_id, 'steam_id' as matched_on, steam_id as matched_text from users where steam_id = ${steamId} limit 5
        `,
        )) as unknown as Hit[];
        rows.forEach(pushUser);
      }
      if (/^\d{1,9}$/.test(q)) {
        const n = Number(q);
        const rows = (await execRows(
          db,
          sql`
          select id, alias, avatar_hash, steam_id, 'momentum_id' as matched_on, id::text as matched_text from users where id = ${n} limit 1
        `,
        )) as unknown as Hit[];
        rows.forEach(pushUser);
        const m = (await execRows(
          db,
          sql`select id, name, status, thumbnail_id from maps where id = ${n} limit 1`,
        )) as unknown as Record<string, unknown>[];
        for (const r of m)
          maps.push({
            id: r.id,
            name: r.name,
            status: r.status,
            thumbnailId: r.thumbnail_id,
            matchedOn: 'map_id',
            matchedText: String(r.id),
          });
      }
      if (q.length >= 2 || users.length === 0) {
        const rows = (await execRows(
          db,
          sql`
          with hits as (
            select entity_id, source, text,
                   case when lower(text) = lower(${q}) then 0 when lower(text) like lower(${q}) || '%' then 1 else 2 end as quality,
                   case source when 'alias' then 0 when 'past_alias' then 1 when 'steam_name' then 2 else 3 end as prio
            from search_index where kind = 'user' and text ilike '%' || ${q} || '%'
          ),
          best as (
            select distinct on (entity_id) entity_id, source, text, quality, prio from hits order by entity_id, quality, prio
          )
          select u.id, u.alias, u.avatar_hash, u.steam_id, b.source as matched_on, b.text as matched_text
          from best b join users u on u.id = b.entity_id
          order by b.quality, b.prio, u.last_run_at desc nulls last limit 20
        `,
        )) as unknown as Hit[];
        rows.forEach(pushUser);
        const m = (await execRows(
          db,
          sql`
          select id, name, status, thumbnail_id,
                 case when lower(name) = lower(${q}) then 0 when lower(name) like lower(${q}) || '%' then 1 else 2 end as quality
          from maps where name ilike '%' || ${q} || '%' order by quality, name limit 20
        `,
        )) as unknown as Record<string, unknown>[];
        for (const r of m) {
          if (maps.some((x) => x.id === r.id)) continue;
          maps.push({
            id: r.id,
            name: r.name,
            status: r.status,
            thumbnailId: r.thumbnail_id,
            matchedOn:
              r.quality === 0
                ? 'map_name'
                : r.quality === 1
                  ? 'map_name_prefix'
                  : 'map_name_substring',
            matchedText: r.name,
          });
        }
      }
      return { q, users: users.slice(0, 20), maps: maps.slice(0, 20) };
    },
  );
}
