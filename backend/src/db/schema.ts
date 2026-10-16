// Drizzle schema. Momentum's own timestamps are kept apart from the archive's observed_at.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// Users (Momentum side)

export const users = pgTable(
  'users',
  {
    id: integer('id').primaryKey(),
    steamId: text('steam_id'),
    alias: text('alias'),
    country: text('country'),
    avatarHash: text('avatar_hash'),
    avatarUrl: text('avatar_url'),
    roles: integer('roles').notNull().default(0),
    bans: integer('bans').notNull().default(0),
    bio: text('bio'),
    socials: jsonb('socials').$type<Record<string, string>>(),
    cosXp: bigint('cos_xp', { mode: 'number' }),
    level: integer('level'),
    mapsCompleted: integer('maps_completed'),
    runsSubmitted: integer('runs_submitted'),
    totalJumps: bigint('total_jumps', { mode: 'number' }),
    totalStrafes: bigint('total_strafes', { mode: 'number' }),
    momentumCreatedAt: ts('momentum_created_at'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    /** Last time the full profile endpoint (profile + stats) was fetched */
    lastRefreshedAt: ts('last_refreshed_at'),
    profileFetched: boolean('profile_fetched').notNull().default(false),
    isDeleted: boolean('is_deleted').notNull().default(false),
    lastRunAt: ts('last_run_at'),
    /** Last time followers and follows were fetched; events are only emitted after the first fetch */
    followsObservedAt: ts('follows_observed_at'),
    /** Last time activities were fetched */
    activitiesObservedAt: ts('activities_observed_at'),
  },
  (t) => [
    index('users_steam_id_idx').on(t.steamId),
    index('users_alias_idx').on(t.alias),
    index('users_last_run_idx').on(t.lastRunAt),
  ],
);

export const userSnapshots = pgTable(
  'user_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    observedAt: ts('observed_at').notNull(),
    hash: text('hash').notNull(),
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
  },
  (t) => [index('user_snapshots_user_idx').on(t.userId, t.observedAt)],
);

export const userFieldChanges = pgTable(
  'user_field_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    observedAt: ts('observed_at').notNull(),
  },
  (t) => [
    index('user_field_changes_user_idx').on(t.userId, t.observedAt),
    index('user_field_changes_field_idx').on(t.field, t.observedAt),
    index('user_field_changes_observed_idx').on(t.observedAt),
  ],
);

export const avatars = pgTable('avatars', {
  hash: text('hash').primaryKey(),
  s3Key: text('s3_key').notNull(),
  bytes: integer('bytes').notNull(),
  contentType: text('content_type'),
  source: text('source').notNull(),
  firstSeenAt: ts('first_seen_at').notNull(),
});

// Steam side

export const steamProfiles = pgTable('steam_profiles', {
  steamId: text('steam_id').primaryKey(),
  personaName: text('persona_name'),
  avatarHash: text('avatar_hash'),
  avatarFull: text('avatar_full'),
  profileUrl: text('profile_url'),
  profileState: integer('profile_state'),
  communityVisibilityState: integer('community_visibility_state'),
  timeCreated: ts('time_created'),
  locCountryCode: text('loc_country_code'),
  vacBanned: boolean('vac_banned'),
  numberOfVacBans: integer('number_of_vac_bans'),
  numberOfGameBans: integer('number_of_game_bans'),
  communityBanned: boolean('community_banned'),
  economyBan: text('economy_ban'),
  daysSinceLastBan: integer('days_since_last_ban'),
  firstSeenAt: ts('first_seen_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull(),
  lastRefreshedAt: ts('last_refreshed_at'),
  lastSourcebansRefreshAt: ts('last_sourcebans_refresh_at'),
});

export const steamProfileSnapshots = pgTable(
  'steam_profile_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    steamId: text('steam_id').notNull(),
    observedAt: ts('observed_at').notNull(),
    hash: text('hash').notNull(),
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
  },
  (t) => [index('steam_profile_snapshots_idx').on(t.steamId, t.observedAt)],
);

export const steamFieldChanges = pgTable(
  'steam_field_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    steamId: text('steam_id').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    observedAt: ts('observed_at').notNull(),
  },
  (t) => [
    index('steam_field_changes_steam_idx').on(t.steamId, t.observedAt),
    index('steam_field_changes_field_idx').on(t.field, t.observedAt),
  ],
);

export const steamNameHistory = pgTable(
  'steam_name_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    steamId: text('steam_id').notNull(),
    name: text('name').notNull(),
    source: text('source').notNull(),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
  },
  (t) => [
    uniqueIndex('steam_name_history_uniq').on(t.steamId, t.name, t.source),
    index('steam_name_history_name_idx').on(t.name),
  ],
);

