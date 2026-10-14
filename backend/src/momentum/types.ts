// Typed shapes of the Momentum Mod public API responses, as observed on the live API.

export interface Paged<T> {
  totalCount: number;
  returnCount: number;
  data: T[];
}

export interface MomUserSummary {
  id: number;
  steamID: string;
  alias: string;
  country: string | null;
  roles: number;
  bans: number;
  createdAt: string;
  avatarURL: string;
  profile?: MomProfile;
  userStats?: MomUserStats;
}

export interface MomProfile {
  userID?: number;
  bio: string;
  socials: Record<string, string> | null;
}

export interface MomUserStats {
  cosXP: number;
  level: number;
  mapsCompleted: number;
  runsSubmitted: number;
  totalJumps: number;
  totalStrafes: number;
}

export type MomUser = MomUserSummary;

export interface MomMapImage {
  id: string;
  small: string;
  medium: string;
  large: string;
  xl: string;
}

export interface MomMapInfo {
  description: string;
  youtubeID: string | null;
  creationDate: string | null;
  approvedDate: string | null;
  requiredGames: number[];
}

export interface MomMapStats {
  reviews: number;
  subscriptions: number;
  plays: number;
  favorites: number;
  completions: number;
  uniqueCompletions: number;
  timePlayed: number;
}

export interface MomLeaderboard {
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
  tier: number | null;
  tags: number[];
  type: number;
  linear: boolean;
}

export interface MomMapVersion {
  id: string;
  versionNum: number;
  changelog: string;
  bspHash: string;
  zoneHash: string;
  submitterID: number;
  submitter?: MomUserSummary;
  createdAt: string;
  downloadURL: string;
}

export interface MomMapCredit {
  type: number;
  description: string | null;
  userID: number;
  user?: MomUserSummary;
}

export interface MomMap {
  id: number;
  name: string;
  status: number;
  submitterID: number;
  currentVersionID: string | null;
  images: MomMapImage[];
  thumbnail?: MomMapImage | null;
  createdAt: string;
  updatedAt: string;
  info?: MomMapInfo;
  stats?: MomMapStats;
  leaderboards?: MomLeaderboard[];
  currentVersion?: MomMapVersion | null;
  versions?: MomMapVersion[];
  credits?: MomMapCredit[];
  submitter?: MomUserSummary;
}

export interface MomLeaderboardRun {
  userID: number;
  mapID: number;
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
  time: number;
  replayHash: string | null;
  downloadURL?: string;
  flags: number[] | null;
  rank?: number;
  pastRunID: number | string;
  createdAt: string;
  splits?: unknown;
  user?: MomUserSummary;
}

export interface MomPastRun {
  id: number;
  userID: number;
  mapID: number;
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
  time: number;
  flags: number[];
  isPB: boolean;
  createdAt: string;
  user?: MomUserSummary;
  map?: MomMap;
  leaderboardRun?: MomLeaderboardRun | null;
}

export interface MomActivity {
  id: number;
  userID: number;
  type: number;
  data: number | string;
  createdAt: string;
  updatedAt?: string;
  user?: MomUserSummary;
}

/**
 * Momentum naming is backwards from what you would expect:
 * followedID is the user being followed, followeeID is the user doing the following.
 */
export interface MomFollow {
  notifyOn: number;
  followedID: number;
  followeeID: number;
  followed?: MomUserSummary;
  followee?: MomUserSummary;
  createdAt: string;
}

export interface MomLeaderboardStats {
  leaderboard: MomLeaderboard;
  totalRuns: number;
}

export interface LeaderboardKey {
  mapId: number;
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
}

export function leaderboardKeyString(k: LeaderboardKey): string {
  return `${k.mapId}:${k.gamemode}:${k.trackType}:${k.trackNum}:${k.style}`;
}

export function parseLeaderboardKey(s: string): LeaderboardKey | null {
  const p = s.split(':').map((x) => Number.parseInt(x, 10));
  if (p.length !== 5 || p.some((n) => !Number.isInteger(n))) return null;
  return { mapId: p[0]!, gamemode: p[1]!, trackType: p[2]!, trackNum: p[3]!, style: p[4]! };
}
