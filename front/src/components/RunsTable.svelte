<script lang="ts">
  import type { RunRow } from '../lib/api';
  import { formatDate, formatTime, gamemodeName, styleName, trackName } from '../lib/format';
  import Identity from './Identity.svelte';

  let {
    runs,
    showUser = true,
    showMap = true,
  }: { runs: RunRow[]; showUser?: boolean; showMap?: boolean } = $props();
</script>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Date</th>
        {#if showUser}<th>Player (at the time)</th>{/if}
        {#if showMap}<th>Map</th>{/if}
        <th>Mode</th>
        <th>Track</th>
        <th>Style</th>
        <th class="num">Time</th>
        <th class="num">Rank</th>
        <th>Replay</th>
        <th>Run</th>
      </tr>
    </thead>
    <tbody>
      {#each runs as r (r.id)}
        <tr class:removed={r.removedAt !== null}>
          <td class="mono small">{formatDate(r.momentumCreatedAt)}</td>
          {#if showUser}
            <td
              ><Identity
                userId={r.userId}
                observedAlias={r.observedAlias}
                observedAvatarHash={r.observedAvatarHash}
                currentAlias={r.userAlias}
                steamName={r.observedSteamName}
              /></td
            >
          {/if}
          {#if showMap}
            <td><a href={`/maps/${r.mapId}`}>{r.mapName}</a></td>
          {/if}
          <td>{gamemodeName(r.gamemode)}</td>
          <td>{trackName(r.trackType, r.trackNum)}</td>
          <td>{styleName(r.style)}</td>
          <td class="num">{formatTime(r.time)}</td>
          <td class="num">{r.rank ?? ''}</td>
          <td>
            {#if r.replayHash && r.replayArchived}
              <a href={`/api/replays/${r.replayHash}/download`} rel="external" download>download</a>
            {:else if r.replayHash}
              <span class="muted small" title="replay referenced but not archived"
                >not archived</span
              >
            {:else}
              <span class="muted small">none</span>
            {/if}
          </td>
          <td>
            <a href={`/runs/${r.id}`} class="mono small">#{r.id}</a>
            {#if r.isPb}<span class="badge accent">PB</span>{/if}
            {#if r.removedAt}<span
                class="badge removed"
                title={r.removalKind === 'deleted'
                  ? 'run deleted upstream'
                  : 'leaderboard entry removed'}
                >{r.removalKind === 'deleted' ? 'deleted' : 'removed'}</span
              >{/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="10" class="muted">No runs.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
