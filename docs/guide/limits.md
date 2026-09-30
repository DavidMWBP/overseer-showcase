# Windows and known limits

## Windows notes

- Child processes are spawned without `cmd.exe`: the daemon resolves `.exe` binaries and npm `.cmd` shims itself so multi-line prompts and descriptions survive intact. Workers run detached so they survive a daemon restart: a small launcher process (`launcher.cjs`) is the detached one, and it runs the worker with a hidden console, so programs the worker starts (`codex.exe`, `cmd.exe`, `git`, `playwright-cli`) no longer open a terminal window or take focus. The session records the worker's own pid, so adoption and interrupts reach the worker.
- Verify, setup and daemon restart install commands run through the shell (`cmd.exe` on Windows), not PowerShell.
- Process trees are killed with `taskkill /T /F`.
- Node 22 prints an experimental warning for `node:sqlite`; the scripts pass `--disable-warning=ExperimentalWarning`.
- Batch worktrees are named short (`<repo>/b<n>-<suffix>`) to keep checked-out paths under the 260-character limit. If git still cannot create one, the batch is rolled back and you are told to move `OVERSEER_DATA_DIR` closer to the drive root or enable `core.longpaths` for that repository. The orchestrator prompt forbids changing git configuration outside a worktree, so it reports the failure rather than working around it in your `.gitconfig`.

## Known limits

These are measured, understood and not bugs:

- **A board refresh takes about a second per repository.** Building the board is one `bd list` per repository, plus one `bd ready` where an open bead has a dependency, and a bd call costs roughly half a second. The daemon's own work on top of that is about 10 ms. The board's `bd list` is reused for up to two seconds while nothing in the repository's `.beads` moved (the files bd rewrites on a mutation), and any write through Overseer drops it; beyond that bd's answers are not cached, because a `bd` you or a worker runs changes bead state through no Overseer request and a cached board would be stale with nothing on screen saying so. The UI is built for that second: the previous board stays complete, every button stays enabled, and a "refreshing…" note appears after 400 ms.
- **Cost is only known when a session ends cleanly.** Claude Code states a cost in its final `result` event alone, so a worker stopped or crashed mid-turn leaves no figure, and the Codex adapter reports none at all. Overseer labels the gap instead of guessing: the card reads "cost unknown", and a total that is missing a session is shown as a floor ("≥ $0.36") with a tooltip saying how many sessions ended without one. A running worker shows no cost, because it has not reported one yet. Every session also records an API-equivalent estimate from its token counts and the model's prices in the models.dev catalog (fetched once from `https://models.dev/api.json`, cached under the data directory as `models.dev.json`, refreshed daily, and read from the cached copy when the machine is offline). The estimate sits beside the reported figure rather than replacing it, and each session stores its source: `reported` (the CLI's own figure), `estimated` (tokens times the catalog prices) or `unknown` when the model id is not in the catalog; an id that does not match exactly is never approximated by a close match.
- **Overseer never sees a repository's cost history again after Remove**, since the session rows go with the repository. Adding the same path back starts the totals at zero.

## Status and known gaps

Claude Code was exercised live as orchestrator and worker throughout a 28-round adversarial UI review on 2026-09-13/14. The OpenCode adapter is tested against a recorded real stream. The Codex adapter (Codex CLI 0.154.0) has since been exercised live and extensively as a worker: Codex models are the default `chore`, `standard` and `hard` tier candidates, and its usage-limit refusal, its lingering CLI after `turn.completed` and the orphan sweep that follows are all handled from real runs. Remaining gaps:

- `spawn_worker` does not write a `harness:<name>` label; the board falls back to the session's harness.
- The orchestrator resumes the last session's native id whenever it is recent enough, without checking whether that session failed.
- On the legacy per-bead Merge, a worktree that cannot be removed afterwards fails the request although the merge landed. The batch path logs and carries on.
- Recorded fixtures contain local paths from the machine they were recorded on.
- `GET /api/batches/:id` builds the whole board to find one batch, so it pays the board's bd cost.
