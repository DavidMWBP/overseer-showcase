export type HarnessName = 'claude' | 'codex' | 'opencode';
export type MergeMode = 'local-merge' | 'gitlab-mr';
/** Who approves a finished batch when it reaches review. The orchestrator value applies only to local merges; GitLab merge requests always wait for the user. */
export type BatchApprover = 'user' | 'orchestrator';
/** The persisted orchestrator value is effective only for a local merge. This keeps invalid legacy rows under user control. */
export const effectiveBatchApprover = (repo: Pick<Repo, 'merge_mode' | 'batch_approver'>): BatchApprover => (
  repo.merge_mode === 'local-merge' && repo.batch_approver === 'orchestrator' ? 'orchestrator' : 'user'
);
export type SessionRole = 'orchestrator' | 'worker' | 'critic' | 'discussion';
export type SessionStatus = 'running' | 'ended' | 'failed';
export type Phase = 'verifying' | 'review' | 'merged' | 'rejected' | 'abandoned' | 'closed' | 'verified' | 'worker-reported';
export type BeadStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'deferred';
export type BoardColumn = 'ready' | 'blocked' | 'running' | 'verifying' | 'review' | 'done';

/**
 * Where a session's own cost figure comes from: `reported` is the CLI's own number, `estimated` is tokens × the
 * models.dev catalog prices, and `unknown` means the model is not in the catalog (and the CLI reported none).
 */
export type CostSource = 'reported' | 'estimated' | 'unknown';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
const CODEX_ULTRA_MODELS = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']);
const CODEX_NO_ULTRA_MODELS = new Set(['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5']);
/** Codex custom model ids are eligible; named models with known support limits follow the CLI's catalog. */
export function supportsUltraEffort(harness: HarnessName, model: string): boolean {
  const id = model.trim();
  return harness === 'codex' && id !== '' && (CODEX_ULTRA_MODELS.has(id) || !CODEX_NO_ULTRA_MODELS.has(id));
}
/** Every tier name the daemon accepts and Setup offers; `critic-chore` is optional (see `resolveTier` and the review round) and absent from `DEFAULT_TIERS`. */
export const TIER_NAMES = ['chore', 'standard', 'hard', 'critic', 'critic-chore'] as const;
export type TierName = (typeof TIER_NAMES)[number];
export interface TierCandidate { harness: HarnessName; model: string; effort: Effort | null; account?: string | null }
export interface Tier { name: TierName; candidates: TierCandidate[] }
export interface TierSettings { tiers: Tier[]; denyModels: string[] }
export interface OrchestratorSettings { model: string | null; effort: Effort | null; promptOverride: string | null; account?: string | null; usageThresholdPercent?: number }
export interface Account { id: string; name: string; label: string | null; harness: 'claude' | 'codex' | 'opencode'; kind: 'oauth_token' | 'api_key' | 'codex_home'; provider?: string | null; home: string | null; created_at: string; last_login_at: string | null; last_verified_at: string | null; has_secret: boolean; logged_in: boolean }
export interface UsageBucket { percent: number; resetsAt: string | null }
export interface AccountUsage { fetchedAt: string; session: UsageBucket | null; weekly: UsageBucket | null; models: Array<UsageBucket & { model: string }>; error?: string }
export interface Finding { file: string | null; summary: string; severity: 'must' | 'should' }
/**
 * What a card can be acted on as, computed by the daemon so the web never infers it from column, session and labels:
 * `running` (a worker is live: Stop), `settling` (the worker has exited, the session-end rule has not finished: nothing),
 * `verifying`, `review` (a bead awaiting Merge/Reject), `verify_failed` (Retry verification / Re-dispatch), `blocked`
 * (waits on another bead: no action, whatever its last verification said), `idle` (open, nothing runs on it: the same
 * two if its branch has commits, and Close bead), `landed_unclosed` (its work is on the batch branch but bd could not
 * record the close, so bd still has it in Verifying: Retry close), `done`.
 */
export type CardState = 'running' | 'settling' | 'verifying' | 'review' | 'verify_failed' | 'blocked' | 'idle' | 'landed_unclosed' | 'done' | 'reviewing' | 'awaiting_decision';

