// The admin panel's security properties, as tests: an anonymous caller gets
// nothing, a forged cookie gets nothing, a Steam login by anyone other than the
// configured owner gets nothing, and a real session still cannot write without
// the Origin and CSRF checks.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { execRows } from '../src/db/index.js';
import { buildApp, type App } from '../src/http/app.js';
import { createSession, cookieName, SESSION_COOKIE } from '../src/http/auth/sessions.js';
import { verifyCallback } from '../src/http/auth/steam-openid.js';
import { getLogger } from '../src/logger.js';
import type { MomentumClient } from '../src/momentum/client.js';
import type { PollerContext } from '../src/poller/context.js';
import { createPollerControl } from '../src/poller/control.js';
import { Scheduler } from '../src/poller/scheduler.js';
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
let scheduler: Scheduler;
let releaseSlow: () => void = () => {};
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
  // A real scheduler with stand in jobs: the panel drives it exactly as it drives the poller.
  const mom = { stats: () => ({ callsTotal: 0 }) } as unknown as MomentumClient;
  scheduler = new Scheduler(t.db, mom, getLogger('scheduler-test'));
  scheduler.register({
    name: 'slow-sweep',
    intervalMs: 3600_000,
    run: (signal, progress) =>
      new Promise((resolve) => {
        progress({ done: 3, total: 10, note: 'halfway-ish' });
        releaseSlow = () => resolve({ seen: 10, new: 2 });
        signal.addEventListener('abort', () => resolve({ seen: 3 }));
      }),
  });
  scheduler.register({ name: 'backfill', intervalMs: 0, manual: true, run: async () => ({}) });
  scheduler.register({
    name: 'replay-download',
    intervalMs: 0,
    worker: true,
    run: async () => {},
  });
  const ctx = { db: t.db, scheduler, log: getLogger('poller-test') } as unknown as PollerContext;
  app = await buildApp({
    cfg,
    db: t.db,
    dbApp: t.db,
    dbSql: (async () => [{ '?column?': 1 }]) as never,
    storage,
    schemaVersion: 4,
    control: createPollerControl(ctx, true),
    log: getLogger('admin-test'),
    status: {
      pollerEnabled: true,
      jobs: () => scheduler.statuses(),
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
  await scheduler.stop();
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
      '/api/admin/poller',
      '/api/admin/poller/history',
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

describe('poller controls', () => {
  const start = (name: string, payload: Record<string, unknown> = {}, headers = writeHeaders()) =>
    app.inject({ method: 'POST', url: `/api/admin/poller/jobs/${name}/start`, headers, payload });

  it('refuses to start anything without a session or without the CSRF token', async () => {
    expect((await start('slow-sweep', {}, {} as never)).statusCode).toBe(401);
    expect(
      (await start('slow-sweep', {}, authed({ origin: 'https://momarchive.org' }))).statusCode,
    ).toBe(403);
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/admin/poller/refresh',
      headers: authed({ origin: 'https://momarchive.org' }),
      payload: { kind: 'user', key: '14991' },
    });
    expect(refresh.statusCode).toBe(403);
    expect(scheduler.statuses().find((j) => j.name === 'slow-sweep')!.runs).toBe(0);
  });

  it('starts a job, shows its progress, refuses a second start and cancels it', async () => {
    const r = await start('slow-sweep');
    expect(r.statusCode).toBe(202);
    const again = await start('slow-sweep');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('running');

    const live = await app.inject({ url: '/api/admin/poller', headers: authed() });
    expect(live.statusCode).toBe(200);
    const job = (live.json().jobs as { name: string }[]).find((j) => j.name === 'slow-sweep');
    expect(job).toMatchObject({ running: true, progress: { done: 3, total: 10 } });

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/admin/poller/jobs/slow-sweep/cancel',
      headers: writeHeaders(),
    });
    expect(cancel.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(scheduler.statuses().find((j) => j.name === 'slow-sweep')!.running).toBe(false),
    );
    const st = scheduler.statuses().find((j) => j.name === 'slow-sweep')!;
    expect(st.lastItemsSeen).toBe(3);
    expect(st.nextRunAt).not.toBeNull();

    const notRunning = await app.inject({
      method: 'POST',
      url: '/api/admin/poller/jobs/slow-sweep/cancel',
      headers: writeHeaders(),
    });
    expect(notRunning.statusCode).toBe(409);

    const hist = await app.inject({
      url: '/api/admin/poller/history?job=slow-sweep',
      headers: authed(),
    });
    expect(hist.json().data[0]).toMatchObject({ job: 'slow-sweep', ok: true, itemsSeen: 3 });
  });

  it('runs a job to the end when left alone', async () => {
    expect((await start('slow-sweep')).statusCode).toBe(202);
    releaseSlow();
    await vi.waitFor(() =>
      expect(scheduler.statuses().find((j) => j.name === 'slow-sweep')!.running).toBe(false),
    );
    expect(scheduler.statuses().find((j) => j.name === 'slow-sweep')!.lastItemsNew).toBe(2);
  });

  it('only starts registered jobs, never a worker, and validates the backfill phase', async () => {
    expect((await start('no-such-job')).statusCode).toBe(404);
    expect((await start('replay-download')).statusCode).toBe(400);
    expect((await start('Bad_Name')).statusCode).toBe(400);
    expect((await start('backfill', { phase: 'everything' })).statusCode).toBe(400);
    expect((await start('backfill', { phase: 'users', sql: 'drop' })).statusCode).toBe(400);
  });

  it('will not start a second backfill while another process is walking', async () => {
    await execRows(
      t.db,
      sql`insert into sync_state (job, cursor, updated_at)
          values ('backfill', ${JSON.stringify({ phase: 'runs', updatedAt: new Date().toISOString() })}::jsonb, now())`,
    );
    const r = await start('backfill', { phase: 'runs' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('busy-elsewhere');
  });

  it('queues a refresh at the front, and only for well formed keys', async () => {
    const send = (kind: string, key: string) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/poller/refresh',
        headers: writeHeaders(),
        payload: { kind, key },
      });
    expect((await send('user', '14991')).statusCode).toBe(200);
    expect((await send('leaderboard', '2231:3:0:0:0')).statusCode).toBe(200);
    for (const [kind, key] of [
      ['user', '0'],
      ['user', '12; drop table users'],
      ['map', '-1'],
      ['leaderboard', '2231:3:0'],
      ['steam', '1'],
    ] as const) {
      expect((await send(kind, key)).statusCode, `${kind} ${key}`).toBe(400);
    }
    const rows = (await execRows(
      t.db,
      sql`select kind, key, priority from refresh_queue order by kind`,
    )) as unknown as { kind: string; key: string; priority: number }[];
    expect(rows).toEqual([
      { kind: 'leaderboard', key: '2231:3:0:0:0', priority: 1 },
      { kind: 'user', key: '14991', priority: 1 },
    ]);
  });

  it('requeues failed replay downloads and leaves the 404s alone unless asked', async () => {
    await execRows(
      t.db,
      sql`insert into replay_queue (sha1, state, attempts, next_attempt_at, enqueued_at) values
          (${'a'.repeat(40)}, 'failed', 5, now(), now()), (${'b'.repeat(40)}, 'failed', 5, now(), now())`,
    );
    await execRows(
      t.db,
      sql`insert into replay_fetch_failures (sha1, attempts, last_status, first_failed_at, last_failed_at, gave_up) values
          (${'a'.repeat(40)}, 5, 500, now(), now(), true), (${'b'.repeat(40)}, 5, 404, now(), now(), true)`,
    );
    const requeue = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/poller/replays/requeue',
        headers: writeHeaders(),
        payload,
      });
    expect((await requeue({})).json().requeued).toBe(1);
    expect((await requeue({ include404: true })).json().requeued).toBe(1);
  });

  it('audits every lever pulled', async () => {
    const r = await app.inject({ url: '/api/admin/audit', headers: authed() });
    const actions = (r.json().data as { action: string }[]).map((a) => a.action);
    for (const a of ['poller.start', 'poller.cancel', 'poller.refresh', 'poller.requeue-replays'])
      expect(actions).toContain(a);
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
