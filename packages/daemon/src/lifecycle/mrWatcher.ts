import type { BatchRow } from '@overseer/shared';
import { git, isAncestor } from '../git/git';
import type { Db, GitlabMrState } from '../db/db';
import { runCapture } from '../util/procs';
import { log } from '../util/log';

export const GITLAB_MR_POLL_INTERVAL_MS = 120_000;

export interface GitlabMrPipeline {
  id: number;
  status: string;
  sha: string;
  web_url: string;
}

interface GitlabPipelineJob {
  id: number;
  name: string;
  status: string;
  allow_failure: boolean;
  failure_reason: string | null;
}

export type GitlabMrResponse =
  | { state: 'merged'; sha: string }
  | { state: 'opened' | 'closed'; sha?: string; head_pipeline?: GitlabMrPipeline };

type ReportedPipelineOutcome = 'failed' | 'success' | 'canceled';

const PIPELINE_FAILURE_HINT = 'Triage per rule 6: runner_system_failure means retry the job; script_failure with named tests justifies a fix bead.';
const IN_PROGRESS_PIPELINE_STATUSES = new Set(['created', 'pending', 'running', 'waiting_for_resource', 'preparing', 'scheduled']);

export interface GitlabMrWatcherDeps {
  db: Db;
  mergeBatch(batchId: string, actor: 'gitlab'): Promise<unknown>;
  notify(text: string, opts?: { wake?: boolean; hint?: string }): Promise<void>;
  /** Replaces the read-only `glab api` call in tests. */
  fetchMr?(repoPath: string, endpoint: string): Promise<string>;
  /** Replaces the read-only pipeline jobs `glab api` call in tests. */
  fetchPipelineJobs?(repoPath: string, endpoint: string): Promise<string>;
}

interface MrLocation {
  iid: string;
  url: string;
  projectEndpoint: string;
  endpoint: string;
}

export function parseGitlabMrResponse(raw: string): GitlabMrResponse | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const mr = value as Record<string, unknown>;
    if (mr.state !== 'opened' && mr.state !== 'merged' && mr.state !== 'closed') return null;
    if (mr.state === 'merged') {
      if (typeof mr.sha !== 'string' || !/^[\da-f]{40}$/i.test(mr.sha)) return null;
      return { state: 'merged', sha: mr.sha.toLowerCase() };
    }
    const headPipeline = parseHeadPipeline(mr.head_pipeline);
    return { state: mr.state, ...(typeof mr.sha === 'string' ? { sha: mr.sha } : {}), ...(headPipeline ? { head_pipeline: headPipeline } : {}) };
  } catch {
    return null;
  }
}

function parseHeadPipeline(value: unknown): GitlabMrPipeline | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pipeline = value as Record<string, unknown>;
  const id = pipeline.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof pipeline.status !== 'string' || typeof pipeline.sha !== 'string' || !/^[\da-f]{40}$/i.test(pipeline.sha) || typeof pipeline.web_url !== 'string') return null;
  return { id, status: pipeline.status, sha: pipeline.sha.toLowerCase(), web_url: pipeline.web_url };
}

function parseGitlabPipelineJobs(raw: string): GitlabPipelineJob[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const jobs: GitlabPipelineJob[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const job = item as Record<string, unknown>;
      const id = job.id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof job.name !== 'string' || typeof job.status !== 'string' || typeof job.allow_failure !== 'boolean') return null;
      jobs.push({
        id, name: job.name, status: job.status, allow_failure: job.allow_failure,
        failure_reason: typeof job.failure_reason === 'string' ? job.failure_reason : null,
      });
    }
    return jobs;
  } catch {
    return null;
  }
}

function mrLocation(mrUrl: string): MrLocation | null {
  try {
    const url = new URL(mrUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const match = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const projectPath = decodeURIComponent(match[1]!);
    if (!projectPath) return null;
    const iid = match[2]!;
    const projectEndpoint = `projects/${encodeURIComponent(projectPath)}`;
    return { iid, url: mrUrl, projectEndpoint, endpoint: `${projectEndpoint}/merge_requests/${iid}` };
  } catch {
    return null;
  }
}

async function fetchGitlabMr(repoPath: string, endpoint: string): Promise<string> {
  const result = await runCapture('glab', ['api', endpoint], { cwd: repoPath });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `glab exited with code ${result.code}`);
  return result.stdout;
}

