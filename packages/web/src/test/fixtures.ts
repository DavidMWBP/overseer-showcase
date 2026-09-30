import type { Bead, BatchDetail, BoardResponse, ChatRow, DiscussionDetail, DiscussionSummary, DiscussionTurnRow, DoctorResponse, InspectResponse, Plan, Repo, StatusResponse, TaskDetail, TierSettings } from '@overseer/shared';

export const repo: Repo = { id: 'r1', path: 'E:/Projects/demo', base_branch: 'main', verify_command: 'pnpm test', review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2 , review_rounds: 2, model_filter: null};

/** Mirrors the daemon's DEFAULT_TIERS (packages/daemon/src/db/db.ts) for tests that don't care about tier content, just its shape. */
export const defaultTiers: TierSettings = {
  tiers: [
    { name: 'chore', candidates: [{ harness: 'codex', model: 'gpt-5.6-luna', effort: null }] },
    { name: 'standard', candidates: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }] },
    { name: 'hard', candidates: [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }] },
    { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
  ],
  denyModels: ['gpt-6-astra'],
};

const bead = (id: string, title: string, extra: Partial<Bead> = {}): Bead => ({ id, title, description: `Description of ${title}`, status: 'open', priority: 2, labels: [], notes: '', assignee: null, closed_at: null, dependency_count: 0, ...extra });

export const board: BoardResponse = {
  bd_ok: true,
  repos: [{
    repo,
    batches: [{ id: 'r1-b1', origin_chat_id: null, linked_chat_ids: [], repo_id: 'r1', title: '#9310 Trend chart', branch: 'feature/9310-trend-chart', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null, beads_total: 4, beads_done: 2, beads_closed: 0, cost: 1.2, cost_unknown: 0 }],
    cards: [
      { bead: bead('ov-1', 'Ready task'), repo_id: 'r1', batch_id: null, column: 'ready', state: 'idle', harness: null, branch: null, cost: null, elapsed_ms: null, session_status: null, session_id: null, verify_block: 'none', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-2', 'Blocked task'), repo_id: 'r1', batch_id: null, column: 'blocked', state: 'blocked', harness: null, branch: null, cost: null, elapsed_ms: null, session_status: null, session_id: null, verify_block: 'none', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-3', 'Running task', { status: 'in_progress', labels: ['harness:claude'] }), repo_id: 'r1', batch_id: 'r1-b1', column: 'running', state: 'running', harness: 'claude', branch: 'bead/ov-3', cost: 0.42, elapsed_ms: 125_000, session_status: 'running', session_id: 'sess-3', verify_block: 'none', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-4', 'Verifying task', { status: 'in_progress', labels: ['overseer:verifying'] }), repo_id: 'r1', batch_id: null, column: 'verifying', state: 'verifying', harness: 'claude', branch: 'bead/ov-4', cost: 0.9, elapsed_ms: 300_000, session_status: 'ended', session_id: 'sess-4', verify_block: 'none', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-5', 'Review task', { status: 'in_progress', labels: ['overseer:review'] }), repo_id: 'r1', batch_id: null, column: 'review', state: 'review', harness: 'opencode', branch: 'bead/ov-5', cost: 1.2, elapsed_ms: 400_000, session_status: 'ended', session_id: 'sess-5', verify_block: 'output', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-6', 'Failed task', { notes: 'Verification failed:\n$ pnpm test\n1 failed\nexit 1' }), repo_id: 'r1', batch_id: 'r1-b1', column: 'ready', state: 'verify_failed', harness: 'claude', branch: 'bead/ov-6', cost: 0.1, elapsed_ms: 20_000, session_status: 'ended', session_id: 'sess-6', verify_block: 'output', verify_failure: '$ pnpm test\n1 failed\nexit 1', tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-7', 'Done task', { status: 'closed', labels: ['overseer:merged'] }), repo_id: 'r1', batch_id: null, column: 'done', state: 'done', harness: 'claude', branch: null, cost: 2, elapsed_ms: 500_000, session_status: 'ended', session_id: 'sess-7', verify_block: 'output', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
      { bead: bead('ov-8', 'Abandoned task', { status: 'closed', labels: ['overseer:abandoned'] }), repo_id: 'r1', batch_id: null, column: 'done', state: 'done', harness: 'claude', branch: null, cost: 0.3, elapsed_ms: 33_000, session_status: 'ended', session_id: 'sess-8', verify_block: 'none', verify_failure: null, tier: null, model: null, account: null, account_name: null, account_label: null, findings: null, accepted_note: null },
    ],
  }],
};

export const status: StatusResponse = { bd_ok: true, orchestrator: { status: 'running', native_session_id: 'abc', last_activity_at: '2026-09-12T10:00:00.000Z', busy: true, model: null, context: null } };

export const reviewDetail: TaskDetail = {
  bead: bead('ov-5', 'Review task', { status: 'in_progress', labels: ['overseer:review'] }),
  repo,
  blocked_by: [],
  sessions: [{ id: 'sess-5', harness: 'opencode', role: 'worker', bead_id: 'ov-5', repo_id: 'r1', native_session_id: 'n', pid: null, pid_started_at: null, start_commit: 'a', cwd: '/wt', status: 'ended', started_at: '2026-09-12T10:00:00.000Z', ended_at: '2026-09-12T10:06:40.000Z', cost: 1.2, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null }],
  worktree: { bead_id: 'ov-5', repo_id: 'r1', path: 'C:/x/wt', branch: 'bead/ov-5', base_branch: 'main', verify_status: 'pass', verify_output: '$ pnpm test\nall green\nexit 0', review_note: 'Adds the greeting endpoint with a test.', conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null },
  last_assistant_text: 'Done. Added the endpoint and a test.',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n line\n+added\ndiff --git a/src/b.ts b/src/b.ts\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+new file\n',
};

