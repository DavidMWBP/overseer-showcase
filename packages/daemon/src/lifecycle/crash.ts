import type { CrashClass } from '@overseer/shared';

// `settleWorker` classifies against `stderrHead`'s output, which joins the CLI's stderr lines with "; " rather than "\n",
// so the line-start anchor accepts either separator (or the raw multi-line text used directly in this file's tests).
const USAGE = /(^|; |\n)\s*Usage: |For more information, try '--help'|\s\[OPTIONS\] <COMMAND>/;
// Claude Code's rejected-authorization message, e.g. "Failed to authenticate. API Error: 401 OAuth access token has been
// revoked."; a 401 alone or an OAuth word alone is something else, so both must be present, case-insensitively.
const AUTH_401 = /\b401\b/;
const AUTH_WORD = /oauth|authenticat/i;

/** Whether a session's error text reports a rejected authentication (the Claude OAuth 401); a 401 without an OAuth/authentication word is not one. */
export function isAuthFailure(text: string | null | undefined): boolean {
  return !!text && AUTH_401.test(text) && AUTH_WORD.test(text);
}

/**
 * Why a worker ended without commits, from its exit reason and the head of its stderr (evidence: ~/.overseer/sessions, 2026-09-16).
 * harness_bug: the CLI rejected its arguments (clap usage text), so any model fails the same way.
 * transient: the event stream broke; the same model usually succeeds on a second try.
 * auth: the session reported a rejected authentication; the account, if any, is parked for a re-login only when its refresh is
 *   also rejected (lifecycle.ts). `authFromText` is false for a session on an account, whose auth failure is decided from the
 *   structured signal alone: a 401 merely quoted in the exit reason must not classify it.
 * task: everything else, left to the orchestrator.
 */
export function classifyExit(reason: string, stderr: string | null, authFromText = true): CrashClass {
  if (authFromText && (isAuthFailure(reason) || isAuthFailure(stderr))) return 'auth';
  if (reason.startsWith('event stream failed')) return 'transient';
  if (/exited with code 2$/.test(reason) && stderr && USAGE.test(stderr)) return 'harness_bug';
  return 'task';
}
