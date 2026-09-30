import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, BatchRow, BatchSignalKind, BatchSignalRow, BatchWait, ChatRow, DiscussionParticipant, DiscussionRow, DiscussionTurnRow, EventRow, OrchestratorSettings, Plan, PreflightReport, PreflightResult, PreflightRun, PreflightStep, Program, ProgramBatch, ProgramEntry, ProgramWait, Repo, ServerRow, ServerStatus, SessionRole, SessionRow, TierSettings, UsageBreakdownRow, UsageDay, UsageDayBreakdownRow, UsageGroup, UsageTotals, WorktreeRow } from '@overseer/shared';
import { ADDED_COLUMNS, ADDED_INDEXES, CHAT_SEEN_REPLIED_BACKFILL, SCHEMA } from './schema';
import { accountLoggedIn } from '../accounts/status';

export const DEFAULT_TIERS: TierSettings = {
  tiers: [
    { name: 'chore', candidates: [{ harness: 'codex', model: 'gpt-5.6-luna', effort: null }, { harness: 'claude', model: 'haiku', effort: null }] },
    { name: 'standard', candidates: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }, { harness: 'claude', model: 'sonnet', effort: null }] },
    { name: 'hard', candidates: [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }, { harness: 'claude', model: 'opus', effort: null }] },
    { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
  ],
  denyModels: ['gpt-6-astra'],
};

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;
export type GitlabMrState = 'opened' | 'merged' | 'closed';
type ProgramWaitEvent = BatchWait & { program_id: string; program_title: string };
type StoredDiscussionAttachment = { name: string; mime: string; size: number; path: string };
export type StoredAccount = Omit<Account, 'has_secret' | 'logged_in' | 'label'> & { label?: string | null; secret: string | null; refresh_token?: string | null; token_expires_at?: number | null; exhausted_until?: number | null };

const parsePlan = (r: Row | undefined): Plan | undefined =>
  r ? { ...(r as unknown as Plan), steps: JSON.parse(r.steps as string), revision: Number(r.revision) } : undefined;