export const steamAvatarHistory = pgTable(
  'steam_avatar_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    steamId: text('steam_id').notNull(),
    avatarHash: text('avatar_hash').notNull(),
    source: text('source').notNull(),
    s3Key: text('s3_key'),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
  },
  (t) => [uniqueIndex('steam_avatar_history_uniq').on(t.steamId, t.avatarHash, t.source)],
);

export const steamSourcebans = pgTable(
  'steam_sourcebans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    steamId: text('steam_id').notNull(),
    server: text('server').notNull(),
    banTimestamp: ts('ban_timestamp').notNull(),
    unbanTimestamp: ts('unban_timestamp'),
    currentState: text('current_state'),
    banReason: text('ban_reason'),
    unbanReason: text('unban_reason'),
    nameAtBan: text('name_at_ban'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
  },
  (t) => [
    uniqueIndex('steam_sourcebans_uniq').on(t.steamId, t.server, t.banTimestamp),
    index('steam_sourcebans_name_idx').on(t.nameAtBan),
  ],
);

// Follows

export const follows = pgTable(
  'follows',
  {
    followerId: integer('follower_id').notNull(),
    followedId: integer('followed_id').notNull(),
    notifyOn: integer('notify_on'),
    momentumCreatedAt: ts('momentum_created_at'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    removedAt: ts('removed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followedId] }),
    index('follows_followed_idx').on(t.followedId),
  ],
);

export const followEvents = pgTable(
  'follow_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    followerId: integer('follower_id').notNull(),
    followedId: integer('followed_id').notNull(),
    event: text('event').notNull(),
    observedAt: ts('observed_at').notNull(),
  },
  (t) => [
    index('follow_events_follower_idx').on(t.followerId, t.observedAt),
    index('follow_events_followed_idx').on(t.followedId, t.observedAt),
  ],
);

// Maps

export const maps = pgTable(
  'maps',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    status: integer('status').notNull(),
    submitterId: integer('submitter_id'),
    currentVersionId: text('current_version_id'),
    description: text('description'),
    youtubeId: text('youtube_id'),
    creationDate: ts('creation_date'),
    approvedDate: ts('approved_date'),
    requiredGames: jsonb('required_games').$type<number[]>(),
    statsReviews: integer('stats_reviews'),
    statsSubscriptions: integer('stats_subscriptions'),
    statsPlays: integer('stats_plays'),
    statsFavorites: integer('stats_favorites'),
    statsCompletions: integer('stats_completions'),
    statsUniqueCompletions: integer('stats_unique_completions'),
    statsTimePlayed: bigint('stats_time_played', { mode: 'number' }),
    imageIds: jsonb('image_ids').$type<string[]>(),
    thumbnailId: text('thumbnail_id'),
    momentumCreatedAt: ts('momentum_created_at'),
    momentumUpdatedAt: ts('momentum_updated_at'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    lastRefreshedAt: ts('last_refreshed_at'),
    detailFetched: boolean('detail_fetched').notNull().default(false),
    /** Gamemodes that have a leaderboard on this map, from leaderboards[] */
    nativeGamemodes: jsonb('native_gamemodes').$type<number[]>(),
    /** True when the map has a leaderboard in one of the archived gamemodes */
    archived: boolean('archived').notNull().default(false),
    /** Set when GET /maps/:id started answering 404 (map hidden or deleted) */
    notFoundAt: ts('not_found_at'),
  },
  (t) => [index('maps_name_idx').on(t.name), index('maps_status_idx').on(t.status)],
);

export const mapSnapshots = pgTable(
  'map_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mapId: integer('map_id').notNull(),
    observedAt: ts('observed_at').notNull(),
    hash: text('hash').notNull(),
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
  },
  (t) => [index('map_snapshots_map_idx').on(t.mapId, t.observedAt)],
);

export const mapFieldChanges = pgTable(
  'map_field_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mapId: integer('map_id').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    observedAt: ts('observed_at').notNull(),
  },
  (t) => [
    index('map_field_changes_map_idx').on(t.mapId, t.observedAt),
    index('map_field_changes_field_idx').on(t.field, t.observedAt),
  ],
);

export const mapVersions = pgTable(
  'map_versions',
  {
    id: text('id').primaryKey(),
    mapId: integer('map_id').notNull(),
    versionNum: integer('version_num').notNull(),
    changelog: text('changelog'),
    bspHash: text('bsp_hash'),
    zoneHash: text('zone_hash'),
    downloadUrl: text('download_url'),
    submitterId: integer('submitter_id'),
    momentumCreatedAt: ts('momentum_created_at'),
    firstSeenAt: ts('first_seen_at').notNull(),
    bspS3Key: text('bsp_s3_key'),
    bspBytes: bigint('bsp_bytes', { mode: 'number' }),
  },
  (t) => [index('map_versions_map_idx').on(t.mapId)],
);

