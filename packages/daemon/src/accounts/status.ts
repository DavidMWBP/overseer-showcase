import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether an account can run a harness on its own credentials, rather than silently falling back to the machine login.
 *
 * A codex_home account keeps its credentials in `<home>/auth.json`, which `codex login` writes; `last_login_at` is stamped only
 * by the login route of this daemon, so a home logged in by hand — the only route before that route existed — has none. Checking
 * the file as well keeps such an account working instead of rejecting every dispatch on it.
 */
export function accountLoggedIn(account: { kind: string; secret: string | null; home?: string | null; last_login_at?: string | null }): boolean {
  if (account.kind !== 'codex_home') return !!account.secret;
  if (account.last_login_at) return true;
  return !!account.home && fs.existsSync(path.join(account.home, 'auth.json'));
}

/**
 * The `exhausted_until` value that parks an account whose stored grant a session's rejected login could not be recovered (its
 * refresh was rejected, or the resumed session was rejected again): far in the future, because unlike a usage-limit reset the
 * account does not come back on its own. It is lifted only by a successful login or verify of
 * that account (`clearAuthHold`), and it is kept distinct from a usage-limit reset time so a verify during a usage hold does
 * not clear that hold.
 */
export const AUTH_HOLD_UNTIL = Date.parse('9999-12-31T00:00:00.000Z');

/** The accounts patch that lifts an authentication hold; a usage-limit reset time is left in place. */
export function clearAuthHold(account: { exhausted_until?: number | null }): { exhausted_until?: null } {
  return account.exhausted_until === AUTH_HOLD_UNTIL ? { exhausted_until: null } : {};
}
