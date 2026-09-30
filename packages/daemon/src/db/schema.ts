export const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL,
  verify_command TEXT, merge_mode TEXT NOT NULL, worker_limit INTEGER NOT NULL, model_filter TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, harness TEXT NOT NULL, role TEXT NOT NULL, bead_id TEXT, repo_id TEXT,
  native_session_id TEXT, pid INTEGER, pid_started_at TEXT, start_commit TEXT, cwd TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, cost REAL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
  estimated_cost REAL, cost_source TEXT, cache_write_1h_tokens INTEGER, resolved_model TEXT, usage_baseline TEXT);
CREATE TABLE IF NOT EXISTS worktrees (
  bead_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
  base_branch TEXT NOT NULL, verify_status TEXT, verify_output TEXT, review_note TEXT,
  conflict_files TEXT, merged_at TEXT, mr_url TEXT, verify_command TEXT, verify_only_result TEXT,
  evidence_gate_failures INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, ts TEXT NOT NULL, answer TEXT, answered_at TEXT, retry_completed_at TEXT, notice_key TEXT);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL,
  base_branch TEXT NOT NULL, status TEXT NOT NULL, note TEXT, mr_url TEXT, conflict_files TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_at TEXT);
CREATE TABLE IF NOT EXISTS gitlab_mr_states (
  mr_url TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('opened','merged','closed')), updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, steps TEXT NOT NULL, status TEXT NOT NULL,
  batch_id TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, label TEXT, harness TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, secret TEXT, home TEXT, created_at TEXT NOT NULL, last_login_at TEXT, last_verified_at TEXT, refresh_token TEXT, token_expires_at INTEGER, exhausted_until INTEGER);
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batch_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, bead_id TEXT, kind TEXT NOT NULL,
  text TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS batch_signals_batch ON batch_signals(batch_id, id);
CREATE TABLE IF NOT EXISTS preflight_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, kind TEXT NOT NULL, step TEXT NOT NULL DEFAULT 'verify', command TEXT NOT NULL,
  head_sha TEXT, result TEXT, exit_code INTEGER, output_tail TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE INDEX IF NOT EXISTS preflight_runs_repo ON preflight_runs(repo_id, id);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repo_id TEXT NOT NULL, bead_id TEXT, name TEXT,
  command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER, pid_started_at TEXT, log_path TEXT,
  status TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT);
CREATE INDEX IF NOT EXISTS servers_session ON servers(session_id);
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, repo_id TEXT, status TEXT NOT NULL,
  stop_reason TEXT, cost_cap REAL NOT NULL DEFAULT 5.0, created_at TEXT NOT NULL,
  ended_at TEXT, synthesis TEXT);
CREATE TABLE IF NOT EXISTS discussion_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id TEXT NOT NULL, round INTEGER NOT NULL,
  harness TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, cost REAL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS discussion_turns_discussion ON discussion_turns(discussion_id, round, id);
CREATE TABLE IF NOT EXISTS discussion_participants (
  discussion_id TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL,
  status TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (discussion_id, harness));
CREATE TABLE IF NOT EXISTS chat_batch_links (
  chat_id INTEGER, batch_id TEXT, created_at TEXT, PRIMARY KEY (chat_id, batch_id));
CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  status TEXT NOT NULL CHECK (status IN ('open','done')), created_at TEXT NOT NULL, origin_chat_id INTEGER);
CREATE TABLE IF NOT EXISTS program_batches (
  program_id TEXT NOT NULL, batch_id TEXT NOT NULL, lane TEXT NOT NULL CHECK (length(trim(lane)) > 0),
  position INTEGER NOT NULL CHECK (position >= 0), PRIMARY KEY (program_id, batch_id), UNIQUE (program_id, lane, position));
CREATE TABLE IF NOT EXISTS batch_waits (
  batch_id TEXT NOT NULL, prerequisite_batch_id TEXT NOT NULL, released_at TEXT, release_notice_at TEXT, abandon_notice_at TEXT,
  PRIMARY KEY (batch_id, prerequisite_batch_id));
CREATE TABLE IF NOT EXISTS program_entries (
  program_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('decision','ownership','note')),
  text TEXT NOT NULL CHECK (length(text) > 0), created_at TEXT NOT NULL, source_chat_id INTEGER);
