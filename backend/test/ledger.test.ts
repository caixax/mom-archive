// The Ledger: drafts stay private, published posts are public, a published post
// that is edited keeps what it said before, and a case draft is built only from
// what the archive recorded.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { execRows } from '../src/db/index.js';
import { buildApp, type App } from '../src/http/app.js';
import { createSession, cookieName, SESSION_COOKIE } from '../src/http/auth/sessions.js';
import { slugify } from '../src/http/routes/admin-ledger.js';
import { getLogger } from '../src/logger.js';
import type { Storage } from '../src/storage/s3.js';
import { createTestDb, type TestDb } from './db-helper.js';

const OWNER = '76561199516285240';
const SECRET = 'b'.repeat(64);
const cookie = cookieName(SESSION_COOKIE, false);

let t: TestDb;
let app: App;
let token = '';
let csrf = '';

beforeAll(async () => {
  t = await createTestDb();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL_RW: 'postgres://rw:x@127.0.0.1:5432/t',
    DATABASE_URL_RO: 'postgres://ro:x@127.0.0.1:5432/t',
    DATABASE_URL_APP: 'postgres://app:x@127.0.0.1:5432/t',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY: 'a',
    S3_SECRET_KEY: 's',
    PUBLIC_BASE_URL: 'https://momarchive.org',
    APP_SECRET: SECRET,
    ADMIN_STEAM_IDS: OWNER,
  });
  app = await buildApp({
    cfg,
    db: t.db,
    dbApp: t.db,
    dbSql: (async () => [{ '?column?': 1 }]) as never,
    storage: {
      getStream: async () => ({ body: Readable.from([]), status: 200 }),
    } as unknown as Storage,
    schemaVersion: 6,
    log: getLogger('ledger-test'),
    status: {
      pollerEnabled: false,
      jobs: () => [],
      momentum: () => ({
        lastCallAt: null,
        lastOkAt: null,
        lastStatus: null,
        lastError: null,
        callsLastHour: 0,
        callsTotal: 0,
        budgetPerHour: 1,
      }),
      steam: () => null,
      steamHistory: () => null,
    },
  });
  await app.ready();
  await execRows(
    t.db,
    sql`insert into users (id, steam_id, alias, bans, first_seen_at, last_seen_at)
        values (7, '76561198000000007', 'hackerman', 1, '2026-09-01T00:00:00Z', now())`,
  );
  await execRows(
    t.db,
    sql`insert into user_field_changes (user_id, field, old_value, new_value, observed_at) values
        (7, 'alias', 'h4x', 'hackerman', '2026-09-10T12:00:00Z'),
        (7, 'bans', '0', '1', '2026-10-01T08:00:00Z')`,
  );
  await execRows(
    t.db,
    sql`insert into maps (id, name, status, first_seen_at, last_seen_at) values (5, 'bhop_arcane', 0, now(), now())`,
  );
  await execRows(
    t.db,
    sql`insert into runs (id, user_id, map_id, gamemode, track_type, track_num, style, time, is_pb, replay_hash,
                          momentum_created_at, first_seen_at, last_seen_at, removed_at, removal_kind)
        values (900, 7, 5, 3, 0, 0, 0, 61.5, true, ${'d'.repeat(40)}, now(), now(), now(), '2026-10-01T09:00:00Z', 'deleted')`,
  );
  await execRows(
    t.db,
    sql`insert into replays (sha1, s3_key, bytes, downloaded_at, user_id, map_id) values (${'d'.repeat(40)}, 'replays/d', 10, now(), 7, 5)`,
  );
  const s = await createSession({
    db: t.db,
    secret: SECRET,
    steamId: OWNER,
    ttlHours: 24,
    ip: null,
    userAgent: null,
  });
  token = s.token;
  csrf = (
    await app.inject({ url: '/api/auth/me', headers: { cookie: `${cookie}=${token}` } })
  ).json().csrfToken;
});

afterAll(async () => {
  await app.close();
  await t.close();
});

