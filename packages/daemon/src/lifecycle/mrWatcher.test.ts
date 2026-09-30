import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchRow, Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { MemoryTaskStore } from '../beads/memory';
import { Bus } from '../bus';
import { loadConfig } from '../config';
import { LocalMergeProvider } from '../git/provider';
import { Lifecycle, batchWorktreePath } from './lifecycle';
import { mkTmpRepo, commitFileAsync, shAsync } from '../test/tmpgit';
import { SessionManager } from '../sessions/manager';
import { log } from '../util/log';
import { GitlabMrWatcher, GITLAB_MR_POLL_INTERVAL_MS, parseGitlabMrResponse, startGitlabMrWatcher } from './mrWatcher';

const SHA = 'a'.repeat(40);
const MR_URL = 'https://gitlab.example.com/group/nested/project/-/merge_requests/41';
const MR_ENDPOINT = 'projects/group%2Fnested%2Fproject/merge_requests/41';
const TS = '2026-09-24T00:00:00.000Z';

async function environment(dbFile = ':memory:') {
  const tmp = mkTmpRepo('ov-mr-watcher-');
  const db = openDb(dbFile);
  const repo: Repo = {
    id: 'r1', path: tmp.path, base_branch: 'main', verify_command: null, setup_command: null,
    merge_mode: 'gitlab-mr', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null,
  };
  db.repos.insert(repo);
  return { ...tmp, db, repo, dbFile };
}

async function addBatch(env: Awaited<ReturnType<typeof environment>>, id = 'r1-b1', mrUrl: string | null = MR_URL): Promise<{ batch: BatchRow; sha: string }> {
  const branch = `feature/${id}`;
  await shAsync(env.path, ['switch', '-q', '-c', branch]);
  const sha = await commitFileAsync(env.path, `${id}.txt`, `${id}\n`, `add ${id}`);
  const batch: BatchRow = {
    id, origin_chat_id: null, repo_id: env.repo.id, title: id, branch, base_branch: 'main', status: 'review', note: null, history: null,
    mr_url: mrUrl, conflict_files: null, created_at: TS, updated_at: TS, merged_at: null, merged_commit: null, setup_at: null,
    waiting_on: null, overlap_files: null,
  };
  env.db.batches.insert(batch);
  return { batch, sha };
}

function opened(sha = SHA): string { return JSON.stringify({ state: 'opened', sha }); }
function openedPipeline(id: number, status: string, sha = SHA): string {
  return JSON.stringify({
    state: 'opened',
    head_pipeline: { id, status, sha, web_url: `https://gitlab.example.com/group/nested/project/-/pipelines/${id}` },
  });
}
function merged(sha: string): string { return JSON.stringify({ state: 'merged', sha }); }

