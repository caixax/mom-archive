// Display helpers. Names mirror backend/src/momentum/enums.ts.

export const GAMEMODES: Record<number, string> = {
  1: 'Surf',
  2: 'Bhop',
  3: 'Bhop HL1',
  4: 'Climb (Momentum)',
  5: 'Climb (KZT)',
  6: 'Climb (1.6)',
  7: 'Rocket Jump',
  8: 'Sticky Jump',
  9: 'Ahop',
  10: 'Conc',
  11: 'Defrag CPM',
  12: 'Defrag VQ3',
  13: 'Defrag VTG',
};

export const STYLES: Record<number, string> = {
  0: 'Normal',
  1: 'Half-Sideways',
  2: 'Half-Sideways',
  3: 'Sideways',
  4: 'W-Only',
  5: 'A/D-Only',
  6: 'S-Only',
  7: 'Backwards',
  8: 'Pro',
  9: 'Teleport',
};

export const TRACK_TYPES: Record<number, string> = { 0: 'Main', 1: 'Stage', 2: 'Bonus' };
export const MAP_STATUS: Record<number, string> = {
  0: 'Approved',
  1: 'Private testing',
  2: 'Content approval',
  3: 'Public testing',
  4: 'Final approval',
  5: 'Disabled',
};
export const LB_TYPES: Record<number, string> = {
  0: 'Ranked',
  1: 'Unranked',
  2: 'Hidden',
  3: 'In submission',
};
export const ACTIVITY: Record<number, string> = {
  1: 'Map uploaded',
  2: 'Map approved',
  3: 'Review made',
  4: 'PB achieved',
  5: 'WR achieved',
  6: 'Report filed',
  7: 'User joined',
};
export const ROLES: Record<number, string> = {
  1: 'Admin',
  2: 'Moderator',
  4: 'Verified',
  8: 'Placeholder',
  16: 'Deleted',
  32: 'Reviewer',
  64: 'Mapper',
  128: 'Porter',
  256: 'Limited',
};
export const BANS: Record<number, string> = {
  1: 'Leaderboards',
  2: 'Alias',
  4: 'Avatar',
  8: 'Bio',
  16: 'Map submission',
};

export const gamemodeName = (g: number | null | undefined): string =>
  g == null ? '?' : (GAMEMODES[g] ?? `Gamemode ${g}`);
export const styleName = (s: number | null | undefined): string =>
  s == null ? '?' : (STYLES[s] ?? `Style ${s}`);
export const trackName = (tt: number, tn: number): string =>
  tt === 0 ? 'Main' : `${TRACK_TYPES[tt] ?? 'Track'} ${tn}`;
export const statusName = (s: number | null | undefined): string =>
  s == null ? '?' : (MAP_STATUS[s] ?? `Status ${s}`);
export const lbTypeName = (t: number | null | undefined): string =>
  t == null ? '?' : (LB_TYPES[t] ?? `Type ${t}`);

