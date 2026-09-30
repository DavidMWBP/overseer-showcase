import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { Db, StoredAccount } from '../db/db';
import { clearAuthHold } from './status';
import { log } from '../util/log';
import { spawnLines, type LineProcess } from '../util/procs';

export type LoginState = { state: 'idle' | 'pending' | 'done' | 'failed'; url?: string; code?: string; error?: string; started_at?: string; instructions?: string };
type Active = LoginState & { process?: LineProcess; account: StoredAccount; verifier?: string; oauthState?: string; lastStderr?: string; expectDeviceUrl?: boolean; expectDeviceCode?: boolean };

const URL_PATTERN = /https?:\/\/[^\s\x07]+/;
const OAUTH_TOKEN = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** The token `claude setup-token` prints. Checked on paste so a wrong paste fails where the user can still fix it. */
const OAUTH_TOKEN_PREFIX = /^sk-ant-oat01-\S+$/;

// OpenCode source reference: sst/opencode commit 68e82e4, packages/opencode/src/auth/anthropic.ts.
// It authorizes at https://claude.ai/oauth/authorize with client id 9d1c250a-e61b-44d9-88ed-5944d1962f5e,
// redirect URI https://console.anthropic.com/oauth/code/callback, and scopes
// "org:create_api_key user:profile user:inference". It POSTs JSON to
// https://console.anthropic.com/v1/oauth/token. Authorization-code JSON is
// { code, state, grant_type: "authorization_code", client_id, redirect_uri, code_verifier };
// refresh JSON is { grant_type: "refresh_token", refresh_token, client_id }.
export const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference';
export const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const PKCE_BYTES = 32;

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }

