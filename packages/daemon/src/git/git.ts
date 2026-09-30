import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Repo, UncommittedWork } from '@overseer/shared';
import { messageArgs } from './message';
import { runSetup } from '../lifecycle/verify';
import { runCapture } from '../util/procs';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

export class GitPushError extends Error {
  constructor(readonly remote: string, readonly branch: string, readonly firstLine: string) {
    super(`git push ${remote} ${branch} failed: ${firstLine}`);
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`, String(stderr)));
      else resolve(String(stdout).trim());
    });
  });
}

export const branchFor = (beadId: string) => `bead/${beadId}`;
export const worktreePath = (worktreesDir: string, repoId: string, beadId: string) => path.join(worktreesDir, repoId, beadId);
export const baseWorktreePath = (worktreesDir: string, repoId: string) => worktreePath(worktreesDir, repoId, 'base');

export async function ensureWorktree(repo: Repo, beadId: string, worktreesDir: string, from: string = repo.base_branch, opts: { prune?: boolean; branchExists?: boolean } = {}): Promise<{ path: string; branch: string; created: boolean }> {
  const wt = worktreePath(worktreesDir, repo.id, beadId);
  const branch = branchFor(beadId);
  // A caller that just pruned this repository (a dispatch that already ensured the batch worktree) passes `prune: false`, so one
  // dispatch prunes once. `branchExists` carries a check the caller already made, so the same branch is not listed twice.
  if (opts.prune !== false) await git(repo.path, ['worktree', 'prune']);
  if (fs.existsSync(wt)) {
    await git(wt, ['rev-parse', '--is-inside-work-tree']);
    return { path: wt, branch, created: false };
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const exists = opts.branchExists ?? !!(await git(repo.path, ['branch', '--list', branch]));
  if (exists) await git(repo.path, ['worktree', 'add', wt, branch]);
  else await git(repo.path, ['worktree', 'add', '-b', branch, wt, from]);
  return { path: wt, branch, created: true };
}

/**
 * The ref a new branch should be cut from: `origin/<base>` freshly fetched when the repo has an origin, else the local base.
 * A failed fetch (offline, missing remote branch) falls back to the `origin/<base>` of the last fetch when there is one, else
 * the local base, and says so in `warning`. The local base branch itself is never checked out or moved.
 */
export async function fetchBase(repoPath: string, base: string): Promise<{ ref: string; warning?: string; fetchError?: string }> {
  const remotes = (await git(repoPath, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.includes('origin')) return { ref: base };
  try {
    await git(repoPath, ['fetch', 'origin', base]);
    return { ref: `origin/${base}` };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
      return { ref: `origin/${base}`, fetchError: reason, warning: `could not fetch origin/${base}; using the last fetched origin/${base}, which may be behind the remote: ${reason}` };
    } catch {
      return { ref: base, fetchError: reason, warning: `could not fetch origin/${base}; the branch was cut from the local ${base}, which may be behind the remote: ${reason}` };
    }
  }
}

/** Resolve the checkout ref for new work: fetched origin for gitlab-mr, local base for local-merge. */
export async function resolveNewWorkBase(repo: Repo): Promise<{ ref: string; warning?: string }> {
  let from = await fetchBase(repo.path, repo.base_branch);
  if (repo.merge_mode !== 'gitlab-mr' && from.ref !== repo.base_branch) {
    const missing = Number(await git(repo.path, ['rev-list', '--count', `${repo.base_branch}..${from.ref}`]));
    const commits = `${missing} commit${missing === 1 ? '' : 's'} that the local ${repo.base_branch} lacks`;
    const base = repo.base_branch;
    // A failed fetch left an older origin ref: say so, and never present its count as the remote's.
    const warning = from.fetchError !== undefined
      ? `could not fetch ${from.ref}; the branch was cut from the local ${base}${missing > 0 ? `. The last fetched ${from.ref}, which may be behind the remote, has ${commits}; nothing was merged or fast-forwarded` : ''}: ${from.fetchError}`
      : missing > 0 ? `${from.ref} has ${commits}; the branch was cut from the local ${base}, and nothing was merged or fast-forwarded` : undefined;
    from = { ref: base, warning };
  }
  return { ref: from.ref, warning: from.warning };
}

export async function createBranch(repoPath: string, branch: string, from: string): Promise<void> {
  if (await git(repoPath, ['branch', '--list', branch])) return;
  await git(repoPath, ['branch', branch, from]);
}

export async function ensureBranchWorktree(repo: Repo, branch: string, dir: string, opts: { prune?: boolean } = {}): Promise<{ path: string; created: boolean }> {
  if (opts.prune !== false) await git(repo.path, ['worktree', 'prune']);
  if (fs.existsSync(dir)) {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return { path: dir, created: false };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.path, ['worktree', 'add', dir, branch]);
  return { path: dir, created: true };
}

/** Merges `branch` into the branch checked out at `wtPath`, one `-m` per paragraph of `message` so the body survives. Aborts and reports the conflicting files on conflict. */
export async function mergeInto(wtPath: string, branch: string, message: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  try {
    await git(wtPath, ['merge', '--no-ff', ...messageArgs(message), branch]);
    return { ok: true };
  } catch (e) {
    let conflicts: string[] = [];
    try {
      conflicts = (await git(wtPath, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    } catch {
      // listing conflicts failed; abort below, then rethrow the original merge error
    }
    try {
      await git(wtPath, ['merge', '--abort']);
    } catch {
      // nothing to abort: the merge was refused before it started, and the original error is what matters
    }
    if (conflicts.length) return { ok: false, conflicts };
    // A commit-msg or pre-merge-commit hook that exits non-zero leaves git saying "Not committing merge"; the hook's own output
    // is the stderr. Named as such, so the reopen note does not read as a git failure (overseer-ldh: commitlint with no node_modules).
    if (e instanceof GitError && /Not committing merge|hook/i.test(e.stderr)) {
      throw new GitError(`the repository's commit hook rejected the merge of ${branch}: ${e.stderr.trim()}`, e.stderr);
    }
    throw e;
  }
}

