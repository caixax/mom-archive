// steam-refresh: GetPlayerSummaries + GetPlayerBans, diffed into steam_field_changes.
// steamhistory-refresh: SourceBans from SteamHistory.net into steam_sourcebans.
import { desc, eq, sql } from 'drizzle-orm';
import {
  steamFieldChanges,
  steamProfileSnapshots,
  steamProfiles,
  steamSourcebans,
} from '../../db/schema.js';
import { errMsg } from '../../logger.js';
import type { SteamBans, SteamSummary } from '../../steam/steam.js';
import type { PollerContext } from '../context.js';
import { diffFields, stableHash } from '../diff.js';
import { recordAvatar, recordName } from '../observe.js';
import type { JobResult, ProgressFn } from '../scheduler.js';
import { ensureAvatarArchived } from './helpers.js';
import { execRows } from '../../db/index.js';

const STEAM_FIELDS = [
  'personaname',
  'avatarhash',
  'profileurl',
  'profilestate',
  'communityvisibilitystate',
  'timecreated',
  'loccountrycode',
  'vac_banned',
  'number_of_vac_bans',
  'number_of_game_bans',
  'community_banned',
  'economy_ban',
] as const;

function steamFields(
  s: SteamSummary | undefined,
  b: SteamBans | undefined,
): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (s) {
    f.personaname = s.personaname ?? null;
    f.avatarhash = s.avatarhash ?? null;
    f.profileurl = s.profileurl ?? null;
    f.profilestate = s.profilestate ?? null;
    f.communityvisibilitystate = s.communityvisibilitystate ?? null;
    f.timecreated = s.timecreated ?? null;
    f.loccountrycode = s.loccountrycode ?? null;
  }
  if (b) {
    f.vac_banned = b.VACBanned;
    f.number_of_vac_bans = b.NumberOfVACBans;
    f.number_of_game_bans = b.NumberOfGameBans;
    f.community_banned = b.CommunityBanned;
    f.economy_ban = b.EconomyBan ?? null;
  }
  return f;
}

function rowFields(r: typeof steamProfiles.$inferSelect): Record<string, unknown> {
  return {
    personaname: r.personaName,
    avatarhash: r.avatarHash,
    profileurl: r.profileUrl,
    profilestate: r.profileState,
    communityvisibilitystate: r.communityVisibilityState,
    timecreated: r.timeCreated ? Math.floor(r.timeCreated.getTime() / 1000) : null,
    loccountrycode: r.locCountryCode,
    vac_banned: r.vacBanned,
    number_of_vac_bans: r.numberOfVacBans,
    number_of_game_bans: r.numberOfGameBans,
    community_banned: r.communityBanned,
    economy_ban: r.economyBan,
  };
}

