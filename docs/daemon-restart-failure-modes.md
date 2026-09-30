# Daemon restart failure modes

The daemon restart path (`POST /api/daemon/restart` → `relaunchDaemon` in `packages/daemon/src/util/daemon.ts`, the root `pnpm start` scripts, and the `daemon-restart.integration.test.ts` proof) was diagnosed from scratch several times between 2026-09-14 and 2026-09-17. This file records each root cause once, with the symptom that identifies it, the commit that fixed it and the test that would catch a regression. `docs/lessons.md` holds the incident entries that produced the prompt-only guards at the end.

## A daemon restart killed running workers and reopened their beads

**Symptom.** Harness processes were children of the daemon, so a restart (or a crash) took them down with it. Recovery reopened every running bead and recorded the close note `daemon restarted while the worker was running` (`RESTART_REASON`, `packages/daemon/src/lifecycle/lifecycle.ts`), discarding the work in flight and re-dispatching from scratch. The 2026-09-14 overseer-b8-nmcr entry in `docs/lessons.md` names the reopened bead and the re-dispatch as caused by the restart, fixed by the overseer-b9-lptx batch (merged `5bc9e37`).

**Fix.** `d64f993` feat(daemon): spawn line processes detached with stdio in a log file and adopt them by pid; `0995319` feat(daemon): harness adapters spawn into a log file and adopt a running process by pid; `bb4816b` feat(daemon): adopt workers that outlived the daemon instead of reopening their beads — a worker is spawned detached with its output in a log file, and on startup one whose pid is alive with the recorded start time is adopted and followed from its saved offset instead of having its bead reopened.

**Regression test.** `packages/daemon/src/lifecycle/lifecycle.test.ts` — `recover adopts a live worker process instead of reopening its bead`.

## A plain start could not take the port from a running daemon

**Symptom.** `pnpm start` died with `EADDRINUSE` when another Overseer daemon already listened on the port. Early on the daemon logged `overseer daemon cannot start: another daemon is already listening on port <port>; exiting` (commit `1f7aa4d`) and exited 1, so the only way to start was to stop the old daemon by hand.

**Fix.** `3b4245f` feat(daemon): take the port from a live daemon on plain start — `takeOverPort` identifies the holder through `GET /api/daemon`, stops that daemon process alone (`stopProcess`, no tree kill, so its workers survive and are adopted) and logs `overseer daemon <pid> is taking port <port> from the Overseer daemon <pid> and stopping that process only; its workers keep running and are adopted` (`packages/daemon/src/util/daemon.ts`).

**Regression test.** `packages/daemon/src/app.test.ts` — `stops only the Overseer daemon holding the port so its workers survive`; `packages/daemon/src/daemon-restart.integration.test.ts` — `takes the port from a live daemon, then restarts while a board websocket is connected`.

## Takeover stopped a daemon that served a different data dir

**Symptom.** A plain start from one install replaced the daemon of another install that happened to share the port. `GET /api/daemon` did not report its data dir, so the holder could not be told apart.

**Fix.** `0bbde57` fix(daemon): only take the port from a daemon of the same data dir — `GET /api/daemon` now reports `data_dir`, and a start refuses to stop a daemon that serves another data dir or reports none, logging `overseer daemon cannot start: port <port> is held by the Overseer daemon <pid> with data dir <a>, not <b>; another install is not stopped` (`packages/daemon/src/util/daemon.ts`).

**Regression test.** `packages/daemon/src/app.test.ts` — `refuses to stop an Overseer daemon of another data dir`.

## Takeover stopped a daemon from another checkout

**Symptom.** A worktree start replaced the long-running daemon of the main checkout when both shared a data dir, because only the data dir was compared.

**Fix.** `25f2ce8` fix(daemon): isolate port takeover by checkout — `GET /api/daemon` also reports `source_root`, and a start refuses to stop a daemon from another checkout, logging `overseer daemon cannot start: port <port> is held by the Overseer daemon <pid> from source root <a>, not <b>; another checkout is not stopped` (`packages/daemon/src/util/daemon.ts`).

**Regression test.** `packages/daemon/src/app.test.ts` — `refuses to stop a daemon from another checkout that shares its data dir`.

