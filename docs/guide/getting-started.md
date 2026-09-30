# Getting started

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | >= 22.13 | `node:sqlite` is used for state; no native build step |
| pnpm | 10 | `corepack enable` installs it from `package.json` |
| git | any recent | worktrees and merges |
| beads `bd` | 1.2.2 | `npm install -g @beads/bd`; on Windows the npm postinstall can fail, then copy `bd.exe` from the GitHub release into the package's `bin` directory |
| Claude Code | 2.1.x | required: the orchestrator is always Claude Code. Log in once with `claude` |
| OpenCode | optional | `npm i -g opencode-ai` to dispatch `opencode` workers |
| Codex CLI | optional | `npm i -g @openai/codex` and `codex login` to dispatch `codex` workers; without it the Codex tier candidates are skipped |
| glab | optional | only for the `gitlab-mr` merge mode |

Check with `bd --version`, `claude --version`, `node --version`, or open Setup, which runs the same checks behind `GET /api/doctor` and prints the install command for anything missing.

## Install and run

```bash
corepack enable
pnpm install
pnpm dev
```

Both scripts start the daemon on http://127.0.0.1:4400 and the web UI on http://localhost:5173 (Vite listens on every interface and accepts `localhost` and IP addresses; any other hostname must be listed in `OVERSEER_WEB_HOSTS`). The UI proxies `/api` to the daemon. To start only the daemon, run `pnpm --filter @overseer/daemon dev` or `start`.

Two ways to run it:

- `pnpm dev` is for working on Overseer: the daemon runs under a file watcher and restarts on every source change.
- `pnpm start` is for the daemon you orchestrate with: the same daemon and web server, no watcher. Use it when Overseer manages its own checkout. A watched daemon restarts in the middle of merging an overseer batch, so a `pnpm dev` daemon that manages its own source root warns once at startup, in `daemon.log` and as a Chat notice. After merging an overseer batch, use **Setup → Restart daemon** to pick up the new code; the page reconnects by itself.

A daemon restart does not lose running workers. A starting daemon binds its port before it has recovered, but answers nothing until it has: health checks report that it is not ready yet, so the page stays on its reconnect poll and loads the board once, from the recovered state, instead of briefly showing workers that are already gone. One detached successor proves it has loaded before the old daemon closes its board sockets and any open MCP stream and exits; shutdown has a bounded wait, a second restart request is refused while the handoff is pending, and that successor keeps retrying a busy port. A plain `pnpm start` retries a busy port briefly, then takes it only from another Overseer daemon that uses the same data directory and source checkout: the new daemon stops that daemon process alone (never its workers, which it adopts) and logs the pid it stopped. A daemon of another data directory or checkout is never stopped. `pnpm dev` never takes an occupied port, so a watcher in another worktree cannot replace the daemon you orchestrate with. When the port belongs to a process that is not an Overseer daemon, it stops nothing and exits with a message that names that pid and process. Workers are spawned detached with their output in `~/.overseer/sessions/<session id>.log`, so they outlive the daemon; the next daemon finds them by pid, follows the log from where the previous one stopped reading (`adopted worker <session> for <bead>` in `daemon.log`), and lands their work as usual when the turn ends. Only a worker that is really gone comes back in Ready with a "daemon restarted while the worker was running" note and the last line of its log.

State lives in `~/.overseer`: `overseer.db`, `worktrees/`, `orchestrator/`, `sessions/`, `daemon.log` and the `models.dev.json` price cache. Delete that directory to start over; it also forgets the orchestrator session. A session's events and its log under `sessions/` are deleted by a nightly job once it ended more than `OVERSEER_RETENTION_DAYS` (14) days ago, while its session row, cost and token counts stay.

## First use

1. Run `pnpm dev` and open http://localhost:5173. The dashboard opens on Setup until a repository is registered, then opens Office by default; if you asked for another view, a line says which one sent you there.
2. Under Prerequisites, fix anything shown in red. Each missing tool lists the install command; nothing is installed for you.
3. Under Add repository, click Browse and pick the root folder of a git repository (or type its path). The Browse dialog has a filter field, an Up button and a Select this folder button; Select appears on a row only when that folder is a git repository. The form checks the folder as you go and fills in the id and base branch. Under Setup → Repositories, set a verify command if you want each worker's result tested, an optional review command for one full suite before each batch is handed over, and a setup command (for example `npm ci`) when its commit hooks or either the verify or review command needs installed dependencies. An empty review command keeps the existing review flow. Click Add.
4. Overseer initialises beads in that repository itself. By default this is stealth mode: `.beads/` is created and added to `.git/info/exclude`, nothing is committed and no `AGENTS.md` is written, so teammates who do not use Overseer see nothing. Tick "My team uses beads: commit its files" only for repositories that have adopted beads.
5. In Chat, pick the repository and describe what you want. The orchestrator creates a batch, creates beads in it and dispatches workers. Chat stays focused on questions, decisions, actionable failures and completed requests; the orchestrator searches and reads for itself first, uses a helper only when a search is too wide, and caps the helper's report at about 100 words because its full report reaches Chat. It does not post progress recaps between tool calls, while the one-line note before a call expected to take over a minute remains. Cards move across the Board: Ready, Blocked, Running, Verifying, Review, Done. Multiple open questions appear one at a time with Previous and Next controls and a Question N of M count, on a phone and on desktop, since several questions' answer boxes and buttons cannot all fit the card. The question card takes at most 40% of the visible screen, also with the keyboard open: a long question scrolls inside the card, keeps its line breaks, and the answer box, Answer and Dismiss stay in view. Typing `/` at the start or after whitespace opens repo and global command suggestions while the composer is focused; Escape closes suggestions first, and a second Escape closes an open details panel.
   The rail status block uses the mascot to show orchestrator activity, questions, connection state and context-driven energy; the count of needs-you items also appears on the browser tab's favicon and as `(n) Overseer` in the tab title. The Review tab badge counts only batches ready for the user, adds the waiting count to its tooltip and accessible name when nonzero, and stays hidden when nothing is ready; the favicon keeps the full item count. On a phone, meaning a window 767 px wide or less or a touch screen 500 px tall or less (a phone held in landscape), the rail becomes a bottom tab bar; a mouse or trackpad keeps the rail at every height from 768 px wide, and rotating or resizing across that line switches the layout without a reload. There Office is the first tab, and each tab's badge overlaps the top-right corner of its label.
   The needs-you strip sits above the Office room, capped at 3 item rows on a phone and 6 on a wider screen with a "+N more" row for the rest, and lists one open question instead of its named bead's decision or verification failure, because answering the question resolves that choice. Decision and failed bead rows open their TaskPane over the room; batch rows open their review drawer over Office, where Merge, Reject with a note, and Abandon are available without changing views; plan rows open the plan, and question rows open Chat with the answer box focused once; paging and auto-advance leave focus where it moved. A repository whose verify command is failing on the base branch opens Setup → Repositories, where **Re-probe** re-runs the check once it is fixed. The Plans row shows the draft count and opens the list of every plan.
6. When every bead of the batch has landed or been closed, the orchestrator calls `request_batch_review` and the batch appears in Review with the combined diff and a summary. Its Needs row opens those review details in a drawer over Office without changing views. Markdown tables in the summary and earlier rounds appear as scrollable tables on a phone. Read it in the drawer or Review, then Merge, Reject with a note, or Abandon.
