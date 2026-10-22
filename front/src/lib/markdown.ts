// Markdown for the Ledger and for reports. marked only tokenizes here; the tokens
// are rendered by Svelte components (components/md), so text is always text and
// no string ever reaches the page as HTML. Raw HTML in the source shows up as the
// literal characters the author typed.
import { Marked, type Token, type Tokens, type TokenizerAndRendererExtension } from 'marked';

export type { Token, Tokens };

export type RefKind = 'user' | 'map' | 'run' | 'replay';

export interface RefToken {
  type: 'ref';
  raw: string;
  kind: RefKind;
  id: string;
}

const REF = /^\[\[(user|map|run|replay):([A-Za-z0-9_.-]{1,80})\]\]/;

const refExtension: TokenizerAndRendererExtension = {
  name: 'ref',
  level: 'inline',
  start(src: string) {
    const i = src.indexOf('[[');
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = REF.exec(src);
    if (!m) return undefined;
    return { type: 'ref', raw: m[0], kind: m[1] as RefKind, id: m[2]! };
  },
  // Never called: nothing here renders to HTML.
  renderer: () => '',
};

const parser = new Marked({ gfm: true, breaks: false });
parser.use({ extensions: [refExtension] });

export function parseMarkdown(src: string): Token[] {
  return parser.lexer(src);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** marked hands some text over entity escaped; the page shows it as typed. */
export function plain(t: { text: string; escaped?: boolean }): string {
  return t.escaped ? t.text.replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e) : t.text;
}

/** Links go out only to http(s), mail, or this site. Anything else renders as text. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (/^https?:\/\/[^\s]+$/i.test(h)) return h;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(h)) return h;
  if (/^\/(?!\/)[^\s]*$/.test(h)) return h;
  if (/^#[\w-]*$/.test(h)) return h;
  return null;
}

export function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** Images only from this site's own archive or the Momentum CDN the CSP already allows. */
export function safeImage(src: string | null | undefined): string | null {
  if (!src) return null;
  const s = src.trim();
  if (/^\/api\/(maps\/images|avatars)\/[\w.-]+$/.test(s)) return s;
  if (/^https:\/\/cdn\.momentum-mod\.org\/[\w./-]+$/.test(s)) return s;
  return null;
}

export interface RefIds {
  users: Set<string>;
  maps: Set<string>;
  runs: Set<string>;
  replays: Set<string>;
}

/** Every reference in a token tree, so they can be resolved in one request. */
export function collectRefs(tokens: Token[], into?: RefIds): RefIds {
  const ids: RefIds = into ?? {
    users: new Set(),
    maps: new Set(),
    runs: new Set(),
    replays: new Set(),
  };
  const walk = (list: unknown[] | undefined) => {
    for (const raw of list ?? []) {
      const t = raw as Record<string, unknown>;
      if (t.type === 'ref') {
        const r = t as unknown as RefToken;
        if (r.kind === 'user' && /^\d+$/.test(r.id)) ids.users.add(r.id);
        else if (r.kind === 'run' && /^\d+$/.test(r.id)) ids.runs.add(r.id);
        else if (r.kind === 'replay' && /^[0-9a-f]{40}$/.test(r.id)) ids.replays.add(r.id);
        else if (r.kind === 'map') ids.maps.add(r.id);
      }
      walk(t.tokens as unknown[] | undefined);
      walk(t.items as unknown[] | undefined);
      if (t.type === 'table') {
        for (const c of (t.header as { tokens: unknown[] }[]) ?? []) walk(c.tokens);
        for (const row of (t.rows as { tokens: unknown[] }[][]) ?? [])
          for (const c of row) walk(c.tokens);
      }
    }
  };
  walk(tokens);
  return ids;
}

export interface ResolvedRefs {
  users: Record<
    string,
    {
      id: number;
      alias: string | null;
      avatarHash: string | null;
      banNames: string[];
      isDeleted: boolean;
    }
  >;
  maps: Record<string, { id: number; name: string }>;
  runs: Record<
    string,
    {
      id: number;
      userId: number;
      alias: string | null;
      mapId: number;
      mapName: string | null;
      time: number;
      rank: number | null;
      removedAt: string | null;
      removalKind: string | null;
      replayHash: string | null;
      replayArchived: boolean;
    }
  >;
  replays: Record<
    string,
    {
      sha1: string;
      time: number | null;
      alias: string | null;
      userId: number | null;
      mapName: string | null;
    }
  >;
}

export function refQuery(ids: RefIds): Record<string, string> | null {
  const q: Record<string, string> = {};
  const take = (s: Set<string>) => [...s].slice(0, 200).join(',');
  if (ids.users.size) q.users = take(ids.users);
  if (ids.runs.size) q.runs = take(ids.runs);
  if (ids.replays.size) q.replays = take(ids.replays);
  if (ids.maps.size) q.maps = take(ids.maps);
  return Object.keys(q).length ? q : null;
}

/** Wraps the selection in a textarea with Markdown markers; used by the editors. */
export function wrapSelection(
  el: HTMLTextAreaElement,
  before: string,
  after = before,
  placeholder = '',
): string {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const inner = value.slice(a, b) || placeholder;
  const next = value.slice(0, a) + before + inner + after + value.slice(b);
  queueMicrotask(() => {
    el.focus();
    el.setSelectionRange(a + before.length, a + before.length + inner.length);
  });
  return next;
}

/** Prefixes every selected line, for lists, quotes and headings. */
export function prefixLines(el: HTMLTextAreaElement, prefix: string): string {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const start = value.lastIndexOf('\n', a - 1) + 1;
  const end = value.indexOf('\n', b);
  const stop = end < 0 ? value.length : end;
  const block = value
    .slice(start, stop)
    .split('\n')
    .map((l, i) => (prefix === '1. ' ? `${i + 1}. ` : prefix) + l)
    .join('\n');
  queueMicrotask(() => el.focus());
  return value.slice(0, start) + block + value.slice(stop);
}
