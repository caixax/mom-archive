<script lang="ts">
  import Identity from '../components/Identity.svelte';
  import { api } from '../lib/api';
  import {
    formatBytes,
    formatDate,
    formatTime,
    gamemodeName,
    styleName,
    trackName,
  } from '../lib/format';

  let { id }: { id: string } = $props();

  interface Detail {
    id: number;
    userId: number;
    userAlias: string | null;
    userAvatarHash: string | null;
    steamId: string | null;
    mapId: number;
    mapName: string;
    mapStatus: number;
    gamemode: number;
    trackType: number;
    trackNum: number;
    style: number;
    time: number;
    flags: number[] | null;
    isPb: boolean;
    rank: number | null;
    replayHash: string | null;
    replayArchived: boolean;
    momentumCreatedAt: string;
    firstSeenAt: string;
    lastSeenAt: string;
    removedAt: string | null;
    removalKind: string | null;
    entryRemovedAt: string | null;
    observedAlias: string | null;
    observedAvatarHash: string | null;
    observedSteamName: string | null;
    splits: unknown;
    replay: {
      sha1: string;
      bytes: number;
      downloadedAt: string;
      header: Record<string, unknown> | null;
      headerOk: boolean;
      headerIssues: string[];
      headerPlayerName: string | null;
      downloadUrl: string;
    } | null;
    replayFailure: {
      attempts: number;
      lastStatus: number | null;
      lastError: string | null;
      gaveUp: boolean;
      lastFailedAt: string;
    } | null;
    links: { momentumMap: string; momentumUser: string };
  }

  let run = $state<Detail | null>(null);
  let error = $state<string | null>(null);
  let showSplits = $state(false);

  $effect(() => {
    api<Detail>(`/api/runs/${encodeURIComponent(id)}`)
      .then((r) => (run = r))
      .catch(
        (e) => (error = e.status === 404 ? 'Run not found in the archive.' : String(e.message)),
      );
  });
</script>

{#if error}
  <h1>Run</h1>
  <p class="error">{error}</p>
{:else if !run}
  <p class="muted">Loading...</p>
{:else}
  <h1>
    Run <span class="mono">#{run.id}</span>
    {#if run.isPb}<span class="badge accent">current PB</span>{/if}
    {#if run.removedAt}<span class="badge removed"
        >{run.removalKind === 'deleted' ? 'deleted upstream' : 'removed from leaderboard'}</span
      >{/if}
    <a class="small report-link" href={`/report?run=${run.id}`}>report</a>
  </h1>
  <dl class="kv">
    <dt>Player</dt>
    <dd>
      <Identity
        userId={run.userId}
        observedAlias={run.observedAlias}
        observedAvatarHash={run.observedAvatarHash}
        currentAlias={run.userAlias}
        currentAvatarHash={run.userAvatarHash}
        steamName={run.observedSteamName}
      />
    </dd>
    <dt>Map</dt>
    <dd>
      <a href={`/maps/${run.mapId}`}>{run.mapName}</a>
      <a
        href={run.links.momentumMap}
        rel="external noopener noreferrer nofollow"
        target="_blank"
        class="small">(momentum-mod.org)</a
      >
    </dd>
    <dt>Mode</dt>
    <dd>
      {gamemodeName(run.gamemode)}, {trackName(run.trackType, run.trackNum)}, {styleName(run.style)}
    </dd>
    <dt>Time</dt>
    <dd class="mono">{formatTime(run.time)} <span class="muted small">({run.time} s)</span></dd>
    <dt>Rank</dt>
    <dd class="mono">{run.rank ?? 'not on the leaderboard'}</dd>
    <dt>Submitted</dt>
    <dd class="mono">{formatDate(run.momentumCreatedAt)}</dd>
    <dt>Archived</dt>
    <dd class="small muted">
      first seen {formatDate(run.firstSeenAt)}, last confirmed {formatDate(run.lastSeenAt)}
    </dd>
    {#if run.removedAt}<dt>Removed</dt>
      <dd class="mono">
        {formatDate(run.removedAt)}{#if run.entryRemovedAt && run.entryRemovedAt !== run.removedAt}
          (entry: {formatDate(run.entryRemovedAt)}){/if}
      </dd>{/if}
    {#if run.flags && run.flags.length}<dt>Flags</dt>
      <dd class="mono">{run.flags.join(', ')}</dd>{/if}
  </dl>

  <h2>Replay</h2>
  {#if run.replay}
    <p>
      <a href={`/watch/${run.replay.sha1}`}><button class="primary">View demo</button></a>
      <a class="button" href={run.replay.downloadUrl} rel="external" download
        ><button>Download .momtv ({formatBytes(run.replay.bytes)})</button></a
      >
      <span class="muted small"
        >sha1 <span class="mono">{run.replay.sha1}</span>, archived {formatDate(
          run.replay.downloadedAt,
        )}</span
      >
    </p>
    {#if !run.replay.headerOk}
      <p class="notice">
        Header did not match the run: {run.replay.headerIssues.join('; ') || 'unparseable header'}.
        The bytes are kept as downloaded.
      </p>
    {/if}
    {#if run.replay.header}
      <dl class="kv">
        {#each Object.entries(run.replay.header) as [k, v] (k)}
          <dt>{k}</dt>
          <dd class="mono">
            {k === 'timestamp' && typeof v === 'number'
              ? formatDate(new Date(v).toISOString())
              : String(v)}
          </dd>
        {/each}
      </dl>
      {#if run.replay.headerPlayerName && run.replay.headerPlayerName !== run.observedAlias}
        <p class="muted small">
          The game wrote the player name as <span class="mono">{run.replay.headerPlayerName}</span> when
          the replay was recorded.
        </p>
      {/if}
    {/if}
    <p class="muted small">
      How to watch: put the file in your Momentum Mod replay folder and open it from the MomentumTV
      menu in game. In browser playback is not possible; the frame format is not public.
    </p>
  {:else if run.replayHash}
    <p class="notice">
      A replay <span class="mono">{run.replayHash}</span> existed for this run but is not archived.
      {#if run.replayFailure}
        Last attempt {formatDate(run.replayFailure.lastFailedAt)}: {run.replayFailure.lastStatus ===
        404
          ? 'the CDN had already deleted it'
          : (run.replayFailure.lastError ?? 'failed')}{run.replayFailure.gaveUp
          ? ' (gave up)'
          : ' (will retry)'}.
      {:else}
        It is queued for download.
      {/if}
    </p>
  {:else}
    <p class="muted">
      No replay. Momentum only stores a replay for the current personal best of each leaderboard;
      this run was never one, or it was already replaced when the archive first saw it.
    </p>
  {/if}

  {#if run.splits}
    <h2>
      Splits <button onclick={() => (showSplits = !showSplits)}
        >{showSplits ? 'hide' : 'show'}</button
      >
    </h2>
    {#if showSplits}<pre>{JSON.stringify(run.splits, null, 2)}</pre>{/if}
  {/if}
{/if}
