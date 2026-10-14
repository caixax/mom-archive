// Copied from momentum-mod/website libs/constants (the package is not published to npm).

export enum Gamemode {
  SURF = 1,
  BHOP = 2,
  BHOP_HL1 = 3,
  CLIMB_MOM = 4,
  CLIMB_KZT = 5,
  CLIMB_16 = 6,
  RJ = 7,
  SJ = 8,
  AHOP = 9,
  CONC = 10,
  DEFRAG_CPM = 11,
  DEFRAG_VQ3 = 12,
  DEFRAG_VTG = 13,
}

export const GamemodeName: Record<number, string> = {
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

export enum Style {
  NORMAL = 0,
  BHOP_HALF_SIDEWAYS = 1,
  SURF_HALF_SIDEWAYS = 2,
  SIDEWAYS = 3,
  W_ONLY = 4,
  AD_ONLY = 5,
  S_ONLY = 6,
  BACKWARDS = 7,
  PRO = 8,
  TELEPORT = 9,
}

export const StyleName: Record<number, string> = {
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

export enum TrackType {
  MAIN = 0,
  STAGE = 1,
  BONUS = 2,
}

export const TrackTypeName: Record<number, string> = { 0: 'Main', 1: 'Stage', 2: 'Bonus' };

export enum Role {
  ADMIN = 1,
  MODERATOR = 2,
  VERIFIED = 4,
  PLACEHOLDER = 8,
  DELETED = 16,
  REVIEWER = 32,
  MAPPER = 64,
  PORTER = 128,
  LIMITED = 256,
}

export const RoleName: Record<number, string> = {
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

export enum Ban {
  LEADERBOARDS = 1,
  ALIAS = 2,
  AVATAR = 4,
  BIO = 8,
  MAP_SUBMISSION = 16,
}

export const BanName: Record<number, string> = {
  1: 'Leaderboards',
  2: 'Alias',
  4: 'Avatar',
  8: 'Bio',
  16: 'Map submission',
};

export enum MapStatus {
  APPROVED = 0,
  PRIVATE_TESTING = 1,
  CONTENT_APPROVAL = 2,
  PUBLIC_TESTING = 3,
  FINAL_APPROVAL = 4,
  DISABLED = 5,
}

export const MapStatusName: Record<number, string> = {
  0: 'Approved',
  1: 'Private testing',
  2: 'Content approval',
  3: 'Public testing',
  4: 'Final approval',
  5: 'Disabled',
};

export enum LeaderboardType {
  RANKED = 0,
  UNRANKED = 1,
  HIDDEN = 2,
  IN_SUBMISSION = 3,
}

export const LeaderboardTypeName: Record<number, string> = {
  0: 'Ranked',
  1: 'Unranked',
  2: 'Hidden',
  3: 'In submission',
};

export enum ActivityType {
  ALL = 0,
  MAP_UPLOADED = 1,
  MAP_APPROVED = 2,
  REVIEW_MADE = 3,
  PB_ACHIEVED = 4,
  WR_ACHIEVED = 5,
  REPORT_FILED = 6,
  USER_JOINED = 7,
}

export enum MapCreditType {
  AUTHOR = 0,
  CONTRIBUTOR = 1,
  TESTER = 2,
  SPECIAL_THANKS = 3,
}

/** The sha1 Steam uses for every missing avatar. */
export const STEAM_MISSING_AVATAR = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';

export function steamAvatarUrl(hash: string): string {
  return `https://avatars.cloudflare.steamstatic.com/${hash}_full.jpg`;
}

/** Bit flag names for a roles or bans integer. */
export function flagNames(value: number, names: Record<number, string>): string[] {
  const out: string[] = [];
  for (const [bit, name] of Object.entries(names)) {
    if ((value & Number(bit)) !== 0) out.push(name);
  }
  return out;
}

/** Allowlisted hosts per social key. Anything else is rendered as plain text. */
export const SOCIAL_URLS: Record<string, { host: string; pattern: RegExp }> = {
  Discord: { host: 'discordapp.com/users', pattern: /^[\w.-]{2,32}$/ },
  Twitch: { host: 'twitch.tv', pattern: /^[\w-]{4,25}$/ },
  YouTube: { host: 'youtube.com', pattern: /^@[\w.-]{3,30}$/ },
  Github: { host: 'github.com', pattern: /^[\w-]{2,39}$/ },
  Twitter: { host: 'twitter.com', pattern: /^[\w-]{2,15}$/ },
  Mastodon: { host: 'mastodon.social', pattern: /^(?:@[\w-]+){2}\.[\w-]+$/ },
  LinkedIn: { host: 'linkedin.com/in', pattern: /^[\w-]{3,40}$/ },
  Instagram: { host: 'instagram.com', pattern: /^[\w-]{3,40}$/ },
  Spotify: { host: 'open.spotify.com/user', pattern: /^[\w-]{3,40}$/ },
  Patreon: { host: 'patreon.com', pattern: /^[\w-]{3,40}$/ },
  'Ko-fi': { host: 'ko-fi.com', pattern: /^[\w-]{3,40}$/ },
  Paypal: { host: 'paypal.me', pattern: /^@[\w-]{3,30}$/ },
};
