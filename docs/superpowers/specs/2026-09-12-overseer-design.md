# Overseer design

Date: 2026-09-12. Status: approved in brainstorming, revised after spec review.

## 1. Goal

A local, single-user web dashboard that replaces direct use of coding-agent CLIs. The user talks to one orchestrator agent. The orchestrator turns goals into story-sized tasks, dispatches each to a headless worker session on a chosen harness (Claude Code, Codex CLI, OpenCode), and asks the user to review and land the result. Harness support is an adapter interface so more CLIs can be added later.

Non-goals for v1: multi-user, remote hosting, live per-worker event feed in the UI, PTY/interactive terminal attach, auto-merge, GitLab issue importer, configurable orchestrator harness (Claude Code is hardcoded for the orchestrator role).

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Orchestrator | A Claude Code session started by Overseer with an MCP server attached | No custom LLM loop; uses existing subscription; resumable |
| Harness I/O | Headless JSON mode per CLI | Structured, resumable, does not break on TUI changes. Adapter interface leaves room for a PTY adapter later |
| Deployment | Local, single user, browser at localhost | CLIs, repos, and credentials already live on the machine |
| Isolation | Git worktree per task, branch `bead/<id>` | Cheap, parallel, works on Windows |
| Task store | beads (`bd`) via CLI JSON | Dependency graph, claim/ready/close, already integrates with all three harnesses |
| Stack | pnpm monorepo, TypeScript: Node daemon (Fastify + WS + SQLite), React + Vite web | One language, first-class child-process handling |
| Prior art | Build fresh, borrow designs from Vibe Kanban (worktree lifecycle, adapters, review UI) and Gas Town (beads dispatch) | Keeps the codebase small and shaped around orchestrator + beads |

## 3. Architecture

Packages:

- `packages/daemon`: all state and side effects. Harness sessions, worktrees, beads calls, SQLite, HTTP/WS API for the UI, MCP server for the orchestrator. Adapters live here as a module.
- `packages/web`: React + Vite. Views Chat, Board, Review. Talks only to the daemon. No harness knowledge.

Flow for a user goal: UI → daemon → orchestrator session. The orchestrator creates beads with `bd`, then uses Overseer MCP tools to spawn and steer workers. Worker events are appended to the daemon event log and pushed to the UI. Merge decisions happen in the Review view. The orchestrator can request a merge; only the user lands code in v1.

Two levels of orchestration, only the top managed by Overseer:

- Overseer orchestrator: across tasks. Which stories exist, dependencies, harness per task, when to request merge.
- Worker: one headless session, one bead. Runs with the harness's normal config in the worktree, so the repo's `CLAUDE.md`, plugins, skills, and the user's settings apply. A Claude Code worker will spawn its own subagents (implementer, E2E, reviewer) exactly as the user's interactive sessions do. Overseer never spawns, messages, or kills a worker's subagents; it only records their activity as nested events.

Bead granularity is a story: the size handed to a senior engineer. The orchestrator prompt states this.

## 4. Data model

### 4.1 beads owns the work

Overseer reads and writes beads only through `bd --json`, never Dolt directly. Beads is per repo; the daemon runs every `bd` call in that repo's primary checkout, never in a worktree. The orchestrator reaches `bd` only through the `bd` MCP tool (section 6); workers never call it.

Native fields used: status (open, in_progress, closed), assignee, priority, dependencies, parent/child.

Overseer labels on a bead:

- `harness:<claude|codex|opencode>`: which CLI runs it.
- `overseer:<verifying|review|merged|rejected|abandoned>`: phases beads does not model. At most one per bead; `spawn_worker` clears it.

Board columns: Ready (open, no open blockers; a rejected bead shows here with its note), Blocked, Running (in_progress, no `overseer:` label), Verifying, Review, Done (closed; the daemon closes a bead when it lands). Done lists only beads Overseer handled (an `overseer:*` label, a session or a worktree row); beads the repo closed on its own stay off the board.

### 4.2 Overseer SQLite owns the machinery

- `repos`: id, path, base_branch, verify_command, merge_mode (`local-merge` | `gitlab-mr`), worker_limit (default 3).
- `sessions`: id, harness, role (`orchestrator` | `worker`), bead_id, repo_id, native_session_id, pid, pid_started_at (together they identify the process; pids get reused), start_commit (branch head when the session started), cwd, status (`running` | `ended` | `failed`), started_at, ended_at, cost.
- `worktrees`: bead_id, repo_id, path, branch, base_branch, verify_status, verify_output, review_note, conflict_files (JSON list, null when none), merged_at, mr_url.
- `events`: session_id, seq, type, payload JSON, ts. Append only. Feeds the UI and is the audit trail.
- `chat`: id, role (`user` | `assistant` | `system`), kind (`message` | `question`), text, ts, answer, answered_at. The orchestrator conversation as shown to the user, derived from events but stored for cheap loading. A pending question is a `question` row with no `answered_at`.

