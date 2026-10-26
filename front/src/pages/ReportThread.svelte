<script lang="ts">
  // One report and its conversation with the archive owner, who signs as Admin.
  import { api } from '../lib/api';
  import { confirmDialog } from '../lib/dialog.svelte';
  import { formatDate } from '../lib/format';
  import { CATEGORY_INFO, loadMember, loginHref, member, memberSend } from '../lib/member.svelte';
  import Markdown from '../components/md/Markdown.svelte';
  import MiniEditor from '../components/md/MiniEditor.svelte';

  let { id }: { id: string } = $props();

  interface Thread {
    publicId: string;
    category: string;
    subjectKind: string | null;
    subjectId: string | null;
    title: string;
    status: string;
    identified: boolean;
    createdAt: string;
    messages: { id: number; author: 'you' | 'admin'; body: string; createdAt: string }[];
  }
  let thread = $state<Thread | null>(null);
  let error = $state<string | null>(null);
  let reply = $state('');
  let busy = $state(false);

  async function load() {
    try {
      thread = (await api<{ data: Thread }>(`/api/member/reports/${encodeURIComponent(id)}`)).data;
      member.unread = Math.max(0, member.unread - 1);
    } catch (e) {
      error = String((e as Error).message);
    }
  }

  $effect(() => {
    void loadMember(true).then(() => {
      if (member.authenticated) void load();
    });
  });

  async function send(e: Event) {
    e.preventDefault();
    if (!reply.trim()) return;
    busy = true;
    try {
      await memberSend(`/api/member/reports/${encodeURIComponent(id)}/messages`, { body: reply });
      reply = '';
      await load();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function close() {
    const ok = await confirmDialog({
      title: 'Close this report?',
      message: 'You will not be able to add to it. You can always send a new one.',
      confirmLabel: 'Close report',
    });
    if (!ok) return;
    busy = true;
    try {
      await memberSend(`/api/member/reports/${encodeURIComponent(id)}/close`);
      await load();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<p class="small"><a href="/reports">Your reports</a></p>

{#if !member.loaded}
  <p class="muted">Checking.</p>
{:else if !member.authenticated}
  <p>Sign in to read this report.</p>
  <p>
    <a href={loginHref(`/reports/${id}`)} rel="external"
      ><button class="primary">Sign in through Steam</button></a
    >
  </p>
{:else if error && !thread}
  <p class="error">{error}</p>
{:else if thread}
  <h1>{thread.title}</h1>
  <p class="small muted">
    {CATEGORY_INFO[thread.category]?.label ?? thread.category}{#if thread.identified}<span
        class="badge warn">signed</span
      >{:else}<span class="badge">anonymous, code {member.code}</span>{/if}
    <span class="badge {thread.status === 'answered' ? 'ok' : ''}">{thread.status}</span>
    {#if thread.subjectKind && thread.subjectId}<span class="about"
        >About <Markdown
          source={`[[${thread.subjectKind}:${thread.subjectId}]]`}
          images={false}
        /></span
      >{/if}
  </p>

  <ol class="thread">
    {#each thread.messages as m (m.id)}
      <li class={m.author}>
        <div class="who small">
          <strong>{m.author === 'admin' ? 'Admin' : 'You'}</strong>
          <span class="muted mono">{formatDate(m.createdAt)}</span>
        </div>
        <Markdown source={m.body} images={false} />
      </li>
    {/each}
  </ol>

  {#if thread.status !== 'closed'}
    <form onsubmit={send} class="reply">
      <MiniEditor bind:value={reply} rows={4} placeholder="Add to this report" />
      {#if error}<p class="error">{error}</p>{/if}
      <p>
        <button class="primary" type="submit" disabled={busy || !reply.trim()}>Send</button>
        <button type="button" onclick={close} disabled={busy}>Close report</button>
      </p>
    </form>
  {:else}
    <p class="muted">This report is closed.</p>
  {/if}
{/if}

<style>
  .thread {
    list-style: none;
    padding: 0;
    max-width: 52rem;
  }
  .thread li {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.2rem 0.9rem;
    margin: 0.7rem 0;
  }
  .thread li.admin {
    border-left: 3px solid var(--accent);
    background: var(--bg-2);
  }
  .who {
    display: flex;
    gap: 0.6rem;
    padding-top: 0.5rem;
  }
  .reply {
    max-width: 52rem;
  }
  .about :global(.md),
  .about :global(.md p) {
    display: inline;
    margin: 0;
  }
</style>