/** Lower-case base32: readable in a branch or a path, and no character that git or a shell treats specially. */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const randomIdSuffix = (): string => Array.from({ length: 4 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');

export interface DbOptions {
  /** The random part of a new batch id; tests pass `() => ''` so ids read `r1-b1`. */
  batchIdSuffix?: () => string;
}
export const DB_BUSY_TIMEOUT_MS = 5_000;
/** SQLite page cache in KiB (negative, so the value is KiB): the board's full scans otherwise spill a multi-hundred-MB sessions table through the default 2 MB. */
export const DB_CACHE_SIZE_KB = -32768;
const suffix = (make: () => string = randomIdSuffix): string => { const s = make(); return s ? `-${s}` : ''; };

/** The token and cost columns every usage query sums, with the session table aliased `s`. Each money field is a floor: the `*_unknown` counts say how many sessions in the bucket contributed no such figure. */
const USAGE_SELECT = `COUNT(*) AS sessions,
  COALESCE(SUM(s.cost),0) AS reported_cost, COUNT(*) FILTER (WHERE s.cost IS NULL) AS reported_unknown,
  COALESCE(SUM(s.estimated_cost),0) AS estimated_cost, COUNT(*) FILTER (WHERE s.estimated_cost IS NULL) AS estimated_unknown,
  COUNT(*) FILTER (WHERE s.harness = 'codex') AS codex_sessions,
  COALESCE(SUM(s.input_tokens),0) AS input_tokens, COALESCE(SUM(s.output_tokens),0) AS output_tokens,
  COALESCE(SUM(s.cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(s.cache_write_tokens),0) AS cache_write_tokens,
  COALESCE(SUM(s.cache_write_1h_tokens),0) AS cache_write_1h_tokens, COALESCE(SUM(s.reasoning_tokens),0) AS reasoning_tokens`;
/** Orders a breakdown by spend: reported cost where a session has one, else its estimate, the same reported-wins-else-estimate rule `cost_source` already applies — never the two added together. Used for ordering only, never returned. */
const USAGE_SPEND = 'SUM(COALESCE(s.cost, s.estimated_cost, 0))';
/** Per dimension: the group key, the readable label (NULL where the dimension has no name of its own) and the join behind it. */
const USAGE_GROUPS: Record<UsageGroup, { key: string; label: string; join: string }> = {
  model: { key: 'COALESCE(s.resolved_model, s.model)', label: 'NULL', join: '' },
  account: { key: 's.account', label: 'COALESCE(a.label, a.name)', join: 'LEFT JOIN accounts a ON a.id = s.account' },
  harness: { key: 's.harness', label: 'NULL', join: '' },
  repo: { key: 's.repo_id', label: 'r.path', join: 'LEFT JOIN repos r ON r.id = s.repo_id' },
  batch: { key: 's.batch_id', label: 'b.title', join: 'LEFT JOIN batches b ON b.id = s.batch_id' },
};
const usageTotals = (r: Row): UsageTotals => ({
  sessions: Number(r.sessions),
  reported_cost: Number(r.reported_cost),
  reported_unknown: Number(r.reported_unknown),
  estimated_cost: Number(r.estimated_cost),
  estimated_unknown: Number(r.estimated_unknown),
  codex_sessions: Number(r.codex_sessions),
  tokens: {
    input: Number(r.input_tokens), output: Number(r.output_tokens),
    cache_read: Number(r.cache_read_tokens), cache_write: Number(r.cache_write_tokens),
    cache_write_1h: Number(r.cache_write_1h_tokens), reasoning: Number(r.reasoning_tokens),
  },
});
const usageKey = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class Db {
  constructor(readonly sql: DatabaseSync, private opts: DbOptions = {}) {}

  repos = {
    insert: (r: Omit<Repo, 'model_filter'> & { model_filter?: Repo['model_filter'] }) => this.sql.prepare('INSERT INTO repos (id,path,base_branch,verify_command,review_command,merge_mode,batch_approver,worker_limit,setup_command,review_rounds,model_filter) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(r.id, r.path, r.base_branch, r.verify_command, r.review_command ?? null, r.merge_mode, r.batch_approver ?? 'user', r.worker_limit, r.setup_command ?? null, r.review_rounds ?? 2, r.model_filter ? JSON.stringify(r.model_filter) : null),
    get: (id: string) => this.parseRepo(this.sql.prepare('SELECT * FROM repos WHERE id=?').get(id) as Row | undefined),
    all: () => (this.sql.prepare('SELECT * FROM repos ORDER BY id').all() as Row[]).map((r) => this.parseRepo(r)!),
    update: (id: string, patch: Partial<Repo>) => this.patch('repos', 'id', id, {
      ...patch,
      ...(patch.model_filter !== undefined ? { model_filter: patch.model_filter ? JSON.stringify(patch.model_filter) : null } : {}),
    } as Row),
    delete: (id: string) => {
      this.sql.prepare('DELETE FROM preflight_runs WHERE repo_id=?').run(id);
      this.sql.prepare('DELETE FROM repos WHERE id=?').run(id);
    },
  };

  sessions = {
    insert: (s: SessionRow) => this.sql.prepare('INSERT INTO sessions (id,harness,role,bead_id,repo_id,native_session_id,pid,pid_started_at,start_commit,cwd,status,started_at,ended_at,cost,batch_id,log_path,log_offset,last_text,end_reason,verify_only,needs_server,tier,model,account,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_write_1h_tokens,reasoning_tokens,estimated_cost,cost_source,resolved_model,usage_baseline,bead_title,token_expires_at,auth_resumed,discussion_id,discussion_kind,harness_forced) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(s.id, s.harness, s.role, s.bead_id, s.repo_id, s.native_session_id, s.pid, s.pid_started_at, s.start_commit, s.cwd, s.status, s.started_at, s.ended_at, s.cost, s.batch_id, s.log_path, s.log_offset, s.last_text ?? null, s.end_reason ?? null, s.verify_only ?? 0, s.needs_server ?? 0, s.tier, s.model, s.account ?? null, s.input_tokens ?? null, s.output_tokens ?? null, s.cache_read_tokens ?? null, s.cache_write_tokens ?? null, s.cache_write_1h_tokens ?? null, s.reasoning_tokens ?? null, s.estimated_cost ?? null, s.cost_source ?? null, s.resolved_model ?? null, s.usage_baseline ?? null, s.bead_title ?? null, s.token_expires_at ?? null, s.auth_resumed ?? null, s.discussion_id ?? null, s.discussion_kind ?? null, s.harness_forced ?? null),
    update: (id: string, patch: Partial<SessionRow>) => this.patch('sessions', 'id', id, patch),
    get: (id: string) => this.sql.prepare('SELECT * FROM sessions WHERE id=?').get(id) as SessionRow | undefined,
    running: () => this.sql.prepare("SELECT * FROM sessions WHERE status='running'").all() as unknown as SessionRow[],
    all: () => this.sql.prepare('SELECT * FROM sessions ORDER BY started_at').all() as unknown as SessionRow[],
    forBead: (beadId: string) => this.sql.prepare('SELECT * FROM sessions WHERE bead_id=? ORDER BY started_at').all(beadId) as unknown as SessionRow[],
    /** The participant sessions of one discussion, newest first. */
    forDiscussion: (discussionId: string) => this.sql.prepare('SELECT * FROM sessions WHERE discussion_id=? ORDER BY started_at').all(discussionId) as unknown as SessionRow[],
    runningWorkersForRepo: (repoId: string) => this.sql.prepare("SELECT * FROM sessions WHERE repo_id=? AND role='worker' AND status='running'").all(repoId) as unknown as SessionRow[],
    latest: (role: SessionRole) => this.sql.prepare('SELECT * FROM sessions WHERE role=? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(role) as SessionRow | undefined,
    /** With their events: a removed repository's task records go, and its cost total with them (round 20: a re-registration inherited the previous one's spend). */
    deleteForRepo: (repoId: string) => {
      this.sql.prepare('DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE repo_id=?)').run(repoId);
      this.sql.prepare('DELETE FROM sessions WHERE repo_id=?').run(repoId);
    },
  };

  discussions = {
    insert: (d: DiscussionRow, attachments: StoredDiscussionAttachment[] = []) => this.sql.prepare('INSERT INTO discussions (id,question,repo_id,status,stop_reason,cost_cap,created_at,ended_at,synthesis,synthesis_cost,attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(d.id, d.question, d.repo_id, d.status, d.stop_reason, d.cost_cap, d.created_at, d.ended_at, d.synthesis, d.synthesis_cost ?? null, attachments.length ? JSON.stringify(attachments) : null),
    get: (id: string) => this.parseDiscussion(this.sql.prepare('SELECT * FROM discussions WHERE id=?').get(id) as Row | undefined),
    all: () => (this.sql.prepare('SELECT * FROM discussions ORDER BY created_at DESC, rowid DESC').all() as Row[]).map((r) => this.parseDiscussion(r)!),
    running: () => (this.sql.prepare("SELECT * FROM discussions WHERE status='running' ORDER BY created_at").all() as Row[]).map((r) => this.parseDiscussion(r)!),
    forRepo: (repoId: string) => (this.sql.prepare('SELECT * FROM discussions WHERE repo_id=? ORDER BY created_at').all(repoId) as Row[]).map((r) => this.parseDiscussion(r)!),
    /** Stored file paths are available only to the cwd-copying and serving code. */
    storedAttachments: (id: string): StoredDiscussionAttachment[] => this.readDiscussionAttachments(id),
    /** The stored file info for the serving route. */
    attachment: (id: string, index: number): StoredDiscussionAttachment | undefined =>
      Number.isInteger(index) && index >= 0 ? this.readDiscussionAttachments(id)[index] : undefined,
    update: (id: string, patch: Partial<DiscussionRow>) => this.patch('discussions', 'id', id, patch),
    turns: (id: string) => this.sql.prepare('SELECT * FROM discussion_turns WHERE discussion_id=? ORDER BY round, id').all(id) as unknown as DiscussionTurnRow[],
    hasTurn: (id: string, round: number, harness: string): boolean =>
      !!this.sql.prepare('SELECT 1 FROM discussion_turns WHERE discussion_id=? AND round=? AND harness=? LIMIT 1').get(id, round, harness),
    insertTurn: (t: Omit<DiscussionTurnRow, 'id'>) => this.sql.prepare('INSERT INTO discussion_turns (discussion_id,round,harness,session_id,text,cost,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(t.discussion_id, t.round, t.harness, t.session_id, t.text, t.cost, t.created_at),
    /** The snapshot of a discussion's participants a repository removal wrote before deleting their session rows; empty until then. */
    participants: (id: string) => this.sql.prepare('SELECT harness,session_id,status,cost FROM discussion_participants WHERE discussion_id=? ORDER BY harness').all(id) as unknown as DiscussionParticipant[],
    /** Replaces a discussion's participant snapshot: the harnesses, their final status and their final cost, kept though their sessions are gone. */
    saveParticipants: (id: string, participants: DiscussionParticipant[]) => {
      this.sql.prepare('DELETE FROM discussion_participants WHERE discussion_id=?').run(id);
      const stmt = this.sql.prepare('INSERT INTO discussion_participants (discussion_id,harness,session_id,status,cost) VALUES (?,?,?,?,?)');
      for (const p of participants) stmt.run(id, p.harness, p.session_id, p.status, p.cost);
    },
  };

  /** One grouped query per bucket for `GET /api/usage`: totals, one row per UTC calendar day, one row per group key. Aggregated in SQL so thousands of sessions cost one scan per bucket, not one row per session over the wire. */
  usage = {
    totals: (from: string, to: string): UsageTotals =>
      usageTotals(this.sql.prepare(`SELECT ${USAGE_SELECT} FROM sessions s WHERE s.started_at>=? AND s.started_at<?`).get(from, to) as Row),
    days: (from: string, to: string): UsageDay[] =>
      (this.sql.prepare(`SELECT substr(s.started_at,1,10) AS day, ${USAGE_SELECT} FROM sessions s WHERE s.started_at>=? AND s.started_at<? GROUP BY day ORDER BY day`).all(from, to) as Row[])
        .map((r) => ({ day: String(r.day), ...usageTotals(r) })),
    by: (group: UsageGroup, from: string, to: string): UsageBreakdownRow[] => {
      const g = USAGE_GROUPS[group];
      const rows = this.sql.prepare(`SELECT ${g.key} AS key, MAX(${g.label}) AS label, ${USAGE_SELECT} FROM sessions s ${g.join} WHERE s.started_at>=? AND s.started_at<? GROUP BY ${g.key} ORDER BY ${USAGE_SPEND} DESC, key IS NULL, key ASC`).all(from, to) as Row[];
      return rows.map((r) => ({ key: usageKey(r.key), label: usageKey(r.label), ...usageTotals(r) }));
    },
    /** The same sums split by calendar day and group key, oldest day first: one query, so a stacked-by-model day series costs one scan rather than one per day. */
    daysBy: (group: UsageGroup, from: string, to: string): UsageDayBreakdownRow[] => {
      const g = USAGE_GROUPS[group];
      const rows = this.sql.prepare(`SELECT substr(s.started_at,1,10) AS day, ${g.key} AS key, MAX(${g.label}) AS label, ${USAGE_SELECT} FROM sessions s ${g.join} WHERE s.started_at>=? AND s.started_at<? GROUP BY day, ${g.key} ORDER BY day, ${USAGE_SPEND} DESC, key IS NULL, key ASC`).all(from, to) as Row[];
      return rows.map((r) => ({ day: String(r.day), key: usageKey(r.key), label: usageKey(r.label), ...usageTotals(r) }));
    },
  };

  accounts = {
    list: (): Account[] => (this.sql.prepare('SELECT id,name,label,harness,kind,provider,home,created_at,last_login_at,last_verified_at,secret FROM accounts ORDER BY created_at').all() as unknown as StoredAccount[]).map(({ secret, label, ...account }) => ({ ...account, label: label ?? null, has_secret: !!secret, logged_in: accountLoggedIn({ ...account, secret }) })),
    get: (id: string) => this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(id) as StoredAccount | undefined,
    insert: (a: Omit<StoredAccount, 'label' | 'provider' | 'secret' | 'refresh_token' | 'token_expires_at' | 'exhausted_until'> & { label?: string | null; provider?: string | null; secret?: string | null; refresh_token?: string | null; token_expires_at?: number | null; exhausted_until?: number | null }) => this.sql.prepare('INSERT INTO accounts (id,name,label,harness,kind,provider,secret,home,created_at,last_login_at,last_verified_at,refresh_token,token_expires_at,exhausted_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a.id,a.name,a.label ?? null,a.harness,a.kind,a.provider ?? null,a.secret ?? null,a.home,a.created_at,a.last_login_at,a.last_verified_at,a.refresh_token ?? null,a.token_expires_at ?? null,a.exhausted_until ?? null),
    update: (id: string, patch: Partial<StoredAccount>) => this.patch('accounts', 'id', id, patch),
    remove: (id: string) => this.sql.prepare('DELETE FROM accounts WHERE id=?').run(id),
  };

  worktrees = {
    upsert: (w: WorktreeRow) => this.sql.prepare('INSERT OR REPLACE INTO worktrees (bead_id,repo_id,path,branch,base_branch,verify_status,verify_output,review_note,conflict_files,merged_at,mr_url,batch_id,closed_at,review_round,review_findings,accepted_note,created_dirty,verify_command,verify_only_result,evidence_gate_failures) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(w.bead_id, w.repo_id, w.path, w.branch, w.base_branch, w.verify_status, w.verify_output, w.review_note, w.conflict_files ? JSON.stringify(w.conflict_files) : null, w.merged_at, w.mr_url, w.batch_id, w.closed_at, w.review_round, w.review_findings ? JSON.stringify(w.review_findings) : null, w.accepted_note, w.created_dirty === undefined ? null : JSON.stringify(w.created_dirty), w.verify_command ?? null, w.verify_only_result ? JSON.stringify(w.verify_only_result) : null, w.evidence_gate_failures ?? 0),
    update: (beadId: string, patch: Partial<WorktreeRow>) => this.patch('worktrees', 'bead_id', beadId, { ...patch, ...(patch.conflict_files !== undefined ? { conflict_files: patch.conflict_files ? JSON.stringify(patch.conflict_files) : null } : {}), ...(patch.review_findings !== undefined ? { review_findings: patch.review_findings ? JSON.stringify(patch.review_findings) : null } : {}), ...(patch.review_carried !== undefined ? { review_carried: patch.review_carried ? JSON.stringify(patch.review_carried) : null } : {}), ...(patch.verify_only_result !== undefined ? { verify_only_result: patch.verify_only_result ? JSON.stringify(patch.verify_only_result) : null } : {}) } as Row),
    get: (beadId: string) => this.parseWt(this.sql.prepare('SELECT * FROM worktrees WHERE bead_id=?').get(beadId) as Row | undefined),
    forRepo: (repoId: string) => (this.sql.prepare('SELECT * FROM worktrees WHERE repo_id=?').all(repoId) as Row[]).map((r) => this.parseWt(r)!),
    forBatch: (batchId: string) => (this.sql.prepare('SELECT * FROM worktrees WHERE batch_id=?').all(batchId) as Row[]).map((r) => this.parseWt(r)!),
    delete: (beadId: string) => this.sql.prepare('DELETE FROM worktrees WHERE bead_id=?').run(beadId),
  };

  batches = {
    /**
     * `<repo>-b<n>-<4 random chars>`: the counter keeps ids readable and in order; the random part makes them unique across installs and
     * data-dir resets, since the `overseer:batch:<id>` label lives in the repository's `.beads` and outlives `~/.overseer` (round 17: a
     * fresh database minted `<repo>-b1` again and the batch adopted the previous install's beads).
     */
    nextId: (repoId: string) => `${repoId}-b${(this.sql.prepare('SELECT COUNT(*) AS n FROM batches WHERE repo_id=?').get(repoId) as { n: number }).n + 1}${suffix(this.opts.batchIdSuffix)}`,
    insert: (b: BatchRow) => this.sql.prepare('INSERT INTO batches (id,repo_id,title,branch,base_branch,status,note,history,mr_url,conflict_files,created_at,updated_at,merged_at,merged_commit,setup_at,review_check,waiting_on,overlap_files,refresh_from,refresh_head,origin_chat_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(b.id, b.repo_id, b.title, b.branch, b.base_branch, b.status, b.note, b.history, b.mr_url, b.conflict_files ? JSON.stringify(b.conflict_files) : null, b.created_at, b.updated_at, b.merged_at, b.merged_commit, b.setup_at ?? null, b.review_check ? JSON.stringify(b.review_check) : null, b.waiting_on ?? null, b.overlap_files ? JSON.stringify(b.overlap_files) : null, b.refresh_from ?? null, b.refresh_head ?? null, b.origin_chat_id ?? null),
    get: (id: string) => this.parseBatch(this.sql.prepare('SELECT * FROM batches WHERE id=?').get(id) as Row | undefined),
    delete: (id: string) => this.sql.prepare('DELETE FROM batches WHERE id=?').run(id),
    forRepo: (repoId: string) => (this.sql.prepare('SELECT * FROM batches WHERE repo_id=? ORDER BY created_at').all(repoId) as Row[]).map((r) => this.parseBatch(r)!),
    all: () => (this.sql.prepare('SELECT * FROM batches ORDER BY created_at').all() as Row[]).map((r) => this.parseBatch(r)!),
    update: (id: string, patch: Partial<BatchRow>) => this.patch('batches', 'id', id, { ...patch, updated_at: now(), ...(patch.conflict_files !== undefined ? { conflict_files: patch.conflict_files ? JSON.stringify(patch.conflict_files) : null } : {}), ...(patch.overlap_files !== undefined ? { overlap_files: patch.overlap_files ? JSON.stringify(patch.overlap_files) : null } : {}), ...(patch.review_check !== undefined ? { review_check: patch.review_check ? JSON.stringify(patch.review_check) : null } : {}) } as Row),
  };

  programs = {
    insert: (p: Program) => this.sql.prepare('INSERT INTO programs (id,repo_id,title,status,created_at,origin_chat_id) VALUES (?,?,?,?,?,?)').run(p.id, p.repo_id, p.title, p.status, p.created_at, p.origin_chat_id),
    get: (id: string) => this.sql.prepare('SELECT * FROM programs WHERE id=?').get(id) as Program | undefined,
    forRepo: (repoId: string) => this.sql.prepare('SELECT * FROM programs WHERE repo_id=? ORDER BY created_at DESC, id DESC').all(repoId) as unknown as Program[],
    all: () => this.sql.prepare('SELECT * FROM programs ORDER BY created_at DESC, id DESC').all() as unknown as Program[],
    update: (id: string, patch: Partial<Pick<Program, 'title' | 'status'>>) => this.patch('programs', 'id', id, patch as Row),
  };

  programBatches = {
    insert: (b: ProgramBatch) => this.sql.prepare('INSERT INTO program_batches (program_id,batch_id,lane,position) VALUES (?,?,?,?)').run(b.program_id, b.batch_id, b.lane, b.position),
    forProgram: (programId: string) => this.sql.prepare('SELECT program_id,batch_id,lane,position FROM program_batches WHERE program_id=? ORDER BY lane, position, batch_id').all(programId) as unknown as ProgramBatch[],
  };

  batchWaits = {
    insert: (w: BatchWait) => {
      const merged = (this.sql.prepare("SELECT 1 FROM batches WHERE id=? AND status='merged'").get(w.prerequisite_batch_id));
      const releasedAt = merged ? now() : null;
      return this.sql.prepare('INSERT INTO batch_waits (batch_id,prerequisite_batch_id,released_at,release_notice_at) VALUES (?,?,?,?)').run(w.batch_id, w.prerequisite_batch_id, releasedAt, releasedAt);
    },
    forProgram: (programId: string): ProgramWait[] => {
      const rows = this.sql.prepare(`SELECT w.batch_id,w.prerequisite_batch_id,
        CASE WHEN w.released_at IS NOT NULL THEN 1 ELSE 0 END AS released
        FROM program_batches pb JOIN batch_waits w ON w.batch_id=pb.batch_id
        WHERE pb.program_id=? ORDER BY w.batch_id,w.prerequisite_batch_id`).all(programId) as unknown as (BatchWait & { released: number })[];
      return rows.map((row) => ({ batch_id: row.batch_id, prerequisite_batch_id: row.prerequisite_batch_id, released: row.released === 1 }));
    },
    unreleasedForBatch: (batchId: string): (BatchWait & { prerequisite_status: string | null })[] => this.sql.prepare(`SELECT w.batch_id,w.prerequisite_batch_id,
      prerequisite.status AS prerequisite_status
      FROM batch_waits w LEFT JOIN batches prerequisite ON prerequisite.id=w.prerequisite_batch_id
      WHERE w.batch_id=? AND w.released_at IS NULL ORDER BY w.prerequisite_batch_id`).all(batchId) as unknown as (BatchWait & { prerequisite_status: string | null })[],
    releaseForPrerequisite: (prerequisiteBatchId: string) => Number(this.sql.prepare(`UPDATE batch_waits SET released_at=?
      WHERE prerequisite_batch_id=? AND released_at IS NULL
      AND EXISTS (SELECT 1 FROM batches prerequisite WHERE prerequisite.id=batch_waits.prerequisite_batch_id AND prerequisite.status='merged')`).run(now(), prerequisiteBatchId).changes),
    releaseMergedPrerequisites: () => Number(this.sql.prepare(`UPDATE batch_waits SET released_at=?
      WHERE released_at IS NULL
      AND EXISTS (SELECT 1 FROM batches prerequisite WHERE prerequisite.id=batch_waits.prerequisite_batch_id AND prerequisite.status='merged')`).run(now()).changes),
    pendingReleaseNotices: (): ProgramWaitEvent[] => this.sql.prepare(`SELECT w.batch_id,w.prerequisite_batch_id,
      (SELECT p.id FROM program_batches pb JOIN programs p ON p.id=pb.program_id WHERE pb.batch_id=w.batch_id ORDER BY p.created_at,p.id LIMIT 1) AS program_id,
      (SELECT p.title FROM program_batches pb JOIN programs p ON p.id=pb.program_id WHERE pb.batch_id=w.batch_id ORDER BY p.created_at,p.id LIMIT 1) AS program_title
      FROM batch_waits w JOIN batches prerequisite ON prerequisite.id=w.prerequisite_batch_id
      JOIN batches dependent ON dependent.id=w.batch_id
      WHERE w.released_at IS NOT NULL AND w.release_notice_at IS NULL AND prerequisite.status='merged' AND dependent.status='open'
      AND NOT EXISTS (SELECT 1 FROM batch_waits other WHERE other.batch_id=w.batch_id AND other.released_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM batch_waits newer WHERE newer.batch_id=w.batch_id AND newer.released_at IS NOT NULL
        AND (newer.released_at>w.released_at OR (newer.released_at=w.released_at AND newer.prerequisite_batch_id>w.prerequisite_batch_id)))
      ORDER BY w.batch_id,w.prerequisite_batch_id`).all() as unknown as ProgramWaitEvent[],
    pendingAbandonNotices: (): ProgramWaitEvent[] => this.sql.prepare(`SELECT w.batch_id,w.prerequisite_batch_id,
      (SELECT p.id FROM program_batches pb JOIN programs p ON p.id=pb.program_id WHERE pb.batch_id=w.batch_id ORDER BY p.created_at,p.id LIMIT 1) AS program_id,
      (SELECT p.title FROM program_batches pb JOIN programs p ON p.id=pb.program_id WHERE pb.batch_id=w.batch_id ORDER BY p.created_at,p.id LIMIT 1) AS program_title
      FROM batch_waits w JOIN batches prerequisite ON prerequisite.id=w.prerequisite_batch_id
      JOIN batches dependent ON dependent.id=w.batch_id
      WHERE w.released_at IS NULL AND w.abandon_notice_at IS NULL AND prerequisite.status='abandoned' AND dependent.status='open'
      ORDER BY w.batch_id,w.prerequisite_batch_id`).all() as unknown as ProgramWaitEvent[],
    markReleaseNoticeSent: (w: BatchWait) => Number(this.sql.prepare('UPDATE batch_waits SET release_notice_at=? WHERE batch_id=? AND released_at IS NOT NULL AND release_notice_at IS NULL').run(now(), w.batch_id).changes),
    markAbandonNoticeSent: (w: BatchWait) => Number(this.sql.prepare('UPDATE batch_waits SET abandon_notice_at=? WHERE batch_id=? AND prerequisite_batch_id=? AND abandon_notice_at IS NULL').run(now(), w.batch_id, w.prerequisite_batch_id).changes),
  };

  programEntries = {
    insert: (e: ProgramEntry) => this.sql.prepare('INSERT INTO program_entries (program_id,kind,text,created_at,source_chat_id) VALUES (?,?,?,?,?)').run(e.program_id, e.kind, e.text, e.created_at, e.source_chat_id),
    forProgram: (programId: string) => this.sql.prepare('SELECT program_id,kind,text,created_at,source_chat_id FROM program_entries WHERE program_id=? ORDER BY created_at,rowid').all(programId) as unknown as ProgramEntry[],
  };

  mergeOrder = {
    /** Replace the ordered batch list as one transaction; each id must already be linked to this program. */
    set: (programId: string, batchIds: string[]) => {
      this.sql.exec('BEGIN IMMEDIATE');
      try {
        if (!this.programs.get(programId)) throw new Error(`program ${programId} not found`);
        const linked = this.sql.prepare('SELECT 1 FROM program_batches WHERE program_id=? AND batch_id=?');
        const insert = this.sql.prepare('INSERT INTO merge_order (program_id,position,batch_id) VALUES (?,?,?)');
        this.sql.prepare('DELETE FROM merge_order WHERE program_id=?').run(programId);
        batchIds.forEach((batchId, position) => {
          if (!linked.get(programId, batchId)) throw new Error(`batch ${batchId} is not in program ${programId}`);
          insert.run(programId, position, batchId);
        });
        this.sql.exec('COMMIT');
      } catch (error) {
        this.sql.exec('ROLLBACK');
        throw error;
      }
    },
    forProgram: (programId: string): string[] => (this.sql.prepare('SELECT batch_id FROM merge_order WHERE program_id=? ORDER BY position').all(programId) as { batch_id: string }[]).map((row) => row.batch_id),
  };

  /** The last valid state observed for an MR; observing `opened` again permits a later close notice. */
  gitlabMrStates = {
    get: (mrUrl: string): GitlabMrState | undefined => (this.sql.prepare('SELECT state FROM gitlab_mr_states WHERE mr_url=?').get(mrUrl) as { state: GitlabMrState } | undefined)?.state,
    transition: (mrUrl: string, state: GitlabMrState): boolean => {
      const r = this.sql.prepare(`INSERT INTO gitlab_mr_states (mr_url,state,updated_at) VALUES (?,?,?)
        ON CONFLICT(mr_url) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
        WHERE gitlab_mr_states.state <> excluded.state`).run(mrUrl, state, now());
      return Number(r.changes) > 0;
    },
  };

  /** Which chat messages were acted on for a batch, the links the Chat outcome chips read (the same pair twice is one row). */
  chatLinks = {
    link: (chatId: number, batchId: string) => this.sql.prepare('INSERT OR IGNORE INTO chat_batch_links (chat_id,batch_id,created_at) VALUES (?,?,?)').run(chatId, batchId, now()),
    /** The chat ids linked to a batch, oldest first. */
    forBatch: (batchId: string): number[] => (this.sql.prepare('SELECT chat_id FROM chat_batch_links WHERE batch_id=? ORDER BY chat_id').all(batchId) as { chat_id: number }[]).map((r) => Number(r.chat_id)),
  };

  plans = {
    /**
     * `<repo>-p<n>`: plans never reach the repository, so unlike batch ids they need no random part.
     * COUNT(*) is safe as a counter only because discard changes a plan's status and never deletes the row, so the count
     * only grows and an id is never reused; a delete path would need a different scheme (e.g. a separate sequence).
     */
    nextId: (repoId: string) => `${repoId}-p${(this.sql.prepare('SELECT COUNT(*) AS n FROM plans WHERE repo_id=?').get(repoId) as { n: number }).n + 1}`,
    insert: (p: Plan) => this.sql.prepare('INSERT INTO plans (id,repo_id,title,steps,status,batch_id,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(p.id, p.repo_id, p.title, JSON.stringify(p.steps), p.status, p.batch_id, p.revision, p.created_at, p.updated_at),
    get: (id: string) => parsePlan(this.sql.prepare('SELECT * FROM plans WHERE id=?').get(id) as Row | undefined),
    drafts: () => (this.sql.prepare("SELECT * FROM plans WHERE status='draft' ORDER BY created_at DESC, rowid DESC").all() as Row[]).map((r) => parsePlan(r)!),
    all: () => (this.sql.prepare('SELECT * FROM plans ORDER BY created_at DESC, rowid DESC').all() as Row[]).map((r) => parsePlan(r)!),
    update: (id: string, patch: Partial<Pick<Plan, 'title' | 'steps' | 'status' | 'batch_id' | 'revision'>>) =>
      this.patch('plans', 'id', id, { ...patch, updated_at: now(), ...(patch.steps ? { steps: JSON.stringify(patch.steps) } : {}) } as Row),
  };

  /** What went wrong or needed a human during a batch, recorded as it happens; `batch_retrospective` reads it back (see lifecycle/retrospective.ts). */
  signals = {
    insert: (s: { batch_id: string; bead_id: string | null; kind: BatchSignalKind; text: string }): BatchSignalRow => {
      const ts = now();
      const r = this.sql.prepare('INSERT INTO batch_signals (batch_id,bead_id,kind,text,ts) VALUES (?,?,?,?,?)').run(s.batch_id, s.bead_id, s.kind, s.text, ts);
      return { id: Number(r.lastInsertRowid), ...s, ts };
    },
    forBatch: (batchId: string) => this.sql.prepare('SELECT * FROM batch_signals WHERE batch_id=? ORDER BY id').all(batchId) as unknown as BatchSignalRow[],
  };

  preflight = {
    insert: (r: { repo_id: string; kind: 'verify_probe'; command: string; head_sha: string | null }): PreflightRun => {
      const started_at = now();
      const x = this.sql.prepare('INSERT INTO preflight_runs (repo_id,kind,step,command,head_sha,started_at) VALUES (?,?,?,?,?,?)').run(r.repo_id, r.kind, 'verify', r.command, r.head_sha, started_at);
      return { id: Number(x.lastInsertRowid), ...r, step: 'verify', result: null, exit_code: null, output_tail: null, started_at, ended_at: null };
    },
    /** `step`/`command` correct the row when the probe's failing step was setup, not verify (the insert always guesses verify); omitted, they keep what `insert` recorded. */
    finish: (id: number, f: { result: PreflightResult; exit_code: number | null; output_tail: string; step?: PreflightStep; command?: string }) =>
      this.sql.prepare('UPDATE preflight_runs SET result=?, exit_code=?, output_tail=?, ended_at=?, step=COALESCE(?,step), command=COALESCE(?,command) WHERE id=?')
        .run(f.result, f.exit_code, f.output_tail, now(), f.step ?? null, f.command ?? null, id),
    latest: (repoId: string) => this.sql.prepare('SELECT * FROM preflight_runs WHERE repo_id=? ORDER BY id DESC LIMIT 1').get(repoId) as PreflightRun | undefined,
    get: (id: number) => this.sql.prepare('SELECT * FROM preflight_runs WHERE id=?').get(id) as PreflightRun | undefined,
    recent: (repoId: string, limit: number) => this.sql.prepare('SELECT * FROM preflight_runs WHERE repo_id=? ORDER BY id DESC LIMIT ?').all(repoId, limit) as unknown as PreflightRun[],
    crashCounts: (repoId: string) => this.sql.prepare("SELECT harness, crash_class, COUNT(*) AS count FROM sessions WHERE repo_id=? AND crash_class IS NOT NULL GROUP BY harness, crash_class ORDER BY harness, crash_class").all(repoId) as unknown as PreflightReport['crashes'],
    /** A run left `result IS NULL` by a probe the daemon never finished (crash or restart mid-probe): closed at startup so its card does not read "probe: running" forever. */
    abandonOpen: () => this.sql.prepare("UPDATE preflight_runs SET result='error', output_tail='daemon restarted during the probe', ended_at=? WHERE result IS NULL").run(now()),
  };

  servers = {
    insert: (r: ServerRow): ServerRow => {
      this.sql.prepare('INSERT INTO servers (id,session_id,repo_id,bead_id,name,command,cwd,pid,pid_started_at,log_path,status,started_at,stopped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(r.id, r.session_id, r.repo_id, r.bead_id, r.name, r.command, r.cwd, r.pid, r.pid_started_at, r.log_path, r.status, r.started_at, r.stopped_at);
      return r;
    },
    update: (id: string, f: { status?: ServerStatus; stopped_at?: string | null }) =>
      this.sql.prepare('UPDATE servers SET status=COALESCE(?,status), stopped_at=COALESCE(?,stopped_at) WHERE id=?').run(f.status ?? null, f.stopped_at ?? null, id),
    get: (id: string) => this.sql.prepare('SELECT * FROM servers WHERE id=?').get(id) as ServerRow | undefined,
    forSession: (sessionId: string) => this.sql.prepare('SELECT * FROM servers WHERE session_id=? ORDER BY started_at').all(sessionId) as unknown as ServerRow[],
    running: () => this.sql.prepare("SELECT * FROM servers WHERE status='running' ORDER BY started_at").all() as unknown as ServerRow[],
  };

  events = {
    append: (sessionId: string, type: string, payload: unknown): EventRow => {
      const seq = (this.sql.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=?').get(sessionId) as { n: number }).n;
      const ts = now();
      const r = this.sql.prepare('INSERT INTO events (session_id,seq,type,payload,ts) VALUES (?,?,?,?,?)').run(sessionId, seq, type, JSON.stringify(payload ?? null), ts);
      return { id: Number(r.lastInsertRowid), session_id: sessionId, seq, type, payload, ts };
    },
    forSession: (sessionId: string) => (this.sql.prepare('SELECT * FROM events WHERE session_id=? ORDER BY seq').all(sessionId) as Row[]).map(parseEvent),
    /** Only the events newer than `seq`, for a live Trace that has the earlier ones already. */
    forSessionAfter: (sessionId: string, seq: number) => (this.sql.prepare('SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq').all(sessionId, seq) as Row[]).map(parseEvent),
    /** Deletes one session's events and returns how many rows went. The session row, its cost and its token counts stay: Usage and the retrospectives read them. */
    deleteForSession: (sessionId: string): number => Number(this.sql.prepare('DELETE FROM events WHERE session_id=?').run(sessionId).changes),
    /** Whether the session recorded an event of any of `types`; an index-backed existence check, not a full read of a session whose events can be megabytes. Unlike `last`, this counts a sub-agent event too, matching the full-session scan it replaced. */
    existsOfTypes: (sessionId: string, types: string[]): boolean =>
      types.length > 0 && !!this.sql.prepare(`SELECT 1 FROM events WHERE session_id=? AND type IN (${types.map(() => '?').join(',')}) LIMIT 1`).get(sessionId, ...types),
    /** The session's own latest event of a type: an event carrying a `parentId` belongs to a sub-agent, not to the session, and is skipped. */
    lastOfType: (sessionId: string, type: string) => { const r = this.sql.prepare("SELECT * FROM events WHERE session_id=? AND type=? AND json_extract(payload,'$.parentId') IS NULL ORDER BY seq DESC LIMIT 1").get(sessionId, type) as Row | undefined; return r ? parseEvent(r) : undefined; },
    lastOfTypeAfter: (sessionId: string, type: string, seq: number) => { const r = this.sql.prepare("SELECT * FROM events WHERE session_id=? AND type=? AND seq>? AND json_extract(payload,'$.parentId') IS NULL ORDER BY seq DESC LIMIT 1").get(sessionId, type, seq) as Row | undefined; return r ? parseEvent(r) : undefined; },
    lastOfTypeBefore: (sessionId: string, type: string, seq: number) => { const r = this.sql.prepare("SELECT * FROM events WHERE session_id=? AND type=? AND seq<? AND json_extract(payload,'$.parentId') IS NULL ORDER BY seq DESC LIMIT 1").get(sessionId, type, seq) as Row | undefined; return r ? parseEvent(r) : undefined; },
    /** The timestamp of the session's latest event of any type — its last sign of life; undefined when it has recorded none. */
    lastTs: (sessionId: string) => (this.sql.prepare('SELECT ts FROM events WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId) as { ts: string } | undefined)?.ts,
    /** The session's own latest event of any type: an event carrying a `parentId` belongs to a sub-agent, not to the session, and is skipped. Undefined when it has recorded none. */
    last: (sessionId: string) => { const r = this.sql.prepare("SELECT * FROM events WHERE session_id=? AND json_extract(payload,'$.parentId') IS NULL ORDER BY seq DESC LIMIT 1").get(sessionId) as Row | undefined; return r ? parseEvent(r) : undefined; },
  };

  chat = {
    /** `hint`: guidance for the model that travels with a notice but is not part of the thread row's text (delivered with it, queued with it). */
    /** `failed_for`: on a system row reporting a user message that was not delivered, that user row's id. */
    insert: (c: { role: ChatRow['role']; kind: ChatRow['kind']; text: string; queued?: boolean; hint?: string | null; reply_to?: number | null; failed_for?: number | null }): ChatRow => {
      const ts = now();
      const queued_at = c.queued ? ts : null;
      const reply_to = c.reply_to ?? null;
      const failed_for = c.failed_for ?? null;
      const r = this.sql.prepare('INSERT INTO chat (role,kind,text,ts,queued_at,hint,reply_to,failed_for) VALUES (?,?,?,?,?,?,?,?)').run(c.role, c.kind, c.text, ts, queued_at, c.hint ?? null, reply_to, failed_for);
      return { id: Number(r.lastInsertRowid), role: c.role, kind: c.kind, text: c.text, ts, answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at, superseded_at: null, reply_to, attachments: undefined, failed_for, retried_at: null };
    },
    insertOnce: (noticeKey: string, c: { role: ChatRow['role']; kind: ChatRow['kind']; text: string; queued?: boolean; hint?: string | null }): { row: ChatRow; inserted: boolean } => {
      const ts = now();
      const queued_at = c.queued ? ts : null;
      const result = this.sql.prepare('INSERT OR IGNORE INTO chat (role,kind,text,ts,queued_at,hint,notice_key) VALUES (?,?,?,?,?,?,?)').run(c.role, c.kind, c.text, ts, queued_at, c.hint ?? null, noticeKey);
      const row = this.sql.prepare('SELECT * FROM chat WHERE notice_key=?').get(noticeKey) as Row | undefined;
      if (!row) throw new Error(`chat notice ${noticeKey} was not stored`);
      return { row: this.parseChat(row)!, inserted: Number(result.changes) > 0 };
    },
    /** Marks every not-yet-retried failure row of one user message retried; returns how many it marked. */
    markRetried: (userId: number) => Number(this.sql.prepare('UPDATE chat SET retried_at=?, retry_completed_at=NULL WHERE failed_for=? AND retried_at IS NULL').run(now(), userId).changes),
    /** Marks an accepted retry finished, atomically adding its new failure row when delivery failed. */
    completeRetry: (userId: number, failureText?: string) => {
      this.sql.exec('BEGIN IMMEDIATE');
      try {
        const failure = failureText === undefined ? null : this.chat.insert({ role: 'system', kind: 'message', text: failureText, queued: false, hint: null, failed_for: userId });
        this.sql.prepare('UPDATE chat SET retry_completed_at=? WHERE failed_for=? AND retried_at IS NOT NULL AND retry_completed_at IS NULL').run(now(), userId);
        this.sql.exec('COMMIT');
        return failure;
      } catch (err) {
        this.sql.exec('ROLLBACK');
        throw err;
      }
    },
    /** Accepted retries that had not completed before a daemon stopped, oldest acceptance first. */
    pendingRetries: () => this.sql.prepare("SELECT failed_for AS user_id, MIN(retried_at) AS retried_at FROM chat WHERE role='system' AND failed_for IS NOT NULL AND retried_at IS NOT NULL AND retry_completed_at IS NULL GROUP BY failed_for ORDER BY retried_at, failed_for").all() as { user_id: number; retried_at: string }[],
    /** The stored file info (with `path`) of every attachment of one message, for re-delivering it. */
    storedAttachments: (chatId: number): { name: string; mime: string; size: number; path: string }[] => {
      const r = this.sql.prepare('SELECT attachments FROM chat WHERE id=?').get(chatId) as { attachments: string | null } | undefined;
      return r?.attachments ? JSON.parse(r.attachments) as { name: string; mime: string; size: number; path: string }[] : [];
    },
    /** Written once the row's files are on disk, replacing the initial null; the caller chooses the storage key, which need not name the row (a rejection stores its files before the notice row exists). `attachments` carries `path`; callers reading it back get `path` stripped, since only the serving route needs it. */
    setAttachments: (id: number, attachments: { name: string; mime: string; size: number; path: string }[]) => this.sql.prepare('UPDATE chat SET attachments=? WHERE id=?').run(JSON.stringify(attachments), id),
    /** The stored file info (with `path`) for one attachment of one message, for the serving route only. */
    attachment: (chatId: number, index: number): { name: string; mime: string; size: number; path: string } | undefined => {
      const r = this.sql.prepare('SELECT attachments FROM chat WHERE id=?').get(chatId) as { attachments: string | null } | undefined;
      if (!r?.attachments) return undefined;
      return (JSON.parse(r.attachments) as { name: string; mime: string; size: number; path: string }[])[index];
    },
    all: () => (this.sql.prepare('SELECT id,role,kind,text,ts,answer,answered_at,seen_at,replied_at,queued_at,superseded_at,reply_to,attachments,failed_for,retried_at FROM chat ORDER BY id').all() as Row[]).map((r) => this.parseChat(r)!),
    /** A chronological page plus any older user message an included assistant reply references, every open question and every
     * queued row (the Office Needs strip and Chat pin read them from the latest page, so they must not fall off it). `has_more`/`oldest_id`
     * describe the window only. */
    page: (options: { limit: number; before?: number; since?: number }) => {
      const where = options.since !== undefined ? 'id>?' : options.before !== undefined ? 'id<?' : '1=1';
      const params = options.since !== undefined ? [options.since] : options.before !== undefined ? [options.before, options.limit] : [options.limit];
      const limit = options.since === undefined ? ' LIMIT ?' : '';
      const page = (this.sql.prepare(`SELECT id,role,kind,text,ts,answer,answered_at,seen_at,replied_at,queued_at,superseded_at,reply_to,attachments,failed_for,retried_at FROM chat WHERE ${where} ORDER BY id DESC${limit}`).all(...params) as Row[]).map((r) => this.parseChat(r)!);
      const oldest_id = page.at(-1)?.id ?? null;
      const refs = page.flatMap((row) => row.reply_to === null || row.reply_to === undefined ? [] : [this.parseChat(this.sql.prepare('SELECT id,role,kind,text,ts,answer,answered_at,seen_at,replied_at,queued_at,superseded_at,reply_to,attachments,failed_for,retried_at FROM chat WHERE id=?').get(row.reply_to) as Row | undefined)]).filter((row): row is ChatRow => row !== undefined);
      const always = (this.sql.prepare("SELECT id,role,kind,text,ts,answer,answered_at,seen_at,replied_at,queued_at,superseded_at,reply_to,attachments,failed_for,retried_at FROM chat WHERE (kind='question' AND answered_at IS NULL AND superseded_at IS NULL) OR queued_at IS NOT NULL").all() as Row[]).map((r) => this.parseChat(r)!);
      const rows = [...new Map([...page, ...refs, ...always].map((row) => [row.id, row])).values()].sort((a, b) => a.id - b.id);
      const has_more = oldest_id !== null && !!this.sql.prepare('SELECT 1 FROM chat WHERE id<? LIMIT 1').get(oldest_id);
      return { rows, has_more, oldest_id };
    },
    get: (id: number) => this.parseChat(this.sql.prepare('SELECT * FROM chat WHERE id=?').get(id) as Row | undefined),
    /** The user's own messages in a time window (both ends inclusive), for a batch retrospective's correction scan. */
    userMessagesBetween: (from: string, to: string) => this.sql.prepare("SELECT * FROM chat WHERE role='user' AND ts>=? AND ts<=? ORDER BY id").all(from, to) as unknown as ChatRow[],
    pendingQuestions: () => this.sql.prepare("SELECT * FROM chat WHERE kind='question' AND answered_at IS NULL AND superseded_at IS NULL ORDER BY id").all() as unknown as ChatRow[],
    answer: (id: number, answer: string) => this.sql.prepare('UPDATE chat SET answer=?, answered_at=? WHERE id=?').run(answer, now(), id),
    /** Notices written while no orchestrator session was live, oldest first. */
    queued: () => this.sql.prepare('SELECT * FROM chat WHERE queued_at IS NOT NULL ORDER BY id').all() as unknown as (ChatRow & { hint: string | null })[],
    /** Marks every queued notice as carried by a turn. */
    flushQueued: () => this.sql.prepare('UPDATE chat SET queued_at=NULL WHERE queued_at IS NOT NULL').run(),
    /** Marks delivered rows seen: set once, the first time the row is handed to an orchestrator session (sent directly or carried as a queued row). */
    markSeen: (ids: number[]) => ids.length ? Number(this.sql.prepare(`UPDATE chat SET seen_at=? WHERE id IN (${ids.map(() => '?').join(',')}) AND seen_at IS NULL`).run(now(), ...ids).changes) : 0,
    /** Clears `seen_at` on rows whose send threw: they were never handed over and are requeued, so they have no status yet. */
    clearSeen: (ids: number[]) => ids.length ? Number(this.sql.prepare(`UPDATE chat SET seen_at=NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes) : 0,
    /** Marks the given seen user rows answered. An assistant text or a question answers every user row seen since the last reply. */
    markReplied: (ids: number[]) => ids.length ? Number(this.sql.prepare(`UPDATE chat SET replied_at=? WHERE id IN (${ids.map(() => '?').join(',')}) AND role='user' AND seen_at IS NOT NULL AND replied_at IS NULL`).run(now(), ...ids).changes) : 0,
    /** The newest user row handed to an orchestrator session (`seen_at` set), or null when none has been. */
    latestSeenUserId: (): number | null => { const r = this.sql.prepare("SELECT id FROM chat WHERE role='user' AND seen_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined; return r ? Number(r.id) : null; },
    /** Puts a notice back in the queue after the turn that should have carried it was refused. */
    requeue: (id: number) => this.sql.prepare('UPDATE chat SET queued_at=? WHERE id=? AND queued_at IS NULL').run(now(), id),
    supersede: (id: number) => this.sql.prepare("UPDATE chat SET superseded_at=? WHERE id=? AND kind='question' AND answered_at IS NULL AND superseded_at IS NULL").run(now(), id),
    /** Closes only the still-pending questions named by a composer draft. */
    supersedeIds: (ids: number[]) => {
      const unique = [...new Set(ids)];
      return unique.length ? Number(this.sql.prepare(`UPDATE chat SET superseded_at=? WHERE id IN (${unique.map(() => '?').join(',')}) AND kind='question' AND answered_at IS NULL AND superseded_at IS NULL`).run(now(), ...unique).changes) : 0;
    },
  };

  /** Browsers that subscribed to push notifications in Setup; `subscription` is the PushSubscription JSON as the browser gave it. */
  push = {
    list: () => this.sql.prepare('SELECT endpoint, subscription, created_at FROM push_subscriptions ORDER BY created_at').all() as unknown as { endpoint: string; subscription: string; created_at: string }[],
    upsert: (endpoint: string, subscription: string) => this.sql.prepare('INSERT INTO push_subscriptions (endpoint,subscription,created_at) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription').run(endpoint, subscription, new Date().toISOString()),
    delete: (endpoint: string) => this.sql.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint),
  };

  settings = {
    get: (key: string) => { const r = this.sql.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return r ? JSON.parse(r.value) : undefined; },
    set: (key: string, value: unknown) => this.sql.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), now()),
    orchestrator: (): OrchestratorSettings => this.settings.get('orchestrator') ?? { model: null, effort: null, promptOverride: null },
    tiers: (): TierSettings => this.settings.get('tiers') ?? DEFAULT_TIERS,
    /** Push a notification for every orchestrator chat reply, not only questions, reviews and decisions. Default on. */
    pushOnReply: (): boolean => this.settings.get('push_on_reply') ?? true,
  };

  private patch(table: string, key: string, id: string, patch: Row) {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    this.sql.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE ${key}=?`).run(...cols.map((c) => patch[c] as never), id);
  }

  private parseChat(r: Row | undefined): ChatRow | undefined {
    if (!r) return undefined;
    const fields = { ...r };
    delete fields.retry_completed_at;
    const row = fields as unknown as ChatRow & { attachments: string | null };
    return { ...row, attachments: row.attachments ? (JSON.parse(row.attachments) as { name: string; mime: string; size: number }[]).map(({ name, mime, size }) => ({ name, mime, size })) : undefined };
  }

  private parseRepo(r: Row | undefined): Repo | undefined {
    if (!r) return undefined;
    return { ...(r as unknown as Repo), model_filter: r.model_filter ? JSON.parse(String(r.model_filter)) : null };
  }

  private parseWt(r: Row | undefined): WorktreeRow | undefined {
    if (!r) return undefined;
    return { ...(r as unknown as WorktreeRow), conflict_files: r.conflict_files ? JSON.parse(String(r.conflict_files)) : null, review_findings: r.review_findings ? JSON.parse(String(r.review_findings)) : null, review_carried: r.review_carried ? JSON.parse(String(r.review_carried)) : null, created_dirty: r.created_dirty === null || r.created_dirty === undefined ? undefined : JSON.parse(String(r.created_dirty)), verify_command: (r.verify_command as string | null) ?? null, verify_only_result: r.verify_only_result ? JSON.parse(String(r.verify_only_result)) : null };
  }

  private parseDiscussion(r: Row | undefined): DiscussionRow | undefined {
    if (!r) return undefined;
    const { attachments: rawAttachments, ...fields } = r;
    const attachments = rawAttachments ? JSON.parse(String(rawAttachments)) as StoredDiscussionAttachment[] : [];
    return {
      ...(fields as unknown as DiscussionRow),
      ...(attachments.length ? { attachments: attachments.map(({ name, mime, size }) => ({ name, mime, size })) } : {}),
    };
  }

  private readDiscussionAttachments(id: string): StoredDiscussionAttachment[] {
    const r = this.sql.prepare('SELECT attachments FROM discussions WHERE id=?').get(id) as { attachments: string | null } | undefined;
    return r?.attachments ? JSON.parse(r.attachments) as StoredDiscussionAttachment[] : [];
  }

  private parseBatch(r: Row | undefined): BatchRow | undefined {
    if (!r) return undefined;
    return { ...(r as unknown as BatchRow), origin_chat_id: (r.origin_chat_id as number | null) ?? null, conflict_files: r.conflict_files ? JSON.parse(String(r.conflict_files)) : null, review_check: r.review_check ? JSON.parse(String(r.review_check)) : null, waiting_on: (r.waiting_on as string | null) ?? null, overlap_files: r.overlap_files ? JSON.parse(String(r.overlap_files)) : null };
  }
}

function parseEvent(r: Row): EventRow {
  return { ...(r as unknown as EventRow), payload: JSON.parse(String(r.payload)) };
}

export function openDb(file: string, opts: DbOptions = {}): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sql = new DatabaseSync(file);
  sql.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=${DB_CACHE_SIZE_KB};`);
  sql.exec(SCHEMA);
  let addedChatSeen = false;
  for (const c of ADDED_COLUMNS) {
    const cols = (sql.prepare(`PRAGMA table_info(${c.table})`).all() as { name: string }[]).map((r) => r.name);
    if (!cols.includes(c.column)) {
      sql.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.ddl}`);
      if (c.table === 'chat' && c.column === 'seen_at') addedChatSeen = true;
    }
  }
  if (addedChatSeen) sql.exec(CHAT_SEEN_REPLIED_BACKFILL);
  sql.exec(ADDED_INDEXES);
  return new Db(sql, opts);
}