export function flagNames(
  value: number | null | undefined,
  names: Record<number, string>,
): string[] {
  if (!value) return [];
  return Object.entries(names)
    .filter(([bit]) => (value & Number(bit)) !== 0)
    .map(([, n]) => n);
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const sec = s.toFixed(3).padStart(6, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC` : date;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const abs = Math.abs(ms);
  const suffix = ms >= 0 ? 'ago' : 'from now';
  const s = Math.round(abs / 1000);
  if (s < 60) return `${s}s ${suffix}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ${suffix}`;
  const d = Math.round(h / 24);
  return `${d}d ${suffix}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatInt(n: number | string | null | undefined): string {
  if (n == null) return '';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString('en-US');
}

/** Allowlisted social links. Anything that does not validate is rendered as text. */
const SOCIALS: Record<string, { host: string; pattern: RegExp }> = {
  Discord: { host: 'https://discordapp.com/users/', pattern: /^[\w.-]{2,32}$/ },
  Twitch: { host: 'https://twitch.tv/', pattern: /^[\w-]{4,25}$/ },
  YouTube: { host: 'https://youtube.com/', pattern: /^@[\w.-]{3,30}$/ },
  Github: { host: 'https://github.com/', pattern: /^[\w-]{2,39}$/ },
  Twitter: { host: 'https://twitter.com/', pattern: /^[\w-]{2,15}$/ },
  Mastodon: { host: 'https://mastodon.social/', pattern: /^(?:@[\w-]+){2}\.[\w-]+$/ },
  LinkedIn: { host: 'https://linkedin.com/in/', pattern: /^[\w-]{3,40}$/ },
  Instagram: { host: 'https://instagram.com/', pattern: /^[\w-]{3,40}$/ },
  Spotify: { host: 'https://open.spotify.com/user/', pattern: /^[\w-]{3,40}$/ },
  Patreon: { host: 'https://patreon.com/', pattern: /^[\w-]{3,40}$/ },
  'Ko-fi': { host: 'https://ko-fi.com/', pattern: /^[\w-]{3,40}$/ },
  Paypal: { host: 'https://paypal.me/', pattern: /^@[\w-]{3,30}$/ },
};

export function socialLink(key: string, value: string): string | null {
  const s = SOCIALS[key];
  if (!s || typeof value !== 'string' || !s.pattern.test(value)) return null;
  const v = key === 'Discord' ? value : key === 'Paypal' ? value.replace(/^@/, '') : value;
  return s.host + encodeURIComponent(v);
}

export function fieldLabel(field: string): string {
  if (field.startsWith('social:')) return `Social ${field.slice(7)}`;
  if (field.startsWith('leaderboard:')) return field;
  if (field.startsWith('sourceban:')) return `SourceBan ${field.slice(10)}`;
  if (field.startsWith('stats.')) return `Stat ${field.slice(6)}`;
  const map: Record<string, string> = {
    alias: 'Alias',
    avatar: 'Avatar',
    avatar_hidden: 'Avatar hidden (ban)',
    country: 'Country',
    roles: 'Roles',
    bans: 'Bans',
    bio: 'Bio',
    cosXP: 'Cosmetic XP',
    level: 'Level',
    mapsCompleted: 'Maps completed',
    runsSubmitted: 'Runs submitted',
    totalJumps: 'Total jumps',
    totalStrafes: 'Total strafes',
    deleted: 'Account visible',
    personaname: 'Steam name',
    avatarhash: 'Steam avatar',
    profileurl: 'Steam profile URL',
    profilestate: 'Steam profile state',
    communityvisibilitystate: 'Steam visibility',
    timecreated: 'Steam account created',
    loccountrycode: 'Steam country',
    vac_banned: 'VAC banned',
    number_of_vac_bans: 'VAC bans',
    number_of_game_bans: 'Game bans',
    community_banned: 'Community banned',
    economy_ban: 'Economy ban',
    status: 'Status',
    name: 'Name',
    currentVersionID: 'Current version',
    description: 'Description',
    leaderboards: 'Leaderboards',
    credits: 'Credits',
    versions: 'Versions',
    images: 'Images',
  };
  return map[field] ?? field;
}

/** Human readable rendering of a change value for roles, bans and status fields. */
export function valueLabel(field: string, value: string | null): string {
  if (value === null) return '(none)';
  if (field === 'roles') return flagNames(Number(value), ROLES).join(', ') || 'none';
  if (field === 'bans') return flagNames(Number(value), BANS).join(', ') || 'none';
  if (field === 'status') return statusName(Number(value));
  if (field === 'timecreated') return formatDate(new Date(Number(value) * 1000).toISOString());
  if (field.startsWith('leaderboard:') && field.endsWith(':type')) return lbTypeName(Number(value));
  if (value.length > 160) return value.slice(0, 157) + '...';
  return value;
}
