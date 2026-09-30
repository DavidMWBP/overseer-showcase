import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { MemoryTaskStore } from '../beads/memory';
import { Beads, type BdRunner } from '../beads/beads';
import { NO_VERIFY_RUN } from '../lifecycle/verify';
import { log } from '../util/log';
import { buildBoard, coalesced, slowBuildWarnings, SlowBuildWarner } from './board';

class SlowMemoryTaskStore extends MemoryTaskStore {
  async list(repoPath: string) {
    await new Promise((r) => setTimeout(r, 50));
    return super.list(repoPath);
  }
}

/** A repo build past the slow threshold, so the warning path runs without a real bd. */
class VerySlowMemoryTaskStore extends MemoryTaskStore {
  async list(repoPath: string) {
    await new Promise((r) => setTimeout(r, 1050));
    return super.list(repoPath);
  }
}

const repoRow = (id: string): Repo => ({ id, path: `/${id}`, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null });

describe('buildBoard', () => {
  it('derives columns, harness, branch, cost and elapsed', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    const repo: Repo = { id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2, model_filter: null};
    db.repos.insert(repo);
    store.add('/r1', { id: 'ov-1', title: 'Ready one' });
    store.add('/r1', { id: 'ov-2', title: 'Blocked one' }, ['ov-1']);
    store.add('/r1', { id: 'ov-3', title: 'Running one', status: 'in_progress', labels: ['harness:opencode'] });
    store.add('/r1', { id: 'ov-4', title: 'In review', status: 'in_progress', labels: ['overseer:review'] });
    store.add('/r1', { id: 'ov-5', title: 'Done', status: 'closed', labels: ['overseer:merged'] });
    store.add('/r1', { id: 'ov-6', title: 'Abandoned', status: 'closed', labels: ['overseer:abandoned'] });
    const started = new Date(Date.now() - 60_000).toISOString();
    db.accounts.insert({ id: 'acct-work', name: 'Work account', label: 'Work', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: started, last_login_at: started, last_verified_at: null });
    db.sessions.insert({ id: 's3', harness: 'opencode', role: 'worker', bead_id: 'ov-3', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, account: 'acct-work', status: 'running', started_at: started, ended_at: null, cost: 0.4 });
    // ov-3 was re-dispatched after a failed verification: while it runs the card carries no failure (round 9: the rail badge kept counting it).
    db.worktrees.upsert({ bead_id: 'ov-3', repo_id: 'r1', path: '/wt', branch: 'bead/ov-3', base_branch: 'main', verify_status: 'fail', verify_output: '$ pnpm test\nexit 1', review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: 'r1-b1', closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    db.worktrees.upsert({ bead_id: 'ov-4', repo_id: 'r1', path: '/wt4', branch: 'bead/ov-4', base_branch: 'main', verify_status: 'fail', verify_output: `$ pnpm test\n${'x'.repeat(1000)}\nexit 1`, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    // ov-5 landed in a repo with no verify command: the run is recorded with no output, so the pane shows the heading alone.
    db.worktrees.upsert({ bead_id: 'ov-5', repo_id: 'r1', path: '/wt5', branch: 'bead/ov-5', base_branch: 'main', verify_status: 'pass', verify_output: NO_VERIFY_RUN, review_note: null, conflict_files: null, merged_at: started, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Batch one', branch: 'batch/r1-b1', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    const board = await buildBoard(db, store);
    expect(board.bd_ok).toBe(true);
    const cards = board.repos[0]!.cards;
    expect(cards.map((c) => [c.bead.id, c.column])).toEqual([['ov-1', 'ready'], ['ov-2', 'blocked'], ['ov-3', 'running'], ['ov-4', 'review'], ['ov-5', 'done'], ['ov-6', 'done']]);
    expect(cards[5]!.bead.labels).toContain('overseer:abandoned');
    const running = cards[2]!;
    expect(running).toMatchObject({ harness: 'opencode', branch: 'bead/ov-3', cost: 0.4, session_status: 'running', account: 'acct-work', account_name: 'Work account', account_label: 'Work' });
    expect(running.elapsed_ms).toBeGreaterThanOrEqual(59_000);
    expect(cards[0]).toMatchObject({ harness: null, branch: null, cost: null, elapsed_ms: null, session_status: null, account: null, account_name: null, account_label: null });
    expect(board.repos[0]!.batches).toEqual([expect.objectContaining({ id: 'r1-b1', beads_total: 1, beads_done: 0, cost: 0.4 })]);
    expect(running.batch_id).toBe('r1-b1');
    expect(running.verify_failure).toBeNull(); // a running bead is not failed, whatever its last verification said
    expect(cards[3]!.verify_failure).toHaveLength(600); // the tail of the output, ending in the exit line
    expect(cards[3]!.verify_failure).toMatch(/x\nexit 1$/);
    // What the pane's verification block will show, which no card state predicts: ov-3 runs again while its branch still carries a
    // failed verification, ov-6 was closed before any verification ran, and ov-5 ran one with no command.
    expect(cards.map((c) => c.verify_block)).toEqual(['none', 'none', 'output', 'output', 'label', 'none']);
    expect(cards.map((c) => c.state)).toEqual(['idle', 'blocked', 'running', 'verify_failed', 'done', 'done']);
    expect(running.session_id).toBe('s3');
    expect(cards[0]!.session_id).toBeNull();
  });
  it('carries a batch\'s linked chat ids, oldest first, including its origin chat message', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert(repoRow('r1'));
    const started = new Date(Date.now() - 60_000).toISOString();
    db.batches.insert({ id: 'r1-b1', origin_chat_id: 5, repo_id: 'r1', title: 'Batch one', branch: 'batch/r1-b1', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    db.chatLinks.link(9, 'r1-b1');
    db.chatLinks.link(3, 'r1-b1');
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.batches[0]!.linked_chat_ids).toEqual([3, 5, 9]);
  });
  it('carries an empty list for a batch created outside the orchestrator', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert(repoRow('r1'));
    const started = new Date(Date.now() - 60_000).toISOString();
    db.batches.insert({ id: 'r1-b1', origin_chat_id: null, repo_id: 'r1', title: 'Web batch', branch: 'batch/r1-b1', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.batches[0]!.linked_chat_ids).toEqual([]);
  });
  it('states a Running bead whose session has ended as settling, and a failed verification on a waiting bead as verify_failed', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    const repo: Repo = { id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2, model_filter: null};
    db.repos.insert(repo);
    // The session-end rule has not run yet: bead still in_progress, no phase label, session ended, no failure recorded.
    store.add('/r1', { id: 'ov-1', title: 'Settling', status: 'in_progress' });
    store.add('/r1', { id: 'ov-2', title: 'Failed', status: 'open' });
    store.add('/r1', { id: 'ov-3', title: 'Verifying', status: 'in_progress', labels: ['overseer:verifying'] });
    store.add('/r1', { id: 'ov-4', title: 'Reviewed', status: 'in_progress', labels: ['overseer:review'] });
    store.add('/r1', { id: 'ov-5', title: 'Blocked after a failure', status: 'open' }, ['ov-2']);
    const started = new Date(Date.now() - 60_000).toISOString();
    db.sessions.insert({ id: 's1', harness: 'claude', role: 'worker', bead_id: 'ov-1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, status: 'ended', started_at: started, ended_at: new Date().toISOString(), cost: 0.1 });
    db.worktrees.upsert({ bead_id: 'ov-1', repo_id: 'r1', path: '/wt', branch: 'bead/ov-1', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    db.worktrees.upsert({ bead_id: 'ov-2', repo_id: 'r1', path: '/wt2', branch: 'bead/ov-2', base_branch: 'main', verify_status: 'fail', verify_output: 'exit 1', review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    db.worktrees.upsert({ bead_id: 'ov-3', repo_id: 'r1', path: '/wt3', branch: 'bead/ov-3', base_branch: 'main', verify_status: 'fail', verify_output: 'exit 1', review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    // A blocked bead is `blocked` even with a failed verification on record: nothing can be dispatched on it until its dependency is done (fix round 11 review).
    db.worktrees.upsert({ bead_id: 'ov-5', repo_id: 'r1', path: '/wt5', branch: 'bead/ov-5', base_branch: 'main', verify_status: 'fail', verify_output: 'exit 1', review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null , review_round: null, review_findings: null, accepted_note: null });
    const cards = (await buildBoard(db, store)).repos[0]!.cards;
    expect(cards.map((c) => [c.bead.id, c.column, c.state])).toEqual([['ov-1', 'running', 'settling'], ['ov-2', 'ready', 'verify_failed'], ['ov-3', 'verifying', 'verifying'], ['ov-4', 'review', 'review'], ['ov-5', 'blocked', 'blocked']]);
    expect(cards[0]).toMatchObject({ session_status: 'ended', verify_failure: null });
  });
  it('states a bead under a running critic as reviewing with the tier and model of the worker, and a bead parked with findings as awaiting_decision', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    const repo: Repo = { id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null };
    db.repos.insert(repo);
    store.add('/r1', { id: 'ov-1', title: 'Under review', status: 'in_progress', labels: ['overseer:verifying'] });
    store.add('/r1', { id: 'ov-2', title: 'Parked', status: 'open' });
    const started = new Date(Date.now() - 60_000).toISOString();
    const row = { harness: 'claude' as const, repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', started_at: started, cost: 0.1, batch_id: null, log_path: null, log_offset: 0 };
    db.sessions.insert({ ...row, id: 's1', role: 'worker', bead_id: 'ov-1', status: 'ended', ended_at: started, tier: 'standard', model: 'sonnet' });
    db.sessions.insert({ ...row, id: 's2', role: 'critic', bead_id: 'ov-1', status: 'running', ended_at: null, tier: 'critic', model: 'fable' });
    db.sessions.insert({ ...row, id: 's3', role: 'worker', bead_id: 'ov-2', status: 'ended', ended_at: started, tier: 'hard', model: 'opus' });
    db.sessions.insert({ ...row, id: 's4', role: 'critic', bead_id: 'ov-2', status: 'ended', ended_at: started, tier: 'critic', model: 'fable' });
    const findings = [{ file: 'a.ts', summary: 'No test.', severity: 'must' as const }];
    const wt = { repo_id: 'r1', base_branch: 'main', verify_status: 'pass' as const, verify_output: 'ok', review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: 2, accepted_note: null };
    db.worktrees.upsert({ ...wt, bead_id: 'ov-1', path: '/wt1', branch: 'bead/ov-1', review_findings: null });
    db.worktrees.upsert({ ...wt, bead_id: 'ov-2', path: '/wt2', branch: 'bead/ov-2', review_findings: findings });
    const cards = (await buildBoard(db, store)).repos[0]!.cards;
    expect(cards[0]).toMatchObject({ state: 'reviewing', column: 'verifying', harness: 'claude', tier: 'standard', model: 'sonnet', session_status: 'running', findings: null });
    expect(cards[1]).toMatchObject({ state: 'awaiting_decision', column: 'ready', tier: 'hard', model: 'opus', findings, accepted_note: null });
  });
  it('hides closed beads Overseer never touched and lists the newest Done first', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    store.add('/r1', { id: 'ov-1', title: 'Closed by hand', status: 'closed', closed_at: '2026-09-10T10:00:00Z' });
    store.add('/r1', { id: 'ov-2', title: 'Older merge', status: 'closed', labels: ['overseer:merged'], closed_at: '2026-09-11T10:00:00Z' });
    store.add('/r1', { id: 'ov-3', title: 'Newer merge', status: 'closed', labels: ['overseer:merged'], closed_at: '2026-09-12T10:00:00Z' });
    store.add('/r1', { id: 'ov-4', title: 'Closed after a session, label lost', status: 'closed', closed_at: '2026-09-13T10:00:00Z' });
    store.add('/r1', { id: 'ov-5', title: 'Still open' });
    db.sessions.insert({ id: 's4', harness: 'claude', role: 'worker', bead_id: 'ov-4', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, status: 'ended', started_at: '2026-09-13T09:00:00Z', ended_at: '2026-09-13T09:30:00Z', cost: 0.2 });
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.cards.map((c) => [c.bead.id, c.column])).toEqual([['ov-5', 'ready'], ['ov-4', 'done'], ['ov-3', 'done'], ['ov-2', 'done']]);
  });
  it('skips the ready call while no open bead has a dependency', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    const ready = vi.spyOn(store, 'ready');
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    store.add('/r1', { id: 'ov-1' });
    store.add('/r1', { id: 'ov-2', status: 'blocked' });
    store.add('/r1', { id: 'ov-3', status: 'closed' }, ['ov-1']); // a closed bead's dependencies no longer matter
    let board = await buildBoard(db, store);
    expect(board.repos[0]!.cards.map((c) => [c.bead.id, c.column])).toEqual([['ov-1', 'ready'], ['ov-2', 'blocked']]);
    expect(ready).not.toHaveBeenCalled();
    store.add('/r1', { id: 'ov-4' }, ['ov-1']);
    board = await buildBoard(db, store);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(board.repos[0]!.cards.map((c) => [c.bead.id, c.column])).toEqual([['ov-1', 'ready'], ['ov-2', 'blocked'], ['ov-4', 'blocked']]);
  });
  it('shows a bead the daemon is running as running even when bd still reads it as open and not ready (round 14)', async () => {
    // `list` and `ready` are two bd reads half a second apart: a dispatch between them leaves the bead open in the first and
    // in_progress (so not ready) in the second, and a card with dependencies flashed through Blocked.
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    store.add('/r1', { id: 'ov-1', status: 'closed' });
    store.add('/r1', { id: 'ov-2' }, ['ov-1']);
    vi.spyOn(store, 'ready').mockResolvedValue([]); // bd already sees ov-2 as in_progress
    db.sessions.insert({ id: 's2', harness: 'claude', role: 'worker', bead_id: 'ov-2', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.cards.find((c) => c.bead.id === 'ov-2')).toMatchObject({ column: 'running', state: 'running' });
  });

  it('counts ended sessions that reported no cost as unknown in the batch total (round 14)', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    store.add('/r1', { id: 'ov-1', status: 'in_progress' });
    store.add('/r1', { id: 'ov-2', status: 'in_progress' });
    const started = new Date().toISOString();
    db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Batch one', branch: 'batch/r1-b1', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    for (const id of ['ov-1', 'ov-2']) db.worktrees.upsert({ bead_id: id, repo_id: 'r1', path: `/wt-${id}`, branch: `bead/${id}`, base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: 'r1-b1', closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    const row = { harness: 'claude' as const, role: 'worker' as const, repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, started_at: started };
    db.sessions.insert({ ...row, id: 's1', bead_id: 'ov-1', status: 'ended', ended_at: started, cost: 0.36 });
    db.sessions.insert({ ...row, id: 's2', bead_id: 'ov-1', status: 'ended', ended_at: started, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null }); // stopped before the harness reported a cost
    db.sessions.insert({ ...row, id: 's3', bead_id: 'ov-2', status: 'running', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null }); // still running: not unknown, not yet reported
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.batches[0]).toMatchObject({ cost: 0.36, cost_unknown: 1 });
  });

  it('counts a bead created for a batch but not dispatched yet by its label, and puts its card under the batch (round 15)', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    const started = new Date().toISOString();
    db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Batch one', branch: 'feature/one', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    store.add('/r1', { id: 'ov-1', status: 'closed', labels: ['overseer:merged', 'overseer:batch:r1-b1'] });
    db.worktrees.upsert({ bead_id: 'ov-1', repo_id: 'r1', path: '/wt-ov-1', branch: 'bead/ov-1', base_branch: 'feature/one', verify_status: 'pass', verify_output: 'ok', review_note: null, conflict_files: null, merged_at: started, mr_url: null, batch_id: 'r1-b1', closed_at: null , review_round: null, review_findings: null, accepted_note: null });
    store.add('/r1', { id: 'ov-2', title: 'Created, waiting', labels: ['overseer:batch:r1-b1'] });
    store.add('/r1', { id: 'ov-3', title: 'Created, closed from the Board', status: 'closed', labels: ['overseer:batch:r1-b1', 'overseer:closed'] });
    store.add('/r1', { id: 'ov-4', title: 'Another batch', labels: ['overseer:batch:r1-b2'] });
    db.batches.insert({ id: 'r1-b2', repo_id: 'r1', title: 'Batch two', branch: 'feature/two', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.batches[0]).toMatchObject({ id: 'r1-b1', beads_total: 3, beads_done: 1, beads_closed: 1 });
    const cards = Object.fromEntries(board.repos[0]!.cards.map((c) => [c.bead.id, c]));
    expect(cards['ov-2']).toMatchObject({ column: 'ready', state: 'idle', batch_id: 'r1-b1' });
    expect(cards['ov-3']).toMatchObject({ column: 'done', batch_id: 'r1-b1' }); // the phase label is read past the batch label
    expect(cards['ov-4']!.batch_id).toBe('r1-b2');
  });

  it('ignores a batch label that names no batch of this install, and does not count a labelled bead closed outside Overseer (fix round 15 review M-5, M-9)', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    const started = new Date().toISOString();
    db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Batch one', branch: 'feature/one', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: started, updated_at: started, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    store.add('/r1', { id: 'ov-1', title: 'Created, waiting', labels: ['overseer:batch:r1-b1'] });
    // Closed with a plain `bd close` (no phase label): the board shows no card for it, so the batch does not count it either.
    store.add('/r1', { id: 'ov-2', title: 'Closed by hand', status: 'closed', labels: ['overseer:batch:r1-b1'] });
    // The label of a batch that no longer exists (the repo was removed and registered again): the card is not under a batch.
    store.add('/r1', { id: 'ov-3', title: 'Stale label', labels: ['overseer:batch:r1-b9'] });
    const board = await buildBoard(db, store);
    expect(board.repos[0]!.batches[0]).toMatchObject({ id: 'r1-b1', beads_total: 1, beads_done: 0, beads_closed: 0 });
    const cards = Object.fromEntries(board.repos[0]!.cards.map((c) => [c.bead.id, c]));
    expect(cards['ov-2']).toBeUndefined();
    expect(cards['ov-3']!.batch_id).toBeNull();
  });

  it('returns empty cards when bd is unavailable', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    store.unavailable = true;
    db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
    const board = await buildBoard(db, store);
    expect(board).toEqual({ bd_ok: false, repos: [{ repo: expect.objectContaining({ id: 'r1' }), batches: [], cards: [] }] });
  });
  it('builds repos in parallel and coalesces concurrent builds', async () => {
    const db = openDb(':memory:');
    const store = new SlowMemoryTaskStore();
    for (const id of ['a', 'b', 'c']) {
      db.repos.insert({ id, path: `/${id}`, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2});
      store.add(`/${id}`, { id: `${id}-1` });
    }
    const t0 = Date.now();
    const b = await buildBoard(db, store);
    expect(Date.now() - t0).toBeLessThan(140);
    expect(b.repos.map((r) => r.cards.length)).toEqual([1, 1, 1]);
    let builds = 0;
    const get = coalesced(async () => { builds++; return buildBoard(db, store); });
    await Promise.all([get(), get(), get()]);
    expect(builds).toBe(1);
    await get();
    expect(builds).toBe(2);
    // With a change signalled after the running build started, callers arriving meanwhile share one follow-up build.
    let changes = 0;
    const fresh = coalesced(async () => { builds++; return buildBoard(db, store); }, () => changes);
    const first = fresh();
    store.add('/a', { id: 'a-2' }); changes++;
    const [r1, r2, r3] = await Promise.all([first, fresh(), fresh()]);
    expect(builds).toBe(4);
    expect(r1.repos[0]!.cards.length).toBeLessThanOrEqual(2);
    expect(r2.repos[0]!.cards).toHaveLength(2);
    expect(r3).toBe(r2);
  });

  it('a Done card carries no description or notes, while a Ready card keeps both', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    db.repos.insert(repoRow('r1'));
    store.add('/r1', { id: 'ov-1', title: 'Ready one', description: 'ready description', notes: 'ready history' });
    store.add('/r1', { id: 'ov-2', title: 'Done one', status: 'closed', labels: ['overseer:merged'], description: 'done description', notes: 'done history' });
    const cards = (await buildBoard(db, store)).repos[0]!.cards;
    const ready = cards.find((c) => c.bead.id === 'ov-1')!;
    const done = cards.find((c) => c.bead.id === 'ov-2')!;
    expect(ready.bead).toMatchObject({ description: 'ready description', notes: 'ready history' });
    expect(done.column).toBe('done');
    // Every other field travels as it did; the pane fetches the full bead when it opens the card.
    expect(done.bead).toEqual({ id: 'ov-2', title: 'Done one', description: '', status: 'closed', priority: 2, labels: ['overseer:merged'], notes: '', assignee: null, closed_at: null, dependency_count: 0 });
  });

  it('serves a second board build from the list cache without a bd read, and a write drops it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-board-cache-'));
    const calls: string[][] = [];
    const run: BdRunner = async (_cwd, args) => {
      calls.push(args);
      return { code: 0, stdout: args[0] === 'list' ? JSON.stringify([{ id: 'ov-1', title: 'One', status: 'open' }]) : '', stderr: '' };
    };
    const store = new Beads(run);
    const db = openDb(':memory:');
    db.repos.insert({ ...repoRow('r1'), path: dir });
    expect((await buildBoard(db, store)).repos[0]!.cards).toHaveLength(1);
    await buildBoard(db, store);
    expect(calls.filter((a) => a[0] === 'list')).toHaveLength(1);
    await store.update(dir, 'ov-1', { status: 'in_progress' }); // a bd write through the queue
    await buildBoard(db, store);
    expect(calls.filter((a) => a[0] === 'list')).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('slow build warnings', () => {
  it('logs a slow repo at most once a minute and carries the count it suppressed', () => {
    const warns: { msg: string; data: Record<string, unknown> }[] = [];
    let now = 1_000_000;
    const w = new SlowBuildWarner(() => now, (msg, data) => warns.push({ msg, data }));
    w.note('r1', 900); // under the threshold: not slow
    expect(warns).toHaveLength(0);
    w.note('r1', 1200);
    w.note('r1', 1300);
    w.note('r1', 1400);
    expect(warns).toEqual([{ msg: 'board build slow', data: { repo: 'r1', ms: 1200, suppressed: 0 } }]);
    now += 59_999;
    w.note('r1', 1500);
    expect(warns).toHaveLength(1);
    now += 1; // the minute is up: log again with the three suppressed since the last line
    w.note('r1', 1600);
    expect(warns).toHaveLength(2);
    expect(warns[1]!.data).toEqual({ repo: 'r1', ms: 1600, suppressed: 3 });
    w.note('r2', 1100); // another repo has its own window
    expect(warns).toHaveLength(3);
  });

  it('warns through the log from a real slow build, then suppresses the next', async () => {
    const db = openDb(':memory:');
    const store = new VerySlowMemoryTaskStore();
    db.repos.insert(repoRow('warn-r1'));
    store.add('/warn-r1', { id: 'warn-r1-1' });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    warn.mockClear();
    try {
      await buildBoard(db, store);
      await buildBoard(db, store);
      const slow = warn.mock.calls.filter(([msg]) => msg === 'board build slow');
      expect(slow).toHaveLength(1);
      expect(slow[0]![1]).toMatchObject({ repo: 'warn-r1', suppressed: 0 });
    } finally {
      warn.mockRestore();
      slowBuildWarnings.reset();
    }
  });
});
