import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execRows } from '../src/db/index.js';
import type {
  MomFollow,
  MomLeaderboardRun,
  MomMap,
  MomPastRun,
  MomUser,
  Paged,
} from '../src/momentum/types.js';
import {
  observeFollows,
  observeLeaderboard,
  observeMap,
  observeRun,
  observeUser,
} from '../src/poller/observe.js';
import {
  claimRefresh,
  claimReplays,
  enqueueRefresh,
  enqueueReplay,
  refreshQueueDepth,
} from '../src/poller/queue.js';
import { createTestDb, type TestDb } from './db-helper.js';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('observeUser', () => {
  it('first observation creates the row and a snapshot but no field changes', async () => {
    const u = fixture<MomUser>('user-14991.json');
    const at = new Date('2026-10-14T10:00:00Z');
    const r = await observeUser(t.db, u, at);
    expect(r.isNew).toBe(true);
    expect(r.changes).toEqual([]);
    const changes = await execRows(
      t.db,
      sql`select * from user_field_changes where user_id = 14991`,
    );
    expect(changes.length).toBe(0);
    const snaps = await execRows(t.db, sql`select * from user_snapshots where user_id = 14991`);
    expect(snaps.length).toBe(1);
    const names = await execRows<{ name: string; source: string }>(
      t.db,
      sql`select name, source from steam_name_history where steam_id = ${u.steamID}`,
    );
    expect(names).toEqual([{ name: u.alias, source: 'momentum' }]);
    const avatars = await execRows(
      t.db,
      sql`select avatar_hash from steam_avatar_history where steam_id = ${u.steamID}`,
    );
    expect(avatars.length).toBe(1);
  });

  it('an alias change tomorrow produces exactly one change row and keeps the old alias searchable', async () => {
    const u = fixture<MomUser>('user-14991.json');
    const at = new Date('2026-10-15T10:00:00Z');
    const r = await observeUser(t.db, { ...u, alias: 'mochinushi' }, at);
    expect(r.isNew).toBe(false);
    expect(r.changes).toEqual([{ field: 'alias', oldValue: u.alias, newValue: 'mochinushi' }]);
    const changes = await execRows<{ field: string; old_value: string; new_value: string }>(
      t.db,
      sql`select field, old_value, new_value from user_field_changes where user_id = 14991`,
    );
    expect(changes).toEqual([{ field: 'alias', old_value: u.alias, new_value: 'mochinushi' }]);
    const snaps = await execRows(t.db, sql`select * from user_snapshots where user_id = 14991`);
    expect(snaps.length).toBe(2);
    const names = await execRows<{ name: string }>(
      t.db,
      sql`select name from steam_name_history where steam_id = ${u.steamID} order by first_seen`,
    );
    expect(names.map((n) => n.name)).toEqual([u.alias, 'mochinushi']);
    // identical observation again: nothing new
    const again = await observeUser(
      t.db,
      { ...u, alias: 'mochinushi' },
      new Date('2026-10-16T10:00:00Z'),
    );
    expect(again.changes).toEqual([]);
    expect(
      (await execRows(t.db, sql`select * from user_snapshots where user_id = 14991`)).length,
    ).toBe(2);
  });

  it('a summary observation (embedded in a run) does not wipe profile fields', async () => {
    const u = fixture<MomUser>('user-14991.json');
    const summary: MomUser = {
      id: u.id,
      steamID: u.steamID,
      alias: 'mochinushi',
      country: 'ES',
      roles: 0,
      bans: 0,
      createdAt: u.createdAt,
      avatarURL: u.avatarURL,
    };
    const r = await observeUser(t.db, summary, new Date('2026-10-17T10:00:00Z'));
    expect(r.changes).toEqual([{ field: 'country', oldValue: null, newValue: 'ES' }]);
    const [row] = await execRows<{ runs_submitted: number; profile_fetched: boolean }>(
      t.db,
      sql`select runs_submitted, profile_fetched from users where id = 14991`,
    );
    expect(row?.runs_submitted).toBe(941);
    expect(row?.profile_fetched).toBe(true);
  });

  it('records a ban as its own change and flags the placeholder avatar', async () => {
    const u = fixture<MomUser>('user-14991.json');
    const banned: MomUser = {
      ...u,
      alias: 'mochinushi',
      country: 'ES',
      bans: 4,
      avatarURL:
        'https://avatars.cloudflare.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
    };
    const r = await observeUser(t.db, banned, new Date('2026-10-18T10:00:00Z'));
    const fields = r.changes.map((c) => c.field).sort();
    expect(fields).toEqual(['avatar', 'avatar_hidden', 'bans']);
    // the placeholder hash is never stored as an avatar the user had
    const avatars = await execRows<{ avatar_hash: string }>(
      t.db,
      sql`select avatar_hash from steam_avatar_history where steam_id = ${u.steamID}`,
    );
    expect(avatars.map((a) => a.avatar_hash)).not.toContain(
      'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb',
    );
  });
});

