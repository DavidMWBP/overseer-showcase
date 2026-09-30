import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchRow, Repo, WorktreeRow } from '@overseer/shared';
import { mkTmpRepo, copyTmpRepo, commitFile, sh, type TmpRepo } from '../test/tmpgit';
import { createBranch, ensureBranchWorktree, ensureWorktree } from './git';
import { GitlabMrProvider, LocalMergeProvider, providerFor, type GlabRunner } from './provider';
import { loadConfig } from '../config';

function remoteTemplate(): TmpRepo & { bare: string } {
  const t = mkTmpRepo();
  const bare = path.join(t.root, 'bare');
  fs.mkdirSync(bare);
  sh(bare, ['init', '--bare', '-q']);
  sh(t.path, ['remote', 'add', 'origin', bare]);
  sh(t.path, ['push', '-q', '-u', 'origin', 'main']);
  return { ...t, bare };
}
const template = remoteTemplate();

function withRemote() {
  const t = copyTmpRepo(template);
  const bare = path.join(t.root, 'bare');
  fs.cpSync(template.bare, bare, { recursive: true });
  sh(t.path, ['remote', 'set-url', 'origin', bare]);
  return { ...t, bare };
}

type Call = { cwd: string; args: string[]; description?: string };
// Records every glab call and reads the description file while it still exists, as glab would.
function fakeGlab(calls: Call[], reply: (args: string[]) => { code: number; stdout: string; stderr: string }): GlabRunner {
  return async (cwd, args) => {
    const at = args.indexOf('--description-file');
    calls.push({ cwd, args, ...(at >= 0 ? { description: fs.readFileSync(args[at + 1]!, 'utf8') } : {}) });
    return reply(args);
  };
}
const created = (n: number) => ({ code: 0, stdout: `Creating merge request in group/proj\n\nhttps://gitlab.example.com/group/proj/-/merge_requests/${n}\n`, stderr: '' });
const ok = { code: 0, stdout: '', stderr: '' };
const noMr = { code: 0, stdout: '[]\n', stderr: '' };
const repoOf = (t: { path: string }): Repo => ({ id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'gitlab-mr', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null });
const batchRow = (mr_url: string | null, base_branch = 'main'): BatchRow => ({ id: 'r1-b1', repo_id: 'r1', title: 'T', branch: 'feature/t', base_branch, status: 'review', note: null, history: null, mr_url, conflict_files: null, created_at: 't', updated_at: 't', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
async function batchWorktree(t: ReturnType<typeof withRemote>) {
  await createBranch(t.path, 'feature/t', 'main');
  const wt = await ensureBranchWorktree(repoOf(t), 'feature/t', path.join(t.worktreesDir, 'r1', 'batch-r1-b1'));
  commitFile(wt.path, 'a.txt', 'a', 'a');
  return wt;
}

describe.concurrent('GitlabMrProvider', () => {
  it('pushes, opens an MR and returns its URL', async () => {
    const t = withRemote();
    const repo = repoOf(t);
    const wt = await ensureWorktree(repo, 'ov-1', t.worktreesDir);
    commitFile(wt.path, 'a.txt', 'a', 'a');
    const calls: Call[] = [];
    const glab = fakeGlab(calls, (args) => (args[1] === 'list' ? noMr : created(7)));
    const row: WorktreeRow = { bead_id: 'ov-1', repo_id: 'r1', path: wt.path, branch: wt.branch, base_branch: 'main', verify_status: 'pass', verify_output: '', review_note: 'Adds a.txt', conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null };
    const r = await new GitlabMrProvider(glab).land(repo, row, { title: 'Add a', description: 'Adds a.txt' });
    expect(r).toEqual({ ok: true, mrUrl: 'https://gitlab.example.com/group/proj/-/merge_requests/7' });
    expect(sh(t.bare, ['branch', '--list', 'bead/ov-1'])).toContain('bead/ov-1');
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([['mr', 'list'], ['mr', 'create']]);
    expect(calls[0]!.args).toEqual(['mr', 'list', '--source-branch', 'bead/ov-1', '--target-branch', 'main', '--output', 'json']);
    expect(calls[1]!).toMatchObject({ cwd: t.path, description: 'Adds a.txt' });
    expect(calls[1]!.args).toEqual(['mr', 'create', '--source-branch', 'bead/ov-1', '--target-branch', 'main', '--title', 'Add a', '--description-file', calls[1]!.args[9]!, '--yes']);
  });
  it('land updates a per-bead MR toward the repository base branch', async () => {
    const t = withRemote();
    const repo = repoOf(t);
    const wt = await ensureWorktree(repo, 'ov-3', t.worktreesDir);
    commitFile(wt.path, 'c.txt', 'c', 'c');
    const calls: Call[] = [];
    const glab = fakeGlab(calls, () => ok);
    const url = 'https://gitlab.example.com/group/proj/-/merge_requests/13';
    const row: WorktreeRow = { bead_id: 'ov-3', repo_id: 'r1', path: wt.path, branch: wt.branch, base_branch: 'main', verify_status: 'pass', verify_output: '', review_note: 'Adds c.txt', conflict_files: null, merged_at: null, mr_url: url, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null };
    const r = await new GitlabMrProvider(glab).land(repo, row, { title: 'Add c', description: 'Adds c.txt' });
    expect(r).toEqual({ ok: true, mrUrl: url });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['mr', 'update', '13', '--title', 'Add c', '--description-file', calls[0]!.args[6]!, '--target-branch', 'main', '--yes']);
  });
  it('landBatch pushes the batch branch and opens an MR when none is open for it', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    const calls: Call[] = [];
    const glab = fakeGlab(calls, (args) => (args[1] === 'list' ? noMr : created(8)));
    const r = await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow(null), wt.path, { title: 'T', description: 'Adds a.txt' });
    expect(r).toEqual({ ok: true, mrUrl: 'https://gitlab.example.com/group/proj/-/merge_requests/8' });
    expect(sh(t.bare, ['branch', '--list', 'feature/t'])).toContain('feature/t');
    expect(calls[0]!.args).toEqual(['mr', 'list', '--source-branch', 'feature/t', '--target-branch', 'main', '--output', 'json']);
    expect(calls[1]!).toMatchObject({ cwd: t.path, description: 'Adds a.txt' });
    expect(calls[1]!.args).toEqual(['mr', 'create', '--source-branch', 'feature/t', '--target-branch', 'main', '--title', 'T', '--description-file', calls[1]!.args[9]!, '--yes']);
  });
  it('landBatch creates a stacked MR against the batch base and lists that target first', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    const calls: Call[] = [];
    const glab = fakeGlab(calls, (args) => (args[1] === 'list' ? noMr : created(9)));
    const r = await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow(null, 'feature/parent'), wt.path, { title: 'T', description: 'Adds a.txt' });
    expect(r).toEqual({ ok: true, mrUrl: 'https://gitlab.example.com/group/proj/-/merge_requests/9' });
    expect(calls.map((call) => call.args)).toEqual([
      ['mr', 'list', '--source-branch', 'feature/t', '--target-branch', 'feature/parent', '--output', 'json'],
      ['mr', 'list', '--source-branch', 'feature/t', '--output', 'json'],
      ['mr', 'create', '--source-branch', 'feature/t', '--target-branch', 'feature/parent', '--title', 'T', '--description-file', calls[2]!.args[9]!, '--yes'],
    ]);
  });
  it('landBatch after a rejection updates the MR the batch already has instead of creating a second one', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    commitFile(wt.path, 'b.txt', 'fix', 'fix after rejection');
    const calls: Call[] = [];
    const glab = fakeGlab(calls, () => ok);
    const url = 'https://gitlab.example.com/group/proj/-/merge_requests/396';
    const r = await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow(url), wt.path, { title: 'T2', description: 'Round 2' });
    expect(r).toEqual({ ok: true, mrUrl: url });
    expect(sh(t.bare, ['log', '--oneline', 'feature/t'])).toContain('fix after rejection');
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ cwd: t.path, description: 'Round 2' });
    expect(calls[0]!.args).toEqual(['mr', 'update', '396', '--title', 'T2', '--description-file', calls[0]!.args[6]!, '--target-branch', 'main', '--yes']);
  });
  it('landBatch re-requests a known stacked MR with the batch current base as its target', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    const calls: Call[] = [];
    const glab = fakeGlab(calls, () => ok);
    const url = 'https://gitlab.example.com/group/proj/-/merge_requests/397';
    const r = await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow(url, 'feature/parent'), wt.path, { title: 'T3', description: 'Restack' });
    expect(r).toEqual({ ok: true, mrUrl: url });
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ cwd: t.path, description: 'Restack' });
    expect(calls[0]!.args).toEqual(['mr', 'update', '397', '--title', 'T3', '--description-file', calls[0]!.args[6]!, '--target-branch', 'feature/parent', '--yes']);
  });
  it('retargetBatch updates a known MR to its new base', async () => {
    const t = withRemote();
    const calls: Call[] = [];
    const url = 'https://gitlab.example.com/group/proj/-/merge_requests/398';
    const glab = fakeGlab(calls, (args) => args[1] === 'view'
      ? { code: 0, stdout: JSON.stringify({ target_branch: 'feature/parent' }), stderr: '' }
      : ok);
    const updated = await new GitlabMrProvider(glab).retargetBatch(repoOf(t), batchRow(url, 'feature/parent'), 'main');
    expect(updated).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([
      ['mr', 'view', '398', '--output', 'json'],
      ['mr', 'update', '398', '--target-branch', 'main', '--yes'],
    ]);
  });
  it('retargetBatch leaves an MR already on the requested base alone', async () => {
    const t = withRemote();
    const calls: Call[] = [];
    const url = 'https://gitlab.example.com/group/proj/-/merge_requests/399';
    const glab = fakeGlab(calls, () => ({ code: 0, stdout: JSON.stringify({ target_branch: 'main' }), stderr: '' }));
    const updated = await new GitlabMrProvider(glab).retargetBatch(repoOf(t), batchRow(url, 'feature/parent'), 'main');
    expect(updated).toBe(false);
    expect(calls.map((call) => call.args)).toEqual([['mr', 'view', '399', '--output', 'json']]);
  });
  it('landBatch updates an open MR GitLab reports for the branch when Overseer has no URL for it', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    const calls: Call[] = [];
    const glab = fakeGlab(calls, (args) => (args[1] === 'list' && args.includes('--target-branch') ? noMr : args[1] === 'list'
      ? { code: 0, stdout: JSON.stringify([{ iid: 12, state: 'opened', target_branch: 'main', web_url: 'https://gitlab.example.com/group/proj/-/merge_requests/12' }]), stderr: '' }
      : ok));
    const r = await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow(null, 'feature/parent'), wt.path, { title: 'T', description: 'd' });
    expect(r).toEqual({ ok: true, mrUrl: 'https://gitlab.example.com/group/proj/-/merge_requests/12' });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([['mr', 'list', '--source-branch'], ['mr', 'list', '--source-branch'], ['mr', 'update', '12']]);
    expect(calls[0]!.args).toEqual(['mr', 'list', '--source-branch', 'feature/t', '--target-branch', 'feature/parent', '--output', 'json']);
    expect(calls[1]!.args).toEqual(['mr', 'list', '--source-branch', 'feature/t', '--output', 'json']);
    expect(calls[2]!.args).toEqual(['mr', 'update', '12', '--title', 'T', '--description-file', calls[2]!.args[6]!, '--target-branch', 'feature/parent', '--yes']);
  });
  it('landBatch falls back to update when create still answers 409 with the existing iid', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    const calls: Call[] = [];
    const glab = fakeGlab(calls, (args) => args[1] === 'list' ? noMr : args[1] === 'create'
      ? { code: 1, stdout: '', stderr: 'POST https://gitlab.example.com/api/v4/projects/1/merge_requests: 409 {message: [Another open merge request already exists for this source branch: !396]}' }
      : { code: 0, stdout: 'https://gitlab.example.com/group/proj/-/merge_requests/396\n', stderr: '' });
    const r = await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow(null), wt.path, { title: 'T', description: 'd' });
    expect(r).toEqual({ ok: true, mrUrl: 'https://gitlab.example.com/group/proj/-/merge_requests/396' });
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([['mr', 'list', '--source-branch'], ['mr', 'create', '--source-branch'], ['mr', 'update', '396']]);
    expect(calls[0]!.args).toEqual(['mr', 'list', '--source-branch', 'feature/t', '--target-branch', 'main', '--output', 'json']);
    expect(calls[1]!.args).toEqual(['mr', 'create', '--source-branch', 'feature/t', '--target-branch', 'main', '--title', 'T', '--description-file', calls[1]!.args[9]!, '--yes']);
    expect(calls[2]!.args).toEqual(['mr', 'update', '396', '--title', 'T', '--description-file', calls[2]!.args[6]!, '--target-branch', 'main', '--yes']);
  });
  it('passes the description to glab byte for byte through the file and removes the file afterwards', async () => {
    const t = withRemote();
    const wt = await batchWorktree(t);
    const description = '# Summary\n\n| col | val |\n|---|---|\n| a | `code` |\n\n- "quotes" & <angles> % $var\n\n```ts\nconst x = 1;\n```\né中🚀\n' + 'x'.repeat(40_000);
    const calls: Call[] = [];
    const glab = fakeGlab(calls, () => ok);
    await new GitlabMrProvider(glab).landBatch(repoOf(t), batchRow('https://gitlab.example.com/g/p/-/merge_requests/1'), wt.path, { title: 'T', description });
    expect(calls[0]!.description).toBe(description);
    expect(calls[0]!.args).not.toContain('--description');
    expect(fs.existsSync(calls[0]!.args[6]!)).toBe(false);
  });
  it('throws with stderr when glab fails', async () => {
    const t = withRemote();
    const repo = repoOf(t);
    const wt = await ensureWorktree(repo, 'ov-2', t.worktreesDir);
    commitFile(wt.path, 'b.txt', 'b', 'b');
    const glab: GlabRunner = async (_cwd, args) => (args[1] === 'list' ? noMr : { code: 1, stdout: '', stderr: 'not authenticated' });
    const row: WorktreeRow = { bead_id: 'ov-2', repo_id: 'r1', path: wt.path, branch: wt.branch, base_branch: 'main', verify_status: 'pass', verify_output: '', review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null };
    await expect(new GitlabMrProvider(glab).land(repo, row, { title: 't', description: 'd' })).rejects.toThrow(/not authenticated/);
  });
});

describe('providerFor', () => {
  it('selects by merge_mode', () => {
    const base: Repo = { id: 'r', path: '/r', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1 , review_rounds: 2, model_filter: null};
    expect(providerFor(base, loadConfig({}))).toBeInstanceOf(LocalMergeProvider);
    expect(providerFor({ ...base, merge_mode: 'gitlab-mr' }, loadConfig({}))).toBeInstanceOf(GitlabMrProvider);
  });
});
