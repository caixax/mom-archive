<script lang="ts">
  import { api } from '../lib/api';
  import {
    formatBytes,
    formatDate,
    formatTime,
    gamemodeName,
    styleName,
    trackName,
  } from '../lib/format';

  let { sha1 }: { sha1: string } = $props();

  interface MapBsp {
    url: string;
    bspHash: string;
    versionNum: number;
    exactVersion: boolean;
    archived: boolean;
  }
  interface ReplayMeta {
    sha1: string;
    bytes: number;
    downloadedAt: string;
    header: Record<string, unknown> | null;
    headerOk: boolean;
    headerIssues: string[];
    headerPlayerName: string | null;
    mapBsp: MapBsp | null;
    pastRunId: number | null;
    userId: number | null;
    currentAlias: string | null;
    mapId: number | null;
    mapName: string | null;
    gamemode: number | null;
    trackType: number | null;
    trackNum: number | null;
    style: number | null;
    runTime: number | null;
    observedAlias: string | null;
    observedSteamName: string | null;
    downloadUrl: string;
  }

  let meta = $state<ReplayMeta | null>(null);
  let error = $state<string | null>(null);
  let playerError = $state<string | null>(null);
  let status = $state('');
  let host = $state<HTMLDivElement | null>(null);

  const webgl2 =
    typeof document === 'undefined'
      ? true
      : Boolean(document.createElement('canvas').getContext('webgl2'));

  $effect(() => {
    error = null;
    api<ReplayMeta>(`/api/replays/${sha1}`)
      .then((m) => (meta = m))
      .catch((e) => (error = String(e.message)));
  });

  // The player is a few hundred kilobytes of WebGL2 renderer, so it is only
  // fetched when someone actually opens a replay.
  $effect(() => {
    const el = host;
    const m = meta;
    if (!el || !m || !m.mapBsp || !webgl2) return;
    let destroyed = false;
    let player: { destroy(): void } | null = null;
    status = 'loading the player';
    void (async () => {
      try {
        const { createPlayer } = await import('@caixax/momtv-player');
        if (destroyed) return;
        status = 'reading the replay and the map';
        player = createPlayer(el, {
          replay: m.downloadUrl,
          map: m.mapBsp!.url,
          autoplay: true,
          onError: (e: Error) => {
            playerError = e.message;
            status = '';
          },
          onLoadStatus: (stage: string, done: number, total: number) => {
            status = total > 0 ? `${stage} ${done}/${total}` : stage;
          },
        });
        status = '';
      } catch (e) {
        playerError = e instanceof Error ? e.message : String(e);
        status = '';
      }
    })();
    return () => {
      destroyed = true;
      player?.destroy();
    };
  });
</script>

<h1>Replay</h1>

{#if error}
  <p class="error">{error}</p>
{:else if meta}
  <p class="muted">
    {#if meta.mapId}<a href={`/maps/${meta.mapId}`}>{meta.mapName}</a>{:else}{meta.mapName ??
        'unknown map'}{/if}
    {#if meta.userId}
      by <a href={`/users/${meta.userId}`}
        >{meta.observedAlias ?? meta.currentAlias ?? `user ${meta.userId}`}</a
      >
    {/if}
    {#if meta.runTime !== null}
      in <span class="mono">{formatTime(meta.runTime)}</span>
    {/if}
    <span class="small"
      >({gamemodeName(meta.gamemode)}, {trackName(meta.trackType ?? 0, meta.trackNum ?? 1)}, {styleName(
        meta.style,
      )})</span
    >
    {#if meta.pastRunId}
      <a href={`/runs/${meta.pastRunId}`} class="mono small">#{meta.pastRunId}</a>
    {/if}
  </p>

  {#if !webgl2}
    <p class="notice">
      This browser has no WebGL2, so the replay cannot be drawn here. The file itself is fine:
      download it and open it from the MomentumTV menu in game.
    </p>
  {:else if !meta.mapBsp}
    <p class="notice">
      The archive has no copy of this map's geometry, so there is nothing to draw the run on. The
      replay file is intact and downloadable; playback needs the map it was recorded on.
    </p>
  {:else if playerError}
    <p class="error">Playback failed: {playerError}</p>
  {/if}

  {#if webgl2 && meta.mapBsp}
    <div class="stage">
      <div class="player" bind:this={host}></div>
      {#if status}<p class="status mono small">{status}</p>{/if}
    </div>
    {#if !meta.mapBsp.exactVersion}
      <p class="notice">
        The map changed since this run was recorded. This is version {meta.mapBsp.versionNum}, not
        the one the replay was made on, so the geometry may not match what the runner played.
      </p>
    {/if}
    <p class="muted small">
      Unofficial in browser playback with
      <a href="https://github.com/caixax/momtv.js" rel="external noopener noreferrer nofollow"
        >momtv.js</a
      >. Materials the map does not pack itself are drawn as flat colours: the archive serves no
      game files. Map version {meta.mapBsp.versionNum}, {meta.mapBsp.archived
        ? 'served from the archive'
        : 'streamed from the official CDN'}.
    </p>
  {/if}

  <p>
    <a href={meta.downloadUrl} rel="external" download
      ><button class="primary">Download .momtv ({formatBytes(meta.bytes)})</button></a
    >
    {#if meta.pastRunId}<a href={`/runs/${meta.pastRunId}`}><button>Run details</button></a>{/if}
  </p>
  <p class="muted small">
    sha1 <span class="mono">{meta.sha1}</span>, archived {formatDate(meta.downloadedAt)}.
    {#if meta.headerPlayerName && meta.headerPlayerName !== meta.observedAlias}
      The game wrote <span class="mono">{meta.headerPlayerName}</span> into the file.
    {/if}
    {#if !meta.headerOk}
      Header did not match the run: {meta.headerIssues.join('; ') || 'unparseable header'}.
    {/if}
  </p>
{:else}
  <p class="muted">Loading.</p>
{/if}

<style>
  .stage {
    position: relative;
    margin: 0.5rem 0 1rem;
  }
  .player {
    height: min(70vh, 620px);
    min-height: 320px;
    background: #000;
    border: 1px solid var(--border);
  }
  .status {
    position: absolute;
    left: 0.6rem;
    bottom: 0.5rem;
    margin: 0;
    padding: 0.1rem 0.4rem;
    background: rgb(0 0 0 / 65%);
    color: var(--muted);
    pointer-events: none;
  }
</style>