export const diffRefs = (repoPath: string, base: string, head: string) => git(repoPath, ['diff', `${base}...${head}`]);

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (await git(repoPath, ['branch', '--list', branch])) await git(repoPath, ['branch', '-D', branch]);
}

export const headCommit = (cwd: string) => git(cwd, ['rev-parse', 'HEAD']);

/** Whether `ancestor` is contained in `descendant`. `merge-base --is-ancestor` uses exit 1 for a normal false result. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.stderr.trim() === '') return false;
    throw err;
  }
}

export async function commitsSince(cwd: string, since: string): Promise<number> {
  return Number(await git(cwd, ['rev-list', '--count', `${since}..HEAD`]));
}

/**
 * Why the branch in `cwd` has nothing to land against `base`, or null when it has: at least one commit of its own that is not a
 * merge, and a non-empty diff. A branch holding only `git merge <base>` (a worker that died right after syncing) or commits
 * that cancel out is not work (overseer-xen, 2026-09-14: a merge-only branch landed and closed the bead as done).
 */
export async function nothingToLand(cwd: string, base: string): Promise<'no commits' | 'only merge commits' | 'empty diff' | null> {
  if (Number(await git(cwd, ['rev-list', '--count', `${base}..HEAD`])) === 0) return 'no commits';
  if (Number(await git(cwd, ['rev-list', '--count', '--no-merges', `${base}..HEAD`])) === 0) return 'only merge commits';
  if ((await git(cwd, ['diff', '--stat', `${base}...HEAD`])).trim() === '') return 'empty diff';
  return null;
}

