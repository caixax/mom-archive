// Reports, as tests of the promises made about them: a reporter is a pseudonym
// to the owner unless they chose to sign, one player cannot read another's
// reports, the owner answers as "Admin", a player session never opens the panel,
// limits and blocks hold, nothing about /api/member/ reaches the request log, and
// a privacy request really hides what it says.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { execRows } from '../src/db/index.js';
import { buildApp, type App } from '../src/http/app.js';
import {
  createMemberSession,
  memberCode,
  memberKey,
  openSteamId,
} from '../src/http/auth/members.js';
import { cookieName, createSession, SESSION_COOKIE } from '../src/http/auth/sessions.js';
import { getLogger } from '../src/logger.js';
import type { Storage } from '../src/storage/s3.js';
import { createTestDb, type TestDb } from './db-helper.js';

const OWNER = '76561199516285240';
const SECRET = 'c'.repeat(64);
const ORIGIN = 'https://momarchive.org';
const PLAYER = '76561198000000101'; // 40 maps, no bans
const NEWBIE = '76561198000000102'; // 3 maps
const BANNED = '76561198000000103'; // 50 maps, leaderboard ban
const STRANGER = '76561198000000199'; // not in the archive
const AVATAR = 'e'.repeat(40);

const adminCookie = cookieName(SESSION_COOKIE, false);
const memberCookie = cookieName('ma_member', false);

let t: TestDb;
let app: App;
let adminToken = '';
let adminCsrf = '';
let closed = false;
const tokens: Record<string, { token: string; csrf: string }> = {};

const okSteam = (async () =>
  new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n')) as unknown as typeof fetch;

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
    PUBLIC_BASE_URL: ORIGIN,
    APP_SECRET: SECRET,
    ADMIN_STEAM_IDS: OWNER,
  });
  app = await buildApp({
    cfg,
    db: t.db,
    dbApp: t.db,
    dbSql: (async () => [{ '?column?': 1 }]) as never,
    storage: {
      getStream: async () => ({
        body: Readable.from([Buffer.from('img')]),
        contentLength: 3,
        status: 200,
      }),
    } as unknown as Storage,
    schemaVersion: 7,
    log: getLogger('reports-test'),
    openidFetch: okSteam,
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
    sql`insert into users (id, steam_id, alias, maps_completed, bans, bio, socials, avatar_hash, first_seen_at, last_seen_at) values
        (101, ${PLAYER}, 'runner', 40, 0, null, null, null, now(), now()),
        (102, ${NEWBIE}, 'newbie', 3, 0, 'my bio', '{"Twitch":"newbie_tv"}'::jsonb, ${AVATAR}, now(), now()),
        (103, ${BANNED}, 'caught', 50, 1, null, null, null, now(), now())`,
  );
  await execRows(
    t.db,
    sql`insert into avatars (hash, s3_key, bytes, source, first_seen_at)
        values (${AVATAR}, 'avatars/e.jpg', 3, 'momentum', now())`,
  );
  const s = await createSession({
    db: t.db,
    secret: SECRET,
    steamId: OWNER,
    ttlHours: 24,
    ip: null,
    userAgent: null,
  });
  adminToken = s.token;
  adminCsrf = (
    await app.inject({ url: '/api/auth/me', headers: { cookie: `${adminCookie}=${adminToken}` } })
  ).json().csrfToken;
  for (const [name, steamId] of [
    ['newbie', NEWBIE],
    ['banned', BANNED],
    ['stranger', STRANGER],
  ] as const) {
    const m = await createMemberSession(t.db, SECRET, steamId);
    const me = await app.inject({
      url: '/api/member/me',
      headers: { cookie: `${memberCookie}=${m.token}` },
    });
    tokens[name] = { token: m.token, csrf: me.json().csrfToken };
  }
});

afterAll(async () => {
  if (!closed) await app.close();
  await t.close();
});

