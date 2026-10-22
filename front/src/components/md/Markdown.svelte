<script lang="ts">
  // Renders Markdown source as components. Used for Ledger posts and report
  // messages. References like [[user:14991]] are resolved in a single request.
  import { api } from '../../lib/api';
  import { collectRefs, parseMarkdown, refQuery, type ResolvedRefs } from '../../lib/markdown';
  import Blocks from './Blocks.svelte';
  import { setMd, type MdContext } from './context';

  interface Props {
    source: string;
    /** Images from the archive itself; off for text written by visitors. */
    images?: boolean;
  }
  let { source, images = true }: Props = $props();

  const tokens = $derived(parseMarkdown(source));
  const ctx = $state<MdContext>({ refs: null, images: false });
  setMd(ctx);
  $effect(() => {
    ctx.images = images;
  });

  let lastQuery = '';
  $effect(() => {
    const q = refQuery(collectRefs(tokens));
    const key = JSON.stringify(q);
    if (key === lastQuery) return;
    lastQuery = key;
    if (!q) {
      ctx.refs = null;
      return;
    }
    // Debounced, so typing in the editor preview does not fire a request per key.
    const t = setTimeout(() => {
      api<ResolvedRefs>('/api/refs', q)
        .then((r) => {
          if (lastQuery === key) ctx.refs = r;
        })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  });
</script>

<div class="md">
  <Blocks {tokens} />
</div>

<style>
  .md {
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .md :global(h2) {
    margin: 1.6rem 0 0.6rem;
  }
  .md :global(h3),
  .md :global(h4) {
    margin: 1.2rem 0 0.5rem;
  }
  .md :global(blockquote) {
    margin: 0.8rem 0;
    padding: 0.2rem 0 0.2rem 0.9rem;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .md :global(pre) {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.6rem 0.8rem;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .md :global(code) {
    font-family: var(--mono);
    font-size: 0.92em;
    background: var(--bg-2);
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
  }
  .md :global(pre code) {
    background: none;
    padding: 0;
  }
  .md :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }
  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.5rem 0;
  }
  .md :global(.raw) {
    font-family: var(--mono);
    font-size: 0.9em;
    color: var(--muted);
    white-space: pre-wrap;
  }
  .md :global(td),
  .md :global(th) {
    overflow-wrap: normal;
  }
  .md :global(li) {
    margin: 0.2rem 0;
  }
</style>
