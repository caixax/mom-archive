// The owner's session. Visitors never touch any of this: /api/auth/me answers
// { authenticated: false } for everyone without the cookie, and the admin page
// is the only thing that asks.
import { api } from './api';

export interface SessionState {
  loaded: boolean;
  authenticated: boolean;
  steamId: string | null;
  expiresAt: string | null;
  csrfToken: string | null;
}

export const session = $state<SessionState>({
  loaded: false,
  authenticated: false,
  steamId: null,
  expiresAt: null,
  csrfToken: null,
});

export async function loadSession(): Promise<void> {
  try {
    const r = await api<{
      authenticated: boolean;
      admin: boolean;
      steamId?: string;
      expiresAt?: string;
      csrfToken?: string;
    }>('/api/auth/me');
    session.authenticated = Boolean(r.authenticated && r.admin);
    session.steamId = r.steamId ?? null;
    session.expiresAt = r.expiresAt ?? null;
    session.csrfToken = r.csrfToken ?? null;
  } catch {
    session.authenticated = false;
    session.csrfToken = null;
  } finally {
    session.loaded = true;
  }
}

export class WriteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

/** Sends a state changing request with the CSRF token this session was given. */
export async function send<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
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
    const b = parsed as { message?: string; error?: string } | null;
    if (res.status === 401) {
      session.authenticated = false;
      session.csrfToken = null;
    }
    throw new WriteError(res.status, b?.message ?? b?.error ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}