const ips: Record<string, string> = {
  player: '10.0.0.1',
  newbie: '10.0.0.2',
  banned: '10.0.0.3',
  stranger: '10.0.0.4',
};
const as = (who: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-for': ips[who]!,
  cookie: `${memberCookie}=${tokens[who]!.token}`,
  origin: ORIGIN,
  'x-csrf-token': tokens[who]!.csrf,
  ...extra,
});
const asAdmin = () => ({
  cookie: `${adminCookie}=${adminToken}`,
  origin: ORIGIN,
  'x-csrf-token': adminCsrf,
});
const file = (who: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/member/reports', headers: as(who), payload });

describe('signing in', () => {
  it('goes through Steam and leaves a pseudonym, not a SteamID', async () => {
    const start = await app.inject({ url: '/api/member/login?next=/report' });
    expect(start.statusCode).toBe(302);
    const stateCookie = start.cookies.find((c) => c.name.endsWith('ma_mlogin'))!;
    const state = stateCookie.value.split('|')[0]!;
    const returnTo = `${ORIGIN}/api/member/callback?state=${state}`;
    const q = new URLSearchParams({
      state,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${PLAYER}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${PLAYER}`,
      'openid.return_to': returnTo,
      'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to',
      'openid.sig': 'x',
    });
    const cb = await app.inject({
      url: `/api/member/callback?${q}`,
      headers: { cookie: `${stateCookie.name}=${encodeURIComponent(stateCookie.value)}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/report');
    const session = cb.cookies.find((c) => c.name === memberCookie)!;
    expect(session.httpOnly).toBe(true);
    const me = await app.inject({
      url: '/api/member/me',
      headers: { cookie: `${memberCookie}=${session.value}` },
    });
    expect(me.json()).toMatchObject({
      authenticated: true,
      code: memberCode(memberKey(SECRET, PLAYER)),
      canReport: { anonymous: true, identified: true },
      account: { alias: 'runner' },
    });
    tokens.player = { token: session.value, csrf: me.json().csrfToken };

    // Nothing stored holds the SteamID in clear.
    const rows = (await execRows(
      t.db,
      sql`select m.*, s.* from members m join member_sessions s on s.member_key = m.member_key`,
    )) as unknown as Record<string, unknown>[];
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PLAYER);
    const sealed = rows.find((r) => r.member_key === memberKey(SECRET, PLAYER))!;
    expect(openSteamId(SECRET, sealed.steam_id_enc as string)).toBe(PLAYER);
    expect(openSteamId('z'.repeat(64), sealed.steam_id_enc as string)).toBeNull();
  });

  it('refuses a callback whose state does not match', async () => {
    const cb = await app.inject({ url: '/api/member/callback?state=aaaaaaaaaaaa' });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain('/report?error=');
    expect(cb.cookies.find((c) => c.name === memberCookie)).toBeUndefined();
  });

  it('never lets a player session into the panel, nor the panel act as a player', async () => {
    const r = await app.inject({ url: '/api/admin/stats', headers: as('player') });
    expect(r.statusCode).toBe(401);
    const me = await app.inject({ url: '/api/auth/me', headers: as('player') });
    expect(me.json()).toEqual({ authenticated: false, admin: false });
    const asMember = await app.inject({
      method: 'POST',
      url: '/api/member/reports',
      headers: asAdmin(),
      payload: { category: 'other', title: 'x x x', body: 'y' },
    });
    expect(asMember.statusCode).toBe(401);
  });
});

describe('filing reports', () => {
  let publicId = '';

  it('files an anonymous report that stores no identity', async () => {
    const r = await file('player', {
      category: 'cheating',
      title: 'Impossible strafes on arcane',
      body: 'Watch [[run:5]] at 0:12.',
      subjectKind: 'user',
      subjectId: 103,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ status: 'open', identified: false });
    publicId = r.json().data.publicId;
    expect(publicId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const rows = (await execRows(t.db, sql`select * from reports`)) as unknown as Record<
      string,
      unknown
    >[];
    expect(rows[0]!.reporter_steam_id).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(PLAYER);
  });

  it('needs the CSRF token and this site as Origin', async () => {
    const payload = { category: 'other', title: 'abc', body: 'x' };
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/member/reports',
      headers: { cookie: `${memberCookie}=${tokens.player!.token}`, origin: ORIGIN },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/member/reports',
      headers: as('player', { origin: 'https://evil.example' }),
      payload,
    });
    expect(evil.statusCode).toBe(403);
  });

  it('keeps anonymous reports to players with enough maps and no ban', async () => {
    const low = await file('newbie', { category: 'cheating', title: 'abc', body: 'x' });
    expect(low.statusCode).toBe(403);
    expect(low.json().message).toContain('10 completed maps');
    const banned = await file('banned', { category: 'other', title: 'abc', body: 'x' });
    expect(banned.statusCode).toBe(403);
    const stranger = await file('stranger', { category: 'privacy', title: 'abc', body: 'x' });
    expect(stranger.statusCode).toBe(403);
  });

  it('lets anyone in the archive sign a request about themselves, and stores who', async () => {
    const r = await file('newbie', {
      category: 'privacy',
      title: 'Please hide my bio and avatar',
      body: 'Thanks.',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.identified).toBe(true);
    const reply = await file('banned', {
      category: 'about_me',
      title: 'About the case on me',
      body: 'My side.',
    });
    expect(reply.statusCode).toBe(200);
  });

  it('caps new reports per day', async () => {
    for (let i = 0; i < 2; i++)
      expect(
        (await file('player', { category: 'other', title: `n ${i}x`, body: 'x' })).statusCode,
      ).toBe(200);
    const fourth = await file('player', { category: 'other', title: 'one more', body: 'x' });
    expect(fourth.statusCode).toBe(429);
  });

  it('shows a player only their own reports', async () => {
    const mine = await app.inject({ url: '/api/member/reports', headers: as('player') });
    expect(mine.json().data).toHaveLength(3);
    const other = await app.inject({
      url: `/api/member/reports/${publicId}`,
      headers: as('newbie'),
    });
    expect(other.statusCode).toBe(404);
    const write = await app.inject({
      method: 'POST',
      url: `/api/member/reports/${publicId}/messages`,
      headers: as('newbie'),
      payload: { body: 'hijack' },
    });
    expect(write.statusCode).toBe(404);
  });

  it('shows the owner a code for anonymous reporters and a name for signed ones', async () => {
    const r = await app.inject({ url: '/api/admin/reports', headers: asAdmin() });
    expect(r.statusCode).toBe(200);
    const list = r.json().data as {
      category: string;
      reporter: { code: string; steamId: string | null; alias: string | null };
    }[];
    const anon = list.find((x) => x.category === 'cheating')!;
    expect(anon.reporter).toMatchObject({
      code: memberCode(memberKey(SECRET, PLAYER)),
      steamId: null,
      alias: null,
    });
    expect(
      JSON.stringify(list.filter((x) => x.category !== 'privacy' && x.category !== 'about_me')),
    ).not.toContain(PLAYER);
    const signed = list.find((x) => x.category === 'privacy')!;
    expect(signed.reporter).toMatchObject({ steamId: NEWBIE, alias: 'newbie' });
    expect(r.json().counts.unread).toBe(5);
  });

  it('carries a conversation where the owner is only ever "Admin"', async () => {
    const list = (await app.inject({ url: '/api/admin/reports', headers: asAdmin() })).json()
      .data as { id: number; publicId: string }[];
    const id = list.find((x) => x.publicId === publicId)!.id;
    const thread = await app.inject({ url: `/api/admin/reports/${id}`, headers: asAdmin() });
    expect(thread.json().data.subjectLabel).toBe('caught');
    const reply = await app.inject({
      method: 'POST',
      url: `/api/admin/reports/${id}/messages`,
      headers: asAdmin(),
      payload: { body: 'Thanks, looking at the replay.' },
    });
    expect(reply.statusCode).toBe(200);
    const mine = (await app.inject({ url: '/api/member/me', headers: as('player') })).json();
    expect(mine.unread).toBe(1);
    const seen = await app.inject({
      url: `/api/member/reports/${publicId}`,
      headers: as('player'),
    });
    const data = seen.json().data;
    expect(data.status).toBe('answered');
    expect(data.messages.map((m: { author: string }) => m.author)).toEqual(['you', 'admin']);
    expect(seen.body).not.toContain(OWNER);
    expect((await app.inject({ url: '/api/member/me', headers: as('player') })).json().unread).toBe(
      0,
    );
    const answer = await app.inject({
      method: 'POST',
      url: `/api/member/reports/${publicId}/messages`,
      headers: as('player'),
      payload: { body: 'Also 0:40.' },
    });
    expect(answer.statusCode).toBe(200);
    const audit = (await app.inject({ url: '/api/admin/audit', headers: asAdmin() })).json()
      .data as {
      action: string;
      details: unknown;
    }[];
    const row = audit.find((a) => a.action === 'report.reply')!;
    expect(JSON.stringify(row)).not.toContain(PLAYER);
  });

  it('closes reports, and a closed report takes no more messages', async () => {
    const close = await app.inject({
      method: 'POST',
      url: `/api/member/reports/${publicId}/close`,
      headers: as('player'),
    });
    expect(close.statusCode).toBe(200);
    const late = await app.inject({
      method: 'POST',
      url: `/api/member/reports/${publicId}/messages`,
      headers: as('player'),
      payload: { body: 'one more thing' },
    });
    expect(late.statusCode).toBe(409);
  });

  it('blocks a reporter by code without learning who they are', async () => {
    const key = memberKey(SECRET, BANNED);
    const b = await app.inject({
      method: 'POST',
      url: `/api/admin/members/${key}/block`,
      headers: asAdmin(),
      payload: { blocked: true, note: 'spam' },
    });
    expect(b.statusCode).toBe(200);
    const me = (await app.inject({ url: '/api/member/me', headers: as('banned') })).json();
    expect(me.canReport).toEqual({ anonymous: false, identified: false });
    const r = await file('banned', { category: 'about_me', title: 'again', body: 'x' });
    expect(r.statusCode).toBe(403);
  });
});

describe('privacy requests', () => {
  it('hides bio, socials and avatar from the profile and the avatar from everywhere', async () => {
    const before = (await app.inject({ url: '/api/users/102' })).json();
    expect(before.bio).toBe('my bio');
    expect((await app.inject({ url: `/api/avatars/${AVATAR}` })).statusCode).toBe(200);
    const set = await app.inject({
      method: 'PUT',
      url: '/api/admin/privacy/102',
      headers: asAdmin(),
      payload: { hideBio: true, hideSocials: true, hideAvatars: true, note: 'asked in a report' },
    });
    expect(set.statusCode).toBe(200);
    const after = (await app.inject({ url: '/api/users/102' })).json();
    expect(after).toMatchObject({
      bio: null,
      socials: {},
      avatarHash: null,
      privacy: { bio: true, socials: true, avatars: true },
    });
    expect((await app.inject({ url: `/api/avatars/${AVATAR}` })).statusCode).toBe(404);
    const undo = await app.inject({
      method: 'PUT',
      url: '/api/admin/privacy/102',
      headers: asAdmin(),
      payload: { hideBio: false, hideSocials: false, hideAvatars: false },
    });
    expect(undo.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/users/102' })).json().bio).toBe('my bio');
  });
});

describe('the request log', () => {
  it('never records a request to /api/member/', async () => {
    await app.close();
    closed = true;
    const rows = (await execRows(t.db, sql`select path from request_log`)) as unknown as {
      path: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.path.startsWith('/api/member/'))).toEqual([]);
    expect(rows.some((r) => r.path.startsWith('/api/admin/'))).toBe(true);
  });
});
