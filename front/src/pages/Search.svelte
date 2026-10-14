<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import { api } from '../lib/api';
  import { statusName } from '../lib/format';
  import { route } from '../lib/router.svelte';

  interface Result {
    q: string;
    users: {
      id: number;
      alias: string | null;
      avatarHash: string | null;
      steamId: string | null;
      matchedOn: string;
      matchedText: string;
    }[];
    maps: {
      id: number;
      name: string;
      status: number;
      thumbnailId: string | null;
      matchedOn: string;
      matchedText: string;
    }[];
  }
  let result = $state<Result | null>(null);
  let error = $state<string | null>(null);
  const q = $derived(route.query.get('q') ?? '');

  $effect(() => {
    if (!q) return;
    api<Result>('/api/search', { q })
      .then((r) => (result = r))
      .catch((e) => (error = String(e.message)));
  });

  const label: Record<string, string> = {
    alias: 'current alias',
    past_alias: 'past alias',
    steam_name: 'steam name',
    name_at_ban: 'name on a SourceBans server',
    steam_id: 'SteamID',
    momentum_id: 'Momentum id',
    map_name: 'map name',
    map_name_prefix: 'map name',
    map_name_substring: 'map name',
    map_id: 'map id',
  };
</script>

<h1>Search: <span class="mono">{q}</span></h1>
{#if error}<p class="error">{error}</p>{/if}
{#if result}
  <div class="two-col">
    <section>
      <h2>Users ({result.users.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>Alias</th><th>Matched on</th><th>SteamID64</th></tr></thead>
          <tbody>
            {#each result.users as u (u.id)}
              <tr>
                <td><Avatar hash={u.avatarHash} /></td>
                <td><a href={`/users/${u.id}`}>{u.alias ?? `user ${u.id}`}</a></td>
                <td class="small"
                  >{label[u.matchedOn] ?? u.matchedOn}{#if u.matchedOn !== 'alias'}: <span
                      class="mono">{u.matchedText}</span
                    >{/if}</td
                >
                <td class="mono small">{u.steamId ?? ''}</td>
              </tr>
            {:else}
              <tr><td colspan="4" class="muted">No users.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>Maps ({result.maps.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Map</th><th>Status</th><th>Matched on</th></tr></thead>
          <tbody>
            {#each result.maps as m (m.id)}
              <tr
                ><td><a href={`/maps/${m.id}`}>{m.name}</a></td><td>{statusName(m.status)}</td><td
                  class="small">{label[m.matchedOn] ?? m.matchedOn}</td
                ></tr
              >
            {:else}
              <tr><td colspan="3" class="muted">No maps.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>
{/if}
