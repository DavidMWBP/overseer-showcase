import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/db';
import { loadConfig } from '../config';
import { log } from '../util/log';
import { AccountLogins, CLAUDE_OAUTH_REFRESH_MARGIN_MS, refreshClaudeOAuth } from './login';
import { freshAccountEnv } from './env';
import { AUTH_HOLD_UNTIL } from './status';

const config = loadConfig({});

const base = { name: 'Work', harness: 'claude' as const, kind: 'oauth_token' as const, home: null, created_at: 't0', last_login_at: null, last_verified_at: null };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('AccountLogins.submitCode', () => {
  it('clears an authentication hold when the account is logged in again', async () => {
    const db = openDb(':memory:');
    db.accounts.insert({ ...base, id: 'a1', secret: null, exhausted_until: AUTH_HOLD_UNTIL });
    const logins = new AccountLogins(db, config);
    logins.start(db.accounts.get('a1')!);
    await logins.submitCode(db.accounts.get('a1')!, 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
    expect(db.accounts.get('a1')?.exhausted_until).toBeNull();
    expect(db.accounts.get('a1')?.last_login_at).toEqual(expect.any(String));
  });

  it('leaves a usage-limit reset in place when the account is logged in again', async () => {
    const db = openDb(':memory:');
    const reset = Date.now() + 60_000;
    db.accounts.insert({ ...base, id: 'a1', secret: null, exhausted_until: reset });
    const logins = new AccountLogins(db, config);
    logins.start(db.accounts.get('a1')!);
    await logins.submitCode(db.accounts.get('a1')!, 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
    expect(db.accounts.get('a1')?.exhausted_until).toBe(reset);
  });
});

describe('refreshClaudeOAuth', () => {
  it('logs the account id and the old and new expiry, never a token', async () => {
    const db = openDb(':memory:');
    const oldExpiry = Date.now() - 1000;
    db.accounts.insert({ ...base, id: 'a1', secret: 'old-access', refresh_token: 'refresh-1', token_expires_at: oldExpiry });
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'refresh-2', expires_in: 3600 }), { status: 200 })));
    await expect(freshAccountEnv(db, config, db.accounts.get('a1')!)).resolves.toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'new-access', ANTHROPIC_API_KEY: undefined });
    const row = info.mock.calls.map((call) => String(call[0])).find((message) => message.includes('a1'));
    expect(row).toContain('a1');
    expect(row).toContain(new Date(oldExpiry).toISOString());
    expect(row).toContain(new Date(db.accounts.get('a1')!.token_expires_at!).toISOString());
    expect(row).not.toContain('new-access');
    expect(row).not.toContain('old-access');
    expect(row).not.toContain('refresh-2');
  });

  const okToken = () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'refresh-2', expires_in: 3600 }), { status: 200 });

  it('leaves a token with three hours left unrefreshed', async () => {
    const db = openDb(':memory:');
    const expiry = Date.now() + 3 * 60 * 60_000;
    db.accounts.insert({ ...base, id: 'a1', secret: 'access', refresh_token: 'refresh-1', token_expires_at: expiry });
    const fetchMock = vi.fn().mockResolvedValue(okToken());
    vi.stubGlobal('fetch', fetchMock);
    await refreshClaudeOAuth(db, config, db.accounts.get('a1')!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.accounts.get('a1')).toMatchObject({ secret: 'access', refresh_token: 'refresh-1', token_expires_at: expiry });
  });

  it('refreshes a token with an hour and fifty-nine minutes left', async () => {
    const db = openDb(':memory:');
    const oldExpiry = Date.now() + 119 * 60_000;
    db.accounts.insert({ ...base, id: 'a1', secret: 'old-access', refresh_token: 'refresh-1', token_expires_at: oldExpiry });
    const fetchMock = vi.fn().mockResolvedValue(okToken());
    vi.stubGlobal('fetch', fetchMock);
    const fresh = await refreshClaudeOAuth(db, config, db.accounts.get('a1')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fresh.secret).toBe('new-access');
    expect(db.accounts.get('a1')!.token_expires_at).not.toBe(oldExpiry);
  });

  it('refreshes a token expiring in exactly the two-hour margin (the margin is exclusive)', async () => {
    const db = openDb(':memory:');
    db.accounts.insert({ ...base, id: 'a1', secret: 'old-access', refresh_token: 'refresh-1', token_expires_at: Date.now() + CLAUDE_OAUTH_REFRESH_MARGIN_MS });
    const fetchMock = vi.fn().mockResolvedValue(okToken());
    vi.stubGlobal('fetch', fetchMock);
    await refreshClaudeOAuth(db, config, db.accounts.get('a1')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes an already expired token', async () => {
    const db = openDb(':memory:');
    db.accounts.insert({ ...base, id: 'a1', secret: 'old-access', refresh_token: 'refresh-1', token_expires_at: Date.now() - 1 });
    const fetchMock = vi.fn().mockResolvedValue(okToken());
    vi.stubGlobal('fetch', fetchMock);
    await refreshClaudeOAuth(db, config, db.accounts.get('a1')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never refreshes an account with no refresh token', async () => {
    const db = openDb(':memory:');
    const expiry = Date.now() - 1;
    db.accounts.insert({ ...base, id: 'a1', secret: 'pasted-token', refresh_token: null, token_expires_at: expiry });
    const fetchMock = vi.fn().mockResolvedValue(okToken());
    vi.stubGlobal('fetch', fetchMock);
    const result = await refreshClaudeOAuth(db, config, db.accounts.get('a1')!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ secret: 'pasted-token', refresh_token: null, token_expires_at: expiry });
  });
});
