<script lang="ts">
  // One [[kind:id]] reference: a link with what the archive knows about it.
  import { avatarSrc } from '../../lib/api';
  import { formatTime } from '../../lib/format';
  import type { RefToken } from '../../lib/markdown';
  import { md } from './context';

  interface Props {
    ref: RefToken;
  }
  let { ref }: Props = $props();
  const ctx = md();

  const user = $derived(ref.kind === 'user' ? ctx.refs?.users[ref.id] : undefined);
  const map = $derived(ref.kind === 'map' ? ctx.refs?.maps[ref.id] : undefined);
  const run = $derived(ref.kind === 'run' ? ctx.refs?.runs[ref.id] : undefined);
  const replay = $derived(ref.kind === 'replay' ? ctx.refs?.replays[ref.id] : undefined);
</script>

{#if ref.kind === 'user'}
  <a class="ref" href={`/users/${ref.id}`}
    >{#if user?.avatarHash}<img
        class="avatar sm"
        src={avatarSrc(user.avatarHash)}
        alt=""
        loading="lazy"
      />{/if}{user?.alias ?? `user ${ref.id}`}</a
  >{#if user?.banNames.length}<span class="badge err">{user.banNames.join(', ')} ban</span>{/if}
{:else if ref.kind === 'map'}
  <a class="ref" href={`/maps/${encodeURIComponent(map?.name ?? ref.id)}`}>{map?.name ?? ref.id}</a>
{:else if ref.kind === 'run'}
  <a class="ref" href={`/runs/${ref.id}`}
    >{#if run}{run.alias ?? '?'} on {run.mapName ?? '?'}, {formatTime(run.time)}{#if run.rank}
        (#{run.rank}){/if}{:else}run {ref.id}{/if}</a
  >{#if run?.removedAt}<span class="badge removed">removed</span>{/if}
{:else if ref.kind === 'replay'}
  <a class="ref" href={`/watch/${ref.id}`}
    >watch{#if replay}: {replay.alias ?? '?'} on {replay.mapName ?? '?'}{#if replay.time !== null},
        {formatTime(replay.time)}{/if}{:else}
      replay {ref.id.slice(0, 8)}{/if}</a
  >
{/if}

<style>
  .ref {
    white-space: nowrap;
  }
  .ref .avatar {
    margin-right: 0.25rem;
    vertical-align: -0.2em;
  }
</style>