export interface Repo {
  id: string;
  path: string;
  base_branch: string;
  verify_command: string | null;
  /** Runs once per batch head before review is requested; null leaves the existing review flow unchanged. */
  review_command?: string | null;
  /** Runs in every new bead and batch worktree right after creation (dependencies, generated files); null: nothing runs. */
  setup_command: string | null;
  merge_mode: MergeMode;
  batch_approver: BatchApprover;
  worker_limit: number;
  review_rounds: number;
  model_filter: { harnesses: HarnessName[]; models: string[]; accounts: string[] } | null;
  /** The id of the failing `preflight_runs` row while the verify command fails on the base branch; null: dispatch allowed. */
  verify_suspect?: number | null;
}

/** A Claude Code slash command or skill available to a repository's chat composer. */
export interface RepoCommand {
  name: string;
  description: string;
  kind: 'command' | 'skill';
  source: 'repo' | 'global';
}

export interface SessionRow {
  id: string;
  harness: HarnessName;
  role: SessionRole;
  bead_id: string | null;
  repo_id: string | null;
  native_session_id: string | null;
  pid: number | null;
  pid_started_at: string | null;
  start_commit: string | null;
  cwd: string;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  cost: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  /** The slice of `cache_write_tokens` written with Claude's 1-hour cache TTL (billed at 2x the input rate), rather than the 5-minute default. */
  cache_write_1h_tokens?: number | null;
  reasoning_tokens?: number | null;
  /** API-equivalent cost from this session's tokens and its model's models.dev prices; null when the model is not in the catalog or no tokens were reported. */
  estimated_cost?: number | null;
  /** How to read the figures: `reported` (the CLI's `cost`), `estimated` (only `estimated_cost` exists), or `unknown` (neither). */
  cost_source?: CostSource | null;
  /** The model id the harness resolved for its main thread (Claude reports it per assistant message), persisted so an adopted session keeps pricing from it rather than the tier alias. */
  resolved_model?: string | null;
  /** JSON of a codex thread's running counters when this session resumed it; the estimate prices the delta above this, so a resumed session does not bill the thread's earlier work. */
  usage_baseline?: string | null;
  tier: TierName | null;
  model: string | null;
  /** The batch the worker was dispatched into, recorded at spawn time so a restarted daemon can adopt the session without a lookup. */
  batch_id: string | null;
  /** The title of the session's bead at dispatch time, recorded on the row so the office feed can name a character without a bd read. */
  bead_title?: string | null;
  /** The harness process's stdout file; the daemon tails it and a restarted daemon resumes from `log_offset`. */
  log_path: string | null;
  log_offset: number;
  /** Written when the session ends, on every exit path: the last assistant text seen and why it ended (exit code / error), or null for a clean end. */
  last_text?: string | null;
  end_reason?: string | null;
  /** 1 for a worker dispatched with `verify_only`: ending without commits but with a final message closes the bead as verified instead of reopening it. */
  verify_only?: number | null;
  /** 1 for a worker dispatched with `needs_server`: the task runs a server, a daemon or a browser, so every automatic re-dispatch of the bead keeps harnesses that cannot hold one unusable. */
  needs_server?: number | null;
  /** 1 for a worker dispatched with both `harness` and `tier`: the harness was forced while the tier was kept, so every automatic retry stays on that harness among that tier's candidates. A forced harness without a tier is recorded as a null `tier` instead. */
  harness_forced?: number | null;
  account?: string | null;
  /** The expiry (ms since epoch) of the Claude OAuth access token this session's environment carried at start, read after any refresh; null for an API-key, codex or opencode account and the CLI's own login. */
  token_expires_at?: number | null;
  /** 1 for a session started to recover one that ended on a rejected login: a second rejection parks its account instead of resuming again, across a daemon restart too. */
  auth_resumed?: number | null;
  /** For a `role: 'discussion'` session, the discussion it answers for. */
  discussion_id?: string | null;
  /** `'synthesis'` for the discussion's closing synthesis session, null for a participant and for every other role. */
  discussion_kind?: 'synthesis' | null;
  crash_class?: CrashClass | null;
  /** When this session's end was first settled: set at the start of the settle, so a second delivery of the same session end is ignored even after a restart. */
  settled_at?: string | null;
}

/** The paths a worktree holds uncommitted: tracked files with a staged or unstaged edit, and files git does not track yet. */
export interface UncommittedWork { modified: string[]; untracked: string[] }

