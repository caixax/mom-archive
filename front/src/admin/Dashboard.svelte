<script lang="ts">
  // The panel's front page: what needs attention, who is on the site right now,
  // visitors and pages over time from the daily rollups, and how the archive grew.
  import { api } from '../lib/api';
  import { formatBytes, formatDate, formatInt, relTime } from '../lib/format';
  import DayChart from './DayChart.svelte';

  interface TopRow {
    key: string;
    n: number;
    uniq: number;
    label: string | null;
  }
  interface Day {
    day: string;
    requests: number;
    humanRequests: number;
    botRequests: number;
    apiClients: number;
    visitors: number;
    pageviews: number;
    errors: number;
    rateLimited: number;
    bytes: number;
    avgMs: number;
    p95Ms: number;
  }
  interface Ban {
    userId: number;
    alias: string | null;
    from: number;
    to: number;
    fromNames: string[];
    toNames: string[];
    at: string;
    removedRuns: number;
    caseSlug?: string | null;
  }
  interface Dashboard {
    days: number;
    rollup: { lastComputedAt: string | null };
    online: { visitors: number; pageviews: number; pages: { page: string; n: number }[] };
    current: Record<string, number>;
    previous: Record<string, number>;
    series: Day[];
    top: Record<string, TopRow[]>;
    growth: { day: string; runs: number; replays: number; removed: number; bans: number }[];
    attention: {
      failingJobs: { name: string; error: string | null; at: string | null }[];
      replaysLost7d: number;
      replaysLostNot404: number;
      bans: Ban[];
      unreadReports?: number;
    };
  }

  interface Props {
    /** Opens another tab of the panel, for the attention items. */
    go?: (tab: string) => void;
    /** Starts a Ledger case draft for a banned player, when the Ledger exists. */
    draftCase?: (userId: number) => void;
  }
  let { go, draftCase }: Props = $props();

  let range = $state(30);
  let data = $state<Dashboard | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      data = await api<Dashboard>('/api/admin/dashboard', { days: range });
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void range;
    void load();
  });

  // Keep "right now" fresh without hammering the admin rate limit.
  $effect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => clearInterval(t);
  });

  /** Every day of the window, so missing rollups show as gaps. */
  const days = $derived.by(() => {
    const out: string[] = [];
    const end = new Date();
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  });
  const byDay = $derived(new Map((data?.series ?? []).map((s) => [s.day, s])));
  const col = (k: keyof Day) => days.map((d) => (byDay.get(d)?.[k] as number | undefined) ?? null);
  const growthDays = $derived((data?.growth ?? []).map((g) => g.day));

  function delta(k: string): { text: string; cls: string } | null {
    if (!data) return null;
    const a = data.current[k] ?? 0;
    const b = data.previous[k] ?? 0;
    if (b === 0) return a === 0 ? null : { text: 'new', cls: 'up' };
    const pct = Math.round(((a - b) / b) * 100);
    return { text: `${pct >= 0 ? '+' : ''}${pct}%`, cls: pct >= 0 ? 'up' : 'down' };
  }

  const regions = (() => {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      return null;
    }
  })();
  function countryName(code: string): string {
    try {
      return regions?.of(code.toUpperCase()) ?? code;
    } catch {
      return code;
    }
  }

  interface ListDef {
    kind: string;
    title: string;
    href?: (r: TopRow) => string | null;
    label?: (r: TopRow) => string;
  }
  const lists: ListDef[] = [
    { kind: 'user', title: 'Profiles', href: (r) => `/users/${r.key}` },
    { kind: 'map', title: 'Maps', href: (r) => `/maps/${encodeURIComponent(r.key)}` },
    { kind: 'run', title: 'Runs', href: (r) => `/runs/${r.key}` },
    { kind: 'watch', title: 'Replays watched', href: (r) => `/watch/${r.key}` },
    { kind: 'ledger', title: 'Ledger posts', href: (r) => `/ledger/${r.key}` },
    { kind: 'page', title: 'Pages' },
    { kind: 'referrer', title: 'Came from' },
    { kind: 'search', title: 'Searched for' },
    { kind: 'country', title: 'Countries', label: (r) => countryName(r.key) },
    { kind: 'device', title: 'Devices' },
    { kind: 'browser', title: 'Browsers' },
    { kind: 'os', title: 'Systems' },
    { kind: 'bot', title: 'Bots' },
    { kind: 'route', title: 'API routes' },
    { kind: 'status', title: 'Status codes' },
  ];

  const kpis: [string, string][] = [
    ['visitor_days', 'Visitors'],
    ['pageviews', 'Page views'],
    ['requests', 'API requests'],
    ['bot_requests', 'Bot requests'],
    ['errors', 'Server errors'],
    ['bytes', 'Served'],
  ];
  const cur = (k: string): number => data?.current[k] ?? 0;

  /** The line under each number: the comparison and whatever else explains it. */
  function kpiNote(k: string, compared: boolean): string {
    const parts: string[] = [];
    if (compared) parts.push(` vs the ${range === 1 ? 'day' : `${range} days`} before`);
    if (k === 'visitor_days')
      parts.push(`unique per day, summed, peak ${formatInt(cur('peak_visitors'))} a day`);
    if (k === 'pageviews' && cur('visitor_days'))
      parts.push(`${(cur('pageviews') / cur('visitor_days')).toFixed(1)} per visitor`);
    if (k === 'bot_requests' && cur('requests'))
      parts.push(`${Math.round((cur('bot_requests') / cur('requests')) * 100)}% of all requests`);
    return parts.join(', ').replace(/^, /, '');
  }

  const attentionCount = $derived(
    data
      ? data.attention.failingJobs.length +
          (data.attention.replaysLostNot404 > 0 ? 1 : 0) +
          data.attention.bans.filter((b) => b.to !== 0 && !b.caseSlug).length +
          (data.attention.unreadReports ? 1 : 0)
      : 0,
  );
