<script lang="ts">
  import { avatarSrc } from '../lib/api';

  let {
    hash,
    alt = '',
    size = '',
  }: { hash: string | null | undefined; alt?: string; size?: '' | 'sm' | 'lg' } = $props();
  let failed = $state(false);
  const src = $derived(avatarSrc(hash));
</script>

{#if src && !failed}
  <img class="avatar {size}" {src} {alt} loading="lazy" onerror={() => (failed = true)} />
{:else}
  <span class="avatar {size}" title={hash ? 'avatar not archived' : 'no avatar'} aria-hidden="true"
  ></span>
{/if}

<style>
  span.avatar {
    display: inline-block;
  }
</style>