/**
 * The work a worktree holds but its branch does not, from `git status --porcelain`: `modified` is every tracked path with a staged
 * or unstaged edit, `untracked` every path git does not know yet. Null when the worktree is clean. Porcelain output already omits
 * ignored paths, so a gitignored evidence folder such as `.playwright-cli/` is not work to lose; `--untracked-files=no` is
 * deliberately not passed, because a new file that was never added is dropped at the merge exactly like a modified tracked file
 * (overseer-gk52, 2026-09-17: a worker's fix and its test sat uncommitted, verification ran in the dirty worktree and passed, and
 * the merge of the branch ref would have dropped both).
 */
export async function uncommittedWork(cwd: string): Promise<UncommittedWork | null> {
  const out = await git(cwd, ['status', '--porcelain']);
  if (!out) return null;
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of out.split('\n')) {
    // `git()` trims the whole output, which eats the leading space of the first line's two-column status; match one or two
    // status characters instead of slicing a fixed offset.
    const m = /^(.{1,2})\s(.*)$/.exec(line);
    if (!m) continue;
    const status = m[1]!;
    const path = m[2]!;
    // A staged rename reads "XY old -> new"; the new path is the one that would be lost.
    const arrow = path.indexOf(' -> ');
    const file = arrow === -1 ? path : path.slice(arrow + 4);
    (status.startsWith('??') ? untracked : modified).push(file);
  }
  return { modified, untracked };
}

export const diffAgainstBase = (cwd: string, base: string) => git(cwd, ['diff', `${base}...HEAD`]);

/**
 * The refs a review round diffs, and that diff. A branch that merged its base in is not reviewable against `base...HEAD`: the
 * merge base is then the pre-merge tip, so the diff carries every change the merge brought with it as well as the work under
 * review (1,344,560 characters against 230,221 for the same work on 2026-09-21, past what the harness accepts). What the branch
 * adds on top of what it merged in is the change under review, so the newest merge's second parent is the diff base. A branch
 * with no merge commit since its base is diffed against `base...HEAD`, exactly as before.
 */
export async function reviewDiff(cwd: string, base: string): Promise<{ range: string; diff: string }> {
  const merges = (await git(cwd, ['rev-list', '--merges', `${base}..HEAD`])).split('\n').filter(Boolean);
  if (!merges.length) return { range: `${base}...HEAD`, diff: await diffAgainstBase(cwd, base) };
  const mergedIn = await git(cwd, ['rev-parse', `${merges[0]}^2`]); // rev-list is newest first; a merge always has a second parent
  const range = `${mergedIn}...HEAD`;
  return { range, diff: await git(cwd, ['diff', range]) };
}

/** `git diff --stat` over a review range: what the critic is left with when the diff itself does not fit the harness input limit. */
export const diffStat = (cwd: string, range: string) => git(cwd, ['diff', '--stat', range]);

/** Insertions plus deletions over a review range, from `git diff --shortstat`: the size the review plan reads. */
export async function diffLines(cwd: string, range: string): Promise<number> {
  const stat = await git(cwd, ['diff', '--shortstat', range]);
  return [/(\d+) insertion/, /(\d+) deletion/].reduce((n, re) => n + Number(re.exec(stat)?.[1] ?? 0), 0);
}

export async function changedFiles(cwd: string, base: string, head = 'HEAD'): Promise<string[]> {
  return (await git(cwd, ['diff', '--name-only', `${base}...${head}`])).split('\n').filter(Boolean);
}