export interface WorktreeRow {
  bead_id: string;
  repo_id: string;
  path: string;
  branch: string;
  base_branch: string;
  verify_status: 'pass' | 'fail' | null;
  verify_output: string | null;
  /** Optional command used to verify a commitless verification-only bead at session end. */
  verify_command?: string | null;
  /** Latest daemon run of a verification-only worktree command, persisted after its worktree folder is removed. */
  verify_only_result?: VerifyOnlyCheck | null;
  review_note: string | null;
  conflict_files: string[] | null;
  merged_at: string | null;
  mr_url: string | null;
  batch_id: string | null;
  /** Set when the user closed the bead as won't do from the Board: it counts as finished for its batch without having landed. */
  closed_at: string | null;
  review_round: number | null;
  review_findings: Finding[] | null;
  accepted_note: string | null;
  /**
   * What the worktree held uncommitted when it was created, after its setup command ran: null when it started clean, undefined
   * when no snapshot was ever recorded (a worktree that predates this tracking), which leaves the end-of-session check with no
   * baseline to subtract. Stored on the row so it survives a daemon restart.
   */
  created_dirty?: UncommittedWork | null;
  /** A review round's landed-findings note and notice suffix, kept from the merge until bd records the landing, so Retry close and recovery write them. */
  landed_note?: string | null;
  /** Changed lines (insertions plus deletions) of the bead's diff, measured once when its first review round starts; decides a standard bead's second round. */
  review_diff_lines?: number | null;
  /** A successful round 1's findings kept for the landing while round 2 runs; apart from `review_findings`, which marks a decision. */
  review_carried?: Finding[] | null;
  landed_reviewed?: string | null;
  /** Consecutive failed evidence-gate checks, kept on the bead across worker re-dispatches and daemon restarts. */
  evidence_gate_failures?: number;
}

export type BatchStatus = 'open' | 'review' | 'merged' | 'abandoned';

export interface ReviewCheckCounts {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  flaky: number;
}

export interface ReviewCheck {
  status: 'pass' | 'fail';
  command: string;
  head_sha: string;
  exit_code: number | null;
  duration_ms: number;
  output_tail: string;
  counts: ReviewCheckCounts | null;
}

export interface VerifyOnlyCheck {
  status: 'pass' | 'fail';
  command: string;
  head_sha: string;
  exit_code: number | null;
  duration_ms: number;
  output_tail: string;
  counts: ReviewCheckCounts | null;
}

export interface BatchRow {
  id: string;
  /** User chat message that started this batch; null for notices, approvals and web-created batches. */
  origin_chat_id?: number | null;
  repo_id: string;
  title: string;
  branch: string;
  base_branch: string;
  status: BatchStatus;
  /** The latest review summary from the orchestrator (null until it requests review, and again after a rejection). */
  note: string | null;
  /** Earlier rounds: every previous summary and rejection note, oldest first; null before the first rejection. */
  history: string | null;
  mr_url: string | null;
  conflict_files: string[] | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  /** Merge commit on the base branch (local-merge only); null until merged. */
  merged_commit: string | null;
  /** When the repo's setup command last completed in the batch worktree; null until then, and again when the worktree is recreated. */
  setup_at: string | null;
  /** The latest configured review command run for this batch head; null until a review command runs. */
  review_check?: ReviewCheck | null;
  /** While in review: the id of an earlier batch in review of the same repo whose diff touches the same files; Merge waits until that one leaves review. Null otherwise. */
  waiting_on: string | null;
  /** The files both batches change, set with `waiting_on`. */
  overlap_files: string[] | null;
  /** Id of a batch merged into base while this one had a running worker: the base is merged into this branch before its next bead lands. Null otherwise. */
  refresh_from?: string | null;
  /** Head commit of the batch named by `refresh_from`, so the deferred refresh can check the fetched base really contains it. */
  refresh_head?: string | null;
  /** Last terminal MR head pipeline outcome inspected successfully; prevents duplicate notices and repeated job reads. */
  last_pipeline_id?: number | null;
  last_pipeline_outcome?: 'failed' | 'success' | 'canceled' | null;
}