function tokenResponse(value: unknown): { access: string; refresh: string; expires: number } {
  const body = value as TokenResponse;
  if (typeof body?.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number') throw new Error('Anthropic OAuth token response was incomplete');
  return { access: body.access_token, refresh: body.refresh_token, expires: Date.now() + body.expires_in * 1000 };
}

const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000;

async function postToken(url: string, body: object, action: string, timeoutMs = TOKEN_ENDPOINT_TIMEOUT_MS): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Anthropic OAuth ${action} failed (HTTP ${response.status})`);
  return tokenResponse(await response.json());
}

/**
 * Refresh a stored Claude OAuth token once it expires within this window, so every session starts with at least this much
 * left. At the previous 5-minute window a token could expire mid-turn: a session started 2026-09-23 on a token 9.5 minutes
 * from expiry, which the 5-minute check left alone, failed its first turn seconds after the token lapsed. Two hours also
 * covers a worker session, which rarely runs longer. Exported as the one margin the orchestrator path reuses.
 */
export const CLAUDE_OAUTH_REFRESH_MARGIN_MS = 2 * 60 * 60_000;

const refreshFlights = new Map<string, Promise<StoredAccount>>();

/**
 * `force` refreshes even a token outside the margin: a session that resumes after its account rejected the very token that is
 * still stored must not be handed that token back just because its recorded expiry is hours away.
 */
export async function refreshClaudeOAuth(db: Db, config: Config, account: StoredAccount, force = false): Promise<StoredAccount> {
  if (account.kind !== 'oauth_token' || !account.refresh_token || account.token_expires_at == null || (!force && account.token_expires_at > Date.now() + CLAUDE_OAUTH_REFRESH_MARGIN_MS)) return account;
  const existing = refreshFlights.get(account.id);
  if (existing) return existing;
  let flight!: Promise<StoredAccount>;
  flight = (async () => {
    // Every attempt is logged with the account id and the two expiries (never the token): a refresh that left no trace let a
    // revoked-but-unexpired grant look healthy on 2026-09-18, when it was refreshed for a dispatch that had already failed.
    try {
      const tokens = await postToken(config.anthropicTokenUrl, { grant_type: 'refresh_token', refresh_token: account.refresh_token, client_id: ANTHROPIC_CLIENT_ID }, 'refresh', config.anthropicTokenTimeoutMs);
      db.accounts.update(account.id, { secret: tokens.access, refresh_token: tokens.refresh, token_expires_at: tokens.expires });
      log.info(`accounts: refreshed Claude OAuth token for ${account.id}; expiry ${new Date(account.token_expires_at!).toISOString()} -> ${new Date(tokens.expires).toISOString()}`);
      return db.accounts.get(account.id)!;
    } catch (err) {
      log.warn(`accounts: Claude OAuth refresh failed for ${account.id}`, err);
      throw err;
    }
  })();
  refreshFlights.set(account.id, flight);
  return flight.finally(() => {
    if (refreshFlights.get(account.id) === flight) refreshFlights.delete(account.id);
  });
}

export const PASTE_INSTRUCTIONS = 'Run `claude setup-token` in a terminal on any machine, sign in, then paste the token it prints (it starts with sk-ant-oat01-).';

/** Never let a token reach a log file or the login state the API returns. */
const redact = (line: string): string => line.replace(OAUTH_TOKEN, '[REDACTED]');

export class AccountLogins {
  private states = new Map<string, Active>();
  constructor(private db: Db, private config: Config) {}
  get(id: string): LoginState { const s = this.states.get(id); return s ? this.public(s) : { state: 'idle' }; }
  private public(s: Active): LoginState {
    const { process: _process, account: _account, verifier: _verifier, oauthState: _oauthState, lastStderr: _lastStderr, expectDeviceUrl: _expectDeviceUrl, expectDeviceCode: _expectDeviceCode, ...state } = s;
    return state;
  }
  private logFile(account: StoredAccount): string { return path.join(this.config.dataDir, 'accounts', account.id, 'login.log'); }
  /** `line` is already redacted by `consume`; the token of an oauth_token account is never written here at all. */
  private write(state: Active, line: string): void {
    fs.mkdirSync(path.dirname(this.logFile(state.account)), { recursive: true });
    fs.appendFileSync(this.logFile(state.account), `${line}\n`);
  }
  start(account: StoredAccount): LoginState {
    const prior = this.states.get(account.id);
    if (prior?.state === 'pending') throw new Error('login already pending');
    if (account.kind === 'api_key') { const state: Active = { account, state: 'done', instructions: 'paste an API key' }; this.states.set(account.id, state); return this.public(state); }
    if (account.kind === 'oauth_token') {
      const verifier = randomBytes(PKCE_BYTES).toString('base64url');
      const oauthState = randomBytes(PKCE_BYTES).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL(ANTHROPIC_AUTHORIZE_URL);
      for (const [key, value] of Object.entries({ code: 'true', client_id: ANTHROPIC_CLIENT_ID, response_type: 'code', redirect_uri: ANTHROPIC_REDIRECT_URI, scope: ANTHROPIC_SCOPES, code_challenge: challenge, code_challenge_method: 'S256', state: oauthState })) url.searchParams.set(key, value);
      const state: Active = { account, verifier, oauthState, state: 'pending', url: url.toString(), started_at: new Date().toISOString(), instructions: `Open the authorization link, approve Claude access, then paste the code shown. As a fallback, ${PASTE_INSTRUCTIONS.replace(/^./, (first) => first.toLowerCase())}` };
      this.states.set(account.id, state); return this.public(state);
    }
    // Codex CLI 0.154.0 prints these real lines (ANSI colour removed here):
    // "1. Open this link in your browser and sign in to your account", then "   https://auth.openai.com/codex/device";
    // "2. Enter this one-time code (expires in 15 minutes)", then a line such as "   EMD6-W78HF".
    const p = spawnLines(this.config.codexBin, ['login', '--device-auth'], { env: { CODEX_HOME: account.home! } });
    const state: Active = { account, process: p, state: 'pending', started_at: new Date().toISOString(), instructions: 'Open the URL and enter the code.' };
    this.states.set(account.id, state);
    void this.follow(state).catch((err) => {
      if (this.states.get(account.id) !== state || state.state !== 'pending') return;
      state.process?.child?.kill();
      state.state = 'failed'; state.error = 'login process failed'; delete state.process;
      log.error(`accounts: login follow failed for ${account.id}`, err);
    });
    try { this.write(state, 'codex device login started'); } catch (err) {
      // The follower is live before this write; contain a filesystem failure so its child cannot be orphaned.
      state.process?.child?.kill();
      state.state = 'failed'; state.error = 'login process failed'; delete state.process;
      log.error(`accounts: login start failed for ${account.id}`, err);
      throw err;
    }
    return this.public(state);
  }
  private async follow(state: Active): Promise<void> {
    const p = state.process!;
    const stdout = (async () => { for await (const raw of p.lines) this.consume(state, raw, false); })();
    const stderr = (async () => { for await (const raw of p.stderrLines ?? []) this.consume(state, raw, true); })();
    await Promise.all([stdout, stderr]);
    if (this.states.get(state.account.id) !== state) return;
    const code = await p.exit;
    if (state.state !== 'pending') return;
    if (code === 0) {
      // The confirmation child replaces the exited device-auth child in `state.process`, so cancel() and close() kill it too.
      const status = spawnLines(this.config.codexBin, ['login', 'status'], { env: { CODEX_HOME: state.account.home! } });
      state.process = status;
      const statusCode = await status.exit;
      // A cancel or an account deletion while the status ran drops the state: it must not stamp last_login_at.
      if (this.states.get(state.account.id) !== state || state.state !== 'pending') return;
      if (statusCode === 0) { this.db.accounts.update(state.account.id, { last_login_at: new Date().toISOString(), ...clearAuthHold(state.account) }); state.state = 'done'; delete state.process; return; }
      state.state = 'failed'; state.error = 'codex login status failed'; delete state.process; return;
    }
    state.state = 'failed'; state.error = state.lastStderr ?? `exited with code ${code}`; delete state.process;
  }
  /** Only a codex device login has a process, so this reads codex output alone. */
  private consume(state: Active, raw: string, isStderr: boolean): void {
    const line = redact(raw.replace(ANSI, '').trim());
    this.write(state, line);
    if (isStderr && line) state.lastStderr = line;
    if (/Open this link in your browser/i.test(line)) state.expectDeviceUrl = true;
    else if (state.expectDeviceUrl) {
      const url = URL_PATTERN.exec(line)?.[0];
      if (url) { state.url = url; state.expectDeviceUrl = false; }
    }
    if (/Enter this one-time code/i.test(line)) state.expectDeviceCode = true;
    else if (state.expectDeviceCode && line) { state.code = line; state.expectDeviceCode = false; }
  }
  /** Exchanges a pasted `code#state`, or stores the whole setup-token fallback. Neither is written to the login log. */
  async submitCode(account: StoredAccount, code: string): Promise<LoginState> {
    const state = this.states.get(account.id);
    if (!state || state.state !== 'pending') throw new Error('login is not pending');
    if (account.kind !== 'oauth_token') throw new Error('login does not accept a code');
    const pasted = code.trim();
    if (!pasted.includes('#')) {
      if (!OAUTH_TOKEN_PREFIX.test(pasted)) throw new Error('paste the authorization code (including #state), or the token `claude setup-token` prints, which starts with sk-ant-oat01-');
      this.db.accounts.update(account.id, { secret: pasted, refresh_token: null, token_expires_at: null, last_login_at: new Date().toISOString(), ...clearAuthHold(account) });
    } else {
      const [authorizationCode, returnedState] = pasted.split('#', 2);
      if (!authorizationCode || !returnedState || returnedState !== state.oauthState || !state.verifier) throw new Error('the pasted Claude authorization code has an invalid state');
      const tokens = await postToken(this.config.anthropicTokenUrl, { code: authorizationCode, state: returnedState, grant_type: 'authorization_code', client_id: ANTHROPIC_CLIENT_ID, redirect_uri: ANTHROPIC_REDIRECT_URI, code_verifier: state.verifier }, 'exchange');
      this.db.accounts.update(account.id, { secret: tokens.access, refresh_token: tokens.refresh, token_expires_at: tokens.expires, last_login_at: new Date().toISOString(), ...clearAuthHold(account) });
    }
    state.state = 'done'; delete state.instructions;
    return this.public(state);
  }
  cancel(id: string): LoginState {
    const state = this.states.get(id);
    if (!state || state.state !== 'pending') return this.get(id);
    this.states.delete(id); state.process?.child?.kill(); return { state: 'idle' };
  }
  /** Kills a pending login and forgets the state entirely, for an account that is being deleted. Resolves once the killed
   * child is gone (bounded), so the caller can remove its CODEX_HOME without the dying process still holding it. */
  async drop(id: string): Promise<void> {
    const exit = this.states.get(id)?.process?.exit;
    this.cancel(id); this.states.delete(id);
    if (exit) await Promise.race([exit, new Promise((r) => setTimeout(r, 5000))]);
  }
  close(): void { for (const [id, state] of this.states) if (state.state === 'pending') { this.states.delete(id); state.process?.child?.kill(); } }
}
