// The admin panel's security properties, as tests: an anonymous caller gets
// nothing, a forged cookie gets nothing, a Steam login by anyone other than the
// configured owner gets nothing, and a real session still cannot write without
// the Origin and CSRF checks.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { execRows } from '../src/db/index.js';
import { buildApp, type App } from '../src/http/app.js';
import { createSession, cookieName, SESSION_COOKIE } from '../src/http/auth/sessions.js';
import { verifyCallback } from '../src/http/auth/steam-openid.js';
import { getLogger } from '../src/logger.js';
import type { Storage } from '../src/storage/s3.js';
import { createTestDb, type TestDb } from './db-helper.js';

const OWNER = '76561199516285240';
const OTHER = '76561198885632335';
const SECRET = 'a'.repeat(64);

const env = {
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
};

let t: TestDb;
let app: App;
let sessionToken = '';
let csrf = '';
const cookie = cookieName(SESSION_COOKIE, false);

beforeAll(async () => {
  t = await createTestDb();
  const cfg = loadConfig(env);
  const storage = {
    headBucket: async () => 1,
    getStream: async () => ({
      body: Readable.from([Buffer.from('x')]),
      contentLength: 1,
      contentRange: undefined,
      contentType: 'application/octet-stream',
      status: 200,
    }),
  } as unknown as Storage;
  app = await buildApp({
    cfg,
    db: t.db,
    dbApp: t.db,
    dbSql: (async () => [{ '?column?': 1 }]) as never,
    storage,
    schemaVersion: 4,
    log: getLogger('admin-test'),
    status: {
      pollerEnabled: true,
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
    sql`insert into users (id, steam_id, alias, first_seen_at, last_seen_at) values (14991, ${OTHER}, 'mochinushi', now(), now())`,
  );
  const s = await createSession({
    db: t.db,
    secret: SECRET,
    steamId: OWNER,
    ttlHours: 24,
    ip: '1.2.3.4',
    userAgent: 'vitest',
  });
  sessionToken = s.token;
  const me = await app.inject({
    url: '/api/auth/me',
    headers: { cookie: `${cookie}=${sessionToken}` },
  });
  csrf = me.json().csrfToken as string;
});

afterAll(async () => {
  await app.close();
  await t.close();
});

const authed = (extra: Record<string, string> = {}) => ({
  cookie: `${cookie}=${sessionToken}`,
  ...extra,
});
const writeHeaders = () => authed({ origin: 'https://momarchive.org', 'x-csrf-token': csrf });

describe('admin panel access', () => {
  it('says nothing about a session to an anonymous caller', async () => {
    const r = await app.inject({ url: '/api/auth/me' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ authenticated: false, admin: false });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('refuses every admin route without a session', async () => {
    for (const url of [
      '/api/admin/stats',
      '/api/admin/announcements',
      '/api/admin/notices',
      '/api/admin/requests',
      '/api/admin/requests/summary',
      '/api/admin/audit',
      '/api/admin/sessions',
    ]) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error).toBe('unauthorized');
    }
    const post = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      payload: { body: 'hello' },
    });
    expect(post.statusCode).toBe(401);
  });

  it('refuses a forged or unknown session cookie', async () => {
    for (const token of ['', 'not-a-token', 'x'.repeat(43), sessionToken + 'a']) {
      const r = await app.inject({
        url: '/api/admin/stats',
        headers: { cookie: `${cookie}=${token}` },
      });
      expect(r.statusCode, token.slice(0, 8)).toBe(401);
    }
  });

  it('lets the owner read the panel', async () => {
    const r = await app.inject({ url: '/api/admin/stats', headers: authed() });
    expect(r.statusCode).toBe(200);
    expect(r.json().counts.users).toBe(1);
    const me = await app.inject({ url: '/api/auth/me', headers: authed() });
    expect(me.json()).toMatchObject({ authenticated: true, admin: true, steamId: OWNER });
  });

  it('refuses writes without the CSRF token or with a foreign Origin', async () => {
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: authed({ origin: 'https://momarchive.org' }),
      payload: { body: 'x' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('bad_csrf_token');

    const badCsrf = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: authed({ origin: 'https://momarchive.org', 'x-csrf-token': 'b'.repeat(64) }),
      payload: { body: 'x' },
    });
    expect(badCsrf.statusCode).toBe(403);

    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: authed({ origin: 'https://evil.example', 'x-csrf-token': csrf }),
      payload: { body: 'x' },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json().error).toBe('bad_origin');
  });

  it('publishes an announcement that the public endpoint then serves', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: writeHeaders(),
      payload: { body: 'Backfill running, numbers move.', level: 'warning', scope: 'all' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as number;

    const pub = await app.inject({ url: '/api/announcements' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().data).toEqual([
      { id, body: 'Backfill running, numbers move.', level: 'warning', scope: 'all' },
    ]);

    const hidden = await app.inject({
      method: 'PATCH',
      url: `/api/admin/announcements/${id}`,
      headers: writeHeaders(),
      payload: { active: false },
    });
    expect(hidden.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/announcements' })).json().data).toEqual([]);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/admin/announcements/${id}`,
      headers: writeHeaders(),
    });
    expect(gone.statusCode).toBe(200);
  });

  it('pins a notice to a profile and shows it on the user endpoint', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/notices',
      headers: writeHeaders(),
      payload: { userId: 14991, body: 'Alias recycled by another account.', level: 'info' },
    });
    expect(created.statusCode).toBe(200);
    const user = await app.inject({ url: '/api/users/14991' });
    expect(user.json().notices).toEqual([
      { id: created.json().data.id, body: 'Alias recycled by another account.', level: 'info' },
    ]);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/admin/notices',
      headers: writeHeaders(),
      payload: { userId: 999999, body: 'nobody' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('writes an audit row for every action', async () => {
    const r = await app.inject({ url: '/api/admin/audit', headers: authed() });
    const actions = (r.json().data as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('announcement.create');
    expect(actions).toContain('notice.create');
    expect(actions).toContain('announcement.delete');
  });

  it('rejects oversized and malformed input', async () => {
    const long = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: writeHeaders(),
      payload: { body: 'x'.repeat(2001) },
    });
    expect(long.statusCode).toBe(400);
    const badLevel = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: writeHeaders(),
      payload: { body: 'x', level: 'shout' },
    });
    expect(badLevel.statusCode).toBe(400);
  });

  it('keeps the request log and shows traffic to the owner', async () => {
    const r = await app.inject({ url: '/api/admin/requests/summary', headers: authed() });
    expect(r.statusCode).toBe(200);
    expect(r.json().log.retentionDays).toBe(30);
    const top = await app.inject({ url: '/api/admin/requests/top?by=ip', headers: authed() });
    expect(top.statusCode).toBe(200);
    const bad = await app.inject({ url: '/api/admin/requests/top?by=secrets', headers: authed() });
    expect(bad.statusCode).toBe(400);
  });

  it('still refuses methods the public API never accepts', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/users' });
    expect(r.statusCode).toBe(405);
    const d = await app.inject({ method: 'DELETE', url: '/api/runs/1' });
    expect(d.statusCode).toBe(405);
  });
});

