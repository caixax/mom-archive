<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import { api, type ChangeRow, type Paged } from '../lib/api';
  import {
    fieldLabel,
    formatBytes,
    formatDate,
    formatInt,
    relTime,
    valueLabel,
  } from '../lib/format';

  interface Stats {
    since: string | null;
    gamemodes: { id: number; name: string }[];
    totals: Record<string, number>;
    lastSuccessfulTick: {
      job: string;
      finishedAt: string;
      itemsSeen: number;
      itemsNew: number;
      apiCalls: number;
    }[];
    apiCallsLastHour: number;
    storage: { total?: number; bytes?: number; updatedAt?: string } | null;
  }

  let stats = $state<Stats | null>(null);
  let changes = $state<ChangeRow[]>([]);
  let bans = $state<ChangeRow[]>([]);
  let error = $state<string | null>(null);

  $effect(() => {
    api<Stats>('/api/stats')
      .then((s) => (stats = s))
      .catch((e) => (error = String(e.message)));
    api<Paged<ChangeRow>>('/api/changes', { take: 40 })
      .then((c) => (changes = c.data))
      .catch(() => undefined);
    api<Paged<ChangeRow>>('/api/changes', { type: 'ban', take: 8 })
      .then((c) => (bans = c.data))
      .catch(() => undefined);
  });

  const typeLabel: Record<string, string> = {
    alias: 'rename',
    avatar: 'avatar',
    ban: 'ban',
    role: 'role',
    removed_run: 'run removed',
    steam_name: 'steam name',
    steam_avatar: 'steam avatar',
    vac: 'steam ban',
    new_wr: 'new WR',
    deleted_user: 'account hidden',
    map: 'map',
  };
</script>

<h1>Momentum Mod archive</h1>
<p class="muted">
  A read only mirror of Momentum Mod leaderboards, replays and user history for
  {#if stats}{stats.gamemodes.map((g) => g.name).join(', ')}{:else}Bhop HL1{/if}.
  {#if stats?.since}
    Watching since <span class="mono">{formatDate(stats.since)}</span>. Anything that happened
    before that date is unknown to this archive.
  {/if}
</p>

{#if error}
  <p class="error">Could not load stats: {error}</p>
{/if}

{#if stats}
  <div class="cards">
    <div class="card">
      <h3>Users</h3>
      <div class="big">{formatInt(stats.totals.users)}</div>
    </div>
    <div class="card">
      <h3>Maps</h3>
      <div class="big">{formatInt(stats.totals.maps)}</div>
      <span class="muted small"
        >{formatInt(stats.totals.archived_maps)} with an archived leaderboard</span
      >
    </div>
    <div class="card">
      <h3>Runs</h3>
      <div class="big">{formatInt(stats.totals.runs)}</div>
      <span class="muted small">{formatInt(stats.totals.removed_runs)} removed upstream</span>
    </div>
    <div class="card">
      <h3>Replays</h3>
      <div class="big">{formatInt(stats.totals.replays)}</div>
      <span class="muted small"
        >{formatBytes(stats.totals.replay_bytes)}, {formatInt(stats.totals.replays_lost)} lost before
        fetch</span
      >
    </div>
    <div class="card">
      <h3>Leaderboard entries</h3>
      <div class="big">{formatInt(stats.totals.leaderboard_entries)}</div>
      <span class="muted small">{formatInt(stats.totals.leaderboards)} leaderboards</span>
    </div>
    <div class="card">
      <h3>Recorded changes</h3>
      <div class="big">
        {formatInt((stats.totals.user_changes ?? 0) + (stats.totals.steam_changes ?? 0))}
      </div>
      <span class="muted small"
        >{formatInt(stats.totals.avatars)} avatars archived, {formatInt(stats.totals.sourcebans)} SourceBans</span
      >
    </div>
  </div>

  <div class="two-col">
    <section>
      <h2>Recent changes</h2>
      <ul class="timeline">
        {#each changes as c (c.type + c.at + String(c.userId) + String(c.runId) + c.field)}
          <li>
            <span class="when">{relTime(c.at)}</span>
            <span>
              <span class="badge">{typeLabel[c.type] ?? c.type}</span>
              {#if c.userId}
                <Avatar hash={c.userAvatarHash} size="sm" />
                <a href={`/users/${c.userId}`}>{c.userAlias ?? `user ${c.userId}`}</a>
              {/if}
              {#if c.type === 'removed_run'}
                run <a href={`/runs/${c.runId}`} class="mono">#{c.runId}</a> on
                <a href={`/maps/${c.mapId}`}>{c.mapName}</a> disappeared from the leaderboard
              {:else if c.type === 'new_wr'}
                set a world record on <a href={`/maps/${c.mapId}`}>{c.mapName}</a> (<a
                  href={`/runs/${c.runId}`}
                  class="mono">#{c.runId}</a
                >)
              {:else if c.type === 'map'}
                <a href={`/maps/${c.mapId}`}>{c.mapName}</a>: {fieldLabel(c.field)}
                <span class="mono">{valueLabel(c.field, c.oldValue)}</span>
                to <span class="mono">{valueLabel(c.field, c.newValue)}</span>
              {:else}
                {fieldLabel(c.field)}: <span class="mono">{valueLabel(c.field, c.oldValue)}</span>
                to <span class="mono">{valueLabel(c.field, c.newValue)}</span>
              {/if}
            </span>
          </li>
        {:else}
          <li><span class="when"></span><span class="muted">No changes recorded yet.</span></li>
        {/each}
      </ul>
    </section>
    <div>
      <section>
        <h2>Latest bans</h2>
        <ul class="timeline">
          {#each bans as b (String(b.userId) + b.at)}
            <li>
              <span class="when">{relTime(b.at)}</span>
              <span>
                <Avatar hash={b.userAvatarHash} size="sm" />
                <a href={`/users/${b.userId}`}>{b.userAlias ?? `user ${b.userId}`}</a>
                <span class="mono">{valueLabel('bans', b.oldValue)}</span>
                to <span class="mono">{valueLabel('bans', b.newValue)}</span>
              </span>
            </li>
          {:else}
            <li>
              <span class="when"></span><span class="muted"
                >No ban changes observed yet. Bans applied before the archive started watching only
                show on the user pages.</span
              >
            </li>
          {/each}
        </ul>
        <p class="muted small"><a href="/users?banned=true">All banned players</a></p>
      </section>
      <section>
        <h2>Last successful poll per job</h2>
        <div class="table-wrap">
          <table>
            <thead
              ><tr
                ><th>Job</th><th>Finished</th><th class="num">Seen</th><th class="num">New</th><th
                  class="num">API calls</th
                ></tr
              ></thead
            >
            <tbody>
              {#each stats.lastSuccessfulTick as t (t.job)}
                <tr
                  ><td>{t.job}</td><td class="mono small" title={formatDate(t.finishedAt)}
                    >{relTime(t.finishedAt)}</td
                  ><td class="num">{t.itemsSeen}</td><td class="num">{t.itemsNew}</td><td
                    class="num">{t.apiCalls}</td
                  ></tr
                >
              {:else}
                <tr><td colspan="5" class="muted">No polls yet.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="muted small">
          {formatInt(stats.apiCallsLastHour)} Momentum API calls in the last hour.
          <a href="/status">Full status</a>.
        </p>
      </section>
    </div>
  </div>
{/if}
