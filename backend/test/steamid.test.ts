import { describe, expect, it } from 'vitest';
import {
  avatarHashFromUrl,
  parseSteamId,
  steamId64ToSteam2,
  steamId64ToSteam3,
} from '../src/momentum/steamid.js';

describe('steam ids', () => {
  const id64 = '76561198885632335';
  it('converts between formats', () => {
    expect(steamId64ToSteam3(id64)).toBe('[U:1:925366607]');
    expect(steamId64ToSteam2(id64)).toBe('STEAM_0:1:462683303');
    expect(parseSteamId('[U:1:925366607]')).toBe(id64);
    expect(parseSteamId('U:1:925366607')).toBe(id64);
    expect(parseSteamId('STEAM_0:1:462683303')).toBe(id64);
    expect(parseSteamId('STEAM_1:1:462683303')).toBe(id64);
    expect(parseSteamId(id64)).toBe(id64);
    expect(parseSteamId('mochinushi')).toBeNull();
    expect(parseSteamId('12345')).toBeNull();
  });
  it('extracts avatar hashes', () => {
    expect(
      avatarHashFromUrl(
        'https://avatars.cloudflare.steamstatic.com/b9e26d994e1910f716f3d604e9c76c39cbd994ad_full.jpg',
      ),
    ).toBe('b9e26d994e1910f716f3d604e9c76c39cbd994ad');
    expect(
      avatarHashFromUrl(
        'https://avatars.steamstatic.com/B9E26D994E1910F716F3D604E9C76C39CBD994AD.jpg',
      ),
    ).toBe('b9e26d994e1910f716f3d604e9c76c39cbd994ad');
    expect(avatarHashFromUrl(null)).toBeNull();
    expect(avatarHashFromUrl('https://example.com/x.jpg')).toBeNull();
  });
});
