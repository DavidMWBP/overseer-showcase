import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import { mkTmpRepo, copyTmpRepo, commitFile, sh } from '../test/tmpgit';
import { until } from '../test/until';
import { baseWorktreePath, ensureWorktree, headCommit, commitsSince, uncommittedWork, diffAgainstBase, removeWorktree, removeWorktreeRetry, mergeLocal, GitError, createBranch, ensureBranchWorktree, mergeInto, diffRefs, deleteBranch } from './git';

const template = mkTmpRepo();

function setup() {
  const t = copyTmpRepo(template);
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3 , review_rounds: 2, model_filter: null};
  return { repo, worktreesDir: t.worktreesDir };
}

describe.concurrent('git worktrees', () => {
  it('creates once, reuses, recreates on existing branch', async () => {
    const { repo, worktreesDir } = setup();
    const a = await ensureWorktree(repo, 'ov-1', worktreesDir);
    expect(a.created).toBe(true);
    expect(a.branch).toBe('bead/ov-1');
    expect(sh(a.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('bead/ov-1');
    const b = await ensureWorktree(repo, 'ov-1', worktreesDir);
    expect(b).toEqual({ ...a, created: false });
    fs.rmSync(a.path, { recursive: true, force: true });
    const c = await ensureWorktree(repo, 'ov-1', worktreesDir);
    expect(c.created).toBe(true);
    expect(sh(c.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('bead/ov-1');
  });

  it('counts commits, diffs, merges, removes', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-2', worktreesDir);
    const start = await headCommit(wt.path);
    expect(await commitsSince(wt.path, start)).toBe(0);
    commitFile(wt.path, 'a.txt', 'hello\n', 'add a');
    expect(await commitsSince(wt.path, start)).toBe(1);
    expect(await diffAgainstBase(wt.path, 'main')).toContain('+hello');
    expect(await mergeLocal(repo, worktreesDir, wt.branch, 'merge ov-2')).toEqual({ ok: true });
    expect(fs.existsSync(`${repo.path}/a.txt`)).toBe(true);
    await removeWorktreeRetry(repo.path, wt.path, wt.branch);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(sh(repo.path, ['branch', '--list', wt.branch])).toBe('');
    // The repo's own folder under worktrees/ goes with its last worktree (round 18 R18-5: empty folders outlived every batch).
    // The rmdir is best-effort and a Windows scanner can hold a fresh folder for a moment, so give it a few more tries: the call
    // is idempotent once the worktree is gone (fix round 18 review M4).
    await until(async () => {
      await removeWorktree(repo.path, wt.path, wt.branch);
      return !fs.existsSync(path.dirname(wt.path));
    }, 5000, 'the last worktree folder to be removed');
    expect(fs.existsSync(path.dirname(wt.path))).toBe(false);
  });

  it('reports conflicts and aborts', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-3', worktreesDir);
    commitFile(wt.path, 'README.md', '# branch\n', 'branch change');
    commitFile(repo.path, 'README.md', '# main\n', 'main change');
    const before = sh(repo.path, ['rev-parse', 'HEAD']);
    expect(await mergeLocal(repo, worktreesDir, wt.branch, 'm')).toEqual({ ok: false, conflicts: ['README.md'] });
    expect(sh(repo.path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(repo.path, ['status', '--porcelain'])).toBe('');
  });

  it('reports the original git error when the merge is refused before it starts', async () => {
    const { repo, worktreesDir } = setup();
    commitFile(repo.path, '.beads/issues.jsonl', '{"id":1}\n', 'track beads');
    const wt = await ensureWorktree(repo, 'ov-5', worktreesDir);
    commitFile(wt.path, '.beads/issues.jsonl', '{"id":2}\n', 'branch touches beads');
    fs.writeFileSync(`${repo.path}/.beads/issues.jsonl`, '{"id":3}\n'); // uncommitted, and excluded from the dirty check
    const err = await mergeLocal(repo, worktreesDir, wt.branch, 'm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toMatch(/would be overwritten/);
    expect((err as Error).message).not.toMatch(/no merge to abort/);
  });

  it('merges over unrelated dirty files, refuses overlapping ones, refuses off-base', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-4', worktreesDir);
    commitFile(wt.path, 'feature.txt', 'f\n', 'feature');
    fs.writeFileSync(`${repo.path}/dirty.txt`, 'x');
    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(`${repo.path}/dirty.txt`, 'utf8')).toBe('x');
    const wt2 = await ensureWorktree(repo, 'ov-4b', worktreesDir);
    commitFile(wt2.path, 'README.md', '# changed\n', 'touch readme');
    fs.writeFileSync(`${repo.path}/README.md`, '# local edit\n');
    await expect(mergeLocal(repo, worktreesDir, wt2.branch, 'm')).rejects.toThrow(/would be overwritten/);
    sh(repo.path, ['checkout', '-q', '--', 'README.md']);
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    await expect(mergeLocal(repo, worktreesDir, wt2.branch, 'm')).resolves.toEqual({ ok: true });
  });
});

describe('uncommittedWork', () => {
  it('is null on a clean worktree and does not count an ignored path', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-u1', worktreesDir);
    commitFile(wt.path, '.gitignore', '.playwright-cli/\n', 'ignore evidence');
    fs.mkdirSync(path.join(wt.path, '.playwright-cli'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, '.playwright-cli', 'shot.png'), 'x');

    expect(await uncommittedWork(wt.path)).toBeNull();
  });

  it('separates a tracked edit from a new untracked file', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-u2', worktreesDir);
    fs.writeFileSync(path.join(wt.path, 'README.md'), '# edited\n');
    fs.writeFileSync(path.join(wt.path, 'new.txt'), 'new\n');

    expect(await uncommittedWork(wt.path)).toEqual({ modified: ['README.md'], untracked: ['new.txt'] });
  });

  it('counts a staged edit as modified', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-u3', worktreesDir);
    fs.writeFileSync(path.join(wt.path, 'README.md'), '# staged\n');
    sh(wt.path, ['add', 'README.md']);

    expect(await uncommittedWork(wt.path)).toEqual({ modified: ['README.md'], untracked: [] });
  });
});