CREATE TABLE IF NOT EXISTS merge_order (
  program_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0), batch_id TEXT NOT NULL,
  PRIMARY KEY (program_id, position), UNIQUE (program_id, batch_id));
`;

/** Columns added after v1. openDb adds each one that is missing (CREATE TABLE IF NOT EXISTS never alters). */
export const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'batches', column: 'origin_chat_id', ddl: 'INTEGER' },
  { table: 'worktrees', column: 'batch_id', ddl: 'TEXT' },
  { table: 'batches', column: 'merged_commit', ddl: 'TEXT' },
  { table: 'chat', column: 'queued_at', ddl: 'TEXT' },
  { table: 'chat', column: 'superseded_at', ddl: 'TEXT' },
  { table: 'chat', column: 'hint', ddl: 'TEXT' },
  { table: 'worktrees', column: 'closed_at', ddl: 'TEXT' },
  { table: 'batches', column: 'history', ddl: 'TEXT' },
  { table: 'chat', column: 'reply_to', ddl: 'INTEGER' },
  { table: 'sessions', column: 'tier', ddl: 'TEXT' },
  { table: 'sessions', column: 'model', ddl: 'TEXT' },
  { table: 'repos', column: 'review_rounds', ddl: 'INTEGER NOT NULL DEFAULT 2' },
  { table: 'worktrees', column: 'review_round', ddl: 'INTEGER' },
  { table: 'worktrees', column: 'review_findings', ddl: 'TEXT' },
  { table: 'worktrees', column: 'evidence_gate_failures', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'worktrees', column: 'accepted_note', ddl: 'TEXT' },
  { table: 'repos', column: 'setup_command', ddl: 'TEXT' },
  { table: 'batches', column: 'setup_at', ddl: 'TEXT' },
  { table: 'sessions', column: 'batch_id', ddl: 'TEXT' },
  { table: 'sessions', column: 'log_path', ddl: 'TEXT' },
  { table: 'sessions', column: 'log_offset', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'batches', column: 'waiting_on', ddl: 'TEXT' },
  { table: 'batches', column: 'overlap_files', ddl: 'TEXT' },
  { table: 'sessions', column: 'last_text', ddl: 'TEXT' },
  { table: 'sessions', column: 'end_reason', ddl: 'TEXT' },
  { table: 'batches', column: 'refresh_from', ddl: 'TEXT' },
  { table: 'batches', column: 'refresh_head', ddl: 'TEXT' },
  { table: 'sessions', column: 'verify_only', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'sessions', column: 'account', ddl: 'TEXT' },
  { table: 'sessions', column: 'needs_server', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'chat', column: 'attachments', ddl: 'TEXT' },
  { table: 'accounts', column: 'refresh_token', ddl: 'TEXT' },
  { table: 'accounts', column: 'token_expires_at', ddl: 'INTEGER' },
  { table: 'accounts', column: 'label', ddl: 'TEXT' },
  { table: 'accounts', column: 'exhausted_until', ddl: 'INTEGER' },
  { table: 'accounts', column: 'provider', ddl: 'TEXT' },
  { table: 'repos', column: 'verify_suspect', ddl: 'INTEGER' },
  { table: 'repos', column: 'model_filter', ddl: 'TEXT' },
  { table: 'sessions', column: 'crash_class', ddl: 'TEXT' },
  { table: 'sessions', column: 'input_tokens', ddl: 'INTEGER' },
  { table: 'sessions', column: 'output_tokens', ddl: 'INTEGER' },
  { table: 'sessions', column: 'cache_read_tokens', ddl: 'INTEGER' },
  { table: 'sessions', column: 'cache_write_tokens', ddl: 'INTEGER' },
  { table: 'sessions', column: 'reasoning_tokens', ddl: 'INTEGER' },
  { table: 'sessions', column: 'estimated_cost', ddl: 'REAL' },
  { table: 'sessions', column: 'cost_source', ddl: 'TEXT' },
  { table: 'sessions', column: 'cache_write_1h_tokens', ddl: 'INTEGER' },
  { table: 'sessions', column: 'resolved_model', ddl: 'TEXT' },
  { table: 'sessions', column: 'usage_baseline', ddl: 'TEXT' },
  { table: 'worktrees', column: 'created_dirty', ddl: 'TEXT' },
  { table: 'worktrees', column: 'landed_note', ddl: 'TEXT' },
  { table: 'worktrees', column: 'review_diff_lines', ddl: 'INTEGER' },
  { table: 'worktrees', column: 'landed_reviewed', ddl: 'TEXT' },
  { table: 'worktrees', column: 'review_carried', ddl: 'TEXT' },
  { table: 'repos', column: 'batch_approver', ddl: "TEXT NOT NULL DEFAULT 'user'" },
  { table: 'sessions', column: 'bead_title', ddl: 'TEXT' },
  { table: 'sessions', column: 'token_expires_at', ddl: 'INTEGER' },
  { table: 'sessions', column: 'auth_resumed', ddl: 'INTEGER' },
  { table: 'sessions', column: 'discussion_id', ddl: 'TEXT' },
  { table: 'batch_waits', column: 'released_at', ddl: 'TEXT' },
  { table: 'batch_waits', column: 'release_notice_at', ddl: 'TEXT' },
  { table: 'batch_waits', column: 'abandon_notice_at', ddl: 'TEXT' },
  { table: 'chat', column: 'notice_key', ddl: 'TEXT' },
  { table: 'sessions', column: 'discussion_kind', ddl: 'TEXT' },
  { table: 'sessions', column: 'harness_forced', ddl: 'INTEGER' },
  { table: 'discussions', column: 'synthesis_cost', ddl: 'REAL' },
  { table: 'discussions', column: 'attachments', ddl: 'TEXT' },
  { table: 'chat', column: 'seen_at', ddl: 'TEXT' },
  { table: 'chat', column: 'replied_at', ddl: 'TEXT' },
  { table: 'sessions', column: 'settled_at', ddl: 'TEXT' },
  { table: 'batches', column: 'last_pipeline_id', ddl: 'INTEGER' },
  { table: 'batches', column: 'last_pipeline_outcome', ddl: 'TEXT' },
  { table: 'repos', column: 'review_command', ddl: 'TEXT' },
  { table: 'batches', column: 'review_check', ddl: 'TEXT' },
  { table: 'worktrees', column: 'verify_command', ddl: 'TEXT' },
  { table: 'worktrees', column: 'verify_only_result', ddl: 'TEXT' },
  { table: 'chat', column: 'failed_for', ddl: 'INTEGER' },
  { table: 'chat', column: 'retried_at', ddl: 'TEXT' },
  { table: 'chat', column: 'retry_completed_at', ddl: 'TEXT' },
];

/**
 * Backfill run once, when `seen_at`/`replied_at` are first added to an existing `chat` table. Rows written before the
 * change carry neither column. An old user row that has an assistant row whose `reply_to` is its id counts as answered:
 * `seen_at` and `replied_at` both take that assistant row's `ts`. Every other old user row stays null and shows no status.
 * Idempotent, so a crash between the two `ALTER TABLE`s cannot double-apply it.
 */
export const CHAT_SEEN_REPLIED_BACKFILL = `
UPDATE chat SET
  seen_at = (SELECT a.ts FROM chat a WHERE a.reply_to = chat.id AND a.role = 'assistant' ORDER BY a.id LIMIT 1),
  replied_at = (SELECT a.ts FROM chat a WHERE a.reply_to = chat.id AND a.role = 'assistant' ORDER BY a.id LIMIT 1)
WHERE role = 'user' AND seen_at IS NULL AND replied_at IS NULL
  AND EXISTS (SELECT 1 FROM chat a WHERE a.reply_to = chat.id AND a.role = 'assistant');
`;

/** Indexes added after v1. openDb creates them after ADDED_COLUMNS, because worktrees.batch_id only exists once that column was added. */
export const ADDED_INDEXES = `
CREATE INDEX IF NOT EXISTS sessions_bead ON sessions(bead_id, started_at);
CREATE INDEX IF NOT EXISTS worktrees_batch ON worktrees(batch_id);
CREATE INDEX IF NOT EXISTS programs_repo_created ON programs(repo_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS program_entries_program_created ON program_entries(program_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS chat_notice_key ON chat(notice_key) WHERE notice_key IS NOT NULL;
`;
