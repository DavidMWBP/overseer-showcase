import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountEnv, opencodeOwnLoginReaches } from './env';

const base = { id: 'a1', name: 'A', secret: null, home: null, created_at: '', last_login_at: null, last_verified_at: null };

describe('accountEnv', () => {
  it('maps each stored account kind without leaking unrelated variables', () => {
    expect(accountEnv(null)).toEqual({});
    expect(accountEnv({ ...base, harness: 'claude', kind: 'oauth_token', secret: 'token' })).toStrictEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'token', ANTHROPIC_API_KEY: undefined });
    expect(accountEnv({ ...base, harness: 'claude', kind: 'api_key', secret: 'key' })).toStrictEqual({ ANTHROPIC_API_KEY: 'key', CLAUDE_CODE_OAUTH_TOKEN: undefined });
    expect(accountEnv({ ...base, harness: 'codex', kind: 'codex_home', home: 'C:/accounts/a1' })).toEqual({ CODEX_HOME: 'C:/accounts/a1' });
  });
});

describe('opencodeOwnLoginReaches', () => {
  it('needs the DeepSeek key in the environment or the opencode login for a deepseek model, and leaves other providers alone', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-reach-'));
    try {
      const env = { XDG_DATA_HOME: data };
      expect(opencodeOwnLoginReaches('deepseek/deepseek-flash', env)).toBe(false);
      expect(opencodeOwnLoginReaches('deepseek/deepseek-flash', { ...env, DEEPSEEK_API_KEY: 'k' })).toBe(true);
      fs.mkdirSync(path.join(data, 'opencode'));
      fs.writeFileSync(path.join(data, 'opencode', 'auth.json'), JSON.stringify({ deepseek: { type: 'api', key: 'k' } }));
      expect(opencodeOwnLoginReaches('deepseek/deepseek-flash', env)).toBe(true);
      // a provider Overseer holds no key variable for is not second-guessed
      expect(opencodeOwnLoginReaches('anthropic/claude', { XDG_DATA_HOME: path.join(data, 'none') })).toBe(true);
      expect(opencodeOwnLoginReaches('deepseek', { XDG_DATA_HOME: path.join(data, 'none') })).toBe(false);
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
  });
});