describe.concurrent('daemon base worktree local merges', () => {
  it('leaves an off-base primary checkout unchanged while advancing the base', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-base-1', worktreesDir);
    commitFile(wt.path, 'merged.txt', 'merged\n', 'feature');
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    fs.writeFileSync(path.join(repo.path, 'local.txt'), 'local\n');
    const head = sh(repo.path, ['rev-parse', 'HEAD']);

    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).resolves.toEqual({ ok: true });

    expect(sh(repo.path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(repo.path, ['status', '--porcelain'])).toBe('?? local.txt');
    expect(sh(repo.path, ['log', '-1', '--format=%s', 'main'])).toBe('m');
    expect(fs.existsSync(path.join(baseWorktreePath(worktreesDir, repo.id), 'merged.txt'))).toBe(true);
    expect(sh(repo.path, ['checkout', '-q', 'main'])).toBe('');
  });

  it('uses the primary checkout when it is already on base', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-base-2', worktreesDir);
    commitFile(wt.path, 'merged.txt', 'merged\n', 'feature');

    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).resolves.toEqual({ ok: true });

    expect(fs.existsSync(path.join(repo.path, 'merged.txt'))).toBe(true);
    expect(fs.existsSync(baseWorktreePath(worktreesDir, repo.id))).toBe(false);
  });

  it('aborts conflicts in the base worktree and leaves it clean', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-base-3', worktreesDir);
    commitFile(wt.path, 'README.md', '# branch\n', 'feature');
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    const basePath = baseWorktreePath(worktreesDir, repo.id);
    sh(repo.path, ['worktree', 'add', '-q', basePath, 'main']);
    commitFile(basePath, 'README.md', '# base\n', 'base');

    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).resolves.toEqual({ ok: false, conflicts: ['README.md'] });
    expect(sh(baseWorktreePath(worktreesDir, repo.id), ['status', '--porcelain'])).toBe('');
  });

  it('refuses a dirty base worktree without merging', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-base-4', worktreesDir);
    commitFile(wt.path, 'merged.txt', 'merged\n', 'feature');
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).resolves.toEqual({ ok: true });
    const basePath = baseWorktreePath(worktreesDir, repo.id);
    fs.writeFileSync(path.join(basePath, 'dirty.txt'), 'dirty\n');
    const wt2 = await ensureWorktree(repo, 'ov-base-4b', worktreesDir);
    commitFile(wt2.path, 'second.txt', 'second\n', 'feature');

    await expect(mergeLocal(repo, worktreesDir, wt2.branch, 'm2')).rejects.toThrow(basePath);
    expect(sh(repo.path, ['log', '-1', '--format=%s', 'main'])).toBe('m');
  });

  it('reuses the base worktree without rerunning setup', async () => {
    const { repo, worktreesDir } = setup();
    repo.setup_command = 'node -e "require(\'fs\').appendFileSync(\'../setup-count\', \'x\')"';
    const first = await ensureWorktree(repo, 'ov-base-5', worktreesDir);
    commitFile(first.path, 'first.txt', 'first\n', 'feature');
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    await expect(mergeLocal(repo, worktreesDir, first.branch, 'm1')).resolves.toEqual({ ok: true });
    const second = await ensureWorktree(repo, 'ov-base-5b', worktreesDir);
    commitFile(second.path, 'second.txt', 'second\n', 'feature');
    await expect(mergeLocal(repo, worktreesDir, second.branch, 'm2')).resolves.toEqual({ ok: true });

    expect(fs.readFileSync(path.join(worktreesDir, repo.id, 'setup-count'), 'utf8')).toBe('x');
  });

  it('removes a base worktree after setup fails so a retry runs setup again', async () => {
    const { repo, worktreesDir } = setup();
    repo.setup_command = 'node -e "const fs=require(\'fs\');const p=\'../setup-attempts\';const n=fs.existsSync(p)?Number(fs.readFileSync(p, \'utf8\')):0;fs.writeFileSync(p, String(n + 1));process.exit(n === 0 ? 1 : 0)"';
    const wt = await ensureWorktree(repo, 'ov-base-setup-fail', worktreesDir);
    commitFile(wt.path, 'merged.txt', 'merged\n', 'feature');
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    const basePath = baseWorktreePath(worktreesDir, repo.id);

    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).rejects.toThrow(/setup command failed/);
    expect(fs.existsSync(basePath)).toBe(false);
    await expect(mergeLocal(repo, worktreesDir, wt.branch, 'm')).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(path.join(worktreesDir, repo.id, 'setup-attempts'), 'utf8')).toBe('2');
  });
});