### 4.3 Task lifecycle

1. Orchestrator creates a bead (`bd create`, `bd dep add` through the `bd` tool) and labels the harness.
2. `spawn_worker` sets the bead `in_progress`, creates worktree and branch `bead/<id>` unless they already exist (reject and rebase reuse them), and starts a worker session with the worker prompt. Refused at the repo's worker limit or when the bead already has a running session.
3. Worker works and commits on the branch; session ends. Workers never change bead status or labels.
4. On session end the daemon inspects the branch. New commits since `start_commit`: set `overseer:verifying`, run the repo's verify command in the worktree, store the result in `worktrees.verify_status` and `verify_output`, set `overseer:review`. No new commits: session failed, bead back to `open` with the last error or assistant text as a note.
5. Orchestrator may call `request_merge`; refused if verification failed. The note is stored as `worktrees.review_note`.
6. User merges (daemon lands the branch, removes the worktree, closes the bead, sets `overseer:merged`) or rejects with a note (daemon sets the bead `open` with `overseer:rejected` and the note; worktree and branch stay; the orchestrator re-dispatches with `spawn_worker`).

The daemon is the only writer of bead status and `overseer:` labels inside this loop. The worker prompt template at `packages/daemon/prompts/worker.md` contains the bead title and description, any reject note and conflict file list, and the optional `instructions` from `spawn_worker`; it tells the worker to commit on the current branch, to leave bead status alone, and to write Conventional Commits (`<type>(<scope>): <subject>`, header at most 72 characters, never `--no-verify`; a repo's own commitlint or CONTRIBUTING/CLAUDE.md rule wins). The same template serves every harness.

Crash recovery on daemon start: the daemon cannot re-attach to a child's output stream, so every session marked running is lost. If a process with the stored pid and start time still exists it is killed; then the session-end rule from step 4 applies, so a worker that had already committed goes to verification, not failure. The orchestrator session is resumed by native session id on its next turn; pending questions stay in `chat`.

## 5. Harness adapters

```ts
interface HarnessAdapter {
  name: 'claude' | 'codex' | 'opencode';
  start(opts: { cwd: string; prompt: string; mcpServers?: McpConfig[]; resumeId?: string }): Promise<SessionHandle>;
  send(handle: SessionHandle, text: string): Promise<void>;
  interrupt(handle: SessionHandle): Promise<void>;
  events(handle: SessionHandle): AsyncIterable<HarnessEvent>;
}

type HarnessEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; parentId?: string }
  | { type: 'tool_result'; id: string; output: unknown }
  | { type: 'file_change'; path: string }
  | { type: 'turn_end'; nativeSessionId: string; cost?: number }
  | { type: 'process_start'; pid: number; pidStartedAt: string | null }
  | { type: 'raw'; line: string }
  | { type: 'error'; message: string };
```

Rules:

- Claude Code: `claude -p --output-format stream-json`, resume with `--resume <id>`. Codex: `codex exec --json`, resume via its session mechanism. OpenCode: `opencode run --format json` with its session flag. Exact flags are verified against installed versions during implementation.
- Parse the JSON stream line by line; unparseable lines become `raw` events, never a crash.
- Fields a harness lacks are absent, not faked.
- Sessions run headless, so a tool call that would prompt is denied, not asked. Overseer therefore starts every session in the harness's autonomous permission mode (Claude Code's bypass-permissions mode, Codex `--full-auto`, OpenCode's equivalent) and relies on the worktree for isolation. Everything else comes from the harness's normal config. A denied call arrives as a `tool_result` error; a session that then ends without a new commit fails per section 4.3.
- `parentId` carries subagent nesting where the harness reports it.

## 6. Orchestrator

Runs from Overseer's own directory, not inside a repo, started like a worker (section 5 rules) with the Overseer MCP server attached and allowed. Every tool takes the repo explicitly.

MCP tools (daemon-hosted, attached only to the orchestrator session):

- `list_repos()`, `list_tasks(repo, filter)`
- `bd(repo, args)` → runs `bd --json` with those args in the repo's primary checkout. A write command (`create`, `note`, `update`, `close`, `dep add`/`dep remove`, `label add`/`label remove`) returns only the bead id(s), status and title — its labels on `create`, the two ids and dependency type on `dep add`/`dep remove` — and `dep list` returns id, title and status per dependency, so the long description and notes are never handed back to be re-read; every read command, `show` included, returns bd's full output, and a failing command returns bd's error text. The orchestrator's only path to beads.
- `spawn_worker(repo, bead_id, harness, instructions?)` → session id. Reuses the bead's worktree and branch when they exist. Errors clearly at the repo's worker limit or when the bead already has a running session.
- `message_worker(session_id, text)`, `interrupt_worker(session_id)`
- `worker_status(session_id)` → state, last assistant text, files changed, cost
- `worker_diff(repo, bead_id)` → diff against base
- `request_merge(repo, bead_id, note)` → stores the note as `worktrees.review_note` and flags for review. Never merges.
- `ask_user(question)` → posts the question to Chat and returns its id without waiting. The orchestrator ends its turn; the answer arrives as its next message, prefixed with the question. Pending questions live in `chat`, so they survive a daemon restart.

Task CRUD has no dedicated tools; the orchestrator uses `bd` through the `bd` tool, never from its own shell, so every call lands in the right repo.

System prompt lives at `packages/daemon/prompts/orchestrator.md`, editable. Rules it states: story-sized beads; pick harness per task; do not micro-manage worker internals; request merge only after verification passes, with a note that reads as an MR description; resolve the target repo by user statement, then `list_repos` inference, then `ask_user`; ask the user only when blocked or when a decision is irreversible, and end the turn after asking.

## 7. Git provider

```ts
interface GitProvider {
  land(worktree: Worktree, description: string): Promise<{ mrUrl?: string }>;
}
```

- `local-merge`: merge branch into base in Overseer's persistent base worktree, remove worktree. When the primary checkout already has the base branch checked out, merge there because Git allows the branch in only one worktree.
- `gitlab-mr`: push branch, open MR via `glab` (already authenticated against the user's self-hosted instance), record MR URL, remove worktree. The MR description is `worktrees.review_note`, written by the orchestrator from bead and diff in `request_merge`; when the user merges without one, the bead title and description are used.

Merge conflict: abort, keep the task in Review, store the conflicting paths in `worktrees.conflict_files` (shown in Review and `GET /tasks/:id`, cleared on the bead's next session end), and post a `system` chat message to the orchestrator with the list. It may dispatch a rebase with `spawn_worker(..., instructions)`; the worker prompt already carries the conflict files.

## 8. API and UI

REST: `GET/POST /repos`, `GET /board`, `GET /tasks/:id` (bead, sessions, and the `worktrees` row: verify result, review note, conflict files), `POST /tasks/:id/merge`, `POST /tasks/:id/reject` (note required), `GET/POST /chat`, `POST /chat/answer` (question id and text). WS `/events` pushes every new event row plus board and chat changes; the UI never polls.

Views, with a shared left rail (repos, orchestrator status):

- Chat: orchestrator thread, tool calls collapsed to one line, pending `ask_user` pinned at top with an answer box, repo selector that prefixes messages with repo context.
- Board: six columns. Card shows title, harness, branch, cost, elapsed. Detail shows description, last assistant text, verification output, link to Review.
- Review: tasks in review. Per-file diff, verification result, orchestrator note, conflict files when present, merge and reject buttons.

## 9. Error handling

- Worker crash, non-zero exit, or clean exit without a new commit (denied tool calls, context limit, gave up): session failed, bead reopened with the last error or assistant text, card red. Orchestrator learns via `worker_status`.
- Verify fails: task still enters Review with the failing output; `request_merge` refused.
- `bd` missing or Dolt down: daemon starts, Board shows a banner, `spawn_worker` refuses.
- Adapter parse failure: `raw` event, session continues.

## 10. Testing

- Adapters: fixture tests from recorded real streams of each CLI.
- Lifecycle, merge, conflict, crash recovery: integration tests on a temporary git repo with a fake adapter emitting scripted events.
- UI: component tests for Board and Review with fixture data.
- Manual smoke script in CLAUDE.md: register a repo, ask for a trivial change, merge it.

## 11. Implementation order

1. Monorepo scaffold, adapter interface, CLAUDE.md.
2. Beads bridge, SQLite, lifecycle, crash recovery.
3. Adapters, MCP server, orchestrator prompt.
4. API, UI, GitProvider, error paths.

## 12. Later

Live per-worker feed, configurable orchestrator harness, GitLab issue importer, per-task auto-merge toggle, PTY attach adapter.
