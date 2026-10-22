<script lang="ts">
  // One Ledger post. The Markdown renderer is loaded only here and in the panel.
  import type { Component } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { formatDate } from '../lib/format';
  import { KIND_LABEL, type LedgerPost } from '../lib/ledger';
  import { route } from '../lib/router.svelte';

  let { slug }: { slug: string } = $props();

  let post = $state<LedgerPost | null>(null);
  let missing = $state(false);
  let error = $state<string | null>(null);
  let old = $state<{
    id: number;
    title: string;
    body: string;
    validFrom: string;
    validTo: string;
  } | null>(null);
  const revId = $derived(Number(route.query.get('rev') ?? '0') || null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Markdown: Promise<Component<any>> = import('../components/md/Markdown.svelte').then(
    (m) => m.default,
  );

  $effect(() => {
    api<{ data: LedgerPost }>(`/api/ledger/${encodeURIComponent(slug)}`)
      .then((r) => {
        post = r.data;
        document.title = `${r.data.title} - mom-archive`;
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) missing = true;
        else error = String(e.message);
      });
    return () => {
      document.title = 'mom-archive';
    };
  });

  $effect(() => {
    const id = revId;
    if (!id) {
      old = null;
      return;
    }
    api<{ data: NonNullable<typeof old> }>(
      `/api/ledger/${encodeURIComponent(slug)}/revisions/${id}`,
    )
      .then((r) => (old = r.data))
      .catch(() => (old = null));
  });
</script>

{#if missing}
  <h1>Not in the Ledger</h1>
  <p class="muted">
    No published post lives at this address. <a href="/ledger">Back to the Ledger</a>.
  </p>
{:else if error}
  <p class="error">{error}</p>
{:else if post}
  <article>
    <p class="small"><a href="/ledger">Ledger</a> / {KIND_LABEL[post.kind]}</p>
    <h1>{post.title}</h1>
    <p class="meta small muted">
      Published <span class="mono">{formatDate(post.publishedAt)}</span>{#if post.editedAt}, last
        edited <span class="mono">{formatDate(post.editedAt)}</span>{/if}{#if post.subjectUserId}.
        About <a href={`/users/${post.subjectUserId}`}
          >{post.subjectAlias ?? `user ${post.subjectUserId}`}</a
        >{/if}.
    </p>
    {#if post.summary}<p class="lead">{post.summary}</p>{/if}

    {#if old}
      <div class="notice">
        You are reading the text this post had from {formatDate(old.validFrom)} to {formatDate(
          old.validTo,
        )}. <a href={`/ledger/${post.slug}`}>Current version</a>.
      </div>
    {/if}

    {#await Markdown then Md}
      <Md source={old ? old.body : post.body} />
    {:catch}
      <pre class="raw">{old ? old.body : post.body}</pre>
    {/await}

    {#if post.revisions.length}
      <section class="history">
        <h2>Earlier versions</h2>
        <p class="small muted">
          A published post is never quietly rewritten: each edit keeps the text it replaced.
        </p>
        <ul class="small">
          {#each post.revisions as r (r.id)}
            <li>
              <a href={`/ledger/${post.slug}?rev=${r.id}`}>
                {formatDate(r.validFrom)} to {formatDate(r.validTo)}</a
              >{#if r.note}: {r.note}{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </article>
{:else}
  <p class="muted">Loading.</p>
{/if}

<style>
  article {
    max-width: 52rem;
  }
  h1 {
    margin-bottom: 0.3rem;
  }
  .lead {
    font-size: 1.08rem;
  }
  .history {
    margin-top: 2.5rem;
    border-top: 1px solid var(--border);
  }
  .raw {
    white-space: pre-wrap;
  }
</style>
