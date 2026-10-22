// A player's own sign in, for reports. Separate from the owner's session in
// every way. The page only asks the server about it when this browser signed in
// before (a hint kept in localStorage), so readers who never sign in send nothing.
import { api } from './api';
import { WriteError } from './session.svelte';

export interface MemberState {
  loaded: boolean;
  enabled: boolean;
  authenticated: boolean;
  code: string | null;
  blocked: boolean;
  account: { userId: number | null; alias: string | null; mapsCompleted: number | null } | null;
  canReport: { anonymous: boolean; identified: boolean };
  reason: string | null;
  unread: number;
  minMaps: number;
  csrfToken: string | null;
}

export const member = $state<MemberState>({
  loaded: false,
  enabled: true,
  authenticated: false,
  code: null,
  blocked: false,
  account: null,
  canReport: { anonymous: false, identified: false },
  reason: null,
  unread: 0,
  minMaps: 10,
  csrfToken: null,
});

const HINT = 'ma-member';

function hint(): boolean {
  try {
    return window.localStorage.getItem(HINT) === '1';
  } catch {
    return false;
  }
}

function setHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(HINT, '1');
    else window.localStorage.removeItem(HINT);
  } catch {
    // storage blocked: the report pages still ask the server themselves
  }
}

/** Asks the server who is signed in. `force` is for the report pages themselves. */
export async function loadMember(force = false): Promise<void> {
  if (!force && !hint()) {
    member.loaded = true;
    return;
  }
  try {
    const r = await api<Partial<MemberState> & { authenticated: boolean; enabled: boolean }>(
      '/api/member/me',
    );
    member.enabled = r.enabled;
    member.authenticated = r.authenticated;
    member.code = r.code ?? null;
    member.blocked = r.blocked ?? false;
    member.account = r.account ?? null;
    member.canReport = r.canReport ?? { anonymous: false, identified: false };
    member.reason = r.reason ?? null;
    member.unread = r.unread ?? 0;
    member.minMaps = r.minMaps ?? 10;
    member.csrfToken = r.csrfToken ?? null;
    setHint(r.authenticated);
  } catch {
    member.authenticated = false;
  } finally {
    member.loaded = true;
  }
}

export function loginHref(next: string): string {
  return `/api/member/login?next=${encodeURIComponent(next)}`;
}

export async function memberSend<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (member.csrfToken) headers['x-csrf-token'] = member.csrfToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    if (res.status === 401) {
      member.authenticated = false;
      setHint(false);
    }
    const b = parsed as { message?: string; error?: string } | null;
    throw new WriteError(res.status, b?.message ?? b?.error ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

export async function memberLogout(): Promise<void> {
  try {
    await memberSend('/api/member/logout');
  } catch {
    // the cookie is cleared or already dead either way
  }
  member.authenticated = false;
  member.code = null;
  member.unread = 0;
  setHint(false);
}

export const CATEGORY_INFO: Record<string, { label: string; identified: boolean; help: string }> = {
  cheating: {
    label: 'Suspected cheating',
    identified: false,
    help: 'A run, a replay or a player that does not look legitimate. Say what you saw and where (times in the replay help).',
  },
  data_error: {
    label: 'Something in the archive is wrong',
    identified: false,
    help: 'A record that does not match what happened, a missing run, a wrong name.',
  },
  other: {
    label: 'Something else',
    identified: false,
    help: 'Anything the archive owner should know.',
  },
  about_me: {
    label: 'This is about me',
    identified: true,
    help: 'Your side of a case or a record about your account. This one is signed: the owner sees which account sent it.',
  },
  privacy: {
    label: 'Hide parts of my profile',
    identified: true,
    help: 'Ask for your bio, socials or avatars to stop being shown. This one is signed, because only you can ask it for your account. Runs, bans and cases are history of a public game and stay.',
  },
};