describe.concurrent('batch branches', () => {
  it('creates a branch and worktree, merges beads into it, diffs, cleans up', async () => {
    const { repo, worktreesDir } = setup();
    await createBranch(repo.path, 'feature/x', 'main');
    await createBranch(repo.path, 'feature/x', 'main');
    expect(sh(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    const dir = `${worktreesDir}/r1/batch-r1-b1`;
    const bw = await ensureBranchWorktree(repo, 'feature/x', dir);
    expect(bw).toEqual({ path: dir, created: true });
    expect((await ensureBranchWorktree(repo, 'feature/x', dir)).created).toBe(false);
    expect(sh(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/x');

    const wt = await ensureWorktree(repo, 'ov-9', worktreesDir, 'feature/x');
    commitFile(wt.path, 'a.txt', 'a\n', 'add a');
    expect(await mergeInto(dir, 'bead/ov-9', 'chore(x): merge ov-9\n\nAdd a\nSource: bead/ov-9')).toEqual({ ok: true });
    expect(fs.existsSync(`${dir}/a.txt`)).toBe(true);
    expect(sh(dir, ['log', '-1', '--format=%B']).trim()).toBe('chore(x): merge ov-9\n\nAdd a\nSource: bead/ov-9');
    expect(await diffRefs(repo.path, 'main', 'feature/x')).toContain('+a');
    expect(await diffAgainstBase(wt.path, 'feature/x')).toBe('');

    const wt2 = await ensureWorktree(repo, 'ov-10', worktreesDir, 'feature/x');
    commitFile(wt2.path, 'a.txt', 'conflict\n', 'clash');
    commitFile(dir, 'a.txt', 'batch side\n', 'batch side');
    expect(await mergeInto(dir, 'bead/ov-10', 'Merge bead/ov-10')).toEqual({ ok: false, conflicts: ['a.txt'] });
    expect(sh(dir, ['status', '--porcelain'])).toBe('');

    await removeWorktree(repo.path, wt.path, wt.branch);
    expect(fs.existsSync(path.dirname(wt.path))).toBe(true); // two worktrees left: the folder stays
    await removeWorktree(repo.path, wt2.path, wt2.branch);
    await removeWorktree(repo.path, dir, 'feature/x');
    expect(fs.existsSync(path.dirname(wt.path))).toBe(false);
    await deleteBranch(repo.path, 'feature/x');
    expect(sh(repo.path, ['branch', '--list', 'feature/x'])).toBe('');
  });
});

describe.concurrent('removeWorktree on a folder git no longer lists', () => {
  it('clears the leftover folder and the branch instead of failing with "is not a working tree"', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-9', worktreesDir);
    // The worktree's `.git` file gone and the entry pruned: what a Windows lock leaves behind after `git worktree remove`.
    fs.rmSync(path.join(wt.path, '.git'));
    sh(repo.path, ['worktree', 'prune']);
    await expect(removeWorktree(repo.path, wt.path, wt.branch)).resolves.toBeUndefined();
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(sh(repo.path, ['branch', '--list', wt.branch])).toBe('');
  });

  it('still reports other git failures', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-10', worktreesDir);
    // Removing through a folder that is no repository at all is not the leftover case and must surface.
    await expect(removeWorktree(wt.path + '-nowhere', wt.path, wt.branch)).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(wt.path)).toBe(true);
  });
});

describe.concurrent('mergeInto and commit hooks', () => {
  it('names a hook rejection and carries the hook output', async () => {
    const { repo, worktreesDir } = setup();
    fs.mkdirSync(path.join(repo.path, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repo.path, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "commitlint: subject may not be empty" >&2\nexit 1\n', { mode: 0o755 });
    await createBranch(repo.path, 'feature/h', 'main');
    const dir = `${worktreesDir}/r1/batch-r1-b2`;
    await ensureBranchWorktree(repo, 'feature/h', dir);
    const wt = await ensureWorktree(repo, 'ov-11', worktreesDir, 'feature/h');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'b\n');
    sh(wt.path, ['add', 'b.txt']);
    sh(wt.path, ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--no-verify', '-m', 'add b']);
    const err = await mergeInto(dir, 'bead/ov-11', 'Merge bead/ov-11').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toMatch(/^the repository's commit hook rejected the merge of bead\/ov-11: .*commitlint: subject may not be empty/s);
    expect(sh(dir, ['status', '--porcelain'])).toBe(''); // the half-done merge was aborted
  });
});