export const mapImages = pgTable(
  'map_images',
  {
    id: text('id').primaryKey(),
    mapId: integer('map_id').notNull(),
    s3Key: text('s3_key'),
    bytes: integer('bytes'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    removedAt: ts('removed_at'),
    fetchFailed: boolean('fetch_failed').notNull().default(false),
  },
  (t) => [index('map_images_map_idx').on(t.mapId)],
);

export const mapCredits = pgTable(
  'map_credits',
  {
    id: serial('id').primaryKey(),
    mapId: integer('map_id').notNull(),
    userId: integer('user_id').notNull(),
    type: integer('type').notNull(),
    description: text('description'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    removedAt: ts('removed_at'),
  },
  (t) => [
    uniqueIndex('map_credits_uniq').on(t.mapId, t.userId, t.type),
    index('map_credits_user_idx').on(t.userId),
  ],
);

export const leaderboards = pgTable(
  'leaderboards',
  {
    mapId: integer('map_id').notNull(),
    gamemode: integer('gamemode').notNull(),
    trackType: integer('track_type').notNull(),
    trackNum: integer('track_num').notNull(),
    style: integer('style').notNull(),
    tier: integer('tier'),
    tags: jsonb('tags').$type<number[]>(),
    type: integer('type'),
    linear: boolean('linear'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    removedAt: ts('removed_at'),
    /** Last time the full board was fetched */
    lastRefreshedAt: ts('last_refreshed_at'),
    entryCount: integer('entry_count'),
  },
  (t) => [
    primaryKey({ columns: [t.mapId, t.gamemode, t.trackType, t.trackNum, t.style] }),
    index('leaderboards_gamemode_idx').on(t.gamemode),
  ],
);

// Runs

export const runs = pgTable(
  'runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    mapId: integer('map_id').notNull(),
    gamemode: integer('gamemode').notNull(),
    trackType: integer('track_type').notNull(),
    trackNum: integer('track_num').notNull(),
    style: integer('style').notNull(),
    time: doublePrecision('time').notNull(),
    flags: jsonb('flags').$type<number[]>(),
    isPb: boolean('is_pb').notNull(),
    /** replayHash of the leaderboard entry at the time of observation, if the run was a PB */
    replayHash: text('replay_hash'),
    momentumCreatedAt: ts('momentum_created_at').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    removedAt: ts('removed_at'),
    /** 'leaderboard' when only the leaderboard entry vanished, 'deleted' when GET /runs/:id returns 404 */
    removalKind: text('removal_kind'),
    observedAlias: text('observed_alias'),
    observedAvatarHash: text('observed_avatar_hash'),
    observedSteamName: text('observed_steam_name'),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('runs_user_idx').on(t.userId, t.momentumCreatedAt),
    index('runs_map_idx').on(t.mapId, t.gamemode, t.trackType, t.trackNum, t.style),
    index('runs_created_idx').on(t.momentumCreatedAt),
    index('runs_removed_idx').on(t.removedAt),
    index('runs_gamemode_created_idx').on(t.gamemode, t.momentumCreatedAt),
  ],
);

export const leaderboardEntries = pgTable(
  'leaderboard_entries',
  {
    mapId: integer('map_id').notNull(),
    gamemode: integer('gamemode').notNull(),
    trackType: integer('track_type').notNull(),
    trackNum: integer('track_num').notNull(),
    style: integer('style').notNull(),
    userId: integer('user_id').notNull(),
    time: doublePrecision('time').notNull(),
    rank: integer('rank'),
    replayHash: text('replay_hash'),
    pastRunId: bigint('past_run_id', { mode: 'number' }),
    flags: jsonb('flags').$type<number[]>(),
    momentumCreatedAt: ts('momentum_created_at'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    removedAt: ts('removed_at'),
    observedAlias: text('observed_alias'),
    observedAvatarHash: text('observed_avatar_hash'),
  },
  (t) => [
    primaryKey({ columns: [t.mapId, t.gamemode, t.trackType, t.trackNum, t.style, t.userId] }),
    index('leaderboard_entries_user_idx').on(t.userId),
    index('leaderboard_entries_replay_idx').on(t.replayHash),
    index('leaderboard_entries_removed_idx').on(t.removedAt),
  ],
);

/** One row per distinct observation of a whole leaderboard. Entries live in leaderboard_snapshots. */
export const leaderboardObservations = pgTable(
  'leaderboard_observations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mapId: integer('map_id').notNull(),
    gamemode: integer('gamemode').notNull(),
    trackType: integer('track_type').notNull(),
    trackNum: integer('track_num').notNull(),
    style: integer('style').notNull(),
    observedAt: ts('observed_at').notNull(),
    /** Last time the same content was confirmed; observation stays valid until the next one */
    lastConfirmedAt: ts('last_confirmed_at').notNull(),
    hash: text('hash').notNull(),
    entryCount: integer('entry_count').notNull(),
  },
  (t) => [
    index('leaderboard_observations_key_idx').on(
      t.mapId,
      t.gamemode,
      t.trackType,
      t.trackNum,
      t.style,
      t.observedAt,
    ),
  ],
);

export const leaderboardSnapshots = pgTable(
  'leaderboard_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    observationId: bigint('observation_id', { mode: 'number' }).notNull(),
    mapId: integer('map_id').notNull(),
    gamemode: integer('gamemode').notNull(),
    trackType: integer('track_type').notNull(),
    trackNum: integer('track_num').notNull(),
    style: integer('style').notNull(),
    userId: integer('user_id').notNull(),
    time: doublePrecision('time').notNull(),
    rank: integer('rank'),
    replayHash: text('replay_hash'),
    pastRunId: bigint('past_run_id', { mode: 'number' }),
    momentumCreatedAt: ts('momentum_created_at'),
    observedAt: ts('observed_at').notNull(),
    observedAlias: text('observed_alias'),
    observedAvatarHash: text('observed_avatar_hash'),
  },
  (t) => [
    index('leaderboard_snapshots_obs_idx').on(t.observationId),
    index('leaderboard_snapshots_user_idx').on(t.userId, t.observedAt),
  ],
);

// Replays

export const replays = pgTable(
  'replays',
  {
    sha1: text('sha1').primaryKey(),
    s3Key: text('s3_key').notNull(),
    bytes: integer('bytes').notNull(),
    downloadedAt: ts('downloaded_at').notNull(),
    header: jsonb('header').$type<Record<string, unknown>>(),
    headerOk: boolean('header_ok').notNull().default(false),
    headerIssues: jsonb('header_issues').$type<string[]>(),
    headerPlayerName: text('header_player_name'),
    pastRunId: bigint('past_run_id', { mode: 'number' }),
    userId: integer('user_id'),
    mapId: integer('map_id'),
    gamemode: integer('gamemode'),
    trackType: integer('track_type'),
    trackNum: integer('track_num'),
    style: integer('style'),
    runTime: doublePrecision('run_time'),
    observedAlias: text('observed_alias'),
    observedAvatarHash: text('observed_avatar_hash'),
    observedSteamName: text('observed_steam_name'),
    sourceUrl: text('source_url'),
  },
  (t) => [
    index('replays_user_idx').on(t.userId),
    index('replays_map_idx').on(t.mapId),
    index('replays_run_idx').on(t.pastRunId),
    index('replays_downloaded_idx').on(t.downloadedAt),
  ],
);

export const replayQueue = pgTable(
  'replay_queue',
  {
    sha1: text('sha1').primaryKey(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull(),
    enqueuedAt: ts('enqueued_at').notNull(),
    startedAt: ts('started_at'),
    pastRunId: bigint('past_run_id', { mode: 'number' }),
    userId: integer('user_id'),
    mapId: integer('map_id'),
    mapName: text('map_name'),
    gamemode: integer('gamemode'),
    trackType: integer('track_type'),
    trackNum: integer('track_num'),
    style: integer('style'),
    runTime: doublePrecision('run_time'),
    steamId: text('steam_id'),
    observedAlias: text('observed_alias'),
    observedAvatarHash: text('observed_avatar_hash'),
    observedSteamName: text('observed_steam_name'),
  },
  (t) => [index('replay_queue_state_idx').on(t.state, t.nextAttemptAt)],
);

export const replayFetchFailures = pgTable('replay_fetch_failures', {
  sha1: text('sha1').primaryKey(),
  attempts: integer('attempts').notNull(),
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
  firstFailedAt: ts('first_failed_at').notNull(),
  lastFailedAt: ts('last_failed_at').notNull(),
  gaveUp: boolean('gave_up').notNull().default(false),
  context: jsonb('context').$type<Record<string, unknown>>(),
});

// Activities

export const activities = pgTable(
  'activities',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    type: integer('type').notNull(),
    data: text('data'),
    momentumCreatedAt: ts('momentum_created_at').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
  },
  (t) => [index('activities_user_idx').on(t.userId, t.momentumCreatedAt)],
);

// Poller bookkeeping

export const syncState = pgTable('sync_state', {
  job: text('job').primaryKey(),
  cursor: jsonb('cursor').notNull().$type<Record<string, unknown>>(),
  updatedAt: ts('updated_at').notNull(),
});

export const pollLog = pgTable(
  'poll_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    job: text('job').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    ok: boolean('ok'),
    itemsSeen: integer('items_seen').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    apiCalls: integer('api_calls').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('poll_log_job_idx').on(t.job, t.startedAt)],
);