describe('observeMap', () => {
  it('stores versions, images, credits, leaderboards and diffs status', async () => {
    const m = fixture<MomMap>('map-2231.json');
    const r = await observeMap(t.db, m, new Date('2026-10-14T10:00:00Z'), [3]);
    expect(r.isNew).toBe(true);
    expect(r.newVersionIds.length).toBe(2);
    expect(r.newImageIds.length).toBe(3);
    const [row] = await execRows<{
      archived: boolean;
      native_gamemodes: number[];
      status: number;
      detail_fetched: boolean;
    }>(
      t.db,
      sql`select archived, native_gamemodes, status, detail_fetched from maps where id = 2231`,
    );
    expect(row?.status).toBe(3);
    expect(row?.detail_fetched).toBe(true);
    expect(row?.native_gamemodes).toContain(1);
    const lbs = await execRows(t.db, sql`select * from leaderboards where map_id = 2231`);
    expect(lbs.length).toBe(m.leaderboards!.length);

    const r2 = await observeMap(t.db, { ...m, status: 0 }, new Date('2026-10-15T10:00:00Z'), [3]);
    expect(r2.changes.map((c) => c.field)).toEqual(['status']);
    const changes = await execRows<{ field: string; old_value: string; new_value: string }>(
      t.db,
      sql`select field, old_value, new_value from map_field_changes where map_id = 2231`,
    );
    expect(changes).toEqual([{ field: 'status', old_value: '3', new_value: '0' }]);
  });

  it('partial map summaries (from runs) do not erase detail fields', async () => {
    const m = fixture<MomMap>('map-2231.json');
    const summary: MomMap = {
      id: m.id,
      name: m.name,
      status: 0,
      submitterID: m.submitterID,
      currentVersionID: m.currentVersionID,
      images: m.images,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
    const r = await observeMap(t.db, summary, new Date('2026-10-16T10:00:00Z'), [3]);
    expect(r.changes).toEqual([]);
    const [row] = await execRows<{ description: string; stats_completions: number }>(
      t.db,
      sql`select description, stats_completions from maps where id = 2231`,
    );
    expect(row?.description).toBe('short but fun');
    expect(row?.stats_completions).toBe(1607);
  });
});

describe('observeRun and leaderboards', () => {
  const page = fixture<Paged<MomPastRun>>('runs-u14991-m2231.json');

  it('stores runs with the identity observed at the time', async () => {
    const at = new Date('2026-10-14T11:00:00Z');
    let fresh = 0;
    for (const r of page.data) {
      if (
        await observeRun(t.db, r, at, {
          alias: r.user!.alias,
          avatarHash: 'b9e26d994e1910f716f3d604e9c76c39cbd994ad',
          steamName: null,
        })
      )
        fresh += 1;
    }
    expect(fresh).toBe(14);
    const again = await observeRun(t.db, page.data[0]!, new Date('2026-10-15T11:00:00Z'), {
      alias: 'renamed',
      avatarHash: null,
      steamName: null,
    });
    expect(again).toBe(false);
    const [row] = await execRows<{
      observed_alias: string;
      first_seen_at: Date;
      last_seen_at: Date;
    }>(
      t.db,
      sql`select observed_alias, first_seen_at, last_seen_at from runs where id = ${page.data[0]!.id}`,
    );
    expect(row?.observed_alias).toContain('mochinushi');
    expect(new Date(row!.last_seen_at).getTime()).toBeGreaterThan(
      new Date(row!.first_seen_at).getTime(),
    );
    const [u] = await execRows<{ last_run_at: Date }>(
      t.db,
      sql`select last_run_at from users where id = 14991`,
    );
    expect(new Date(u!.last_run_at).toISOString()).toBe('2026-10-12T13:37:48.699Z');
  });

  it('leaderboard observations detect removals and reconstruct the board as of a date', async () => {
    const lb = fixture<Paged<MomLeaderboardRun>>('lb-2363.json');
    const key = { mapId: 2363, gamemode: 3, trackType: 0, trackNum: 1, style: 0 };
    const ids = new Map<number, { alias: string | null; avatarHash: string | null }>();
    for (const e of lb.data) ids.set(e.userID, { alias: e.user?.alias ?? null, avatarHash: null });

    const day1 = new Date('2026-10-14T12:00:00Z');
    const r1 = await observeLeaderboard(t.db, key, lb.data, day1, ids);
    expect(r1.added).toBe(3);
    expect(r1.changed).toBe(true);
    expect(r1.newHashes.length).toBe(3);

    // same board the next day: no new observation, last_confirmed_at moves
    const day2 = new Date('2026-10-15T12:00:00Z');
    const r2 = await observeLeaderboard(t.db, key, lb.data, day2, ids);
    expect(r2.changed).toBe(false);
    expect(r2.added + r2.removed + r2.improved).toBe(0);
    const obs = await execRows<{ observed_at: Date; last_confirmed_at: Date }>(
      t.db,
      sql`select observed_at, last_confirmed_at from leaderboard_observations where map_id = 2363 order by observed_at`,
    );
    expect(obs.length).toBe(1);
    expect(new Date(obs[0]!.last_confirmed_at).toISOString()).toBe(day2.toISOString());

    // day 3: rank 2 is gone (admin deletion), rank 3 improved
    const day3 = new Date('2026-10-16T12:00:00Z');
    const improved = {
      ...lb.data[2]!,
      time: lb.data[2]!.time - 1,
      replayHash: 'a'.repeat(40),
      pastRunID: 9999999,
      rank: 2,
    };
    const r3 = await observeLeaderboard(t.db, key, [lb.data[0]!, improved], day3, ids);
    expect(r3.removed).toBe(1);
    expect(r3.improved).toBe(1);
    expect(r3.newHashes).toEqual(['a'.repeat(40)]);
    const removed = await execRows<{ user_id: number; removed_at: Date }>(
      t.db,
      sql`select user_id, removed_at from leaderboard_entries where map_id = 2363 and removed_at is not null`,
    );
    expect(removed.map((r) => r.user_id)).toEqual([lb.data[1]!.userID]);
    const queued = await claimRefresh(t.db, 10, ['run-verify']);
    expect(queued.map((q) => q.key)).toEqual([String(lb.data[1]!.pastRunID)]);

    // identity on the improved entry is the day 3 identity; the untouched entry keeps day 1
    const entries = await execRows<{
      user_id: number;
      observed_alias: string;
      past_run_id: string;
    }>(
      t.db,
      sql`select user_id, observed_alias, past_run_id from leaderboard_entries where map_id = 2363 and removed_at is null order by rank`,
    );
    expect(entries.length).toBe(2);
    expect(Number(entries[1]!.past_run_id)).toBe(9999999);

    // as-of reconstruction: the observation valid on day 2 is the day 1 board
    const atDay2 = await execRows<{ id: number }>(
      t.db,
      sql`select id from leaderboard_observations where map_id = 2363 and observed_at <= ${new Date('2026-10-15T23:00:00Z')} order by observed_at desc limit 1`,
    );
    const snapDay2 = await execRows<{ user_id: number }>(
      t.db,
      sql`select user_id from leaderboard_snapshots where observation_id = ${atDay2[0]!.id} order by rank`,
    );
    expect(snapDay2.map((s) => s.user_id)).toEqual(lb.data.map((e) => e.userID));
    const atDay3 = await execRows<{ id: number; entry_count: number }>(
      t.db,
      sql`select id, entry_count from leaderboard_observations where map_id = 2363 and observed_at <= ${day3} order by observed_at desc limit 1`,
    );
    expect(atDay3[0]!.entry_count).toBe(2);
  });

  it('replay queue dedupes against archived replays and claims pending jobs', async () => {
    const job = {
      sha1: 'b'.repeat(40),
      pastRunId: 1,
      userId: 4558,
      mapId: 2363,
      mapName: 'bhop_cooksassistant',
      gamemode: 3,
      trackType: 0,
      trackNum: 1,
      style: 0,
      runTime: 26.7,
      steamId: '1',
      observedAlias: 'Gman',
      observedAvatarHash: null,
      observedSteamName: null,
    };
    expect(await enqueueReplay(t.db, job)).toBe(true);
    expect(await enqueueReplay(t.db, job)).toBe(false);
    expect(await enqueueReplay(t.db, { ...job, sha1: 'not-a-sha' })).toBe(false);
    const claimed = await claimReplays(t.db, 10);
    expect(claimed.map((c) => c.sha1)).toContain('b'.repeat(40));
    const second = await claimReplays(t.db, 10);
    expect(second.find((c) => c.sha1 === 'b'.repeat(40))).toBeUndefined();
  });

  it('refresh queue keeps the best priority per key', async () => {
    await enqueueRefresh(t.db, 'user', 1, 5);
    await enqueueRefresh(t.db, 'user', 1, 1);
    await enqueueRefresh(t.db, 'user', 2, 8);
    const depth = await refreshQueueDepth(t.db);
    expect(depth.user).toBe(2);
    const items = await claimRefresh(t.db, 1, ['user']);
    expect(items[0]?.key).toBe('1');
    expect(items[0]?.priority).toBe(1);
  });
});

describe('observeFollows', () => {
  it('first fetch stores follows silently, later diffs emit events', async () => {
    const followers = fixture<Paged<MomFollow>>('followers-14991.json').data;
    const following = fixture<Paged<MomFollow>>('follows-14991.json').data;
    const r1 = await observeFollows(
      t.db,
      14991,
      followers,
      following,
      new Date('2026-10-14T13:00:00Z'),
    );
    expect(r1).toEqual({ followed: 0, unfollowed: 0 });
    expect(
      (
        await execRows(
          t.db,
          sql`select * from follows where followed_id = 14991 and removed_at is null`,
        )
      ).length,
    ).toBe(3);
    expect((await execRows(t.db, sql`select * from follow_events`)).length).toBe(0);

    const r2 = await observeFollows(
      t.db,
      14991,
      followers.slice(1),
      [],
      new Date('2026-10-15T13:00:00Z'),
    );
    expect(r2).toEqual({ followed: 0, unfollowed: 2 });
    const events = await execRows<{ event: string; follower_id: number; followed_id: number }>(
      t.db,
      sql`select event, follower_id, followed_id from follow_events order by id`,
    );
    expect(events.length).toBe(2);
    expect(events.every((e) => e.event === 'unfollowed')).toBe(true);
    expect(events.some((e) => e.follower_id === 14991 && e.followed_id === 15599)).toBe(true);
  });
});

describe('search index', () => {
  it('refreshes and finds users by past alias', async () => {
    await execRows(t.db, sql`refresh materialized view search_index`);
    const rows = await execRows<{ entity_id: number; source: string; text: string }>(
      t.db,
      sql`select entity_id, source, text from search_index where kind = 'user' and text ilike '%TERRIER%' order by source`,
    );
    expect(rows.some((r) => r.entity_id === 14991 && r.source === 'past_alias')).toBe(true);
    const maps = await execRows<{ text: string }>(
      t.db,
      sql`select text from search_index where kind = 'map' and text ilike '%biotrix%'`,
    );
    expect(maps.map((m) => m.text)).toEqual(['df_biotrix-omega']);
  });
});
