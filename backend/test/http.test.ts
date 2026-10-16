import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/http/app.js';
import { getLogger } from '../src/logger.js';
import type {
  MomLeaderboardRun,
  MomMap,
  MomPastRun,
  MomUser,
  Paged,
} from '../src/momentum/types.js';
import { observeLeaderboard, observeMap, observeRun, observeUser } from '../src/poller/observe.js';
import type { Storage } from '../src/storage/s3.js';
import { createTestDb, type TestDb } from './db-helper.js';
import { sql } from 'drizzle-orm';
import { execRows } from '../src/db/index.js';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

const env = {
  NODE_ENV: 'test',
  DATABASE_URL_RW: 'postgres://rw:x@127.0.0.1:5432/t',
  DATABASE_URL_RO: 'postgres://ro:x@127.0.0.1:5432/t',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 's',
  PUBLIC_BASE_URL: 'https://momarchive.caixa.cc',
};

let t: TestDb;
let app: App;
const replayBytes = Buffer.from('MMTV-fake-bytes-for-download-test');

beforeAll(async () => {
  t = await createTestDb();
  const cfg = loadConfig(env);
  const storage = {
    headBucket: async () => 3,
    getStream: async (key: string, range?: string) => {
      if (!key.endsWith('.momtv')) return null;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range)!;
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : replayBytes.length - 1;
        const slice = replayBytes.subarray(start, end + 1);
        return {
          body: Readable.from([slice]),
          contentLength: slice.length,
          contentRange: `bytes ${start}-${end}/${replayBytes.length}`,
          contentType: 'application/octet-stream',
          status: 206,
        };
      }
      return {
        body: Readable.from([replayBytes]),
        contentLength: replayBytes.length,
        contentRange: undefined,
        contentType: 'application/octet-stream',
        status: 200,
      };
    },
  } as unknown as Storage;
  app = await buildApp({
    cfg,
    db: t.db,
    dbSql: (async () => [{ '?column?': 1 }]) as never,
    storage,
    schemaVersion: 2,
    log: getLogger('http-test'),
    status: {
      pollerEnabled: true,
      jobs: () => [],
      momentum: () => ({
        lastCallAt: new Date(),
        lastOkAt: new Date(),
        lastStatus: 200,
        lastError: null,
        callsLastHour: 5,
        callsTotal: 5,
        budgetPerHour: 10800,
      }),
      steam: () => null,
      steamHistory: () => null,
    },
  });
  await app.ready();

  // seed
  const at = new Date('2026-10-14T10:00:00Z');
  await observeUser(t.db, fixture<MomUser>('user-14991.json'), at);
  await observeUser(
    t.db,
    { ...fixture<MomUser>('user-14991.json'), alias: 'mochinushi' },
    new Date('2026-10-15T10:00:00Z'),
  );
  await observeMap(t.db, fixture<MomMap>('map-2231.json'), at, [3]);
  for (const r of fixture<Paged<MomPastRun>>('runs-u14991-m2231.json').data) {
    await observeRun(t.db, r, at, { alias: r.user!.alias, avatarHash: null, steamName: null });
  }
  const lb = fixture<Paged<MomLeaderboardRun>>('lb-2363.json');
  await execRows(
    t.db,
    sql`insert into maps (id, name, status, first_seen_at, last_seen_at, archived) values (2363, 'bhop_cooksassistant', 0, ${at}, ${at}, true)`,
  );
  for (const e of lb.data) if (e.user) await observeUser(t.db, e.user, at);
  const ids = new Map(
    lb.data.map((e) => [e.userID, { alias: e.user?.alias ?? null, avatarHash: null }]),
  );
  const key = { mapId: 2363, gamemode: 3, trackType: 0, trackNum: 1, style: 0 };
  await observeLeaderboard(t.db, key, lb.data, at, ids);
  await observeLeaderboard(t.db, key, lb.data.slice(0, 2), new Date('2026-10-16T10:00:00Z'), ids);
  await execRows(
    t.db,
    sql`insert into replays (sha1, s3_key, bytes, downloaded_at, header_ok, past_run_id, user_id, map_id, gamemode, track_type, track_num, style, run_time, observed_alias)
        values (${lb.data[0]!.replayHash}, ${'replays/' + lb.data[0]!.replayHash + '.momtv'}, ${replayBytes.length}, ${at}, true, ${Number(lb.data[0]!.pastRunID)}, 4558, 2363, 3, 0, 1, 0, 26.715, 'Gman')`,
  );
  await execRows(t.db, sql`refresh materialized view search_index`);
});

