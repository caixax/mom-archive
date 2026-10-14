<script lang="ts">
  import Pager from '../components/Pager.svelte';
  import { api, type MapSummary, type Paged } from '../lib/api';
  import { formatDate, GAMEMODES, lbTypeName } from '../lib/format';
  import { route, setQuery } from '../lib/router.svelte';

  let result = $state<Paged<MapSummary> | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  const q = $derived(route.query.get('q') ?? '');
  const bucket = $derived(route.query.get('bucket') ?? '');
  const lbType = $derived(route.query.get('lbType') ?? '');
  const native = $derived(route.query.get('native') ?? '');
  const sort = $derived(route.query.get('sort') ?? 'name');
  const page = $derived(Number(route.query.get('page') ?? '1'));

  let qInput = $state('');

  $effect(() => {
    qInput = q;
    loading = true;
    error = null;
    api<Paged<MapSummary>>('/api/maps', {
      q,
      bucket,
      lbType,
      native,
      sort,
      page,
      take: 50,
      archived: bucket || lbType || native || q ? undefined : true,
    })
      .then((r) => (result = r))
      .catch((e) => (error = String(e.message)))
      .finally(() => (loading = false));
  });

  function submit(e: Event) {
    e.preventDefault();
    setQuery({ q: qInput, page: 1 }, false);
  }
</script>

<h1>Maps</h1>
<p class="muted">
  Ranked, unranked and beta maps with a Bhop HL1 leaderboard, plus every map that received a Bhop
  HL1 run. Use the filters to narrow down.
</p>

<form class="filters" onsubmit={submit}>
  <input type="search" placeholder="map name" bind:value={qInput} maxlength="100" />
  <label
    >status
    <select
      value={bucket}
      onchange={(e) => setQuery({ bucket: (e.target as HTMLSelectElement).value, page: 1 })}
    >
      <option value="">any</option>
      <option value="released">released (approved)</option>
      <option value="beta">beta (public testing, final approval)</option>
      <option value="other">other (private, disabled)</option>
    </select>
  </label>
  <label
    >leaderboard
    <select
      value={lbType}
      onchange={(e) => setQuery({ lbType: (e.target as HTMLSelectElement).value, page: 1 })}
    >
      <option value="">any</option>
      <option value="0">ranked</option>
      <option value="1">unranked</option>
      <option value="2">hidden</option>
      <option value="3">in submission</option>
    </select>
  </label>
  <label
    >native mode
    <select
      value={native}
      onchange={(e) => setQuery({ native: (e.target as HTMLSelectElement).value, page: 1 })}
    >
      <option value="">any</option>
      {#each Object.entries(GAMEMODES) as [id, name] (id)}
        <option value={id}>{name}</option>
      {/each}
    </select>
  </label>
  <label
    >sort
    <select
      value={sort}
      onchange={(e) => setQuery({ sort: (e.target as HTMLSelectElement).value, page: 1 })}
    >
      <option value="name">name</option>
      <option value="recent">recently seen</option>
      <option value="id">newest id</option>
    </select>
  </label>
  <button type="submit">Apply</button>
</form>

{#if error}<p class="error">{error}</p>{/if}
{#if loading && !result}<p class="muted">Loading...</p>{/if}

{#if result}
  <div class="table-wrap">
    <table>
      <thead>
        <tr
          ><th></th><th>Map</th><th>Status</th><th>Bhop HL1 boards</th><th>Native modes</th><th
            >Submitter</th
          ><th>First seen</th></tr
        >
      </thead>
      <tbody>
        {#each result.data as m (m.id)}
          <tr>
            <td
              >{#if m.thumbnailUrl}<img
                  src={m.thumbnailUrl}
                  alt=""
                  width="64"
                  height="36"
                  loading="lazy"
                  style="border-radius:3px"
                />{/if}</td
            >
            <td
              ><a href={`/maps/${m.id}`}>{m.name}</a>{#if m.notFoundAt}<span
                  class="badge err"
                  title="no longer reachable on the Momentum API">gone</span
                >{/if}</td
            >
            <td
              >{m.statusName}{#if m.bucket === 'beta'}<span class="badge warn">beta</span>{/if}</td
            >
            <td
              >{#if m.leaderboardTypes && m.leaderboardTypes.length}{m.leaderboardTypes
                  .map(lbTypeName)
                  .join(', ')}{:else}<span class="muted">none</span>{/if}</td
            >
            <td class="small">{m.nativeGamemodeNames.join(', ')}</td>
            <td
              >{#if m.submitterId}<a href={`/users/${m.submitterId}`}
                  >{m.submitterAlias ?? m.submitterId}</a
                >{/if}</td
            >
            <td class="mono small">{formatDate(m.firstSeenAt, false)}</td>
          </tr>
        {:else}
          <tr><td colspan="7" class="muted">No maps match.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <Pager
    page={result.page}
    take={result.take}
    total={result.total}
    onchange={(p) => setQuery({ page: p }, false)}
  />
{/if}
