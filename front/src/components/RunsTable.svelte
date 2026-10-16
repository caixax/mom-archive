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
        <th class="flag" aria-label="State"></th>
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
        <tr>
          <td class="flag">
            {#if r.removedAt}
              <!-- Marked, not struck through: the run is gone upstream, not less real. -->
              <span
                class="gone"
                title={r.removalKind === 'deleted'
                  ? `Run deleted upstream (${formatDate(r.removedAt)})`
                  : `Leaderboard entry removed upstream (${formatDate(r.removedAt)})`}
                aria-label="removed upstream"
              >
                {#if r.removalKind === 'deleted'}
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
                    ><path
                      fill="currentColor"
                      d="M6 1h4l1 1h3v2H2V2h3zM3 5h10l-.8 9.1A1 1 0 0 1 11.2 15H4.8a1 1 0 0 1-1-.9zm3 2v6h1V7zm3 0v6h1V7z"
                    /></svg
                  >
                {:else}
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
                    ><path
                      fill="currentColor"
                      d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1m0 1.5A5.5 5.5 0 0 1 12.2 11L5 3.8A5.4 5.4 0 0 1 8 2.5m-4.2 2L11 11.7A5.5 5.5 0 0 1 3.8 4.5"
                    /></svg
                  >
                {/if}
              </span>
            {/if}
          </td>
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
              <a href={`/watch/${r.replayHash}`}>view</a>
              <span class="muted">/</span>
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
          </td>
        </tr>
      {:else}
        <tr><td colspan="11" class="muted">No runs.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  th.flag,
  td.flag {
    width: 1.4rem;
    padding-right: 0;
    text-align: center;
  }
  .gone {
    color: var(--removed);
    display: inline-flex;
    vertical-align: middle;
    cursor: help;
  }
</style>