</script>

<div class="filters">
  <label
    >window
    <select bind:value={range}>
      <option value={1}>today</option>
      <option value={7}>7 days</option>
      <option value={30}>30 days</option>
      <option value={90}>90 days</option>
      <option value={365}>1 year</option>
    </select>
  </label>
  {#if data}
    <span class="badge {data.online.visitors > 0 ? 'ok' : ''}"
      >{formatInt(data.online.visitors)} on the site now</span
    >
    <span class="muted small"
      >Rollup {data.rollup.lastComputedAt ? relTime(data.rollup.lastComputedAt) : 'not run yet'},
      every 15 minutes.</span
    >
  {/if}
</div>

{#if error}<p class="error">{error}</p>{/if}

{#if data}
  {#if attentionCount > 0}
    <section class="attention">
      <h2>Needs a look</h2>
      <ul class="plain">
        {#if data.attention.unreadReports}
          <li>
            <span class="badge accent">reports</span>
            {data.attention.unreadReports} report(s) with something new.
            {#if go}<button class="link" onclick={() => go('reports')}>open</button>{/if}
          </li>
        {/if}
        {#each data.attention.failingJobs as j (j.name)}
          <li>
            <span class="badge err">job</span>
            <strong>{j.name}</strong> failed {relTime(j.at)}:
            <span class="mono small">{(j.error ?? '').slice(0, 140)}</span>
            {#if go}<button class="link" onclick={() => go('poller')}>poller</button>{/if}
          </li>
        {/each}
        {#if data.attention.replaysLostNot404 > 0}
          <li>
            <span class="badge warn">replays</span>
            {data.attention.replaysLostNot404} replay download(s) gave up in the last 7 days for a reason
            other than 404. They may still be fetchable.
            {#if go}<button class="link" onclick={() => go('poller')}>retry from the poller</button
              >{/if}
          </li>
        {/if}
        {#each data.attention.bans.filter((b) => b.to !== 0 && !b.caseSlug) as b (b.userId + b.at)}
          <li>
            <span class="badge err">ban</span>
            <a href={`/users/${b.userId}`}>{b.alias ?? `user ${b.userId}`}</a>
            got {b.toNames.join(', ') || `flags ${b.to}`}
            {relTime(b.at)}{#if b.removedRuns}, {b.removedRuns} run(s) removed{/if}. No case written
            yet.
            {#if draftCase}<button class="link" onclick={() => draftCase(b.userId)}
                >draft a case</button
              >{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="cards kpis">
    {#each kpis as [k, title] (k)}
      {@const d = delta(k)}
      <div class="card">
        <h3>{title}</h3>
        <div class="big">
          {k === 'bytes' ? formatBytes(data.current[k]) : formatInt(data.current[k])}
        </div>
        <span class="small muted"
          >{#if d}<span class={d.cls}>{d.text}</span>{/if}{kpiNote(k, Boolean(d))}</span
        >
      </div>
    {/each}
  </div>

  <h2>Visitors and page views</h2>
  <DayChart
    {days}
    bars={col('pageviews')}
    line={col('visitors')}
    barLabel="page views"
    lineLabel="visitors"
  />

  {#if data.online.pages.length}
    <p class="small">
      <strong>Being read now:</strong>
      {#each data.online.pages as p, i (p.page)}{i ? ', ' : ''}<a href={p.page}>{p.page}</a>
        <span class="muted">({p.n})</span>{/each}
    </p>
  {/if}

  <h2>Most viewed, {range === 1 ? 'today' : `last ${range} days`}</h2>
  <div class="tops">
    {#each lists as l (l.kind)}
      {@const rows = data.top[l.kind] ?? []}
      {#if rows.length}
        {@const max = Math.max(1, ...rows.map((r) => r.n))}
        <div class="card top">
          <h3>{l.title}</h3>
          <ol>
            {#each rows as r (r.key)}
              {@const href = l.href?.(r) ?? null}
              {@const text = l.label?.(r) ?? r.label ?? r.key}
              <li>
                <span class="bar" style={`width:${Math.round((r.n / max) * 100)}%`}></span>
                <span class="k" title={r.key}
                  >{#if href}<a {href}>{text}</a>{:else}{text}{/if}</span
                >
                <span class="n mono" title={`${formatInt(r.uniq)} visitor days`}
                  >{formatInt(r.n)}</span
                >
              </li>
            {/each}
          </ol>
        </div>
      {/if}
    {/each}
  </div>
  {#if Object.keys(data.top).length === 0}
    <p class="muted">
      Nothing rolled up yet. The first rollup runs a couple of minutes after the backend starts and
      covers everything still in the request log.
    </p>
  {/if}

  <h2>The archive, per day</h2>
  <div class="grid2">
    <div>
      <h3 class="small muted">Runs first seen</h3>
      <DayChart
        days={growthDays}
        bars={data.growth.map((g) => g.runs)}
        barLabel="runs"
        height={90}
      />
    </div>
    <div>
      <h3 class="small muted">Replays saved</h3>
      <DayChart
        days={growthDays}
        bars={data.growth.map((g) => g.replays)}
        barLabel="replays"
        height={90}
      />
    </div>
    <div>
      <h3 class="small muted">Runs removed from Momentum</h3>
      <DayChart
        days={growthDays}
        bars={data.growth.map((g) => g.removed)}
        barLabel="removed"
        height={90}
      />
    </div>
    <div>
      <h3 class="small muted">Ban changes</h3>
      <DayChart
        days={growthDays}
        bars={data.growth.map((g) => g.bans)}
        barLabel="ban changes"
        height={90}
      />
    </div>
  </div>

  <h2>Requests and speed</h2>
  <DayChart
    {days}
    bars={col('humanRequests')}
    line={col('botRequests')}
    barLabel="human API requests"
    lineLabel="bot requests"
  />
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th>Day</th><th class="num">Visitors</th><th class="num">Views</th><th class="num"
            >Requests</th
          ><th class="num">Bots</th><th class="num">5xx</th><th class="num">429</th><th class="num"
            >Avg ms</th
          ><th class="num">p95 ms</th><th class="num">Served</th></tr
        ></thead
      >
      <tbody>
        {#each [...data.series].reverse() as s (s.day)}
          <tr>
            <td class="mono small">{s.day}</td>
            <td class="num">{formatInt(s.visitors)}</td>
            <td class="num">{formatInt(s.pageviews)}</td>
            <td class="num">{formatInt(s.requests)}</td>
            <td class="num">{formatInt(s.botRequests)}</td>
            <td class="num">{formatInt(s.errors)}</td>
            <td class="num">{formatInt(s.rateLimited)}</td>
            <td class="num">{s.avgMs}</td>
            <td class="num">{s.p95Ms}</td>
            <td class="num">{formatBytes(s.bytes)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="muted small">
    Visitors are distinct addresses that opened a page that day, bots and the panel left out; there
    are no cookies, so a visitor on two days counts twice. Page views come from a beacon the site
    sends on each navigation, which browsers asking not to be tracked skip. Rollups keep no
    addresses and no user agents, so they are kept for good. Generated {formatDate(
      new Date().toISOString(),
    )}.
  </p>
{:else if !error}
  <p class="muted">Loading.</p>
{/if}

<style>
  .attention {
    border-left: 3px solid var(--warn);
    padding: 0.2rem 0 0.2rem 0.8rem;
    margin: 0.5rem 0 1rem;
  }
  .attention h2 {
    margin-top: 0;
  }
  .attention li {
    margin: 0.35rem 0;
  }
  ul.plain {
    list-style: none;
    padding: 0;
  }
  .kpis {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  }
  .up {
    color: var(--ok);
  }
  .down {
    color: var(--err);
  }
  .tops {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr));
    gap: 0.75rem;
  }
  .top ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .top li {
    position: relative;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.18rem 0.3rem;
    font-size: 0.9rem;
  }
  .top .bar {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--accent);
    opacity: 0.12;
    border-radius: 2px;
  }
  .top .k {
    position: relative;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .top .n {
    position: relative;
    color: var(--muted);
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
    gap: 0 1rem;
  }
  .grid2 h3 {
    margin: 0.3rem 0 0;
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0 0.2rem;
    font: inherit;
    text-decoration: underline;
  }
</style>
