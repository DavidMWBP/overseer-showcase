# Overseer setup design

Date: 2026-09-12. Status: approved in brainstorming. Extends `2026-09-12-overseer-design.md`.

## 1. Goal

The user never types a setup command. After `pnpm dev` they open the dashboard, see which prerequisites are missing and how to fix them, and register a repository by picking a folder. Overseer initialises beads in that repository itself, in stealth mode by default, so a repository shared with a team that does not use beads or Overseer gets no committed files.

Non-goals: installing tools for the user, detecting whether a CLI is logged in, changing a registered repository's path, multi-user or remote access.

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Entry point | Dashboard only; no CLI wizard, no orchestrator tool | A CLI wizard is still a command to remember. The orchestrator needs a registered repo to exist, so it cannot bootstrap one |
| Folder selection | Path field plus a daemon-backed folder browser | Browser folder pickers never expose the absolute path. The daemon runs on the user's machine and can list folders |
| beads init | `bd init --stealth --non-interactive`, run by the daemon | Verified on bd 1.2.2: writes `.beads/`, adds it to `.git/info/exclude`, makes no commit, writes no `AGENTS.md`. Teammates see nothing |
| Committed beads | Opt-in checkbox per repo | Some repos do adopt beads; then bd's own commit is wanted |
| Doctor | Report and explain, never install | A global npm install has a known Windows failure mode; the fix text is enough |
| `AGENTS.md` | Not needed | Claude Code reads `CLAUDE.md`; workers are told not to run `bd`; the orchestrator uses the MCP `bd` tool from its own directory |

## 3. Daemon API

All routes stay under `/api`. The daemon binds to 127.0.0.1 and is single-user, so the file-system routes are not sandboxed beyond that.

### 3.1 `GET /api/doctor`

Runs `<binary> --version` for each tool, honouring the `OVERSEER_*` binary overrides from `config.ts`, with a 5 s timeout per tool, all in parallel. Also checks that `dataDir` exists or can be created and is writable.

```ts
interface DoctorResponse {
  tools: DoctorTool[];
  data_dir: { path: string; ok: boolean; problem: string | null };
}
interface DoctorTool {
  name: 'git' | 'bd' | 'claude' | 'codex' | 'opencode' | 'glab';
  required: boolean;          // git, bd, claude are required
  ok: boolean;                // spawn succeeded and exit code 0
  version: string | null;     // first line of stdout, trimmed
  fix: string | null;         // shown when !ok
}
```

Fix texts are static per tool: `npm install -g @beads/bd` plus the Windows note for bd, `npm install -g @anthropic-ai/claude-code` then run `claude` once for claude, the install commands for the optional tools, and "install git and make sure it is on PATH" for git. The claude row's fix also appears as a hint when ok, because login state is not detectable.

No caching. The check reuses `runCapture` from `util/procs.ts`; the doctor module takes the runner as a constructor argument so tests inject a fake.

### 3.2 `GET /api/fs/browse?path=<abs>`

```ts
interface BrowseResponse {
  path: string | null;               // null at the roots level
  parent: string | null;             // null at a root or at the roots level
  entries: { name: string; path: string; is_git_repo: boolean }[];
}
```

Without `path`, returns the roots: on win32 every drive letter `A:`–`Z:` whose `<letter>:\` exists, otherwise the home directory. With `path`, returns the subfolders of that folder sorted by name, skipping names that start with `.` and entries that cannot be read. `is_git_repo` is true when `<entry>/.git` exists (file or directory, so worktrees count). A `path` that does not exist or is not a directory returns 400.

### 3.3 `POST /api/repos/inspect`

Body `{ path: string }`. Never fails for a bad path; problems are data.

```ts
interface InspectResponse {
  path: string;                 // resolved absolute path
  exists: boolean;
  is_git_root: boolean;         // `git rev-parse --show-toplevel` equals path
  branch: string | null;        // `git rev-parse --abbrev-ref HEAD`
  has_beads: boolean;           // .beads directory present
  suggested_id: string;         // basename, lowercased, non [a-z0-9-] replaced by '-'
  problems: string[];           // empty when the repo can be registered
}
```

Problems: "folder does not exist", "not the root of a git repository" (a subfolder of a repo is refused so the worktree and merge logic keep a single primary checkout), "already registered as <id>".

### 3.4 `POST /api/repos`

Body, all optional except `path`:

```ts
{ path: string; id?: string; base_branch?: string; verify_command?: string | null;
  merge_mode?: 'local-merge' | 'gitlab-mr'; worker_limit?: number; beads?: 'stealth' | 'commit' }