describe('GitlabMrWatcher', () => {
  it('makes no API call without an eligible GitLab review MR', async () => {
    const env = await environment();
    const fetchMr = vi.fn(async () => opened());
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr, mergeBatch: async () => undefined, notify: async () => undefined });

    await watcher.tick();
    const { batch } = await addBatch(env);
    env.db.batches.update(batch.id, { status: 'open' });
    await watcher.tick();
    env.db.batches.update(batch.id, { status: 'review', mr_url: null });
    await watcher.tick();
    env.db.batches.update(batch.id, { mr_url: '' });
    await watcher.tick();
    env.db.batches.update(batch.id, { mr_url: MR_URL });
    env.db.repos.update('r1', { merge_mode: 'local-merge' });

    await watcher.tick();

    expect(fetchMr).not.toHaveBeenCalled();
    env.db.sql.close();
  });

  it('does nothing for an opened MR', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchMr = vi.fn(async () => opened());
    const mergeBatch = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);

    await new GitlabMrWatcher({ db: env.db, fetchMr, mergeBatch, notify }).tick();

    expect({ fetch: fetchMr.mock.calls, merges: mergeBatch.mock.calls, notices: notify.mock.calls }).toEqual({
      fetch: [[env.path, MR_ENDPOINT]], merges: [], notices: [],
    });
    env.db.sql.close();
  });

  it.each(['created', 'pending', 'running', 'waiting_for_resource', 'preparing', 'scheduled'])(
    'does not inspect jobs or notify for a %s pipeline', async (status) => {
      const env = await environment();
      await addBatch(env);
      const fetchPipelineJobs = vi.fn(async () => '[]');
      const notify = vi.fn(async () => undefined);

      await new GitlabMrWatcher({
        db: env.db, fetchMr: async () => openedPipeline(150847, status), fetchPipelineJobs,
        mergeBatch: async () => undefined, notify,
      }).tick();

      expect({ jobs: fetchPipelineJobs.mock.calls, notices: notify.mock.calls }).toEqual({ jobs: [], notices: [] });
      env.db.sql.close();
    },
  );

  it('wakes with only required failed jobs and the local head comparison', async () => {
    const env = await environment();
    const { batch, sha } = await addBatch(env);
    const fetchPipelineJobs = vi.fn(async () => JSON.stringify([
      { id: 470178, name: 'test-frontend 6/6', status: 'failed', allow_failure: false, failure_reason: 'script_failure' },
      { id: 470179, name: 'optional-lint', status: 'failed', allow_failure: true, failure_reason: 'script_failure' },
      { id: 470163, name: 'merge-request-build', status: 'skipped', allow_failure: false, failure_reason: null },
    ]));
    const notify = vi.fn(async () => undefined);

    await new GitlabMrWatcher({
      db: env.db, fetchMr: async () => openedPipeline(150838, 'failed', sha), fetchPipelineJobs,
      mergeBatch: async () => undefined, notify,
    }).tick();

    expect({ jobs: fetchPipelineJobs.mock.calls, notices: notify.mock.calls }).toEqual({
      jobs: [[env.path, 'projects/group%2Fnested%2Fproject/pipelines/150838/jobs?per_page=100']],
      notices: [[
        `Batch ${batch.id} MR !41 pipeline 150838 failed: https://gitlab.example.com/group/nested/project/-/pipelines/150838. Pipeline SHA matches local batch head: yes. Failed jobs: test-frontend 6/6 (470178, script_failure).`,
        { wake: true, hint: 'Triage per rule 6: runner_system_failure means retry the job; script_failure with named tests justifies a fix bead.' },
      ]],
    });
    env.db.sql.close();
  });

  it('reports a failed pipeline once across ticks and a database-backed restart', async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mr-pipeline-db-')), 'watcher.db');
    const env = await environment(dbFile);
    const { batch, sha } = await addBatch(env);
    env.db.sql.close();
    const notifications: unknown[][] = [];
    const fetchPipelineJobs = vi.fn(async () => JSON.stringify([
      { id: 470178, name: 'test-frontend 6/6', status: 'failed', allow_failure: false, failure_reason: 'script_failure' },
    ]));
    const makeWatcher = (db: ReturnType<typeof openDb>) => new GitlabMrWatcher({
      db, fetchMr: async () => openedPipeline(150838, 'failed', sha), fetchPipelineJobs,
      mergeBatch: async () => undefined, notify: async (...args) => { notifications.push(args); },
    });

    const beforeRestart = openDb(env.dbFile);
    const firstWatcher = makeWatcher(beforeRestart);
    await firstWatcher.tick();
    await firstWatcher.tick();
    beforeRestart.sql.close();
    const afterRestart = openDb(env.dbFile);
    await makeWatcher(afterRestart).tick();

    expect({
      notices: notifications,
      jobs: fetchPipelineJobs.mock.calls.length,
      pipeline: [afterRestart.batches.get(batch.id)?.last_pipeline_id, afterRestart.batches.get(batch.id)?.last_pipeline_outcome],
    }).toEqual({
      notices: [[
        `Batch ${batch.id} MR !41 pipeline 150838 failed: https://gitlab.example.com/group/nested/project/-/pipelines/150838. Pipeline SHA matches local batch head: yes. Failed jobs: test-frontend 6/6 (470178, script_failure).`,
        { wake: true, hint: 'Triage per rule 6: runner_system_failure means retry the job; script_failure with named tests justifies a fix bead.' },
      ]],
      jobs: 1,
      pipeline: [150838, 'failed'],
    });
    afterRestart.sql.close();
  });

  it('reports a new failed pipeline id separately', async () => {
    const env = await environment();
    const { sha } = await addBatch(env);
    const fetchMr = vi.fn()
      .mockResolvedValueOnce(openedPipeline(150838, 'failed', sha))
      .mockResolvedValueOnce(openedPipeline(150839, 'failed', sha));
    const fetchPipelineJobs = vi.fn(async () => JSON.stringify([
      { id: 470178, name: 'test-frontend 6/6', status: 'failed', allow_failure: false, failure_reason: 'script_failure' },
    ]));
    const notify = vi.fn(async (_text: string, _opts?: { wake?: boolean; hint?: string }) => undefined);
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr, fetchPipelineJobs, mergeBatch: async () => undefined, notify });

    await watcher.tick();
    await watcher.tick();

    expect(notify.mock.calls.map(([text]) => text)).toEqual([
      expect.stringContaining('pipeline 150838 failed:'),
      expect.stringContaining('pipeline 150839 failed:'),
    ]);
    env.db.sql.close();
  });

  it('queues one warning line for a successful pipeline with an allowed failure', async () => {
    const env = await environment();
    await addBatch(env);
    const notify = vi.fn(async () => undefined);
    await new GitlabMrWatcher({
      db: env.db, fetchMr: async () => openedPipeline(150846, 'success'),
      fetchPipelineJobs: async () => JSON.stringify([
        { id: 470200, name: 'optional-lint', status: 'failed', allow_failure: true, failure_reason: 'script_failure' },
      ]),
      mergeBatch: async () => undefined, notify,
    }).tick();

    expect(notify.mock.calls).toEqual([['Batch r1-b1 pipeline 150846 passed with warnings: optional-lint', { wake: false }]]);
    env.db.sql.close();
  });

  it('does not notify for a successful pipeline without allowed failures', async () => {
    const env = await environment();
    await addBatch(env);
    const notify = vi.fn(async () => undefined);
    await new GitlabMrWatcher({
      db: env.db, fetchMr: async () => openedPipeline(150846, 'success'),
      fetchPipelineJobs: async () => '[]',
      mergeBatch: async () => undefined, notify,
    }).tick();

    expect(notify.mock.calls).toEqual([]);
    env.db.sql.close();
  });

  it('queues one quiet line for a canceled pipeline without reading jobs', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchPipelineJobs = vi.fn(async () => '[]');
    const notify = vi.fn(async () => undefined);
    await new GitlabMrWatcher({
      db: env.db, fetchMr: async () => openedPipeline(150850, 'canceled'), fetchPipelineJobs,
      mergeBatch: async () => undefined, notify,
    }).tick();

    expect({ jobs: fetchPipelineJobs.mock.calls, notices: notify.mock.calls }).toEqual({
      jobs: [], notices: [[`Batch r1-b1 MR !41 pipeline 150850 was canceled: https://gitlab.example.com/group/nested/project/-/pipelines/150850.`, { wake: false }]],
    });
    env.db.sql.close();
  });

  it('does nothing when an opened MR has no head pipeline', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchPipelineJobs = vi.fn(async () => '[]');
    const notify = vi.fn(async () => undefined);
    await new GitlabMrWatcher({ db: env.db, fetchMr: async () => opened(), fetchPipelineJobs, mergeBatch: async () => undefined, notify }).tick();

    expect({ jobs: fetchPipelineJobs.mock.calls, notices: notify.mock.calls }).toEqual({ jobs: [], notices: [] });
    env.db.sql.close();
  });

  it('ignores a head pipeline with a zero id', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchPipelineJobs = vi.fn(async () => '[]');
    const notify = vi.fn(async () => undefined);
    await new GitlabMrWatcher({
      db: env.db, fetchMr: async () => openedPipeline(0, 'failed'), fetchPipelineJobs,
      mergeBatch: async () => undefined, notify,
    }).tick();

    expect({ jobs: fetchPipelineJobs.mock.calls, notices: notify.mock.calls }).toEqual({ jobs: [], notices: [] });
    env.db.sql.close();
  });

  it('retries a failed jobs call next tick without a notice on the failed tick', async () => {
    const env = await environment();
    const { sha } = await addBatch(env);
    const fetchMr = vi.fn()
      .mockRejectedValueOnce(new Error('MR unavailable'))
      .mockResolvedValue(openedPipeline(150838, 'failed', sha));
    const fetchPipelineJobs = vi.fn()
      .mockRejectedValueOnce(new Error('VPN unavailable'))
      .mockResolvedValueOnce(JSON.stringify([
        { id: 470178, name: 'test-frontend 6/6', status: 'failed', allow_failure: false, failure_reason: 'script_failure' },
      ]));
    const notify = vi.fn(async (_text: string, _opts?: { wake?: boolean; hint?: string }) => undefined);
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr, fetchPipelineJobs, mergeBatch: async () => undefined, notify });

    await watcher.tick();
    const noticesBeforeJobsRetry = notify.mock.calls.length;
    await watcher.tick();
    const noticesAfterJobsFailure = notify.mock.calls.length;
    await watcher.tick();

    expect({ noticesBeforeJobsRetry, noticesAfterJobsFailure, jobs: fetchPipelineJobs.mock.calls.length, notices: notify.mock.calls.map(([text]) => text) }).toEqual({
      noticesBeforeJobsRetry: 1,
      noticesAfterJobsFailure: 1,
      jobs: 2,
      notices: [
        'GitLab MR polling failed: "MR unavailable"',
        expect.stringContaining('pipeline 150838 failed:'),
        'GitLab MR polling recovered.',
      ],
    });
    env.db.sql.close();
  });

  it('keeps polling failure and recovery notices for other batches when jobs reads fail', async () => {
    const env = await environment();
    await addBatch(env, 'r1-b1');
    await addBatch(env, 'r1-b2', 'https://gitlab.example.com/group/nested/project/-/merge_requests/42');
    const fetchMr = vi.fn(async (_repoPath: string, endpoint: string) => {
      if (endpoint === MR_ENDPOINT) return openedPipeline(150839, 'failed');
      if (fetchMr.mock.calls.filter(([, seen]) => seen === endpoint).length === 1) throw new Error('MR unavailable');
      return opened();
    });
    const fetchPipelineJobs = vi.fn(async () => { throw new Error('jobs unavailable'); });
    const notify = vi.fn(async () => undefined);
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr, fetchPipelineJobs, mergeBatch: async () => undefined, notify });

    await watcher.tick();
    await watcher.tick();

    expect(notify.mock.calls).toEqual([
      ['GitLab MR polling failed: "MR unavailable"', { wake: false }],
      ['GitLab MR polling recovered.', { wake: false }],
    ]);
    env.db.sql.close();
  });

  it('retries a batch jobs read when another batch keeps polling', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchPipelineJobs = vi.fn(async () => { throw new Error('jobs unavailable'); });
    const watcher = new GitlabMrWatcher({
      db: env.db, fetchMr: async () => openedPipeline(150840, 'failed'), fetchPipelineJobs,
      mergeBatch: async () => undefined, notify: async () => undefined,
    });

    await watcher.tick();
    await watcher.tick();

    expect(fetchPipelineJobs).toHaveBeenCalledTimes(2);
    env.db.sql.close();
  });

  it('reports recovery after every MR and pipeline jobs read succeeds', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchMr = vi.fn()
      .mockRejectedValueOnce(new Error('MR unavailable'))
      .mockResolvedValue(openedPipeline(150841, 'success'));
    const fetchPipelineJobs = vi.fn(async () => '[]');
    const notify = vi.fn(async () => undefined);
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr, fetchPipelineJobs, mergeBatch: async () => undefined, notify });

    await watcher.tick();
    await watcher.tick();

    expect({ jobs: fetchPipelineJobs.mock.calls.length, notices: notify.mock.calls }).toEqual({
      jobs: 1,
      notices: [
        ['GitLab MR polling failed: "MR unavailable"', { wake: false }],
        ['GitLab MR polling recovered.', { wake: false }],
      ],
    });
    env.db.sql.close();
  });

  it('records an equal-head merge as gitlab and sends one quiet line', async () => {
    const env = await environment();
    const { batch, sha } = await addBatch(env);
    const mergeBatch = vi.fn(async (id: string, _actor: 'gitlab') => { env.db.batches.update(id, { status: 'merged' }); });
    const notify = vi.fn(async () => undefined);

    await new GitlabMrWatcher({ db: env.db, fetchMr: async () => merged(sha), mergeBatch, notify }).tick();

    expect({
      status: env.db.batches.get(batch.id)?.status,
      mergeCalls: mergeBatch.mock.calls,
      notices: notify.mock.calls,
    }).toEqual({
      status: 'merged',
      mergeCalls: [[batch.id, 'gitlab']],
      notices: [[`Batch ${batch.id} merged on GitLab (!41); recorded.`, { wake: false }]],
    });
    env.db.sql.close();
  });

  it('emits one merged milestone when a GitLab MR is polled as merged', async () => {
    const env = await environment();
    const { batch, sha } = await addBatch(env);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mr-lifecycle-'));
    const config = {
      ...loadConfig({}),
      dataDir,
      worktreesDir: path.join(dataDir, 'worktrees'),
      sessionsDir: path.join(dataDir, 'sessions'),
      orchestratorDir: path.join(dataDir, 'orchestrator'),
    };
    const bus = new Bus();
    const lifecycle = new Lifecycle({
      db: env.db,
      store: new MemoryTaskStore(),
      sessions: new SessionManager(env.db, {}, bus, config.sessionsDir),
      bus,
      config,
      provider: () => new LocalMergeProvider(),
      notify: async () => undefined,
      refreshRetryMs: 0,
    });
    const worktree = batchWorktreePath(config.worktreesDir, env.repo.id, batch.id);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await shAsync(env.path, ['switch', '-q', 'main']);
    await shAsync(env.path, ['worktree', 'add', '-q', worktree, batch.branch]);
    const milestones: unknown[] = [];
    bus.on('office_milestone', (milestone) => milestones.push(milestone));
    const fetchMr = vi.fn(async () => merged(sha));
    const watcher = new GitlabMrWatcher({
      db: env.db,
      fetchMr,
      mergeBatch: async (id, actor) => { await lifecycle.mergeBatch(id, actor); },
      notify: async () => undefined,
    });

    await watcher.tick();
    await watcher.tick();

    expect({ status: env.db.batches.get(batch.id)?.status, fetches: fetchMr.mock.calls.length, milestones }).toEqual({
      status: 'merged',
      fetches: 1,
      milestones: [{ kind: 'merged', repo_id: 'r1', batch_id: batch.id, bead_id: null, at: expect.any(String) }],
    });
    env.db.sql.close();
  });

  it('records a merge when the local head is an ancestor of the MR head', async () => {
    const env = await environment();
    const { batch, sha: localHead } = await addBatch(env);
    await shAsync(env.path, ['switch', '-q', '-c', 'feature/remote', batch.branch]);
    const mrHead = await commitFileAsync(env.path, 'remote.txt', 'remote\n', 'remote commit');
    await shAsync(env.path, ['switch', '-q', batch.branch]);
    const mergeBatch = vi.fn(async (id: string, _actor: 'gitlab') => { env.db.batches.update(id, { status: 'merged' }); });

    await new GitlabMrWatcher({ db: env.db, fetchMr: async () => merged(mrHead), mergeBatch, notify: async () => undefined }).tick();

    expect({ isAncestor: localHead !== mrHead, status: env.db.batches.get(batch.id)?.status, actor: mergeBatch.mock.calls[0]?.[1] }).toEqual({
      isAncestor: true, status: 'merged', actor: 'gitlab',
    });
    env.db.sql.close();
  });

  it('leaves unpushed commits unrecorded and wakes once across ticks and a restart', async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mr-watch-db-')), 'watcher.db');
    const env = await environment(dbFile);
    const { batch, sha: mrHead } = await addBatch(env);
    const localHead = await commitFileAsync(env.path, 'unpushed.txt', 'local\n', 'local-only commit');
    const mergeBatch = vi.fn(async () => undefined);
    const notices: unknown[][] = [];
    const fetchMr = async () => merged(mrHead);
    const makeWatcher = (db: ReturnType<typeof openDb>) => new GitlabMrWatcher({
      db, fetchMr, mergeBatch, notify: async (...args) => { notices.push(args); },
    });

    env.db.sql.close();
    const beforeRestart = openDb(env.dbFile);
    const firstWatcher = makeWatcher(beforeRestart);
    await firstWatcher.tick();
    await firstWatcher.tick();
    beforeRestart.sql.close();
    const afterRestart = openDb(env.dbFile);
    await makeWatcher(afterRestart).tick();

    expect({
      status: afterRestart.batches.get(batch.id)?.status,
      state: afterRestart.gitlabMrStates.get(MR_URL),
      localHeadDiffers: localHead !== mrHead,
      mergeCalls: mergeBatch.mock.calls,
      notices,
    }).toEqual({
      status: 'review',
      state: 'merged',
      localHeadDiffers: true,
      mergeCalls: [],
      notices: [[
        `Batch ${batch.id} has 1 unpushed commit after MR !41 merged on GitLab.`,
        { wake: true, hint: 'Ask the user how to handle the unpushed commits before recording this merge.' },
      ]],
    });
    afterRestart.sql.close();
  });

  it('notifies once when the merge path refuses across ticks and a restart', async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mr-watch-db-')), 'watcher.db');
    const env = await environment(dbFile);
    const { batch, sha } = await addBatch(env);
    env.db.sql.close();
    const mergeBatch = vi.fn(async () => { throw new Error(`batch ${batch.id} is waiting on r1-parent`); });
    const notices: unknown[][] = [];
    const makeWatcher = (db: ReturnType<typeof openDb>) => new GitlabMrWatcher({
      db, fetchMr: async () => merged(sha), mergeBatch,
      notify: async (...args) => { notices.push(args); },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const beforeRestart = openDb(env.dbFile);
    const firstWatcher = makeWatcher(beforeRestart);
    await firstWatcher.tick();
    await firstWatcher.tick();
    beforeRestart.sql.close();
    const afterRestart = openDb(env.dbFile);
    await makeWatcher(afterRestart).tick();

    expect({
      status: afterRestart.batches.get(batch.id)?.status,
      state: afterRestart.gitlabMrStates.get(MR_URL),
      attempts: mergeBatch.mock.calls.length,
      warningLines: warn.mock.calls.length,
      notices,
    }).toEqual({
      status: 'review',
      state: 'merged',
      attempts: 3,
      warningLines: 1,
      notices: [[
        `Batch ${batch.id} merge processing for MR !41 failed after GitLab merged it: batch ${batch.id} is waiting on r1-parent.`,
        { wake: true, hint: 'Tell the user that GitLab merged the MR; inspect the batch state and resolve this merge-path failure.' },
      ]],
    });
    afterRestart.sql.close();
    warn.mockRestore();
  });

  it('notifies once for a close across repeated ticks and a database-backed restart', async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mr-watch-db-')), 'watcher.db');
    const env = await environment(dbFile);
    const { batch } = await addBatch(env);
    env.db.sql.close();
    const notifications: unknown[][] = [];
    const fetchMr = async () => JSON.stringify({ iid: 41, state: 'closed', closed_at: TS });
    const makeWatcher = (db: ReturnType<typeof openDb>) => new GitlabMrWatcher({
      db, fetchMr, mergeBatch: async () => undefined, notify: async (...args) => { notifications.push(args); },
    });

    const beforeRestart = openDb(env.dbFile);
    const firstWatcher = makeWatcher(beforeRestart);
    await firstWatcher.tick();
    await firstWatcher.tick();
    beforeRestart.sql.close();
    const afterRestart = openDb(env.dbFile);
    await makeWatcher(afterRestart).tick();

    expect({
      state: afterRestart.gitlabMrStates.get(MR_URL),
      notices: notifications,
      batch: afterRestart.batches.get(batch.id)?.status,
    }).toEqual({
      state: 'closed',
      notices: [[`Batch ${batch.id} MR !41 was closed on GitLab.`, { wake: true, hint: 'Ask the user whether to abandon the batch.' }]],
      batch: 'review',
    });
    afterRestart.sql.close();
  });

  it('reports the first GitLab failure once across three ticks and reports recovery', async () => {
    const env = await environment();
    await addBatch(env);
    const fetchMr = vi.fn(async (): Promise<string> => { throw new Error('VPN down'); });
    const notify = vi.fn(async () => undefined);
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr, mergeBatch: async () => undefined, notify });

    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    fetchMr.mockResolvedValue(opened());
    await watcher.tick();

    expect(notify.mock.calls).toEqual([
      ['GitLab MR polling failed: "VPN down"', { wake: false }],
      ['GitLab MR polling recovered.', { wake: false }],
    ]);
    env.db.sql.close();
  });

  it('takes no action on malformed JSON', async () => {
    const env = await environment();
    const { batch } = await addBatch(env);
    const mergeBatch = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);

    expect(parseGitlabMrResponse('{bad json')).toBeNull();
    await new GitlabMrWatcher({ db: env.db, fetchMr: async () => '{bad json', mergeBatch, notify }).tick();

    expect({ status: env.db.batches.get(batch.id)?.status, mergeCalls: mergeBatch.mock.calls, notices: notify.mock.calls, state: env.db.gitlabMrStates.get(MR_URL) }).toEqual({
      status: 'review', mergeCalls: [], notices: [], state: undefined,
    });
    env.db.sql.close();
  });

  it('makes one call and handles each of two eligible batches', async () => {
    const env = await environment();
    const first = await addBatch(env, 'r1-b1', 'https://gitlab.example.com/group/nested/project/-/merge_requests/41');
    const second = await addBatch(env, 'r1-b2', 'https://gitlab.example.com/group/nested/project/-/merge_requests/42');
    const heads = new Map([[MR_ENDPOINT, first.sha], ['projects/group%2Fnested%2Fproject/merge_requests/42', second.sha]]);
    const fetchMr = vi.fn(async (_repoPath: string, endpoint: string) => merged(heads.get(endpoint)!));
    const mergeBatch = vi.fn(async (id: string, _actor: 'gitlab') => { env.db.batches.update(id, { status: 'merged' }); });

    await new GitlabMrWatcher({ db: env.db, fetchMr, mergeBatch, notify: async () => undefined }).tick();

    expect({
      endpoints: fetchMr.mock.calls.map(([, endpoint]) => endpoint).sort(),
      merged: [env.db.batches.get(first.batch.id)?.status, env.db.batches.get(second.batch.id)?.status],
      mergeCalls: mergeBatch.mock.calls,
    }).toEqual({
      endpoints: [MR_ENDPOINT, 'projects/group%2Fnested%2Fproject/merge_requests/42'].sort(),
      merged: ['merged', 'merged'],
      mergeCalls: [[first.batch.id, 'gitlab'], [second.batch.id, 'gitlab']],
    });
    env.db.sql.close();
  });

  it('uses an injectable interval and skips timer ticks while a request is still in flight', async () => {
    vi.useFakeTimers();
    const env = await environment();
    await addBatch(env);
    let release!: (raw: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const fetchMr = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(opened());
    const stop = startGitlabMrWatcher({ db: env.db, fetchMr, mergeBatch: async () => undefined, notify: async () => undefined }, 25);
    try {
      await vi.advanceTimersByTimeAsync(75);
      expect(fetchMr).toHaveBeenCalledTimes(1);
      release(opened());
      await vi.advanceTimersByTimeAsync(25);
      expect(fetchMr).toHaveBeenCalledTimes(2);
      expect(GITLAB_MR_POLL_INTERVAL_MS).toBe(120_000);
    } finally {
      stop();
      vi.useRealTimers();
      env.db.sql.close();
    }
  });
  it('fetches an MR head that exists only on origin, then records the ancestor merge', async () => {
    const env = await environment();
    const { batch } = await addBatch(env);
    const origin = path.join(env.root, 'origin');
    await shAsync(env.root, ['clone', '-q', env.path, origin]);
    await shAsync(origin, ['switch', '-q', batch.branch]);
    const mrHead = await commitFileAsync(origin, 'suggestion.txt', 'applied on GitLab\n','apply suggestion');
    await shAsync(origin, ['update-ref', 'refs/merge-requests/41/head', mrHead]);
    await shAsync(env.path, ['remote', 'add', 'origin', origin]);
    const missingBefore = await shAsync(env.path, ['cat-file', '-e', `${mrHead}^{commit}`]).then(() => false, () => true);
    const mergeBatch = vi.fn(async (id: string, _actor: 'gitlab') => { env.db.batches.update(id, { status: 'merged' }); });
    const notify = vi.fn(async () => undefined);

    await new GitlabMrWatcher({ db: env.db, fetchMr: async () => merged(mrHead), mergeBatch, notify }).tick();

    expect({ missingBefore, status: env.db.batches.get(batch.id)?.status, notices: notify.mock.calls }).toEqual({
      missingBefore: true, status: 'merged', notices: [[`Batch ${batch.id} merged on GitLab (!41); recorded.`, { wake: false }]],
    });
    env.db.sql.close();
  });

  it('wakes once and records nothing when the MR head is still unknown after the fetch', async () => {
    const env = await environment();
    const { batch } = await addBatch(env);
    const unknown = 'b'.repeat(40);
    const mergeBatch = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const watcher = new GitlabMrWatcher({ db: env.db, fetchMr: async () => merged(unknown), mergeBatch, notify });

    await watcher.tick();
    await watcher.tick();

    expect({ status: env.db.batches.get(batch.id)?.status, merges: mergeBatch.mock.calls.length, notices: notify.mock.calls }).toEqual({
      status: 'review', merges: 0, notices: [[
        `Batch ${batch.id} MR !41 merged on GitLab at ${unknown}, which is not available locally; not recorded.`,
        { wake: true, hint: 'Ask the user to check the remote and record the merge with Mark merged once the branch matches.' },
      ]],
    });
    env.db.sql.close();
  });

  it.each([
    ['another action is running', (id: string) => `batch ${id} is being merged`],
    ['the batch left review', (id: string) => `batch ${id} is not in review`],
  ])('skips silently when the merge path refuses because %s', async (_name, message) => {
    const env = await environment();
    const { batch, sha } = await addBatch(env);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const mergeBatch = vi.fn(async () => { throw new Error(message(batch.id)); });
    const notify = vi.fn(async () => undefined);

    await new GitlabMrWatcher({ db: env.db, fetchMr: async () => merged(sha), mergeBatch, notify }).tick();

    expect({ attempts: mergeBatch.mock.calls.length, notices: notify.mock.calls, warnings: warn.mock.calls.length }).toEqual({ attempts: 1, notices: [], warnings: 0 });
    warn.mockRestore();
    env.db.sql.close();
  });
});
