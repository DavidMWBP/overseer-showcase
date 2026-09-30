# Overseer

Local dashboard that drives coding-agent CLIs (Claude Code, Codex, OpenCode) through one orchestrator session. pnpm monorepo, TypeScript, Node >= 22.13.

- Specs: `docs/superpowers/specs/2026-09-12-overseer-design.md` (v1) and `docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md` (batches, board speed, orchestrator sessions, traces, the current UI). The batches spec is kept current: read it before changing behaviour.
- User-facing overview and quick start: `README.md`; full workflows, screens, configuration, API, and development details: the matching page in `docs/guide/`.
- `AGENTS.md` only points here (Codex reads `AGENTS.md`, not `CLAUDE.md`), so nothing else is kept there.

## Where things are documented

Claude Code loads a package's `CLAUDE.md` when you work under that package. Codex and OpenCode do not: read the package file of every package you touch.

| Topic | Section |
|---|---|
| Commands, configuration, conventions | this file |
| Daemon restart, `pnpm start` port takeover, the ready gate | `packages/daemon/CLAUDE.md` → Daemon restart and port takeover |
| REST routes, the `/api/events` socket, background action jobs | `packages/daemon/CLAUDE.md` → REST API and socket |
| Lifecycle: settling, verify-only beads, review rounds, merges, sweeps, reaper, MR watcher, preflight | `packages/daemon/CLAUDE.md` → Lifecycle |
| Orchestrator, notices, chat delivery, `chat_batch_links` | `packages/daemon/CLAUDE.md` → Orchestrator and chat |
| Accounts, OAuth refresh and auth resume, usage limits | `packages/daemon/CLAUDE.md` → Accounts and auth |
| Tiers, forced harness, `needs_server` | `packages/daemon/CLAUDE.md` → Routing and tiers |
| Harness adapters (claude, codex, opencode), MCP wiring, long-lived servers | `packages/daemon/CLAUDE.md` → Harnesses, Long-lived servers |
| Discussions, plans, pricing, reports, push, prompts and prompt evals | `packages/daemon/CLAUDE.md`, one section each |
| Office (room, lighting, props, characters, camera, Pixi) | `packages/web/CLAUDE.md` → Office |
| Board, Chat, Review, Plans, Usage, Evidence, Needs strip, phone layout | `packages/web/CLAUDE.md`, one section each |
| Loading placeholders (shimmer) | `packages/web/CLAUDE.md` → Loading placeholders |
| Browser layout tests (`test:*-layout`) | `packages/web/CLAUDE.md` → Layout tests |

