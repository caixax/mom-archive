<script lang="ts">
  // The owner's panel. Not linked from anywhere: it is reached by typing /admin.
  // Everything here is behind a Steam session for a SteamID the server has in
  // ADMIN_STEAM_IDS, and every write carries the session's CSRF token.
  import { api } from '../lib/api';
  import { formatBytes, formatDate, formatInt, relTime } from '../lib/format';
  import { loadSession, send, session, WriteError } from '../lib/session.svelte';
  import { route } from '../lib/router.svelte';

  type Tab = 'overview' | 'traffic' | 'announcements' | 'notices' | 'audit' | 'sessions';
  let tab = $state<Tab>('overview');
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let busy = $state(false);

  const loginError = $derived(route.query.get('error'));

  $effect(() => {
    void loadSession();
  });

  function fail(e: unknown) {
    error = e instanceof WriteError || e instanceof Error ? e.message : String(e);
    note = null;
  }
  function done(msg: string) {
    note = msg;
    error = null;
  }

  // Overview

  interface Stats {
    counts: Record<string, number>;
    jobs: {
      job: string;
      startedAt: string;
      finishedAt: string | null;
      ok: boolean | null;
      itemsSeen: number;
      itemsNew: number;
      apiCalls: number;
      error: string | null;
    }[];
    failures: { job: string; failures: number; lastFailure: string }[];
    runsPerDay: { day: string; runs: number }[];
    storage: { total?: number; bytes?: number; updatedAt?: string } | null;
    cursors: { job: string; cursor: Record<string, unknown>; updatedAt: string }[];
  }
  let stats = $state<Stats | null>(null);

  async function loadStats() {
    try {
      stats = await api<Stats>('/api/admin/stats');
    } catch (e) {
      fail(e);
    }
  }

  // Traffic

  interface Summary {
    hours: number;
    totals: Record<string, number>;
    series: { hour: string; requests: number; ips: number; errors: number }[];
    statuses: { status: number; n: number }[];
    log: { oldest: string | null; rows: number; retentionDays: number; enabled: boolean };
  }
  interface TopRow {
    key: string;
    requests: number;
    lastSeen: string;
    routes: number;
    avgMs: number;
    errors: number;
    countries: string[];
    agent: string | null;
  }
  interface LogRow {
    at: string;
    ip: string | null;
    country: string | null;
    method: string;
    path: string;
    route: string;
    query: string | null;
    status: number;
    ms: number;
    bytes: number | null;
    userAgent: string | null;
    referer: string | null;
    admin: boolean;
  }
  let hours = $state(24);
  let summary = $state<Summary | null>(null);
  let topBy = $state<'ip' | 'route' | 'agent' | 'country'>('ip');
  let top = $state<TopRow[]>([]);
  let tail = $state<LogRow[]>([]);
  let filterIp = $state('');
  let filterRoute = $state('');
  let filterStatus = $state('');
  let filterAgent = $state('');

  async function loadTraffic() {
    try {
      const [s, t] = await Promise.all([
        api<Summary>('/api/admin/requests/summary', { hours }),
        api<{ data: TopRow[] }>('/api/admin/requests/top', { hours, by: topBy, limit: 25 }),
      ]);
      summary = s;
      top = t.data;
      await loadTail();
    } catch (e) {
      fail(e);
    }
  }

  async function loadTail() {
    try {
      const r = await api<{ data: LogRow[] }>('/api/admin/requests', {
        hours,
        ip: filterIp.trim() || undefined,
        route: filterRoute.trim() || undefined,
        status: filterStatus.trim() || undefined,
        agent: filterAgent.trim() || undefined,
        limit: 200,
      });
      tail = r.data;
    } catch (e) {
      fail(e);
    }
  }

  const peak = $derived(Math.max(1, ...(summary?.series ?? []).map((s) => s.requests)));

  // Announcements

  interface Announcement {
    id: number;
    body: string;
    level: string;
    scope: string;
    startsAt: string | null;
    endsAt: string | null;
    active: boolean;
    createdAt: string;
  }
  let announcements = $state<Announcement[]>([]);
  let newBody = $state('');
  let newLevel = $state('info');
  let newScope = $state('home');
  let newStarts = $state('');
  let newEnds = $state('');

  async function loadAnnouncements() {
    try {
      announcements = (await api<{ data: Announcement[] }>('/api/admin/announcements')).data;
    } catch (e) {
      fail(e);
    }
  }

  async function createAnnouncement(e: Event) {
    e.preventDefault();
    if (!newBody.trim()) return;
    busy = true;
    try {
      await send('POST', '/api/admin/announcements', {
        body: newBody,
        level: newLevel,
        scope: newScope,
        startsAt: newStarts ? new Date(newStarts).toISOString() : null,
        endsAt: newEnds ? new Date(newEnds).toISOString() : null,
      });
      newBody = '';
      newStarts = '';
      newEnds = '';
      done('Announcement published.');
      await loadAnnouncements();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  async function toggleAnnouncement(a: Announcement) {
    busy = true;
    try {
      await send('PATCH', `/api/admin/announcements/${a.id}`, { active: !a.active });
      await loadAnnouncements();
      done(a.active ? 'Hidden.' : 'Shown.');
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function deleteAnnouncement(a: Announcement) {
    if (!confirm('Delete this announcement?')) return;
    busy = true;
    try {
      await send('DELETE', `/api/admin/announcements/${a.id}`);
      await loadAnnouncements();
      done('Deleted.');
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  // Profile notices

  interface Notice {
    id: number;
    userId: number;
    alias: string | null;
    body: string;
    level: string;
    active: boolean;
    createdAt: string;
  }
  let notices = $state<Notice[]>([]);
  let noticeUserId = $state('');
  let noticeBody = $state('');
  let noticeLevel = $state('info');

  async function loadNotices() {
    try {
      notices = (await api<{ data: Notice[] }>('/api/admin/notices')).data;
    } catch (e) {
      fail(e);
    }
  }

  async function createNotice(e: Event) {
    e.preventDefault();
    const id = Number(noticeUserId);
    if (!Number.isInteger(id) || id < 1 || !noticeBody.trim()) {
      fail(new Error('A Momentum user id and a body are needed.'));
      return;
    }
    busy = true;
    try {
      await send('POST', '/api/admin/notices', {
        userId: id,
        body: noticeBody,
        level: noticeLevel,
      });
      noticeBody = '';
      done('Notice pinned to the profile.');
      await loadNotices();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  async function toggleNotice(n: Notice) {
    busy = true;
    try {
      await send('PATCH', `/api/admin/notices/${n.id}`, { active: !n.active });
      await loadNotices();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function deleteNotice(n: Notice) {
    if (!confirm('Delete this notice?')) return;
    busy = true;
    try {
      await send('DELETE', `/api/admin/notices/${n.id}`);
      await loadNotices();
      done('Deleted.');
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  // Audit and sessions

  interface AuditRow {
    at: string;
    steamId: string;
    action: string;
    target: string | null;
    details: Record<string, unknown> | null;
    ip: string | null;
    userAgent: string | null;
  }
  let audit = $state<AuditRow[]>([]);
  interface SessionRow {
    id: string;
    steamId: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    revokedAt: string | null;
    ip: string | null;
    userAgent: string | null;
    current: boolean;
  }
  let sessions = $state<SessionRow[]>([]);

  async function loadAudit() {
    try {
      audit = (await api<{ data: AuditRow[] }>('/api/admin/audit', { limit: 200 })).data;
    } catch (e) {
      fail(e);
    }
  }
  async function loadSessions() {
    try {
      sessions = (await api<{ data: SessionRow[] }>('/api/admin/sessions')).data;
    } catch (e) {
      fail(e);
    }
  }
  async function revokeSessionRow(s: SessionRow) {
    busy = true;
    try {
      await send('DELETE', `/api/admin/sessions/${s.id}`);
      await loadSessions();
      done('Session revoked.');
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }
  async function revokeOthers() {
    busy = true;
    try {
      const r = await send<{ revoked: number }>('POST', '/api/admin/sessions/revoke-others');
      await loadSessions();
      done(`${r.revoked} other session(s) revoked.`);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function logout() {
    try {
      await send('POST', '/api/auth/logout');
    } catch {
      // the cookie is gone either way
    }
    window.location.href = '/';
  }

  // Load whatever the visible tab needs.
  $effect(() => {
    if (!session.authenticated) return;
    const t = tab;
    if (t === 'overview') void loadStats();
    else if (t === 'traffic') void loadTraffic();
    else if (t === 'announcements') void loadAnnouncements();
    else if (t === 'notices') void loadNotices();
    else if (t === 'audit') void loadAudit();
    else if (t === 'sessions') void loadSessions();
  });

  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['traffic', 'Traffic'],
    ['announcements', 'Announcements'],
    ['notices', 'Profile notices'],
    ['audit', 'Audit'],
    ['sessions', 'Sessions'],
  ];
</script>

<h1>Admin</h1>

{#if !session.loaded}
  <p class="muted">Checking the session.</p>
{:else if !session.authenticated}
  <p>
    This panel belongs to the archive owner. Sign in with the Steam account listed on the server.
  </p>
  {#if loginError}<p class="error">Sign in failed: {loginError}</p>{/if}
  <p>
    <a href="/api/auth/steam/login" rel="external"
      ><button class="primary">Sign in through Steam</button></a
    >
  </p>
  <p class="muted small">
    Steam is the only thing asked, and only to prove which account you are. No account is created
    for anyone else, and nothing about visitors is stored by signing in.
  </p>
{:else}
  <p class="muted small">
    Signed in as <span class="mono">{session.steamId}</span>, session until {formatDate(
      session.expiresAt,
    )}.
    <button class="link" onclick={logout}>Sign out</button>
  </p>

  <nav class="tabs">
    {#each tabs as [id, label] (id)}
      <button class:active={tab === id} onclick={() => ((tab = id), (error = null), (note = null))}
        >{label}</button
      >
    {/each}
  </nav>

  {#if error}<p class="error">{error}</p>{/if}
  {#if note}<p class="notice">{note}</p>{/if}

  {#if tab === 'overview'}
    {#if stats}
      <h2>Archive</h2>
      <div class="table-wrap">
        <table>
          <tbody>
            {#each Object.entries(stats.counts) as [k, v] (k)}
              <tr><td>{k.replace(/_/g, ' ')}</td><td class="num">{formatInt(v)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if stats.storage}
        <p class="muted small">
          Storage: {formatInt(stats.storage.total)} objects, {formatBytes(stats.storage.bytes)},
          counted {formatDate(stats.storage.updatedAt)}.
        </p>
      {/if}

      <h2>Jobs</h2>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>Job</th><th>Last run</th><th>Result</th><th class="num">Seen</th><th class="num"
                >New</th
              ><th class="num">API calls</th></tr
            ></thead
          >
          <tbody>
            {#each stats.jobs as j (j.job)}
              <tr>
                <td>{j.job}</td>
                <td class="mono small" title={formatDate(j.startedAt)}>{relTime(j.startedAt)}</td>
                <td class="small"
                  >{#if j.ok}<span class="badge ok">ok</span>{:else if j.ok === false}<span
                      class="badge err"
                      title={j.error ?? ''}>failed</span
                    >{:else}<span class="badge">running</span>{/if}</td
                >
                <td class="num">{formatInt(j.itemsSeen)}</td>
                <td class="num">{formatInt(j.itemsNew)}</td>
                <td class="num">{formatInt(j.apiCalls)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if stats.failures.length}
        <h3>Failures in the last 7 days</h3>
        <ul class="plain small">
          {#each stats.failures as f (f.job)}
            <li>{f.job}: {f.failures}, last {relTime(f.lastFailure)}</li>
          {/each}
        </ul>
      {/if}

      <h2>Runs first seen per day</h2>
      <div class="table-wrap">
        <table>
          <tbody>
            {#each stats.runsPerDay as d (d.day)}
              <tr
                ><td class="mono small">{formatDate(d.day, false)}</td><td class="num"
                  >{formatInt(d.runs)}</td
                ><td class="bar"
                  ><span
                    style={`width:${Math.round((d.runs / Math.max(1, ...stats.runsPerDay.map((x) => x.runs))) * 100)}%`}
                  ></span></td
                ></tr
              >
            {/each}
          </tbody>
        </table>
      </div>

      <h2>Cursors</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Job</th><th>Updated</th><th>Cursor</th></tr></thead>
          <tbody>
            {#each stats.cursors as c (c.job)}
              <tr
                ><td>{c.job}</td><td class="mono small">{relTime(c.updatedAt)}</td><td
                  class="mono small">{JSON.stringify(c.cursor).slice(0, 160)}</td
                ></tr
              >
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted small"><a href="/status">Public status page</a></p>
    {:else}
      <p class="muted">Loading.</p>
    {/if}
  {/if}

  {#if tab === 'traffic'}
    <div class="filters">
      <label
        >window
        <select
          value={hours}
          onchange={(e) => ((hours = Number(e.currentTarget.value)), loadTraffic())}
        >
          <option value={1}>1 hour</option>
          <option value={24}>24 hours</option>
          <option value={168}>7 days</option>
          <option value={720}>30 days</option>
        </select>
      </label>
      <button onclick={loadTraffic} disabled={busy}>Refresh</button>
    </div>
    {#if summary}
      {#if !summary.log.enabled}
        <p class="notice">
          REQUEST_LOG_ENABLED is false on the server, so nothing new is being recorded.
        </p>
      {/if}
      <div class="cards">
        <div class="card">
          <h3>Requests</h3>
          <div class="big">{formatInt(summary.totals.requests)}</div>
          <span class="muted small">{formatInt(summary.totals.admin_requests)} to the panel</span>
        </div>
        <div class="card">
          <h3>Unique IPs</h3>
          <div class="big">{formatInt(summary.totals.unique_ips)}</div>
          <span class="muted small">{formatInt(summary.totals.unique_agents)} user agents</span>
        </div>
        <div class="card">
          <h3>Errors</h3>
          <div class="big">{formatInt(summary.totals.errors)}</div>
          <span class="muted small"
            >{formatInt(summary.totals.client_errors)} 4xx, {formatInt(summary.totals.rate_limited)} rate
            limited</span
          >
        </div>
        <div class="card">
          <h3>Latency</h3>
          <div class="big">{formatInt(summary.totals.avg_ms)} ms</div>
          <span class="muted small">worst {formatInt(summary.totals.max_ms)} ms</span>
        </div>
        <div class="card">
          <h3>Served</h3>
          <div class="big">{formatBytes(summary.totals.bytes)}</div>
          <span class="muted small"
            >log holds {formatInt(summary.log.rows)} rows, {summary.log.retentionDays} day retention</span
          >
        </div>
      </div>

      <h2>Per hour</h2>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>Hour</th><th class="num">Requests</th><th class="num">IPs</th><th class="num"
                >4xx/5xx</th
              ><th></th></tr
            ></thead
          >
          <tbody>
            {#each summary.series as s (s.hour)}
              <tr>
                <td class="mono small">{formatDate(s.hour)}</td>
                <td class="num">{formatInt(s.requests)}</td>
                <td class="num">{formatInt(s.ips)}</td>
                <td class="num">{formatInt(s.errors)}</td>
                <td class="bar"
                  ><span style={`width:${Math.round((s.requests / peak) * 100)}%`}></span></td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <h2>Status codes</h2>
      <p class="mono small">
        {#each summary.statuses as s (s.status)}{s.status}: {formatInt(s.n)}&nbsp;&nbsp;{/each}
      </p>

      <h2>Top</h2>
      <div class="filters">
        <label
          >by
          <select
            value={topBy}
            onchange={(e) => ((topBy = e.currentTarget.value as typeof topBy), loadTraffic())}
          >
            <option value="ip">IP</option>
            <option value="route">route</option>
            <option value="agent">user agent</option>
            <option value="country">country</option>
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>{topBy}</th><th class="num">Requests</th><th class="num">Routes</th><th
                class="num">Errors</th
              ><th class="num">Avg ms</th><th>Last seen</th><th>Seen as</th><th></th></tr
            ></thead
          >
          <tbody>
            {#each top as t (t.key)}
              <tr>
                <td class="mono small">{t.key}</td>
                <td class="num">{formatInt(t.requests)}</td>
                <td class="num">{formatInt(t.routes)}</td>
                <td class="num">{formatInt(t.errors)}</td>
                <td class="num">{formatInt(t.avgMs)}</td>
                <td class="mono small">{relTime(t.lastSeen)}</td>
                <td class="small muted"
                  >{#if topBy === 'ip'}{(t.countries ?? []).join(' ')}
                    {(t.agent ?? '').slice(0, 60)}{:else if topBy === 'agent'}{(
                      t.countries ?? []
                    ).join(' ')}{/if}</td
                >
                <td
                  >{#if topBy === 'ip'}<button
                      class="link"
                      onclick={() => ((filterIp = t.key), loadTail())}>filter</button
                    >{:else if topBy === 'route'}<button
                      class="link"
                      onclick={() => ((filterRoute = t.key), loadTail())}>filter</button
                    >{:else if topBy === 'agent'}<button
                      class="link"
                      onclick={() => ((filterAgent = t.key.slice(0, 60)), loadTail())}
                      >filter</button
                    >{/if}</td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <h2>Log</h2>
      <div class="filters">
        <input placeholder="ip" bind:value={filterIp} maxlength="64" />
        <input placeholder="route" bind:value={filterRoute} maxlength="200" />
        <input placeholder="status" bind:value={filterStatus} maxlength="3" class="narrow" />
        <input placeholder="user agent contains" bind:value={filterAgent} maxlength="200" />
        <button onclick={loadTail} disabled={busy}>Apply</button>
        <button
          class="link"
          onclick={() => (
            (filterIp = ''),
            (filterRoute = ''),
            (filterStatus = ''),
            (filterAgent = ''),
            loadTail()
          )}>clear</button
        >
      </div>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>When</th><th>IP</th><th></th><th>Method</th><th>Path</th><th class="num"
                >Status</th
              ><th class="num">ms</th><th class="num">Bytes</th><th>User agent</th></tr
            ></thead
          >
          <tbody>
            {#each tail as r (r.at + String(r.ip) + r.path + String(r.ms))}
              <tr>
                <td class="mono small">{formatDate(r.at)}</td>
                <td class="mono small">{r.ip ?? ''}</td>
                <td class="small">{r.country ?? ''}</td>
                <td class="small">{r.method}</td>
                <td class="mono small"
                  >{r.path}{#if r.query}<span class="muted">?{r.query.slice(0, 80)}</span>{/if}</td
                >
                <td class="num"
                  ><span class="badge {r.status >= 500 ? 'err' : r.status >= 400 ? 'warn' : 'ok'}"
                    >{r.status}</span
                  ></td
                >
                <td class="num">{r.ms}</td>
                <td class="num">{r.bytes === null ? '' : formatBytes(r.bytes)}</td>
                <td class="small muted" title={r.userAgent ?? ''}
                  >{(r.userAgent ?? '').slice(0, 50)}</td
                >
              </tr>
            {:else}
              <tr><td colspan="9" class="muted">Nothing in this window.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        IPs are kept for {summary.log.retentionDays} days and then deleted by the housekeeping job.
        {#if summary.log.oldest}Oldest row: {formatDate(summary.log.oldest)}.{/if}
      </p>
    {:else}
      <p class="muted">Loading.</p>
    {/if}
  {/if}

  {#if tab === 'announcements'}
    <form class="stack" onsubmit={createAnnouncement}>
      <textarea
        bind:value={newBody}
        placeholder="Text shown on the site. Plain text, no markup."
        maxlength="2000"
        rows="3"
      ></textarea>
      <div class="filters">
        <label
          >level
          <select bind:value={newLevel}
            ><option value="info">info</option><option value="warning">warning</option><option
              value="critical">critical</option
            ></select
          >
        </label>
        <label
          >where
          <select bind:value={newScope}
            ><option value="home">home only</option><option value="all">every page</option></select
          >
        </label>
        <label>from <input type="datetime-local" bind:value={newStarts} /></label>
        <label>until <input type="datetime-local" bind:value={newEnds} /></label>
        <button class="primary" type="submit" disabled={busy}>Publish</button>
      </div>
    </form>
    <div class="table-wrap">
      <table>
        <thead
          ><tr><th>Body</th><th>Level</th><th>Where</th><th>Window</th><th>State</th><th></th></tr
          ></thead
        >
        <tbody>
          {#each announcements as a (a.id)}
            <tr>
              <td>{a.body}</td>
              <td class="small">{a.level}</td>
              <td class="small">{a.scope}</td>
              <td class="mono small"
                >{a.startsAt ? formatDate(a.startsAt, false) : 'now'} to {a.endsAt
                  ? formatDate(a.endsAt, false)
                  : 'forever'}</td
              >
              <td
                >{#if a.active}<span class="badge ok">live</span>{:else}<span class="badge"
                    >hidden</span
                  >{/if}</td
              >
              <td>
                <button class="link" onclick={() => toggleAnnouncement(a)} disabled={busy}
                  >{a.active ? 'hide' : 'show'}</button
                >
                <button class="link" onclick={() => deleteAnnouncement(a)} disabled={busy}
                  >delete</button
                >
              </td>
            </tr>
          {:else}
            <tr><td colspan="6" class="muted">No announcements.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if tab === 'notices'}
    <form class="stack" onsubmit={createNotice}>
      <div class="filters">
        <input
          placeholder="momentum user id"
          bind:value={noticeUserId}
          maxlength="9"
          class="narrow"
        />
        <label
          >level
          <select bind:value={noticeLevel}
            ><option value="info">info</option><option value="warning">warning</option><option
              value="critical">critical</option
            ></select
          >
        </label>
      </div>
      <textarea
        bind:value={noticeBody}
        placeholder="Note shown on that player's page. Plain text."
        maxlength="2000"
        rows="3"
      ></textarea>
      <div><button class="primary" type="submit" disabled={busy}>Pin to profile</button></div>
    </form>
    <div class="table-wrap">
      <table>
        <thead
          ><tr><th>User</th><th>Body</th><th>Level</th><th>State</th><th>Added</th><th></th></tr
          ></thead
        >
        <tbody>
          {#each notices as n (n.id)}
            <tr>
              <td><a href={`/users/${n.userId}`}>{n.alias ?? `user ${n.userId}`}</a></td>
              <td>{n.body}</td>
              <td class="small">{n.level}</td>
              <td
                >{#if n.active}<span class="badge ok">live</span>{:else}<span class="badge"
                    >hidden</span
                  >{/if}</td
              >
              <td class="mono small">{formatDate(n.createdAt, false)}</td>
              <td>
                <button class="link" onclick={() => toggleNotice(n)} disabled={busy}
                  >{n.active ? 'hide' : 'show'}</button
                >
                <button class="link" onclick={() => deleteNotice(n)} disabled={busy}>delete</button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="6" class="muted">No notices.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if tab === 'audit'}
    <p class="muted small">Every action taken in this panel, newest first.</p>
    <div class="table-wrap">
      <table>
        <thead
          ><tr><th>When</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead
        >
        <tbody>
          {#each audit as a (a.at + a.action + String(a.target))}
            <tr>
              <td class="mono small">{formatDate(a.at)}</td>
              <td>{a.action}</td>
              <td class="mono small">{a.target ?? ''}</td>
              <td class="mono small">{a.details ? JSON.stringify(a.details).slice(0, 80) : ''}</td>
              <td class="mono small">{a.ip ?? ''}</td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">Nothing yet.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if tab === 'sessions'}
    <p>
      <button onclick={revokeOthers} disabled={busy}>Revoke every other session</button>
    </p>
    <div class="table-wrap">
      <table>
        <thead
          ><tr
            ><th>Started</th><th>Last seen</th><th>Expires</th><th>IP</th><th>User agent</th><th
              >State</th
            ><th></th></tr
          ></thead
        >
        <tbody>
          {#each sessions as s (s.id)}
            <tr>
              <td class="mono small">{formatDate(s.createdAt)}</td>
              <td class="mono small">{relTime(s.lastSeenAt)}</td>
              <td class="mono small">{formatDate(s.expiresAt, false)}</td>
              <td class="mono small">{s.ip ?? ''}</td>
              <td class="small muted" title={s.userAgent ?? ''}
                >{(s.userAgent ?? '').slice(0, 40)}</td
              >
              <td
                >{#if s.revokedAt}<span class="badge">revoked</span>{:else if s.current}<span
                    class="badge accent">this one</span
                  >{:else}<span class="badge ok">live</span>{/if}</td
              >
              <td
                >{#if !s.revokedAt && !s.current}<button
                    class="link"
                    onclick={() => revokeSessionRow(s)}
                    disabled={busy}>revoke</button
                  >{/if}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  nav.tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0.75rem 0;
    border-bottom: 1px solid var(--border);
  }
  nav.tabs button {
    background: none;
    border: 1px solid transparent;
    border-bottom: none;
    color: var(--muted);
    padding: 0.35rem 0.7rem;
    cursor: pointer;
  }
  nav.tabs button.active {
    color: var(--fg);
    border-color: var(--border);
    background: var(--bg-2);
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
  form.stack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.5rem 0 1rem;
  }
  textarea {
    width: 100%;
    font: inherit;
    background: var(--bg-2);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 0.4rem;
  }
  input.narrow {
    width: 8rem;
  }
  td.bar {
    width: 30%;
    min-width: 4rem;
  }
  td.bar span {
    display: block;
    height: 0.6rem;
    background: var(--accent);
    opacity: 0.6;
  }
  ul.plain {
    list-style: none;
    padding: 0;
  }
</style>
