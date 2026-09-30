import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchRow, Program, Repo } from '@overseer/shared';
import type { AppDeps } from '../app';
import { Bus } from '../bus';
import { MemoryTaskStore } from '../beads/memory';
import { openDb } from '../db/db';
import { loadConfig } from '../config';
import { ActionJobs } from './jobs';
import { registerRest } from './rest';

interface ProgramApiFixture {
  app: FastifyInstance;
  dataDir: string;
  db: ReturnType<typeof openDb>;
  store: MemoryTaskStore;
}

async function setup(): Promise<ProgramApiFixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-program-api-'));
  const dbPath = path.join(dataDir, 'overseer.db');
  expect(path.resolve(dbPath)).not.toBe(path.resolve(loadConfig({}).dbPath));
  const db = openDb(dbPath);
  const bus = new Bus();
  const store = new MemoryTaskStore();
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: path.join(dataDir, 'worktrees') };
  const app = Fastify({ logger: false });
  registerRest(app, { db, config, bus, store, jobs: new ActionJobs(bus) } as unknown as AppDeps);
  await app.ready();
  return { app, dataDir, db, store };
}

const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url });

function repoRow(id: string, repoPath: string): Repo {
  return { id, path: repoPath, base_branch: 'main', verify_command: null, review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null };
}

function programRow(id: string, repoId: string, createdAt: string, status: Program['status'] = 'open'): Program {
  return { id, repo_id: repoId, title: `Program ${id}`, status, created_at: createdAt, origin_chat_id: null };
}

function batchRow(id: string, title: string, status: BatchRow['status'] = 'open'): BatchRow {
  const created_at = '2026-09-28T00:00:00.000Z';
  return { id, repo_id: 'r1', title, branch: `feature/${id}`, base_branch: 'main', status, note: null, history: null, mr_url: null, conflict_files: null, created_at, updated_at: created_at, merged_at: status === 'merged' ? created_at : null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null };
}

function setupWorktree(db: ReturnType<typeof openDb>, beadId: string, batchId: string, mergedAt: string | null, closedAt: string | null): void {
  db.worktrees.upsert({ bead_id: beadId, repo_id: 'r1', path: `C:/worktrees/${beadId}`, branch: `bead/${beadId}`, base_branch: `feature/${batchId}`, verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: mergedAt, mr_url: null, batch_id: batchId, closed_at: closedAt, review_round: null, review_findings: null, accepted_note: null });
}

