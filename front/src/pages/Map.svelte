<script lang="ts">
  import Identity from '../components/Identity.svelte';
  import Pager from '../components/Pager.svelte';
  import { api, type LeaderboardEntry } from '../lib/api';
  import {
    fieldLabel,
    formatDate,
    formatInt,
    formatTime,
    gamemodeName,
    lbTypeName,
    relTime,
    styleName,
    trackName,
    valueLabel,
  } from '../lib/format';
  import { route, setQuery } from '../lib/router.svelte';

  let { idOrName }: { idOrName: string } = $props();

  interface Board {
    gamemode: number;
    gamemodeName: string;
    trackType: number;
    trackNum: number;
    style: number;
    tier: number | null;
    tags: number[];
    type: number | null;
    typeName: string | null;
    linear: boolean | null;
    entryCount: number | null;
    currentEntries: number;
    lastRefreshedAt: string | null;
    removedAt: string | null;
  }
  interface MapDetail {
    id: number;
    name: string;
    status: number;
    statusName: string;
    bucket: string;
    submitterId: number | null;
    submitterAlias: string | null;
    description: string | null;
    youtubeId: string | null;
    creationDate: string | null;
    approvedDate: string | null;
    nativeGamemodeNames: string[];
    stats: Record<string, number | null>;
    counts: { runs: number; removed_runs: number; replays: number };
    links: { momentum: string };
    firstSeenAt: string;
    lastRefreshedAt: string | null;
    notFoundAt: string | null;
    leaderboards: Board[];
    versions: {
      id: string;
      versionNum: number;
      changelog: string | null;
      bspHash: string | null;
      zoneHash: string | null;
      downloadUrl: string | null;
      submitterId: number | null;
      submitterAlias: string | null;
      momentumCreatedAt: string | null;
      firstSeenAt: string;
      bspArchived: boolean;
    }[];
    images: {
      id: string;
      archived: boolean;
      url: string | null;
      firstSeenAt: string;
      removedAt: string | null;
    }[];
    credits: {
      userId: number;
      alias: string | null;
      type: number;
      description: string | null;
      removedAt: string | null;
    }[];
    history: {
      field: string;
      oldValue: string | null;
      newValue: string | null;
      observedAt: string;
    }[];
  }
  interface BoardResponse {
    total: number;
    page: number;
    take: number;
    data: LeaderboardEntry[];
    at: string | null;
    observation: { id: number; observedAt: string; validUntil: string; entryCount: number } | null;
    leaderboard: { lastRefreshedAt: string | null; entryCount: number | null } | null;
    note?: string;
  }

  let map = $state<MapDetail | null>(null);
  let board = $state<BoardResponse | null>(null);
  let observations = $state<
    { id: number; observedAt: string; validUntil: string; entryCount: number }[]
  >([]);
  let error = $state<string | null>(null);
  let boardError = $state<string | null>(null);

  const creditType: Record<number, string> = {
    0: 'Author',
    1: 'Contributor',
    2: 'Tester',
    3: 'Special thanks',
  };

  const gm = $derived(Number(route.query.get('gamemode') ?? '3'));
  const tt = $derived(Number(route.query.get('trackType') ?? '0'));
  const tn = $derived(Number(route.query.get('trackNum') ?? '1'));
  const st = $derived(Number(route.query.get('style') ?? '0'));
  const at = $derived(route.query.get('at') ?? '');
  const page = $derived(Number(route.query.get('page') ?? '1'));
  let atInput = $state('');

  $effect(() => {
    api<MapDetail>(`/api/maps/${encodeURIComponent(idOrName)}`)
      .then((m) => (map = m))
      .catch(
        (e) => (error = e.status === 404 ? 'Map not found in the archive.' : String(e.message)),
      );
  });

  $effect(() => {
    if (!map) return;
    const id = map.id;
    atInput = at ? at.slice(0, 16) : '';
    boardError = null;
    api<BoardResponse>(`/api/maps/${id}/leaderboard`, {
      gamemode: gm,
      trackType: tt,
      trackNum: tn,
      style: st,
      at: at ? new Date(at).toISOString() : undefined,
      page,
      take: 100,
    })
      .then((b) => (board = b))
      .catch((e) => (boardError = String(e.message)));
    api<{ data: typeof observations }>(`/api/maps/${id}/leaderboard/observations`, {
      gamemode: gm,
      trackType: tt,
      trackNum: tn,
      style: st,
    })
      .then((o) => (observations = o.data))
      .catch(() => (observations = []));
  });

  function selectBoard(b: Board) {
    setQuery(
      {
        gamemode: b.gamemode,
        trackType: b.trackType,
        trackNum: b.trackNum,
        style: b.style,
        page: 1,
      },
      false,
    );
  }
  function applyAt(e: Event) {
    e.preventDefault();
    if (!atInput) {
      setQuery({ at: null, page: 1 }, false);
      return;
    }
    const d = new Date(atInput);
    if (Number.isNaN(d.getTime())) return;
    setQuery({ at: d.toISOString(), page: 1 }, false);
  }
  const boardsForMode = $derived((map?.leaderboards ?? []).filter((b) => b.gamemode === gm));
  const otherModes = $derived(
    [...new Set((map?.leaderboards ?? []).map((b) => b.gamemode))].sort((a, b) => a - b),
  );
