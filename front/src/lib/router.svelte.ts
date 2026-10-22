// Tiny History API router. Routes are matched in App.svelte against `route.path`.
// The URL objects below are local scratch values, not reactive state.
/* eslint-disable svelte/prefer-svelte-reactivity */

export interface RouteState {
  path: string;
  query: URLSearchParams;
}

function read(): RouteState {
  return { path: window.location.pathname, query: new URLSearchParams(window.location.search) };
}

export const route = $state<RouteState>(read());

function update(): void {
  const r = read();
  const moved = r.path !== route.path;
  route.path = r.path;
  route.query = r.query;
  if (moved) pageview(r.path);
}

let firstView = true;

/**
 * Tells the server a page was opened, so the owner's numbers count pages rather
 * than API calls. No cookie, no id: just the path, and on the first page of a
 * visit the site that linked here. Skipped for the panel and for browsers that
 * ask not to be tracked.
 */
function pageview(path: string): void {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.doNotTrack === '1' || nav.globalPrivacyControl === true) return;
  if (path === '/admin' || path.startsWith('/admin/')) return;
  let url = `/api/pv${path === '/' ? '' : path}`;
  if (firstView && document.referrer) {
    try {
      if (new URL(document.referrer).origin !== window.location.origin)
        url += `?r=${encodeURIComponent(document.referrer.slice(0, 280))}`;
    } catch {
      // not a URL, nothing to report
    }
  }
  firstView = false;
  void fetch(url, { keepalive: true, credentials: 'omit' }).catch(() => undefined);
}

export function navigate(href: string, replace = false): void {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin) {
    window.location.href = href;
    return;
  }
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  update();
  window.scrollTo(0, 0);
}

export function setQuery(
  params: Record<string, string | number | null | undefined>,
  replace = true,
): void {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  update();
}

let installed = false;
export function installRouter(): void {
  if (installed) return;
  installed = true;
  pageview(route.path);
  window.addEventListener('popstate', update);
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as HTMLElement | null)?.closest('a');
    if (
      !a ||
      !a.href ||
      a.target === '_blank' ||
      a.hasAttribute('download') ||
      a.getAttribute('rel')?.includes('external')
    )
      return;
    const url = new URL(a.href);
    if (url.origin !== window.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
}

/** Match "/maps/:id" style patterns. Returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = s[i]!;
    if (a.startsWith(':')) params[a.slice(1)] = decodeURIComponent(b);
    else if (a !== b) return null;
  }
  return params;
}