Documentation surfaces: a behaviour change updates the batches spec, `README.md` (the user's overview), the `docs/guide/` page covering the changed area, and the `CLAUDE.md` that covers the area (this file or a package file, per the table) in the same batch.

## Commands

- On Windows run `pnpm`, `npm`, `npx`, `vitest`, `playwright` and `playwright-cli` in PowerShell; Git Bash is for `git` and file inspection.
- In a Claude session started by the daemon (or any session whose settings register the same hook), a Bash call with a segment starting with one of exactly those six names is denied and answered with the PowerShell form (`packages/daemon/hooks/deny-background.cjs`); the check splits on `|` even inside quotes.
- A corepack module-not-found error (`...\corepack\dist\pnpm.js`) means the wrong shell, not a broken tree.

| Command | Purpose |
|---|---|
| `corepack enable && pnpm install` | one-time setup |
| `npm install -g @beads/bd` | beads CLI, required (bd 1.2.2); on Windows the npm postinstall can fail, then copy `bd.exe` from the GitHub release into the package's `bin` directory |
| `pnpm dev` | daemon on :4400 and web on :5173 with a file watcher (`OVERSEER_WATCH=1`); for working on Overseer |
| `pnpm --filter @overseer/daemon dev` | the daemon alone, with the watcher |
| `pnpm start` | daemon and web without the watcher: the daemon you orchestrate with |
| `pnpm --filter @overseer/web build` | production bundle (`vite build`); `pnpm start` does not need it, it serves the web through Vite |
| `pnpm typecheck` | all packages; the web typecheck also covers `packages/web/test-only` without adding it to the app build |
| `pnpm test` | `pnpm -r test`: the daemon's fast files and the web suite |
| `pnpm --filter @overseer/daemon test [file\|filter]` | daemon fast files (`packages/daemon/vitest.config.ts`'s `include` minus `slowTestFiles`) |
| `pnpm --filter @overseer/daemon test:slow [file\|filter]` | the three slow files: `src/beads/beads.live.test.ts`, `src/daemon-restart.integration.test.ts`, `src/api/evidence.performance.test.ts` |
| `pnpm --filter @overseer/web test -- <pattern>` | web vitest (jsdom, 15 s test timeout) |
| `pnpm --filter @overseer/web test:<script>` | real-browser checks (the `test:*-layout` scripts plus `test:office-chat-dock` and `test:office-offline`); first `pnpm --filter @overseer/web exec playwright install chromium webkit` (`test:chat-layout` also runs WebKit); list in `packages/web/CLAUDE.md` → Layout tests |
| `pnpm --filter @overseer/daemon record:claude\|record:opencode\|record:codex` | record harness fixtures |
| `pnpm --filter @overseer/daemon eval:prompt` / `eval:loop` | prompt eval and shortening loop (spend tokens); flags in `packages/daemon/CLAUDE.md` → Prompts and evals |
| `node scripts/demo/record.mjs [--out <file.mp4>] [--from <work dir>]` | records the scripted demo (`scripts/demo/`, fictional data, temp daemon and ports) as a captioned 1920x1080 MP4 with ffmpeg on `PATH`; default output `~/.overseer/evidence/demo/overseer-demo.mp4` beside `contact-sheet.png` and `captioned-waits.json`; `--from` re-edits an earlier raw recording |

### Tests

- The whole daemon suite is `pnpm --filter @overseer/daemon test && pnpm --filter @overseer/daemon test:slow`; a Definition of Done that means the whole suite, or filters by substring, names both, because a bare substring under `test` (no explicit file; `test -- <x>` is the same) reaches only the fast files it matches and silently skips a matching slow file.
- `pnpm --filter @overseer/daemon test <file>` runs one file correctly whichever list it is in: the wrapper (`packages/daemon/scripts/test.mts`, deciding through `packages/daemon/src/util/test-mode.ts`) reruns vitest under `--mode slow` when the file is in `slowTestFiles`. Naming files from both lists in one call fails, naming the two commands to run instead. `test:slow <filter>` stays slow (`daemon-restart` reaches the slow file); naming a fast file there fails with the same message.
- Every vitest run is capped at 4 worker processes so overlapping runs share the 16-thread box. `OVERSEER_VITEST_MAX_FORKS` overrides the cap (any positive integer); it is read from the shell only, never from `.env`.
- The beads-live and daemon-restart slow files spawn real processes (git, bd, a second daemon); the evidence performance file creates 11,000- and 5,000-file temporary fixtures. Process tests can be flaky under load. `packages/daemon/src/vitest-config.test.ts` asserts every `src/**/*.test.ts` file is reached by exactly one of the fast run or `slowTestFiles`.
- Env switches: `OVERSEER_LIVE=1` enables the live CLI tests (spend tokens); `OVERSEER_RECORD=1` lets the beads live test rewrite fixtures.
- Daemon test conventions (real git, real SQLite, the fake adapter, async child processes): `packages/daemon/CLAUDE.md` → Testing.

### `pnpm dev` vs `pnpm start`

- `pnpm start` is the user's setup: the web served over Tailscale HTTPS to a Home Screen app on an iPhone. A merge to main changes nothing in that daemon until it restarts, and the orchestrator sees new MCP tools only after New session.
- Restart from Setup → Restart (`POST /api/daemon/restart`), which reinstalls when the lockfile or a `package.json` changed and keeps the current daemon serving on any failure. A plain `pnpm start` takes the port over only from an Overseer daemon of the same data dir and checkout. `pnpm dev` never takes an occupied port, and warns when a managed repo is its own source root (a merge restarts it mid-merge). Details: `packages/daemon/CLAUDE.md` → Daemon restart and port takeover, and `docs/daemon-restart-failure-modes.md`.
- Tests and throwaway daemons use a temp data dir and a free port, never port 4400 or `~/.overseer`, which belong to the live daemon.

### Manual smoke run

The end-to-end smoke run (batch flow, verification failure and recovery, Close bead, Merge, review round, crash recovery; about 20 minutes and a handful of live Claude Code sessions) is the `overseer-smoke` skill, `.claude/skills/overseer-smoke/SKILL.md`.

## Layout

- `packages/daemon` — all state and side effects: Fastify REST and websocket, node:sqlite, the harness adapters, the lifecycle, the MCP server the orchestrator and every session call. Detail: `packages/daemon/CLAUDE.md`.
- `packages/web` — React + Vite UI; talks only to `/api` (Vite proxies it to the daemon). Detail: `packages/web/CLAUDE.md`.
- Data flow: the web fetches REST from `/api/*` (`packages/daemon/src/api/rest.ts`) and follows the `/api/events` websocket (`packages/daemon/src/api/ws.ts`), both proxied by Vite to the daemon, whose entry point is `packages/daemon/src/index.ts`. The orchestrator and every harness session call the daemon back over MCP at `/mcp/<session id>`.
- `packages/shared` — API types shared by both (`SessionRole`, `BoardCard`, `BatchSummary`, plans in `src/plan.ts`).
- `packages/daemon/prompts/` — orchestrator, worker, critic and discussion prompts; `docs/lessons.md` records the incident behind each prompt rule.
- `.claude/skills/` — `overseer-smoke` (manual smoke run), `pixellab` (Office art), `office-critic` (Office art critique), `playwright-cli`, `playwright-best-practices`.

## Configuration

- A repo-root `.env` (git-ignored; `.env.example` lists every runtime variable except `OVERSEER_PROMPTS_DIR` and `OVERSEER_WATCH` (set by the daemon's `dev` script); the test switches `OVERSEER_LIVE`, `OVERSEER_RECORD` and `OVERSEER_VITEST_MAX_FORKS` are not in it) is loaded by `packages/daemon/src/index.ts` (`process.loadEnvFile`) and `packages/web/vite.config.ts` (Vite's `loadEnv` on the repo root); shell variables win.
- Web (`vite.config.ts`): `OVERSEER_PORT` for the API proxy target, `OVERSEER_WEB_PORT` (5173), `OVERSEER_WEB_HOSTS` (comma-separated hostnames accepted besides localhost; the user's hostnames). Vite listens on every interface (`host: true`) but refuses a Host header it does not know, so a name you serve it under must be in `OVERSEER_WEB_HOSTS`.
- Daemon (`packages/daemon/src/config.ts`; `OVERSEER_PUSH_SUBJECT` in `src/push/push.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `OVERSEER_PORT` | 4400 | daemon port |
| `OVERSEER_DATA_DIR` | `~/.overseer` | `overseer.db`, `worktrees/`, `orchestrator/`, `sessions/` (one stdio log per harness session), `reports/` (one nightly count per day), `evidence/`, `discussions/`, `servers/` (long-lived server output), `accounts/` (login logs, codex homes), `models.dev.json` (price catalog cache), `daemon.log`, `daemon-restart.log` |
| `OVERSEER_PROMPTS_DIR` | `packages/daemon/prompts` | prompt directory |
| `OVERSEER_ORCHESTRATOR_IDLE_MIN` | 30 | minutes of inactivity before the next message starts a fresh orchestrator session |
| `OVERSEER_STALL_MIN` | 15 | minutes of silence before a running worker or critic is reported stalled; 0 starts no sweep |
| `OVERSEER_IDLE_END_MIN` | 3 | minutes a worker idles after a turn end with a non-empty final message before it is ended as a clean end; 0 starts no sweep |
| `OVERSEER_REAP_MIN` | 5 | minutes between orphan-reaper passes; 0 starts no reaper |
| `OVERSEER_RETENTION_DAYS` | 14 | days after a session ends before its events and log are deleted (the row, cost and token counts stay); 0 or an invalid value falls back to 14, so it never disables retention |
| `OVERSEER_USAGE_THRESHOLD` | 95 | Claude OAuth usage percentage threshold; reduced by the per-session reserve for each other running session on the account (the session being resumed is excluded) and floored at half this value |
| `OVERSEER_USAGE_RESERVE_PER_SESSION` | 2 | percentage points to subtract for each other running session on a Claude OAuth account; a blank, negative or non-finite value falls back to 2, and 0 is valid |
| `OVERSEER_PUSH_SUBJECT` | `mailto:overseer@example.com` | VAPID subject for web push |
| `OVERSEER_BD`, `OVERSEER_CLAUDE`, `OVERSEER_CODEX`, `OVERSEER_OPENCODE`, `OVERSEER_GLAB` | on `PATH` | binaries |

- `OVERSEER_RESTART_AFTER_PID` and `OVERSEER_RESTART_AFTER_STARTED_AT` (set for a restart successor) and `OVERSEER_HOLDERS_FILE[_2]` (set for the session-log holder sweep in `util/procs.ts`) are internal; never set them by hand.
- No env var exists for the orchestrator model/effort/prompt override or the tier candidate lists: they are rows in the DB `settings` table, edited in Setup → Models (`packages/daemon/CLAUDE.md` → Routing and tiers). Per-repo settings (verify, setup and review commands, `review_rounds`, `batch_approver`, merge mode, `model_filter`: optional harness/model/account allow-lists on global worker tiers (critics remain global), `worker_limit`: running workers per repo, default 2) are edited in the repo's Setup form.
- Deleting `~/.overseer` resets everything, including the orchestrator session.

## Conventions

- When one command decides a verification-only bead's pass or fail, `spawn_worker` may pass `verify_command` only with `verify_only: true`; a re-dispatch with `verify_only: true` keeps the stored command when no new `verify_command` is supplied. The daemon runs it in the bead worktree at session end and records its command, head, exit code and parsed counts. This verify-only close applies when the branch has no commits, only merge commits or an empty diff (a re-dispatched bead's branch carries earlier refresh merges); a branch with real commits goes on to verification and landing. A passing run closes as verified; a failing run reopens as `verify_incomplete` with its output tail and includes a same-command worker PASS line when present. Any worker Check failure still reopens. Unless a stop wins, an opted-in evidence report is checked against the bead description, final message and worktree HEAD before either close; a failure reopens as `verify_incomplete` with its problems in the note and notice. If `verify_command` and the gate both fail, one reopen includes both reasons. Matching of `Check:` and `PASS` remains case-insensitive. Without `verify_command`, an all-PASS Check result closes as worker-reported with the `overseer:worker-reported` label, close reason, notice and card state text; a missing, failed, blocked, not-run or malformed check keeps its existing `verify_incomplete` reason and reopens with the missing or offending lines in its note and notice.
- Tests use real git repos (`src/test/tmpgit.ts`), real SQLite (`:memory:`), the fake adapter (`src/harness/fake.ts`) and a real in-process MCP client; test output must stay free of warnings.
- One bd write per lifecycle transition (`store.update` takes status, phase and note together). A bd call costs about half a second and the board's `bd list` queues behind that repo's writes; its last result is reused for up to two seconds while nothing in the repo's `.beads` moved (the files bd rewrites on a mutation), and any write clears it.
- Notices have two readers: the text is Overseer's log line about the user in the third person and is shown in Chat; instructions for the model travel as `hint` and are never rendered. A notice kind the orchestrator prompt calls no-action (`isQuietNotice`, `src/orchestrator/quietNotices.ts`) starts no orchestrator turn, live session or not: it is written to the chat as queued, to its bead's notes when the caller passes `beadId` (`noteBead` in `index.ts`), and prepended to the next turn under `[Overseer] Since your last turn:`, once; everything else still starts or joins a turn as before.
- Chat replies stay focused on questions, decisions, actionable failures and completed requests; the orchestrator searches and reads for itself before using a helper, caps helper reports at about 100 words because the full report reaches Chat, and skips progress recaps between tool calls. The one-line note before a call expected to take over a minute remains.
- Card and pane actions are driven by `BoardCard.state`, never inferred in the web from separate fields.
- Commits are Conventional Commits (`<type>(<scope>): <subject>`). Commit with explicit paths; never commit `docs/superpowers/plans/*.tasks.json` (execution-status mirrors), evidence, screenshots or probe output.
- Nothing committed to this repository may name the user, their employer, or a managed repository's host, or contain product or customer text, account names, email addresses, home paths, or likeness references. Replace those details with fictional stand-ins.
- `.npmrc` sets `shell-emulator=true`, so a `VAR=1 cmd` package script (the daemon's `dev`) runs on Windows too; keep it.
- Schema changes extend `ADDED_COLUMNS` / `ADDED_INDEXES` in `packages/daemon/src/db/schema.ts`; there is no other migration mechanism.

## Harness status

- Claude Code: exercised live as orchestrator and worker; one known gap (detached Bash child).
- Codex: the default worker tiers, with a Claude fallback; reports no cost.
- OpenCode: fixture only, not exercised live; skipped for `needs_server`.
- glab: needed for the `gitlab-mr` merge mode after `glab auth login`.
- Detail, gaps and versions for each: `packages/daemon/CLAUDE.md` → Harnesses and → MR watcher.

