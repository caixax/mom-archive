<script lang="ts">
  import type { Component } from 'svelte';
  import { installRouter, match, navigate, route } from './lib/router.svelte';
  import Home from './pages/Home.svelte';
  import Maps from './pages/Maps.svelte';
  import MapPage from './pages/Map.svelte';
  import Users from './pages/Users.svelte';
  import User from './pages/User.svelte';
  import Run from './pages/Run.svelte';
  import Deleted from './pages/Deleted.svelte';
  import Api from './pages/Api.svelte';
  import About from './pages/About.svelte';
  import Status from './pages/Status.svelte';
  import Search from './pages/Search.svelte';
  import NotFound from './pages/NotFound.svelte';

  installRouter();

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
    ['/status', 'Status'],
    ['/docs', 'API'],
    ['/about', 'About'],
  ] as const;

  function isActive(href: string): boolean {
    if (href === '/') return route.path === '/';
    return route.path === href || route.path.startsWith(href + '/');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Page = { c: Component<any>; params: Record<string, string> };
  const page = $derived.by((): Page => {
    const p = route.path;
    let m: Record<string, string> | null;
    if (p === '/' || p === '') return { c: Home, params: {} };
    if (p === '/maps') return { c: Maps, params: {} };
    if ((m = match('/maps/:idOrName', p))) return { c: MapPage, params: m };
    if (p === '/users') return { c: Users, params: {} };
    if ((m = match('/users/:id', p))) return { c: User, params: m };
    if ((m = match('/runs/:id', p))) return { c: Run, params: m };
    if (p === '/deleted') return { c: Deleted, params: {} };
    if (p === '/docs') return { c: Api, params: {} };
    if (p === '/about') return { c: About, params: {} };
    if (p === '/status') return { c: Status, params: {} };
    if (p === '/search') return { c: Search, params: {} };
    return { c: NotFound, params: {} };
  });
</script>

<header class="top">
  <a class="brand" href="/">mom-archive</a>
  <nav>
    {#each links as [href, label] (href)}
      <a {href} class:active={isActive(href)}>{label}</a>
    {/each}
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
  {#key route.path}
    <page.c {...page.params} />
  {/key}
</main>

<footer>
  mom-archive is an independent, read only mirror of public Momentum Mod data. Not affiliated with
  Momentum Mod.
  <a href="/api/openapi.json" rel="external">JSON API</a>
</footer>