## A watch start took the port from the running daemon

**Symptom.** A `pnpm dev` file watcher in another worktree replaced the user's long-running daemon. The watcher has no reason ever to stop a holder, but it only rethrew the `EADDRINUSE`, so the failure was hard to read.

**Fix.** `1d65ccf` fix(daemon): keep watch starts from taking ports — a watcher (`OVERSEER_WATCH=1`) inspects the holder and exits 1 with `overseer daemon cannot start: port <port> is held by pid <pid> (<name>); watcher mode will not stop it` (`packages/daemon/src/util/daemon.ts`), leaving the daemon untouched.

**Regression test.** `packages/daemon/src/app.test.ts` — `a watch start names the daemon holding the port and never stops it`; `packages/daemon/src/daemon-restart.integration.test.ts` — `does not let a watch start take a port from a running daemon`.

## The successor bound before the parent released the port, and open websockets blocked the close

**Symptom.** The replacement could not bind while the old daemon still listened, and the old daemon's `app.close()` did not finish while board websockets were open (Fastify waits for upgraded connections), so the port was never released. The daemon logged `overseer daemon <pid> could not bind because the port is still in use; retrying in 500ms` (`packages/daemon/src/util/daemon.ts`).

**Fix.** `08293eb` fix(daemon): make restart handoff reliable — the successor waits for the parent to exit before it binds, `preClose` terminates open board sockets (`packages/daemon/src/api/ws.ts`), and a restart successor retries a busy port with no deadline.

**Regression test.** `packages/daemon/src/api/ws.test.ts` — `closes an open board socket during daemon shutdown`; `packages/daemon/src/app.test.ts` — `retries EADDRINUSE for a restart successor before listening successfully`.

## An open MCP stream outlived the server and held the shutdown

**Symptom.** `app.close()` did not finish while a `GET /mcp` streaming (SSE) request was open: Fastify does not track a hijacked reply as a live connection, so its default `forceCloseConnections: 'idle'` left that socket open until the ten-second bound. The restart integration probe took about 11.8 s with an MCP stream open against about 2.2 s with only a board websocket, and the parent logged `overseer daemon restart parent <pid> could not close cleanly; exiting so successor <pid> can start`.

**Fix.** `7808550` fix(daemon): close MCP streams and sockets before shutdown — `registerMcp` keeps every `StreamableHTTPServerTransport` and closes them in a `preClose` hook (`packages/daemon/src/mcp/server.ts`), and `buildApp` sets `forceCloseConnections: true` so Fastify drops active keep-alive connections as well as idle ones (`packages/daemon/src/app.ts`). A shutdown that still times out logs the live resource kinds and counts through `openHandleSummary` (`packages/daemon/src/util/daemon.ts`).

**Regression test.** `packages/daemon/src/shutdown.test.ts` — `names the open handles when the shutdown bound is reached`; `packages/daemon/src/daemon-restart.integration.test.ts` — `closes with a board websocket and an MCP stream open, well inside the restart bound`.

## A plain start retried a busy port instead of failing, and the parent's shutdown was unbounded

**Symptom.** The shared retry loop retried `EADDRINUSE` for every start, so a plain start hung beside a live daemon instead of taking over or failing; and `relaunchDaemon` awaited `app.close()` with no bound, so a hung shutdown left the successor waiting forever.

**Fix.** `1f7aa4d` fix(daemon): scope restart retries to successors — `listenWithRetry` retries only for a restart successor, a plain start surfaces `EADDRINUSE`, and the parent races `app.close()` against a 10-second bound, logging `overseer daemon restart parent <pid> could not close cleanly; exiting so successor <pid> can start` (`packages/daemon/src/util/daemon.ts`).

**Regression test.** `packages/daemon/src/app.test.ts` — `surfaces EADDRINUSE to the caller when retries are off`, `can bound plain-start retries before deciding whether to take over the port`, `bounds a hung Fastify shutdown and exits to release the successor`.

## The parent closed before the successor had loaded

**Symptom.** `spawn` only says Node created a process. The parent closed as soon as it spawned the successor, so the port could be handed to a process that had not loaded its entrypoint yet and then died — leaving nothing serving.