describe('programs REST', () => {
  let x: ProgramApiFixture;

  beforeEach(async () => { x = await setup(); });
  afterEach(async () => {
    await x.app.close();
    x.db.sql.close();
    fs.rmSync(x.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('returns no rows when there are no programs and rejects an empty repo filter', async () => {
    expect((await get(x.app, '/api/programs')).json()).toEqual([]);
    expect((await get(x.app, '/api/programs?repo=r1')).json()).toEqual([]);
    const emptyRepo = await get(x.app, '/api/programs?repo=');
    expect(emptyRepo.statusCode).toBe(400);
  });

  it('returns a program with empty collections when it has no batches', async () => {
    x.db.programs.insert(programRow('p-empty', 'r1', '2026-09-28T00:00:00.000Z'));
    const listSpy = vi.spyOn(x.store, 'list');
    const response = await get(x.app, '/api/programs/p-empty');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'p-empty', batches: [], waits: [], entries: [], merge_order: [] });
    expect(listSpy).not.toHaveBeenCalled();
    const removed = await get(x.app, '/api/programs/removed');
    expect(removed.statusCode).toBe(404);
    expect(removed.json()).toEqual({ error: 'program removed not found' });
  });

  it('reads detail counts from the program repo when another repo cannot list beads', async () => {
    const repoPath = path.join(x.dataDir, 'program-repo');
    const otherRepoPath = path.join(x.dataDir, 'unrelated-repo');
    x.db.repos.insert(repoRow('r1', repoPath));
    x.db.repos.insert(repoRow('r2', otherRepoPath));
    x.db.programs.insert(programRow('p-scoped', 'r1', '2026-09-28T00:00:00.000Z'));
    const batch = batchRow('r1-b-scoped', 'Scoped batch');
    x.db.batches.insert(batch);
    x.db.programBatches.insert({ program_id: 'p-scoped', batch_id: batch.id, lane: 'main', position: 0 });
    x.store.add(repoPath, { id: 'ov-program-scoped', title: 'Program bead', labels: [`overseer:batch:${batch.id}`] });
    const originalList = x.store.list.bind(x.store);
    const list = vi.spyOn(x.store, 'list');
    list.mockImplementation(async (requestedPath) => {
      if (requestedPath === otherRepoPath) throw new Error('unrelated repo listing failed');
      return originalList(requestedPath);
    });

    const response = await get(x.app, '/api/programs/p-scoped');
    expect(response.statusCode).toBe(200);
    expect(response.json().batches).toEqual([
      { program_id: 'p-scoped', batch_id: batch.id, lane: 'main', position: 0, title: batch.title, status: 'open', beads_total: 1, beads_done: 0, beads_closed: 0 },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(repoPath);
  });

  it('lists programs newest first and filters by repo', async () => {
    x.db.programs.insert(programRow('p-old', 'r1', '2026-09-27T00:00:00.000Z'));
    x.db.programs.insert(programRow('p-new', 'r1', '2026-09-28T00:00:00.000Z', 'done'));
    x.db.programs.insert(programRow('p-other', 'r2', '2026-09-29T00:00:00.000Z'));
    expect((await get(x.app, '/api/programs')).json().map((p: Program) => p.id)).toEqual(['p-other', 'p-new', 'p-old']);
    expect((await get(x.app, '/api/programs?repo=r1')).json().map((p: Program) => p.id)).toEqual(['p-new', 'p-old']);
  });

  it('returns batch states and bead counts, waits, entries and merge order', async () => {
    const repoPath = path.join(x.dataDir, 'repo');
    x.db.repos.insert(repoRow('r1', repoPath));
    x.db.programs.insert({ ...programRow('p365', 'r1', '2026-09-28T00:00:00.000Z'), title: 'Stories 365 and 366', origin_chat_id: 19 });
    const first = batchRow('r1-b365', '#365 shared model');
    const second = batchRow('r1-b366', '#366 REST routes', 'merged');
    x.db.batches.insert(first);
    x.db.batches.insert(second);
    x.db.programBatches.insert({ program_id: 'p365', batch_id: first.id, lane: '#365 → #366', position: 0 });
    x.db.programBatches.insert({ program_id: 'p365', batch_id: second.id, lane: '#365 → #366', position: 1 });
    x.db.batchWaits.insert({ batch_id: second.id, prerequisite_batch_id: first.id });
    x.db.programEntries.insert({ program_id: 'p365', kind: 'decision', text: 'Keep this phrase verbatim.', created_at: '2026-09-28T00:01:00.000Z', source_chat_id: 19 });
    x.db.programEntries.insert({ program_id: 'p365', kind: 'ownership', text: 'Batch #365 owns the shared type.', created_at: '2026-09-28T00:02:00.000Z', source_chat_id: null });
    x.db.programEntries.insert({ program_id: 'p365', kind: 'note', text: 'Review the shared export after both batches land.', created_at: '2026-09-28T00:03:00.000Z', source_chat_id: null });
    x.db.mergeOrder.set('p365', [first.id, second.id]);

    x.store.add(repoPath, { id: 'ov-open', title: 'Open bead', labels: ['overseer:batch:r1-b365'] });
    x.store.add(repoPath, { id: 'ov-closed', title: 'Closed bead', status: 'closed', labels: ['overseer:batch:r1-b365', 'overseer:closed'] });
    x.store.add(repoPath, { id: 'ov-landed', title: 'Landed bead', status: 'closed', labels: ['overseer:batch:r1-b366', 'overseer:merged'] });
    setupWorktree(x.db, 'ov-closed', first.id, null, '2026-09-28T00:04:00.000Z');
    setupWorktree(x.db, 'ov-landed', second.id, '2026-09-28T00:05:00.000Z', null);

    const response = await get(x.app, '/api/programs/p365');
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail).toMatchObject({ id: 'p365', title: 'Stories 365 and 366', origin_chat_id: 19 });
    expect(detail.batches).toEqual([
      { program_id: 'p365', batch_id: first.id, lane: '#365 → #366', position: 0, title: first.title, status: 'open', beads_total: 2, beads_done: 0, beads_closed: 1 },
      { program_id: 'p365', batch_id: second.id, lane: '#365 → #366', position: 1, title: second.title, status: 'merged', beads_total: 1, beads_done: 1, beads_closed: 0 },
    ]);
    expect(detail.waits).toEqual([{ batch_id: second.id, prerequisite_batch_id: first.id, released: false }]);
    expect(detail.entries).toEqual([
      { program_id: 'p365', kind: 'decision', text: 'Keep this phrase verbatim.', created_at: '2026-09-28T00:01:00.000Z', source_chat_id: 19 },
      { program_id: 'p365', kind: 'ownership', text: 'Batch #365 owns the shared type.', created_at: '2026-09-28T00:02:00.000Z', source_chat_id: null },
      { program_id: 'p365', kind: 'note', text: 'Review the shared export after both batches land.', created_at: '2026-09-28T00:03:00.000Z', source_chat_id: null },
    ]);
    expect(detail.merge_order).toEqual([first.id, second.id]);

    x.db.batches.update(first.id, { status: 'merged' });
    x.db.batchWaits.releaseForPrerequisite(first.id);
    const afterPrerequisiteMerge = await get(x.app, '/api/programs/p365');
    expect(afterPrerequisiteMerge.json().waits).toEqual([{ batch_id: second.id, prerequisite_batch_id: first.id, released: true }]);
  });
});
