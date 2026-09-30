import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, DEFAULT_TIERS, DB_BUSY_TIMEOUT_MS, DB_CACHE_SIZE_KB } from './db';
import { loadConfig } from '../config';

describe('Db', () => {
  it('adds the nullable chat origin to an existing batches table', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-origin-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE batches (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    old.exec("INSERT INTO batches (id,repo_id,title,branch,base_branch,status,created_at,updated_at) VALUES ('r1-b1','r1','Old','feature/old','main','open','t0','t0')");
    old.close();
    const db = openDb(file);
    expect(db.batches.get('r1-b1')?.origin_chat_id).toBeNull();
    expect((db.sql.prepare('PRAGMA table_info(batches)').all() as { name: string }[]).map((c) => c.name)).toContain('origin_chat_id');
    db.sql.close();
  });
  it('adds nullable last-pipeline fields to an existing batches table', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-pipeline-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE batches (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    old.exec("INSERT INTO batches (id,repo_id,title,branch,base_branch,status,created_at,updated_at) VALUES ('r1-b1','r1','Old','feature/old','main','review','t0','t0')");
    old.close();
    const db = openDb(file);
    const columns = (db.sql.prepare('PRAGMA table_info(batches)').all() as { name: string }[]).map((column) => column.name);
    expect({
      columns: columns.filter((column) => column === 'last_pipeline_id' || column === 'last_pipeline_outcome'),
      batch: db.batches.get('r1-b1'),
    }).toMatchObject({
      columns: ['last_pipeline_id', 'last_pipeline_outcome'],
      batch: { last_pipeline_id: null, last_pipeline_outcome: null },
    });
    db.sql.close();
  });
  it('adds seen_at and replied_at to an existing chat table and backfills answered rows from reply_to', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-chatseen-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE chat (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL, answer TEXT, answered_at TEXT, queued_at TEXT, superseded_at TEXT, hint TEXT, reply_to INTEGER, attachments TEXT)');
    old.prepare('INSERT INTO chat (role,kind,text,ts) VALUES (?,?,?,?)').run('user', 'message', 'answered old message', 't1');
    old.prepare('INSERT INTO chat (role,kind,text,ts,reply_to) VALUES (?,?,?,?,?)').run('assistant', 'message', 'the old reply', 't2', 1);
    old.prepare('INSERT INTO chat (role,kind,text,ts) VALUES (?,?,?,?)').run('user', 'message', 'unanswered old message', 't3');
    old.close();
    const db = openDb(file);
    const columns = (db.sql.prepare('PRAGMA table_info(chat)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('seen_at');
    expect(columns).toContain('replied_at');
    // The answered user row takes the answering assistant row's ts for both marks; every other old row stays null.
    expect(db.chat.get(1)).toMatchObject({ seen_at: 't2', replied_at: 't2' });
    expect(db.chat.get(2)).toMatchObject({ seen_at: null, replied_at: null });
    expect(db.chat.get(3)).toMatchObject({ seen_at: null, replied_at: null });
    db.sql.close();
  });
  it('adds retry state to an existing chat table and recovers an accepted retry until it completes', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-chatretry-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE chat (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL, answer TEXT, answered_at TEXT, queued_at TEXT, superseded_at TEXT, hint TEXT, reply_to INTEGER, attachments TEXT, seen_at TEXT, replied_at TEXT)');
    old.prepare('INSERT INTO chat (role,kind,text,ts) VALUES (?,?,?,?)').run('system', 'message', 'an old notice', 't1');
    old.close();
    const db = openDb(file);
    expect(db.chat.page({ limit: 10 }).rows[0]).toMatchObject({ text: 'an old notice', failed_for: null, retried_at: null });
    expect((db.sql.prepare('PRAGMA table_info(chat)').all() as { name: string }[]).map((column) => column.name)).toContain('retry_completed_at');
    const user = db.chat.insert({ role: 'user', kind: 'message', text: 'hello' });
    const first = db.chat.insert({ role: 'system', kind: 'message', text: 'Message saved but not delivered: x', failed_for: user.id });
    const second = db.chat.insert({ role: 'system', kind: 'message', text: 'Message saved but not delivered: y', failed_for: user.id });
    expect(db.chat.markRetried(user.id)).toBe(2);
    expect(db.chat.markRetried(user.id)).toBe(0);
    expect(db.chat.get(first.id)!.retried_at).toBeTruthy();
    expect(db.chat.pendingRetries()).toMatchObject([{ user_id: user.id }]);
    const nextFailure = db.chat.completeRetry(user.id, 'retry failed again')!;
    expect(nextFailure).toMatchObject({ failed_for: user.id, retried_at: null, text: 'retry failed again' });
    expect(db.chat.pendingRetries()).toEqual([]);
    expect(db.chat.markRetried(user.id)).toBe(1);
    db.chat.completeRetry(user.id);
    expect(db.chat.pendingRetries()).toEqual([]);
    expect(db.chat.get(1)!.retried_at).toBeNull();
    db.sql.close();
  });

  it('opens SQLite with the configured busy timeout', () => {
    const db = openDb(':memory:');
    expect(db.sql.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: DB_BUSY_TIMEOUT_MS });
  });

  it('records chat-to-batch links once per pair, oldest chat first', () => {
    const db = openDb(':memory:');
    db.chatLinks.link(7, 'r1-b1');
    db.chatLinks.link(3, 'r1-b1');
    db.chatLinks.link(7, 'r1-b1'); // the same pair twice is one link
    db.chatLinks.link(7, 'r1-b2');
    expect(db.chatLinks.forBatch('r1-b1')).toEqual([3, 7]);
    expect(db.chatLinks.forBatch('r1-b2')).toEqual([7]);
    expect(db.chatLinks.forBatch('r1-b9')).toEqual([]);
    db.sql.close();
  });

  it('creates chat_batch_links on a database from an older schema', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-links-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE batches (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    old.close();
    const db = openDb(file);
    expect((db.sql.prepare('PRAGMA table_info(chat_batch_links)').all() as { name: string }[]).map((c) => c.name)).toEqual(['chat_id', 'batch_id', 'created_at']);
    db.chatLinks.link(1, 'r1-b1');
    expect(db.chatLinks.forBatch('r1-b1')).toEqual([1]);
    db.sql.close();
  });

  it('reports the newest user row handed to a session, ignoring other roles', () => {
    const db = openDb(':memory:');
    expect(db.chat.latestSeenUserId()).toBeNull();
    const first = db.chat.insert({ role: 'user', kind: 'message', text: 'first' });
    const notice = db.chat.insert({ role: 'system', kind: 'message', text: 'notice', queued: true });
    const second = db.chat.insert({ role: 'user', kind: 'message', text: 'second' });
    db.chat.markSeen([first.id, notice.id]);
    expect(db.chat.latestSeenUserId()).toBe(first.id);
    db.chat.markSeen([second.id]);
    expect(db.chat.latestSeenUserId()).toBe(second.id);
    db.sql.close();
  });

  it('opens SQLite with the configured page cache size', () => {
    const db = openDb(':memory:');
    expect(db.sql.prepare('PRAGMA cache_size').get()).toEqual({ cache_size: DB_CACHE_SIZE_KB });
  });

  it('creates the bead and batch lookup indexes on a fresh database', () => {
    const db = openDb(':memory:');
    const indexNames = (table: string) => (db.sql.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);
    expect(indexNames('sessions')).toContain('sessions_bead');
    expect(indexNames('worktrees')).toContain('worktrees_batch');
  });

  it('creates the lookup indexes on a database from an older schema', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, harness TEXT NOT NULL, role TEXT NOT NULL, bead_id TEXT, repo_id TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL)');
    old.exec('CREATE TABLE worktrees (bead_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL)');
    old.close();
    const db = openDb(file);
    const indexNames = (table: string) => (db.sql.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);
    expect(indexNames('sessions')).toContain('sessions_bead');
    expect(indexNames('worktrees')).toContain('worktrees_batch');
  });

  it('plans the bead and batch lookups through the indexes', () => {
    const db = openDb(':memory:');
    const plan = (sql: string, ...params: string[]) => (db.sql.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join('\n');
    expect(plan('SELECT * FROM sessions WHERE bead_id=? ORDER BY started_at', 'b1')).toContain('sessions_bead');
    expect(plan('SELECT * FROM worktrees WHERE batch_id=?', 'r1-b1')).toContain('worktrees_batch');
  });

  it('round-trips every table', () => {
    const db = openDb(':memory:');
    openDb(':memory:');
    const modelFilter = { harnesses: ['claude' as const], models: ['future-model'], accounts: ['account-1'] };
    db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: 'npm test', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3 , review_rounds: 2, model_filter: modelFilter });
    expect(db.repos.get('r1')?.path).toBe('/tmp/r1');
    expect(db.repos.get('r1')?.model_filter).toEqual(modelFilter);
    expect(db.repos.all()[0]?.model_filter).toEqual(modelFilter);
    expect(db.repos.all()).toHaveLength(1);

    db.sessions.insert({ id: 's1', harness: 'claude', role: 'worker', bead_id: 'b1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/tmp/wt', status: 'running', started_at: 't0', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    db.sessions.update('s1', { pid: 12, pid_started_at: 'x', native_session_id: 'n1', cost: 0.5 });
    expect(db.sessions.get('s1')).toMatchObject({ pid: 12, native_session_id: 'n1', cost: 0.5 });
    expect(db.sessions.running()).toHaveLength(1);
    expect(db.sessions.forBead('b1')).toHaveLength(1);

    db.accounts.insert({ id: 'a1', name: 'Work', label: 'Work', harness: 'claude', kind: 'oauth_token', secret: 'private', home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    expect(db.accounts.get('a1')).toEqual({ id: 'a1', name: 'Work', label: 'Work', harness: 'claude', kind: 'oauth_token', provider: null, secret: 'private', home: null, created_at: 't0', last_login_at: null, last_verified_at: null, refresh_token: null, token_expires_at: null, exhausted_until: null });
    expect(db.accounts.list()).toEqual([{ id: 'a1', name: 'Work', label: 'Work', harness: 'claude', kind: 'oauth_token', provider: null, home: null, created_at: 't0', last_login_at: null, last_verified_at: null, has_secret: true, logged_in: true }]);
    expect(typeof db.accounts.list()[0]!.has_secret).toBe('boolean');
    expect(db.accounts.list()[0]).not.toHaveProperty('secret');
    expect(db.accounts.list()[0]).not.toHaveProperty('refresh_token');
    db.accounts.update('a1', { name: 'Personal', last_verified_at: 't1' });
    expect(db.accounts.get('a1')).toMatchObject({ name: 'Personal', last_verified_at: 't1' });
    db.accounts.remove('a1');
    expect(db.accounts.list()).toEqual([]);

    const sig = db.signals.insert({ batch_id: 'r1-b1', bead_id: 'b1', kind: 'reopen', text: 'no_commits: no output' });
    expect(db.signals.forBatch('r1-b1')).toEqual([{ ...sig, id: 1 }]);
    expect(db.signals.forBatch('r1-b2')).toEqual([]);
    db.sessions.update('s1', { status: 'ended', ended_at: 't1' });
    expect(db.sessions.running()).toHaveLength(0);
    expect(db.sessions.latest('worker')?.id).toBe('s1');

    db.worktrees.upsert({ bead_id: 'b1', repo_id: 'r1', path: '/tmp/wt', branch: 'bead/b1', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
    db.worktrees.update('b1', { conflict_files: ['a.ts', 'b.ts'], verify_status: 'fail' });
    expect(db.worktrees.get('b1')?.conflict_files).toEqual(['a.ts', 'b.ts']);
    expect(db.worktrees.forRepo('r1')).toHaveLength(1);

    // `<repo>-b<n>-<random>`: the counter orders the ids, the random part keeps a fresh database from minting an id whose label is already in the repo's .beads (round 17).
    expect(db.batches.nextId('r1')).toMatch(/^r1-b1-[a-z2-7]{4}$/);
    expect(openDb(':memory:').batches.nextId('r1')).not.toBe(db.batches.nextId('r1'));
    expect(openDb(':memory:', { batchIdSuffix: () => '' }).batches.nextId('r1')).toBe('r1-b1');
    db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Trend chart', branch: 'feature/trend-chart', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: 't0', updated_at: 't0', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    expect(db.batches.nextId('r1')).toMatch(/^r1-b2-[a-z2-7]{4}$/);
    db.batches.update('r1-b1', { status: 'review', note: 'done', conflict_files: ['x.ts'] });
    expect(db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'done', conflict_files: ['x.ts'] });
    expect(db.batches.forRepo('r1')).toHaveLength(1);
    db.worktrees.update('b1', { batch_id: 'r1-b1' });
    expect(db.worktrees.forBatch('r1-b1').map((w) => w.bead_id)).toEqual(['b1']);

    const e1 = db.events.append('s1', 'assistant_text', { text: 'hi' });
    const e2 = db.events.append('s1', 'turn_end', { nativeSessionId: 'n1' });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    expect(db.events.forSession('s1').map((e) => e.type)).toEqual(['assistant_text', 'turn_end']);
    expect(db.events.lastOfType('s1', 'assistant_text')?.payload).toEqual({ text: 'hi' });
    db.events.append('s1', 'assistant_text', { text: 'sub-agent note', parentId: 'call_task' });
    expect(db.events.lastOfType('s1', 'assistant_text')?.payload).toEqual({ text: 'hi' }); // a sub-agent's text is not the session's own

    const q = db.chat.insert({ role: 'assistant', kind: 'question', text: 'which repo?' });
    db.chat.insert({ role: 'user', kind: 'message', text: 'hello' });
    expect(db.chat.pendingQuestions().map((c) => c.id)).toEqual([q.id]);
    db.chat.answer(q.id, 'that one');
    expect(db.chat.pendingQuestions()).toHaveLength(0);
    expect(db.chat.all()).toHaveLength(2);
    const q2 = db.chat.insert({ role: 'assistant', kind: 'question', text: 'which branch?' });
    const q3 = db.chat.insert({ role: 'assistant', kind: 'question', text: 'which word?' });
    const closed = db.chat.supersedeIds([q2.id, q2.id]);
    expect({ closed, pending: db.chat.pendingQuestions().map((c) => c.id) }).toEqual({ closed: 1, pending: [q3.id] });
    expect(db.chat.get(q2.id)?.superseded_at).toBeTruthy();
    expect(db.chat.supersedeIds([])).toBe(0);
    expect(db.chat.supersede(q3.id).changes).toBe(1);
    expect(db.chat.pendingQuestions()).toHaveLength(0);
    const n = db.chat.insert({ role: 'system', kind: 'message', text: 'landed', queued: true });
    expect(n.queued_at).toBeTruthy();
    expect(db.chat.queued().map((c) => c.id)).toEqual([n.id]);
    db.chat.flushQueued();
    expect(db.chat.queued()).toHaveLength(0);
    expect(db.chat.get(n.id)?.queued_at).toBeNull();

    // overseer-5nh: attachments round-trip, with `path` visible only through the dedicated accessor
    const m = db.chat.insert({ role: 'user', kind: 'message', text: 'a screenshot' });
    expect(m.attachments).toBeUndefined();
    db.chat.setAttachments(m.id, [{ name: 'shot.png', mime: 'image/png', size: 3, path: '/tmp/shot.png' }]);
    expect(db.chat.get(m.id)?.attachments).toEqual([{ name: 'shot.png', mime: 'image/png', size: 3 }]);
    expect(db.chat.all().find((c) => c.id === m.id)?.attachments).toEqual([{ name: 'shot.png', mime: 'image/png', size: 3 }]);
    expect(db.chat.attachment(m.id, 0)).toEqual({ name: 'shot.png', mime: 'image/png', size: 3, path: '/tmp/shot.png' });
    expect(db.chat.attachment(m.id, 1)).toBeUndefined();
    expect(db.chat.attachment(q.id, 0)).toBeUndefined();
  });

  it('answers existsOfTypes the same as scanning the session, including sub-agent events', () => {
    const db = openDb(':memory:');
    db.sessions.insert({ id: 's1', harness: 'claude', role: 'worker', bead_id: 'b1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/tmp/wt', status: 'running', started_at: 't0', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    const types = ['assistant_text', 'tool_call', 'tool_result', 'file_change'];
    const scan = () => db.events.forSession('s1').some((ev) => types.includes(ev.type));
    expect(db.events.existsOfTypes('s1', types)).toBe(false);
    expect(db.events.existsOfTypes('s1', types)).toBe(scan());
    db.events.append('s1', 'raw', { line: 'codex 0.154.0' });
    expect(db.events.existsOfTypes('s1', types)).toBe(false);
    expect(db.events.existsOfTypes('s1', types)).toBe(scan());
    // A sub-agent's event counts too, exactly as the previous full-session scan counted it.
    db.events.append('s1', 'tool_result', { id: 't1', output: 'x', parentId: 'call_task' });
    expect(db.events.existsOfTypes('s1', types)).toBe(true);
    expect(db.events.existsOfTypes('s1', types)).toBe(scan());
    expect(db.events.existsOfTypes('nobody', types)).toBe(false);
    expect(db.events.existsOfTypes('s1', [])).toBe(false);
  });

  it('stores plans with their steps and lists drafts newest first', () => {
    const db = openDb(':memory:');
    const steps = [{ title: 'Table', description: 'd', dependsOn: [] }, { title: 'Login', description: '', dependsOn: [0] }];
    expect(db.plans.nextId('r1')).toBe('r1-p1');
    db.plans.insert({ id: 'r1-p1', repo_id: 'r1', title: 'Accounts', steps, status: 'draft', batch_id: null, revision: 1, created_at: '2026-09-16T10:00:00.000Z', updated_at: '2026-09-16T10:00:00.000Z' });
    db.plans.insert({ id: 'r1-p2', repo_id: 'r1', title: 'Later', steps, status: 'draft', batch_id: null, revision: 1, created_at: '2026-09-16T11:00:00.000Z', updated_at: '2026-09-16T11:00:00.000Z' });
    db.plans.insert({ id: 'r1-p3', repo_id: 'r1', title: 'Gone', steps, status: 'discarded', batch_id: null, revision: 1, created_at: '2026-09-16T12:00:00.000Z', updated_at: '2026-09-16T12:00:00.000Z' });
    expect(db.plans.nextId('r1')).toBe('r1-p4');
    expect(db.plans.get('r1-p1')).toMatchObject({ title: 'Accounts', steps, status: 'draft', batch_id: null, revision: 1 });
    expect(db.plans.get('nope')).toBeUndefined();
    expect(db.plans.drafts().map((p) => p.id)).toEqual(['r1-p2', 'r1-p1']);
    db.plans.update('r1-p1', { title: 'Accounts v2', steps: [steps[0]!], status: 'approved', batch_id: 'r1-b1', revision: 2 });
    const p = db.plans.get('r1-p1')!;
    expect(p).toMatchObject({ title: 'Accounts v2', steps: [steps[0]], status: 'approved', batch_id: 'r1-b1', revision: 2 });
    expect(p.updated_at > '2026-09-16T10:00:00.000Z').toBe(true);
  });

  it('adds batch_id to a worktrees table created without it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE worktrees (bead_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, verify_status TEXT, verify_output TEXT, review_note TEXT, conflict_files TEXT, merged_at TEXT, mr_url TEXT)');
    old.close();
    const db = openDb(file);
    const result = { status: 'pass' as const, command: 'pnpm test', head_sha: 'abc123', exit_code: 0, duration_ms: 123, output_tail: 'Tests 1 passed', counts: { passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0 } };
    db.worktrees.upsert({ bead_id: 'b9', repo_id: 'r', path: '/p', branch: 'bead/b9', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: 'r-b1', closed_at: null, review_round: null, review_findings: null, accepted_note: null, verify_command: 'pnpm test', verify_only_result: result });
    expect(db.worktrees.get('b9')).toMatchObject({ batch_id: 'r-b1', verify_command: 'pnpm test', verify_only_result: result });
  });

  it('adds label, exhausted_until and provider to an accounts table created without them', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, harness TEXT NOT NULL, kind TEXT NOT NULL, secret TEXT, home TEXT, created_at TEXT NOT NULL, last_login_at TEXT, last_verified_at TEXT, refresh_token TEXT, token_expires_at INTEGER)');
    old.close();
    const db = openDb(file);
    const columns = db.sql.prepare('PRAGMA table_info(accounts)').all();
    expect(columns).toContainEqual(expect.objectContaining({ name: 'label' }));
    expect(columns).toContainEqual(expect.objectContaining({ name: 'exhausted_until' }));
    expect(columns).toContainEqual(expect.objectContaining({ name: 'provider' }));
  });

  it('migrates existing repositories with null model filters and the user as batch approver', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL, verify_command TEXT, merge_mode TEXT NOT NULL, worker_limit INTEGER NOT NULL)');
    old.prepare('INSERT INTO repos (id,path,base_branch,verify_command,merge_mode,worker_limit) VALUES (?,?,?,?,?,?)').run('r1', '/tmp/r1', 'main', 'pnpm test', 'local-merge', 2);
    old.prepare('INSERT INTO repos (id,path,base_branch,verify_command,merge_mode,worker_limit) VALUES (?,?,?,?,?,?)').run('r2', '/tmp/r2', 'main', null, 'local-merge', 2);
    old.close();
    const db = openDb(file);
    // The new column arrives with its default, so a repository registered before the setting keeps approving by the user.
    expect(db.repos.get('r1')).toMatchObject({ batch_approver: 'user', merge_mode: 'local-merge', verify_command: 'pnpm test', review_command: null });
    expect(db.repos.all().map((repo) => repo.model_filter)).toEqual([null, null]);
    expect((db.sql.prepare('PRAGMA table_info(repos)').all() as { name: string }[]).map((column) => column.name)).toContain('model_filter');
  });

  it('migrates and round-trips the batch review check', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE batches (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, status TEXT NOT NULL, note TEXT, mr_url TEXT, conflict_files TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_at TEXT)');
    old.prepare('INSERT INTO batches (id,repo_id,title,branch,base_branch,status,note,mr_url,conflict_files,created_at,updated_at,merged_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('r1-b1', 'r1', 'Old batch', 'feature/old', 'main', 'open', null, null, null, 't0', 't0', null);
    old.close();
    const db = openDb(file);
    expect(db.batches.get('r1-b1')?.review_check).toBeNull();
    const check = { status: 'pass' as const, command: 'pnpm test', head_sha: 'abc123', exit_code: 0, duration_ms: 123, output_tail: 'Tests 1 passed', counts: { passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0 } };
    db.batches.update('r1-b1', { review_check: check });
    expect(db.batches.get('r1-b1')?.review_check).toEqual(check);
  });

  it('adds estimated_cost and cost_source to a sessions table created without them', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, harness TEXT NOT NULL, role TEXT NOT NULL, bead_id TEXT, repo_id TEXT, native_session_id TEXT, pid INTEGER, pid_started_at TEXT, start_commit TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, cost REAL)');
    old.close();
    const db = openDb(file);
    const columns = db.sql.prepare('PRAGMA table_info(sessions)').all();
    expect(columns).toContainEqual(expect.objectContaining({ name: 'estimated_cost' }));
    expect(columns).toContainEqual(expect.objectContaining({ name: 'cost_source' }));
    expect(columns).toContainEqual(expect.objectContaining({ name: 'resolved_model' }));
    expect(columns).toContainEqual(expect.objectContaining({ name: 'usage_baseline' }));
    db.sessions.insert({ id: 's9', harness: 'codex', role: 'worker', bead_id: 'b9', repo_id: 'r9', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/tmp/wt9', status: 'running', started_at: 't0', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: 'gpt-5.6-terra', cache_write_1h_tokens: 43_514, estimated_cost: 0.5, cost_source: 'estimated', resolved_model: 'gpt-5.6-terra', usage_baseline: '{"input":100}' });
    expect(db.sessions.get('s9')).toMatchObject({ cache_write_1h_tokens: 43_514, estimated_cost: 0.5, cost_source: 'estimated', resolved_model: 'gpt-5.6-terra', usage_baseline: '{"input":100}' });
  });

  it('adds token_expires_at to a sessions table created without it, and existing rows read null', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, harness TEXT NOT NULL, role TEXT NOT NULL, bead_id TEXT, repo_id TEXT, cwd TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL)');
    old.prepare('INSERT INTO sessions (id,harness,role,cwd,status,started_at) VALUES (?,?,?,?,?,?)').run('s-old', 'claude', 'worker', '/tmp/wt', 'ended', 't0');
    old.close();
    const db = openDb(file);
    const columns = db.sql.prepare('PRAGMA table_info(sessions)').all();
    expect(columns).toContainEqual(expect.objectContaining({ name: 'token_expires_at' }));
    expect(db.sessions.get('s-old')?.token_expires_at).toBeNull();
  });

  it('points every test database at a temp path, never the live default', () => {
    const live = loadConfig({}).dbPath;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    expect(live).toBe(path.join(os.homedir(), '.overseer', 'overseer.db'));
    expect(file).not.toBe(live);
    expect(file.startsWith(os.tmpdir())).toBe(true);
  });

  it('settings round-trip and seed defaults', () => {
    const db = openDb(':memory:');
    expect(db.settings.tiers()).toEqual(DEFAULT_TIERS);
    expect(db.settings.orchestrator()).toEqual({ model: null, effort: null, promptOverride: null });

    const custom = { tiers: [{ name: 'standard' as const, candidates: [{ harness: 'claude' as const, model: 'opus', effort: null }] }], denyModels: [] };
    db.settings.set('tiers', custom);
    expect(db.settings.tiers()).toEqual(custom);
  });

  it('sessions and repos carry tier/model and review_rounds', () => {
    const db = openDb(':memory:');
    db.repos.insert({ id: 'r2', path: '/tmp/r2', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: undefined as unknown as number });
    expect(db.repos.get('r2')?.review_rounds).toBe(2);

    db.sessions.insert({ id: 's2', harness: 'codex', role: 'worker', bead_id: 'b2', repo_id: 'r2', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/tmp/wt2', status: 'running', started_at: 't0', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: 'standard', model: 'gpt-5.6-terra' });
    expect(db.sessions.get('s2')).toMatchObject({ tier: 'standard', model: 'gpt-5.6-terra' });
  });

  it('worktree review_findings round-trips as an array', () => {
    const db = openDb(':memory:');
    db.repos.insert({ id: 'r3', path: '/tmp/r3', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 2 });
    const findings = [{ file: 'a.ts', summary: 'missing null check', severity: 'must' as const }];
    db.worktrees.upsert({ bead_id: 'b3', repo_id: 'r3', path: '/tmp/wt3', branch: 'bead/b3', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: 1, review_findings: findings, accepted_note: null });
    expect(db.worktrees.get('b3')?.review_findings).toEqual(findings);
  });

  describe('preflight runs', () => {
    it('records a probe run and finishes it', () => {
      const db = openDb(':memory:');
      db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: 'x', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0 });
      const run = db.preflight.insert({ repo_id: 'r1', kind: 'verify_probe', command: 'x', head_sha: 'abc1234' });
      expect(db.preflight.latest('r1')).toMatchObject({ id: run.id, result: null });
      db.preflight.finish(run.id, { result: 'fail', exit_code: 1, output_tail: 'exit 1' });
      expect(db.preflight.latest('r1')).toMatchObject({ result: 'fail', exit_code: 1, output_tail: 'exit 1' });
      expect(db.preflight.recent('r1', 20)).toHaveLength(1);
      expect(db.repos.get('r1')!.verify_suspect).toBeNull();
    });

    it('abandons an open run left by a daemon restart mid-probe', () => {
      const db = openDb(':memory:');
      db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: 'x', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0 });
      const run = db.preflight.insert({ repo_id: 'r1', kind: 'verify_probe', command: 'x', head_sha: 'abc1234' });
      db.preflight.abandonOpen();
      expect(db.preflight.get(run.id)).toMatchObject({ result: 'error', output_tail: 'daemon restarted during the probe' });
    });

    it('counts crash_class by harness', () => {
      const db = openDb(':memory:');
      db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: 'x', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0 });
      db.sessions.insert({ id: 's1', harness: 'codex', role: 'worker', bead_id: 'b1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/tmp/wt', status: 'running', started_at: 't0', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
      db.sessions.update('s1', { crash_class: 'transient' });
      db.sessions.insert({ id: 's2', harness: 'codex', role: 'worker', bead_id: 'b2', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/tmp/wt', status: 'running', started_at: 't0', ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
      db.sessions.update('s2', { crash_class: 'transient' });
      expect(db.preflight.crashCounts('r1')).toEqual([{ harness: 'codex', crash_class: 'transient', count: 2 }]);
    });
  });
});

