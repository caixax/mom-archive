// Opt-in checks against the real Momentum API and CDN. Run with LIVE_TESTS=1.
// Nothing is written anywhere; replay bytes stay in memory.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getLogger } from '../src/logger.js';
import { MomentumClient } from '../src/momentum/client.js';
import { readHeader, checkHeader } from '../src/momentum/replay-header.js';

const live = process.env.LIVE_TESTS === '1';

describe.skipIf(!live)('live momentum api', () => {
  const c = new MomentumClient({
    baseUrl: 'https://api.momentum-mod.org/v1',
    cdnUrl: 'https://cdn.momentum-mod.org',
    userAgent: 'mom-archive/test (+https://momarchive.caixa.cc)',
    rps: 5,
    rpm: 100,
    logger: getLogger('live'),
  });

  it('user 14991, map 2231 and the removed-run case', async () => {
    const u = await c.getUser(14991);
    expect(u.steamID).toBe('76561198885632335');
    expect(u.profile).toBeTruthy();
    const m = await c.getMap(2231);
    expect(m.name).toBe('df_biotrix-omega');
    expect(m.leaderboards?.length).toBeGreaterThan(0);
    const runs = await c.getRunsPage({ skip: 0, order: 'desc', userID: 14991, mapID: 2231 });
    expect(runs.totalCount).toBeGreaterThanOrEqual(14);
    const gm3 = runs.data.filter((r) => r.gamemode === 3);
    expect(gm3.length).toBeGreaterThanOrEqual(4);
  });

  it('the global runs feed ignores the gamemode filter (documented quirk)', async () => {
    const page = await c.getRunsPage({ skip: 0, order: 'desc', gamemode: 3, take: 20 });
    expect(page.data.length).toBe(20);
    // not asserting that other gamemodes appear (they usually do); only that the call works
    expect(page.totalCount).toBeGreaterThan(1_000_000);
  });

  it('downloads a current PB replay, verifies sha1 and parses its header', async () => {
    const key = { mapId: 2363, gamemode: 3, trackType: 0, trackNum: 1, style: 0 };
    const lb = await c.getLeaderboardPage(key, 0, 1);
    const top = lb.data[0];
    expect(top?.replayHash).toMatch(/^[0-9a-f]{40}$/);
    const dl = await c.download(c.replayUrl(top!.replayHash!));
    expect(dl.status).toBe(200);
    expect(createHash('sha1').update(dl.bytes).digest('hex')).toBe(top!.replayHash);
    const h = readHeader(dl.bytes);
    expect(h.gamemode).toBe(3);
    expect(h.mapName.toLowerCase()).toBe('bhop_cooksassistant');
    expect(h.playerSteamID).toBe(top!.user?.steamID);
    expect(
      checkHeader(h, {
        gamemode: 3,
        trackType: 0,
        trackNum: 1,
        style: 0,
        runTime: top!.time,
        steamId: top!.user?.steamID,
        mapName: 'bhop_cooksassistant',
      }),
    ).toEqual([]);
  });
});
