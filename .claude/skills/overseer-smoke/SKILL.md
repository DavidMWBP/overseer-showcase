---
name: overseer-smoke
description: Run the manual end-to-end smoke flow (PowerShell, with a POSIX variant): batch dispatch, verification failure and recovery, close, merge, review round, and crash recovery. Use when asked to smoke-test Overseer, verify its batch flow by hand, or check a release. Not for automated Playwright test authoring (use playwright-best-practices) or browser control (use playwright-cli).
---

# Overseer smoke

Prerequisites: `bd --version`, `claude --version` and `pnpm -r test` all succeed.

1. Create a disposable repo and isolated app state in one PowerShell session:
   ```powershell
   $demo = Join-Path $env:TEMP ("ov-demo-" + [guid]::NewGuid().ToString('N'))
   $dataDir = Join-Path $env:TEMP ("ov-smoke-data-" + [guid]::NewGuid().ToString('N'))
   $ports = @(53840, 53841)
   if ($dataDir -eq (Join-Path $HOME '.overseer') -or $ports -contains 4400 -or $ports -contains 5173) { throw 'Use a temp data directory and non-default ports.' }
   if (Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue) { throw 'Choose two free ports, not 4400 or 5173, and update $ports.' }
   New-Item -ItemType Directory -Path $demo
   git -C $demo init -b main
   [System.IO.File]::WriteAllText((Join-Path $demo 'README.md'), "# demo`n", [System.Text.UTF8Encoding]::new($false))
   git -C $demo add .
   git -C $demo commit -m "chore: initialize demo"
   $env:OVERSEER_DATA_DIR = $dataDir
   $env:OVERSEER_PORT = [string]$ports[0]
   $env:OVERSEER_WEB_PORT = [string]$ports[1]
   ```
2. Run `pnpm dev` in this worktree and shell. Open `http://localhost:$($ports[1])` to reach Setup.
3. Setup → Add repository → Browse to `$demo` → Select this folder. Set Id to `ov-demo`, leave the beads checkbox unchecked, and set verify command to `node -e "process.exit(require('fs').existsSync('nope.txt')?0:1)"`. Verify commands run through `cmd.exe` (`spawn(..., { shell: true })`), so PowerShell-only syntax such as `Test-Path` does not work. Expect “Added ov-demo and initialised beads in it,” the repo in the rail, six empty columns, `!! .beads/` from `git -C $demo status --porcelain --ignored`, and one commit.
4. Chat → pick `ov-demo` → send: *“Create one batch with two tasks: one adds `hello.txt` containing `hi`, the other adds `bye.txt` containing `bye`. Dispatch only the hello task to a claude worker and leave the other undispatched.”* Create both beads up front. The batch enters review once all beads land or close; review batches take no new beads. Expect batch 0/2, hello Ready → Running → Verifying, and bye still Ready.
5. Verification fails: hello returns to Ready with a red rule and “verify failed” chip at the top. Its pane shows `exit 1`, Retry verification, Re-dispatch, and Close bead; Chat names the command and branch.
6. Setup → Edit `ov-demo` → set verify to `node -e "process.exit(require('fs').existsSync('hello.txt')?0:1)"` → Save. The notice confirms the next verification uses it. Board → open hello → Retry verification. Expect immediate acknowledgement, Verifying → Done, batch 1/2, and `git -C $demo log --oneline --all -5` showing `chore(…): merge <bead id>` on the batch branch.
7. Open bye in Ready and choose Close bead with a note. Expect Done with a “closed” chip, “1 landed, 1 closed of 2,” and a Chat notice. The orchestrator then calls `request_batch_review` because done plus closed equals total.
8. Review → In review: expect header `pass (1 landed, 1 closed of 2 beads)`, summary, bead list and combined diff with `+hi`. Click Merge and confirm. On `main`, `git -C $demo log --oneline -1` shows the merge commit, `hello.txt` exists, `git -C $demo branch --list 'feature/*'` is empty, and the batch is under Finished with its merge commit and no actions.
9. Setup → Edit `ov-demo` → set Review rounds to `1` → Save. Chat → send: *“Add `three.txt` containing `three`, dispatched to a claude worker, in its own batch.”* Expect Ready → Running → Verifying → Reviewing, with a critic on a different model. If it passes, the card lands and the batch reaches review as in step 8. If it finds issues, round 1 is the limit: expect Awaiting decision, findings, a `[Overseer] three.txt awaits a decision ...` notice, and Land anyway. Either ask the orchestrator to re-dispatch with instructions addressing the findings, or accept review and confirm it lands with an “open findings” note.
10. Ask for one more file and wait for Running. Get the daemon PID from Setup → Daemon's “Running since … (pid N)” line. Kill only the daemon (`taskkill /PID <daemon pid> /F`, no `/T`, so the worker survives), then run `pnpm dev` again in the same shell. Expect the card still Running and `adopted worker <session> for <bead>` in `daemon.log`; it verifies and lands when the worker turn ends. If `/T` kills the worker too, it returns Ready with a “daemon restarted while the worker was running” note. The browser shows the outage banner and refetches when the daemon returns, without a reload.

Cleanup, after the smoke run: `Remove-Item -LiteralPath $demo, $dataDir -Recurse -Force`, then `Remove-Item Env:OVERSEER_DATA_DIR, Env:OVERSEER_PORT, Env:OVERSEER_WEB_PORT`. These variables and paths were created for this run; do not substitute the live data directory.

On POSIX, use a fresh `/tmp/ov-demo` path, a `mktemp -d` data directory, and two checked free ports set as `OVERSEER_DATA_DIR`, `OVERSEER_PORT` and `OVERSEER_WEB_PORT` before `pnpm dev`. Use `test -f hello.txt` and `test -f nope.txt` for the verify commands, `kill -9 <daemon pid>` in step 10, and remove only the two temp paths created for the run.
