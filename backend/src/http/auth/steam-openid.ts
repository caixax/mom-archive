// Steam sign in. Steam speaks OpenID 2.0, so the only thing that proves an
// identity is asking Steam to check the signature it just produced: nothing in
// the callback query string is trusted before that round trip succeeds.
import { errMsg, type Logger } from '../../logger.js';

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;

/** The URL to send the browser to. `returnTo` must be the exact callback URL, state included. */
export function buildLoginUrl(realm: string, returnTo: string): string {
  const url = new URL(STEAM_OPENID_ENDPOINT);
  url.searchParams.set('openid.ns', NS);
  url.searchParams.set('openid.mode', 'checkid_setup');
  url.searchParams.set('openid.return_to', returnTo);
  url.searchParams.set('openid.realm', realm);
  url.searchParams.set('openid.identity', IDENTIFIER_SELECT);
  url.searchParams.set('openid.claimed_id', IDENTIFIER_SELECT);
  return url.toString();
}

export type VerifyResult =
  | { ok: true; steamId: string }
  | { ok: false; reason: string; retryable?: boolean };

export interface VerifyOptions {
  /** The callback URL this server expects, including the state it generated. */
  expectedReturnTo: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Validates a Steam OpenID callback.
 *
 * Checks, in order: the response is an id_res from Steam's own endpoint, it was
 * issued for this exact return_to, the claimed identifier is a SteamID64 URL, and
 * Steam itself confirms the signature through check_authentication.
 */
export async function verifyCallback(
  params: Record<string, string | undefined>,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const get = (k: string): string => params[k] ?? '';
  if (get('openid.mode') !== 'id_res') return { ok: false, reason: 'not an id_res response' };
  if (get('openid.ns') !== NS) return { ok: false, reason: 'wrong openid namespace' };
  if (get('openid.op_endpoint') !== STEAM_OPENID_ENDPOINT) {
    return { ok: false, reason: 'response did not come from steam' };
  }
  // Steam signs return_to, so comparing it to what we generated ties the response
  // to this login attempt and to this server.
  if (get('openid.return_to') !== opts.expectedReturnTo) {
    return { ok: false, reason: 'return_to does not match this login attempt' };
  }
  const claimed = CLAIMED_ID.exec(get('openid.claimed_id'));
  if (!claimed) return { ok: false, reason: 'claimed identifier is not a steamid' };
  if (get('openid.identity') !== get('openid.claimed_id')) {
    return { ok: false, reason: 'identity and claimed_id disagree' };
  }
  if (!get('openid.sig') || !get('openid.signed')) {
    return { ok: false, reason: 'response is not signed' };
  }

  // Echo every openid.* parameter back with mode=check_authentication. Only the
  // fields Steam signed matter, but sending the lot is what the spec asks for.
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (!k.startsWith('openid.')) continue;
    body.set(k, v);
  }
  body.set('openid.mode', 'check_authentication');

  const fetchImpl = opts.fetchImpl ?? fetch;
  let text: string;
  try {
    const res = await fetchImpl(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, reason: `steam answered HTTP ${res.status}`, retryable: true };
    }
    text = await res.text();
  } catch (e) {
    opts.logger.warn('steam openid verification failed', { error: errMsg(e) });
    return { ok: false, reason: 'steam could not be reached', retryable: true };
  }

  const valid = /(^|\n)is_valid\s*:\s*true\s*(\n|$)/.test(text);
  if (!valid) return { ok: false, reason: 'steam rejected the signature' };
  return { ok: true, steamId: claimed[1]! };
}
