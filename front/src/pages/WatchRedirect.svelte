<script lang="ts">
  // /watch/:sha1 used to be a page of its own. The run's page plays the replay
  // now, so this only resolves the hash to its run and sends the visitor there.
  // Links posted while the old page existed keep working, which is the whole
  // point of an archive.
  import { api } from '../lib/api';
  import { navigate } from '../lib/router.svelte';

  let { sha1 }: { sha1: string } = $props();
  let failed = $state(false);

  $effect(() => {
    api<{ pastRunId: number | null }>(`/api/replays/${sha1}`)
      .then((r) => {
        if (r.pastRunId) navigate(`/runs/${r.pastRunId}`, true);
        else failed = true;
      })
      .catch(() => (failed = true));
  });
</script>

{#if failed}
  <h1>Replay</h1>
  <p class="notice">
    This replay is not tied to a run the archive knows, so there is no page to send you to. The file
    itself is still here:
    <a href={`/api/replays/${sha1}/download`} rel="external" download>download it</a>.
  </p>
{:else}
  <p class="muted">Taking you to the run.</p>
{/if}