/**
 * Something that went wrong or needed a human during a batch. `rejection`: the user rejected the batch in Review. `reopen`: a bead
 * went back to Ready (the text names the reason class and the note). `redispatch`: a new worker on a bead that had one, with the
 * instructions it was given. `closed`: the user closed a bead as won't do from the Board. `correction`: a user chat message during the
 * batch that reads as a correction or a status ping (matched by keyword, see lifecycle/retrospective.ts).
 */
export type BatchSignalKind = 'rejection' | 'reopen' | 'redispatch' | 'closed' | 'correction' | 'crash';
export type ReopenReason = 'no_commits' | 'uncommitted_changes' | 'verify_incomplete' | 'verify_failed' | 'merge_conflict' | 'hook_rejected' | 'setup_failed' | 'stopped';

export interface BatchSignalRow {
  id: number;
  batch_id: string;
  bead_id: string | null;
  kind: BatchSignalKind;
  text: string;
  ts: string;
}

/** The full record `GET /api/batches/:id/retrospective` returns, and `batch_retrospective` returns with `full: true` or, per bead, `bead_id`; the tool's default is a compact form (see lifecycle/retrospective.ts). */
export interface BatchRetrospective {
  batch_id: string;
  title: string;
  status: BatchStatus;
  created_at: string;
  ended_at: string | null;
  signals: {
    rejections: { note: string; ts: string }[];
    reopens: { bead_id: string; reason: ReopenReason; note: string; ts: string }[];
    redispatches: { bead_id: string; instructions: string | null; ts: string }[];
    closed: { bead_id: string; note: string | null; ts: string }[];
    corrections: { text: string; matched: string; ts: string }[];
  };
  crashes: { bead_id: string; crash_class: CrashClass; reason: string; ts: string }[];
  counts: {
    beads_total: number;
    reopens: number;
    redispatches: number;
    signals: number;
    /** Sum of the reported worker session costs; sessions that reported none are not in it. */
    worker_cost: number;
    /** From batch creation to its close (merge or abandon), or to now while it is open or in review. */
    wall_clock_ms: number;
  };
}

/**
 * A long-running action (Merge, Reject, Abandon, Retry verification, …) that a REST action endpoint acknowledged
 * with 202 and is running in the background for one target (a bead or a batch). Carried on the target's board row
 * so a reload still shows it, and gone once the job ends.
 */
export interface PendingAction { job_id: string; action: string; started_at: string }

/** The outcome of a background action, broadcast as the `action_result` socket message. `data` is what the endpoint returned before the 202 (e.g. `{ session_id }` for redispatch); `message` is the failure's reason. */
export interface ActionResult { job_id: string; action: string; target: string; ok: boolean; message: string | null; data: unknown }

export interface BatchSummary extends BatchRow {
  /** Chat messages this batch was acted on for, oldest first; includes `origin_chat_id` when it is set, so the web has one list to read. */
  linked_chat_ids: number[];
  beads_total: number;
  beads_done: number;
  /** Beads closed as won't do by the user; finished for the batch without landing (beads_done counts only landed ones). */
  beads_closed: number;
  cost: number;
  /** Ended worker sessions that reported no cost (stopped or crashed before the harness's final event): `cost` is a floor, not the total. */
  cost_unknown: number;
  /** The background action running for this batch right now, null otherwise. */
  pending_action?: PendingAction | null;
}

export interface BatchDetail {
  batch: BatchRow;
  repo: Repo;
  beads: BoardCard[];
  diff: string | null;
  cost: number;
  cost_unknown: number;
  /** Landed beads whose verification ran a command (their output is not the no-command sentinel); the header reads this, not the repo's current command. */
  landed_verified: number;
}

export type ProgramStatus = 'open' | 'done';
export type ProgramEntryKind = 'decision' | 'ownership' | 'note';

/** A group of related batches created for one multi-story request. */
export interface Program {
  id: string;
  repo_id: string;
  title: string;
  status: ProgramStatus;
  created_at: string;
  origin_chat_id: number | null;
}

/** Membership and ordering within one lane; positions are zero-based. */
export interface ProgramBatch {
  program_id: string;
  batch_id: string;
  lane: string;
  position: number;
}

export interface BatchWait {
  batch_id: string;
  prerequisite_batch_id: string;
}

export interface ProgramWait extends BatchWait {
  /** True once the prerequisite merge has durably released this wait. */
  released: boolean;
}

