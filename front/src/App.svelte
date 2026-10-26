<script lang="ts">
  import type { Component } from 'svelte';
  import { installRouter, match, navigate, route } from './lib/router.svelte';
  import Home from './pages/Home.svelte';
  import Maps from './pages/Maps.svelte';
  import MapPage from './pages/Map.svelte';
  import Users from './pages/Users.svelte';
  import User from './pages/User.svelte';
  import Run from './pages/Run.svelte';
  import Watch from './pages/Watch.svelte';
  import Deleted from './pages/Deleted.svelte';
  import Api from './pages/Api.svelte';
  import About from './pages/About.svelte';
  import Status from './pages/Status.svelte';
  import Search from './pages/Search.svelte';
  import Ledger from './pages/Ledger.svelte';
  import LedgerPost from './pages/LedgerPost.svelte';
  import NotFound from './pages/NotFound.svelte';
  import Banners from './components/Banners.svelte';
  import Dialogs from './components/Dialogs.svelte';
  import { loadMember, member } from './lib/member.svelte';

  installRouter();
  void loadMember();

  let q = $state('');

  function submit(e: Event) {
    e.preventDefault();
    const term = q.trim();
    if (term.length === 0) return;
    navigate(`/search?q=${encodeURIComponent(term)}`);
  }

  const links = [
    ['/', 'Home'],
    ['/maps', 'Maps'],
    ['/users', 'Users'],
    ['/deleted', 'Deleted runs'],
    ['/ledger', 'Ledger'],
    ['/status', 'Status'],
    ['/docs', 'API'],
    ['/about', 'About'],
  ] as const;

  function isActive(href: string): boolean {
    if (href === '/') return route.path === '/';
    return route.path === href || route.path.startsWith(href + '/');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyComponent = Component<any>;
  type Page = {
    c: AnyComponent | null;
    lazy?: () => Promise<AnyComponent>;
    params: Record<string, string>;
  };

  // The report pages carry the Markdown renderer; readers who never report never load them.
  const lazyPages: Record<string, Promise<AnyComponent>> = {};
  function lazy(name: string, load: () => Promise<{ default: AnyComponent }>) {
    return () => (lazyPages[name] ??= load().then((m) => m.default));
  }
  const ReportPage = lazy('report', () => import('./pages/Report.svelte'));
  const ReportsPage = lazy('reports', () => import('./pages/Reports.svelte'));
  const ThreadPage = lazy('thread', () => import('./pages/ReportThread.svelte'));

  let adminPromise: Promise<AnyComponent> | null = null;
  function loadAdmin() {
    adminPromise ??= import('./pages/Admin.svelte').then((m) => m.default);
    return adminPromise;
  }
  const page = $derived.by((): Page => {
    const p = route.path;
    let m: Record<string, string> | null;
    if (p === '/' || p === '') return { c: Home, params: {} };
    if (p === '/maps') return { c: Maps, params: {} };
    if ((m = match('/maps/:idOrName', p))) return { c: MapPage, params: m };
    if (p === '/users') return { c: Users, params: {} };
    if ((m = match('/users/:id', p))) return { c: User, params: m };
    if ((m = match('/runs/:id', p))) return { c: Run, params: m };
    if ((m = match('/watch/:sha1', p))) return { c: Watch, params: m };
    if (p === '/deleted') return { c: Deleted, params: {} };
    if (p === '/docs') return { c: Api, params: {} };
    if (p === '/about') return { c: About, params: {} };
    if (p === '/status') return { c: Status, params: {} };
    if (p === '/search') return { c: Search, params: {} };
    if (p === '/ledger') return { c: Ledger, params: {} };
    if (p === '/report') return { c: null, lazy: ReportPage, params: {} };
    if (p === '/reports') return { c: null, lazy: ReportsPage, params: {} };
    if ((m = match('/reports/:id', p))) return { c: null, lazy: ThreadPage, params: m };
    if ((m = match('/ledger/:slug', p))) return { c: LedgerPost, params: m };
    return { c: NotFound, params: {} };
  });
</script>

<header class="top">
  <a class="brand" href="/">mom-archive</a>
  <nav>
    {#each links as [href, label] (href)}
      <a {href} class:active={isActive(href)}>{label}</a>
    {/each}
    {#if member.authenticated}
      <a href="/reports" class:active={isActive('/reports')}
        >Reports{#if member.unread}<span class="badge accent">{member.unread}</span>{/if}</a
      >
    {/if}
  </nav>
  <form onsubmit={submit} role="search">
    <input
      type="search"
      placeholder="player, old name, SteamID, map"
      bind:value={q}
      aria-label="Search"
      maxlength="100"
    />
    <button type="submit">Search</button>
  </form>
</header>

<main>
  {#if route.path === '/admin'}
    <!-- The owner's panel: not in the nav, not in the public bundle either. -->
    {#await loadAdmin()}
      <p class="muted">Loading.</p>
    {:then Admin}
      <Admin />
    {:catch}
      <p class="error">The admin panel could not be loaded.</p>
    {/await}
  {:else}
    <Banners home={route.path === '/'} />
    {#key route.path}
      {#if page.c}
        <page.c {...page.params} />
      {:else if page.lazy}
        {#await page.lazy()}
          <p class="muted">Loading.</p>
        {:then Lazy}
          <Lazy {...page.params} />
        {:catch}
          <p class="error">This page could not be loaded.</p>
        {/await}
      {/if}
    {/key}
  {/if}
</main>

<Dialogs />

<footer>
  mom-archive is an independent, read only mirror of public Momentum Mod data. Not affiliated with
  Momentum Mod.
  <a href="/api/openapi.json" rel="external">JSON API</a>
  <a href="/report" class="footer-link">Report something</a>
</footer>
