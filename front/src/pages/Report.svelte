<script lang="ts">
  // Filing a report. Private between the player and the archive owner, and
  // anonymous to the owner unless the category is about the player themselves.
  import { api } from '../lib/api';
  import type { ResolvedRefs } from '../lib/markdown';
  import {
    CATEGORY_INFO,
    loadMember,
    loginHref,
    member,
    memberLogout,
    memberSend,
  } from '../lib/member.svelte';
  import { navigate, route } from '../lib/router.svelte';
  import MiniEditor from '../components/md/MiniEditor.svelte';

  const loginError = $derived(route.query.get('error'));
  let category = $state('');
  let title = $state('');
  let body = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  // A report can start from a player, run or map page: /report?user=14991
  let subjectKind = $state<'user' | 'run' | 'map' | null>(null);
  let subjectId = $state<number | null>(null);
  let subjectLabel = $state<string | null>(null);

  $effect(() => {
    void loadMember(true);
  });

  $effect(() => {
    const q = route.query;
    for (const k of ['user', 'run', 'map'] as const) {
      const v = q.get(k);
      if (v && /^\d{1,12}$/.test(v)) {
        subjectKind = k;
        subjectId = Number(v);
        api<ResolvedRefs>('/api/refs', { [`${k}s`]: v })
          .then((r) => {
            if (k === 'user') subjectLabel = r.users[v]?.alias ?? `player ${v}`;
            else if (k === 'map') subjectLabel = r.maps[v]?.name ?? `map ${v}`;
            else {
              const run = r.runs[v];
              subjectLabel = run
                ? `run by ${run.alias ?? '?'} on ${run.mapName ?? '?'}`
                : `run ${v}`;
            }
          })
          .catch(() => (subjectLabel = `${k} ${v}`));
        return;
      }
    }
  });

  const allowed = (c: string) =>
    CATEGORY_INFO[c]!.identified ? member.canReport.identified : member.canReport.anonymous;

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    if (!category) return void (error = 'Pick what the report is about.');
    if (title.trim().length < 3) return void (error = 'A short title, please.');
    if (!body.trim()) return void (error = 'Write what happened.');
    busy = true;
    try {
      const r = await memberSend<{ data: { publicId: string } }>('/api/member/reports', {
        category,
        title: title.trim(),
        body,
        subjectKind,
        subjectId,
      });
      navigate(`/reports/${r.data.publicId}`);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<h1>Report something</h1>

<section class="how">
  <p>
    Reports go to whoever runs this archive and to nobody else. They are not public, there are no
    comments, and the replies you get are signed <strong>Admin</strong>.
  </p>
  <ul>
    <li>
      <strong>Most reports are anonymous to the owner.</strong> The owner sees a code such as
      <span class="mono">7F3A2C</span>, the same for all your reports, so spam can be blocked, but
      not your Steam account or your Momentum name.
    </li>
    <li>
      <strong>Two kinds are signed</strong>, because they only make sense if the owner knows who is
      asking: a request about your own data, and your side of a case or record about you.
    </li>
    <li>
      Signing in stores that code and, for as long as the sign in lasts (30 days at most), your
      SteamID encrypted. Requests to the report pages are not written to the server's request log.
    </li>
    <li>
      The owner runs the server, so this is a promise kept by how the site is built, not a
      cryptographic guarantee. <a href="/about">More on what this site records.</a>
    </li>
  </ul>
  <p class="small muted">
    Anonymous reports need a Momentum account the archive knows with at least {member.minMaps}
    completed maps and no Momentum ban. Up to 3 new reports a day and 5 open at once.
  </p>
</section>

{#if loginError}<p class="error">Sign in failed: {loginError}</p>{/if}

{#if !member.loaded}
  <p class="muted">Checking.</p>
{:else if !member.enabled}
  <p class="muted">Reports are not open on this instance.</p>
{:else if !member.authenticated}
  <p>
    <a href={loginHref(route.path + window.location.search)} rel="external"
      ><button class="primary">Sign in through Steam</button></a
    >
  </p>
  <p class="small muted">Steam only proves which account you are. No password, no email.</p>
{:else}
  <p class="small">
    {#if member.account?.alias}Signed in as <strong>{member.account.alias}</strong> (shown to you only).{:else}Signed
      in.{/if} Your reporter code is
    <span class="mono">{member.code}</span>.
    <a href="/reports">Your reports</a>{#if member.unread}
      <span class="badge accent">{member.unread} new</span>{/if}.
    <button class="link" onclick={() => memberLogout()}>Sign out</button>
  </p>
  {#if member.reason}<p class="notice">{member.reason}</p>{/if}

  {#if member.canReport.anonymous || member.canReport.identified}
    <form class="report" onsubmit={submit}>
      <fieldset>
        <legend>What is it about?</legend>
        {#each Object.entries(CATEGORY_INFO) as [key, c] (key)}
          <label class="cat" class:disabled={!allowed(key)}>
            <input
              type="radio"
              name="category"
              value={key}
              bind:group={category}
              disabled={!allowed(key)}
            />
            <span>
              <span
                ><strong>{c.label}</strong>
                {#if c.identified}<span class="badge warn">signed</span>{:else}<span class="badge"
                    >anonymous</span
                  >{/if}</span
              >
              <span class="small muted">{c.help}</span>
            </span>
          </label>
        {/each}
      </fieldset>

      {#if subjectKind && subjectId}
        <p class="small">
          About: <strong>{subjectLabel ?? `${subjectKind} ${subjectId}`}</strong>
          <button
            type="button"
            class="link"
            onclick={() => ((subjectKind = null), (subjectId = null))}>remove</button
          >
        </p>
      {/if}

      <label class="field"
        >Title <input bind:value={title} maxlength="120" placeholder="One line" required /></label
      >
      <MiniEditor
        bind:value={body}
        placeholder="What happened, where, and anything that helps check it."
      />
      {#if error}<p class="error">{error}</p>{/if}
      <p><button class="primary" type="submit" disabled={busy}>Send report</button></p>
    </form>
  {/if}
{/if}

<style>
  .how {
    border-left: 3px solid var(--accent);
    padding: 0.1rem 0 0.1rem 0.9rem;
    margin-bottom: 1.2rem;
    max-width: 52rem;
  }
  .how li {
    margin: 0.3rem 0;
  }
  .report {
    max-width: 52rem;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.8rem;
  }
  .cat {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    padding: 0.45rem 0;
    cursor: pointer;
  }
  .cat > span {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .cat .badge {
    margin-left: 0.4rem;
  }
  .cat.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .field input {
    width: 100%;
    box-sizing: border-box;
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
