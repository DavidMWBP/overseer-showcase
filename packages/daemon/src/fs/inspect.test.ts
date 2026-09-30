import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import { mkTmpRepo, copyTmpRepo, type TmpRepo } from '../test/tmpgit';
import { inspectRepo } from './inspect';
import { suggestId } from './paths';

const reg = (p: string): Repo => ({ id: 'reg', path: p, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2, model_filter: null});
const template = mkTmpRepo();

/** A fresh copy of the committed template, removed when the test ends so each test owns its own root. */
async function withRepo(fn: (t: TmpRepo) => Promise<void>): Promise<void> {
  const t = copyTmpRepo(template);
  try { await fn(t); } finally { fs.rmSync(t.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}

describe.concurrent('inspectRepo', () => {
  it('describes a registrable repo', () => withRepo(async (t) => {
    const r = await inspectRepo(t.path, []);
    expect(r).toMatchObject({ path: t.path, exists: true, is_git_root: true, branch: 'main', has_beads: false, suggested_id: 'repo', problems: [] });
    fs.mkdirSync(path.join(t.path, '.beads'));
    expect((await inspectRepo(t.path, [])).has_beads).toBe(true);
  }));
  it('reports the problems', () => withRepo(async (t) => {
    expect((await inspectRepo(path.join(t.path, 'nope'), [])).problems).toEqual(['folder does not exist']);
    fs.mkdirSync(path.join(t.path, 'sub'));
    const sub = await inspectRepo(path.join(t.path, 'sub'), []);
    expect(sub.exists).toBe(true);
    expect(sub.problems).toEqual(['not the root of a git repository']);
    expect((await inspectRepo(path.dirname(t.path), [])).problems).toEqual(['not the root of a git repository']);
    const upper = process.platform === 'win32' ? t.path.toUpperCase() : t.path;
    expect((await inspectRepo(t.path, [reg(upper)])).problems).toEqual(['already registered as reg']);
  }));
  it('suggests ids', () => {
    expect(suggestId('/x/My Repo.v2')).toBe('my-repo-v2');
    expect(suggestId('/x/---')).toBe('repo');
  });
  it('resolves a junction/symlink to the repo it points at', () => withRepo(async (t) => {
    const link = path.join(path.dirname(t.path), 'repo-link');
    fs.symlinkSync(t.path, link, process.platform === 'win32' ? 'junction' : 'dir');
    const r = await inspectRepo(link, []);
    expect(r.problems).toEqual([]);
    expect(r.is_git_root).toBe(true);
    expect(r.path).toBe(fs.realpathSync.native(t.path));
  }));
});
