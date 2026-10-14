<script lang="ts">
  import Pager from '../components/Pager.svelte';
  import RunsTable from '../components/RunsTable.svelte';
  import { api, type Paged, type RunRow } from '../lib/api';
  import { GAMEMODES } from '../lib/format';
  import { route, setQuery } from '../lib/router.svelte';

  let result = $state<Paged<RunRow> | null>(null);
  let error = $state<string | null>(null);
  const gamemode = $derived(route.query.get('gamemode') ?? '');
  const page = $derived(Number(route.query.get('page') ?? '1'));

  $effect(() => {
    api<Paged<RunRow>>('/api/runs', { removed: true, gamemode, page, take: 50 })
      .then((r) => (result = r))
      .catch((e) => (error = String(e.message)));
  });
</script>

<h1>Deleted runs</h1>
<p class="muted">
  Runs whose leaderboard entry disappeared from Momentum after the archive had recorded it, newest
  first. "removed" means the entry is gone from the board but the run still exists in Momentum's
  history; "deleted" means the run itself answers 404. A player improving their time does not count:
  that replaces the entry rather than removing it.
</p>
<div class="filters">
  <label
    >mode
    <select
      value={gamemode}
      onchange={(e) => setQuery({ gamemode: (e.target as HTMLSelectElement).value, page: 1 })}
    >
      <option value="">any</option>
      {#each Object.entries(GAMEMODES) as [g, name] (g)}<option value={g}>{name}</option>{/each}
    </select>
  </label>
</div>
{#if error}<p class="error">{error}</p>{/if}
{#if result}
  <RunsTable runs={result.data} />
  <Pager
    page={result.page}
    take={result.take}
    total={result.total}
    onchange={(p) => setQuery({ page: p }, false)}
  />
{/if}
