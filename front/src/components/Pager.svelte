<script lang="ts">
  let {
    page,
    take,
    total,
    onchange,
  }: { page: number; take: number; total: number; onchange: (page: number) => void } = $props();
  const pages = $derived(Math.max(1, Math.ceil(total / take)));
</script>

{#if total > take}
  <div class="pager">
    <button disabled={page <= 1} onclick={() => onchange(page - 1)}>Previous</button>
    <span class="muted small">page {page} of {pages} ({total} rows)</span>
    <button disabled={page >= pages} onclick={() => onchange(page + 1)}>Next</button>
  </div>
{:else if total > 0}
  <p class="muted small">{total} rows</p>
{/if}
