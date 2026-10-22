<script lang="ts">
  // Writing the Ledger: a list of posts and an editor with a live preview. Drafts
  // are private until published; editing a published post keeps the old text as
  // a revision the public can read, with the note written here.
  import { api } from '../lib/api';
  import { formatDate, relTime } from '../lib/format';
  import { KIND_LABEL, type LedgerKind } from '../lib/ledger';
  import { prefixLines, wrapSelection } from '../lib/markdown';
  import { send } from '../lib/session.svelte';
  import Markdown from '../components/md/Markdown.svelte';

  interface Props {
    /** Post to open right away, for a case drafted from the dashboard. */
    openId?: number | null;
    onmessage: (kind: 'ok' | 'error', text: string) => void;
  }
  let { openId = null, onmessage }: Props = $props();

  interface Row {
    id: number;
    slug: string;
    kind: LedgerKind;
    title: string;
    status: 'draft' | 'published';
    pinned: boolean;
    subjectUserId: number | null;
    subjectAlias: string | null;
    publishedAt: string | null;
    editedAt: string | null;
    updatedAt: string;
    chars: number;
    revisions: number;
  }
  interface Post {
    id: number;
    slug: string;
    kind: LedgerKind;
    title: string;
    summary: string | null;
    body: string;
    status: 'draft' | 'published';
    pinned: boolean;
    subjectUserId: number | null;
    publishedAt: string | null;
    editedAt: string | null;
    revisions: { id: number; validFrom: string; validTo: string; note: string | null }[];
  }

  const kinds: LedgerKind[] = ['case', 'news', 'concern', 'changelog'];
  let rows = $state<Row[]>([]);
  let post = $state<Post | null>(null);
  let saved = $state('');
  let busy = $state(false);
  let view = $state<'split' | 'write' | 'preview'>('split');
  let note = $state('');
  let schedule = $state('');
  let showHelp = $state(false);
  let newKind = $state<LedgerKind>('news');
  let textarea = $state<HTMLTextAreaElement | null>(null);

  const snapshot = (p: Post | null) =>
    p
      ? JSON.stringify([
          p.kind,
          p.title,
          p.slug,
          p.summary ?? '',
          p.body,
          p.pinned,
          p.subjectUserId,
        ])
      : '';
  const rowMeta = (r: Row) =>
    [
      KIND_LABEL[r.kind],
      r.pinned ? 'pinned' : '',
      r.revisions ? `${r.revisions} rev` : '',
      relTime(r.updatedAt),
    ]
      .filter(Boolean)
      .join(', ');
  const dirty = $derived(post !== null && snapshot(post) !== saved);
  const live = $derived(
    post?.status === 'published' && post.publishedAt && new Date(post.publishedAt) <= new Date(),
  );

  async function loadList() {
    try {
      rows = (await api<{ data: Row[] }>('/api/admin/ledger')).data;
    } catch (e) {
      onmessage('error', (e as Error).message);
    }
  }

  async function open(id: number) {
    if (dirty && !confirm('Discard the unsaved changes to this post?')) return;
    try {
      const p = (await api<{ data: Post }>(`/api/admin/ledger/${id}`)).data;
      post = p;
      saved = snapshot(p);
      note = '';
      schedule = '';
    } catch (e) {
      onmessage('error', (e as Error).message);
    }
  }

  $effect(() => {
    void loadList();
  });
  $effect(() => {
    if (openId) void open(openId);
  });
  $effect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  async function create() {
    if (dirty && !confirm('Discard the unsaved changes to this post?')) return;
    const title = prompt('Title of the new post');
    if (!title?.trim()) return;
    busy = true;
    try {
      const r = await send<{ data: Post }>('POST', '/api/admin/ledger', {
        kind: newKind,
        title: title.trim(),
      });
      await loadList();
      post = { ...r.data, revisions: [] };
      saved = snapshot(post);
      onmessage('ok', 'Draft created.');
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function save(extra: Record<string, unknown> = {}) {
    if (!post) return;
    busy = true;
    try {
      const body: Record<string, unknown> = {
        kind: post.kind,
        title: post.title,
        summary: post.summary?.trim() ? post.summary : null,
        body: post.body,
        pinned: post.pinned,
        subjectUserId: post.subjectUserId || null,
        ...extra,
      };
      if (post.status === 'draft') body.slug = post.slug;
      if (live && note.trim()) body.note = note.trim();
      const r = await send<{ data: Post }>('PATCH', `/api/admin/ledger/${post.id}`, body);
      const revisions = post.revisions;
      post = { ...r.data, revisions };
      saved = snapshot(post);
      note = '';
      await loadList();
      // Reload so a new revision shows up in the list under the editor.
      const fresh = (await api<{ data: Post }>(`/api/admin/ledger/${post.id}`)).data;
      post.revisions = fresh.revisions;
      onmessage(
        'ok',
        extra.status === 'published'
          ? 'Published.'
          : extra.status === 'draft'
            ? 'Back to draft.'
            : 'Saved.',
      );
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function publish() {
    if (!post) return;
    const when = schedule ? new Date(schedule) : null;
    const msg = when
      ? `Publish "${post.title}" on ${formatDate(when.toISOString())}?`
      : `Publish "${post.title}" now? It becomes public at /ledger/${post.slug}.`;
    if (!confirm(msg)) return;
    await save({ status: 'published', ...(when ? { publishedAt: when.toISOString() } : {}) });
  }

  async function unpublish() {
    if (!post) return;
    if (!confirm('Take this post down? Its address stops working until it is published again.'))
      return;
    await save({ status: 'draft' });
  }

  async function remove() {
    if (!post) return;
    const word = post.status === 'published' ? 'published post and its revisions' : 'draft';
    if (!confirm(`Delete this ${word} for good?`)) return;
    busy = true;
    try {
      await send('DELETE', `/api/admin/ledger/${post.id}`);
      post = null;
      saved = '';
      await loadList();
      onmessage('ok', 'Deleted.');
    } catch (e) {
      onmessage('error', (e as Error).message);
    } finally {
      busy = false;
    }
  }

  function slugFromTitle() {
    if (!post || post.status !== 'draft') return;
    post.slug =
      post.title
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72)
        .replace(/-+$/g, '') || 'post';
  }

  // Toolbar

  function wrap(before: string, after = before, placeholder = 'text') {
    if (!post || !textarea) return;
    post.body = wrapSelection(textarea, before, after, placeholder);
  }
  function lines(prefix: string) {
    if (!post || !textarea) return;
    post.body = prefixLines(textarea, prefix);
  }
  function insert(text: string) {
    if (!post || !textarea) return;
    const { selectionStart: a, selectionEnd: b, value } = textarea;
    post.body = value.slice(0, a) + text + value.slice(b);
    const el = textarea;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(a + text.length, a + text.length);
    });
  }
  function link() {
    const url = prompt('Link to (https://..., or a path on this site like /users/14991)');
    if (url) wrap('[', `](${url.trim()})`, 'link text');
  }
  function ref(kind: 'user' | 'map' | 'run' | 'replay') {
    const hint =
      kind === 'user'
        ? 'Momentum user id'
        : kind === 'map'
          ? 'map id or name'
          : kind === 'run'
            ? 'run id'
            : 'replay sha1';
    const id = prompt(`Reference a ${kind}: ${hint}`);
    if (id?.trim()) insert(`[[${kind}:${id.trim()}]]`);
  }
  function table() {
    insert('\n| Column | Column |\n| --- | --- |\n| value | value |\n');
  }

  function keys(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      if (dirty && !busy) void save();
    } else if (k === 'b') {
      e.preventDefault();
      wrap('**');
    } else if (k === 'i') {
      e.preventDefault();
      wrap('*');
    } else if (k === 'k') {
      e.preventDefault();
      link();
    }
  }