export async function observeSteamProfile(
  ctx: PollerContext,
  steamId: string,
  s: SteamSummary | undefined,
  b: SteamBans | undefined,
  observedAt: Date,
): Promise<number> {
  if (!s && !b) return 0;
  const next = steamFields(s, b);
  return ctx.db.transaction(async (tx) => {
    const ins = await tx
      .insert(steamProfiles)
      .values({ steamId, firstSeenAt: observedAt, lastSeenAt: observedAt })
      .onConflictDoNothing()
      .returning({ steamId: steamProfiles.steamId });
    const isNew = ins.length > 0;
    const [prev] = await tx
      .select()
      .from(steamProfiles)
      .where(eq(steamProfiles.steamId, steamId))
      .for('update');
    if (!prev) throw new Error('steam profile vanished');
    const changes =
      isNew || prev.lastRefreshedAt === null
        ? []
        : diffFields(rowFields(prev), next, [...STEAM_FIELDS]);
    const set: Partial<typeof steamProfiles.$inferInsert> = {
      lastSeenAt: observedAt,
      lastRefreshedAt: observedAt,
    };
    if (s) {
      set.personaName = s.personaname ?? null;
      set.avatarHash = s.avatarhash ?? null;
      set.avatarFull = s.avatarfull ?? null;
      set.profileUrl = s.profileurl ?? null;
      set.profileState = s.profilestate ?? null;
      set.communityVisibilityState = s.communityvisibilitystate ?? null;
      set.timeCreated = s.timecreated ? new Date(s.timecreated * 1000) : null;
      set.locCountryCode = s.loccountrycode ?? null;
    }
    if (b) {
      set.vacBanned = b.VACBanned;
      set.numberOfVacBans = b.NumberOfVACBans;
      set.numberOfGameBans = b.NumberOfGameBans;
      set.communityBanned = b.CommunityBanned;
      set.economyBan = b.EconomyBan ?? null;
      set.daysSinceLastBan = b.DaysSinceLastBan;
    }
    await tx.update(steamProfiles).set(set).where(eq(steamProfiles.steamId, steamId));
    if (changes.length > 0) {
      await tx.insert(steamFieldChanges).values(
        changes.map((c) => ({
          steamId,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          observedAt,
        })),
      );
    }
    if (isNew || changes.length > 0) {
      const [row] = await tx.select().from(steamProfiles).where(eq(steamProfiles.steamId, steamId));
      const hash = stableHash(rowFields(row!));
      const [last] = await tx
        .select({ hash: steamProfileSnapshots.hash })
        .from(steamProfileSnapshots)
        .where(eq(steamProfileSnapshots.steamId, steamId))
        .orderBy(desc(steamProfileSnapshots.observedAt))
        .limit(1);
      if (!last || last.hash !== hash) {
        await tx
          .insert(steamProfileSnapshots)
          .values({ steamId, observedAt, hash, data: { ...row } as Record<string, unknown> });
      }
    }
    if (s?.personaname) await recordName(tx, steamId, s.personaname, 'steam', observedAt);
    if (s?.avatarhash) await recordAvatar(tx, steamId, s.avatarhash, 'steam', observedAt);
    return changes.length;
  });
}

/** Picks steam ids due for a refresh: active users every 6h, everyone every 24h. */
async function dueSteamIds(ctx: PollerContext, limit: number): Promise<string[]> {
  const rows = (await execRows(
    ctx.db,
    sql`
    select u.steam_id from users u
    left join steam_profiles p on p.steam_id = u.steam_id
    where u.steam_id is not null and u.is_deleted = false
      and (
        p.last_refreshed_at is null
        or (u.last_run_at > now() - interval '7 days' and p.last_refreshed_at < now() - interval '6 hours')
        or p.last_refreshed_at < now() - interval '24 hours'
      )
    order by p.last_refreshed_at asc nulls first
    limit ${limit}
  `,
  )) as unknown as { steam_id: string }[];
  return rows.map((r) => r.steam_id);
}

export async function steamRefresh(
  ctx: PollerContext,
  signal: AbortSignal = ctx.scheduler.signal,
  progress: ProgressFn = () => {},
): Promise<JobResult> {
  if (!ctx.steam) return { note: 'disabled' };
  if (!ctx.steam.hasBudget()) return { note: 'daily quota reached' };
  const ids = await dueSteamIds(ctx, 20_000);
  let seen = 0;
  let changed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    if (signal.aborted) break;
    progress({ done: i, total: ids.length });
    const batch = ids.slice(i, i + 100);
    let summaries: SteamSummary[];
    let bans: SteamBans[];
    try {
      [summaries, bans] = await Promise.all([
        ctx.steam.getPlayerSummaries(batch),
        ctx.steam.getPlayerBans(batch),
      ]);
    } catch (e) {
      ctx.log.warn('steam batch failed', { size: batch.length, error: errMsg(e) });
      continue;
    }
    const byId = new Map(summaries.map((s) => [s.steamid, s]));
    const bansById = new Map(bans.map((b) => [b.SteamId, b]));
    const observedAt = new Date();
    for (const id of batch) {
      const s = byId.get(id);
      const b = bansById.get(id);
      seen += 1;
      const n = await observeSteamProfile(ctx, id, s, b, observedAt);
      if (n > 0) {
        changed += 1;
        ctx.log.info('steam profile changed', { steamId: id, changes: n });
      }
      if (s?.avatarhash) await ensureAvatarArchived(ctx, s.avatarhash, 'steam');
      if (!s && !b) {
        // Steam returned nothing for this id. Still mark it refreshed so it is not retried every tick.
        await ctx.db
          .insert(steamProfiles)
          .values({
            steamId: id,
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
            lastRefreshedAt: observedAt,
          })
          .onConflictDoUpdate({
            target: steamProfiles.steamId,
            set: { lastRefreshedAt: observedAt },
          });
      }
    }
  }
  return { seen, new: changed, note: `due=${ids.length}` };
}

