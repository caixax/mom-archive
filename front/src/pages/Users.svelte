<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import Pager from '../components/Pager.svelte';
  import { api, type Paged, type UserSummary } from '../lib/api';
  import { formatDate, relTime } from '../lib/format';
  import { route, setQuery } from '../lib/router.svelte';

  let result = $state<Paged<UserSummary> | null>(null);
  let error = $state<string | null>(null);
  const q = $derived(route.query.get('q') ?? '');
  const sort = $derived(route.query.get('sort') ?? 'recent');
  const page = $derived(Number(route.query.get('page') ?? '1'));
  let qInput = $state('');

  $effect(() => {
    qInput = q;
    error = null;
    api<Paged<UserSummary>>('/api/users', { q, sort, page, take: 50 })
      .then((r) => (result = r))
      .catch((e) => (error = String(e.message)));
  });

  function submit(e: Event) {
    e.preventDefault();
    setQuery({ q: qInput, page: 1 }, false);
  }
</script>

<h1>Users</h1>
<p class="muted">
  Every player the archive has seen. Search matches current aliases, past aliases, Steam names and
  names recorded by SourceBans.
</p>
<form class="filters" onsubmit={submit}>
  <input type="search" placeholder="alias, old alias" bind:value={qInput} maxlength="100" />
  <label
    >sort
    <select
      value={sort}
      onchange={(e) => setQuery({ sort: (e.target as HTMLSelectElement).value, page: 1 })}
    >
      <option value="recent">recent activity</option>
      <option value="alias">alias</option>
      <option value="id">momentum id</option>
    </select>
  </label>
  <button type="submit">Search</button>
</form>
{#if error}<p class="error">{error}</p>{/if}
{#if result}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th></th><th>Alias</th><th>Matched</th><th>Country</th><th>Roles / bans</th><th
            >Last run</th
          ><th>Momentum id</th></tr
        ></thead
      >
      <tbody>
        {#each result.data as u (u.id)}
          <tr>
            <td><Avatar hash={u.avatarHash} /></td>
            <td
              ><a href={`/users/${u.id}`}>{u.alias ?? `user ${u.id}`}</a>{#if u.isDeleted}<span
                  class="badge err">hidden</span
                >{/if}</td
            >
            <td class="small muted"
              >{#if u.matchedOn && u.matchedOn !== 'alias'}{u.matchedOn.replace('_', ' ')}:
                <span class="mono">{u.matchedText}</span>{/if}</td
            >
            <td>{u.country ?? ''}</td>
            <td class="small"
              >{u.roleNames.join(', ')}{#if u.banNames.length}
                <span class="badge err">{u.banNames.join(', ')}</span>{/if}</td
            >
            <td class="mono small" title={formatDate(u.lastRunAt)}
              >{u.lastRunAt ? relTime(u.lastRunAt) : ''}</td
            >
            <td class="mono small">{u.id}</td>
          </tr>
        {:else}
          <tr><td colspan="7" class="muted">No users match.</td></tr>
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
