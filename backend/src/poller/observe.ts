// Turns API objects into archive rows: upsert current state, append snapshots,
// record field changes, keep point in time identity on runs and leaderboard entries.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/index.js';
import {
  activities,
  avatars,
  followEvents,
  follows,
  leaderboardEntries,
  leaderboardObservations,
  leaderboardSnapshots,
  leaderboards,
  mapCredits,
  mapFieldChanges,
  mapImages,
  mapSnapshots,
  mapVersions,
  maps,
  runs,
  steamAvatarHistory,
  steamNameHistory,
  userFieldChanges,
  userSnapshots,
  users,
} from '../db/schema.js';
import { STEAM_MISSING_AVATAR } from '../momentum/enums.js';
import type {
  LeaderboardKey,
  MomActivity,
  MomFollow,
  MomLeaderboardRun,
  MomMap,
  MomPastRun,
  MomUser,
} from '../momentum/types.js';
import {
  boardHash,
  diffBoards,
  diffMapFields,
  diffUserFields,
  normalizeMap,
  normalizeUser,
  stableHash,
  userRowToFields,
  type BoardEntryLike,
  type FieldChange,
} from './diff.js';
import { enqueueLeaderboardRefresh, enqueueRefresh, enqueueReplay, PRIORITY } from './queue.js';
import { execRows } from '../db/index.js';

export interface ObserveResult {
  isNew: boolean;
  changes: FieldChange[];
}

type DbLike = Db | Tx;