/** Decisions preserve the user's words, and source_chat_id identifies their source when one exists. */
export interface ProgramEntry {
  program_id: string;
  kind: ProgramEntryKind;
  text: string;
  created_at: string;
  source_chat_id: number | null;
}

export interface ProgramBatchSummary extends ProgramBatch {
  title: string | null;
  status: BatchStatus | null;
  beads_total: number;
  beads_done: number;
  beads_closed: number;
}

/** Full read model returned by `GET /api/programs/:id`. */
export interface ProgramDetail extends Program {
  batches: ProgramBatchSummary[];
  waits: ProgramWait[];
  entries: ProgramEntry[];
  merge_order: string[];
}

export interface CostsResponse {
  /** `unknown` counts ended sessions that reported no cost: the totals are floors while it is above zero. */
  repos: { repo_id: string; total: number; today: number; unknown: number }[];
  batches: { batch_id: string; total: number; unknown: number }[];
}

/** The token counters a usage bucket sums, one per `sessions` column. */
export type UsageTokenKind = 'input' | 'output' | 'cache_read' | 'cache_write' | 'cache_write_1h' | 'reasoning';

/** The dimensions `GET /api/usage?group=` can break a range down by. */
export type UsageGroup = 'model' | 'account' | 'harness' | 'repo' | 'batch';

/**
 * Sessions in a bucket, their token counters by kind and the two cost figures kept apart: `reported_cost` sums the CLI's own
 * `cost`, `estimated_cost` sums the catalog estimate, and the two are never added together. Each sum covers only the sessions
 * that carry the figure, so `reported_unknown` and `estimated_unknown` count the ones that contributed none — a bucket
 * entirely unpriced is then distinguishable from one that genuinely cost $0.
 */
export interface UsageTotals {
  sessions: number;
  reported_cost: number;
  /** Sessions with no reported `cost` (a CLI that reports none, such as codex, or one that crashed before its result line): `reported_cost` is a floor while this is above zero. */
  reported_unknown: number;
  estimated_cost: number;
  /** Sessions with no `estimated_cost` (the model is not in the catalog): `estimated_cost` is a floor while this is above zero. */
  estimated_unknown: number;
  /** Sessions run on codex, whose estimate is priced at the catalog's base context tier and can read up to 2x low: the Usage page shows that caveat on exactly the buckets this counts. */
  codex_sessions: number;
  tokens: Record<UsageTokenKind, number>;
}

/** One calendar day (UTC) that has sessions in range, oldest first. */
export interface UsageDay extends UsageTotals { day: string }

/**
 * One row of a breakdown. `key` is the model/account/harness/repo/batch id, or null for sessions that carry none; `label` is
 * the readable name where one exists (the account's label or, unlabelled, its name; the repo's path; the batch's title), null
 * otherwise and for a deleted account.
 */
export interface UsageBreakdownRow extends UsageTotals { key: string | null; label: string | null }

/** One breakdown row confined to one calendar day (UTC): what a stacked bar per day is drawn from. */
export interface UsageDayBreakdownRow extends UsageBreakdownRow { day: string }

export interface UsageResponse {
  /** Inclusive range, `YYYY-MM-DD`. */
  from: string;
  to: string;
  totals: UsageTotals;
  /** One row per calendar day (UTC) that has sessions in range, oldest first. */
  days: UsageDay[];
  /** Only the requested dimensions (all five when `group` is omitted); each sorted by spend, highest first. */
  groups: Partial<Record<UsageGroup, UsageBreakdownRow[]>>;
  /** The same sums split by day and model, oldest day first, so a day's bar can be stacked by model; empty unless `model` is among the requested dimensions. */
  days_by_model: UsageDayBreakdownRow[];
}

export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
}