**Fix.** `30a11c2` fix(daemon): keep parent online until successor starts — the parent waits until the successor has reached its parent gate before it closes, and a successor that exits first leaves the parent serving.

**Regression test.** `packages/daemon/src/app.test.ts` — `starts one successor before closing and makes it wait for this process to exit`.

## An abandoned successor was left alive

**Symptom.** A successor that never reached the parent gate stayed detached and waited for the parent forever; whenever the parent eventually exited it would bind and race a later restart. The readiness gate was also only 10 seconds, too short for a cold `tsx` start, so healthy handoffs were abandoned. The failure string is `restart successor <pid> did not reach startup within 30 seconds` (`packages/daemon/src/util/daemon.ts`).

**Fix.** `f33d669` fix(daemon): stop abandoned restart successors and widen test bounds — the gate is 30 seconds and an abandoned successor is killed, logging `overseer daemon restart abandoned successor <pid>; this daemon keeps serving` (`packages/daemon/src/util/daemon.ts`).

**Regression test.** `packages/daemon/src/app.test.ts` — `keeps the parent online and stops the successor when it does not reach startup`.

## The readiness marker was missed after multibyte log output

**Symptom.** The parent looked for the successor's startup marker from a string (UTF-16) offset into `daemon-restart.log`. Once the log held a multibyte character, the offset landed past the marker and the parent saw `did not reach startup within 30 seconds` although the successor had written its line.

**Fix.** `25f2ce8` fix(daemon): isolate port takeover by checkout (read only appended bytes); `fb676ff` fix(daemon): preserve restart successor log offsets — the parent reads the file from a byte offset with `readSync`.

**Regression test.** `packages/daemon/src/app.test.ts` — `reads the successor marker from a byte offset after multibyte log output`.

## The successor's wait for its parent had no deadline

**Symptom.** `waitForRestartParent` polled a bare pid forever. On Windows a pid recycled after the parent exited looked alive, so the successor never bound and logged nothing. There was also no bound on a parent that never exits.

**Fix.** `fb1f4ad` fix(daemon): bound the restart successor's parent-pid wait — pass the parent's recorded start time and reuse `isAlive`, and give the wait a 60-second deadline, logging `overseer daemon restart parent pid <pid> was reused by another process; successor <pid> is starting` or `overseer daemon restart gave up waiting for parent <pid> after 60s; successor <pid> is starting anyway` (`packages/daemon/src/util/daemon.ts`); `ac60e96` fix(daemon): use wall-clock restart parent deadline makes the deadline wall-clock, because a slow identity check is not progress.

**Regression test.** `packages/daemon/src/app.test.ts` — `stops waiting and logs reuse when the parent pid is alive under a different process`, `gives up after the deadline and logs a timeout instead of waiting forever`, `uses a wall-clock deadline when parent identity checks are slow`.

## A failed parent close exited non-zero and took Vite down

**Symptom.** A parent whose close failed or timed out exited with a non-zero code. Under `pnpm -r --parallel start` that tore down the whole run, so `pnpm start` reported `packages/web start: Failed` (`packages/daemon/src/daemon-restart.integration.test.ts`) and there was no page or proxy even though the successor had taken over. Vite's `strictPort` re-raised the same class of failure for a second worktree by refusing to move off a taken port.

**Fix.** `81b9343` fix(daemon): exit restart parent with 0 and keep vite port flexible — the parent logs the close failure and exits 0 anyway, and Vite auto-increments its port again (`packages/web/vite.config.ts`).

**Regression test.** `packages/daemon/src/app.test.ts` — `exits the parent after a spawned successor even when Fastify shutdown rejects`; `packages/daemon/src/daemon-restart.integration.test.ts` — `keeps the root pnpm process and Vite server alive across a daemon restart`; `packages/web/src/vite-config.test.tsx` — `loads and keeps the daemon proxy, the open host and the env-driven allowed hosts` asserts `strictPort` is undefined (`1bf18ba` test(web): expect vite to keep auto-incrementing its port).

## Setup stopped polling before the handoff budget