afterAll(async () => {
  await app.close();
  await t.close();
});

describe('http api', () => {
  it('health returns only ok and schema', async () => {
    const r = await app.inject({ url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, schema: 2 });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects non GET methods and invalid params with generic errors', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/users', payload: {} });
    expect(post.statusCode).toBe(405);
    const bad = await app.inject({ url: '/api/users/abc' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_request');
    expect(bad.json().requestId).toBeTruthy();
    const big = await app.inject({ url: '/api/users?take=1000' });
    expect(big.statusCode).toBe(400);
    const sha = await app.inject({ url: '/api/replays/not-a-sha/download' });
    expect(sha.statusCode).toBe(400);
    const missing = await app.inject({ url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
  });

  it('user detail includes history, aliases and steam id conversions', async () => {
    const r = await app.inject({ url: '/api/users/14991' });
    expect(r.statusCode).toBe(200);
    const u = r.json();
    expect(u.alias).toBe('mochinushi');
    expect(u.steamId3).toBe('[U:1:925366607]');
    expect(u.history.length).toBe(1);
    expect(u.history[0].field).toBe('alias');
    expect(u.aliases.map((a: { name: string }) => a.name).sort()).toEqual([
      '[СКОТЧ TERRIER] mochinushi',
      'mochinushi',
    ]);
    expect(u.counts.runs).toBe(14);
    expect(u.links.steam).toBe('https://steamcommunity.com/profiles/76561198885632335');
    expect((await app.inject({ url: '/api/users/424242' })).statusCode).toBe(404);
  });

  it('user search matches past aliases', async () => {
    const r = await app.inject({ url: '/api/users?q=TERRIER' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data[0].id).toBe(14991);
    expect(r.json().data[0].matchedOn).toBe('past_alias');
    const s = await app.inject({ url: '/api/search?q=STEAM_0:1:462683303' });
    expect(s.json().users[0].matchedOn).toBe('steam_id');
    const m = await app.inject({ url: '/api/search?q=biotrix' });
    expect(m.json().maps[0].name).toBe('df_biotrix-omega');
    const idq = await app.inject({ url: '/api/search?q=14991' });
    expect(idq.json().users[0].matchedOn).toBe('momentum_id');
  });

  it('user runs include the removed flag and filters', async () => {
    const r = await app.inject({ url: '/api/users/14991/runs?gamemode=3' });
    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBe(4);
    expect(r.json().data.every((x: { isPb: boolean }) => x.isPb === false)).toBe(true);
  });

  it('map detail resolves by name and id', async () => {
    const byName = await app.inject({ url: '/api/maps/df_biotrix-omega' });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().id).toBe(2231);
    expect(byName.json().bucket).toBe('beta');
    expect(byName.json().versions.length).toBe(2);
    const byId = await app.inject({ url: '/api/maps/2231' });
    expect(byId.json().name).toBe('df_biotrix-omega');
    const list = await app.inject({ url: '/api/maps?bucket=beta' });
    expect(list.json().data.map((m: { id: number }) => m.id)).toContain(2231);
  });

  it('leaderboard current and as-of views', async () => {
    const now = await app.inject({ url: '/api/maps/2363/leaderboard?gamemode=3' });
    expect(now.statusCode).toBe(200);
    const body = now.json();
    expect(body.total).toBe(3);
    const removed = body.data.filter((e: { removedAt: string | null }) => e.removedAt);
    expect(removed.length).toBe(1);
    expect(body.data[0].observedAlias).toBe('Gman');
    expect(body.data[0].replayArchived).toBe(true);

    const past = await app.inject({
      url: '/api/maps/2363/leaderboard?gamemode=3&at=2026-10-15T00:00:00Z',
    });
    expect(past.statusCode).toBe(200);
    expect(past.json().total).toBe(3);
    expect(past.json().observation.entryCount).toBe(3);

    const diff = await app.inject({
      url: '/api/maps/2363/leaderboard/diff?gamemode=3&from=2026-10-15T00:00:00Z&to=2026-10-17T00:00:00Z',
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().removed.length).toBe(1);
    expect(diff.json().added.length).toBe(0);

    const early = await app.inject({
      url: '/api/maps/2363/leaderboard?gamemode=3&at=2020-01-01T00:00:00Z',
    });
    expect(early.json().observation).toBeNull();
    const badDate = await app.inject({ url: '/api/maps/2363/leaderboard?gamemode=3&at=yesterday' });
    expect(badDate.statusCode).toBe(400);
  });

  it('changes feed lists the alias change and the removed run', async () => {
    const r = await app.inject({ url: '/api/changes' });
    expect(r.statusCode).toBe(200);
    const types = r.json().data.map((c: { type: string }) => c.type);
    expect(types).toContain('alias');
    expect(types).toContain('removed_run');
    const only = await app.inject({ url: '/api/changes?type=alias' });
    expect(only.json().data.every((c: { type: string }) => c.type === 'alias')).toBe(true);
  });

  it('records feed lists the current first place of each leaderboard', async () => {
    const r = await app.inject({ url: '/api/records' });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as {
      userId: number;
      mapName: string;
      time: number;
      gamemode: number;
      trackType: number;
      at: string;
    }[];
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.gamemode === 3)).toBe(true);
    expect(data[0]!.mapName).toBe('bhop_cooksassistant');
    // Newest first
    const dates = data.map((d) => new Date(d.at).getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    const filtered = await app.inject({ url: '/api/records?style=9' });
    expect(filtered.json().data.length).toBe(0);
  });

  it('users can be ordered by world records held and filtered by ban', async () => {
    const r = await app.inject({ url: '/api/users?sort=wrs' });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as { id: number; wrs: number }[];
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!.wrs).toBeGreaterThan(0);
    const counts = data.map((d) => d.wrs);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    const banned = await app.inject({ url: '/api/users?banned=true' });
    expect(banned.statusCode).toBe(200);
    expect((banned.json().data as { bans: number }[]).every((u) => u.bans !== 0)).toBe(true);
  });

  it('map bsp is served for a known version hash and refused otherwise', async () => {
    const miss = await app.inject({ url: '/api/maps/bsp/' + 'a'.repeat(40) });
    expect(miss.statusCode).toBe(404);
    const bad = await app.inject({ url: '/api/maps/bsp/not-a-hash' });
    expect(bad.statusCode).toBe(400);
  });

  it('replay metadata and download with range support', async () => {
    const sha = 'e38630bae44dedd6fd92d83a062d794d66e5fe08';
    const meta = await app.inject({ url: `/api/replays/${sha}` });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().mapName).toBe('bhop_cooksassistant');
    const dl = await app.inject({ url: `/api/replays/${sha}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toContain(
      'attachment; filename="bhop_cooksassistant_Gman_0m26.715s.momtv"',
    );
    expect(dl.headers['accept-ranges']).toBe('bytes');
    expect(dl.rawPayload.equals(replayBytes)).toBe(true);
    const part = await app.inject({
      url: `/api/replays/${sha}/download`,
      headers: { range: 'bytes=0-3' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${replayBytes.length}`);
    expect(part.rawPayload.toString()).toBe('MMTV');
    const nope = await app.inject({ url: `/api/replays/${'0'.repeat(40)}/download` });
    expect(nope.statusCode).toBe(404);
  });

  it('stats and status answer without secrets', async () => {
    const stats = await app.inject({ url: '/api/stats' });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().totals.users).toBeGreaterThan(0);
    expect(stats.json().totals.runs).toBe(14);
    const status = await app.inject({ url: '/api/status' });
    expect(status.statusCode).toBe(200);
    const names = status.json().components.map((c: { name: string }) => c.name);
    expect(names).toEqual([
      'momentum_api',
      'database',
      'storage',
      'watcher',
      'replay_queue',
      'steam_api',
      'steamhistory',
      'backfill',
    ]);
    const text = JSON.stringify(status.json());
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('127.0.0.1');
    const openapi = await app.inject({ url: '/api/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths['/api/users/{id}']).toBeTruthy();
  });
});
