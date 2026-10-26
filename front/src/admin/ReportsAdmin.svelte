<script lang="ts">
  // Answering reports. Anonymous reporters are a code; only signed reports (a
  // request about the player's own data, or their side of a record) say who sent
  // them. Replies reach the reporter signed "Admin".
  import { api } from '../lib/api';
  import { formatDate, relTime } from '../lib/format';
  import { CATEGORY_INFO } from '../lib/member.svelte';
  import { confirmDialog, promptDialog } from '../lib/dialog.svelte';
  import { send } from '../lib/session.svelte';
  import Markdown from '../components/md/Markdown.svelte';
  import MiniEditor from '../components/md/MiniEditor.svelte';

  interface Props {
    onmessage: (kind: 'ok' | 'error', text: string) => void;
  }
  let { onmessage }: Props = $props();

  interface Reporter {
    code: string;
    key: string;
    blocked: boolean;
    blockedNote?: string | null;
    reportsTotal: number;
    firstSeenAt?: string | null;
    steamId: string | null;
    userId: number | null;
    alias: string | null;
    privacy?: { hideBio: boolean; hideSocials: boolean; hideAvatars: boolean } | null;
  }
  interface Row {
    id: number;
    publicId: string;
    category: string;
    subjectKind: string | null;
    subjectId: string | null;
    title: string;
    status: string;
    identified: boolean;
    reporter: Reporter;
    messages: number;
    createdAt: string;
    lastMessageAt: string;
    unread: boolean;
  }
  interface Thread extends Omit<Row, 'messages' | 'unread' | 'lastMessageAt'> {
    subjectLabel: string | null;
    messages: { id: number; author: string; body: string; createdAt: string }[];
  }
  interface Hide {
    userId: number;
    alias: string | null;
    hideBio: boolean;
    hideSocials: boolean;
    hideAvatars: boolean;
    note: string | null;
    updatedAt: string;
  }

  let status = $state('active');
  let rows = $state<Row[]>([]);
  let counts = $state<Record<string, number>>({});
  let thread = $state<Thread | null>(null);
  let reply = $state('');
  let busy = $state(false);
  let hides = $state<Hide[]>([]);
  let priv = $state({ hideBio: false, hideSocials: false, hideAvatars: false });

  async function loadList() {
    try {
      const r = await api<{ data: Row[]; counts: Record<string, number> }>('/api/admin/reports', {
        status: status === 'all' ? undefined : status,
      });
      rows = r.data;
      counts = r.counts;
    } catch (e) {
      onmessage('error', (e as Error).message);
    }
  }
  async function loadHides() {
    try {
      hides = (await api<{ data: Hide[] }>('/api/admin/privacy')).data;
    } catch (e) {
      onmessage('error', (e as Error).message);
    }
  }
  async function open(id: number) {
    try {
      thread = (await api<{ data: Thread }>(`/api/admin/reports/${id}`)).data;
      const p = thread.reporter.privacy;
      priv = {
        hideBio: p?.hideBio ?? false,
        hideSocials: p?.hideSocials ?? false,
        hideAvatars: p?.hideAvatars ?? false,
      };
      reply = '';
      const row = rows.find((r) => r.id === id);
      if (row) row.unread = false;
    } catch (e) {
      onmessage('error', (e as Error).message);
    }
  }

  $effect(() => {
    void status;
    void loadList();
  });
  $effect(() => {
    void loadHides();
  });

  async function answer(close: boolean) {
    if (!thread || !reply.trim()) return;
    busy = true;
    try {
      await send('POST', `/api/admin/reports/${thread.id}/messages`, { body: reply, close });
      onmessage(
        'ok',
        close ? 'Answered and closed.' : 'Answered. The reporter sees it signed Admin.',
      );
      await open(thread.id);
      await loadList();
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function setStatus(s: string) {
    if (!thread) return;
    busy = true;
    try {
      await send('PATCH', `/api/admin/reports/${thread.id}`, { status: s });
      thread.status = s;
      await loadList();
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function block(on: boolean) {
    if (!thread) return;
    let note: string | null = null;
    if (on) {
      note = await promptDialog({
        title: `Block reporter ${thread.reporter.code}?`,
        message: 'They can still sign in, but cannot send reports or messages. You can undo it.',
        label: 'Why, kept with the block and seen only by you',
        value: 'spam',
        confirmLabel: 'Block',
      });
      if (note === null) return;
    }
    busy = true;
    try {
      await send('POST', `/api/admin/members/${thread.reporter.key}/block`, {
        blocked: on,
        ...(note ? { note } : {}),
      });
      onmessage('ok', on ? `Reporter ${thread.reporter.code} blocked.` : 'Unblocked.');
      await open(thread.id);
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function savePrivacy() {
    if (!thread?.reporter.userId) return;
    busy = true;
    try {
      await send('PUT', `/api/admin/privacy/${thread.reporter.userId}`, {
        ...priv,
        note: `report ${thread.publicId}`,
        reportId: thread.id,
      });
      onmessage('ok', 'Profile updated. It takes effect on the public pages at once.');
      await loadHides();
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function clearHide(h: Hide) {
    const ok = await confirmDialog({
      title: 'Show this profile in full again?',
      message: `${h.alias ?? `user ${h.userId}`}'s hidden bio, social links or avatars become visible again.`,
      confirmLabel: 'Show again',
    });
    if (!ok) return;
    busy = true;
    try {
      await send('PUT', `/api/admin/privacy/${h.userId}`, {
        hideBio: false,
        hideSocials: false,
        hideAvatars: false,
      });
      await loadHides();
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  const subjectHref = (k: string | null, id: string | null) =>
    k && id ? `/${k === 'user' ? 'users' : k === 'run' ? 'runs' : 'maps'}/${id}` : null;
  const reporterStats = (r: Reporter) =>
    `${r.reportsTotal} report(s) from this account` +
    (r.firstSeenAt ? `, first signed in ${formatDate(r.firstSeenAt, false)}.` : '.');
  const reporterName = (r: Reporter) =>
    r.alias ? `${r.alias}` : r.steamId ? r.steamId : `Reporter ${r.code}`;
</script>

<div class="filters">
  <label
    >show
    <select bind:value={status}>
      <option value="active">not closed</option>
      <option value="open">waiting for you</option>
      <option value="answered">answered</option>
      <option value="closed">closed</option>
      <option value="all">all</option>
    </select>
  </label>
  <span class="small muted"
    >{counts.unread ?? 0} with something new, {counts.active ?? 0} not closed, {counts.total ?? 0} in
    all.</span
  >
</div>

<div class="reports">
  <aside>
    <ul>
      {#each rows as r (r.id)}
        <li class:active={thread?.id === r.id}>
          <button class="row" onclick={() => open(r.id)}>
            <span class="t"
              >{#if r.unread}<span class="dot ok"></span>{/if}{r.title}</span
            >
            <span class="small muted">
              {CATEGORY_INFO[r.category]?.label ?? r.category}, {r.identified
                ? reporterName(r.reporter)
                : `#${r.reporter.code}`}{r.reporter.blocked ? ' (blocked)' : ''}, {relTime(
                r.lastMessageAt,
              )}
            </span>
          </button>
        </li>
      {:else}
        <li class="muted small">Nothing here.</li>
      {/each}
    </ul>
  </aside>

  <section>
    {#if thread}
      <h2>{thread.title}</h2>
      <p class="small">
        <span class="badge {thread.identified ? 'warn' : ''}"
          >{thread.identified ? 'signed' : 'anonymous'}</span
        >
        {CATEGORY_INFO[thread.category]?.label ?? thread.category}, sent {formatDate(
          thread.createdAt,
        )}.
        {#if subjectHref(thread.subjectKind, thread.subjectId)}
          About <a
            href={subjectHref(thread.subjectKind, thread.subjectId)}
            target="_blank"
            rel="noopener">{thread.subjectLabel ?? `${thread.subjectKind} ${thread.subjectId}`}</a
          >.
        {/if}
      </p>

      <div class="who card">
        {#if thread.identified}
          <strong>Signed by</strong>
          {#if thread.reporter.userId}<a
              href={`/users/${thread.reporter.userId}`}
              target="_blank"
              rel="noopener">{thread.reporter.alias ?? `user ${thread.reporter.userId}`}</a
            >{/if}
          <span class="mono small">{thread.reporter.steamId}</span>
        {:else}
          <strong>Reporter <span class="mono">{thread.reporter.code}</span></strong>
          <span class="small muted">anonymous: the archive does not tell you who this is.</span>
        {/if}
        <span class="small muted">{reporterStats(thread.reporter)}</span>
        {#if thread.reporter.blocked}
          <span class="badge err">blocked</span>{#if thread.reporter.blockedNote}<span
              class="small muted"
            >
              {thread.reporter.blockedNote}</span
            >{/if}
          <button class="link" onclick={() => block(false)} disabled={busy}>unblock</button>
        {:else}
          <button class="link" onclick={() => block(true)} disabled={busy}
            >block this reporter</button
          >
        {/if}
      </div>

      {#if thread.category === 'privacy' && thread.reporter.userId}
        <div class="card privacy">
          <strong>Privacy request</strong>
          <span class="small muted"
            >Hide on {thread.reporter.alias ?? `user ${thread.reporter.userId}`}'s public profile.
            The archive keeps the data; it is just not served.</span
          >
          <div class="filters">
            <label><input type="checkbox" bind:checked={priv.hideBio} /> bio</label>
            <label><input type="checkbox" bind:checked={priv.hideSocials} /> social links</label>
            <label
              ><input type="checkbox" bind:checked={priv.hideAvatars} /> avatars, everywhere</label
            >
            <button onclick={savePrivacy} disabled={busy}>Apply</button>
          </div>
        </div>
      {/if}

      <ol class="thread">
        {#each thread.messages as m (m.id)}
          <li class={m.author}>
            <div class="small">
              <strong
                >{m.author === 'admin'
                  ? 'Admin (you)'
                  : thread.identified
                    ? reporterName(thread.reporter)
                    : `Reporter ${thread.reporter.code}`}</strong
              >
              <span class="muted mono">{formatDate(m.createdAt)}</span>
            </div>
            <Markdown source={m.body} images={false} />
          </li>
        {/each}
      </ol>

      <MiniEditor
        bind:value={reply}
        rows={5}
        placeholder="Your answer. The reporter sees it signed Admin."
      />
      <div class="filters">
        <button class="primary" onclick={() => answer(false)} disabled={busy || !reply.trim()}
          >Answer</button
        >
        <button onclick={() => answer(true)} disabled={busy || !reply.trim()}
          >Answer and close</button
        >
        <span class="grow"></span>
        <label
          >state
          <select
            value={thread.status}
            onchange={(e) => setStatus(e.currentTarget.value)}
            disabled={busy}
          >
            <option value="open">open</option>
            <option value="answered">answered</option>
            <option value="closed">closed</option>
          </select>
        </label>
      </div>
    {:else}
      <p class="muted">
        Pick a report. Anonymous ones show a code instead of a name; the same code means the same
        person.
      </p>
    {/if}
  </section>
</div>

<h2>Profiles with hidden parts</h2>
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Player</th><th>Bio</th><th>Socials</th><th>Avatars</th><th>Note</th><th>Since</th><th
        ></th></tr
      ></thead
    >
    <tbody>
      {#each hides as h (h.userId)}
        <tr>
          <td><a href={`/users/${h.userId}`}>{h.alias ?? `user ${h.userId}`}</a></td>
          <td>{h.hideBio ? 'hidden' : ''}</td>
          <td>{h.hideSocials ? 'hidden' : ''}</td>
          <td>{h.hideAvatars ? 'hidden' : ''}</td>
          <td class="small muted">{h.note ?? ''}</td>
          <td class="mono small">{formatDate(h.updatedAt, false)}</td>
          <td
            ><button class="link" onclick={() => clearHide(h)} disabled={busy}>show again</button
            ></td
          >
        </tr>
      {:else}
        <tr><td colspan="7" class="muted">None.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .reports {
    display: grid;
    grid-template-columns: minmax(14rem, 20rem) 1fr;
    gap: 1rem;
    align-items: start;
  }
  @media (max-width: 860px) {
    .reports {
      grid-template-columns: 1fr;
    }
  }
  aside ul {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 70vh;
    overflow-y: auto;
  }
  aside li {
    border-bottom: 1px solid var(--border);
  }
  aside li.active {
    background: var(--bg-2);
    border-left: 3px solid var(--accent);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 0.5rem 0.4rem;
    cursor: pointer;
    font: inherit;
  }
  .row .dot {
    margin-right: 0.35rem;
  }
  section h2 {
    margin-top: 0;
  }
  .who,
  .privacy {
    margin: 0.6rem 0;
  }
  .thread {
    list-style: none;
    padding: 0;
  }
  .thread li {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.9rem 0.1rem;
    margin: 0.6rem 0;
  }
  .thread li.admin {
    border-left: 3px solid var(--accent);
    background: var(--bg-2);
  }
  .grow {
    flex: 1;
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0 0.2rem;
    font: inherit;
    text-decoration: underline;
  }
</style>