**Symptom.** The web polled the successor for 30 one-second attempts, less than the 30-second gate plus the parent's shutdown and bind time, so a healthy restart was reported as a failure.

**Fix.** `fb676ff` fix(daemon): preserve restart successor log offsets — the UI poll was raised to 50 one-second reads to cover the successor gate, parent close bound and bind time.

**Regression test.** `packages/web/src/views/Setup.test.tsx` — `waits longer than the daemon handoff budget before reporting a restart failure` and `counts slow status reads against the wall-clock restart polling deadline`.

## A merged daemon fix was not live until the daemon was restarted

**Symptom.** Re-dispatched workers hung for over 30 minutes because the running non-watch daemon predated the merge. The lesson's signature: a codex session whose `.log` stays empty while `.log.err` shows only `Reading additional input from stdin...` (`docs/lessons.md`, 2026-09-15, overseer-b26-purt).

**Fix.** `620a031` feat(daemon): add self-restart status endpoints (the `restart_needed` field of `GET /api/daemon` and `POST /api/daemon/restart`); `92904b5` docs(orchestrator): check daemon restart before dispatch (orchestrator rule 23).

**Regression test.** **no regression test** — the guard is a prompt rule; `packages/daemon/src/app.test.ts` — `reports daemon startup facts and restart need from the current source head` covers only the `restart_needed` computation.

## Restarting by killing the daemon's process tree killed detached workers

**Symptom.** A restart that ran `taskkill /T` on the `pnpm start` process tree killed two detached workers with it; both beads reopened without commits, recorded as `reason "no_commits", note: "daemon restarted while the worker was running"` (`docs/lessons.md`, 2026-09-15, overseer-b29-poz7).

**Fix.** `ee436df` docs(prompts): record tests and safe daemon restarts and `058bd90` fix(prompts): clarify safe daemon restarts — orchestrator rule 23 says to restart through `POST /api/daemon/restart` (the Setup button) and never kill the daemon's process tree while workers run.

**Regression test.** **no regression test** — the prompt rule itself is not asserted. The daemon's own stop path is covered by `packages/daemon/src/daemon-restart.integration.test.ts` — `stops only the daemon process, so its detached workers keep running`.

## Changed dependencies left the successor unable to load

**Symptom.** A merged `yaml` dependency changed the checkout manifests and lockfile, but the long-running checkout had not installed it. The successor exited with `ERR_MODULE_NOT_FOUND` before startup, the current daemon kept serving, and Setup showed no failure reason or output.

**Fix.** `f516af17` fix(daemon): install dependencies before restart — the initial implementation hashed `pnpm-lock.yaml` and every checked-out `package.json` at startup, then ran `pnpm install --frozen-lockfile` with a five-minute bound before spawning a successor when the hash changed. The current hash covers the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `packages/*/package.json`. A startup read failure leaves an unknown hash, so the daemon starts and the next restart installs once its current inputs can be read; if current inputs still cannot be read during restart, the failure reason is returned and the current daemon stays online. Install and successor startup failures stay on `GET /api/daemon` with at most 20 output lines; Setup polls for six minutes to cover the install and handoff budgets, shows the reason and output, hides an older failure while a retry is in progress, and clears it after a later successful restart. The orchestrator receives one wake notice.

**Regression test.** `packages/daemon/src/util/daemon.test.ts` — an unknown startup hash is safe and forces the next install; an unreadable current input reports its path; changes to the root manifest, lockfile, workspace file or `packages/web/package.json` are detected; changes under `.claude/worktrees/` and `.ds-sync/` skip install; install failure prevents spawn; successor exit retains the last 20 lines. `packages/daemon/src/app.test.ts` — failed install records the status and sends one wake notice, a successful restart clears the failure, and a second request while restarting remains 409. `packages/web/src/views/Setup.test.tsx` — displays failure output, hides an old failure as soon as retry starts, and clears it after success.

## Causes with no regression test

- A merged daemon fix was not live until the daemon was restarted (prompt-only guard; `restart_needed` itself is tested).
- Restarting by killing the daemon's process tree killed detached workers (prompt-only guard; the daemon's own `stopProcess` path is tested).
