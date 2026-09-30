import { describe, it, expect } from 'vitest';
import type { BatchRow, SessionRow } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { DEFAULT_USAGE_DAYS, usageQuery, usageRange, usageReport } from './usage';

const session = (over: Partial<SessionRow> & Pick<SessionRow, 'id' | 'started_at'>): SessionRow => ({
  harness: 'claude', role: 'worker', bead_id: null, repo_id: null, native_session_id: null,
  pid: null, pid_started_at: null, start_commit: null, cwd: '/tmp/wt', status: 'ended', ended_at: null,
  cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, ...over,
});

const batch = (id: string, repoId: string, title: string): BatchRow => ({
  id, repo_id: repoId, title, branch: `feature/${id}`, base_branch: 'main', status: 'open', note: null, history: null,
  mr_url: null, conflict_files: null, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null, refresh_from: null, refresh_head: null,
});

const report = (db: Db, from: string, to: string) => usageReport(db, { ...usageRange(from, to), groups: ['model', 'account', 'harness', 'repo', 'batch'] });

describe('GET /api/usage report', () => {
  it('sums totals, days and every requested breakdown without adding reported and estimated dollars', () => {
    const db = openDb(':memory:');
    db.repos.insert({ id: 'r1', path: '/repos/one', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2 });
    db.repos.insert({ id: 'r2', path: '/repos/two', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2 });
    db.accounts.insert({ id: 'a1', name: 'Work', label: 'work', harness: 'claude', kind: 'oauth_token', secret: 't', home: null, created_at: 't', last_login_at: 't', last_verified_at: null });
    db.batches.insert(batch('r1-b1', 'r1', 'Batch one'));
    db.sessions.insert(session({
      id: 's1', started_at: '2026-09-10T08:00:00.000Z', harness: 'claude', role: 'worker', repo_id: 'r1', batch_id: 'r1-b1', account: 'a1',
      model: 'sonnet', resolved_model: 'claude-sonnet-4', cost: 1.5, estimated_cost: 1.2,
      input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 5, cache_write_1h_tokens: 2, reasoning_tokens: 3,
    }));
    db.sessions.insert(session({
      id: 's2', started_at: '2026-09-10T09:00:00.000Z', harness: 'codex', role: 'worker', repo_id: 'r1', batch_id: 'r1-b1', account: 'a1',
      model: 'gpt-5.6-terra', cost: null, estimated_cost: 0.8, cost_source: 'estimated', input_tokens: 200, output_tokens: 20,
    }));
    db.sessions.insert(session({
      id: 's3', started_at: '2026-09-11T10:00:00.000Z', harness: 'opencode', role: 'worker', repo_id: 'r2',
      model: 'deepseek/deepseek-flash', cost: 2, estimated_cost: null, cost_source: 'unknown', input_tokens: 300,
    }));

    const r = report(db, '2026-09-10', '2026-09-11');
    expect(usageReport(db, { ...usageRange('2026-09-10', '2026-09-11'), groups: ['harness'] }).days_by_model).toEqual([]);
    expect(r.from).toBe('2026-09-10');
    expect(r.to).toBe('2026-09-11');
    expect(r.totals).toEqual({ sessions: 3, reported_cost: 3.5, reported_unknown: 1, estimated_cost: 2, estimated_unknown: 1, codex_sessions: 1, tokens: { input: 600, output: 70, cache_read: 10, cache_write: 5, cache_write_1h: 2, reasoning: 3 } });
    expect(r.days).toEqual([
      { day: '2026-09-10', sessions: 2, reported_cost: 1.5, reported_unknown: 1, estimated_cost: 2, estimated_unknown: 0, codex_sessions: 1, tokens: { input: 300, output: 70, cache_read: 10, cache_write: 5, cache_write_1h: 2, reasoning: 3 } },
      { day: '2026-09-11', sessions: 1, reported_cost: 2, reported_unknown: 0, estimated_cost: 0, estimated_unknown: 1, codex_sessions: 0, tokens: { input: 300, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } },
    ]);
    expect(r.groups.model!.map((g) => [g.key, g.reported_cost, g.estimated_cost])).toEqual([
      ['deepseek/deepseek-flash', 2, 0], ['claude-sonnet-4', 1.5, 1.2], ['gpt-5.6-terra', 0, 0.8],
    ]);
    expect(r.groups.account!.map((g) => [g.key, g.label, g.reported_cost])).toEqual([['a1', 'work', 1.5], [null, null, 2]]);
    expect(r.groups.harness!.map((g) => [g.key, g.reported_cost])).toEqual([['opencode', 2], ['claude', 1.5], ['codex', 0]]);
    expect(r.groups.repo!.map((g) => [g.key, g.label])).toEqual([['r1', '/repos/one'], ['r2', '/repos/two']]);
    // The codex count is what tells the Usage page which buckets carry the base-context-tier caveat, so it follows the sessions, not the model id.
    expect(r.groups.model!.map((g) => [g.key, g.codex_sessions])).toEqual([['deepseek/deepseek-flash', 0], ['claude-sonnet-4', 0], ['gpt-5.6-terra', 1]]);
    expect(r.groups.harness!.map((g) => [g.key, g.codex_sessions])).toEqual([['opencode', 0], ['claude', 0], ['codex', 1]]);
    // The stacked bars need each day split by model; a day carries only the models that ran in it.
    expect(r.days_by_model.map((g) => [g.day, g.key, g.reported_cost, g.estimated_cost])).toEqual([
      ['2026-09-10', 'claude-sonnet-4', 1.5, 1.2], ['2026-09-10', 'gpt-5.6-terra', 0, 0.8], ['2026-09-11', 'deepseek/deepseek-flash', 2, 0],
    ]);
    expect(r.groups.batch!.map((g) => [g.key, g.label])).toEqual([['r1-b1', 'Batch one'], [null, null]]);
  });

  it('includes the from and to days themselves and excludes the days just outside', () => {
    const db = openDb(':memory:');
    for (const [id, at] of [
      ['before', '2026-08-31T23:59:59.999Z'], ['first', '2026-09-01T00:00:00.000Z'],
      ['last', '2026-09-30T23:59:59.999Z'], ['after', '2026-10-01T00:00:00.000Z'],
    ] as const) db.sessions.insert(session({ id, started_at: at, cost: 1 }));

    const r = report(db, '2026-09-01', '2026-09-30');
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.reported_cost).toBe(2);
    expect(r.days.map((d) => d.day)).toEqual(['2026-09-01', '2026-09-30']);
  });

  it('keeps a model the catalog does not price in the breakdown, with a zero estimate', () => {
    const db = openDb(':memory:');
    db.sessions.insert(session({ id: 'unknown', started_at: '2026-09-10T08:00:00.000Z', model: 'mystery-model', resolved_model: 'mystery-model', cost: null, estimated_cost: null, cost_source: 'unknown', input_tokens: 10 }));
    db.sessions.insert(session({ id: 'priced', started_at: '2026-09-10T09:00:00.000Z', model: 'sonnet', resolved_model: 'claude-sonnet-4', cost: null, estimated_cost: 0.25, cost_source: 'estimated' }));

    const r = report(db, '2026-09-10', '2026-09-10');
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.estimated_cost).toBe(0.25);
    // Both sessions report no cost, so `reported_cost` 0 is a floor over 2; only the unpriced model contributes no estimate.
    expect(r.totals.reported_unknown).toBe(2);
    expect(r.totals.estimated_unknown).toBe(1);
    expect(r.groups.model).toEqual([
      expect.objectContaining({ key: 'claude-sonnet-4', sessions: 1, estimated_cost: 0.25, reported_unknown: 1, estimated_unknown: 0 }),
      expect.objectContaining({ key: 'mystery-model', sessions: 1, reported_cost: 0, reported_unknown: 1, estimated_cost: 0, estimated_unknown: 1 }),
    ]);
  });

  it('does not count a session that genuinely cost $0 as unknown', () => {
    const db = openDb(':memory:');
    db.sessions.insert(session({ id: 'free', started_at: '2026-09-10T08:00:00.000Z', cost: 0, estimated_cost: 0, cost_source: 'reported' }));

    const r = report(db, '2026-09-10', '2026-09-10');
    expect(r.totals).toMatchObject({ reported_cost: 0, reported_unknown: 0, estimated_cost: 0, estimated_unknown: 0 });
  });

  it('names an unlabelled live account and keeps a deleted account as its key with no label', () => {
    const db = openDb(':memory:');
    db.accounts.insert({ id: 'a1', name: 'Personal Max', label: null, harness: 'claude', kind: 'oauth_token', secret: 't', home: null, created_at: 't', last_login_at: 't', last_verified_at: null });
    db.accounts.insert({ id: 'a2', name: 'Work', label: 'work', harness: 'claude', kind: 'oauth_token', secret: 't', home: null, created_at: 't', last_login_at: 't', last_verified_at: null });
    db.accounts.insert({ id: 'a9', name: 'Gone', label: 'gone', harness: 'claude', kind: 'oauth_token', secret: 't', home: null, created_at: 't', last_login_at: 't', last_verified_at: null });
    for (const id of ['a1', 'a2', 'a9']) db.sessions.insert(session({ id: `s-${id}`, started_at: '2026-09-10T08:00:00.000Z', account: id, cost: 0.5 }));
    db.accounts.remove('a9');

    const r = report(db, '2026-09-10', '2026-09-10');
    expect(r.groups.account!.map((g) => [g.key, g.label])).toEqual([['a1', 'Personal Max'], ['a2', 'work'], ['a9', null]]);
  });

  it('defaults to the last 30 days ending today and validates the query', () => {
    expect(usageRange(undefined, undefined, '2026-09-17')).toEqual({ from: '2026-08-19', to: '2026-09-17' });
    expect(DEFAULT_USAGE_DAYS).toBe(30);
    expect(usageQuery({}, '2026-09-17')).toEqual({ from: '2026-08-19', to: '2026-09-17', groups: ['model', 'account', 'harness', 'repo', 'batch'] });
    expect(usageQuery({ from: '2026-09-01', to: '2026-09-30', group: 'model,repo,model' })).toEqual({ from: '2026-09-01', to: '2026-09-30', groups: ['model', 'repo'] });
    expect(() => usageQuery({ group: 'not-a-group' })).toThrow();
    expect(() => usageQuery({ from: '09/01/2026' })).toThrow();
    // A day that rolls over (V8 parses it as another date) and days Date.parse turns into NaN (an out-of-range month or day 00) are both 400s, never a 500.
    expect(() => usageQuery({ from: '2026-02-31' })).toThrow('not a real date');
    expect(() => usageQuery({ from: '2026-13-01' })).toThrow('not a real date');
    expect(() => usageQuery({ to: '2026-09-00' })).toThrow('not a real date');
    expect(() => usageQuery({ from: '2026-00-10' })).toThrow('not a real date');
  });

  it('aggregates 5,000 sessions in one query per bucket within a bounded time', () => {
    const db = openDb(':memory:');
    db.sql.exec('BEGIN');
    for (let i = 0; i < 5_000; i += 1) {
      const day = String(1 + (i % 30)).padStart(2, '0');
      db.sessions.insert(session({
        id: `s${i}`, started_at: `2026-09-${day}T00:00:00.000Z`, harness: i % 2 ? 'claude' : 'codex',
        repo_id: `r${i % 4}`, batch_id: `b${i % 5}`, model: `model-${i % 7}`, resolved_model: `model-${i % 7}`,
        cost: i % 2 ? 0.01 : null, estimated_cost: 0.02, input_tokens: 1, output_tokens: 1,
      }));
    }
    db.sql.exec('COMMIT');

    const started = performance.now();
    const r = report(db, '2026-09-01', '2026-09-30');
    const ms = performance.now() - started;
    expect(r.totals.sessions).toBe(5_000);
    expect(r.days).toHaveLength(30);
    expect(r.groups.model).toHaveLength(7);
    expect(ms).toBeLessThan(1000);
  });
});