async function fetchGitlabPipelineJobs(repoPath: string, endpoint: string): Promise<string> {
  const result = await runCapture('glab', ['api', endpoint], { cwd: repoPath });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `glab exited with code ${result.code}`);
  return result.stdout;
}

const SKIPPED_REFUSAL = /^batch \S+ is (being (merged|abandoned|rejected)|not in review)$/;

async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  return git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
}

function firstErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/, 1)[0]!.trim() || 'unknown error';
}

export class GitlabMrWatcher {
  private running = false;
  private pollingError: string | null = null;

  constructor(private readonly deps: GitlabMrWatcherDeps) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = GITLAB_MR_POLL_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => log.warn('gitlab MR watcher: tick failed', error));
    }, intervalMs);
    return () => clearInterval(timer);
  }

  private async poll(): Promise<void> {
    const batches = this.deps.db.batches.all().filter((batch) => batch.status === 'review' && batch.mr_url !== null);
    let attempted = 0;
    let recoveryEligible = 0;
    let firstError: string | null = null;

    for (const batch of batches) {
      const repo = this.deps.db.repos.get(batch.repo_id);
      const location = batch.mr_url ? mrLocation(batch.mr_url) : null;
      if (!repo || repo.merge_mode !== 'gitlab-mr' || !location) continue;
      attempted += 1;

      let raw: string;
      try {
        raw = await (this.deps.fetchMr ?? fetchGitlabMr)(repo.path, location.endpoint);
      } catch (error) {
        firstError ??= firstErrorLine(error);
        continue;
      }
      recoveryEligible += 1;

      const mr = parseGitlabMrResponse(raw);
      if (!mr) {
        log.debug(`gitlab MR watcher: ignored an invalid response for ${batch.id} (${batch.mr_url})`);
        continue;
      }

      const changed = this.deps.db.gitlabMrStates.transition(location.url, mr.state);
      if (mr.state === 'closed') {
        if (changed) await this.notify(`Batch ${batch.id} MR !${location.iid} was closed on GitLab.`, { wake: true, hint: 'Ask the user whether to abandon the batch.' });
        continue;
      }
      if (mr.state === 'merged') {
        await this.recordMerged(batch, repo.path, location, mr.sha, changed);
        continue;
      }
      if (mr.head_pipeline && await this.reportPipeline(batch, repo.path, location, mr.head_pipeline)) recoveryEligible -= 1;
    }

    if (attempted === 0) return;
    if (firstError) {
      if (this.pollingError === null) {
        this.pollingError = firstError;
        await this.notify(`GitLab MR polling failed: ${JSON.stringify(firstError)}`, { wake: false });
      }
    } else if (this.pollingError !== null && recoveryEligible > 0) {
      this.pollingError = null;
      await this.notify('GitLab MR polling recovered.', { wake: false });
    }
  }

  private async reportPipeline(batch: BatchRow, repoPath: string, location: MrLocation, pipeline: GitlabMrPipeline): Promise<boolean> {
    const outcome = pipeline.status;
    if (IN_PROGRESS_PIPELINE_STATUSES.has(outcome)) return false;
    if (outcome !== 'failed' && outcome !== 'success' && outcome !== 'canceled') return false;
    if (batch.last_pipeline_id === pipeline.id && batch.last_pipeline_outcome === outcome) return false;

    if (outcome === 'canceled') {
      this.rememberPipeline(batch.id, pipeline.id, outcome);
      await this.notify(`Batch ${batch.id} MR !${location.iid} pipeline ${pipeline.id} was canceled: ${pipeline.web_url}.`, { wake: false });
      return false;
    }

    let jobs: GitlabPipelineJob[];
    try {
      const endpoint = `${location.projectEndpoint}/pipelines/${pipeline.id}/jobs?per_page=100`;
      const raw = await (this.deps.fetchPipelineJobs ?? fetchGitlabPipelineJobs)(repoPath, endpoint);
      const parsed = parseGitlabPipelineJobs(raw);
      if (!parsed) throw new Error('invalid pipeline jobs response');
      jobs = parsed;
    } catch (error) {
      log.warn(`gitlab MR watcher: could not read jobs for pipeline ${pipeline.id} on ${batch.id}`, error);
      return true;
    }

    this.rememberPipeline(batch.id, pipeline.id, outcome);
    if (outcome === 'failed') {
      const localHead = await git(repoPath, ['rev-parse', '--verify', `refs/heads/${batch.branch}`]).catch(() => null);
      const headMatches = localHead?.toLowerCase() === pipeline.sha;
      const failedJobs = jobs.filter((job) => job.status === 'failed' && !job.allow_failure);
      const jobText = failedJobs.map((job) => `${job.name} (${job.id}, ${job.failure_reason ?? 'unknown'})`).join('; ') || 'none returned';
      await this.notify(`Batch ${batch.id} MR !${location.iid} pipeline ${pipeline.id} failed: ${pipeline.web_url}. Pipeline SHA matches local batch head: ${headMatches ? 'yes' : 'no'}. Failed jobs: ${jobText}.`, {
        wake: true,
        hint: PIPELINE_FAILURE_HINT,
      });
      return false;
    }

    const warnings = jobs.filter((job) => job.status === 'failed' && job.allow_failure);
    if (warnings.length) {
      await this.notify(`Batch ${batch.id} pipeline ${pipeline.id} passed with warnings: ${warnings.map((job) => job.name).join(', ')}`, { wake: false });
    }
    return false;
  }

  private rememberPipeline(batchId: string, pipelineId: number, outcome: ReportedPipelineOutcome): void {
    this.deps.db.batches.update(batchId, { last_pipeline_id: pipelineId, last_pipeline_outcome: outcome });
  }

  private async recordMerged(batch: BatchRow, repoPath: string, location: MrLocation, sha: string, stateChanged: boolean): Promise<void> {
    try {
      const localHead = await git(repoPath, ['rev-parse', '--verify', `refs/heads/${batch.branch}`]);
      if (!await hasCommit(repoPath, sha)) {
        // A commit added on GitLab (an applied suggestion, a rebase) exists only on the remote until its MR head is fetched.
        await git(repoPath, ['fetch', '--quiet', 'origin', `refs/merge-requests/${location.iid}/head`]).catch(() => undefined);
        if (!await hasCommit(repoPath, sha)) {
          if (stateChanged) {
            await this.notify(`Batch ${batch.id} MR !${location.iid} merged on GitLab at ${sha}, which is not available locally; not recorded.`, {
              wake: true,
              hint: 'Ask the user to check the remote and record the merge with Mark merged once the branch matches.',
            });
          }
          return;
        }
      }
      if (localHead.toLowerCase() === sha || await isAncestor(repoPath, localHead, sha)) {
        try {
          await this.deps.mergeBatch(batch.id, 'gitlab');
        } catch (error) {
          // Another Merge, Reject or Abandon for this batch is running, or already moved it out of review: nothing to report.
          if (SKIPPED_REFUSAL.test(firstErrorLine(error))) return;
          throw error;
        }
        await this.notify(`Batch ${batch.id} merged on GitLab (!${location.iid}); recorded.`, { wake: false });
        return;
      }

      const unpushed = Number(await git(repoPath, ['rev-list', '--count', `${sha}..${localHead}`]));
      if (stateChanged && Number.isSafeInteger(unpushed) && unpushed > 0) {
        await this.notify(`Batch ${batch.id} has ${unpushed} unpushed commit${unpushed === 1 ? '' : 's'} after MR !${location.iid} merged on GitLab.`, {
          wake: true,
          hint: 'Ask the user how to handle the unpushed commits before recording this merge.',
        });
      }
    } catch (error) {
      if (stateChanged) {
        log.warn(`gitlab MR watcher: could not record merged MR !${location.iid} for ${batch.id}`, error);
        await this.notify(`Batch ${batch.id} merge processing for MR !${location.iid} failed after GitLab merged it: ${firstErrorLine(error)}.`, {
          wake: true,
          hint: 'Tell the user that GitLab merged the MR; inspect the batch state and resolve this merge-path failure.',
        });
      }
    }
  }

  private async notify(text: string, opts: { wake?: boolean; hint?: string }): Promise<void> {
    await this.deps.notify(text, opts).catch((error: unknown) => log.warn('gitlab MR watcher: notice failed', error));
  }
}

export function startGitlabMrWatcher(deps: GitlabMrWatcherDeps, intervalMs = GITLAB_MR_POLL_INTERVAL_MS): () => void {
  return new GitlabMrWatcher(deps).start(intervalMs);
}