/** Removes the worktree and, unless `branch` is null, its branch; null keeps the branch (Remove repository must not delete unmerged work). */
export async function removeWorktree(repoPath: string, wtPath: string, branch: string | null, opts: { prune?: boolean } = {}): Promise<void> {
  if (fs.existsSync(wtPath)) {
    try {
      await git(repoPath, ['worktree', 'remove', '--force', wtPath]);
    } catch (err) {
      // Git drops the worktree entry even when a locked file keeps the folder (a Windows scanner): the path is then only a
      // leftover folder, and `worktree remove` says "is not a working tree" on every later pass. Finish the removal instead.
      if (!(err instanceof GitError && err.stderr.includes('is not a working tree'))) throw err;
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }
  // A cleanup that removes several worktrees of one repository prunes once: the caller that already pruned passes `prune: false`.
  if (opts.prune !== false) await git(repoPath, ['worktree', 'prune']);
  if (branch && await git(repoPath, ['branch', '--list', branch])) await git(repoPath, ['branch', '-D', branch]);
  // `worktrees/<repo>/` is left behind empty once its last worktree goes, and a user who reads "Deleted: Overseer's worktrees for
  // it" finds the folder still there (round 18). rmdir removes it only while it is empty, so another live worktree keeps it.
  try { fs.rmdirSync(path.dirname(wtPath)); } catch { /* not empty, or never created */ }
}

/** Remove a worktree again immediately before waiting for a Windows scanner lock to clear. */
export async function removeWorktreeRetry(repoPath: string, wtPath: string, branch: string | null, opts: { delayMs?: number; prune?: boolean } = {}): Promise<void> {
  const { delayMs = 500, ...rest } = opts;
  try {
    await removeWorktree(repoPath, wtPath, branch, rest);
  } catch {
    try {
      await removeWorktree(repoPath, wtPath, branch, rest);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
      await removeWorktree(repoPath, wtPath, branch, rest);
    }
  }
}

export async function mergeLocal(repo: Repo, worktreesDir: string | undefined, branch: string, message: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  const current = await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Git cannot put one branch in two worktrees. Keep the primary checkout path for that case (and for direct callers without
  // daemon worktree configuration), but otherwise isolate the merge from whatever branch the user has checked out.
  if (current === repo.base_branch || !worktreesDir) return mergeInto(repo.path, branch, message);

  const wtPath = baseWorktreePath(worktreesDir, repo.id);
  await git(repo.path, ['worktree', 'prune']);
  if (fs.existsSync(wtPath)) {
    const status = await git(wtPath, ['status', '--porcelain']);
    if (status) throw new GitError(`daemon base worktree ${wtPath} has local changes`, '');
    await git(wtPath, ['checkout', repo.base_branch]);
  } else {
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    await git(repo.path, ['worktree', 'add', wtPath, repo.base_branch]);
    if (repo.setup_command) {
      const setup = await runSetup(repo.setup_command, wtPath);
      if (setup.status !== 'pass') {
        try { await removeWorktree(repo.path, wtPath, null); } catch { /* keep the setup failure as the actionable error */ }
        throw new GitError(`the repository's setup command failed in daemon base worktree ${wtPath}: ${setup.output}`, setup.output);
      }
    }
  }
  // A branch can only be checked out by one worktree. Detach after each merge so the user can later check out the base branch
  // in their primary checkout; the next local merge checks it out here again.
  try {
    return await mergeInto(wtPath, branch, message);
  } finally {
    await git(wtPath, ['checkout', '--detach']);
  }
}

export const pushBranch = (cwd: string, branch: string) => git(cwd, ['push', '-u', 'origin', branch]);

/** Push the local base branch to its configured remote, or origin when it has no configured upstream. */
export async function pushBaseBranch(repoPath: string, base: string): Promise<string | null> {
  const remotes = (await git(repoPath, ['remote'])).split(/\r?\n/).filter(Boolean);
  if (!remotes.length) return null;

  let upstream: string | null = null;
  try {
    const configured = await git(repoPath, ['config', '--get', `branch.${base}.remote`]);
    if (configured !== '.' && remotes.includes(configured)) upstream = configured;
  } catch { /* no configured upstream */ }

  const remote = upstream ?? (remotes.includes('origin') ? 'origin' : null);
  if (!remote) return null;

  const result = await runCapture('git', ['push', remote, base], { cwd: repoPath });
  if (result.code !== 0) {
    const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines.find((line) => /^(?:fatal:|error:|! \[|remote:.*(?:error|denied|fail|reject))/i.test(line)) ?? lines[0] ?? `git push exited with code ${result.code}`;
    throw new GitPushError(remote, base, firstLine);
  }
  return remote;
}
