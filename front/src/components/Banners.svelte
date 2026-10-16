<script lang="ts">
  // Site announcements. Bodies are plain text and are rendered as text, never
  // as markup, the same rule the archive applies to every string it did not write.
  import { api } from '../lib/api';

  interface Announcement {
    id: number;
    body: string;
    level: 'info' | 'warning' | 'critical' | string;
    scope: 'home' | 'all' | string;
  }

  let { home = false }: { home?: boolean } = $props();
  let items = $state<Announcement[]>([]);

  $effect(() => {
    api<{ data: Announcement[] }>('/api/announcements')
      .then((r) => (items = r.data))
      .catch(() => (items = []));
  });

  const shown = $derived(items.filter((a) => a.scope === 'all' || home));
</script>

{#each shown as a (a.id)}
  <div class="banner {a.level}" role="status">{a.body}</div>
{/each}

<style>
  .banner {
    margin: 0 0 0.6rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-left-width: 4px;
    background: var(--bg-2);
    white-space: pre-wrap;
  }
  .banner.info {
    border-left-color: var(--accent);
  }
  .banner.warning {
    border-left-color: #d9a406;
  }
  .banner.critical {
    border-left-color: var(--removed);
  }
</style>
