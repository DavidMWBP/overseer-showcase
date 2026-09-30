# Preflight: verify probe, dispatch gate, worker-exit classifier

Date: 2026-09-16. Status: approved design, not yet planned.

## Problem

Two failure classes waste dispatch cycles before any work can be judged.

1. A verify command that fails on every tree (for example `node -e "process.exit(1)"`) reopens beads two or three times before prompt rule 22 or the user notices it.
2. A worker that crashes is reopened, and the orchestrator decides what to do, with no record of why it crashed. Evidence from `~/.overseer/sessions` on 2026-09-16 (28 failed codex sessions):
   - 4 × `codex exited with code 2`, 0 s, stderr is clap usage text (`codex exec [OPTIONS] <COMMAND>`). An adapter argument bug, none since 2026-09-15. A retry on any model fails the same way.
   - 19 × `event stream failed: codex session …`, some after 3–10 s, others after 35–80 min.
   - 2 × `apply_patch verification failed`, 1 × sandbox `CreateProcess` rejection.
   - The `rmcp … AuthRequired` stderr line on every codex run since 2026-09-16 17:51 is noise: 12 codex sessions ended normally after it.

## Out of scope

The /insights report proposed more checks. These are left out, with the reason:

- Dependency install: the per-repo `setup_command` already runs in every worktree and reopens with `setup_failed`.
- Port reaping: killing processes on the user's machine is risky; `TurnGrace` and the Claude `end()` sweep already clean orphans (overseer-xnj stays open separately).
- commitlint: `git/message.ts` already writes conventional merge commits.
- Network reachability: no host list is configured; prompt rule 15 covers a 403 without VPN.
- A Claude Code PreToolUse hook: `spawn_worker` is daemon code and Board re-dispatch bypasses the orchestrator, so the gate lives in the daemon.

## Design

### Verify probe

- Trigger: saving a repo in Setup (`POST`/`PUT` of the repo) when the setup or verify command changed, and a Re-probe button in the repo's Setup row (`POST /api/repos/:id/probe`).
- Run: in the daemon-owned base worktree (the one `mergeLocal` uses) at the current base head, run the setup command, then the verify command, through `lifecycle/verify.ts`. The probe runs in the background; the save answers at once.
- Record: one `preflight_runs` row per probe: `id, repo_id, kind ('verify_probe'), head_sha, command, exit_code, output_tail (last 600 chars), started_at, ended_at`.
- State: `repos.verify_suspect` (new column via `ADDED_COLUMNS`), set to the run id on a non-zero exit, cleared to null on exit 0. No verify command configured: no probe, flag cleared.
- Gate: while `verify_suspect` is set, `spawn_worker`, `redispatch` and the plan approval's dispatch refuse with `<setup|verify> command "<command>" exits <code> on <base> at <short sha>; fix it in Setup → Edit, then Re-probe (`times out` replaces `exits <code>` after a timeout; `setup` names the step when the setup command is the one that failed)`. Beads already running are not touched.
- Notice: on the transition to suspect, one Chat notice (third person, with a `hint` for the orchestrator not to re-dispatch) and a web push. `lib/needsYou.ts` gains a kind `repo` for a suspect repo; its row opens Setup on that repo.
- Prompt rule 22 stays: it covers a command that passes on the base but fails on a branch for reasons outside the change.

### Worker-exit classifier

- `lifecycle/crash.ts`: `classifyExit(endReason: string, stderrTail: string | null): 'harness_bug' | 'transient' | 'task'`, a pure function.
  - `harness_bug`: stderr contains clap usage output (`Usage:` / `For more information, try '--help'`), or the process exits with code 2 in under 2 s.
  - `transient`: end reason starts with `event stream failed`.
  - `task`: everything else.
- Called where a failed worker session is handled today (next to `exitReasonFrom`).
- Actions:
  - `harness_bug`: reopen with the reason and a Chat notice telling the user the harness failed to start; no retry. The orchestrator hint says not to re-dispatch on the same harness.
  - `transient`: the first transient crash of a bead in the current dispatch re-dispatches once automatically on the same harness and model, without step-up, like the rate-limit path. A second transient crash reopens as `task` does.
  - `task`: today's behaviour.
- Record: one `batch_signals` row of kind `crash` per decision (`<class>: <reason>`), so it reaches `batch_retrospective`.

### History

- `GET /api/repos/:id/preflight` returns the last 20 probe runs and crash counts per harness and class for the repo.
- Setup shows on each repo row the last probe result (pass, fail with exit code, or none) and the crash counts.

## Error handling

- The probe itself failing to start (missing base worktree, dirty base worktree) records an `exit_code` of null with the error text and does not set `verify_suspect`: an unrunnable probe is not evidence against the command. The Setup row shows the error.
- A probe that times out (the verify timeout) sets `verify_suspect`.
- A second save while a probe runs queues one more probe; the last result wins.

## Testing

Tests first, real tmp git repos and `:memory:` SQLite as the conventions require.

- Probe with `process.exit(1)` sets the flag; `spawn_worker`, `redispatch` and plan approval refuse with the quoted reason; a save with a passing command clears it and dispatch works.
- Probe error (no base worktree) records a run and leaves the flag clear.
- `classifyExit` table test with the real stderr samples above as fixtures.
- A transient crash re-dispatches exactly once; the second reopens; a `harness_bug` never re-dispatches; each writes one `crash` signal.
- Web: the `repo` Needs row and the Setup row states, including a 390 px screenshot.

## Documentation

Same batch: the batches spec (dispatch gate, crash classes), `README.md` (Setup probe, Needs row), `CLAUDE.md` (layout entries for `preflight_runs`, `crash.ts`, the new route), and the orchestrator prompt's rule 22 mentioning the gate.