export interface ChatRow {
  id: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'message' | 'question';
  text: string;
  ts: string;
  answer: string | null;
  answered_at: string | null;
  /** Set when the row was handed to an orchestrator session (sent directly, or carried as a queued row); null while the daemon still holds the row. */
  seen_at: string | null;
  /** Set on a user row the orchestrator answered (assistant text, or a question it asked) after it had seen it; null means seen but not yet answered. */
  replied_at: string | null;
  /** Set on an Overseer notice written while no orchestrator session was live; cleared when the next turn carries it. */
  queued_at: string | null;
  /** Set on a question the orchestrator moved past (a later user message was answered) or the user dismissed; no answer is expected. */
  superseded_at: string | null;
  /** On an orchestrator row: the id of the user message whose turn produced it, so a reply that lands after a newer user message can say which one it answers (round 16). Null for a turn started by a notice or an answer. */
  reply_to?: number | null;
  /** Images attached to a user message; the web builds the download URL from the chat id and array index, so no path travels here. */
  attachments?: Array<{ name: string; mime: string; size: number }>;
  /** On a system row reporting that a user message was not delivered (a thrown delivery or a refused start): that user row's id. Chat offers Retry on it. */
  failed_for?: number | null;
  /** Set on every failure row of a user message once a Retry of it was accepted; Chat then shows no Retry on them. */
  retried_at?: string | null;
}

/** A chronological chat page. `oldest_id` is the cursor for the oldest paginated row; `rows` can also include an older `reply_to` row needed to render a reply, and always includes every open question (kind `question`, unanswered, not superseded) and every row with `queued_at` set, however old, so the Office Needs strip and Chat pin see them on the latest page. `has_more` and `oldest_id` describe the window only. */
export interface ChatPage {
  rows: ChatRow[];
  has_more: boolean;
  oldest_id: number | null;
}

/** A user message sent from Chat. Missing `open_question_ids` is kept for older web pages; an empty list means none were open when the draft began. */
export interface ChatSendRequest {
  text: string;
  repo?: string;
  attachments?: Array<{ name: string; mime: string; data: string }>;
  open_question_ids?: number[];
}

export interface Bead {
  id: string;
  title: string;
  description: string;
  status: BeadStatus;
  priority: number;
  labels: string[];
  notes: string;
  assignee: string | null;
  closed_at: string | null;
  /** Number of beads this one depends on (`bd list` reports it); 0 means nothing can block it. */
  dependency_count: number;
}

export interface BoardCard {
  bead: Bead;
  repo_id: string;
  batch_id: string | null;
  column: BoardColumn;
  state: CardState;
  harness: HarnessName | null;
  branch: string | null;
  cost: number | null;
  elapsed_ms: number | null;
  session_status: SessionStatus | null;
  /** The last session of this bead, so a `session_ended` notice can be matched to its card before the next board arrives. */
  session_id: string | null;
  /** Tail of the verify output when the last verification of this bead failed and the bead is not running or verifying again; null otherwise. */
  verify_failure: string | null;
  /**
   * What the task pane's verification block shows once the detail arrives: `none` (no verification recorded on this bead's
   * worktree), `label` (a run with no verify command: the heading alone) or `output` (heading and output). The card state and the
   * branch cannot answer this — a failed verification survives a re-dispatch and a bead closed as won't-do never ran one — so the
   * daemon reports it and the pane's loading placeholder reserves exactly that block.
   */
  verify_block: 'none' | 'label' | 'output';
  tier: TierName | null;
  model: string | null;
  /** Account selected for the latest session; null uses the machine login. */
  account?: string | null;
  account_name: string | null;
  account_label: string | null;
  findings: Finding[] | null;
  accepted_note: string | null;
  /** The background action running for this bead right now, null otherwise. */
  pending_action?: PendingAction | null;
}

export interface BoardResponse {
  bd_ok: boolean;
  repos: { repo: Repo; batches: BatchSummary[]; cards: BoardCard[] }[];
}

export interface TaskDetail {
  bead: Bead;
  repo: Repo;
  /** While the bead is open and waits on others: the ids of the open beads blocking it (`bd blocked`), so its pane names them instead of counting them. Empty otherwise, and when the read failed. */
  blocked_by: string[];
  sessions: SessionRow[];
  worktree: WorktreeRow | null;
  last_assistant_text: string | null;
  diff: string | null;
}

export interface StatusResponse {
  bd_ok: boolean;
  /** `busy`: a turn is in progress (something was delivered, no turn end yet); a live session between turns is not busy. */
  /** `context`: tokens the orchestrator's last request used and its model's context window, for a percentage; null until the first turn ended or when the harness reports no window. */
  orchestrator: { status: SessionStatus | 'idle'; native_session_id: string | null; last_activity_at: string | null; busy: boolean; model: string | null; context: { tokens: number; window: number } | null };
}