```

Order of operations:

1. Resolve the path and run the inspect checks; any problem is a 400 with that text. A duplicate id is 409 as today.
2. `id` defaults to `suggested_id`. It must match `^[a-z0-9][a-z0-9-]*$`, else 400; the id is also the beads prefix.
3. If `.beads` is missing: run `bd init --prefix <id> --non-interactive`, adding `--stealth` unless `beads === 'commit'`. The command runs in the repo path through the `Beads` bridge without `--json`. A non-zero exit is a 400 whose message is bd's stderr (or stdout when stderr is empty), and nothing is inserted.
4. Insert the row with the same defaults as today (`base_branch` = current branch, `merge_mode` = `local-merge`, `worker_limit` = 2). Emit `board` and `repos` on the bus.

The existing 400 for a missing `.beads` directory is removed. `beads` is ignored when `.beads` already exists.

### 3.5 `PATCH /api/repos/:id`

Body: any of `base_branch`, `verify_command` (string or null), `merge_mode`, `worker_limit`. 404 for an unknown id, 400 for an empty body or a bad value. Returns the updated row and emits `repos`. `path` and `id` are not editable.

### 3.6 `DELETE /api/repos/:id`

404 for an unknown id. 409 with `{ error, sessions: string[] }` when any session for the repo has status `running`. Otherwise: for every worktree row of the repo, run `removeWorktree` (one retry after 500 ms on failure, because antivirus scanners briefly lock fresh folders on Windows; the second failure is reported but does not stop the delete), then delete the repo's worktree rows and the repo row. Sessions and events are kept as history. `.beads` inside the repo is not touched. Emits `board` and `repos`. Returns `{ ok: true, warnings: string[] }`.

### 3.7 Shared types and WebSocket

`packages/shared` gains `DoctorResponse`, `DoctorTool`, `BrowseResponse`, `InspectResponse`, `RepoPatch`, and `WsMessage` gains `{ type: 'repos' }`. The daemon's bus already fans messages out to the socket; `repos` is added to the allowed types. The web client reloads the repo list on `repos`.

## 4. Web UI

### 4.1 Rail and routing

`View` gains `'setup'`. The rail lists it after Review. A red dot on the Setup button appears when the doctor reports a required tool as not ok or the data dir as not ok. `App` opens Setup instead of Board on first load when the repo list is empty or the doctor has a red item; the doctor is fetched once on load and on the panel's Refresh button.

### 4.2 Setup view

Three stacked sections.

**Prerequisites.** One row per doctor tool: name, required or optional, version or "not found", and the fix text when not ok (rendered in a code block). Data dir row at the end. Refresh button. While loading, rows show "checking".

**Repositories.** The registered repos as a table: id, path, base branch, merge mode, worker limit, verify command, with Edit and Remove per row. Edit swaps the row for the form in edit mode (no path, no beads checkbox) with Save and Cancel. Remove asks `confirm()` and shows the 409 session list as an inline error when refused.

**Add repository.** The form:

- Path text field with a Browse button. Typing or picking calls inspect, debounced 300 ms, and shows the result under the field: green "git repository on branch <b>" or the problems in red. Add is disabled until `problems` is empty.
- Id, prefilled from `suggested_id` whenever the path changes and the user has not edited it.
- Base branch, prefilled from `branch` the same way.
- Verify command (empty means none), worker limit (default 2), merge mode select.
- Only when `has_beads` is false: checkbox "My team uses beads: commit its files" (unchecked = stealth) with one line of help text saying that unchecked leaves nothing for teammates to see.
- Add button. Errors from the POST show inline. On success the form resets and the repo appears in the list.

**Browse dialog.** Opened by the Browse button. Shows the current path, an Up button, and the folder list from `/fs/browse`; git repos are marked and can be chosen with a Select button, other folders open on click. Starts at the roots level, or at the parent of the current path value when that exists. Choosing a folder puts its path in the field and closes the dialog.

## 5. Documentation

- README: "First use" becomes: run `pnpm dev`, open the dashboard, fix anything red under Setup, add a repository with Browse. A sentence explains stealth mode and the commit checkbox. The curl example moves to a short "API" note for scripting.
- CLAUDE.md smoke script: step 1 creates the throwaway repo without `bd init`; step 3 registers it through Setup and expects `.beads/` in `git status --ignored` as `!!`; the Windows variant drops its `bd init` remark.
- CLAUDE.md Layout gains the doctor and fs modules.

## 6. Error handling

- Every route validates its body with zod like the existing routes; validation errors are 400 with the zod message.
- bd init failures never leave a half-registered repo (init runs before insert). A repo whose init succeeded but insert failed is not possible in practice because insert is a single SQLite statement, and re-adding the same path is safe because `.beads` then exists and init is skipped.
- Doctor spawn failures (ENOENT, timeout) are `ok: false` rows, never a failed response.
- Browse and inspect treat permission errors as "cannot read" entries or problems, never 500s.

## 7. Testing

Daemon, following the existing conventions (real git repos from `tmpgit.ts`, `:memory:` SQLite, fake bd runner):

- doctor: injected runner returns success, ENOENT and timeout; assert rows, `required`, and that overrides from config are the binaries invoked.
- browse: temp tree with a dot-folder, a plain folder, a git repo folder; roots level on the current platform; 400 for a missing path.
- inspect: non-existent path, subfolder of a repo, repo root, registered repo.
- register: missing `.beads` runs init with exactly `['init', '--prefix', id, '--non-interactive', '--stealth']`, `beads: 'commit'` drops `--stealth`, existing `.beads` runs nothing, failing init returns 400 and inserts no row, bad id is 400.
- patch: updates fields, rejects unknown id and empty body.
- delete: refused with a running session, removes worktree rows and the git worktree otherwise, survives a worktree that is already gone.
- WebSocket: `repos` is delivered to a connected client on add, patch and delete.

Web (Vitest with mocked `fetch`, as in the existing view tests):

- Setup renders doctor rows with fix text for a failing required tool and marks the rail.
- Add form: inspect is called after typing, Add is disabled while problems exist, the id and branch prefill, the beads checkbox is shown only without `.beads`, and the POST body matches the fields.
- Browse dialog lists entries and fills the path on Select.
- Edit and Remove send PATCH and DELETE.

## 8. Implementation order

1. Shared types and the `repos` WebSocket message.
2. Doctor module and route.
3. Browse and inspect routes.
4. Register with beads init, PATCH, DELETE.
5. Setup view, browse dialog, rail and App routing.
6. README and CLAUDE.md.
7. Manual smoke run on Windows following the updated CLAUDE.md script.
