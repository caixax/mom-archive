<script lang="ts">
  // Shows the identity as observed at the time of the run, with the current one when different.
  import Avatar from './Avatar.svelte';

  let {
    userId,
    observedAlias,
    observedAvatarHash,
    currentAlias,
    currentAvatarHash,
    steamName,
  }: {
    userId: number | null | undefined;
    observedAlias: string | null | undefined;
    observedAvatarHash?: string | null;
    currentAlias?: string | null;
    currentAvatarHash?: string | null;
    steamName?: string | null;
  } = $props();

  const changed = $derived(
    currentAlias != null && observedAlias != null && currentAlias !== observedAlias,
  );
  const avatarChanged = $derived(
    currentAvatarHash != null &&
      observedAvatarHash != null &&
      currentAvatarHash !== observedAvatarHash,
  );
  const shownAlias = $derived(
    observedAlias ?? currentAlias ?? (userId != null ? `user ${userId}` : 'unknown'),
  );
</script>

<span class="identity">
  <Avatar hash={observedAvatarHash ?? currentAvatarHash} alt="" size="sm" />
  {#if userId != null}
    <a href={`/users/${userId}`} title={changed ? `now: ${currentAlias}` : undefined}
      >{shownAlias}</a
    >
  {:else}
    <span>{shownAlias}</span>
  {/if}
  {#if changed}
    <span class="muted small" title="current alias">(now {currentAlias})</span>
  {/if}
  {#if avatarChanged}
    <span class="badge" title="avatar changed since">avatar changed</span>
  {/if}
  {#if steamName && steamName !== shownAlias}
    <span class="muted small" title="Steam persona name at the time">[steam: {steamName}]</span>
  {/if}
</span>

<style>
  .identity {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
</style>
