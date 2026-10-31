<script lang="ts">
  // The replay, played in the page it belongs to.
  //
  // Nothing is downloaded until someone presses play: the renderer is its own
  // chunk and the map is a file of its own, so a page that merely mentions a
  // replay costs nothing. Once started it behaves like the watch page.
  import { api } from '../lib/api';
  import { formatInt } from '../lib/format';
  import { gameAssets } from '../lib/game-assets';

  export interface MapBsp {
    url: string;
    bspHash: string;
    versionNum: number;
    exactVersion: boolean;
    archived: boolean;
  }

  interface Props {
    sha1: string;
    /** The bytes, when the page already has them. Saves fetching the file twice. */
    bytes?: ArrayBuffer | null;
    /** Passed in when the page knows it; fetched here otherwise. */
    mapBsp?: MapBsp | null;
    height?: string;
  }
  let { sha1, bytes = null, mapBsp = null, height = 'min(70vh, 620px)' }: Props = $props();

  /** Filled from the prop when the page knows it, asked for otherwise. */
  let fetched = $state<MapBsp | null>(null);
  const resolved = $derived(mapBsp ?? fetched);
  let playing = $state(false);
  let status = $state('');
  let error = $state<string | null>(null);
  let host = $state<HTMLDivElement | null>(null);

  /** True once one of the two sources has answered. */
  let asked = $state(false);

  const webgl2 =
    typeof document === 'undefined'
      ? true
      : Boolean(document.createElement('canvas').getContext('webgl2'));

  $effect(() => {
    if (mapBsp) {
      asked = true;
      return;
    }
    api<{ mapBsp: MapBsp | null }>(`/api/replays/${sha1}`)
      .then((m) => (fetched = m.mapBsp))
      .catch(() => (fetched = null))
      .finally(() => (asked = true));
  });

  $effect(() => {
    const el = host;
    const map = resolved;
    if (!playing || !el || !map || !webgl2) return;
    let dropped = false;
    let player: { destroy(): void } | null = null;
    status = 'loading the player';
    void (async () => {
      try {
        const [{ createPlayer }, assets] = await Promise.all([
          import('@caixax/momtv-player'),
          gameAssets(),
        ]);
        if (dropped) return;
        status = 'reading the replay and the map';
        player = createPlayer(el, {
          ...assets,
          replay: bytes ?? `/api/replays/${sha1}/download`,
          map: map.url,
          autoplay: true,
          onError: (e: Error) => {
            error = e.message;
            status = '';
          },
          onLoadStatus: (stage: string, done: number, total: number) => {
            status = total > 0 ? `${stage} ${formatInt(done)}/${formatInt(total)}` : stage;
          },
        });
        status = '';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        status = '';
      }
    })();
    return () => {
      dropped = true;
      player?.destroy();
    };
  });
</script>

{#if !webgl2}
  <p class="notice">
    This browser has no WebGL2, so the replay cannot be drawn here. The file itself is fine:
    download it and open it from the MomentumTV menu in game.
  </p>
{:else if !resolved}
  {#if asked}
    <p class="notice">
      The archive has no copy of this map's geometry, so there is nothing to draw the run on. The
      replay file is intact and downloadable; playback needs the map it was recorded on.
    </p>
  {:else}
    <p class="muted">Looking for the map this run was recorded on.</p>
  {/if}
{:else}
  <div class="stage" style={`--stage-height:${height}`}>
    {#if playing}
      <div class="screen" bind:this={host}></div>
      {#if status}<p class="status mono small">{status}</p>{/if}
    {:else}
      <button class="screen start" onclick={() => (playing = true)}>
        <span class="play" aria-hidden="true">&#9654;</span>
        <span>Play the replay here</span>
        <span class="muted small">
          Map version {resolved.versionNum}{resolved.exactVersion
            ? ', the one this run was recorded on'
            : ', not the one this run was recorded on'}
        </span>
      </button>
    {/if}
  </div>
  {#if error}<p class="error">Playback failed: {error}</p>{/if}
  {#if playing && !resolved.exactVersion}
    <p class="notice">
      The map changed since this run was recorded. This is version {resolved.versionNum}, not the
      one the replay was made on, so the geometry may not match what the runner played.
    </p>
  {/if}
{/if}

<style>
  .stage {
    position: relative;
    margin: 0.5rem 0;
  }
  .screen {
    display: block;
    width: 100%;
    height: var(--stage-height);
    min-height: 320px;
    background: #000;
    border: 1px solid var(--border);
  }
  button.start {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button.start:hover {
    border-color: var(--accent);
  }
  .play {
    font-size: 2rem;
    color: var(--accent);
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
