import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessName, Repo } from '@overseer/shared';
import type { AppDeps } from '../app';
import { Bus } from '../bus';
import { MemoryTaskStore } from '../beads/memory';
import { openDb } from '../db/db';
import { loadConfig } from '../config';
import { mkTmpRepo } from '../test/tmpgit';
import { ActionJobs } from './jobs';
import { registerRest } from './rest';

interface ReposApiFixture {
  app: FastifyInstance;
  dataDir: string;
  db: ReturnType<typeof openDb>;
}

async function setup(): Promise<ReposApiFixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-repos-api-'));
  expect(path.resolve(dataDir)).not.toBe(path.resolve(loadConfig({}).dataDir));
  const db = openDb(':memory:');
  const bus = new Bus();
  const store = new MemoryTaskStore();
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: path.join(dataDir, 'worktrees') };
  const app = Fastify({ logger: false });
  const logins = { drop: async () => {}, close: () => {} };
  registerRest(app, { db, config, bus, store, logins, jobs: new ActionJobs(bus) } as unknown as AppDeps);
  await app.ready();
  return { app, dataDir, db };
}

function repoRow(id: string, model_filter: Repo['model_filter'] = null): Repo {
  return { id, path: `/${id}`, base_branch: 'main', verify_command: null, review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter };
}

function account(db: ReposApiFixture['db'], id: string, harness: HarnessName): void {
  db.accounts.insert({ id, name: `Account ${id}`, label: null, harness, kind: harness === 'codex' ? 'codex_home' : harness === 'opencode' ? 'api_key' : 'oauth_token', secret: harness === 'opencode' ? 'fixture-key' : null, home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
}

describe('repository model filter REST', () => {
  let x: ReposApiFixture;

  beforeEach(async () => {
    x = await setup();
    x.db.repos.insert(repoRow('r1'));
    account(x.db, 'account-claude', 'claude');
    account(x.db, 'account-codex', 'codex');
  });
  afterEach(async () => {
    await x.app.close();
    x.db.sql.close();
    fs.rmSync(x.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('sets, changes and clears a filter, trimming and removing duplicates while keeping free model ids', async () => {
    const t = mkTmpRepo('ov-repos-create-');
    try {
      const created = await x.app.inject({ method: 'POST', url: '/api/repos', payload: {
        id: 'created-repo', path: t.path,
        model_filter: { harnesses: [' claude ', 'claude'], models: [' future-model ', 'future-model'], accounts: [' account-claude ', 'account-claude'] },
      } });
      expect(created.statusCode).toBe(200);
      expect(created.json().model_filter).toEqual({ harnesses: ['claude'], models: ['future-model'], accounts: ['account-claude'] });
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }

    const changed = await x.app.inject({ method: 'PATCH', url: '/api/repos/r1', payload: {
      model_filter: { harnesses: ['codex'], models: ['model-removed-from-tiers'], accounts: ['account-codex'] },
    } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().model_filter).toEqual({ harnesses: ['codex'], models: ['model-removed-from-tiers'], accounts: ['account-codex'] });

    const cleared = await x.app.inject({ method: 'PATCH', url: '/api/repos/r1', payload: { model_filter: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().model_filter).toBeNull();

    const empty = await x.app.inject({ method: 'PATCH', url: '/api/repos/r1', payload: { model_filter: { harnesses: [], models: [], accounts: [] } } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().model_filter).toBeNull();
  });

  it.each([
    ['unknown harness', { harnesses: ['made-up'], models: [], accounts: [] }, 'unknown harness value "made-up"'],
    ['blank model', { harnesses: [], models: ['   '], accounts: [] }, 'model "   " is blank'],
    ['unknown account id', { harnesses: [], models: [], accounts: ['missing-account'] }, 'unknown account id "missing-account"'],
    ['account harness mismatch', { harnesses: ['claude'], models: [], accounts: ['account-codex'] }, 'account id "account-codex" uses harness "codex"'],
  ])('rejects %s in POST and PATCH with a value-specific 400', async (_label, model_filter, message) => {
    const patch = await x.app.inject({ method: 'PATCH', url: '/api/repos/r1', payload: { model_filter } });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error).toContain(message);

    const post = await x.app.inject({ method: 'POST', url: '/api/repos', payload: { id: 'invalid-repo', path: '/missing/repo', model_filter } });
    expect(post.statusCode).toBe(400);
    expect(post.json().error).toContain(message);
  });

  it('keeps PATCH strict for unknown keys', async () => {
    const response = await x.app.inject({ method: 'PATCH', url: '/api/repos/r1', payload: { unexpected_setting: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('unexpected_setting');
  });

  it('keeps a deleted account id in the repository filter', async () => {
    x.db.repos.update('r1', { model_filter: { harnesses: ['claude'], models: ['future-model'], accounts: ['account-claude'] } });
    const deleted = await x.app.inject({ method: 'DELETE', url: '/api/accounts/account-claude' });
    expect(deleted.statusCode).toBe(200);
    expect((await x.app.inject({ method: 'GET', url: '/api/repos' })).json()[0].model_filter).toEqual({ harnesses: ['claude'], models: ['future-model'], accounts: ['account-claude'] });
  });
});