/** Pending refresh work: users, leaderboards, activities, maps. Unique per (kind, key). */
export const refreshQueue = pgTable(
  'refresh_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    priority: integer('priority').notNull().default(5),
    enqueuedAt: ts('enqueued_at').notNull(),
    startedAt: ts('started_at'),
    attempts: integer('attempts').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('refresh_queue_uniq').on(t.kind, t.key),
    index('refresh_queue_order_idx').on(t.priority, t.enqueuedAt),
  ],
);

/** Failed binary downloads (avatars, map images, bsps) so they are not retried forever. */
export const fetchFailures = pgTable(
  'fetch_failures',
  {
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    attempts: integer('attempts').notNull().default(1),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    lastAt: ts('last_at').notNull(),
    gaveUp: boolean('gave_up').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

/** Values the status page and stats endpoint read without recomputing (storage totals, etc). */
export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().$type<Record<string, unknown>>(),
  updatedAt: ts('updated_at').notNull(),
});

// Admin side. These are the only tables the HTTP process may write, through the
// momarchive_app role. Nothing here can change what the archive observed.

/** Admin sessions. The cookie holds a random token; only its HMAC lands here. */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    steamId: text('steam_id').notNull(),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('admin_sessions_token_idx').on(t.tokenHash),
    index('admin_sessions_steam_idx').on(t.steamId, t.createdAt),
  ],
);

