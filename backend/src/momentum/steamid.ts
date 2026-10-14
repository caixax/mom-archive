// SteamID64 <-> SteamID3 <-> SteamID2 conversions, and avatar hash extraction.

const BASE = 76561197960265728n;

export function isSteamId64(s: string): boolean {
  return /^7656119\d{10}$/.test(s);
}

export function steamId64ToAccountId(id64: string): number {
  return Number(BigInt(id64) - BASE);
}

export function steamId64ToSteam3(id64: string): string {
  return `[U:1:${steamId64ToAccountId(id64)}]`;
}

export function steamId64ToSteam2(id64: string): string {
  const acc = steamId64ToAccountId(id64);
  return `STEAM_0:${acc % 2}:${Math.floor(acc / 2)}`;
}

/** Accepts SteamID64, SteamID3 ("[U:1:123]" or "U:1:123") or SteamID2 ("STEAM_0:1:123"). */
export function parseSteamId(input: string): string | null {
  const s = input.trim();
  if (isSteamId64(s)) return s;
  const m3 = /^\[?U:1:(\d{1,10})\]?$/i.exec(s);
  if (m3) return (BigInt(m3[1]!) + BASE).toString();
  const m2 = /^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(s);
  if (m2) return (BigInt(m2[2]!) * 2n + BigInt(m2[1]!) + BASE).toString();
  return null;
}

/** Extracts the avatar hash from a Steam avatar URL. */
export function avatarHashFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/([0-9a-f]{40})(?:_full|_medium)?\.jpg/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}
