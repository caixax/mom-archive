// Where the game's own files are, when this server has them: the materials and
// models Momentum ships and the Half-Life 2 archive it mounts, which fill in
// whatever a map does not pack. A server without them answers the probe with a
// 404 (or, before nginx knows the path, with the page itself), and those
// surfaces draw as flat colours instead.
//
// Asked once per page load and remembered, since both the watch page and an
// opened leaderboard row want the answer.

export interface GameAssets {
  assetsBaseUrl: string[];
  vpkUrls: string[];
}

let asked: Promise<GameAssets | null> | null = null;

async function probe(): Promise<GameAssets | null> {
  try {
    const res = await fetch('/game/mount/hl2_dir.vpk', { method: 'HEAD' });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || type.includes('text/html')) return null;
  } catch {
    return null;
  }
  return {
    assetsBaseUrl: ['/game/momentum', '/game/platform'],
    vpkUrls: ['/game/mount/hl2_dir.vpk'],
  };
}

export function gameAssets(): Promise<GameAssets | null> {
  asked ??= probe();
  return asked;
}