/** Banners shown on the site. Rendered as text, never as HTML. */
export const announcements = pgTable(
  'announcements',
  {
    id: serial('id').primaryKey(),
    body: text('body').notNull(),
    /** info | warning | critical */
    level: text('level').notNull().default('info'),
    /** home | all */
    scope: text('scope').notNull().default('home'),
    startsAt: ts('starts_at'),
    endsAt: ts('ends_at'),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => [index('announcements_active_idx').on(t.active, t.scope)],
);

/** A note the owner pinned to one archived user's page. Text only. */
export const userNotices = pgTable(
  'user_notices',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull(),
    body: text('body').notNull(),
    level: text('level').notNull().default('info'),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => [index('user_notices_user_idx').on(t.userId, t.active)],
);

/** Every admin action, so the panel can never quietly change anything. */
export const adminAudit = pgTable(
  'admin_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull(),
    steamId: text('steam_id').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('admin_audit_at_idx').on(t.at)],
);

/** One row per HTTP request, buffered and inserted in batches. Pruned by retention. */
export const requestLog = pgTable(
  'request_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull(),
    ip: text('ip'),
    country: text('country'),
    method: text('method').notNull(),
    /** Exactly what was asked for */
    path: text('path').notNull(),
    /** The same path with ids, hashes and uuids collapsed, for grouping */
    route: text('route').notNull(),
    query: text('query'),
    status: integer('status').notNull(),
    ms: integer('ms').notNull(),
    bytes: integer('bytes'),
    userAgent: text('user_agent'),
    referer: text('referer'),
    admin: boolean('admin').notNull().default(false),
  },
  (t) => [
    index('request_log_at_idx').on(t.at),
    index('request_log_ip_idx').on(t.ip, t.at),
    index('request_log_route_idx').on(t.route, t.at),
  ],
);

export const schemaTables = {
  adminSessions,
  announcements,
  userNotices,
  adminAudit,
  requestLog,
  users,
  userSnapshots,
  userFieldChanges,
  avatars,
  steamProfiles,
  steamProfileSnapshots,
  steamFieldChanges,
  steamNameHistory,
  steamAvatarHistory,
  steamSourcebans,
  follows,
  followEvents,
  maps,
  mapSnapshots,
  mapFieldChanges,
  mapVersions,
  mapImages,
  mapCredits,
  leaderboards,
  runs,
  leaderboardEntries,
  leaderboardObservations,
  leaderboardSnapshots,
  replays,
  replayQueue,
  replayFetchFailures,
  activities,
  syncState,
  pollLog,
  refreshQueue,
  fetchFailures,
  kv,
};

export const nowSql = sql`now()`;
