<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import Pager from '../components/Pager.svelte';
  import RunsTable from '../components/RunsTable.svelte';
  import { api, type Paged, type RunRow } from '../lib/api';
  import {
    fieldLabel,
    formatDate,
    formatInt,
    GAMEMODES,
    relTime,
    socialLink,
    STYLES,
    valueLabel,
  } from '../lib/format';
  import { route, setQuery } from '../lib/router.svelte';

  let { id }: { id: string } = $props();

  interface Detail {
    id: number;
    steamId: string | null;
    steamId3: string | null;
    steamId2: string | null;
    alias: string | null;
    country: string | null;
    avatarHash: string | null;
    roleNames: string[];
    banNames: string[];
    isDeleted: boolean;
    bio: string | null;
    socials: Record<string, string>;
    stats: Record<string, number | null>;
    profileFetched: boolean;
    momentumCreatedAt: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    lastRefreshedAt: string | null;
    links: { momentum: string; steam: string | null };
    steam: {
      personaName: string | null;
      avatarHash: string | null;
      profileUrl: string | null;
      communityVisibilityState: number | null;
      timeCreated: string | null;
      locCountryCode: string | null;
      vacBanned: boolean | null;
      numberOfVacBans: number | null;
      numberOfGameBans: number | null;
      communityBanned: boolean | null;
      economyBan: string | null;
      daysSinceLastBan: number | null;
      lastRefreshedAt: string | null;
      lastSourcebansRefreshAt: string | null;
    } | null;
    counts: Record<string, number>;
    history: {
      source: string;
      field: string;
      oldValue: string | null;
      newValue: string | null;
      observedAt: string;
    }[];
    aliases: { name: string; source: string; firstSeen: string; lastSeen: string }[];
    avatars: {
      hash: string;
      source: string;
      firstSeen: string;
      lastSeen: string;
      archived: boolean;
      url: string;
    }[];
    statsHistory: {
      observedAt: string;
      cosXp: number | null;
      level: number | null;
      mapsCompleted: number | null;
      runsSubmitted: number | null;
      totalJumps: number | null;
      totalStrafes: number | null;
    }[];
    sourcebans: {
      server: string;
      banTimestamp: string;
      unbanTimestamp: string | null;
      currentState: string | null;
      banReason: string | null;
      unbanReason: string | null;
      nameAtBan: string | null;
    }[];
    credits: { map_id: number; map_name: string; type: number; description: string | null }[];
  }
  interface FollowEvent {
    id: number;
    followerId: number;
    followerAlias: string | null;
    followedId: number;
    followedAlias: string | null;
    event: string;
    observedAt: string;
  }

  let user = $state<Detail | null>(null);
  let runs = $state<Paged<RunRow> | null>(null);
  let followEvents = $state<FollowEvent[]>([]);
  let error = $state<string | null>(null);

  const gamemode = $derived(route.query.get('gamemode') ?? '');
  const style = $derived(route.query.get('style') ?? '');
  const removed = $derived(route.query.get('removed') ?? '');
  const page = $derived(Number(route.query.get('page') ?? '1'));

  $effect(() => {
    api<Detail>(`/api/users/${encodeURIComponent(id)}`)
      .then((u) => (user = u))
      .catch(
        (e) => (error = e.status === 404 ? 'User not found in the archive.' : String(e.message)),
      );
    api<Paged<FollowEvent>>(`/api/users/${encodeURIComponent(id)}/follow-events`, { take: 50 })
      .then((r) => (followEvents = r.data))
      .catch(() => undefined);
  });
  $effect(() => {
    api<Paged<RunRow>>(`/api/users/${encodeURIComponent(id)}/runs`, {
      gamemode,
      style,
      removed: removed === '' ? undefined : removed === 'true',
      page,
      take: 50,
    })
      .then((r) => (runs = r))
      .catch(() => undefined);
  });

  const sourceLabel: Record<string, string> = {
    momentum: 'Momentum',
    steam: 'Steam',
    steamhistory: 'SourceBans',
  };
</script>