describe('steam openid verification', () => {
  const base = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${OWNER}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${OWNER}`,
    'openid.return_to': 'https://momarchive.org/api/auth/steam/callback?state=abc',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to',
    'openid.sig': 'whatever',
  };
  const opts = (fetchImpl: typeof fetch) => ({
    expectedReturnTo: base['openid.return_to'],
    logger: getLogger('openid-test'),
    fetchImpl,
  });
  const ok = (async () =>
    new Response(
      'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n',
    )) as unknown as typeof fetch;
  const no = (async () =>
    new Response(
      'ns:http://specs.openid.net/auth/2.0\nis_valid:false\n',
    )) as unknown as typeof fetch;

  it('accepts a response steam confirms', async () => {
    const r = await verifyCallback(base, opts(ok));
    expect(r).toEqual({ ok: true, steamId: OWNER });
  });

  it('refuses when steam does not confirm the signature', async () => {
    const r = await verifyCallback(base, opts(no));
    expect(r.ok).toBe(false);
  });

  it('refuses a response aimed at another return_to', async () => {
    const r = await verifyCallback(
      { ...base, 'openid.return_to': 'https://evil.example/callback?state=abc' },
      opts(ok),
    );
    expect(r).toMatchObject({ ok: false });
  });

  it('refuses an endpoint that is not steam, and a claimed id that is not a steamid', async () => {
    expect(
      (await verifyCallback({ ...base, 'openid.op_endpoint': 'https://evil.example' }, opts(ok)))
        .ok,
    ).toBe(false);
    expect(
      (
        await verifyCallback(
          {
            ...base,
            'openid.claimed_id': 'https://steamcommunity.com/openid/id/123',
            'openid.identity': 'https://steamcommunity.com/openid/id/123',
          },
          opts(ok),
        )
      ).ok,
    ).toBe(false);
  });

  it('refuses an unsigned response and a cancelled login', async () => {
    expect((await verifyCallback({ ...base, 'openid.sig': '' }, opts(ok))).ok).toBe(false);
    expect((await verifyCallback({ ...base, 'openid.mode': 'cancel' }, opts(ok))).ok).toBe(false);
  });
});

describe('sessions belong to the configured owner only', () => {
  it('ignores a session whose steamid is not an admin any more', async () => {
    const cfg = loadConfig(env);
    const s = await createSession({
      db: t.db,
      secret: SECRET,
      steamId: OTHER,
      ttlHours: 24,
      ip: null,
      userAgent: null,
    });
    const r = await app.inject({
      url: '/api/admin/stats',
      headers: { cookie: `${cookie}=${s.token}` },
    });
    expect(r.statusCode).toBe(401);
    expect(cfg.ADMIN_STEAM_IDS).toEqual([OWNER]);
  });

  it('stores only a hash of the token', async () => {
    const rows = (await execRows(t.db, sql`select token_hash from admin_sessions`)) as unknown as {
      token_hash: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(sessionToken);
    }
  });
});