async function dueSourcebanIds(ctx: PollerContext, limit: number): Promise<string[]> {
  const rows = (await execRows(
    ctx.db,
    sql`
    select u.steam_id from users u
    left join steam_profiles p on p.steam_id = u.steam_id
    where u.steam_id is not null and u.is_deleted = false
      and (p.last_sourcebans_refresh_at is null or p.last_sourcebans_refresh_at < now() - interval '24 hours')
    order by p.last_sourcebans_refresh_at asc nulls first
    limit ${limit}
  `,
  )) as unknown as { steam_id: string }[];
  return rows.map((r) => r.steam_id);
}

export async function steamHistoryRefresh(
  ctx: PollerContext,
  signal: AbortSignal = ctx.scheduler.signal,
  progress: ProgressFn = () => {},
): Promise<JobResult> {
  if (!ctx.steamHistory) return { note: 'disabled' };
  const ids = await dueSourcebanIds(ctx, 10_000);
  let seen = 0;
  let newBans = 0;
  let stateChanges = 0;
  for (let i = 0; i < ids.length; i += 100) {
    if (signal.aborted) break;
    progress({ done: i, total: ids.length });
    const batch = ids.slice(i, i + 100);
    let result;
    try {
      result = await ctx.steamHistory.getSourceBans(batch);
    } catch (e) {
      ctx.log.warn('steamhistory batch failed', { size: batch.length, error: errMsg(e) });
      continue;
    }
    const observedAt = new Date();
    for (const id of batch) {
      seen += 1;
      const bans = result.get(id) ?? [];
      for (const b of bans) {
        if (!b.Server || !b.BanTimestamp) continue;
        const banTs = new Date(b.BanTimestamp * 1000);
        const unbanTs = b.UnbanTimestamp ? new Date(b.UnbanTimestamp * 1000) : null;
        const [prev] = await ctx.db
          .select({ id: steamSourcebans.id, currentState: steamSourcebans.currentState })
          .from(steamSourcebans)
          .where(
            sql`${steamSourcebans.steamId} = ${id} and ${steamSourcebans.server} = ${b.Server} and ${steamSourcebans.banTimestamp} = ${banTs.toISOString()}::timestamptz`,
          );
        if (!prev) {
          newBans += 1;
          await ctx.db
            .insert(steamSourcebans)
            .values({
              steamId: id,
              server: b.Server,
              banTimestamp: banTs,
              unbanTimestamp: unbanTs,
              currentState: b.CurrentState ?? null,
              banReason: b.BanReason ?? null,
              unbanReason: b.UnbanReason ?? null,
              nameAtBan: b.Name ?? null,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
            })
            .onConflictDoNothing();
        } else {
          if (prev.currentState !== (b.CurrentState ?? null)) {
            stateChanges += 1;
            await ctx.db.insert(steamFieldChanges).values({
              steamId: id,
              field: `sourceban:${b.Server}`,
              oldValue: prev.currentState,
              newValue: b.CurrentState ?? null,
              observedAt,
            });
          }
          await ctx.db
            .update(steamSourcebans)
            .set({
              unbanTimestamp: unbanTs,
              currentState: b.CurrentState ?? null,
              banReason: b.BanReason ?? null,
              unbanReason: b.UnbanReason ?? null,
              nameAtBan: b.Name ?? null,
              lastSeenAt: observedAt,
            })
            .where(eq(steamSourcebans.id, prev.id));
        }
        if (b.Name) await recordName(ctx.db, id, b.Name, 'steamhistory', banTs);
      }
      await ctx.db
        .insert(steamProfiles)
        .values({
          steamId: id,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          lastSourcebansRefreshAt: observedAt,
        })
        .onConflictDoUpdate({
          target: steamProfiles.steamId,
          set: { lastSourcebansRefreshAt: observedAt },
        });
    }
  }
  return { seen, new: newBans, note: `state_changes=${stateChanges} due=${ids.length}` };
}