{#if error}
  <h1>User</h1>
  <p class="error">{error}</p>
{:else if !user}
  <p class="muted">Loading...</p>
{:else}
  <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
    <Avatar hash={user.avatarHash} size="lg" alt="" />
    <div>
      <h1 style="margin-top:0">
        {user.alias ?? `user ${user.id}`}
        {#each user.roleNames as r (r)}<span class="badge accent">{r}</span>{/each}
        {#each user.banNames as b (b)}<span class="badge err">ban: {b}</span>{/each}
        {#if user.isDeleted}<span class="badge err">no longer visible on Momentum</span>{/if}
      </h1>
      <dl class="kv">
        <dt>Momentum id</dt>
        <dd class="mono">
          {user.id}
          <a href={user.links.momentum} rel="external noopener noreferrer nofollow" target="_blank"
            >profile</a
          >
        </dd>
        <dt>SteamID64</dt>
        <dd class="mono">
          {user.steamId ?? ''}
          {#if user.links.steam}<a
              href={user.links.steam}
              rel="external noopener noreferrer nofollow"
              target="_blank">steamcommunity</a
            >{/if}
        </dd>
        <dt>SteamID3 / 2</dt>
        <dd class="mono">{user.steamId3 ?? ''} / {user.steamId2 ?? ''}</dd>
        <dt>Country</dt>
        <dd>
          {user.country ??
            ''}{#if user.steam?.locCountryCode && user.steam.locCountryCode !== user.country}
            (steam: {user.steam.locCountryCode}){/if}
        </dd>
        <dt>Momentum account</dt>
        <dd class="mono">{formatDate(user.momentumCreatedAt)}</dd>
        <dt>Archive</dt>
        <dd class="small muted">
          first seen {formatDate(user.firstSeenAt)}, profile refreshed {relTime(
            user.lastRefreshedAt,
          )}
        </dd>
        {#if user.bio}<dt>Bio</dt>
          <dd>{user.bio}</dd>{/if}
        {#if Object.keys(user.socials).length}
          <dt>Socials</dt>
          <dd>
            {#each Object.entries(user.socials) as [k, v] (k)}
              {@const href = socialLink(k, v)}
              <span style="margin-right:0.75rem"
                >{k}: {#if href}<a {href} rel="noopener noreferrer nofollow" target="_blank">{v}</a
                  >{:else}{v}{/if}</span
              >
            {/each}
          </dd>
        {/if}
      </dl>
    </div>
  </div>

  <div class="cards">
    <div class="card">
      <h3>Runs archived</h3>
      <div class="big">{formatInt(user.counts.runs)}</div>
      <span class="muted small"
        >{formatInt(user.counts.removed_runs)} removed, {formatInt(user.counts.replays)} replays</span
      >
    </div>
    <div class="card">
      <h3>Leaderboard entries</h3>
      <div class="big">{formatInt(user.counts.leaderboard_entries)}</div>
      <span class="muted small">{formatInt(user.counts.world_records)} world records</span>
    </div>
    <div class="card">
      <h3>Followers / following</h3>
      <div class="big">{formatInt(user.counts.followers)} / {formatInt(user.counts.following)}</div>
    </div>
    <div class="card">
      <h3>Level</h3>
      <div class="big">{user.stats.level ?? '?'}</div>
      <span class="muted small"
        >{formatInt(user.stats.cosXp)} XP, {formatInt(user.stats.runsSubmitted)} runs submitted, {formatInt(
          user.stats.mapsCompleted,
        )} maps</span
      >
    </div>
  </div>

  <div class="two-col">
    <section>
      <h2>Aliases</h2>
      <p class="muted small">
        Momentum aliases observed by the archive, Steam persona names, and names recorded on
        SourceBans servers.
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Source</th><th>First seen</th><th>Last seen</th></tr></thead>
          <tbody>
            {#each user.aliases as a (a.source + a.name)}
              <tr
                ><td>{a.name}</td><td class="small">{sourceLabel[a.source] ?? a.source}</td><td
                  class="mono small">{formatDate(a.firstSeen, false)}</td
                ><td class="mono small">{formatDate(a.lastSeen, false)}</td></tr
              >
            {:else}
              <tr><td colspan="4" class="muted">No alias history.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <h2>Avatars</h2>
      <div class="gallery">
        {#each user.avatars as a (a.source + a.hash)}
          <figure>
            {#if a.archived}<img class="avatar lg" src={a.url} alt="" loading="lazy" />{:else}<span
                class="avatar lg"
                style="display:inline-block"
                title="not archived"
              ></span>{/if}
            <figcaption>
              {formatDate(a.firstSeen, false)}<br />{sourceLabel[a.source] ??
                a.source}{#if !a.archived}
                (not archived){/if}
            </figcaption>
          </figure>
        {:else}
          <p class="muted">No avatar history.</p>
        {/each}
      </div>

      {#if user.steam}
        <h2>Steam</h2>
        <dl class="kv">
          <dt>Persona</dt>
          <dd>{user.steam.personaName ?? ''}</dd>
          <dt>Visibility</dt>
          <dd>
            {user.steam.communityVisibilityState === 3
              ? 'public'
              : user.steam.communityVisibilityState === null
                ? ''
                : 'private or friends only'}
          </dd>
          <dt>Account created</dt>
          <dd class="mono">{formatDate(user.steam.timeCreated)}</dd>
          <dt>VAC</dt>
          <dd>{user.steam.vacBanned ? `banned (${user.steam.numberOfVacBans})` : 'none'}</dd>
          <dt>Game bans</dt>
          <dd>{user.steam.numberOfGameBans ?? 0}</dd>
          <dt>Community / economy</dt>
          <dd>
            {user.steam.communityBanned ? 'community banned' : 'ok'} / {user.steam.economyBan ??
              'none'}
          </dd>
          {#if user.steam.daysSinceLastBan}<dt>Days since last ban</dt>
            <dd>{user.steam.daysSinceLastBan}</dd>{/if}
          <dt>Refreshed</dt>
          <dd class="small muted">{relTime(user.steam.lastRefreshedAt)}</dd>
        </dl>
      {/if}

      <h2>SourceBans</h2>
      {#if user.sourcebans.length === 0}
        <p class="muted small">
          No SourceBans records{#if !user.steam?.lastSourcebansRefreshAt}
            (not checked yet or SteamHistory disabled){/if}.
        </p>
      {:else}
        <div class="table-wrap">
          <table>
            <thead
              ><tr
                ><th>Server</th><th>Name at ban</th><th>Reason</th><th>State</th><th>Banned</th><th
                  >Unbanned</th
                ></tr
              ></thead
            >
            <tbody>
              {#each user.sourcebans as b (b.server + b.banTimestamp)}
                <tr
                  ><td>{b.server}</td><td>{b.nameAtBan ?? ''}</td><td
                    >{b.banReason ?? ''}{#if b.unbanReason}
                      / {b.unbanReason}{/if}</td
                  ><td
                    ><span
                      class="badge"
                      class:err={b.currentState === 'Permanent' || b.currentState === 'Temp-Ban'}
                      >{b.currentState ?? '?'}</span
                    ></td
                  ><td class="mono small">{formatDate(b.banTimestamp, false)}</td><td
                    class="mono small">{formatDate(b.unbanTimestamp, false)}</td
                  ></tr
                >
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if user.credits.length}
        <h2>Map credits</h2>
        <ul>
          {#each user.credits as c (`${c.map_id}:${c.type}`)}
            <li>
              <a href={`/maps/${c.map_id}`}>{c.map_name}</a>
              <span class="muted small"
                >{['author', 'contributor', 'tester', 'special thanks'][c.type] ??
                  c.type}{#if c.description}: {c.description}{/if}</span
              >
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>Timeline</h2>
      <p class="muted small">
        Every field change the archive observed, Momentum and Steam side, newest first.
      </p>
      <ul class="timeline">
        {#each user.history as h (h.source + h.observedAt + h.field)}
          <li>
            <span class="when">{formatDate(h.observedAt)}</span>
            <span
              ><span class="badge">{h.source}</span>
              {fieldLabel(h.field)}: <span class="mono">{valueLabel(h.field, h.oldValue)}</span> to
              <span class="mono">{valueLabel(h.field, h.newValue)}</span></span
            >
          </li>
        {:else}
          <li><span class="when"></span><span class="muted">No changes observed yet.</span></li>
        {/each}
      </ul>

      <h2>Follow events</h2>
      <ul class="timeline">
        {#each followEvents as f (f.id)}
          <li>
            <span class="when">{formatDate(f.observedAt)}</span>
            <span
              ><a href={`/users/${f.followerId}`}>{f.followerAlias ?? f.followerId}</a>
              {f.event}
              <a href={`/users/${f.followedId}`}>{f.followedAlias ?? f.followedId}</a></span
            >
          </li>
        {:else}
          <li><span class="when"></span><span class="muted">No follow events observed.</span></li>
        {/each}
      </ul>

      <h2>Stats over time</h2>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>Observed</th><th class="num">Level</th><th class="num">XP</th><th class="num"
                >Maps</th
              ><th class="num">Runs</th><th class="num">Jumps</th><th class="num">Strafes</th></tr
            ></thead
          >
          <tbody>
            {#each user.statsHistory as s (s.observedAt)}
              <tr
                ><td class="mono small">{formatDate(s.observedAt, false)}</td><td class="num"
                  >{s.level ?? ''}</td
                ><td class="num">{formatInt(s.cosXp)}</td><td class="num"
                  >{formatInt(s.mapsCompleted)}</td
                ><td class="num">{formatInt(s.runsSubmitted)}</td><td class="num"
                  >{formatInt(s.totalJumps)}</td
                ><td class="num">{formatInt(s.totalStrafes)}</td></tr
              >
            {:else}
              <tr><td colspan="7" class="muted">No profile snapshots yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <h2>Runs</h2>
  <div class="filters">
    <label
      >mode
      <select
        value={gamemode}
        onchange={(e) => setQuery({ gamemode: (e.target as HTMLSelectElement).value, page: 1 })}
      >
        <option value="">any</option>
        {#each Object.entries(GAMEMODES) as [g, name] (g)}<option value={g}>{name}</option>{/each}
      </select>
    </label>
    <label
      >style
      <select
        value={style}
        onchange={(e) => setQuery({ style: (e.target as HTMLSelectElement).value, page: 1 })}
      >
        <option value="">any</option>
        {#each Object.entries(STYLES) as [s, name] (s)}<option value={s}>{name}</option>{/each}
      </select>
    </label>
    <label
      >removed
      <select
        value={removed}
        onchange={(e) => setQuery({ removed: (e.target as HTMLSelectElement).value, page: 1 })}
      >
        <option value="">any</option>
        <option value="true">removed only</option>
        <option value="false">present only</option>
      </select>
    </label>
  </div>
  {#if runs}
    <RunsTable runs={runs.data} showUser={false} />
    <Pager
      page={runs.page}
      take={runs.take}
      total={runs.total}
      onchange={(p) => setQuery({ page: p }, false)}
    />
  {/if}
{/if}
