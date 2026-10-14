import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getLogger } from '../src/logger.js';
import {
  endpointKey,
  MomApiError,
  MomentumClient,
  RateLimiter,
  type RawSink,
} from '../src/momentum/client.js';
import type { MomLeaderboardRun, MomPastRun, MomUser, Paged } from '../src/momentum/types.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function mockFetch(
  handler: (
    url: string,
    n: number,
  ) => { status: number; body?: string; headers?: Record<string, string> },
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url, calls.length);
    return new Response(r.body ?? '', {
      status: r.status,
      headers: r.headers ?? { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function client(fetchImpl: typeof fetch, rawSink?: RawSink, rps = 100, rpm = 6000): MomentumClient {
  return new MomentumClient({
    baseUrl: 'https://api.momentum-mod.org/v1',
    cdnUrl: 'https://cdn.momentum-mod.org',
    userAgent: 'mom-archive/test',
    rps,
    rpm,
    rawSink,
    logger: getLogger('test'),
    fetchImpl,
  });
}

describe('endpointKey', () => {
  it('collapses ids and uuids', () => {
    expect(endpointKey('/runs')).toBe('runs');
    expect(endpointKey('/maps/2231/leaderboard')).toBe('maps-leaderboard');
    expect(endpointKey('/users/14991')).toBe('users');
    expect(endpointKey('/users/14991/activities')).toBe('users-activities');
  });
});

describe('RateLimiter', () => {
  it('spaces calls to respect the per second bucket', async () => {
    const rl = new RateLimiter(10, 600);
    const t = Date.now();
    for (let i = 0; i < 12; i++) await rl.acquire();
    const elapsed = Date.now() - t;
    // 12 calls at 10 rps with a 10 token burst: at least ~100ms for the two beyond the burst
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

describe('MomentumClient', () => {
  it('parses typed responses and stores raw bodies', async () => {
    const raw: { endpoint: string; size: number }[] = [];
    const sink: RawSink = {
      put: async (endpoint, body) => void raw.push({ endpoint, size: body.length }),
    };
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('/users/14991')) return { status: 200, body: fixture('user-14991.json') };
      if (url.includes('/runs')) return { status: 200, body: fixture('runs-u14991-m2231.json') };
      return { status: 404, body: '{"message":"not found"}' };
    });
    const c = client(fetch, sink);
    const u = await c.getUser(14991);
    expect(u.alias).toContain('mochinushi');
    expect(u.userStats?.runsSubmitted).toBe(941);
    const runs = await c.getRunsPage({ skip: 0, order: 'desc', userID: 14991, mapID: 2231 });
    expect(runs.totalCount).toBe(14);
    const gm3 = runs.data.filter((r) => r.gamemode === 3);
    // user 14991 has 4 gamemode 3 runs on map 2231 and none of them is still on the leaderboard
    expect(gm3.length).toBe(4);
    expect(gm3.every((r) => !r.isPB && !r.leaderboardRun)).toBe(true);
    expect(calls[0]).toContain('expand=profile%2CuserStats');
    expect(calls[1]).toContain('orderBy=createdAt');
    expect(raw.map((r) => r.endpoint)).toEqual(['users', 'runs']);
    expect(c.stats().callsTotal).toBe(2);
    expect(c.stats().lastStatus).toBe(200);
  });

  it('throws MomApiError with status 404 without retrying', async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 404,
      body: '{"message":"User not found"}',
    }));
    const c = client(fetch);
    await expect(c.getUser(99999999)).rejects.toSatisfy(
      (e: unknown) => e instanceof MomApiError && e.status === 404 && e.notFound,
    );
    expect(calls.length).toBe(1);
  });

  it('retries on 429 using retry-after and then succeeds', async () => {
    const { fetch, calls } = mockFetch((_url, n) =>
      n === 1
        ? { status: 429, body: '', headers: { 'retry-after': '0' } }
        : { status: 200, body: fixture('user-14991.json') },
    );
    const c = client(fetch);
    const u = await c.getUser(14991);
    expect(u.id).toBe(14991);
    expect(calls.length).toBe(2);
  });

  it('pages until returnCount < take', async () => {
    const lb = JSON.parse(fixture('lb-2363.json')) as Paged<MomLeaderboardRun>;
    const { fetch, calls } = mockFetch((url) => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      const data = skip === 0 ? [lb.data[0], lb.data[1]] : [lb.data[2]];
      return {
        status: 200,
        body: JSON.stringify({ totalCount: 3, returnCount: data.length, data }),
      };
    });
    const c = client(fetch);
    const all: MomLeaderboardRun[] = [];
    for await (const { page } of c.pages<MomLeaderboardRun>(
      '/maps/2363/leaderboard',
      { gamemode: 3 },
      { take: 2 },
    ))
      all.push(...page.data);
    expect(all.length).toBe(3);
    expect(calls.length).toBe(2);
    expect(all[0]!.rank).toBe(1);
    expect(all[0]!.downloadURL).toBe(
      'https://cdn.momentum-mod.org/runs/e38630bae44dedd6fd92d83a062d794d66e5fe08',
    );
  });

  it('download computes sha1 and reports 404 without throwing', async () => {
    const bytes = Buffer.from('hello replay');
    const { fetch } = mockFetch((url) =>
      url.endsWith('/runs/abc')
        ? {
            status: 200,
            body: bytes.toString(),
            headers: { 'content-type': 'application/octet-stream' },
          }
        : { status: 404 },
    );
    const c = client(fetch);
    const ok = await c.download(c.replayUrl('abc'));
    expect(ok.status).toBe(200);
    expect(ok.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(ok.bytes.equals(bytes)).toBe(true);
    const missing = await c.download(c.replayUrl('nope'));
    expect(missing.status).toBe(404);
    expect(missing.bytes.length).toBe(0);
  });

  it('typed fixture shapes match expectations', () => {
    const page = JSON.parse(fixture('runs-u14991-m2231.json')) as Paged<MomPastRun>;
    const pb = page.data.find((r) => r.leaderboardRun);
    expect(pb?.leaderboardRun?.replayHash).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof pb?.leaderboardRun?.pastRunID).toBe('string');
    const users = JSON.parse(fixture('users-batch.json')) as Paged<MomUser>;
    expect(users.data.every((u) => u.profile && u.userStats)).toBe(true);
  });
});
