<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import { api, type ChangeRow, type Paged } from '../lib/api';
  import { KIND_LABEL, type LedgerSummary } from '../lib/ledger';
  import {
    formatBytes,
    formatDate,
    formatInt,
    formatTime,
    gamemodeName,
    relTime,
    styleName,
    trackName,
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

  interface WrRow {
    userId: number | null;
    userAlias: string | null;
    userAvatarHash: string | null;
    mapId: number | null;
    mapName: string | null;
    runId: number | null;
    gamemode: number | null;
    trackType: number | null;
    trackNum: number | null;
    style: number | null;
    time: number | null;
    at: string;
  }

  let stats = $state<Stats | null>(null);
  let records = $state<WrRow[]>([]);
  let bans = $state<ChangeRow[]>([]);
  let ledger = $state<LedgerSummary[]>([]);
  let error = $state<string | null>(null);

  $effect(() => {
    api<Stats>('/api/stats')
      .then((s) => (stats = s))
      .catch((e) => (error = String(e.message)));
    api<Paged<WrRow>>('/api/records', { take: 30 })
      .then((r) => (records = r.data))
      .catch(() => undefined);
    api<Paged<ChangeRow>>('/api/changes', { type: 'ban', take: 8 })
      .then((c) => (bans = c.data))
      .catch(() => undefined);
    api<Paged<LedgerSummary>>('/api/ledger', { take: 4 })
      .then((l) => (ledger = l.data))
      .catch(() => undefined);
  });
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

{#if ledger.length}
  <section class="ledger">
    <h2>From the <a href="/ledger">Ledger</a></h2>
    <ul>
      {#each ledger as p (p.id)}
        <li>
          <span class="badge {p.kind === 'case' ? 'err' : p.kind === 'concern' ? 'warn' : 'accent'}"
            >{KIND_LABEL[p.kind]}</span
          >
          <a href={`/ledger/${p.slug}`}>{p.title}</a>
          <span class="muted small mono">{formatDate(p.publishedAt, false)}</span>
        </li>
      {/each}
    </ul>
  </section>
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
      <h2>Latest world records</h2>
      <ul class="timeline">
        {#each records as r (String(r.mapId) + String(r.gamemode) + String(r.trackType) + String(r.trackNum) + String(r.style) + String(r.userId))}
          <li>
            <span class="when">{relTime(r.at)}</span>
            <span>
              <Avatar hash={r.userAvatarHash} size="sm" />
              <a href={`/users/${r.userId}`}>{r.userAlias ?? `user ${r.userId}`}</a>
              <span class="mono">{formatTime(r.time)}</span>
              on <a href={`/maps/${r.mapId}`}>{r.mapName}</a>
              <span class="muted small"
                >{trackName(r.trackType ?? 0, r.trackNum ?? 1)}{#if r.style}, {styleName(
                    r.style,
                  )}{/if}{#if stats && stats.gamemodes.length > 1}, {gamemodeName(
                    r.gamemode,
                  )}{/if}</span
              >
              {#if r.runId}<a href={`/runs/${r.runId}`} class="mono small">#{r.runId}</a>{/if}
            </span>
          </li>
        {:else}
          <li>
            <span class="when"></span><span class="muted">No records recorded yet.</span>
          </li>
        {/each}
      </ul>
      <p class="muted small">
        The current first place of every leaderboard, newest first. A record set before the archive
        started watching carries Momentum's own date.
      </p>
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

<style>
  .ledger ul {
    list-style: none;
    padding: 0;
    margin: 0.3rem 0 1rem;
  }
  .ledger li {
    padding: 0.25rem 0;
  }
  .ledger .badge {
    margin: 0 0.4rem 0 0;
  }
</style>
