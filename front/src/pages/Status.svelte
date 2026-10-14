<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type StatusComponent } from '../lib/api';
  import { formatDate, relTime } from '../lib/format';

  interface Status {
    checkedAt: string;
    since: string | null;
    components: StatusComponent[];
  }
  let status = $state<Status | null>(null);
  let error = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});

  const titles: Record<string, string> = {
    momentum_api: 'Momentum API',
    database: 'Database',
    storage: 'Replay storage',
    watcher: 'Watcher jobs',
    replay_queue: 'Replay queue',
    steam_api: 'Steam API',
    steamhistory: 'SteamHistory',
    backfill: 'Backfill',
  };

  async function load() {
    try {
      status = await api<Status>('/api/status');
      error = null;
    } catch (e) {
      error = String((e as Error).message);
    }
  }

  onMount(() => {
    // No meta refresh here: the browser arms it with the /status URL and later drags the
    // user back to it even after navigating away. Timers are throttled in background tabs,
    // so instead refresh immediately when the tab becomes visible again.
    void load();
    const t = setInterval(load, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  interface JobRow {
    name: string;
    running: boolean;
    lastStartAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastItemsSeen: number;
    lastItemsNew: number;
    lastDurationMs: number | null;
    nextRunAt: string | null;
    intervalMs: number;
    runs: number;
    failures: number;
  }
</script>

<h1>Status</h1>
<p class="muted">
  Refreshes every 30 seconds. {#if status}Last check {formatDate(status.checkedAt)}.{/if}
</p>
{#if error}<p class="error">{error}</p>{/if}
{#if status}
  <div class="cards">
    {#each status.components as c (c.name)}
      <div class="card">
        <h3><span class="dot {c.level}"></span>{titles[c.name] ?? c.name}</h3>
        <p style="margin:0">{c.detail}</p>
        <p class="muted small" style="margin:0.4rem 0 0">checked {relTime(c.checkedAt)}</p>
        {#if c.name === 'watcher' && c.data?.jobs}
          <button
            class="small"
            style="margin-top:0.5rem"
            onclick={() => (expanded = { ...expanded, watcher: !expanded.watcher })}
            >{expanded.watcher ? 'hide jobs' : 'show jobs'}</button
          >
        {/if}
      </div>
    {/each}
  </div>

  {#if expanded.watcher}
    {@const watcher = status.components.find((c) => c.name === 'watcher')}
    {#if watcher?.data?.jobs}
      <h2>Jobs</h2>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>Job</th><th>State</th><th>Last start</th><th>Last success</th><th class="num"
                >Seen</th
              ><th class="num">New</th><th class="num">ms</th><th>Next run</th><th>Last error</th
              ></tr
            ></thead
          >
          <tbody>
            {#each watcher.data.jobs as JobRow[] as j (j.name)}
              <tr>
                <td>{j.name}</td>
                <td
                  >{#if j.running}<span class="badge accent">running</span
                    >{:else if j.lastError}<span class="badge err">failing</span>{:else}<span
                      class="badge ok">idle</span
                    >{/if}</td
                >
                <td class="mono small">{relTime(j.lastStartAt)}</td>
                <td class="mono small">{relTime(j.lastSuccessAt)}</td>
                <td class="num">{j.lastItemsSeen}</td>
                <td class="num">{j.lastItemsNew}</td>
                <td class="num">{j.lastDurationMs ?? ''}</td>
                <td class="mono small">{j.intervalMs > 0 ? relTime(j.nextRunAt) : 'continuous'}</td>
                <td class="small error">{j.lastError ?? ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
{/if}
