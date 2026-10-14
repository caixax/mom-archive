import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MomMap, MomUser } from '../src/momentum/types.js';
import {
  boardHash,
  diffBoards,
  diffFields,
  diffMapFields,
  diffUserFields,
  normalizeMap,
  normalizeUser,
  stableHash,
  stableStringify,
  toText,
  userRowToFields,
} from '../src/poller/diff.js';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

describe('stable hashing', () => {
  it('ignores key order and undefined values', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
  });
  it('toText renders scalars and objects', () => {
    expect(toText(null)).toBeNull();
    expect(toText('x')).toBe('x');
    expect(toText(5)).toBe('5');
    expect(toText(true)).toBe('true');
    expect(toText({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('diffFields', () => {
  it('returns nothing on first observation', () => {
    expect(diffFields(null, { alias: 'x' })).toEqual([]);
  });
  it('only compares present fields', () => {
    const changes = diffFields({ alias: 'a', bio: 'old' }, { alias: 'b', bio: undefined });
    expect(changes).toEqual([{ field: 'alias', oldValue: 'a', newValue: 'b' }]);
  });
});

describe('normalizeUser', () => {
  it('extracts avatar hash and flat fields from the fixture', () => {
    const u = fixture<MomUser>('user-14991.json');
    const obs = normalizeUser(u);
    expect(obs.id).toBe(14991);
    expect(obs.steamId).toBe('76561198885632335');
    expect(obs.avatarHash).toBe('b9e26d994e1910f716f3d604e9c76c39cbd994ad');
    expect(obs.full).toBe(true);
    expect(obs.fields.alias).toBe(u.alias);
    expect(obs.fields.avatar_hidden).toBe(false);
    expect(obs.fields.cosXP).toBe(16679883);
    expect(obs.fields.bio).toBe('');
  });

  it('flags the placeholder avatar when the AVATAR ban bit is set', () => {
    const u = fixture<MomUser>('user-14991.json');
    const banned = {
      ...u,
      bans: 4,
      avatarURL:
        'https://avatars.cloudflare.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
    };
    const obs = normalizeUser(banned);
    expect(obs.fields.avatar_hidden).toBe(true);
    expect(obs.fields.bans).toBe(4);
  });

  it('diffs exactly one row when only the alias changed', () => {
    const u = fixture<MomUser>('user-14991.json');
    const prev = normalizeUser(u).fields;
    const next = normalizeUser({ ...u, alias: 'mochinushi' }).fields;
    const changes = diffUserFields(prev, next);
    expect(changes).toEqual([{ field: 'alias', oldValue: u.alias, newValue: 'mochinushi' }]);
  });

  it('reports removed and added socials as their own fields', () => {
    const u = fixture<MomUser>('user-14991.json');
    const withSocials: MomUser = {
      ...u,
      profile: { bio: 'hi', socials: { Discord: 'abc', Twitch: 'xyz' } },
    };
    const prev = normalizeUser(withSocials).fields;
    const next = normalizeUser({
      ...u,
      profile: { bio: 'hi', socials: { Twitch: 'xyz2', YouTube: '@yt' } },
    }).fields;
    const changes = diffUserFields(prev, next)
      .map((c) => c.field)
      .sort();
    expect(changes).toEqual(['social:Discord', 'social:Twitch', 'social:YouTube']);
    const discord = diffUserFields(
      prev,
      normalizeUser({ ...u, profile: { bio: 'hi', socials: { Twitch: 'xyz' } } }).fields,
    ).find((c) => c.field === 'social:Discord');
    expect(discord).toEqual({ field: 'social:Discord', oldValue: 'abc', newValue: null });
  });

  it('summary observations never touch profile and stats fields', () => {
    const u = fixture<MomUser>('user-14991.json');
    const fullRow = userRowToFields({
      alias: u.alias,
      country: null,
      avatarHash: 'b9e26d994e1910f716f3d604e9c76c39cbd994ad',
      roles: 0,
      bans: 0,
      bio: 'some bio',
      socials: { Discord: 'x' },
      cosXp: 1,
      level: 2,
      mapsCompleted: 3,
      runsSubmitted: 4,
      totalJumps: 5,
      totalStrafes: 6,
      profileFetched: true,
    });
    const summary: MomUser = {
      id: u.id,
      steamID: u.steamID,
      alias: u.alias,
      country: null,
      roles: 0,
      bans: 0,
      createdAt: u.createdAt,
      avatarURL: u.avatarURL,
    };
    expect(diffUserFields(fullRow, normalizeUser(summary).fields)).toEqual([]);
  });
});

describe('normalizeMap', () => {
  it('flattens info, stats, leaderboards, credits and versions', () => {
    const m = fixture<MomMap>('map-2231.json');
    const obs = normalizeMap(m);
    expect(obs.id).toBe(2231);
    expect(obs.full).toBe(true);
    expect(obs.fields.status).toBe(3);
    expect(obs.fields['stats.completions']).toBe(1607);
    expect(obs.fields['leaderboard:1:0:1:0:type']).toBe(3);
    expect((obs.fields.versions as string[]).length).toBe(2);
    expect(obs.imageIds.length).toBe(3);
    expect(obs.thumbnailId).toBe('a08f8b7d-00ca-4934-ba20-b5bda00c012f');
  });

  it('diffs status changes and removed leaderboards', () => {
    const m = fixture<MomMap>('map-2231.json');
    const prev = normalizeMap(m).fields;
    const approved: MomMap = { ...m, status: 0, leaderboards: m.leaderboards!.slice(1) };
    const changes = diffMapFields(prev, normalizeMap(approved).fields);
    const fields = changes.map((c) => c.field);
    expect(fields).toContain('status');
    expect(fields).toContain('leaderboards');
    const removedKey = `${m.leaderboards![0]!.gamemode}:${m.leaderboards![0]!.trackType}:${m.leaderboards![0]!.trackNum}:${m.leaderboards![0]!.style}`;
    expect(fields).toContain(`leaderboard:${removedKey}:type`);
    expect(changes.find((c) => c.field === 'status')).toEqual({
      field: 'status',
      oldValue: '3',
      newValue: '0',
    });
  });
});

describe('boards', () => {
  const a = { userId: 1, time: 10, rank: 1, replayHash: 'aa', pastRunId: 100 };
  const b = { userId: 2, time: 12, rank: 2, replayHash: 'bb', pastRunId: 101 };
  const c = { userId: 3, time: 13, rank: 3, replayHash: 'cc', pastRunId: 102 };

  it('hash is order independent', () => {
    expect(boardHash([a, b, c])).toBe(boardHash([c, a, b]));
    expect(boardHash([a, b])).not.toBe(boardHash([a, b, c]));
  });

  it('detects added, removed and improved entries', () => {
    const b2 = { ...b, time: 11, rank: 2, replayHash: 'bb2', pastRunId: 150 };
    const d = diffBoards(
      [a, b, c],
      [a, b2, { userId: 4, time: 20, rank: 3, replayHash: 'dd', pastRunId: 160 }],
    );
    expect(d.added.map((e) => e.userId)).toEqual([4]);
    expect(d.removed.map((e) => e.userId)).toEqual([3]);
    expect(d.improved.map((e) => e.after.userId)).toEqual([2]);
    expect(d.unchanged).toBe(1);
  });
});