export const doctorOk: DoctorResponse = {
  tools: [
    { name: 'git', required: true, ok: true, version: 'git version 2.45.0', fix: null },
    { name: 'bd', required: true, ok: true, version: 'bd version 1.2.2', fix: null },
    { name: 'claude', required: true, ok: true, version: '2.1.269', fix: 'Run `claude` once in a terminal to log in if you have not yet.' },
    { name: 'codex', required: false, ok: false, version: null, fix: 'npm install -g @openai/codex\nThen run `codex login`.' },
    { name: 'opencode', required: false, ok: true, version: '1.0.0', fix: null },
    { name: 'glab', required: false, ok: false, version: null, fix: 'Install glab (https://gitlab.com/gitlab-org/cli) and run `glab auth login`.' },
  ],
  data_dir: { path: 'C:/Users/me/.overseer', ok: true, problem: null },
};

export const doctorBad: DoctorResponse = {
  ...doctorOk,
  tools: doctorOk.tools.map((t) => (t.name === 'claude' ? { ...t, ok: false, version: null, fix: 'npm install -g @anthropic-ai/claude-code\nRun `claude` once in a terminal to log in if you have not yet.' } : t)),
};

export const inspectNoBeads: InspectResponse = { path: 'E:\\Projects\\demo', exists: true, is_git_root: true, branch: 'main', has_beads: false, suggested_id: 'demo', problems: [] };
export const inspectBad: InspectResponse = { path: 'E:\\bad', exists: false, is_git_root: false, branch: null, has_beads: false, suggested_id: 'bad', problems: ['folder does not exist'] };

export const chat: ChatRow[] = [
  { id: 1, role: 'user', kind: 'message', text: '[repo: r1] add a greeting endpoint', ts: '2026-09-12T10:00:00.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
  { id: 2, role: 'assistant', kind: 'message', text: 'Created ov-1 and dispatched a claude worker.', ts: '2026-09-12T10:00:05.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
  { id: 3, role: 'assistant', kind: 'question', text: 'Should the endpoint require auth?', ts: '2026-09-12T10:01:00.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
  { id: 4, role: 'system', kind: 'message', text: 'Merge of ov-2 into main conflicted in: src/a.ts', ts: '2026-09-12T10:02:00.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
];

export const batchDetail: BatchDetail = {
  batch: { id: 'r1-b1', origin_chat_id: null, repo_id: 'r1', title: '#9310 Trend chart', branch: 'feature/9310-trend-chart', base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null },
  repo,
  beads: [board.repos[0]!.cards[2]!],
  diff: reviewDetail.diff,
  cost: 1.2,
  cost_unknown: 0,
  landed_verified: 0,
};

/** One draft and one approved plan, so /api/plans (drafts) and /api/plans/all (every status) can both be answered from one fixture. */
export const plans: Plan[] = [
  { id: 'r1-p1', repo_id: 'r1', title: 'Accounts and credentials', status: 'draft', batch_id: null, revision: 1, created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z', steps: [{ title: 'Accounts table', description: 'Add the table and its columns.', dependsOn: [] }, { title: 'Login flow', description: 'OAuth with PKCE, driven from the page.', dependsOn: [0] }] },
  { id: 'r1-p2', repo_id: 'r1', title: 'Shimmer the loading states', status: 'approved', batch_id: 'r1-b2', revision: 4, created_at: '2026-09-11T10:00:00.000Z', updated_at: '2026-09-11T10:00:00.000Z', steps: [{ title: 'Pass the unloaded state down', description: 'Hand each view the null a fetch has not answered yet.', dependsOn: [] }] },
];

export const discussionTurn = (over: Partial<DiscussionTurnRow> = {}): DiscussionTurnRow => ({
  id: 1, discussion_id: 'd-1', round: 1, harness: 'claude', session_id: 's-c', text: 'Postgres.', cost: 0.25, created_at: '2026-09-12T10:00:01.000Z', ...over,
});

/** A running discussion of two participants, one turn each in round 1; a test spreads it to make a stopped, failed or done one. */
export const discussionSummary: DiscussionSummary = {
  id: 'd-1', question: 'Which storage engine?', repo_id: null, status: 'running', stop_reason: null,
  cost_cap: 5, created_at: '2026-09-12T10:00:00.000Z', ended_at: null, synthesis: null, turns: 2, cost: 0.5, rounds: 1, round_in_progress: false,
};

export const discussionDetail: DiscussionDetail = {
  ...discussionSummary,
  turns: [
    discussionTurn({ id: 1, round: 1, harness: 'claude', text: 'Postgres.', cost: 0.25 }),
    discussionTurn({ id: 2, round: 1, harness: 'codex', text: 'SQLite.', cost: 0.25 }),
  ],
  participants: [
    { harness: 'claude', session_id: 's-c', status: 'running', cost: 0.25 },
    { harness: 'codex', session_id: 's-x', status: 'running', cost: 0.25 },
  ],
  cost: 0.5,
};