</script>

<div class="ledger-admin">
  <aside class="list">
    <div class="filters">
      <select bind:value={newKind} aria-label="Kind of the new post">
        {#each kinds as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
      </select>
      <button class="primary" onclick={create} disabled={busy}>New post</button>
    </div>
    <ul>
      {#each rows as r (r.id)}
        <li class:active={post?.id === r.id}>
          <button class="row" onclick={() => open(r.id)}>
            <span class="t">{r.title}</span>
            <span class="small muted">
              <span class="badge {r.status === 'published' ? 'ok' : ''}"
                >{r.status === 'published'
                  ? r.publishedAt && new Date(r.publishedAt) > new Date()
                    ? 'scheduled'
                    : 'live'
                  : 'draft'}</span
              >
              {rowMeta(r)}
            </span>
          </button>
        </li>
      {:else}
        <li class="muted small">
          No posts yet. Write the first one, or draft a case from a ban on the dashboard.
        </li>
      {/each}
    </ul>
  </aside>

  <section class="editor">
    {#if post}
      <div class="fields">
        <label class="wide"
          >Title <input
            bind:value={post.title}
            maxlength="200"
            onblur={() => post?.status === 'draft' && !post.slug && slugFromTitle()}
          /></label
        >
        <label
          >Kind
          <select bind:value={post.kind}>
            {#each kinds as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
          </select>
        </label>
        <label
          >Address
          <span class="slug"
            ><span class="muted">/ledger/</span><input
              bind:value={post.slug}
              maxlength="80"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              disabled={post.status === 'published'}
              title={post.status === 'published' ? 'A published post keeps its address' : ''}
            />{#if post.status === 'draft'}<button class="link" onclick={slugFromTitle}
                >from title</button
              >{/if}</span
          ></label
        >
        <label
          >About player id <input
            class="narrow"
            type="number"
            min="1"
            bind:value={post.subjectUserId}
            placeholder="optional"
          /></label
        >
        <label class="check"><input type="checkbox" bind:checked={post.pinned} /> pinned</label>
        <label class="wide"
          >Summary, shown in lists and the feed <input
            bind:value={post.summary}
            maxlength="500"
            placeholder="One or two plain sentences"
          /></label
        >
      </div>

      <div class="toolbar" role="toolbar" aria-label="Formatting">
        <button onclick={() => wrap('**')} title="Bold (Ctrl+B)"><b>B</b></button>
        <button onclick={() => wrap('*')} title="Italic (Ctrl+I)"><i>I</i></button>
        <button onclick={() => wrap('~~')} title="Strikethrough"><s>S</s></button>
        <button onclick={() => lines('## ')} title="Heading">H2</button>
        <button onclick={() => lines('### ')} title="Subheading">H3</button>
        <button onclick={link} title="Link (Ctrl+K)">link</button>
        <button onclick={() => lines('> ')} title="Quote">quote</button>
        <button onclick={() => lines('- ')} title="List">list</button>
        <button onclick={() => lines('1. ')} title="Numbered list">1.</button>
        <button onclick={() => wrap('`')} title="Inline code">code</button>
        <button onclick={() => wrap('\n```\n', '\n```\n', 'code')} title="Code block">block</button>
        <button onclick={table} title="Table">table</button>
        <button onclick={() => insert('\n\n---\n\n')} title="Divider">rule</button>
        <span class="sep"></span>
        <button onclick={() => ref('user')} title="Reference a player">+player</button>
        <button onclick={() => ref('run')} title="Reference a run">+run</button>
        <button onclick={() => ref('replay')} title="Reference a replay">+replay</button>
        <button onclick={() => ref('map')} title="Reference a map">+map</button>
        <span class="sep"></span>
        <select bind:value={view} aria-label="Layout">
          <option value="split">side by side</option>
          <option value="write">write</option>
          <option value="preview">preview</option>
        </select>
        <button class="link" onclick={() => (showHelp = !showHelp)}
          >{showHelp ? 'hide help' : 'help'}</button
        >
      </div>

      {#if showHelp}
        <div class="help small">
          <p>
            <code>**bold**</code> <code>*italic*</code> <code>~~struck~~</code>
            <code>`code`</code> <code>[text](https://...)</code> <code>## Heading</code>
            <code>- list</code> <code>1. list</code> <code>&gt; quote</code> <code>---</code>,
            tables with <code>| a | b |</code>. Raw HTML is shown as typed, never run.
          </p>
          <p>
            References turn into live links with what the archive knows:
            <code>[[user:14991]]</code> <code>[[run:123456]]</code>
            <code>[[replay:&lt;sha1&gt;]]</code> <code>[[map:bhop_arcane]]</code>. Images only from
            the archive itself: <code>![alt](/api/maps/images/&lt;id&gt;)</code>.
          </p>
          <p>Ctrl+S saves, Ctrl+B bold, Ctrl+I italic, Ctrl+K link.</p>
        </div>
      {/if}

      <div class="panes {view}">
        {#if view !== 'preview'}
          <textarea
            bind:this={textarea}
            bind:value={post.body}
            onkeydown={keys}
            spellcheck="true"
            maxlength="100000"
            aria-label="Body, Markdown"
            placeholder="Write in Markdown. The toolbar and the help above show what works."
          ></textarea>
        {/if}
        {#if view !== 'write'}
          <div class="preview" aria-label="Preview">
            <h1>{post.title}</h1>
            {#if post.summary}<p class="lead">{post.summary}</p>{/if}
            <Markdown source={post.body} />
          </div>
        {/if}
      </div>
      <p class="small muted">{post.body.length.toLocaleString('en-US')} of 100,000 characters.</p>

      <div class="actions">
        {#if live}
          <input
            class="note"
            bind:value={note}
            maxlength="300"
            placeholder="What this edit changes (shown with the earlier version)"
          />
        {/if}
        <button class="primary" onclick={() => save()} disabled={busy || !dirty}
          >{dirty ? 'Save' : 'Saved'}</button
        >
        {#if post.status === 'draft'}
          <label class="small"
            >publish at <input type="datetime-local" bind:value={schedule} /></label
          >
          <button onclick={publish} disabled={busy || dirty} title={dirty ? 'Save first' : ''}
            >{schedule ? 'Schedule' : 'Publish'}</button
          >
        {:else}
          <a href={`/ledger/${post.slug}`} target="_blank" rel="noopener">view</a>
          <button onclick={unpublish} disabled={busy}>Unpublish</button>
        {/if}
        <button class="danger" onclick={remove} disabled={busy}>Delete</button>
      </div>
      <p class="small muted">
        {#if post.status === 'published'}
          {live ? 'Live since' : 'Scheduled for'}
          {formatDate(post.publishedAt)}{#if post.editedAt}, last edited {formatDate(
              post.editedAt,
            )}{/if}. Saving a change to the title, summary or text keeps the current text as a
          revision anyone can read.
        {:else}
          Draft: only you can see it.
        {/if}
      </p>
      {#if post.revisions.length}
        <details>
          <summary class="small">{post.revisions.length} earlier version(s)</summary>
          <ul class="small">
            {#each post.revisions as r (r.id)}
              <li>
                <a href={`/ledger/${post.slug}?rev=${r.id}`} target="_blank" rel="noopener"
                  >{formatDate(r.validFrom)} to {formatDate(r.validTo)}</a
                >{#if r.note}: {r.note}{/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {:else}
      <p class="muted">
        Pick a post on the left or start a new one. Cases about bans can be drafted straight from
        the dashboard: the draft comes filled with the archive's records for that player.
      </p>
    {/if}
  </section>
</div>

<style>
  .ledger-admin {
    display: grid;
    grid-template-columns: minmax(14rem, 18rem) 1fr;
    gap: 1rem;
    align-items: start;
  }
  @media (max-width: 860px) {
    .ledger-admin {
      grid-template-columns: 1fr;
    }
  }
  .list ul {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 70vh;
    overflow-y: auto;
  }
  .list li {
    border-bottom: 1px solid var(--border);
  }
  .list li.active {
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
  .row .badge {
    margin-left: 0;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1rem;
    align-items: flex-end;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .fields label.wide {
    flex: 1 1 100%;
  }
  .fields label.wide input {
    width: 100%;
  }
  .fields label.check {
    flex-direction: row;
    align-items: center;
  }
  .slug {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }
  input.narrow {
    width: 8rem;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
    margin: 0.8rem 0 0.4rem;
    position: sticky;
    top: 0;
    background: var(--bg);
    padding: 0.3rem 0;
    z-index: 1;
  }
  .toolbar button {
    padding: 0.2rem 0.5rem;
    min-width: 2rem;
  }
  .sep {
    width: 1px;
    height: 1.4rem;
    background: var(--border);
    margin: 0 0.3rem;
  }
  .help {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
  }
  .panes {
    display: grid;
    gap: 0.8rem;
  }
  .panes.split {
    grid-template-columns: 1fr 1fr;
  }
  @media (max-width: 1100px) {
    .panes.split {
      grid-template-columns: 1fr;
    }
  }
  textarea {
    width: 100%;
    min-height: 60vh;
    font-family: var(--mono);
    font-size: 0.9rem;
    line-height: 1.5;
    background: var(--bg-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.6rem;
    resize: vertical;
    box-sizing: border-box;
  }
  .preview {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 1rem;
    min-height: 60vh;
    max-height: 80vh;
    overflow-y: auto;
  }
  .preview h1 {
    font-size: 1.5rem;
  }
  .lead {
    font-size: 1.05rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.5rem;
  }
  .actions .note {
    flex: 1 1 18rem;
  }
  button.danger {
    color: var(--err);
    border-color: var(--err);
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
