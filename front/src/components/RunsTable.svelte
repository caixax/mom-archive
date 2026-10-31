<script lang="ts">
  import type { RunRow } from '../lib/api';
  import { formatDate, formatTime, gamemodeName, styleName, trackName } from '../lib/format';
  import Identity from './Identity.svelte';
  import RunPanel from './RunPanel.svelte';

  let {
    runs,
    showUser = true,
    showMap = true,
    /** Whose runs these are, for the rows that do not carry a user of their own. */
    userId = null,
  }: { runs: RunRow[]; showUser?: boolean; showMap?: boolean; userId?: number | null } = $props();

  /** The one open run. One at a time keeps the page light. */
  let openRun = $state<number | null>(null);

  /** A click anywhere on the row opens it, except on something that was clickable already. */
  function toggleRow(id: number, ev: MouseEvent) {
    if ((ev.target as HTMLElement | null)?.closest('a, button, input, select')) return;
    openRun = openRun === id ? null : id;
  }

  // A board is gone from under an open row when the list itself changes.
  $effect(() => {
    const ids = new Set(runs.map((r) => r.id));
    if (openRun !== null && !ids.has(openRun)) openRun = null;
  });
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
        <th>Details</th>
        <th>Run</th>
        <th class="open" aria-label="Open"></th>
      </tr>
    </thead>
    <tbody>
      {#each runs as r (r.id)}
        <tr class:open={openRun === r.id} onclick={(ev) => toggleRow(r.id, ev)}>
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
            <a href={`/runs/${r.id}`}>details</a>
            {#if r.replayHash && !r.replayArchived}
              <span class="muted small" title="replay referenced but not archived"
                >replay not archived</span
              >
            {/if}
          </td>
          <td>
            <a href={`/runs/${r.id}`} class="mono small">#{r.id}</a>
            {#if r.isPb}<span class="badge accent">PB</span>{/if}
          </td>
          <td class="open">
            <button
              class="chev"
              aria-expanded={openRun === r.id}
              aria-label={openRun === r.id ? 'Close this run' : 'Open this run'}
              onclick={(ev) => {
                ev.stopPropagation();
                openRun = openRun === r.id ? null : r.id;
              }}>{openRun === r.id ? '-' : '+'}</button
            >
          </td>
        </tr>
        {#if openRun === r.id}
          {@const who = r.userId ?? userId}
          <tr class="details">
            <td colspan="12">
              {#if who === null}
                <p class="muted">This run has no player recorded, so there is nothing to open.</p>
              {:else}
                <RunPanel
                  userId={who}
                  mapId={r.mapId}
                  gamemode={r.gamemode}
                  trackType={r.trackType}
                  trackNum={r.trackNum}
                  style={r.style}
                  time={r.time}
                  replayHash={r.replayHash}
                  replayArchived={r.replayArchived}
                  pastRunId={r.id}
                />
              {/if}
            </td>
          </tr>
        {/if}
      {:else}
        <tr><td colspan="12" class="muted">No runs.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  /* The expander sits at the end of the row, and the whole row is clickable too. */
  th.open,
  td.open {
    width: 1.6rem;
    padding-left: 0;
    text-align: center;
  }
  button.chev {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-family: var(--mono);
    line-height: 1;
    padding: 0.05rem 0.3rem;
    cursor: pointer;
  }
  button.chev:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  tbody tr.open {
    background: var(--bg-2);
  }
  tbody tr.open button.chev {
    color: var(--accent);
    border-color: var(--accent);
  }
  tbody tr.details:hover {
    background: none;
  }
  tr.details > td {
    padding: 0;
    border-bottom: 1px solid var(--border);
  }
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
