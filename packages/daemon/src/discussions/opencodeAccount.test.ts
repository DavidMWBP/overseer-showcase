import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountEnv } from '../accounts/env';
import { openDb, type Db, type StoredAccount } from '../db/db';
import { chooseOpencodeAccount } from './opencodeAccount';

const LIVE_DB = path.join(os.homedir(), '.overseer', 'overseer.db');
const opened: { db: Db; dir: string }[] = [];

/** A fresh temp database, asserted off the live install's path, so no test can reach the user's own rows. */
function tempDb(): Db {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'disc-eval-account-'));
  const file = path.join(dir, 'overseer.db');
  expect(path.resolve(file).toLowerCase()).not.toBe(path.resolve(LIVE_DB).toLowerCase());
  const db = openDb(file);
  opened.push({ db, dir });
  return db;
}

function insert(db: Db, id: string, harness: 'claude' | 'codex' | 'opencode', extra: { provider?: string | null; secret?: string | null } = {}): void {
  db.accounts.insert({ id, name: id, harness, kind: harness === 'claude' ? 'oauth_token' : harness === 'codex' ? 'codex_home' : 'api_key', home: null, created_at: '2026-09-30', last_login_at: null, last_verified_at: null, ...extra });
}

const rows = (db: Db): StoredAccount[] => db.sql.prepare('SELECT * FROM accounts').all() as unknown as StoredAccount[];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('chooseOpencodeAccount', () => {
  it('stops with what to pass or create when the database has no opencode account', () => {
    const db = tempDb();
    insert(db, 'a-claude', 'claude');
    expect(() => chooseOpencodeAccount(rows(db))).toThrow(/no opencode account; pass --opencode-account <id> or create one in Setup/);
  });

  it('uses the only opencode account when the database has exactly one, and only its environment', () => {
    const db = tempDb();
    insert(db, 'a-claude', 'claude');
    insert(db, 'a-oc', 'opencode', { provider: 'deepseek', secret: 'key-1' });
    const chosen = chooseOpencodeAccount(rows(db));
    expect(chosen.id).toBe('a-oc');
    expect(accountEnv(chosen)).toEqual({ DEEPSEEK_API_KEY: 'key-1' });
  });

  it('asks for the flag when the database has two opencode accounts, unless one is named', () => {
    const db = tempDb();
    insert(db, 'a-oc', 'opencode', { provider: 'deepseek', secret: 'k1' });
    insert(db, 'a-oc-two', 'opencode', { provider: 'deepseek', secret: 'k2' });
    expect(() => chooseOpencodeAccount(rows(db))).toThrow(/2 opencode accounts; pass --opencode-account <id> to choose one/);
    expect(chooseOpencodeAccount(rows(db), 'a-oc-two').id).toBe('a-oc-two');
  });

  it('refuses an id that names a claude or codex account, or no account at all', () => {
    const db = tempDb();
    insert(db, 'a-claude', 'claude');
    insert(db, 'a-codex', 'codex');
    const all = rows(db);
    expect(() => chooseOpencodeAccount(all, 'a-claude')).toThrow(/a-claude is missing or not an opencode account/);
    expect(() => chooseOpencodeAccount(all, 'a-codex')).toThrow(/a-codex is missing or not an opencode account/);
    expect(() => chooseOpencodeAccount(all, 'a-gone')).toThrow(/a-gone is missing or not an opencode account/);
  });

  it('refuses an empty --opencode-account value even when a valid opencode account exists', () => {
    const db = tempDb();
    insert(db, 'a-oc', 'opencode', { provider: 'deepseek', secret: 'k1' });
    expect(() => chooseOpencodeAccount(rows(db), '')).toThrow('--opencode-account needs an account id');
  });
});