function withProgramDb(testBody: (db: ReturnType<typeof openDb>) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-program-db-'));
  const file = path.join(dataDir, 'overseer.db');
  expect(path.resolve(file)).not.toBe(path.resolve(loadConfig({}).dbPath));
  try {
    const db = openDb(file);
    try { testBody(db); }
    finally { db.sql.close(); }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function insertProgramBatch(db: ReturnType<typeof openDb>, batchId: string, status = 'open'): void {
  db.sql.prepare('INSERT INTO batches (id,repo_id,title,branch,base_branch,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(batchId, 'r1', `Batch ${batchId}`, `feature/${batchId}`, 'main', status, '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
}

describe('program data tables', () => {
  it('stores programs and filters them by repo in newest-first order', () => withProgramDb((db) => {
    db.programs.insert({ id: 'p1', repo_id: 'r1', title: 'First request', status: 'open', created_at: '2026-09-27T00:00:00.000Z', origin_chat_id: 41 });
    db.programs.insert({ id: 'p2', repo_id: 'r1', title: 'Second request', status: 'done', created_at: '2026-09-28T00:00:00.000Z', origin_chat_id: null });
    db.programs.insert({ id: 'p3', repo_id: 'r2', title: 'Other repo', status: 'open', created_at: '2026-09-29T00:00:00.000Z', origin_chat_id: null });
    expect(db.programs.get('p1')).toMatchObject({ title: 'First request', status: 'open', origin_chat_id: 41 });
    expect(db.programs.forRepo('r1').map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(db.programs.all().map((p) => p.id)).toEqual(['p3', 'p2', 'p1']);
    db.programs.update('p1', { status: 'done' });
    expect(db.programs.get('p1')?.status).toBe('done');
    expect(() => db.programs.insert({ id: 'p4', repo_id: 'r1', title: '', status: 'open', created_at: 't0', origin_chat_id: null })).toThrow();
    expect(() => db.programs.insert({ id: 'p1', repo_id: 'r1', title: 'Duplicate', status: 'open', created_at: 't0', origin_chat_id: null })).toThrow();
  }));

  it('stores lane membership with ordered zero-based positions and rejects duplicate membership or position', () => withProgramDb((db) => {
    const rows = [
      { program_id: 'p1', batch_id: 'b1', lane: '#9365 → #9366', position: 0 },
      { program_id: 'p1', batch_id: 'b2', lane: '#9365 → #9366', position: 1 },
      { program_id: 'p1', batch_id: 'b3', lane: '#9354', position: 0 },
    ];
    rows.forEach((row) => db.programBatches.insert(row));
    expect(db.programBatches.forProgram('p1')).toEqual([rows[2], rows[0], rows[1]]);
    expect(() => db.programBatches.insert(rows[0]!)).toThrow();
    expect(() => db.programBatches.insert({ program_id: 'p1', batch_id: 'b4', lane: '#9365 → #9366', position: 1 })).toThrow();
    expect(() => db.programBatches.insert({ program_id: 'p1', batch_id: 'b4', lane: '', position: 2 })).toThrow();
    expect(() => db.programBatches.insert({ program_id: 'p1', batch_id: 'b4', lane: '#9365 → #9366', position: -1 })).toThrow();
  }));

  it('stores waits and releases them when the prerequisite batch is merged', () => withProgramDb((db) => {
    db.programBatches.insert({ program_id: 'p1', batch_id: 'b2', lane: 'lane', position: 0 });
    db.batchWaits.insert({ batch_id: 'b2', prerequisite_batch_id: 'b1' });
    insertProgramBatch(db, 'b1');
    expect(db.batchWaits.forProgram('p1')).toEqual([{ batch_id: 'b2', prerequisite_batch_id: 'b1', released: false }]);
    db.batches.update('b1', { status: 'merged' });
    expect(db.batchWaits.forProgram('p1')).toEqual([{ batch_id: 'b2', prerequisite_batch_id: 'b1', released: false }]);
    expect(db.batchWaits.releaseForPrerequisite('b1')).toBe(1);
    expect(db.batchWaits.forProgram('p1')).toEqual([{ batch_id: 'b2', prerequisite_batch_id: 'b1', released: true }]);
    expect(() => db.batchWaits.insert({ batch_id: 'b2', prerequisite_batch_id: 'b1' })).toThrow();
  }));

  it('stores a keyed chat notice once across repeated lifecycle delivery attempts', () => withProgramDb((db) => {
    const first = db.chat.insertOnce('program-wait-release:b2:b1', { role: 'system', kind: 'message', text: 'Program Release: batch b2 can start (b1 merged)', queued: true });
    const second = db.chat.insertOnce('program-wait-release:b2:b1', { role: 'system', kind: 'message', text: 'duplicate notice', queued: true });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row).toMatchObject({ id: first.row.id, text: first.row.text, queued_at: first.row.queued_at });
    expect(db.chat.all().filter((row) => row.text.includes('batch b2 can start'))).toHaveLength(1);
  }));

  it('stores program entries in chronological order without changing their text or collapsing duplicates', () => withProgramDb((db) => {
    const decision = { program_id: 'p1', kind: 'decision' as const, text: '  Keep the existing wording.\n', created_at: '2026-09-28T00:00:00.000Z', source_chat_id: 52 };
    db.programEntries.insert(decision);
    db.programEntries.insert({ program_id: 'p1', kind: 'ownership', text: 'Batch b2 owns the shared type.', created_at: '2026-09-28T00:01:00.000Z', source_chat_id: null });
    db.programEntries.insert({ program_id: 'p1', kind: 'note', text: 'Same note', created_at: '2026-09-28T00:02:00.000Z', source_chat_id: null });
    db.programEntries.insert({ program_id: 'p1', kind: 'note', text: 'Same note', created_at: '2026-09-28T00:03:00.000Z', source_chat_id: null });
    expect(db.programEntries.forProgram('p1')).toEqual([decision,
      { program_id: 'p1', kind: 'ownership', text: 'Batch b2 owns the shared type.', created_at: '2026-09-28T00:01:00.000Z', source_chat_id: null },
      { program_id: 'p1', kind: 'note', text: 'Same note', created_at: '2026-09-28T00:02:00.000Z', source_chat_id: null },
      { program_id: 'p1', kind: 'note', text: 'Same note', created_at: '2026-09-28T00:03:00.000Z', source_chat_id: null },
    ]);
    expect(() => db.programEntries.insert({ program_id: 'p1', kind: 'decision', text: '', created_at: 't0', source_chat_id: null })).toThrow();
  }));

  it('stores a replaceable merge order, including an empty order, and rolls back duplicates', () => withProgramDb((db) => {
    db.programs.insert({ id: 'p1', repo_id: 'r1', title: 'Program', status: 'open', created_at: 't0', origin_chat_id: null });
    db.programBatches.insert({ program_id: 'p1', batch_id: 'b1', lane: 'lane', position: 0 });
    db.programBatches.insert({ program_id: 'p1', batch_id: 'b2', lane: 'lane', position: 1 });
    db.mergeOrder.set('p1', ['b2', 'b1']);
    expect(db.mergeOrder.forProgram('p1')).toEqual(['b2', 'b1']);
    expect(() => db.mergeOrder.set('p1', ['b1', 'b1'])).toThrow();
    expect(() => db.mergeOrder.set('p1', ['missing'])).toThrow('batch missing is not in program p1');
    expect(db.mergeOrder.forProgram('p1')).toEqual(['b2', 'b1']);
    db.mergeOrder.set('p1', []);
    expect(db.mergeOrder.forProgram('p1')).toEqual([]);
  }));

  it('creates program tables while opening an existing database and preserves its rows', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-program-migration-'));
    const file = path.join(dataDir, 'overseer.db');
    expect(path.resolve(file)).not.toBe(path.resolve(loadConfig({}).dbPath));
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL, verify_command TEXT, merge_mode TEXT NOT NULL, worker_limit INTEGER NOT NULL)');
    old.prepare('INSERT INTO repos (id,path,base_branch,verify_command,merge_mode,worker_limit) VALUES (?,?,?,?,?,?)').run('r1', 'C:/legacy/repo', 'main', null, 'local-merge', 2);
    old.close();
    try {
      const db = openDb(file);
      try {
        const tables = (db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name);
        expect(tables).toEqual(expect.arrayContaining(['programs', 'program_batches', 'batch_waits', 'program_entries', 'merge_order']));
        expect(db.sql.prepare('SELECT path FROM repos WHERE id=?').get('r1')).toEqual({ path: 'C:/legacy/repo' });
      } finally { db.sql.close(); }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