const w = () => ({
  cookie: `${cookie}=${token}`,
  origin: 'https://momarchive.org',
  'x-csrf-token': csrf,
});
const post = (url: string, payload: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST') =>
  app.inject({ method, url, headers: w(), payload });

describe('ledger', () => {
  let id = 0;

  it('keeps drafts private and refuses writes without the owner', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/api/admin/ledger',
      payload: { kind: 'news', title: 'x' },
    });
    expect(anon.statusCode).toBe(401);
    const r = await post('/api/admin/ledger', {
      kind: 'changelog',
      title: 'Site update: Ledger and dashboard',
      body: '## What changed\n\n- The **Ledger** exists.',
    });
    expect(r.statusCode).toBe(200);
    id = r.json().data.id;
    expect(r.json().data).toMatchObject({
      slug: 'site-update-ledger-and-dashboard',
      status: 'draft',
    });
    expect((await app.inject({ url: '/api/ledger' })).json().total).toBe(0);
    expect(
      (await app.inject({ url: '/api/ledger/site-update-ledger-and-dashboard' })).statusCode,
    ).toBe(404);
  });

  it('publishes, lists, and serves the Markdown source and an RSS feed', async () => {
    const r = await post(`/api/admin/ledger/${id}`, { status: 'published' }, 'PATCH');
    expect(r.statusCode).toBe(200);
    const list = (await app.inject({ url: '/api/ledger?kind=changelog' })).json();
    expect(list.data).toHaveLength(1);
    const one = (await app.inject({ url: '/api/ledger/site-update-ledger-and-dashboard' })).json()
      .data;
    expect(one.body).toContain('**Ledger**');
    expect(one.revisions).toEqual([]);
    const feed = await app.inject({ url: '/api/ledger/feed.xml' });
    expect(feed.headers['content-type']).toContain('application/rss+xml');
    expect(feed.body).toContain('https://momarchive.org/ledger/site-update-ledger-and-dashboard');
  });

  it('keeps the old text of a published post as a revision when it is edited', async () => {
    const r = await post(
      `/api/admin/ledger/${id}`,
      { body: '## What changed\n\n- The **Ledger** exists, with cases.', note: 'typo' },
      'PATCH',
    );
    expect(r.statusCode).toBe(200);
    const one = (await app.inject({ url: '/api/ledger/site-update-ledger-and-dashboard' })).json()
      .data;
    expect(one.editedAt).not.toBeNull();
    expect(one.revisions).toHaveLength(1);
    expect(one.revisions[0].note).toBe('typo');
    const old = await app.inject({
      url: `/api/ledger/site-update-ledger-and-dashboard/revisions/${one.revisions[0].id}`,
    });
    expect(old.json().data.body).toBe('## What changed\n\n- The **Ledger** exists.');
    const pin = await post(`/api/admin/ledger/${id}`, { pinned: true }, 'PATCH');
    expect(pin.statusCode).toBe(200);
    const again = (
      await app.inject({ url: '/api/ledger/site-update-ledger-and-dashboard' })
    ).json();
    expect(again.data.revisions).toHaveLength(1);
  });

  it('will not move a published post to a new address', async () => {
    const r = await post(`/api/admin/ledger/${id}`, { slug: 'something-else' }, 'PATCH');
    expect(r.statusCode).toBe(409);
  });

  it('hides a post scheduled for later until its time comes', async () => {
    const r = await post('/api/admin/ledger', { kind: 'news', title: 'Coming soon' });
    const later = await post(
      `/api/admin/ledger/${r.json().data.id}`,
      { status: 'published', publishedAt: new Date(Date.now() + 86400_000).toISOString() },
      'PATCH',
    );
    expect(later.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/ledger/coming-soon' })).statusCode).toBe(404);
  });

  it('drafts a case from the archive records alone', async () => {
    const r = await post('/api/admin/ledger/draft-case', { userId: 7 });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d).toMatchObject({ kind: 'case', status: 'draft', subjectUserId: 7 });
    expect(d.title).toBe('hackerman: leaderboards ban');
    expect(d.body).toContain('[[user:7]]');
    expect(d.body).toContain('alias changed from **h4x** to **hackerman**');
    expect(d.body).toContain('[[run:900]]');
    expect(d.body).toContain(`[[replay:${'d'.repeat(40)}]]`);
    expect(d.body).toContain('ban flags changed from none to Leaderboards');
    expect((await post('/api/admin/ledger/draft-case', { userId: 99999 })).statusCode).toBe(404);
  });

  it('resolves the references a post makes in one request', async () => {
    const r = await app.inject({
      url: `/api/refs?users=7,8&runs=900&maps=bhop_arcane,5&replays=${'d'.repeat(40)}`,
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.users['7']).toMatchObject({ alias: 'hackerman', banNames: ['Leaderboards'] });
    expect(b.users['8']).toBeUndefined();
    expect(b.runs['900']).toMatchObject({ mapName: 'bhop_arcane', replayArchived: true });
    expect(b.maps['bhop_arcane']).toMatchObject({ id: 5 });
    expect(b.replays['d'.repeat(40)]).toMatchObject({ alias: 'hackerman' });
    expect((await app.inject({ url: '/api/refs?users=1;drop' })).statusCode).toBe(400);
  });

  it('rejects malformed posts', async () => {
    expect((await post('/api/admin/ledger', { kind: 'rant', title: 'x' })).statusCode).toBe(400);
    expect((await post('/api/admin/ledger', { kind: 'news', title: '' })).statusCode).toBe(400);
    expect(
      (await post('/api/admin/ledger', { kind: 'news', title: 'x', slug: 'Bad Slug' })).statusCode,
    ).toBe(400);
    expect(
      (await post('/api/admin/ledger', { kind: 'news', title: 'x', body: 'x'.repeat(100_001) }))
        .statusCode,
    ).toBe(400);
    const long = await post('/api/admin/ledger', {
      kind: 'news',
      title: 'Long',
      body: 'y'.repeat(60_000),
    });
    expect(long.statusCode).toBe(200);
  });

  it('makes readable slugs', () => {
    expect(slugify('Ñandú: el caso de X!')).toBe('nandu-el-caso-de-x');
    expect(slugify('***')).toBe('post');
  });

  it('deletes a post with its revisions, and audits all of it', async () => {
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/admin/ledger/${id}`, headers: w() }))
        .statusCode,
    ).toBe(200);
    const [n] = (await execRows(
      t.db,
      sql`select count(*)::int as n from ledger_revisions`,
    )) as unknown as {
      n: number;
    }[];
    expect(n?.n).toBe(0);
    const audit = (await app.inject({ url: '/api/admin/audit', headers: w() })).json().data as {
      action: string;
    }[];
    const actions = audit.map((a) => a.action);
    for (const a of [
      'ledger.create',
      'ledger.publish',
      'ledger.update',
      'ledger.draft-case',
      'ledger.delete',
    ])
      expect(actions).toContain(a);
  });
});