</script>

{#if error}
  <h1>Map</h1>
  <p class="error">{error}</p>
{:else if !map}
  <p class="muted">Loading...</p>
{:else}
  <h1>
    {map.name}
    <span class="badge">{map.statusName}</span>
    {#if map.bucket === 'beta'}<span class="badge warn">beta</span>{/if}
    {#if map.notFoundAt}<span
        class="badge err"
        title="GET /maps/{map.id} answers 404 since {formatDate(map.notFoundAt)}"
        >gone upstream</span
      >{/if}
  </h1>
  <p class="muted">
    Native modes: {map.nativeGamemodeNames.join(', ') || 'unknown'}.
    {#if map.submitterId}Submitted by <a href={`/users/${map.submitterId}`}
        >{map.submitterAlias ?? map.submitterId}</a
      >.{/if}
    <a href={map.links.momentum} rel="external noopener noreferrer nofollow" target="_blank"
      >momentum-mod.org</a
    >. First seen {formatDate(map.firstSeenAt)}, last refreshed {relTime(map.lastRefreshedAt)}.
  </p>
  {#if map.description}<p>{map.description}</p>{/if}

  <div class="cards">
    <div class="card">
      <h3>Runs archived</h3>
      <div class="big">{formatInt(map.counts.runs)}</div>
      <span class="muted small">{formatInt(map.counts.removed_runs)} removed</span>
    </div>
    <div class="card">
      <h3>Replays</h3>
      <div class="big">{formatInt(map.counts.replays)}</div>
    </div>
    <div class="card">
      <h3>Completions (Momentum)</h3>
      <div class="big">{formatInt(map.stats.completions)}</div>
      <span class="muted small"
        >{formatInt(map.stats.uniqueCompletions)} unique, {formatInt(map.stats.favorites)} favorites</span
      >
    </div>
  </div>

  <h2>Leaderboard</h2>
  <div class="filters">
    <label
      >mode
      <select
        value={gm}
        onchange={(e) =>
          setQuery(
            {
              gamemode: (e.target as HTMLSelectElement).value,
              trackType: 0,
              trackNum: 1,
              style: 0,
              page: 1,
            },
            false,
          )}
      >
        {#each otherModes as g (g)}
          <option value={g}>{gamemodeName(g)}</option>
        {/each}
        {#if !otherModes.includes(gm)}<option value={gm}>{gamemodeName(gm)}</option>{/if}
      </select>
    </label>
    {#each boardsForMode as b (`${b.trackType}:${b.trackNum}:${b.style}`)}
      <button
        class:primary={b.trackType === tt && b.trackNum === tn && b.style === st}
        onclick={() => selectBoard(b)}
        title={`${b.typeName ?? ''} tier ${b.tier ?? '?'}`}
      >
        {trackName(b.trackType, b.trackNum)} / {styleName(b.style)} ({b.currentEntries})
      </button>
    {/each}
    {#if boardsForMode.length === 0}
      <span class="muted small"
        >No {gamemodeName(gm)} leaderboard declared on this map; cross mode runs are listed below if any.</span
      >
    {/if}
  </div>
  <form class="filters" onsubmit={applyAt}>
    <label>as of (UTC) <input type="datetime-local" bind:value={atInput} /></label>
    <button type="submit">View</button>
    {#if at}<button type="button" onclick={() => setQuery({ at: null, page: 1 }, false)}
        >Back to current</button
      >{/if}
    {#if observations.length > 0}
      <label
        >observations
        <select
          onchange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) setQuery({ at: v, page: 1 }, false);
          }}
        >
          <option value="">jump to...</option>
          {#each observations as o (o.id)}
            <option value={o.observedAt}>{formatDate(o.observedAt)} ({o.entryCount} entries)</option
            >
          {/each}
        </select>
      </label>
    {/if}
  </form>

  {#if boardError}<p class="error">{boardError}</p>{/if}
  {#if board}
    {#if board.at}
      <p class="notice">
        Showing the board as observed at
        {#if board.observation}<span class="mono">{formatDate(board.observation.observedAt)}</span>,
          valid until
          <span class="mono">{formatDate(board.observation.validUntil)}</span
          >.{:else}{board.note}{/if}
        Entries that have since disappeared are struck through.
      </p>
    {:else if board.leaderboard}
      <p class="muted small">
        Last full refresh {relTime(board.leaderboard.lastRefreshedAt)}. Removed entries are struck
        through and listed last.
      </p>
    {/if}
    <div class="table-wrap">
      <table>
        <thead>
          <tr
            ><th class="num">#</th><th>Player (as observed)</th><th class="num">Time</th><th
              >Date</th
            ><th>Replay</th><th>Run</th><th>Archive</th></tr
          >
        </thead>
        <tbody>
          {#each board.data as e (`${e.userId}:${e.pastRunId}`)}
            <tr class:removed={e.removedAt !== null}>
              <td class="num">{e.rank ?? ''}</td>
              <td
                ><Identity
                  userId={e.userId}
                  observedAlias={e.observedAlias}
                  observedAvatarHash={e.observedAvatarHash}
                  currentAlias={e.currentAlias}
                  currentAvatarHash={e.currentAvatarHash}
                /></td
              >
              <td class="num">{formatTime(e.time)}</td>
              <td class="mono small">{formatDate(e.momentumCreatedAt)}</td>
              <td>
                {#if e.replayHash && e.replayArchived}<a
                    href={`/api/replays/${e.replayHash}/download`}
                    rel="external"
                    download>download</a
                  >
                {:else if e.replayHash}<span class="muted small">not archived</span>
                {:else}<span class="muted small">none</span>{/if}
              </td>
              <td
                >{#if e.pastRunId}<a href={`/runs/${e.pastRunId}`} class="mono small"
                    >#{e.pastRunId}</a
                  >{/if}</td
              >
              <td class="small muted">
                seen {formatDate(e.firstSeenAt, false)}
                {#if e.removedAt}<span class="badge removed"
                    >removed {formatDate(e.removedAt, false)}</span
                  >{/if}
              </td>
            </tr>
          {:else}
            <tr><td colspan="7" class="muted">No entries.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <Pager
      page={board.page}
      take={board.take}
      total={board.total}
      onchange={(p) => setQuery({ page: p }, false)}
    />
  {/if}

  <div class="two-col">
    <section>
      <h2>Versions</h2>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th class="num">v</th><th>Changelog</th><th>BSP hash</th><th>By</th><th>Created</th
              ><th>BSP</th></tr
            ></thead
          >
          <tbody>
            {#each map.versions as v (v.id)}
              <tr>
                <td class="num">{v.versionNum}</td>
                <td>{v.changelog || ''}</td>
                <td class="mono small">{v.bspHash?.slice(0, 12) ?? ''}</td>
                <td
                  >{#if v.submitterId}<a href={`/users/${v.submitterId}`}
                      >{v.submitterAlias ?? v.submitterId}</a
                    >{/if}</td
                >
                <td class="mono small">{formatDate(v.momentumCreatedAt)}</td>
                <td
                  >{#if v.bspArchived}<span class="badge ok">archived</span
                    >{:else if v.downloadUrl}<a
                      href={v.downloadUrl}
                      rel="external noopener noreferrer nofollow">cdn</a
                    >{/if}</td
                >
              </tr>
            {:else}
              <tr><td colspan="6" class="muted">No versions known.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <h2>Credits</h2>
      <ul>
        {#each map.credits as c (`${c.userId}:${c.type}`)}
          <li class:muted={c.removedAt !== null}>
            {creditType[c.type] ?? c.type}:
            <a href={`/users/${c.userId}`}>{c.alias ?? c.userId}</a>{#if c.description}
              ({c.description}){/if}{#if c.removedAt}<span class="badge removed">removed</span>{/if}
          </li>
        {:else}
          <li class="muted">No credits.</li>
        {/each}
      </ul>
      <h2>Leaderboards declared</h2>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>Mode</th><th>Track</th><th>Style</th><th>Type</th><th class="num">Tier</th><th
                class="num">Entries</th
              ><th>Refreshed</th></tr
            ></thead
          >
          <tbody>
            {#each map.leaderboards as b (`${b.gamemode}:${b.trackType}:${b.trackNum}:${b.style}`)}
              <tr class:removed={b.removedAt !== null}>
                <td>{b.gamemodeName}</td><td>{trackName(b.trackType, b.trackNum)}</td><td
                  >{styleName(b.style)}</td
                ><td>{b.type == null ? '' : lbTypeName(b.type)}</td><td class="num"
                  >{b.tier ?? ''}</td
                ><td class="num">{b.currentEntries}</td><td class="small muted"
                  >{relTime(b.lastRefreshedAt)}</td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>Images</h2>
      <div class="gallery">
        {#each map.images as img (img.id)}
          <figure>
            {#if img.url}<img class="map" src={img.url} alt="" loading="lazy" />{:else}<span
                class="badge">not archived</span
              >{/if}
            <figcaption>
              {formatDate(img.firstSeenAt, false)}{#if img.removedAt}
                (removed {formatDate(img.removedAt, false)}){/if}
            </figcaption>
          </figure>
        {:else}
          <p class="muted">No images.</p>
        {/each}
      </div>
      <h2>Change history</h2>
      <ul class="timeline">
        {#each map.history as h (h.observedAt + h.field)}
          <li>
            <span class="when">{formatDate(h.observedAt)}</span><span
              >{fieldLabel(h.field)}: <span class="mono">{valueLabel(h.field, h.oldValue)}</span> to
              <span class="mono">{valueLabel(h.field, h.newValue)}</span></span
            >
          </li>
        {:else}
          <li><span class="when"></span><span class="muted">No changes observed yet.</span></li>
        {/each}
      </ul>
    </section>
  </div>
{/if}