/** Upsert a name into steam_name_history. */
export async function recordName(
  db: DbLike,
  steamId: string,
  name: string,
  source: 'momentum' | 'steam' | 'steamhistory',
  seenAt: Date,
): Promise<void> {
  if (!steamId || !name) return;
  await db
    .insert(steamNameHistory)
    .values({ steamId, name, source, firstSeen: seenAt, lastSeen: seenAt })
    .onConflictDoUpdate({
      target: [steamNameHistory.steamId, steamNameHistory.name, steamNameHistory.source],
      set: {
        firstSeen: sql`least(${steamNameHistory.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`greatest(${steamNameHistory.lastSeen}, excluded.last_seen)`,
      },
    });
}

export async function recordAvatar(
  db: DbLike,
  steamId: string,
  hash: string,
  source: 'momentum' | 'steam',
  seenAt: Date,
): Promise<void> {
  if (!steamId || !hash || hash === STEAM_MISSING_AVATAR) return;
  await db
    .insert(steamAvatarHistory)
    .values({ steamId, avatarHash: hash, source, firstSeen: seenAt, lastSeen: seenAt })
    .onConflictDoUpdate({
      target: [
        steamAvatarHistory.steamId,
        steamAvatarHistory.avatarHash,
        steamAvatarHistory.source,
      ],
      set: {
        firstSeen: sql`least(${steamAvatarHistory.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`greatest(${steamAvatarHistory.lastSeen}, excluded.last_seen)`,
      },
    });
}

export async function avatarArchived(db: DbLike, hash: string): Promise<boolean> {
  const r = await db
    .select({ hash: avatars.hash })
    .from(avatars)
    .where(eq(avatars.hash, hash))
    .limit(1);
  return r.length > 0;
}

/**
 * Observe a Momentum user object. Partial objects (embedded in runs, follows, credits)
 * only touch the fields they carry. Returns the field changes that were recorded.
 */
export async function observeUser(db: Db, u: MomUser, observedAt: Date): Promise<ObserveResult> {
  const obs = normalizeUser(u);
  return db.transaction(async (tx) => {
    const ins = await tx
      .insert(users)
      .values({
        id: obs.id,
        steamId: obs.steamId,
        alias: obs.alias,
        country: (obs.fields.country as string | null) ?? null,
        avatarHash: obs.avatarHash,
        avatarUrl: u.avatarURL ?? null,
        roles: u.roles ?? 0,
        bans: u.bans ?? 0,
        momentumCreatedAt: obs.momentumCreatedAt,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    const isNew = ins.length > 0;
    const [prev] = await tx.select().from(users).where(eq(users.id, obs.id)).for('update');
    if (!prev) throw new Error(`user ${obs.id} vanished during observe`);

    const prevFields = isNew ? null : userRowToFields(prev);
    const changes = diffUserFields(prevFields, obs.fields);

    const set: Partial<typeof users.$inferInsert> = {
      steamId: obs.steamId ?? prev.steamId,
      alias: obs.alias,
      country: (obs.fields.country as string | null) ?? null,
      avatarHash: obs.avatarHash,
      avatarUrl: u.avatarURL ?? prev.avatarUrl,
      roles: u.roles ?? 0,
      bans: u.bans ?? 0,
      momentumCreatedAt: obs.momentumCreatedAt ?? prev.momentumCreatedAt,
      lastSeenAt: observedAt,
    };
    if (u.profile !== undefined) {
      set.bio = u.profile.bio ?? '';
      set.socials = u.profile.socials ?? {};
    }
    if (u.userStats !== undefined) {
      set.cosXp = u.userStats.cosXP;
      set.level = u.userStats.level;
      set.mapsCompleted = u.userStats.mapsCompleted;
      set.runsSubmitted = u.userStats.runsSubmitted;
      set.totalJumps = u.userStats.totalJumps;
      set.totalStrafes = u.userStats.totalStrafes;
    }
    if (obs.full) {
      set.profileFetched = true;
      set.lastRefreshedAt = observedAt;
    }
    await tx.update(users).set(set).where(eq(users.id, obs.id));

    if (changes.length > 0) {
      await tx.insert(userFieldChanges).values(
        changes.map((c) => ({
          userId: obs.id,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          observedAt,
        })),
      );
    }
    if (isNew || changes.length > 0) {
      const [row] = await tx.select().from(users).where(eq(users.id, obs.id));
      const data = { ...row } as Record<string, unknown>;
      const hash = stableHash(userRowToFields(row!));
      const [last] = await tx
        .select({ hash: userSnapshots.hash })
        .from(userSnapshots)
        .where(eq(userSnapshots.userId, obs.id))
        .orderBy(desc(userSnapshots.observedAt))
        .limit(1);
      if (!last || last.hash !== hash) {
        await tx.insert(userSnapshots).values({ userId: obs.id, observedAt, hash, data });
      }
    }
    if (obs.steamId) {
      if (obs.alias) await recordName(tx, obs.steamId, obs.alias, 'momentum', observedAt);
      if (obs.avatarHash)
        await recordAvatar(tx, obs.steamId, obs.avatarHash, 'momentum', observedAt);
    }
    return { isNew, changes };
  });
}

/** Observe many embedded user summaries, deduplicated by id. */
export async function observeUsers(
  db: Db,
  list: MomUser[],
  observedAt: Date,
): Promise<{ newUsers: number[] }> {
  const seen = new Map<number, MomUser>();
  for (const u of list) if (u && !seen.has(u.id)) seen.set(u.id, u);
  const newUsers: number[] = [];
  for (const u of seen.values()) {
    const r = await observeUser(db, u, observedAt);
    if (r.isNew) newUsers.push(u.id);
  }
  return { newUsers };
}

/** Observe a map object. Full objects (GET /maps/:id with expand) update everything. */
export async function observeMap(
  db: Db,
  m: MomMap,
  observedAt: Date,
  archivedGamemodes: number[],
): Promise<ObserveResult & { newVersionIds: string[]; newImageIds: string[] }> {
  const obs = normalizeMap(m);
  const nativeGamemodes = m.leaderboards
    ? [...new Set(m.leaderboards.map((l) => l.gamemode))].sort((a, b) => a - b)
    : undefined;
  const archived = m.leaderboards
    ? m.leaderboards.some((l) => archivedGamemodes.includes(l.gamemode))
    : undefined;
  return db.transaction(async (tx) => {
    const ins = await tx
      .insert(maps)
      .values({
        id: m.id,
        name: m.name,
        status: m.status,
        submitterId: m.submitterID ?? null,
        currentVersionId: m.currentVersionID ?? null,
        imageIds: obs.imageIds,
        thumbnailId: obs.thumbnailId,
        momentumCreatedAt: m.createdAt ? new Date(m.createdAt) : null,
        momentumUpdatedAt: m.updatedAt ? new Date(m.updatedAt) : null,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      })
      .onConflictDoNothing()
      .returning({ id: maps.id });
    const isNew = ins.length > 0;
    const [prev] = await tx.select().from(maps).where(eq(maps.id, m.id)).for('update');
    if (!prev) throw new Error(`map ${m.id} vanished during observe`);

    let prevFields: Record<string, unknown> | null = null;
    if (!isNew) {
      const [snap] = await tx
        .select({ data: mapSnapshots.data })
        .from(mapSnapshots)
        .where(eq(mapSnapshots.mapId, m.id))
        .orderBy(desc(mapSnapshots.observedAt))
        .limit(1);
      prevFields = snap?.data ?? {
        name: prev.name,
        status: prev.status,
        submitterID: prev.submitterId,
        currentVersionID: prev.currentVersionId,
        images: prev.imageIds ?? [],
      };
    }
    const changes = diffMapFields(prevFields, obs.fields);

    const set: Partial<typeof maps.$inferInsert> = {
      name: m.name,
      status: m.status,
      submitterId: m.submitterID ?? prev.submitterId,
      currentVersionId: m.currentVersionID ?? prev.currentVersionId,
      imageIds: obs.imageIds,
      thumbnailId: obs.thumbnailId ?? prev.thumbnailId,
      momentumCreatedAt: m.createdAt ? new Date(m.createdAt) : prev.momentumCreatedAt,
      momentumUpdatedAt: m.updatedAt ? new Date(m.updatedAt) : prev.momentumUpdatedAt,
      lastSeenAt: observedAt,
    };
    if (m.info) {
      set.description = m.info.description ?? '';
      set.youtubeId = m.info.youtubeID ?? null;
      set.creationDate = m.info.creationDate ? new Date(m.info.creationDate) : null;
      set.approvedDate = m.info.approvedDate ? new Date(m.info.approvedDate) : null;
      set.requiredGames = m.info.requiredGames ?? [];
    }
    if (m.stats) {
      set.statsReviews = m.stats.reviews;
      set.statsSubscriptions = m.stats.subscriptions;
      set.statsPlays = m.stats.plays;
      set.statsFavorites = m.stats.favorites;
      set.statsCompletions = m.stats.completions;
      set.statsUniqueCompletions = m.stats.uniqueCompletions;
      set.statsTimePlayed = m.stats.timePlayed;
    }
    if (nativeGamemodes !== undefined) set.nativeGamemodes = nativeGamemodes;
    if (archived !== undefined) set.archived = archived;
    if (obs.full) {
      set.detailFetched = true;
      set.lastRefreshedAt = observedAt;
    }
    await tx.update(maps).set(set).where(eq(maps.id, m.id));

    if (changes.length > 0) {
      await tx.insert(mapFieldChanges).values(
        changes.map((c) => ({
          mapId: m.id,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          observedAt,
        })),
      );
    }
    // Snapshot the merged field map so partial observations do not erase detail fields.
    const merged = { ...(prevFields ?? {}), ...obs.fields };
    const hash = stableHash(merged);
    if (isNew || changes.length > 0) {
      await tx.insert(mapSnapshots).values({ mapId: m.id, observedAt, hash, data: merged });
    }

    const newVersionIds: string[] = [];
    if (m.versions) {
      const existing = new Set(
        (
          await tx
            .select({ id: mapVersions.id })
            .from(mapVersions)
            .where(eq(mapVersions.mapId, m.id))
        ).map((r) => r.id),
      );
      for (const v of m.versions) {
        if (existing.has(v.id)) continue;
        await tx
          .insert(mapVersions)
          .values({
            id: v.id,
            mapId: m.id,
            versionNum: v.versionNum,
            changelog: v.changelog ?? null,
            bspHash: v.bspHash ?? null,
            zoneHash: v.zoneHash ?? null,
            downloadUrl: v.downloadURL ?? null,
            submitterId: v.submitterID ?? null,
            momentumCreatedAt: v.createdAt ? new Date(v.createdAt) : null,
            firstSeenAt: observedAt,
          })
          .onConflictDoNothing();
        newVersionIds.push(v.id);
      }
    }

    const newImageIds: string[] = [];
    if (m.images) {
      const existing = await tx
        .select({ id: mapImages.id, removedAt: mapImages.removedAt })
        .from(mapImages)
        .where(eq(mapImages.mapId, m.id));
      const have = new Map(existing.map((r) => [r.id, r]));
      const current = new Set(obs.imageIds);
      for (const id of obs.imageIds) {
        const h = have.get(id);
        if (!h) {
          await tx
            .insert(mapImages)
            .values({ id, mapId: m.id, firstSeenAt: observedAt, lastSeenAt: observedAt })
            .onConflictDoNothing();
          newImageIds.push(id);
        } else {
          await tx
            .update(mapImages)
            .set({ lastSeenAt: observedAt, removedAt: null })
            .where(eq(mapImages.id, id));
        }
      }
      for (const r of existing) {
        if (!current.has(r.id) && r.removedAt === null) {
          await tx.update(mapImages).set({ removedAt: observedAt }).where(eq(mapImages.id, r.id));
        }
      }
    }

    if (m.credits) {
      const existing = await tx.select().from(mapCredits).where(eq(mapCredits.mapId, m.id));
      const keyOf = (c: { userId: number; type: number }) => `${c.userId}:${c.type}`;
      const current = new Map(m.credits.map((c) => [keyOf({ userId: c.userID, type: c.type }), c]));
      for (const [k, c] of current) {
        const ex = existing.find((e) => keyOf(e) === k);
        if (!ex) {
          await tx
            .insert(mapCredits)
            .values({
              mapId: m.id,
              userId: c.userID,
              type: c.type,
              description: c.description ?? null,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
            })
            .onConflictDoNothing();
        } else {
          await tx
            .update(mapCredits)
            .set({ lastSeenAt: observedAt, removedAt: null, description: c.description ?? null })
            .where(eq(mapCredits.id, ex.id));
        }
      }
      for (const e of existing) {
        if (!current.has(keyOf(e)) && e.removedAt === null) {
          await tx.update(mapCredits).set({ removedAt: observedAt }).where(eq(mapCredits.id, e.id));
        }
      }
    }

    if (m.leaderboards) {
      const existing = await tx.select().from(leaderboards).where(eq(leaderboards.mapId, m.id));
      const keyOf = (l: { gamemode: number; trackType: number; trackNum: number; style: number }) =>
        `${l.gamemode}:${l.trackType}:${l.trackNum}:${l.style}`;
      const current = new Map(m.leaderboards.map((l) => [keyOf(l), l]));
      for (const l of m.leaderboards) {
        await tx
          .insert(leaderboards)
          .values({
            mapId: m.id,
            gamemode: l.gamemode,
            trackType: l.trackType,
            trackNum: l.trackNum,
            style: l.style,
            tier: l.tier ?? null,
            tags: l.tags ?? [],
            type: l.type,
            linear: l.linear,
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          })
          .onConflictDoUpdate({
            target: [
              leaderboards.mapId,
              leaderboards.gamemode,
              leaderboards.trackType,
              leaderboards.trackNum,
              leaderboards.style,
            ],
            set: {
              tier: l.tier ?? null,
              tags: l.tags ?? [],
              type: l.type,
              linear: l.linear,
              lastSeenAt: observedAt,
              removedAt: null,
            },
          });
      }
      for (const e of existing) {
        if (!current.has(keyOf(e)) && e.removedAt === null) {
          await tx
            .update(leaderboards)
            .set({ removedAt: observedAt })
            .where(
              and(
                eq(leaderboards.mapId, e.mapId),
                eq(leaderboards.gamemode, e.gamemode),
                eq(leaderboards.trackType, e.trackType),
                eq(leaderboards.trackNum, e.trackNum),
                eq(leaderboards.style, e.style),
              ),
            );
        }
      }
    }

    return { isNew, changes, newVersionIds, newImageIds };
  });
}

export interface ObservedIdentity {
  alias: string | null;
  avatarHash: string | null;
  steamName: string | null;
}

/** Looks up a fresh Steam persona name (refreshed within the last 24h) for the observed identity. */
export async function freshSteamName(db: DbLike, steamId: string | null): Promise<string | null> {
  if (!steamId) return null;
  const rows = await execRows(
    db,
    sql`select persona_name from steam_profiles where steam_id = ${steamId} and last_refreshed_at > now() - interval '24 hours' limit 1`,
  );
  const r = (rows as unknown as { persona_name: string | null }[])[0];
  return r?.persona_name ?? null;
}

/** Upsert a PastRun. Returns true when the run was new to the archive. */
export async function observeRun(
  db: Db,
  r: MomPastRun,
  observedAt: Date,
  identity: ObservedIdentity,
): Promise<boolean> {
  const replayHash = r.leaderboardRun?.replayHash ?? null;
  const raw = { ...r } as Record<string, unknown>;
  delete raw.user;
  delete raw.map;
  if (raw.leaderboardRun && typeof raw.leaderboardRun === 'object') {
    const lr = { ...(raw.leaderboardRun as Record<string, unknown>) };
    delete lr.user;
    delete lr.map;
    raw.leaderboardRun = lr;
  }
  const inserted = await db
    .insert(runs)
    .values({
      id: r.id,
      userId: r.userID,
      mapId: r.mapID,
      gamemode: r.gamemode,
      trackType: r.trackType,
      trackNum: r.trackNum,
      style: r.style,
      time: r.time,
      flags: r.flags ?? [],
      isPb: Boolean(r.isPB),
      replayHash,
      momentumCreatedAt: new Date(r.createdAt),
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      observedAlias: identity.alias,
      observedAvatarHash: identity.avatarHash,
      observedSteamName: identity.steamName,
      raw,
    })
    .onConflictDoUpdate({
      target: runs.id,
      set: {
        lastSeenAt: observedAt,
        isPb: Boolean(r.isPB),
        replayHash: sql`coalesce(${runs.replayHash}, ${replayHash})`,
        removedAt: null,
        // keep observed identity from the first sighting
      },
    })
    .returning({ firstSeenAt: runs.firstSeenAt });
  const first = inserted[0]?.firstSeenAt;
  const isNew = first !== undefined && first.getTime() === observedAt.getTime();
  if (isNew) {
    await db
      .update(users)
      .set({
        lastRunAt: sql`greatest(coalesce(${users.lastRunAt}, 'epoch'::timestamptz), ${new Date(r.createdAt)})`,
      })
      .where(eq(users.id, r.userID));
  }
  return isNew;
}

/** A leaderboard entry seen embedded in a PastRun (leaderboardRun) or on a board page. */
export async function upsertLeaderboardEntry(
  db: DbLike,
  key: LeaderboardKey,
  e: MomLeaderboardRun,
  observedAt: Date,
  identity: { alias: string | null; avatarHash: string | null },
): Promise<void> {
  const pastRunId = e.pastRunID !== undefined && e.pastRunID !== null ? Number(e.pastRunID) : null;
  await db
    .insert(leaderboardEntries)
    .values({
      mapId: key.mapId,
      gamemode: key.gamemode,
      trackType: key.trackType,
      trackNum: key.trackNum,
      style: key.style,
      userId: e.userID,
      time: e.time,
      rank: e.rank ?? null,
      replayHash: e.replayHash ?? null,
      pastRunId,
      flags: e.flags ?? [],
      momentumCreatedAt: e.createdAt ? new Date(e.createdAt) : null,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      observedAlias: identity.alias,
      observedAvatarHash: identity.avatarHash,
    })
    .onConflictDoUpdate({
      target: [
        leaderboardEntries.mapId,
        leaderboardEntries.gamemode,
        leaderboardEntries.trackType,
        leaderboardEntries.trackNum,
        leaderboardEntries.style,
        leaderboardEntries.userId,
      ],
      set: {
        time: e.time,
        rank: e.rank ?? sql`${leaderboardEntries.rank}`,
        replayHash: e.replayHash ?? null,
        pastRunId,
        flags: e.flags ?? [],
        momentumCreatedAt: e.createdAt ? new Date(e.createdAt) : null,
        lastSeenAt: observedAt,
        removedAt: null,
        // identity is refreshed only when the run itself changed (new PB)
        observedAlias: sql`case when ${leaderboardEntries.pastRunId} is distinct from ${pastRunId} then ${identity.alias} else ${leaderboardEntries.observedAlias} end`,
        observedAvatarHash: sql`case when ${leaderboardEntries.pastRunId} is distinct from ${pastRunId} then ${identity.avatarHash} else ${leaderboardEntries.observedAvatarHash} end`,
      },
    });
}

export interface BoardObserveResult {
  added: number;
  removed: number;
  improved: number;
  total: number;
  newHashes: string[];
  changed: boolean;
}

/**
 * Observe a complete leaderboard. Entries present last time and missing now are
 * marked removed (this is how admin deletions surface). A snapshot is appended only
 * when the board content changed since the previous observation.
 */
export async function observeLeaderboard(
  db: Db,
  key: LeaderboardKey,
  entries: MomLeaderboardRun[],
  observedAt: Date,
  identities: Map<number, { alias: string | null; avatarHash: string | null }>,
): Promise<BoardObserveResult> {
  const keyWhere = and(
    eq(leaderboardEntries.mapId, key.mapId),
    eq(leaderboardEntries.gamemode, key.gamemode),
    eq(leaderboardEntries.trackType, key.trackType),
    eq(leaderboardEntries.trackNum, key.trackNum),
    eq(leaderboardEntries.style, key.style),
  );
  return db.transaction(async (tx) => {
    const before = await tx
      .select()
      .from(leaderboardEntries)
      .where(and(keyWhere, isNull(leaderboardEntries.removedAt)));
    const after: (BoardEntryLike & { entry: MomLeaderboardRun })[] = entries.map((e) => ({
      userId: e.userID,
      time: e.time,
      rank: e.rank ?? null,
      replayHash: e.replayHash ?? null,
      pastRunId: e.pastRunID !== undefined && e.pastRunID !== null ? Number(e.pastRunID) : null,
      entry: e,
    }));
    const diff = diffBoards(before, after);

    for (const a of after) {
      const id = identities.get(a.userId) ?? {
        alias: a.entry.user?.alias ?? null,
        avatarHash: null,
      };
      await upsertLeaderboardEntry(tx, key, a.entry, observedAt, id);
    }
    const removedRunIds: number[] = [];
    if (diff.removed.length > 0) {
      await tx
        .update(leaderboardEntries)
        .set({ removedAt: observedAt })
        .where(
          and(
            keyWhere,
            inArray(
              leaderboardEntries.userId,
              diff.removed.map((r) => r.userId),
            ),
          ),
        );
      for (const r of diff.removed) if (r.pastRunId) removedRunIds.push(r.pastRunId);
      if (removedRunIds.length > 0) {
        await tx
          .update(runs)
          .set({ removedAt: observedAt })
          .where(and(inArray(runs.id, removedRunIds), isNull(runs.removedAt)));
      }
    }

    const hash = boardHash(after);
    const [last] = await tx
      .select({ id: leaderboardObservations.id, hash: leaderboardObservations.hash })
      .from(leaderboardObservations)
      .where(
        and(
          eq(leaderboardObservations.mapId, key.mapId),
          eq(leaderboardObservations.gamemode, key.gamemode),
          eq(leaderboardObservations.trackType, key.trackType),
          eq(leaderboardObservations.trackNum, key.trackNum),
          eq(leaderboardObservations.style, key.style),
        ),
      )
      .orderBy(desc(leaderboardObservations.observedAt))
      .limit(1);
    let changed = false;
    if (last && last.hash === hash) {
      await tx
        .update(leaderboardObservations)
        .set({ lastConfirmedAt: observedAt })
        .where(eq(leaderboardObservations.id, last.id));
    } else {
      changed = true;
      const [obs] = await tx
        .insert(leaderboardObservations)
        .values({ ...key, observedAt, lastConfirmedAt: observedAt, hash, entryCount: after.length })
        .returning({ id: leaderboardObservations.id });
      if (after.length > 0) {
        for (let i = 0; i < after.length; i += 500) {
          await tx.insert(leaderboardSnapshots).values(
            after.slice(i, i + 500).map((a) => {
              const id = identities.get(a.userId) ?? {
                alias: a.entry.user?.alias ?? null,
                avatarHash: null,
              };
              return {
                observationId: obs!.id,
                mapId: key.mapId,
                gamemode: key.gamemode,
                trackType: key.trackType,
                trackNum: key.trackNum,
                style: key.style,
                userId: a.userId,
                time: a.time,
                rank: a.rank,
                replayHash: a.replayHash,
                pastRunId: a.pastRunId,
                momentumCreatedAt: a.entry.createdAt ? new Date(a.entry.createdAt) : null,
                observedAt,
                observedAlias: id.alias,
                observedAvatarHash: id.avatarHash,
              };
            }),
          );
        }
      }
    }

    await tx
      .insert(leaderboards)
      .values({
        ...key,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        lastRefreshedAt: observedAt,
        entryCount: after.length,
      })
      .onConflictDoUpdate({
        target: [
          leaderboards.mapId,
          leaderboards.gamemode,
          leaderboards.trackType,
          leaderboards.trackNum,
          leaderboards.style,
        ],
        set: { lastRefreshedAt: observedAt, entryCount: after.length },
      });

    for (const id of removedRunIds)
      await enqueueRefresh(tx as unknown as Db, 'run-verify', id, PRIORITY.high);

    const newHashes = [...diff.added, ...diff.improved.map((i) => i.after)]
      .map((e) => e.replayHash)
      .filter((h): h is string => Boolean(h));
    return {
      added: diff.added.length,
      removed: diff.removed.length,
      improved: diff.improved.length,
      total: after.length,
      newHashes,
      changed,
    };
  });
}

/** Enqueue the replay of a leaderboard entry for download. */
export async function enqueueReplayFor(
  db: Db,
  key: LeaderboardKey,
  e: MomLeaderboardRun,
  mapName: string | null,
  identity: ObservedIdentity & { steamId: string | null },
): Promise<boolean> {
  if (!e.replayHash) return false;
  return enqueueReplay(db, {
    sha1: e.replayHash,
    pastRunId: e.pastRunID !== undefined && e.pastRunID !== null ? Number(e.pastRunID) : null,
    userId: e.userID,
    mapId: key.mapId,
    mapName,
    gamemode: key.gamemode,
    trackType: key.trackType,
    trackNum: key.trackNum,
    style: key.style,
    runTime: e.time,
    steamId: identity.steamId,
    observedAlias: identity.alias,
    observedAvatarHash: identity.avatarHash,
    observedSteamName: identity.steamName,
  });
}

/** Store activities; returns how many were new. */
export async function observeActivities(
  db: Db,
  list: MomActivity[],
  observedAt: Date,
): Promise<number> {
  if (list.length === 0) return 0;
  const rows = await db
    .insert(activities)
    .values(
      list.map((a) => ({
        id: a.id,
        userId: a.userID,
        type: a.type,
        data: a.data === null || a.data === undefined ? null : String(a.data),
        momentumCreatedAt: new Date(a.createdAt),
        firstSeenAt: observedAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: activities.id });
  return rows.length;
}

/**
 * Diff a user's complete follow lists. `followers` are people following userId,
 * `following` are people userId follows. Emits follow_events on changes.
 */
export async function observeFollows(
  db: Db,
  userId: number,
  followers: MomFollow[],
  following: MomFollow[],
  observedAt: Date,
): Promise<{ followed: number; unfollowed: number }> {
  // Momentum: followedID = target, followeeID = the one who follows.
  const pairs: { followerId: number; followedId: number; notifyOn: number; createdAt: string }[] =
    [];
  for (const f of followers)
    pairs.push({
      followerId: f.followeeID,
      followedId: userId,
      notifyOn: f.notifyOn,
      createdAt: f.createdAt,
    });
  for (const f of following)
    pairs.push({
      followerId: userId,
      followedId: f.followedID,
      notifyOn: f.notifyOn,
      createdAt: f.createdAt,
    });
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select({ followsObservedAt: users.followsObservedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    // First fetch establishes the baseline: the follows are stored with Momentum's own
    // createdAt, but no follow_events are emitted because they were not observed happening.
    const emitEvents = Boolean(me?.followsObservedAt);
    const existing = await tx
      .select()
      .from(follows)
      .where(
        and(
          sql`(${follows.followerId} = ${userId} or ${follows.followedId} = ${userId})`,
          isNull(follows.removedAt),
        ),
      );
    const keyOf = (a: number, b: number) => `${a}>${b}`;
    const current = new Set(pairs.map((p) => keyOf(p.followerId, p.followedId)));
    const had = new Set(existing.map((e) => keyOf(e.followerId, e.followedId)));
    let followed = 0;
    let unfollowed = 0;
    for (const p of pairs) {
      await tx
        .insert(follows)
        .values({
          followerId: p.followerId,
          followedId: p.followedId,
          notifyOn: p.notifyOn,
          momentumCreatedAt: p.createdAt ? new Date(p.createdAt) : null,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
        })
        .onConflictDoUpdate({
          target: [follows.followerId, follows.followedId],
          set: { lastSeenAt: observedAt, removedAt: null, notifyOn: p.notifyOn },
        });
      if (!had.has(keyOf(p.followerId, p.followedId)) && emitEvents) {
        followed += 1;
        await tx.insert(followEvents).values({
          followerId: p.followerId,
          followedId: p.followedId,
          event: 'followed',
          observedAt,
        });
      }
    }
    for (const e of existing) {
      if (!current.has(keyOf(e.followerId, e.followedId))) {
        unfollowed += 1;
        await tx
          .update(follows)
          .set({ removedAt: observedAt })
          .where(and(eq(follows.followerId, e.followerId), eq(follows.followedId, e.followedId)));
        if (emitEvents) {
          await tx.insert(followEvents).values({
            followerId: e.followerId,
            followedId: e.followedId,
            event: 'unfollowed',
            observedAt,
          });
        }
      }
    }
    await tx.update(users).set({ followsObservedAt: observedAt }).where(eq(users.id, userId));
    return { followed, unfollowed };
  });
}

export { enqueueLeaderboardRefresh };
