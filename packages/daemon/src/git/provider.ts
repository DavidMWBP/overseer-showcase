import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchRow, Repo, WorktreeRow } from '@overseer/shared';
import type { Config } from '../config';
import { mergeLocal, pushBranch } from './git';
import { runCapture } from '../util/procs';
import { mergeMessage } from './message';

export type LandResult = { ok: true; mrUrl?: string } | { ok: false; conflicts: string[] };

export interface GitProvider {
  land(repo: Repo, wt: WorktreeRow, mr: { title: string; description: string }): Promise<LandResult>;
  landBatch(repo: Repo, batch: BatchRow, wtPath: string, mr: { title: string; description: string }): Promise<LandResult>;
  retargetBatch?(repo: Repo, batch: BatchRow, targetBranch: string): Promise<boolean>;
}

export class MergeConflictError extends Error {
  constructor(readonly files: string[]) { super(`merge conflict in ${files.join(', ')}`); }
}

export class LocalMergeProvider implements GitProvider {
  constructor(private readonly worktreesDir?: string) {}

  async land(repo: Repo, wt: WorktreeRow, mr: { title: string; description: string }): Promise<LandResult> {
    const r = await mergeLocal(repo, this.worktreesDir, wt.branch, mergeMessage({ target: repo.base_branch, id: wt.bead_id, title: mr.title, source: wt.branch, description: mr.description }));
    return r.ok ? { ok: true } : { ok: false, conflicts: r.conflicts };
  }

  async landBatch(repo: Repo, batch: BatchRow, _wtPath: string, mr: { title: string; description: string }): Promise<LandResult> {
    const r = await mergeLocal(repo, this.worktreesDir, batch.branch, mergeMessage({ target: repo.base_branch, id: batch.id, title: mr.title, source: batch.branch, description: mr.description }));
    return r.ok ? { ok: true } : { ok: false, conflicts: r.conflicts };
  }
}

export type GlabRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export class GitlabMrProvider implements GitProvider {
  constructor(private glab: GlabRunner) {}

  async land(repo: Repo, wt: WorktreeRow, mr: { title: string; description: string }): Promise<LandResult> {
    await pushBranch(wt.path, wt.branch);
    const url = await this.createOrUpdate(repo, wt.branch, repo.base_branch, mr, wt.mr_url);
    return { ok: true, mrUrl: url };
  }

  async landBatch(repo: Repo, batch: BatchRow, wtPath: string, mr: { title: string; description: string }): Promise<LandResult> {
    await pushBranch(wtPath, batch.branch);
    const url = await this.createOrUpdate(repo, batch.branch, batch.base_branch, mr, batch.mr_url);
    return { ok: true, mrUrl: url };
  }

  async retargetBatch(repo: Repo, batch: BatchRow, targetBranch: string): Promise<boolean> {
    if (!batch.mr_url) return false;
    const iid = iidOf(batch.mr_url);
    if (!iid) throw new Error(`could not read the merge request id from ${batch.mr_url}`);
    const viewed = await this.glab(repo.path, ['mr', 'view', iid, '--output', 'json']);
    if (viewed.code !== 0) throw new Error(`glab mr view !${iid} failed (exit ${viewed.code}): ${viewed.stderr.trim() || viewed.stdout.trim()}`);
    let current: { target_branch?: string };
    try { current = JSON.parse(viewed.stdout) as { target_branch?: string }; } catch { throw new Error(`glab mr view !${iid} returned no JSON: ${viewed.stdout.trim().slice(0, 200)}`); }
    if (!current.target_branch) throw new Error(`glab mr view !${iid} did not return its target branch`);
    if (current.target_branch === targetBranch) return false;
    await this.update(repo, iid, undefined, undefined, batch.mr_url, targetBranch);
    return true;
  }

  // Re-requesting review after a rejection must update the MR GitLab already has for the branch: a second `mr create` fails with 409.
  // The description travels through a file: it is markdown with pipes and backticks and can exceed the Windows command line.
  private async createOrUpdate(repo: Repo, branch: string, targetBranch: string, mr: { title: string; description: string }, knownUrl: string | null): Promise<string | undefined> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mr-')), 'description.md');
    fs.writeFileSync(file, mr.description);
    try {
      let existing = knownUrl ? { iid: iidOf(knownUrl), url: knownUrl } : await this.openMr(repo, branch, targetBranch);
      // GitLab can retarget a stacked MR when its parent's source branch is deleted after merge.
      if (!existing && !knownUrl && targetBranch !== repo.base_branch) existing = await this.openMr(repo, branch);
      if (existing?.iid) return await this.update(repo, existing.iid, mr.title, file, existing.url, targetBranch);
      const r = await this.glab(repo.path, ['mr', 'create', '--source-branch', branch, '--target-branch', targetBranch, '--title', mr.title, '--description-file', file, '--yes']);
      if (r.code === 0) return r.stdout.match(/https?:\/\/\S+/)?.[0];
      const message = r.stderr.trim() || r.stdout.trim();
      const conflict = /already exists[^!]*!(\d+)/.exec(message);
      if (conflict?.[1]) return await this.update(repo, conflict[1], mr.title, file, undefined, targetBranch);
      throw new Error(`glab mr create failed (exit ${r.code}): ${message}`);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }

  private async openMr(repo: Repo, branch: string, targetBranch?: string): Promise<{ iid: string; url?: string } | undefined> {
    const args = ['mr', 'list', '--source-branch', branch];
    if (targetBranch) args.push('--target-branch', targetBranch);
    args.push('--output', 'json');
    const r = await this.glab(repo.path, args);
    if (r.code !== 0) throw new Error(`glab mr list failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    let rows: { iid: number; state?: string; web_url?: string }[] = [];
    try { rows = JSON.parse(r.stdout || '[]'); } catch { throw new Error(`glab mr list returned no JSON: ${r.stdout.trim().slice(0, 200)}`); }
    const open = rows.find((m) => !m.state || m.state === 'opened');
    return open ? { iid: String(open.iid), url: open.web_url } : undefined;
  }

  private async update(repo: Repo, iid: string, title: string | undefined, file: string | undefined, url: string | undefined, targetBranch: string): Promise<string | undefined> {
    const args = ['mr', 'update', iid];
    if (title !== undefined) args.push('--title', title);
    if (file !== undefined) args.push('--description-file', file);
    args.push('--target-branch', targetBranch, '--yes');
    const r = await this.glab(repo.path, args);
    if (r.code !== 0) throw new Error(`glab mr update !${iid} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return url ?? r.stdout.match(/https?:\/\/\S+/)?.[0];
  }
}

function iidOf(url: string): string | undefined {
  return /\/merge_requests\/(\d+)/.exec(url)?.[1];
}

export function providerFor(repo: Repo, config: Config): GitProvider {
  return repo.merge_mode === 'gitlab-mr'
    ? new GitlabMrProvider((cwd, args) => runCapture(config.glabBin, args, { cwd }))
    : new LocalMergeProvider(config.worktreesDir);
}
