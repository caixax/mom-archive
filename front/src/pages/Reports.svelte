<script lang="ts">
  // A player's own reports.
  import { api } from '../lib/api';
  import { formatDate, relTime } from '../lib/format';
  import { CATEGORY_INFO, loadMember, loginHref, member } from '../lib/member.svelte';

  interface Row {
    publicId: string;
    category: string;
    title: string;
    status: string;
    identified: boolean;
    createdAt: string;
    lastMessageAt: string;
    unread: boolean;
  }
  let rows = $state<Row[] | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void loadMember(true).then(() => {
      if (!member.authenticated) return;
      api<{ data: Row[] }>('/api/member/reports')
        .then((r) => (rows = r.data))
        .catch((e) => (error = String(e.message)));
    });
  });
</script>

<h1>Your reports</h1>

{#if !member.loaded}
  <p class="muted">Checking.</p>
{:else if !member.authenticated}
  <p>Sign in to see the reports you sent.</p>
  <p>
    <a href={loginHref('/reports')} rel="external"
      ><button class="primary">Sign in through Steam</button></a
    >
  </p>
{:else}
  <p><a href="/report"><button class="primary">New report</button></a></p>
  {#if error}<p class="error">{error}</p>{/if}
  {#if rows}
    <div class="table-wrap">
      <table>
        <thead
          ><tr><th>Report</th><th>Kind</th><th>State</th><th>Sent</th><th>Last message</th></tr
          ></thead
        >
        <tbody>
          {#each rows as r (r.publicId)}
            <tr>
              <td
                ><a href={`/reports/${r.publicId}`}>{r.title}</a>{#if r.unread}<span
                    class="badge accent">new reply</span
                  >{/if}</td
              >
              <td class="small"
                >{CATEGORY_INFO[r.category]?.label ?? r.category}{#if r.identified}<span
                    class="badge warn">signed</span
                  >{/if}</td
              >
              <td><span class="badge {r.status === 'answered' ? 'ok' : ''}">{r.status}</span></td>
              <td class="mono small">{formatDate(r.createdAt, false)}</td>
              <td class="mono small">{relTime(r.lastMessageAt)}</td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">No reports yet.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}