export interface DaemonStatus {
  pid: number;
  started_at: string;
  commit: string | null;
  source_head: string | null;
  restart_needed: boolean;
  restart_in_progress?: boolean;
  restart_failure?: DaemonRestartFailure | null;
  /** The daemon's data dir, so a plain start only takes the port from a daemon of the same install. */
  data_dir?: string;
  /** The checkout that supplied the daemon code, so another worktree cannot replace it. */
  source_root?: string;
}

export interface DaemonRestartFailure {
  reason: string;
  output: string[];
}

export type DoctorToolName = 'git' | 'bd' | 'claude' | 'codex' | 'opencode' | 'glab';

export interface DoctorTool {
  name: DoctorToolName;
  required: boolean;
  ok: boolean;
  version: string | null;
  fix: string | null;
}

export interface DoctorResponse {
  tools: DoctorTool[];
  data_dir: { path: string; ok: boolean; problem: string | null };
}

export interface BrowseEntry { name: string; path: string; is_git_repo: boolean }

export interface BrowseResponse {
  path: string | null;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface InspectResponse {
  path: string;
  exists: boolean;
  is_git_root: boolean;
  branch: string | null;
  has_beads: boolean;
  suggested_id: string;
  problems: string[];
}

export type BeadsMode = 'stealth' | 'commit';

export interface RepoPatch {
  base_branch?: string;
  verify_command?: string | null;
  review_command?: string | null;
  setup_command?: string | null;
  merge_mode?: MergeMode;
  batch_approver?: BatchApprover;
  worker_limit?: number;
  model_filter?: Repo['model_filter'];
}

export interface RepoCreate extends RepoPatch { path: string; id?: string; beads?: BeadsMode }

/** `kept_branches`: the bead and batch branches left in the repository (Overseer never deletes a branch on Remove; it may carry unmerged work). */
export interface DeleteRepoResponse { ok: true; warnings: string[]; kept_branches: string[] }

/**
 * What a character in the office view is doing, derived from the session and lifecycle events the daemon already emits:
 * `walking_in` (a session just started, nothing recorded yet), `working` (a tool call was recorded: typing at a desk),
 * `verifying` (the bead's verify command is running: at the printer), `reviewing` (a critic session is reviewing: a reviewer
 * walks over) and `leaving` (the session ended or its bead landed). A stall is not a state: it arrives as `stalled_since`
 * beside the state the session was already in, and the web draws the stalled look from that. A usage-limit pause publishes
 * nothing: the limit is held on the account, not the session.
 */
export type OfficeState = 'walking_in' | 'working' | 'verifying' | 'reviewing' | 'leaving';

/** One character in the office view: a running session, or a bead whose verification is running between sessions. */
export interface OfficeSession {
  session_id: string;
  role: SessionRole;
  harness: HarnessName;
  model: string | null;
  /** The model id the harness resolved for its main thread once it reported one (see `SessionRow.resolved_model`); the label shows it over `model`. */
  resolved_model: string | null;
  account_label: string | null;
  bead_id: string | null;
  bead_title: string | null;
  batch_id: string | null;
  repo_id: string | null;
  state: OfficeState;
  /**
   * When the stall sweep last found this session silent past the threshold, as an ISO time, or null. It sits beside
   * `state` rather than replacing it, so clearing the mark returns the character to the pose it already had. The mark is
   * set by the sweep, cleared by the session's next event, and cleared by a later sweep that no longer finds it stalled.
   */
  stalled_since: string | null;
}

export type OfficeMilestoneKind = 'verify_passed' | 'verify_failed' | 'review_ready' | 'merged';

export type WsMessage =
  /** A session recorded an event; only the id travels, the web refetches an open Trace of that session (throttled). */
  | { type: 'event'; session_id: string }
  /** A worker or orchestrator process has exited; sent before the `board` notice that follows, so a card can read settling at once (round 12). */
  | { type: 'session_ended'; session_id: string }
  | { type: 'board' }
  | { type: 'chat' }
  | { type: 'status' }
  | { type: 'repos' }
  /** A plan was proposed, saved, approved or discarded; the web refetches the drafts and an open plan page. */
  | { type: 'plans' }
  /** A discussion was created, recorded a turn or ended; the web refetches the discussions and an open one. */
  | { type: 'discussion'; id: string }
  /** What the orchestrator is doing right now; the Chat view shows the latest non-idle one as a status line. Resent to every new socket, so a refresh mid-turn is correct. */
  | { type: 'orchestrator_activity'; activity: OrchestratorActivity }
  /** A session's office state changed; the web updates that one character. The whole set a socket starts from arrives as one `office_snapshot`. */
  | { type: 'office'; session: OfficeSession }
  /** A one-shot result or transition for the Office feed. It is not included in the connect snapshot. */
  | { type: 'office_milestone'; kind: OfficeMilestoneKind; repo_id: string; batch_id: string | null; bead_id: string | null; at: string }
  /**
   * The office's whole set, sent once on every socket connect, including when it is empty, so a view can tell "no sessions
   * are running" from "the set is not loaded yet". It replaces whatever the web held.
   */
  | { type: 'office_snapshot'; sessions: OfficeSession[] }
  /** A background action ended: its success or failure, for the web's toast. `data` is what the endpoint returned before the 202. */
  | ({ type: 'action_result' } & ActionResult);

/** The orchestrator's live activity during a turn. `summary` is one line derived from the tool call, never the full command or any tool output. */
export interface OrchestratorActivity {
  state: 'thinking' | 'tool' | 'idle';
  tool: string | null;
  summary: string | null;
  started_at: string;
}

export type CrashClass = 'harness_bug' | 'transient' | 'task' | 'auth';
export type PreflightResult = 'pass' | 'fail' | 'timeout' | 'error';
/** Which command a probe run's `command`/`result` describe: the setup command failed before verify ever ran, or verify itself. */
export type PreflightStep = 'setup' | 'verify';
export type ServerStatus = 'running' | 'stopped';
/** A long-lived process (dev server, preview, Playwright) the daemon runs on a session's behalf; see `servers/servers.ts`. */
export interface ServerRow { id: string; session_id: string; repo_id: string; bead_id: string | null; name: string | null; command: string; cwd: string; pid: number | null; pid_started_at: string | null; log_path: string | null; status: ServerStatus; started_at: string; stopped_at: string | null }

export interface PreflightRun { id: number; repo_id: string; kind: 'verify_probe'; step: PreflightStep; command: string; head_sha: string | null; result: PreflightResult | null; exit_code: number | null; output_tail: string | null; started_at: string; ended_at: string | null }
export interface PreflightReport { runs: PreflightRun[]; crashes: { harness: HarnessName; crash_class: CrashClass; count: number }[] }

/** A multi-model discussion's lifecycle: `running` until it stops by its own rule, the user's Stop, a failure or the cost cap. */
export type DiscussionStatus = 'running' | 'done' | 'stopped' | 'failed';
export interface DiscussionRow {
  id: string;
  question: string;
  repo_id: string | null;
  status: DiscussionStatus;
  stop_reason: string | null;
  /** Dollars the discussion is allowed to spend; the cap ends it once the participants' cost reaches it. */
  cost_cap: number;
  created_at: string;
  ended_at: string | null;
  /** The closing synthesis, written when the discussion finishes; null until then and after a cap, user or failure stop. */
  synthesis: string | null;
  /** What the synthesis session cost, kept on the row so the total survives the repository removal that deletes its session. */
  synthesis_cost?: number | null;
  /** The discussion's question images; stored file paths are kept private to the daemon. */
  attachments?: { name: string; mime: string; size: number }[];
}
/** One participant's answer for one round; a round records one turn per participant. */
export interface DiscussionTurnRow {
  id: number;
  discussion_id: string;
  round: number;
  harness: HarnessName;
  session_id: string;
  text: string;
  /** The participant's cost at that turn, `cost ?? estimated_cost ?? 0` on its session. */
  cost: number | null;
  created_at: string;
}
/** A participant of a discussion: its harness, its live or ended session and that session's cost. */
export interface DiscussionParticipant {
  harness: HarnessName;
  session_id: string;
  status: SessionStatus;
  cost: number;
}
export interface DiscussionSummary extends DiscussionRow {
  turns: number;
  cost: number;
  /** The highest round with at least one recorded turn; 0 before the first answer. */
  rounds: number;
  /** True while that round still waits on an active participant's answer. */
  round_in_progress: boolean;
}
export interface DiscussionDetail extends DiscussionRow { turns: DiscussionTurnRow[]; participants: DiscussionParticipant[]; cost: number }

export * from './plan';
