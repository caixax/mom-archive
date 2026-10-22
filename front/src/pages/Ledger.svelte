<script lang="ts">
  // The Ledger: cases, news, concerns and site updates written by whoever runs
  // the archive. Every case points at the archive's own records.
  import Pager from '../components/Pager.svelte';
  import { api, type Paged } from '../lib/api';
  import { formatDate } from '../lib/format';
  import { KIND_LABEL, KIND_PLURAL, type LedgerKind, type LedgerSummary } from '../lib/ledger';
  import { route, setQuery } from '../lib/router.svelte';

  const kinds: LedgerKind[] = ['case', 'news', 'concern', 'changelog'];
  const kind = $derived((route.query.get('kind') as LedgerKind | null) ?? null);
  const page = $derived(Number(route.query.get('page') ?? '1') || 1);
  let data = $state<Paged<LedgerSummary> | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const k = kind;
    const p = page;
    api<Paged<LedgerSummary>>('/api/ledger', { kind: k, page: p, take: 20 })
      .then((r) => ((data = r), (error = null)))
      .catch((e) => (error = String(e.message)));
  });
</script>

<h1>Ledger</h1>
<p class="muted">
  What the archive's records show and nobody else wrote down: bans and removed runs Momentum never
  announced, news, concerns, and changes to this site. Cases state what the archive observed and
  link to every record; opinion, where there is any, is marked as such.
  <a href="/api/ledger/feed.xml" rel="external">RSS</a>
</p>

<nav class="chips" aria-label="Kind">
  <a href="/ledger" class:active={!kind}>All</a>
  {#each kinds as k (k)}
    <a href={`/ledger?kind=${k}`} class:active={kind === k}>{KIND_PLURAL[k]}</a>
  {/each}
</nav>

{#if error}<p class="error">{error}</p>{/if}

{#if data}
  <ul class="posts">
    {#each data.data as p (p.id)}
      <li class:pinned={p.pinned}>
        <div class="meta small">
          <span class="badge {p.kind === 'case' ? 'err' : p.kind === 'concern' ? 'warn' : 'accent'}"
            >{KIND_LABEL[p.kind]}</span
          >
          {#if p.pinned}<span class="badge">pinned</span>{/if}
          <span class="mono muted">{formatDate(p.publishedAt, false)}</span>
          {#if p.editedAt}<span class="muted">edited {formatDate(p.editedAt, false)}</span>{/if}
        </div>
        <h2><a href={`/ledger/${p.slug}`}>{p.title}</a></h2>
        {#if p.summary}<p>{p.summary}</p>{/if}
        {#if p.subjectUserId}
          <p class="small muted">
            About <a href={`/users/${p.subjectUserId}`}
              >{p.subjectAlias ?? `user ${p.subjectUserId}`}</a
            >
          </p>
        {/if}
      </li>
    {:else}
      <li class="muted">Nothing here yet.</li>
    {/each}
  </ul>
  <Pager
    page={data.page}
    take={data.take}
    total={data.total}
    onchange={(p) => setQuery({ page: p }, false)}
  />
{:else if !error}
  <p class="muted">Loading.</p>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.8rem 0 1.2rem;
  }
  .chips a {
    padding: 0.2rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.9rem;
    color: var(--muted);
    text-decoration: none;
  }
  .chips a.active {
    color: var(--text);
    border-color: var(--accent);
  }
  .posts {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .posts > li {
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--border);
  }
  .posts > li.pinned {
    border-left: 3px solid var(--accent);
    padding-left: 0.8rem;
  }
  .posts h2 {
    margin: 0.3rem 0;
    font-size: 1.25rem;
  }
  .posts p {
    margin: 0.3rem 0;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .meta .badge {
    margin-left: 0;
  }
</style>
