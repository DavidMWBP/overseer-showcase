# Lessons

Rules in the orchestrator and worker prompts (`packages/daemon/prompts/`) that were added because a run went wrong. One entry per rule, with the incident that caused it, so a later prompt edit can see why the sentence is there before changing it. Batch retrospectives append entries here too, and they arrive as `Lessons from` batches that are reviewed like any other batch.

## 2026-09-22 — acme-portal-sample-009 (incomplete verification closed as verified)

Source: verification-only sessions ended on blocked ports or status-only messages such as "I'll wait for its reply" and "running in the background", without completed check results, but were closed as verified because any non-empty final message satisfied the lifecycle rule.

- **A verification-only result closes only when it contains at least one `Check: <command> - PASS - <summary>` line and no non-PASS or malformed `Check:` line.** Missing checks, FAIL, NOT RUN and BLOCKED results reopen as `verify_incomplete`, quoting the missing or offending lines so the orchestrator re-dispatches with explicit instructions. Applies to: daemon session-end rule, orchestrator prompt rule 17, worker results block.

## 2026-09-14 — acme-portal #9310 run

Orchestrator prompt, "How to work" items 13–18; worker prompt, "Rules" bullets 3–5.

- **Evidence never goes into the user's repository** (orchestrator 13, worker bullet 3). A worker committed screenshots and probe output to the feature branch because the bead asked for evidence without saying where it should go. Evidence belongs in the MR description or the review note; descriptions that ask for evidence must say so and forbid committing it.
- **Announce long-running tool calls** (orchestrator 14). The chat went silent for the length of a test suite and the user could not tell whether the orchestrator was working or stuck. One line before, one line after.
- **Read every bead's final notes before requesting review** (orchestrator 15). The review note claimed the Definition of Done checks had passed although no bead note recorded a result. Missing results are re-run or asked for, and the note says who ran what.
- **Re-dispatch with staged commits after a worker ends mid-command** (orchestrator 16, worker bullet 4). A worker started a long test run, ended its session without committing, and the bead reopened with no commits. The re-dispatch instructions now say to commit in stages and run long commands in the foreground with a bounded timeout.
- **Verification-only beads write results in a fixed shape** (orchestrator 17, worker bullet 5). A verification bead's notes described the checks in prose and the orchestrator could not quote a per-check pass/fail. Per check: command, pass or fail, paths.
- **Artefact conventions must name what not to commit** (orchestrator 18). Helper files (`.playwright-cli/`, `.tmp-*.py`, `dist/`) ended up in the branch because the description introduced an evidence folder without saying the helpers were throwaway.

## 2026-09-14 — overseer-b8-nmcr retrospective

Source: batch overseer-b8-nmcr (session end_reason, landing rule), rejected on 2026-09-14 after batch overseer-b9-lptx (detached workers) was merged first. Both edited `manager.ts`, `lifecycle.ts`, `db.ts`, `schema.ts`, `shared/index.ts` and the batches spec; the orchestrator requested review on both and told the user to merge them together. The rejection note, quoted verbatim:

> Last merge into main conflicted in: docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md, packages/daemon/src/db/db.ts, packages/daemon/src/db/schema.ts, packages/daemon/src/lifecycle/lifecycle.ts, packages/daemon/src/sessions/manager.ts, packages/shared/src/index.ts. Reject with a note and the orchestrator adds a bead that rebases the branch.

- **Check open batches of the same repo for overlapping files before requesting review** (orchestrator 19). Compare the batch's `git diff --stat <base>...<batch branch>` with every other open or in-review batch of the repo. On overlap, say so in the review note and in chat, name which batch to merge first, and expect the second to need a conflict bead; when the overlap is large, merge the base branch into the second batch's branch via a bead before requesting its review, or fold the work into one batch from the start. Never tell the user to merge overlapping batches "together". Applies to: orchestrator prompt.

Observation, not a rule: the retrospective's keyword matcher flagged a chat message containing "instead" as a correction although it was a question. The other two signals (a reopen and a re-dispatch) were caused by the daemon restarting, which overseer-b9-lptx fixes. Left for a later tuning pass of the matcher.

## 2026-09-14 — acme-portal-sample-019 retrospective

Source: batch acme-portal-sample-019 (#9318), rejected on 2026-09-14. The batch was created at 11:22 UTC and review requested at 11:30 UTC; `origin/dev` had received six commits between 10:42 and 11:13 UTC (a docs merge and release 0.1.13). The batch branch was cut from the local `dev` checkout, which had not been fetched, so the MR opened already conflicting in `e2e/TEMPORARY-WORKAROUNDS.md` and `src/plugins/i18n.ts`, the user rejected the batch and a conflict bead followed. The rejection note, quoted verbatim:

> Merge conflicts must be resolved.

- **Check the batch branch against the freshly fetched remote base before requesting review** (orchestrator 20). Rule 19 covers overlap between two Overseer batches; this case is the base branch itself moving on the remote. In a `gitlab-mr` repo, `git fetch origin <base>` and check the batch branch merges cleanly into `origin/<base>` (`git merge-tree` against the merge-base). If it does not, add a bead to the same batch that merges `origin/<base>` into the batch branch and resolves the conflicts, and request review only after it lands. Applies to: orchestrator prompt.

## 2026-09-14 — acme-portal-sample-028 and acme-portal-sample-033 retrospective

Source: two sample feature requests were rejected after the required integration check could not reach a test service. The worker reported the environment blocker, but review was requested anyway. Network access was restored and the orchestrator added a verification step to each request. Asking first would have avoided one review cycle per request. The rejection note, paraphrased:

> Rerun the integration checks and confirm they pass. Network access is available.

- **A check blocked by the environment is a blocker to resolve before review, not a Known limit to report** (orchestrator 15, worker results block). When a bead's Definition of Done includes a check the worker could not run for an environment reason (403 without VPN, missing credentials, a service down), the orchestrator does not request batch review. It tells the user in one line what is blocked and what it needs ("E2E needs the VPN up; say when it is and I'll run them") and requests review only after a verification bead has recorded the check as passed. A check that was not run is never listed under Known limits. The worker reports such a check in its fixed results shape with the exact error, so the orchestrator can act, and does not describe it as a limitation of the work. Applies to: orchestrator prompt (rule 15), worker prompt (results block).

## 2026-09-14 — acme-portal-sample-002 and acme-portal-sample-007 (background commands)

Source: two claude workers in repo acme-portal on 2026-09-14. Both started a long run with Bash `run_in_background`, then yielded their turn to wait for it; with `claude -p` the headless process exits on yield, so the job's completion never reached the model. Both sessions ended with `end_reason` null and `verify_status` pass, Overseer landed the commits, and the results were never reported: the orchestrator had to add a verification bead each time. The last assistant text of each, quoted verbatim:

> Waiting on the evidence agent now.

> Waiting on the full-suite completion notification. Nothing else to run concurrently without contending with the suite for CPU.

- **Background commands are blocked for workers** (worker bullet 4, daemon). The prompt rule to run long commands in the foreground with a bounded timeout was ignored twice, so the daemon now enforces it: a claude worker is started with `--settings` pointing at a PreToolUse hook (`packages/daemon/hooks/deny-background.cjs`) that rejects a Bash call with `run_in_background: true` (exit 2, the reason fed back to the model). The worker prompt says so and points at the `timeout` parameter (up to 600000 ms) and splitting longer runs. Verified with a real `claude -p` run under `--dangerously-skip-permissions`: the background call was rejected and the model re-ran the command in the foreground. Applies to: worker prompt + daemon.

## 2026-09-14 — acme-portal-sample-036 (verification-only bead reopened without commits)

Source: batch acme-portal-sample-036 (dev pipeline hotfix), bead acme-portal-sample-049, a verification-only bead (run typecheck, lint, vitest; commit nothing) created under orchestrator rule 17. The worker finished with a complete results table and the session-end rule reopened it, since the branch had no commits; the notice, quoted verbatim:

> acme-portal-sample-049 reopened: worker ended without commits: All five verification steps pass on `bead/acme-portal-sample-049` ...

`request_batch_review` then refused the batch, quoted verbatim:

> batch acme-portal-sample-036 still open: acme-portal-sample-049 not done

The only way out was asking the user to press Close bead on the Board, which delayed a priority hotfix: rule 17 asks for beads whose correct outcome the session-end rule treated as a failure.

- **A verification-only worker that ends without commits but with a final message closes its bead as verified** (daemon, `spawn_worker` `verify_only`). `spawn_worker` takes `verify_only: true`; when such a worker ends with no new commits and a final message, the daemon records the message as the bead's note, closes the bead with reason "verification recorded, no commits" and phase `verified` (label `overseer:verified`), and counts it in `beads_closed`, so the batch can go to review. A worker that ends with no final text, or one the daemon lost, still reopens. Applies to: daemon session-end rule, `spawn_worker` tool schema, orchestrator prompt (rule 17: dispatch verification-only beads with `verify_only: true`).
## 2026-09-14 — acme-portal-sample-036 retrospective

Source: batch acme-portal-sample-036, merged on 2026-09-14. The batch ended with a verification-only bead, acme-portal-sample-049, whose worker ran every check and recorded the results in the fixed shape, committed nothing (there was nothing to commit) and was therefore reopened as `no_commits`; six minutes later the user closed it as won't do (note: null) so the batch could finish, which mislabels a fully successful bead in the batch counts. The signals, quoted verbatim from `batch_retrospective`:

> Reopen of acme-portal-sample-049, reason no_commits, worker note: "All five verification steps pass on `bead/acme-portal-sample-049` (head 5d374ca4, which carries the f013b9f2 import fix). No code changes were made, nothing to commit, and the worktree is clean." ... "| `npm run test` | PASS | 606 files passed, 15309 passed / 21 skipped / 5 todo, 731.5s, exit 0 |" ... "Nothing could not be run."

> Closed as won't do by the user: acme-portal-sample-049 (note: null), six minutes after the reopen.

- **Verification-only beads are dispatched with `verify_only`, so a commit-less end is recorded as completion; one dispatched without it that comes back `no_commits` with every check passed is finished with Close bead** (orchestrator 17, worker results block). Overseer only lands beads that commit, so without the flag the orchestrator had no landing path. The `verify_only` flag of `spawn_worker` (see the entry above) makes the daemon record the worker's final text as the bead note and close the bead as verified. When a verification bead was dispatched without it and the reopen note carries per-check results in the fixed shape with every check passed, the orchestrator treats the reopen as the bead's completion: it quotes the results in the review note and tells the user to press Close bead on its card, and never re-dispatches it or asks for a no-op commit (rule 4 already forbids that). If any check failed, the reopen is a real failure and is handled as such. Prefer folding verification into the last code bead of a batch so no commit-less bead exists at all. The worker states explicitly in its final message that no commit is expected. Applies to: orchestrator prompt (rule 17, cross-referencing rule 4), worker prompt (results block).

## 2026-09-26 — overseer-mirq and overseer-b175-gvij

Source: batch overseer-mirq (from overseer-b182-erj5 retrospective, 2026-09-26). Two dispatches on chore tier failed, and the standard one passed: "[must] The evidence doesn't meet the DoD. The only capture is `pixi-office-empty.png`, an empty room." and "[must] The evidence still fails the DoD. The capture night-1280x800-working-agents.png shows every worker desk empty; only the orchestrator and ov-3 stand in the top-right corner. It also crops out the review room's far corner, so the lamp at (19.2, 12.2) cannot be seen. The final message says 'multiple working agents seated at desks' and 'lamp visible in review room', and the image shows neither."

- **A bead whose Definition of Done includes live evidence of a driven or seeded scene is dispatched at `standard` or above, never `chore`, even when its code change is small.** The evidence tier matters more than the code complexity; a small fix with high evidence needs the reasoning to produce what lives on screen. Applies to: orchestrator prompt rule 3.

Source: batch overseer-b175-gvij (pre-review run, 2026-09-26). The batch's own beads added `pixi.js` to `packages/web/package.json` and `pnpm-lock.yaml` after the batch worktree's setup ran; the pre-review full-suite run then failed with `Error: Failed to resolve import "pixi.js" from "src/office/pixi/characters.ts"` and "error TS2307: Cannot find module 'pixi.js'". `pnpm install --frozen-lockfile` in the batch worktree fixed it.

- **Before the pre-review full-suite run, re-run the setup command in the batch worktree when the base or batch beads changed `package.json` or a lockfile.** A batch worktree's setup runs once at creation; batch beads that land after may change dependencies, leaving imports unresolved. Applies to: orchestrator prompt rule 15.

## 2026-09-14 — overseer-b15-vizv retrospective

Source: batch overseer-b15-vizv "Worker sessions end silently when the worker yields while a background command is still running", merged on 2026-09-14. The orchestrator created two independent beads in one batch and dispatched them in parallel although both, by their descriptions, edited `docs/lessons.md` and `packages/daemon/src/lifecycle/lifecycle.ts`. The second to land conflicted, which cost a re-dispatch and a full re-run of the tests. The signals, quoted verbatim from `batch_retrospective`:

> Reopen of overseer-2q8, reason merge_conflict, note: "docs/lessons.md, packages/daemon/src/lifecycle/lifecycle.ts".

> Re-dispatch of overseer-2q8 with instructions: "Your previous commits conflicted with the batch branch (which now carries overseer-djq: background Bash blocked for claude workers, its lessons entry and worker.md sentence) in docs/lessons.md and packages/daemon/src/lifecycle/lifecycle.ts. Rebase or merge the batch branch into your bead branch and resolve both files keeping BOTH changes: in lessons.md keep djq's entry and append yours after it; in lifecycle.ts keep djq's spawning changes and your session-end verify-only path. Re-run the lifecycle tests, prompt tests and pnpm typecheck after resolving and record the results. Commit the resolution before running the tests."

- **Beads of one batch that touch the same file are chained with `blocked-by`, not dispatched in parallel** (orchestrator 2). When two beads of the same batch will touch the same file (an append-only log such as `docs/lessons.md`, a shared module, a prompt file), make the second depend on the first with `blocked-by:` so it branches from a batch branch that already carries the first's commits, instead of dispatching both at once. Parallel dispatch is only for beads whose file sets are disjoint. Applies to: orchestrator prompt (rule 2).

## 2026-09-14 — acme-portal-sample-034 retrospective

Source: batch acme-portal-sample-034 (#9312, MR 8403), rejected on 2026-09-14. The signal, quoted verbatim from `batch_retrospective`:

> Rejected by the user: "Unit tests are failing in the pipeline"

Pipeline 149703 on the MR had six `test-frontend` shards; four passed and two (1/6 and 5/6) failed with `failure_reason` `runner_system_failure` ("Job failed (system failure): creating docker connection ... EC2 Instance Connect is not supported on a terminated instance" and "instance no longer running"). No unit test failed. The right response was to retry the two jobs, which the orchestrator did; a worker dispatched to "fix the failing unit tests" would have found nothing and burned a review round.

- **A rejection or user message that cites a failing pipeline is diagnosed from the jobs, never from the note alone** (orchestrator 6). Fetch the pipeline's jobs (`glab api projects/<id>/pipelines/<pipeline>/jobs`) and read each failed job's `failure_reason` and trace tail. `runner_system_failure`, or an empty trace with runner `ERROR` lines, means infrastructure: retry the jobs (`glab api -X POST projects/<id>/jobs/<job>/retry`), wait for the result, and re-request review with the pipeline link. Only `script_failure` with named failing tests justifies a fix bead, and that bead's description must quote the failing test names and the assertion from the trace. Applies to: orchestrator rule 6.

## 2026-09-14 — overseer-b20-ic4p retrospective

Source: batch overseer-b20-ic4p on the overseer repo (merge mode `local-merge`), rejected on 2026-09-14. While the batch was open the user committed four changes directly on `main` (d921a53, 57780c2, caa467e, 4526447) touching the same files as the batch. Rule 20 only told the orchestrator to run the merge-tree check in `gitlab-mr` repos, so it requested review without checking, and the merge failed at the Merge button. The rejection note, quoted verbatim:

> Last merge into main conflicted in: CLAUDE.md, README.md, docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md, packages/web/src/components/PushSettings.tsx. Reject with a note and the orchestrator adds a bead that rebases the branch.

- **The pre-review merge check runs in every repo, against whichever base can move** (orchestrator 20). The check is about the base branch moving, whatever the merge mode: in `gitlab-mr` repos after `git fetch origin <base>`, against `origin/<base>`; in `local-merge` repos against the local base branch, which the user may have committed to directly. If the batch branch does not merge cleanly, add the merge-from-base bead to the batch first and request review only after it lands. Applies to: orchestrator rule 20.

In the same batch, overseer-lnm was re-dispatched twice. The first re-dispatch, by the daemon's review loop, went to codex with instructions beginning "The review of the previous attempt (already committed on this branch) found these issues. Fix them so the next review passes:" and ended with no new commits; review round 2 reported, quoted verbatim:

> HEAD is still 5b432e5 (the same commit the previous review looked at), the working tree is clean and there are no new commits on the branch

The second re-dispatch, by the orchestrator, went to claude with the same two findings spelled out as numbered steps and landed in one round.

- **A review-round re-dispatch that ends without new commits is re-dispatched to claude at once** (orchestrator 4). Do not wait for the next round to repeat the same findings: re-dispatch to `claude` immediately with the findings as numbered, file-and-line steps and an explicit "confirm the branch has new commits on top of <sha>" line. Applies to: orchestrator rule 4, the sentence about re-dispatching reopened beads with instructions.

## 2026-09-15 — overseer-b24-xlct retrospective

Source: batch overseer-b24-xlct ("Codex adapter: replace the removed --full-auto flag and surface harness startup errors in the reopen note"), merged on 2026-09-15. The batch had four re-dispatches. The first two were codex workers crashing at startup on the removed `--full-auto` flag; the batch itself fixed that issue. The third was an orchestrator re-dispatch to claude after a review-round re-dispatch committed nothing, already covered by the overseer-b20-ic4p entry. The fourth signal is new. The review of the codex adapter bead found that the worker's live proof did not exercise the path the task named. The review-round re-dispatch instructions, quoted verbatim:

> [must] packages/daemon/src/harness/codex.ts: `-c sandbox_mode=workspace-write` does not allow a git commit in an Overseer worktree. Every bead and batch worktree is a `git worktree add` checkout (git/git.ts), so its git dir lives under the main checkout's `.git/worktrees/<name>`, outside the sandbox's writable root. Verified live with codex-cli 0.154.0 on Windows in a temp repo plus worktree: `codex exec --json -c sandbox_mode=workspace-write -c approval_policy=never --cd <wt>` asked to `git add` and commit answers `fatal: Unable to create '<main>/.git/worktrees/wt/index.lock': Permission denied` (command exit 1); adding the common git dir via `-c 'sandbox_workspace_write.writable_roots=[\"<main>/.git\"]'` still fails the same way; `-c sandbox_mode=danger-full-access -c approval_policy=never` commits successfully. The task's first requirement was writes in the worktree including `git commit`, and the worker prompt requires commits, so with this change a codex worker runs but can never deliver. Pick a sandbox setting that lets the worker commit in a worktree (danger-full-access is the only one I found that works; if you choose it, say so in the code comment since the task asked not to bypass the sandbox without a reason), and add the worktree commit to the live proof: the probe in a plain temp dir did not exercise this path.

> [should] The final message says network behaviour is unchanged and the live proof covers writes, but the proof only wrote a file in a non-git temp dir. When you redo the proof, run it in a `git worktree add` checkout and include the commit output in the notes, so the reviewer can see the exact flags that make a headless codex worker able to commit.

- **A live proof of a harness, sandbox or tooling change runs in the shape Overseer uses for real, a `git worktree add` checkout of a repo with a commit, and exercises every requirement the task names (here: writing a file AND git commit), with the exact command, exit code and output pasted into the final message. A proof in a simplified stand-in (a plain temp dir, no git, no commit) does not count and costs a review round.** Applies to: worker prompt.

## 2026-09-15 — /insights report over 2026-09-09 to 2026-09-14

Orchestrator prompt, "How to work" items 21–22. Source: the Claude Code usage report, not a single batch; the signals recur across the smoke-script runs of that week.

- **Never invent unspecified content; ask one question first** (orchestrator 21). Workers and the orchestrator filled gaps in terse task descriptions with made-up file contents ("zeta", "omega") at least three times, and two batches were rejected because a required line only surfaced at review. The rule moves the question to before the dispatch, where it costs one turn instead of a review cycle.
- **Identical verify failures across beads point at the gate, not the work** (orchestrator 22). Throughout the week the smoke script's deliberately broken verify command (`node -e "process.exit(1)"`) reopened beads two and three times (overseer-copy-an7 three times) before the setting was fixed. The orchestrator diagnosed it each time, but only after the re-dispatches had run. The rule stops the re-dispatch at the second identical failure and names the Setup field to check.

## 2026-09-15 — acme-portal-sample-037 (evidence lost with the bead worktree)

Source: a mobile admin record-list request (sample work item #9263) was abandoned after two verification-only tasks proved the cause was in the backend, so no code change or merge request was needed. The task said: "Keep helper and evidence files out of commits; store evidence outside the worktree and report where it is." The verification note listed screenshots, request samples and a manifest. The batch worktree remained after the bead worktree was removed, so the files were gone when the reviewer tried to attach them. The final note was the only copy of the API responses.

- **Evidence produced by a verification-only bead is lost when the bead worktree is removed at session end, so it must be put somewhere that survives before the worker ends** (orchestrator 13/17, worker results block). "Not committed and left in the worktree" is never a valid location for evidence the orchestrator will need after the worker ends. A bead description that asks a verification-only worker to capture evidence for the user (screenshots, probe JSON, manifest) must tell the worker to upload each file to the repo's GitLab project uploads API (`curl --form file=@<path> -H 'PRIVATE-TOKEN: ...' https://<host>/api/v4/projects/<id>/uploads`, token from `glab config get token --host <host>`) and put the returned markdown links in its final message, or, when the repo has no GitLab project, to copy the files to a named path outside the worktree and report that path. The orchestrator quotes those links in the review note or the work-item comment. Applies to: orchestrator prompt (rules 13 and 17), worker prompt (results block).

## 2026-09-15 — overseer-b27-5pze retrospective

Source: batch overseer-b27-5pze "Codex adapter: close stdin after spawn so codex exec starts the turn instead of blocking on \"Reading additional input from stdin...\"", merged into main on 2026-09-15 (0569bd2). The orchestrator dispatched a bead with a tier only, as the prompt says to do; Overseer picked codex for it, and the codex worker hung on the exact adapter bug this bead was created to fix. The bead had to be stopped and re-dispatched to claude. The same shape occurred one batch earlier: overseer-b24-xlct (removed --full-auto flag) had two codex workers crash at startup on the bug that batch fixed. Two batches in a row make this a rule, not a one-off.

> bead overseer-f61, reason "stopped", note: "stopped by the orchestrator: dispatched to codex, which hangs on the very stdin bug this bead fixes; re-dispatching to claude"

- **When a bead's work is a fix to a harness adapter, or the bead's notes record that harness failing before it did any work (a startup crash, a hang before the first API call), the orchestrator passes `harness` for a different CLI (normally `claude`) at dispatch time, even though the user did not ask for one. This is the one exception to "only when the user asks".** Applies to: orchestrator prompt (`spawn_worker` tool bullet, rule 3 of "How to work").

## 2026-09-15 — overseer-b26-purt retrospective

Source: batch overseer-b26-purt ("Board detail pane: slide-out overlay panel on desktop instead of stacking under the board"), merged on 2026-09-15 (209b825). The daemon fix from overseer-b27-5pze had merged into main, but the non-watch `pnpm start` daemon had started before that merge and still ran the old adapter, so four re-dispatched workers hung for over 30 minutes until the user restarted the daemon by hand. A codex session whose `.log` stays empty while `.log.err` shows only "Reading additional input from stdin..." is the hang signature.

> bead overseer-nzk, reason "stopped", note: "stopped by the orchestrator: codex exec hung on \"Reading additional input from stdin...\" for 35 min with no output on the review-round re-dispatch: the running daemon (started 02:29 without watch) predates the stdin fix merged at 08:45; no API call was made"

- **A daemon change merged into main is not live until the daemon is restarted; after an overseer batch that touches `packages/daemon` merges, check that the daemon process started after the merge before dispatching or re-dispatching work that depends on the fix. If it did not, tell the user that a manual restart is needed, which ends the orchestrator session and running workers, and wait.** Applies to: orchestrator prompt.

## 2026-09-15 — overseer-b31-4s5r retrospective (and overseer-o8j)

Source: batch overseer-b31-4s5r "Setup: Restart daemon button with a restart needed indicator", merged 2026-09-15 (d35044a). The batch's one signal was the review-round re-dispatch of overseer-9mf, which found that the web header badge overflows on phones (390 px) because it cannot truncate and the screenshot requirement was skipped. The same shape recurred twice more on the same day in batch overseer-b29-poz7 (bead overseer-o8j, both codex attempts): the review reported "Task item 7's manual browser proof is still missing", and the worker's log shows why — it loaded the codex-bundled `control-in-app-browser` skill, found no browser instance, and stopped, although `playwright-cli` is on PATH and Chromium headless is installed. Each skipped proof cost a review round and hid a real bug (badge overflow at 390 px; rejection thumbnails never rendered in the chat thread).

> [should] packages/web/src/styles.css: On phones the header badge cannot truncate and overflows the one-line status row. [...] Add `flex: 1 1 auto` (or `flex-shrink: 1`) to the badge rule, and capture the 390 px screenshot requirement 5 asks for — it was skipped, which is why this was not caught.

- **When a task asks for a browser or screenshot proof, use `playwright-cli` (on PATH) or `npx playwright` with a throwaway script outside the worktree; never an IDE or in-app browser skill, and never skip the proof because such a skill finds no browser. A proof you could not run is a FAIL line in the results block naming what was missing.** Applies to: worker prompt.

## 2026-09-15 — overseer-b29-poz7 retrospective

Source: batch overseer-b29-poz7 "Chat: attach images to a message ...", merged 2026-09-15 (0fa10ac): 5 beads, 2 reopens, 9 re-dispatches. The missing-tests signal recurred the same day in overseer-b33-e4d5: bead overseer-wcw's first review said "Contract item 6 asked for five test additions; only src/accounts/env.test.ts exists", making this a rule rather than a one-off. The restart came from a detached script that ran `taskkill /T` on the `pnpm start` process tree; two detached workers died with it and both beads reopened without commits. Two new signals were identified; the other signals were already covered by existing entries or were not lessons.

> [must] No tests were added. `git diff --stat` against the base shows only 6 files changed, none of them a test: app.test.ts, the lifecycle tests and Review.test.tsx are untouched. Task items 3 and 6 require daemon tests (reject with an attachment stores the file and the chat row carries it, the delivered text ends with the `[attached image: ...]` line, reject without attachments unchanged, a bad attachment gives 400 and does not reject) and web tests (a selected file shows a thumbnail, Reject posts base64 attachments, a refused file shows the hint).

> reason "no_commits", note: "daemon restarted while the worker was running"

- **Tests the task names are part of the deliverable, not optional; before the final message the worker runs `git diff --stat <base>...HEAD` and confirms every test file the task names is in it, adding what is missing before reporting.** Applies to: worker prompt.
- **An Overseer restart goes through `POST /api/daemon/restart` (the Setup button), which re-executes only the daemon and leaves workers to be re-adopted; the orchestrator never kills the daemon's process tree, and if a restart is unavoidable by other means it waits until no worker runs.** Applies to: orchestrator prompt, rule 23.

## 2026-09-15 — acme-portal-sample-032 retrospective

Source: a shared-search update (#9315) was merged on 2026-09-15 (MR 8406) after one rejection and eight re-dispatches over 1407 minutes. The same search control appeared on several screens, but the evidence showed them one at a time. A layout difference surfaced only after the user compared them. A later review also had to recapture valid Playwright evidence because the worker used a temporary test spec instead of the named CLI.

> Why do the two admin lists look different when they show the same kind of data? One puts the result count beside its title, and the other has filters. Make them use the same layout and filters while keeping the first list at its current height.

> [must] The mandatory evidence was not captured with the required playwright-cli; the final report says it was generated by a temporary npx playwright test spec. Re-capture the three required screenshots via playwright-cli (or npx playwright cli) and upload and report the replacement links.

- **When a batch changes a shared component or pattern, the evidence bead captures every screen using it side by side at the same width and the review note names any difference between those screens as a finding or an explicit out-of-scope item, so the user sees divergence before rejecting.** Applies to: orchestrator prompt (evidence rules 13/17).
- **A browser proof made with any Playwright entry point (playwright-cli, `npx playwright test` with a throwaway spec, or a Playwright script) satisfies a task that asks for playwright-cli; the reviewer judges what the capture shows, not the command that produced it.** Applies to: critic prompt (and the worker prompt's browser-proof bullet, which already accepts `npx playwright`).

## 2026-09-15 — overseer-b39-wi7c retrospective

Source: batch overseer-b39-wi7c retrospective, from the review-round re-dispatch of bead overseer-3y3. The signal was:

> [must] The required manual proof is missing: the PNGs at C:\Workspace\dev\.overseer\evidence\mascot\chat-390.png and chat-1400.png were captured from localhost:5173, which serves the main checkout, so they show the old UI (rail dot + "orchestrator: idle", no mascot, no activity line) and prove nothing about this branch. Nothing about requirement 2 (mascot at 32/40 px, label beside it, fixed-height line at both widths) is verified. Start this worktree's own web server on a free port against the running daemon, e.g. `pnpm --filter @overseer/web dev -- --port 5180`, capture the chat header area at 390 px and 1400 px, and overwrite those two files.

- **A browser or screenshot proof is captured from a server started in the worker's own worktree on a free port (the main checkout's dev server on its default port serves other code); before capturing, the worker confirms the page shows this branch's change (a new element, label or text the task introduced), and a capture that shows the old UI is a FAIL line, not evidence.** Applies to: worker prompt (the browser-proof bullet) and orchestrator prompt (evidence rule 13).

## 2026-09-15 — overseer-41x and overseer-7dj (lingering dev servers)

Source: two codex workers on 2026-09-15. Both finished their work, committed, posted a final message that claimed their servers were stopped, and then stayed `running` for over an hour (overseer-41x from 13:12 UTC until the orchestrator interrupted it 75 minutes later) because the vite dev servers they had started for their Playwright proof were still running and held codex's stdio pipes: `lines` never ended, `exit` never resolved and the daemon never saw the turn end. The orchestrator stopped both by hand and killed the orphaned vite trees separately. The interrupt notes on the beads:

> Stopped by the orchestrator: Worker finished its work and posted its final message at 15:12 local (commit 3b977e8, checks recorded) but the codex process never exited: two vite dev servers it started from its worktree on port 5174 are still running and hold the session open. Stopping so the commits go through verification and merge (worker session 2b87a5d6-44d8-4b8f-a1fc-0b602f35d28c), after it had committed: its commits are kept and the bead goes on to verification

> Stopped by the orchestrator: Worker finished (commit 40c6fa37, checks recorded) at 16:58 local but the codex process never exited: the vite dev server it started on port 5189 is still running despite its "server stopped" claim. Stopping so the commit goes through verification; killing the orphaned vite tree separately (worker session 6ffb2b1c-5c53-4ce6-ae42-db8c5eaa52f6), after it had committed: its commits are kept and the bead goes on to verification

- **Stop every server or watcher you started (dev server, preview, Playwright) before your final message: the session cannot end while one is still running.** Applies to: worker prompt (the browser-proof bullet).
- **The daemon does not depend on the worker obeying: the codex adapter ends the turn on `turn.completed` after a grace (`TurnGrace`, `TURN_END_GRACE_MS`), kills the process tree if the CLI is still alive, and uses `fileHolders` to sweep a process that inherited both session-log handles (the live proof of overseer-psr ran `node bg.js` through pwsh, both exited, and only those handles still led to the background node); requiring both stdout and stderr excludes a human tailing only the stdout log.** Applies to: `util/procs.ts`, `harness/codex.ts` (bead overseer-psr).

## 2026-09-15 — acme-portal-sample-038 retrospective

Source: batch acme-portal-sample-038 (#9321 pipeline consolidation): 2 beads, 9 re-dispatches, 1 stop, 201 minutes, $29 worker cost. The user wrote this retrospective:

> 1. A written decision replaced the stated goal. A decision said the deployment controller publishes releases, so there should be no deploy jobs. The requested result was to match the reference project, which has direct deploy jobs. The decision was wrong, and the work followed it without checking the reference.
> 2. The reference was stale. The local checkout was from July. Its remote development branch had moved, including deployment jobs and new endpoints. The first comparison used the stale copy.
> 3. A constraint bred a workaround. Requiring an unchanged cloud-specific CI file led to same-name job overrides in another CI file. The reference configuration used neither file that way, so the result failed parity.
> 4. The first rewrite repeated the pattern. It reshaped the cloud CI file to match the stale project, including templates and deployment jobs. The requested change was to restore that file with value changes only. "Identical to the reference" meant change only what differs from the current reference, not restructure every file.

- **A decision on an issue is input, not ground truth.** When the user names a reference system, compare its current remote state (`git fetch` and `origin/<branch>` blobs, never a working tree) before accepting any written decision that contradicts it. Applies to: orchestrator bead descriptions name the reference remote ref; worker prompt.
- **“Identical to X” means change what differs from X, keep what X also has, and keep the additions the user names.** It does not mean touch every file. Applies to: worker prompt; orchestrator prompt near rule 21.
- **When a constraint forces a mechanism the reference does not use, stop and raise the constraint.** The worker reports it as a `FAIL/blocked` line; the orchestrator calls `ask_user`. Do not build the workaround. Applies to: both prompts.
- **Before deleting an env file, diff its keys and values against the job variables that replace it, and report the diff.** Applies to: worker prompt.
- **Before renaming a hostname in a deploy job or chart, list the live objects that still claim the old and the new host.** A duplicate ingress host fails silently. Applies to: worker prompt.
- **Report lint, the parity table, and operational risks as three separate things.** The parity table maps each reference job to one local job and classifies it as expected difference, local addition, intentionally absent, or `DEVIATION`; valid YAML is not a safe deployment. Applies to: worker results block; orchestrator review note.

Signal (review finding, 2026-09-15 12:33 UTC):

> [must] The change titled "keep the cloud deployment config untouched" reverted many unrelated files, including unrelated fixes, a chart-filter rename, CI reliability changes, team learnings and release notes.

- **A restore or comparison in a worker is always against the merge base, never a branch tip.** When the base branch has a remote, fetch it and use `MB=$(git merge-base origin/<base> HEAD)`; without a remote, use `MB=$(git merge-base <base> HEAD)` against the local base branch; for a batch feature branch, use its local merge base because its remote copy has no newly landed beads. Restore with `git checkout $MB -- <file>`, never from a branch tip; after restoring, paste `git diff --name-only $MB...HEAD`, which must list only task-allowed files. Applies to: worker prompt; orchestrator re-dispatch instructions.

Signal (reopen note, 2026-09-15 12:50 UTC):

> stopped by the orchestrator: dispatched to codex although the user asked for claude (tier + harness together let the tier pick codex); re-dispatching with harness claude only

- **To force a CLI, call `spawn_worker` with `harness` and without `tier`.** Passing both lets the tier candidate list pick another harness. Applies to: orchestrator `spawn_worker` tool bullet. Superseded on 2026-09-25 (overseer-fczf, below): passing both now forces the harness within that tier.

## 2026-09-15 — acme-portal-sample-033 retrospective

Source: batch acme-portal-sample-033 (#9317, MR 8400). After rejection for merge conflicts, a merge bead landed on the local batch branch but the orchestrator did not request review again, so the branch was never pushed and MR 8400 kept running the old head. When the user later reported failing tests, the orchestrator diagnosed the `script_failure` correctly but compared `origin/dev` with the pushed feature branch and created a second merge bead even though the fix was already present; the batch branch was clean at merge commit `0608eef5`, and re-requesting review pushed it and turned pipeline 9149807 green.

- **A landed bead in a `gitlab-mr` batch is not in GitLab until review is requested again.** Before creating a fix bead for a failing MR pipeline or a `behind the base` finding, compare the MR head SHA with the local batch branch; if they differ, call `request_batch_review` again to push the landed commit instead of dispatching a new bead. After a rejection is addressed by a landed bead, re-request review at once. Applies to: orchestrator rule 6.

## 2026-09-15 — overseer-b43-ixy7 retrospective

Source: mascot part 3, batch overseer-b43-ixy7: 3 beads, 13 re-dispatches, 250 minutes and $40.72 worker cost. Bead overseer-7dj alone went through seven review cycles on the phone strip and rail layout.

> round 4: "with an orchestrator model configured (e.g. status text 'thinking · claude-opus-4-1'), the strip overflows 390 px because `.rail-status-live` and `.rail-status-text` do not shrink (Playwright measured New session ending at 444.7 px, document scroll width 445 px)"; round 6: "The phone strip no longer fits at 390 px in a common state: with `Restart needed` shown and the state word 'idle (session open)', `.rail-status` measures scrollWidth 390 against clientWidth 366 and the New session button's right edge lands at 402 px ... The earlier evidence only covered the short state word 'thinking' (366 px, fits), which hides the case."

- **A bead that changes a responsive layout names the worst-case content states its proof must measure: the longest state word, every optional badge, a configured model or other longest value, and both breakpoints; the worker measures and screenshots those states, not whichever state the app happens to show. A short-state proof is not evidence for the strip.** Applies to: orchestrator rule 13, worker browser-proof bullet.

> round 3 asked "Consider hiding the elapsed timer below 768 px", round 5 instructed "Do not mount `Elapsed` on phones", and round 7 then found "The elapsed turn timer is gated on `!phone`, so below 768 px there is no elapsed counter at all ... mount it on phones too". Seven cycles were needed before the user decided a prescriptive layout, which then passed.

- **A critic reads the bead notes for earlier rounds and does not reverse a decision an earlier round asked for and the worker implemented unless it is a must with new evidence. When a bead has had three review cycles on the same surface, the orchestrator asks the user for a decision instead of re-dispatching another finding; it then re-dispatches only with a prescriptive spec (exact layout, states and measurements), or accepts.** Applies to: critic prompt, orchestrator rule 4.

> overseer-nfc round 1: "[must] The spec conflict was resolved by dropping main's two board-strip sentences instead of keeping both sides. `git diff 62ceb78 HEAD -- <spec>` shows neither of main's edits survived ... They were replaced by a new invented bullet".

- **When resolving a merge conflict, keep both sides' content unless the task says otherwise, never substitute invented wording, and verify afterwards with `git diff <each parent> HEAD -- <file>` that each side's hunks survived; paste that check in the final message.** Applies to: worker merge-conflict bullet.

## 2026-09-15 — overseer-b38-rrse retrospective

Source: batch overseer-b38-rrse (batch refresh after a sibling merge): one bead, 12 re-dispatches, 335 minutes and $32.87 worker cost. One bead changed fetched-base resolution, ancestor wait and deferral, the squash escape, conflict handling and notices, merge-bead recovery, and retrospective signals, Review banner and docs; each review round found a new edge case in another behaviour. The existing entries already cover merge-conflict preservation and recovery review discipline, but not splitting lifecycle work or recording final runner summaries.

- **A bead that changes lifecycle semantics (merge, refresh, verification or landing) is split into one bead per behaviour, each with its own tests and review, chained with `blocked-by:` in one batch. A single description that lists more than two behaviours or touches more than one lifecycle path is a sign to split before dispatch.** Signals: round 1 "Line 997 now writes `merged_commit: mergedHead` ... in both merge modes"; round 3 "The deferred refresh path (integrate, ~line 512-513) still skips the ancestor check"; round 6 "The ancestor check at resolveRefreshBase (line 627) never succeeds when GitLab squash-merges"; round 9 "integrate() runs the deferred refreshFromBase before merging the bead, so the merge bead ... triggers the same conflict wake notice one more time"; round 10 "The recovery block in integrate() ... can throw ... which strands the bead"; round 11 "resolveRefreshBase's squash/rebase escape accepts a base that may be up to 30 s old". Applies to: orchestrator prompt, rule 2.
- **A `Check:` line for a test run quotes the runner's own summary line from the run at the final commit. A run that did not finish, was interrupted or ran before the last commit is recorded as `FAIL` or `NOT RUN` with the reason, never `PASS`.** Signals: round 1 "[must] The required `npx vitest run` in packages/daemon was never completed and was reported FAIL/unknown. I ran it: 4 tests fail, 3 of them caused by this change"; round 11 "[must] packages/daemon/src/lifecycle/lifecycle.test.ts: `npx vitest run` in packages/daemon FAILS, so the recorded Check line does not hold. 'batches: a recovery bead that merges the queued base clears refresh conflict metadata' (line ~1108) fails deterministically". Applies to: worker prompt, results block.

## 2026-09-15 — overseer-b33-e4d5 retrospective (rejection)

Source: Accounts batch overseer-b33-e4d5: 4 beads, 25 re-dispatches, 575 minutes and $78.73 worker cost, then rejected. The user's goal was login from the Setup page without a terminal. The fallback required a terminal on another machine, which was the problem the bead existed to remove; comparable tools such as opencode achieve the flow with their own OAuth PKCE implementation, but nobody inspected one before the fallback was adopted.

> oauth_token accounts (claude): `claude setup-token` is interactive ... Try driving it with a plain stdin pipe first ... If the command refuses to run without a TTY ... implement the paste path only

> [must] packages/daemon/src/accounts/login.ts: The driven `claude setup-token` path cannot work: the CLI writes nothing to a piped stdout. I probed it three ways ... Item 3's fallback is the one that applies: implement the paste path only

> Implement the paste path only for oauth_token accounts: POST login returns state 'pending' with `instructions` telling the user to run `claude setup-token` on any machine and paste the printed token

> Why can't we do the oauth path for Claude code? Some other applications/alternatives do support this so we should be able to do this too.

- **A bead description never pre-authorises a fallback that degrades the user's stated flow.** When the chosen mechanism fails or a worker result or review finding proposes a lesser alternative, the orchestrator stops and reports, checks a named comparable tool's implementation for an equivalent route, dispatches it if reachable, and otherwise asks the user before instructing the fallback. Applies to: orchestrator prompt (rules 21 and 4).
- **A critic reports it as a `must` finding that states, with the evidence, that the requested mechanism cannot work, not as an instruction to implement the lesser alternative.** Naming a degraded fallback is the user's decision. Applies to: critic prompt.

## 2026-09-16 — overseer-b50-yhfl: removal sweeps its references

Source: batch overseer-b50-yhfl.

> "The three-line comment at lines 88-90 above <Mascot> still explains the wording of the text this change deleted ... None of those strings exist in the component any more, so the comment now describes nothing."

> "README.md line 124 still tells the user the rail shows \"its state: 'thinking' ... 'idle (session open)' between turns, 'idle' with no session\", which this change removes"

> "Two more places in the batches spec still document the status text this change deleted, so the spec now contradicts itself."

- **When a change deletes a string, prop, class or behaviour, grep the whole repository for it, including comments, README, CLAUDE.md, specs and test names, and correct or delete every mention in the same change. A comment or document that describes what no longer exists is a defect, not a leftover.** Applies to: worker prompt.

## 2026-09-16 — overseer-b50-yhfl: replacement assertions must fail

Source: batch overseer-b50-yhfl.

> "The four replacements of the old statusLine() assertions with expect(document.querySelector('.rail-status-text, .rail-status-state')).toBeNull() ... can never fail: both classes were deleted from the app, so the query is null in every state."

> "the state assertion became `aria-label` toContain('orchestrator:'), which is true for every mascot state, so the test no longer verifies the idle orchestrator its name promises."

- **When a test's subject is removed or changed, the replacement assertion must fail if the behaviour it names breaks. An assertion that holds for every state, a query for something that no longer exists, or a test whose name promises more than its body checks, is worse than deleting the test, because it reads as coverage.** Applies to: worker prompt.

## 2026-09-16 — overseer-b52-salt retrospective

Source: batch overseer-b52-salt (Setup left sub-navigation), merged 2026-09-16. Bead overseer-uzm went through three review cycles, each finding a different entry point into Setup that the new section selection missed. The bead description said “Every existing entry point into Setup must still land on the right section” and named two examples; it did not list them. The signals were:

> Round 1: "[must] packages/web/src/views/Setup.tsx: The Chat \"Open Setup\" entry point is missed. Chat.tsx:178 renders \"Register a repository in Setup first ... Open Setup\", wired in App.tsx:210 as onSetup={() => onView('setup')}. onView calls setAskedFor(null), so sentFrom is null and the new sentFrom effect does not fire; the user lands on General (Prerequisites + Daemon) with no repository UI at all"

> Round 2: "[must] packages/web/src/App.tsx: The no-repository auto-redirect (App.tsx:132, `if (repos.length === 0 && !manual.current) setView('setup')`) still lands on General, so the fresh-install flow reaches Setup with no repository UI at all. ... This is the same defect round 1 raised as a must for Chat's 'Open Setup' button, on the more common path"

> Round 3: "[should] packages/web/App.tsx: On a reload while repo-less the doctor alert no longer wins with General. `decided` is initialised to `viewFromHash() !== null` (App.tsx:52), and after the first redirect the hash is `#setup`, so on every later load the effect returns at `if (decided.current) return;` (App.tsx:143) before the `doctorAlert(doctor)` branch"

- **When a bead changes where a view or section lands, enumerate every entry point by name and give each one its own Definition of Done test. Find them by grepping for the view's setter and every redirect into it; if a review round finds a missed entry point, list every remaining one it can find in that round so a re-dispatch closes the class, not one instance.** Applies to: orchestrator prompt, rule 2.
- **When a task changes a landing or selection mechanism, grep for every caller of the setter or redirect before coding, list each caller with the section it now lands on and the test covering it in the final message, and treat “every entry point” as a request for that list.** Applies to: worker prompt.

## 2026-09-16 — overseer-b53-6ykc retrospective

Source: batch overseer-b53-6ykc (Setup Accounts usage percentages), merged 2026-09-16. Across three batches on 2026-09-16 the review rounds spent separate rounds on the same class of finding: a behaviour change landed without updating one of this repo's documentation surfaces (CLAUDE.md route/convention lines, README.md's user-facing paragraph, the batches spec `docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md`), and each round found one surface at a time, so a bead needed up to three re-dispatches for docs alone. The bead descriptions had not named the surfaces.

> overseer-b53-6ykc, overseer-aez round 1: "[should] CLAUDE.md: CLAUDE.md enumerates the account routes (`GET|POST /api/accounts`, `/api/accounts/:id/login`, `/login/code` and `/verify`) and the new `/api/accounts/:id/usage` is not listed; the repo convention is that behaviour changes update CLAUDE.md in the same batch."

> overseer-b53-6ykc, overseer-d5e round 1: "[should] docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md: The batches spec has an Accounts section (line 150) that still describes Accounts without the usage route or the usage line, and neither this bead nor the daemon bead overseer-aez touched it"

> overseer-b53-6ykc, overseer-d5e round 2: "[should] README.md: The usage line is user-visible behaviour in Setup → Accounts, but README's Accounts paragraph (line 144) still describes Accounts without it, and `git diff main...HEAD --name-only` shows no bead of this batch touched README."

> overseer-b52-salt, overseer-uzm round 3: "[should] README.md: README.md:144 still reads \"Prerequisites at the top, then Models, Accounts, the registered repositories and the add form.\", which describes the stacked layout this change replaced. CLAUDE.md requires README to carry the user's view of a behaviour change in the same batch."

> overseer-b56-gade, overseer-088 round 1: "[must] README.md: The README sentence doesn't describe the new behaviour." and "[should] docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md: The project CLAUDE.md says behaviour changes update the batches spec in the same batch."

- **A bead description for a behaviour change in a repo that keeps documentation surfaces lists each surface explicitly as a Definition-of-Done item with the section to touch, or states which other bead of the batch carries it; `update docs` without the list is not enough.** Applies to: orchestrator rule 2.
- **Before the final commit, grep the repo's CLAUDE.md for the documentation surfaces it requires and check each one against the change; list each surface in the final message as updated, or as not applicable with the reason.** Applies to: worker documentation rule.
- **A round that finds a documentation surface missing checks every other surface the repo's CLAUDE.md names in the same round and reports them together, so one re-dispatch closes the class.** Applies to: critic prompt.

## 2026-09-16 — overseer-b60-utcl retrospective

Source: batch overseer-b60-utcl. Chat loads the latest messages only. Bead overseer-nzc needed five re-dispatches. Two review rounds found that switching Chat from a full `/api/chat` fetch to a paged, `since`-delta fetch lost data other consumers had relied on, and a daemon change had to be added mid-way through the web bead. The signals were:

> 1. "[must] packages/web/src/App.tsx: Open questions no longer reach Needs at all: `needsYouItems(board, [])`, `counts.questions: 0` and so `pendingQuestion={false}` always. The rail's Chat badge, the mascot's asking state, the favicon count and every question item in Needs are gone."
>
> 2. "[must] packages/web/src/views/Chat.tsx: The `since` delta only returns rows with `id > newest` (`db.ts` `page`: `id>?`), so changes to rows already loaded never arrive. A question the daemon supersedes, or that gets answered from another device or by the orchestrator, keeps its null `answered_at`/`superseded_at` in client state and stays pinned in the composer until a full reload. The old full refetch picked these up."
>
> 3. "[must] packages/web/src/App.tsx: Task item 4 can't be met with the current API. App now feeds `needsYouItems` only the latest 100 rows (`/chat?limit=100`), and `db.chat.page()` (db.ts:136-143) adds only `reply_to` refs. It has no kind or open-question filter. [...] This needs a daemon follow-up that returns open questions [...] The orchestrator should decide it, not this web bead."
>
> 4. "[must] packages/web/src/views/Chat.tsx: An answered question older than the page window stays pinned in Chat, with its answer box. [...] The same applies to a `queued_at` row below the window after `flushQueued` [...] The old full refetch covered all of these."

- **When a batch replaces a full list fetch with a paged or delta fetch, the API bead's description lists every consumer of the full list (grep the endpoint and its client helper) and every field that changes on rows already loaded, and states how each consumer still gets current data. The client bead is not dispatched until the API bead covers all of them.** Applies to: orchestrator prompt.

## 2026-09-16 — overseer-b61-w7ml retrospective

Source: batch overseer-b61-w7ml (Account failover). The signal was:

> [must] packages/daemon/src/harness/claude.ts: Claude Code sends `rate_limit_event` on ordinary turns too, not only when a limit is hit. The recorded fixture `src/harness/fixtures/claude.jsonl` has three of them, all with `rate_limit_info.status: "allowed"` at 19-20% five_hour usage, and the new test asserts that all three become `rate_limit` events. As written, every Claude worker and critic is stopped at its first event, its account is marked exhausted, and the bead is re-dispatched. Only treat the event as a limit hit when `rate_limit_info.status` shows the limit was reached (e.g. `rejected`; decide what `allowed_warning` means).

- **Before creating a bead that acts on an external event or message type (a CLI stream event, a webhook, an API status), grep the repo's fixtures and logs for that type, quote one real sample in the description, and name the field and value that trigger the action; never state an assumed shape as fact.** Applies to: orchestrator prompt, How to work, step 2.

## 2026-09-16 — overseer-b62-igei retrospective

Source: batch overseer-b62-igei (account labels). The signal was:

> [must] packages/shared/src/index.ts: The requested mechanism cannot work as specified: the Definition of Done requires `pnpm typecheck` to pass, but the task makes `Account.label` and `BoardCard.account_name`/`account_label` required fields and forbids touching the web package. As a result, `pnpm typecheck` fails with TS2741/TS2739 in packages/web/src/components/AccountsSettings.test.tsx (lines 8-9), ModelsSettings.test.tsx (lines 20, 60, 90, 102) and packages/web/src/test/fixtures.ts (lines 24-31), which I reproduced in this worktree. Required shared types plus an untouched web package cannot give a clean typecheck.

- **When a batch splits a change across packages, each bead's Definition of Done must be reachable with only the files that bead may touch. A bead that changes a shared type owns every compile fix it causes in other packages (fixtures, test helpers), or the type change is made optional until the consuming bead lands.** Applies to: orchestrator prompt.

## 2026-09-16 — overseer-b67-6os6 retrospective

Source: batch overseer-b67-6os6 (board cards). Four of its eight re-dispatches were caused by screenshots whose captions claimed states the image did not render. The signals were:

> 1. "[should] The evidence misses the requested contents. At 1280 px the running card's agent pill reads only \"codex · …\", so the longest model name is never visible [...] The 390 px screenshot shows only the Ready column, with no running, verifying, done or long-title card."
>
> 2. "[must] The evidence set does not show the required \"account with a label\". [...] a `title` attribute is an OS-drawn tooltip that a Playwright page screenshot never captures. The final message's line for merged-1280.png (\"account hover verified\") is therefore not supported by that image."
>
> 3. "[must] Evidence: no capture shows a Failed card. The card titled \"Failed verification example\" renders with a `Ready` pill [...] because its mock `verify_failure` is null. [...] Then describe each image by what it actually renders, not by what it was meant to show."
>
> 4. "[should] merged-1280-pane.png does not render what the final message says it renders. The pane was captured mid `detail-slide-in` animation [...] the Account value reads \"Prima\" with the rest off-image. [...] Rounds 1 and 2 both asked for captions that match the image."

- **After taking a screenshot, open the image and describe only what it actually renders. A state counts as captured only when it is visible in the image; a hover tooltip, a value clipped at an edge, or a frame taken mid-animation is not evidence. When a required state is missing, change the fixture or the capture and take it again, and never name a state in a caption that the image does not show.** Applies to: worker prompt.

## 2026-09-16 — overseer-b69-5km2 retrospective

Source: batch overseer-b69-5km2 (Setup polish). The bead named two widths, 390 px and 1280 px, and both of its re-dispatches were breakages in the bands between them. The signals were:

> 1. "[should] packages/web/src/styles.css: The new desktop grid cannot fit between 768 px and about 1000 px, where the old flex row worked. At 768 px the row needs 272 px in a 250 px container, so the account actions extend 6 px past the card and the three buttons stack into three lines; at 800 px they still use three lines, and at 900 px two. The layout is correct at 390 px and 1280 px; the problem is the band above the 767 px breakpoint, including narrow tablets and landscape phones."
>
> 2. "[should] packages/web/src/styles.css: [...] the label track keeps its full 180 px and the actions track its auto width, so at 1024 px (iPad landscape) the name, status and usage block is about 106 px wide and wraps to roughly twelve lines [...] Nothing overflows, and 390 px and 1280 px are correct, so this is only the band from 1001 px to about 1150 px."
>
> 3. "[should] packages/web/src/components/AccountsSettings.test.tsx: The replaced test was the only guard on the account row layout CSS [...] The phone stacking now lives entirely in the `@media (max-width: 767px)` rule [...] delete that one line and 390 px gets the 180 px label column plus the button column again while all 305 web tests stay green. The repo pairs a behaviour assertion with a styles.css regex for exactly this."

- **A bead that changes a responsive layout names every breakpoint the stylesheet defines and requires a measurement at each breakpoint edge and at one width inside each band, not only at the narrowest and widest widths.** Applies to: orchestrator prompt.
- **When a layout rule moves into CSS, keep a test that would fail if the rule were deleted; in this repo that is a behaviour assertion paired with a stylesheet assertion, as `Setup.test.tsx` and `Rail.test.tsx` do. Measure a layout change at each breakpoint edge and inside each band, and report the measured numbers.** Applies to: worker prompt.

## 2026-09-16 — worker dev servers on the user's web port

Worker prompt, "Rules", the browser-proof bullet.

- **Start proof servers on an explicit port, never 5173, 5174 or 4400.** Workers in `acme-portal-sample-013` and `overseer-jb2` started Vite with its default port and left it running. Both held 5173, so the user's Tailscale URL reached a worker's Vite, which answered "Blocked request" for the unlisted host, and `pnpm start` fell back to 5175. "A free port" was not enough, because 5173 is free whenever the user's server is down.

## 2026-09-16 — /insights report over 2026-09-09 to 2026-09-16

Source: an `/insights` sweep of the week's runs, not a single batch retrospective. Two recurring patterns, each costing repeated re-dispatches or a wasted worker session:

> bead an7 reopened three times on the verify command `node -e "process.exit(1)"`: the same failure output on every attempt, because the command itself always fails regardless of the work.

> four codex workers on 2026-09-14/15 exited in 0 s with `codex exited with code 2` and clap usage text (`codex exec [OPTIONS] <COMMAND>`): a CLI invocation error before any turn started, re-dispatched onto the same broken invocation each time.

- **Overseer now probes a repo's setup and verify commands on the base branch itself (`lifecycle/probe.ts`) whenever they are saved, and `spawn_worker` refuses to dispatch while a probe is failing: the command is the suspect before a worker ever runs it, not after two beads have failed on it.** Applies to: orchestrator prompt, rule 22 (`Overseer also probes the command on the base branch when it is saved; while that probe fails, spawn_worker refuses with the command and exit code, so relay that refusal to the user instead of retrying.`).
- **A worker that exits in 0 s with a harness's own usage/argument-parsing error, not a task failure, is a broken invocation, not broken work: `lifecycle/crash.ts` classifies it `harness_bug` and reopens with a hint not to re-dispatch on that harness, rather than retrying the same broken command.** Applies to: orchestrator prompt, rule 4 (`An "[Overseer] … re-dispatched after a transient stream failure" notice needs no action; a reopen whose hint names a harness bug must not be re-dispatched on that harness.`).

## 2026-09-16 — overseer-b65-un2y retrospective: safety clauses enforce harness isolation

Source: batch overseer-b65-un2y. Signal, quoted verbatim from the re-dispatch record:

> in `packages/daemon/src/app.test.ts`, `setup()` builds its config from `loadConfig({})`. So `x.config.dataDir` is the live default `C:\\Workspace\\dev\\.overseer`, and the multibyte `waitForSuccessorReady` test truncates the real `daemon-restart.log` with `fs.writeFileSync`. The last test run replaced the user's live file with the rocket fixture and a fake pid marker.

- **When work touches a path, port or process that the user's live install also uses, the worker makes the harness fail on the default with a temp dir or port and an assertion that the resolved value is not the default; it does not rely on care.** A bead description for such work asks for that guard by name. Applies to: worker prompt; orchestrator prompt bead-writing rules.

## 2026-09-16 — overseer-b65-un2y retrospective: deadlines use elapsed time

Source: batch overseer-b65-un2y. Signal, quoted verbatim:

> waitForRestartParent's 60-second deadline is iteration-based (elapsed += 100), but each iteration also awaits isAlive, which launches PowerShell on Windows. A start-time query averages about 180 ms here, so this path takes roughly 168 seconds and then incorrectly logs 'after 60s'

- **A timeout or deadline in a polling loop is computed from a clock reading taken before the loop, never by adding the sleep interval per iteration, and its test makes the work inside the loop consume time so the bound is real.** Applies to: worker prompt.

## 2026-09-16 — overseer-b65-un2y retrospective: chat carries asks, not narration

Source: batch overseer-b65-un2y. Signal, quoted verbatim from the user during this batch:

> Why do I keep saying gigantic texts from sub agents? I’m only interested when you have a direct ask for me or you say something I need to respond to

- **The orchestrator writes to the user only for a question, a decision, a failure the user must act on, or a finished request; it does not recap running work.** Helper output is summarised in the orchestrator's own words and never pasted. Applies to: orchestrator prompt.

## 2026-09-17 — acme-portal-sample-014 retrospective: outward-facing text carries no Overseer vocabulary

Source: the setup-flow improvement (sample work item #9323), merged 2026-09-17.

> Please keep internal project terminology out of text written for people outside this project.

- **Text that leaves the system under the user's name — a merge-request title or description, an MR or issue comment, a commit message, a work-item note — never names Overseer or its vocabulary (Overseer, bead, batch, worker, orchestrator, critic, review round, dispatch, worktree id). Describe the change itself: what changed, why, how it was verified.** Applies to: orchestrator prompt (the review-note rules for request_batch_review and request_merge) and worker prompt (commit messages and any text the worker writes into GitLab).

## 2026-09-17 — acme-portal-sample-014 retrospective: a reported test failure is reproduced before anything is edited

Source: acme-portal acme-portal-sample-014 (#9323 Start Onboarding), merged 2026-09-17.

> [must] e2e/specs/regression/setup-only.spec.ts: This change does not address a reproduced cause. Before the edit, the exact check passed and logged creation of the run account before the first case. The test framework resolves worker fixtures before beforeAll hooks. The explicit runAccount parameter therefore cannot explain the missing file; investigate the original transient or concurrent-cleanup failure and compare with the base before changing the test.

> No change needed. The setup-only spec passes on the branch (12 passed), as do typecheck and lint. The earlier missing-account failure did not recur on the branch or the base.

- **When work starts from a reported failure, reproduce it first — run the exact reported command on the branch and, when the failure is claimed to be pre-existing, on the base branch too. A change that is not tied to a reproduced failure and a named root cause is not made; the worker reports that the failure does not reproduce, with both runs quoted, and stops.** Applies to: worker prompt, and the orchestrator's bead-writing rules (a bead created from a reported failure states the exact command and requires the reproduction step before any edit).

## 2026-09-17 — acme-portal-sample-014 retrospective: a Definition-of-Done check must cover the files the work changed

Source: acme-portal acme-portal-sample-014 (#9323 Start Onboarding), merged 2026-09-17.

> [should] Two Definition-of-Done lines do not say what they appear to say. `npx vue-tsc --noEmit -p tsconfig.app.json` only includes `src/**` (see tsconfig.app.json `include`), so it typechecks none of this diff; `e2e/**/*.ts` lives in tsconfig.node.json, which is what `npm run build`'s `vue-tsc -b` covers. `npm run lint` (oxlint scans e2e/) was not run at all. Both pass when actually run against this diff, so the record just needs correcting to the commands that cover the changed file. Separately, the `npm run test` FAIL line is unresolved: no unit-tested file changed here, so either state that the unit suite is not applicable to this diff or land a completed run.

- **Before recording a check as passed, confirm the command actually reads the files that changed (a typecheck project's `include`, a linter's scan paths, a test filter). When it does not, run the command that does and record that one. A check that does not apply to the diff is recorded as not applicable with the reason, never as a pass and never left as an unresolved FAIL.** Applies to: worker prompt (the results block).

## 2026-09-17 — overseer-b82-dfwi: size a layout to the container it actually gets

Source: batch overseer-b82-dfwi. The signal is the review re-dispatch:

> The requested three-column desktop mechanism cannot fit under the task constraint to change only the account rows at 768-1199px: the supplied measurements show only 250px of row width at 768 and 480px at 1001, while the fixed 240px fields column plus 230px actions column and one 10px gap already consume all 480px before the account-info column.

- **Before a bead prescribes a layout for a width band, measure the width of the container the view actually gets at that band (after side menus and padding), not the viewport, and check that the prescribed columns fit; if they do not, ask the user before dispatching.** Applies to: orchestrator prompt (rule 13); worker prompt (browser-proof bullet).

## 2026-09-17 — overseer-b82-dfwi: a fresh evidence folder per attempt

Source: batch overseer-b82-dfwi. The signal, from the worker's final message:

> The same folder also holds files from an earlier attempt that I didn't make or check: `accounts-1300.png`, `accounts-1600.png`, `accounts-500*.png`, the `*-opencode.png` files and `measurements.json`. Don't rely on them.

- **Before capturing, empty the evidence folder the task names, or write into a new subfolder for this attempt, so the reported folder only holds files this attempt made and checked.** Applies to: worker prompt (browser-proof bullet).

## 2026-09-17 — overseer-b72-xmlw: review findings live only in the critic's final message

Source: batch overseer-b72-xmlw. The signal is the whole instruction of a re-dispatch:

> - [must] Waiting on the daemon suite. While it runs, here's what I've confirmed so far.

- **A critic never writes a `[must]` or `[should]` marker in an interim message — findings live only in the final `submit_review` — and a re-dispatch whose only finding is not a defect is not dispatched: the orchestrator reports it to the user instead.** Applies to: critic prompt (`packages/daemon/prompts/critic.md`); orchestrator prompt (rule 4).

## 2026-09-17 — overseer-b72-xmlw: verify a value taken from an external catalog

Source: batch overseer-b72-xmlw. The signal, from the re-dispatch that fixed it:

> One fix, nothing else: the suggested DeepSeek model id is a retired legacy name.

- **A model id, provider name, endpoint or other value copied from a vendor catalog is checked against the vendor's own documentation or catalog before it ships, and the source is quoted in the final message.** Applies to: worker prompt.

## 2026-09-17 — overseer-b72-xmlw: a doc sentence goes in the section that already covers its topic

Source: batch overseer-b72-xmlw. The signals, from the same review round:

> The added sentence sits at line 5, between the date line and `## Why`, so it floats outside every section of the design doc.

> The added sentence at line 154 duplicates the paragraph immediately below it

- **Before adding a sentence to a document, grep that document for the facts it states; put the sentence in the section that already covers the topic, extending that text rather than repeating it, and never above the first heading.** Applies to: worker prompt.

## 2026-09-17 — overseer-ialj: a shell call never returns while a started process holds its pipes

Source: task overseer-ialj, nine of twelve stalled opencode sessions on 2026-09-17. One stalled session's last event:

> tool bash running {"command":"playwright-cli open \"http://localhost:5200/shimmer-check.html\" 2>&1 | Select-Object -Last 20","timeout":120000}

- **Start every server, daemon or browser with none of its standard handles attached to the shell (in PowerShell, `Start-Process` with `-RedirectStandardOutput`, `-RedirectStandardError` and `-WindowStyle Hidden`), poll a server's port with a bounded timeout and stop the server and its process tree before the final message; a browser opened with `playwright-cli open` outlives the process that opened it, so stop it with `playwright-cli close` and confirm with `playwright-cli list` that none is left.** Applies to: worker prompt (background-commands bullet).

## 2026-09-17 — review on 2026-09-17: Git Bash cannot resolve an npm CLI shim

Source: a review on 2026-09-17 that reported a browser check as blocked. The signal:

> my Git Bash failing to resolve the playwright-cli shim ('Cannot find module ...\program files\nodejs\node_modules\@playwright\cli\playwright-cli.js')

- **When a `pnpm`, `npx` or `playwright-cli` call fails in Bash because its `.cmd` shim does not resolve, run it from PowerShell instead of retrying in Bash or reporting the check as blocked.** Applies to: worker prompt.

## 2026-09-17 — overseer-e2jf: the prescribed `Start-Process` recipe hangs opencode's shell tool

Source: task overseer-e2jf, investigating three opencode sessions (`overseer-eyau`, `overseer-dxep`, `overseer-o355`) that stalled at the same time on 2026-09-17. No prompt rule was added or changed; this entry exists to stop a wrong diagnosis and a wrong fix from coming back.

The evidence gathered live while all three were stalled:

> 1. Each session log ends on a `step_start` with nothing after it. `tool_use` is only written when a tool call completes, so the log ending on `step_start` means a shell call was issued and never returned.
> 2. The timing lines up exactly. Session log last write, then the child process creation time: `overseer-eyau` 23:29:09 then 23:29:11; `overseer-dxep` 23:30:02 then 23:30:04; `overseer-o355` 23:35:39 then 23:35:41. The silence begins about two seconds before a server child appears, not after.
> 3. Those children are alive and listening. `overseer-eyau` a daemon on 5231, `overseer-dxep` a daemon on 5251 and a Vite server on 5250, `overseer-o355` a daemon on 5230, each with an `esbuild.exe` grandchild. So the hung shell call is the one that starts the dev server.
> 4. The last COMPLETED shell call in each log is ordinary and fast (a `Get-Content`, a `New-Item`, a port probe). The hanging call is the next one, which is why it is absent from the log.
> 5. The server processes' parent pids are not the opencode pids, so opencode reached them through an intermediate shell, and they outlive it.

- **"No tool process is running under opencode, so it is waiting on the model" is wrong for this class.** The silence starts about two seconds *before* the server child appears, and the log ends on a `step_start`, which is written when a shell call is issued and not when it returns. A stalled opencode session whose log ends on `step_start` is waiting on its own shell tool, not on the provider.
- **The recipe the worker prompt prescribes is itself the hang.** Reproduced twice outside Overseer, in a `git worktree` checkout of a one-commit temp repo, with `opencode run --format json` on `deepseek/deepseek-v4-flash` and the same `OPENCODE_PERMISSION` value the adapter sets. Command, verbatim, as the only instruction in the turn: `Start-Process pnpm.cmd -ArgumentList 'dev' -RedirectStandardOutput <file> -RedirectStandardError <file> -WindowStyle Hidden -PassThru`. Both runs printed exactly one JSON line, a `step_start`, then nothing; opencode was still alive and was killed at 300 s and at 240 s. The dev server survived, listening, its parent an intermediate `pnpm.js` whose own parent `cmd.exe` was gone — the same shape as items 3 and 5 above. The shell tool's own timeout never fired, which is why these sessions stay silent far past the 2-minute default.
- **The shapes the same harness returns from.** `pnpm dev` alone returns after the shell tool's 120 s default (or a model-set 60 s) with `shell tool terminated command after exceeding timeout`, and the server is killed with it. `pnpm dev & sleep 3; echo started` returns in about 3 s — opencode's shell tool on Windows is **PowerShell, not bash**, so `&` is the background-job operator and the call prints a `BackgroundJob` table; the job dies with the call. A foreground dev server that spawns a stdio-inheriting grandchild (the `esbuild.exe` shape) also returns, at the 120 s timeout. So the timeout rescues an attached foreground server; it does not rescue the detached `Start-Process` shape.
- **No prompt wording fixes this.** The recipe that the overseer-ialj entry above added to the worker prompt is the exact command that hangs, so telling workers to follow it more clearly cannot help. Choosing a mechanism — a different shell for opencode, a wrapper script, or a stall heuristic — is the user's decision and none was made here.

## 2026-09-17 — overseer-b97-aebq: interrupting a review round moves work away from landing

Source: batch overseer-b97-aebq. Critic sessions on codex and opencode had no `submit_review` tool, so a critic that reached a clean pass could not record it and the daemon counted the round as findings and re-dispatched a worker onto approved work. The re-dispatch record for `overseer-rfza` carries the shape verbatim, the daemon's own words wrapping the critic's:

> The review of the previous attempt (already committed on this branch) found these issues. Fix them so the next review passes:
> - [must] I've completed the review. My verdict is **pass** — no findings.

The orchestrator's response was wrong twice before it was right. Its interrupt reason on `overseer-o355`, quoted verbatim:

> The review it was re-dispatched for returned "Verdict: pass — no must or should findings, the change can land as is". The critic had no submit_review tool in its toolset, the seventh occurrence tonight, so Overseer read the prose as findings and put a worker onto approved work. There is nothing for it to change; stopping it rather than letting it spend a round rewriting a branch a reviewer just cleared.

Stopping the worker did save that round, but it reopened the bead to Ready, which is further from landing than where it started. The state that lands such a bead is `awaits a decision`, which a bead only reaches by finishing its review rounds — and there `accept_review` closes it in one call with the reviewer's own verdict as the reason. Three beads were landed that way the same evening (`overseer-d1zr`, `overseer-yxr`, `overseer-dk4b`), while the two that were interrupted sat parked and needed a fresh worker and two more rounds each to get back.

- **When a review round's findings are not defects — a verdict the critic could not record, a report that contains no defect — do not interrupt the worker that was re-dispatched. Let the rounds finish so the bead reaches `awaits a decision`, then put the reviewer's verdict to the user and land it with `accept_review`. Interrupting is for work that should stop, not for work that should land; it returns the bead to Ready and costs a worker and two rounds to recover.** Applies to: orchestrator prompt, rule 4. This extends rule 4's existing sentence "A re-dispatch whose only finding is not a defect is not dispatched: report it to the user instead", which covers the orchestrator's own dispatch but not a re-dispatch the daemon made automatically.

## 2026-09-18 — overseer-b85-bwp3: a shared contract needs its own blocking task

Source: batch overseer-b85-bwp3. Five view tasks were split by file, so each owned its own view and looked parallel. They also shared one component whose doc comment carries a contract, and one clause of it — stop the shimmer once the fetch has failed — needs state only the shell owns, because a view cannot see whether the fetch it waits on failed. Four separate review rounds then found the same defect in four different tasks, and three of them were told to build the same missing shell state independently in the same file. The batch already had a blocking plumbing task for the other shell-level concern, telling not-loaded from empty; the failure-gating concern needed exactly the same treatment and did not get it, because it was never read out of the component's contract when the tasks were written. The signals, quoted verbatim from three of those rounds:

> The board shimmer is gated only on `p.offline`, but the board's first fetch can also fail with an error the daemon answered (a 400/500 …), where `offline` stays false and `board` stays null — the shimmer then fabricates six columns of cards for the whole failure

> `App.tsx` computes `loadFailed = offline || loadError !== null`, where `loadError` is the shell's single-slot error set by *any* of the eight `load()` fetches … So Needs and PlanList stop shimmering not only when one of *their* fetches fails, but also when an unrelated one does.

> Prerequisites (`:255`) and Repositories (`:286`) shimmers stop only on `offline` (daemon unreachable), not on a daemon-answered 500 … that error leaves the shimmer painting forever under the load-error banner

- **Before dispatching parallel tasks that share a component, read that component's contract and name every requirement in it that needs state the shell owns. Each of those becomes its own blocking task, landed first. Disjoint file sets do not make tasks parallel when they share a contract; the shared state is the real dependency.** Applies to: orchestrator prompt, rule 2, next to the existing sentence about chaining tasks that touch the same file.

## 2026-09-18 — overseer-b85-bwp3: coordination sent to a running worker dies with the session

Source: batch overseer-b85-bwp3. When the orchestrator noticed the three tasks converging, it sent each running worker the same prescribed shape by message. One had already finished and never received it — the call was refused with:

> worker for overseer-a8tl is not running (status ended)

Had either of the other two stalled and been re-dispatched, the prescription would have gone with the session, because a re-dispatch starts from the task's description and notes, not from a previous session's messages. It worked anyway only by luck: the task that never got the message independently chose the same shape the others were told to use, so the three branches converged instead of colliding in one file.

- **Anything told to a running worker that must outlive that turn — a prescribed shape, a decision, a constraint the task text does not carry — is written to the task's notes as well as sent as a message. A message is for the worker now; the note is what a re-dispatch reads.** Applies to: orchestrator prompt, next to the tools that message a worker.

## 2026-09-18 — overseer-b87-wpkx: a silence limit kills a working long command

Source: batch overseer-b87-wpkx. A merge task was killed mid-run although it was healthy. The reopen note, quoted verbatim:

> opencode printed nothing for 1200 s after its last event (step_start); the turn was ended; last message: Now update the `unusableCandidates` helper to preserve the harness-limit check from this batch:

The orchestrator checked while it was still silent and found a live vitest process with its children, and sampled CPU twice twelve seconds apart: the test process had gained about 1.2 seconds of CPU in that window. It was running the slow daemon lifecycle suite on a loaded machine, and that suite prints nothing until it finishes. The adapter ended the turn anyway, the work was lost, and the task had to be redone on another harness.

This is the opposite of the server hang recorded above: there the tool genuinely never returns, while here the tool is working normally and the adapter gives up because its silence limit measures output, not liveness. The two look identical from the log — both end on `step_start` and go quiet — so tell them apart by checking whether a child process is alive and consuming CPU: if it is, the command is working and the limit is about to kill it; if nothing is running, the tool has hung.

- **A command that runs long without printing anything is killed on a harness with a silence limit, however healthy it is: split a long test run — a subset at a time, or per file with a bounded timeout — and commit finished work before starting one, so an interruption cannot cost the whole round.** Applies to: worker prompt.
- **A task whose Definition of Done is a long, silent command — a slow test suite, a full build — is not dispatched to opencode, whose adapter ends a turn that prints nothing for 20 minutes. A stall notice for such a task is checked against the child processes before it is treated as a stall: a live process consuming CPU means the work is real.** Applies to: orchestrator prompt.

## 2026-09-18 — four workers stalled starting a server on a CLI that cannot hold one

Source: four opencode workers in one evening, each stalled on a server start and each leaking a listening server; measured and recorded in `docs/server-start-in-a-worker-shell.md` (a backgrounded start is reaped with the tool call's host, a detached one blocks the tool for good).

- **Pass `needs_server: true` to `spawn_worker` whenever the task starts a dev server, a daemon or a browser, including evidence and screenshot capture; the dispatch then skips every harness that cannot keep such a process alive, and refuses a forced one with the reason.** Applies to: orchestrator prompt (`spawn_worker` tool bullet).

## 2026-09-18 — overseer-b96-lfql: do not move the base while a merge-from-base bead resolves

Source: batch overseer-b96-lfql. A bead resolved eleven files against `main`, correctly. While it was still working, another batch merged into `main`, and the resolution was stale before it could be reviewed. The review finding, quoted verbatim:

> The branch no longer merges cleanly with main. The merge took main at e242d28, and main has since advanced by seven commits (the lessons-shared-contract-plumbing-and-coo batch plus overseer-b99-ittg). `git merge-tree --write-tree main HEAD` exits 1 with CONFLICT (content) in `docs/lessons.md` and `packages/daemon/prompts/orchestrator.md`; against e242d28 the same command exits 0, so the delivered resolution is itself complete and correct, only stale.

That cost a full extra round on work that was already right. It was the third time in one evening that a merge into the base put a conflict back into a batch that had just resolved one; the first two were unavoidable, this one was self-inflicted.

- **A merge-from-base bead's resolution is only valid against the base tip it resolved against, so while one is in flight on any batch, merge nothing else into the base: let it land, merge that batch, then move on. When several batches are waiting, merge them one at a time in a stated order rather than in parallel, and do not start a batch's merge bead before the previous batch is in.** Applies to: orchestrator prompt, next to the existing rule about checking that a batch branch merges cleanly before requesting review.
- **The pre-review merge check is `git merge-tree --write-tree <base> <batch branch>` read by exit status, where 0 means clean, not a grep of the legacy three-argument form's output for conflict markers. Name the batch branch explicitly: the check runs against the primary checkout, whose HEAD is the base, so `<base> HEAD` compares the base to itself and exits 0.** Applies to: orchestrator prompt, rule 20.

## 2026-09-18 — overseer-b81-mo5l: a review finding's premise is checked before relaying

Source: batch overseer-b81-mo5l. A review round prescribed a mechanism, stating a fact about a data source. The orchestrator relayed that instruction into a re-dispatch without checking it. The fact was wrong, the worker built on it, and the next round had to undo the result. Round 2's finding, relayed verbatim into the re-dispatch:

> The cumulative counters the session stores cannot tell which requests crossed 200k, but `ev.usage` at turn_end is that turn's own usage, so pick the tier per turn and accumulate the estimate.

Round 3's finding, on what that produced:

> The per-turn Codex context tiering asked for in round 2 cannot work from `ev.usage`: codex's `turn.completed.usage` is thread-cumulative, not that turn's own usage, and the exec `--json` stream carries no per-request context at all. Evidence from the real logs in `~/.overseer/sessions`: in `503a79a2-...log` turn 1 has 34 `item.completed` events and reports `input_tokens` 6,121,302, while turn 2 has only 3 items yet reports 6,430,193 — three requests cannot carry 6.4M input against a 272k window, so the figure is the thread total

And on the cost of believing it:

> 381 of the 382 recorded codex turns are at or above the 272k threshold and essentially every codex session is now priced at the 2x tier regardless of its real context — round 2 reported the estimate as up to 2x low, this makes it ~2x high almost always

The wrong mechanism reached a commit, was measured against real logs by the next reviewer, and had to be reverted to base-tier pricing — which then needed a user decision of its own. That task took five re-dispatches.

- **The orchestrator's task-writing rule already says never to state an assumed shape as fact (grep the fixtures and logs for the event or message type and quote a real sample), but that rule stops at tasks the orchestrator writes. A review finding relayed into a re-dispatch is an instruction too: before relaying a finding that prescribes a mechanism on a factual claim about what some data holds — a field exists, a value is per-turn rather than cumulative, an endpoint returns a shape — check the claim against the fixtures or the recorded logs first, the same way a task description's claims are checked. If it holds, say so and relay it; if it does not, say what the data actually shows and let the worker choose the mechanism, rather than passing on a prescription that cannot work.** Applies to: orchestrator prompt, rule 4, alongside the existing rules about what a re-dispatch's instructions may contain.

## 2026-09-18 — overseer-b85-bwp3: shared documentation surfaces are a shared file

Source: batch overseer-b85-bwp3. A batch of nine tasks was split so that each owned its own view file, and their code was genuinely disjoint. Their documentation was not: `CLAUDE.md`, `README.md` and the batches spec each carry an enumeration of which blocks now shimmer, and every task appended its own views to all three. Two approved tasks then had to be re-dispatched purely to re-merge, after siblings landed while they were in review. The reopen notes, quoted verbatim:

> CLAUDE.md, packages/web/src/test/setup.ts

> CLAUDE.md, README.md, docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md

It also produced a content defect, not just a merge cost. A reviewer found:

> appending Review's three spots to the shimmer enumeration broke the sentence that follows it. "Those last three were measured the same way as the first three and land exactly: Needs 128 px …, the Plans list 54 and 165 …, a plan 42 and 868" now reads as Review's list, batch pane and bead pane while listing numbers for Needs, the Plans list and a plan.

- **Documentation surfaces that a repository's conventions say every task must update are a shared file for the rule that chains tasks touching the same file, and are easy to miss because a batch can look parallel on its code while every task updates the same documents: either chain the tasks so each branches from a batch branch carrying the previous task's documentation, or give the documentation update to a single closing task and say so in every other task's description. When appending to an enumeration in one of those documents, read the sentences immediately after it: a list that gains entries can change what a following sentence refers to.** Applies to: orchestrator prompt, rule 2, extending the existing list of what counts as the same file.

## 2026-09-18 — acme-portal-sample-017 (#9333): a removed behaviour is a user decision, not a Known limit

Source: batch acme-portal-sample-017 (#9333), rejected 2026-09-18. The signal, the critic's finding relayed to bead acme-portal-sample-008, quoted verbatim:

> The saved account language is now applied but no longer stored. So when a signed-in person's account language differs from the browser language, every reload first shows the browser language, then switches once the current user loads. Before this change, the first screen already used the saved language. The task's rule may make this acceptable, but the hand-back doesn't mention it. List it as a known limit or decision in the report so the user can accept it or ask for a fix.

And the rejection it led to, quoted verbatim:

> Avoid the language switch on reload for a signed-in person whose account language differs from the browser language. Cache the last account language in this browser under its own localStorage key, use it at boot ahead of the browser languages, and reconcile once the account data arrives.

What happened: the orchestrator carried the finding into the merge-request description as an accepted trade-off. The user rejected the batch and asked for the fix, costing a review round and a re-dispatch.

- **When a review finding or a worker report names a behaviour the previous release had and this change removes or degrades, the orchestrator does not write it into the review note as an accepted limit: it puts the behaviour to the user as a decision with `ask_user` before requesting review, and requests review with their answer. A visible behaviour the change takes away is never a Known limit decided by the orchestrator.** Applies to: orchestrator prompt (rules 5 and 15).

## 2026-09-18 — acme-portal-sample-017 (#9333): the old rule's stored values are part of the change

Source: batch acme-portal-sample-017 (#9333), first rejection 2026-09-17. The signal, quoted verbatim:

> Doesn't seem to work.
>
> navigater.language returns "nl" but even when removing cookies/not having set userPersistentData yet the application is in english (both when logging/logged in) and also on the /signup page (we should take the browser/os languge)

What happened: the new rule (follow the browser when nothing is saved) was correct in the code, but the old `dashboard2-locale` key still held values the app itself had written under the previous behaviour, and those shadowed the browser language on every existing browser profile. Nothing in the bead said what happens to values already stored, and no check ran with such a value present.

- **A bead that changes the precedence or the meaning of a persisted value (a localStorage key, a cookie, a saved account field) names the existing keys in its description, states what happens to values written under the old rule (kept, migrated, or reset once), and its Definition of Done includes one check run with such a value already present. Code that is right on a clean profile is not evidence.** Applies to: orchestrator prompt (rule 2), worker prompt (Definition of Done / verification).

## 2026-09-18 — acme-portal-sample-017 (#9333): account-wide state shares every test that writes it

Source: batch acme-portal-sample-017 (#9333), re-dispatch of bead acme-portal-sample-040. The signal, quoted verbatim from the re-dispatch instructions:

> #9333 makes the profile-panel language switch account-global (ProfileSlideSidebar.vue -> useLocaleSwitcher.changeLocale -> useCurrentUserStore.saveLocale writes locale into userPersistentData), but this spec's switchLanguage(page,'NL') runs on the worker's slot-scoped run account (getE2EUser() -> requireRunUser()) and its afterEach only resets localStorage['dashboard2-locale']. The account-locale watcher in src/stores/data/useCurrentUser.ts:56-68 re-applies the saved 'nl' on every later sign-in and wins over the stored/browser value, so case 2 of this same file (its EN-shape assertions such as expect(en).toMatch(/\.\d{2}$/)) and every later spec on that slot render Dutch and fail. The new spec was run alone, so this was not observed.

- **When a change moves state from browser-local to account-wide (or otherwise onto a shared fixture), the bead description lists every existing test that writes that state, found by grepping the write path, requires running them together with the new one rather than the new one alone, and requires registering the state in the repo's shared-state guard where one exists. A new spec that passes alone is not evidence that the suite still passes.** Applies to: orchestrator prompt (rule 2), worker prompt (verification).

## 2026-09-18 — acme-portal-sample-016 (#9329): a gate that needs a tool goes to a harness that has it

Source: batch acme-portal-sample-016 (#9329), bead acme-portal-sample-042. The signals, quoted verbatim. The reopen note:

> stopped by the orchestrator: The review's main finding needs the Figma MCP, which opencode cannot use (Figma does not approve it as a client); moving this round to claude

and the review finding that round carried:

> The Figma exact-state gate was closed as "Unverified — no Figma tool available", but the Figma MCP is reachable from this worktree. I called get_metadata and get_design_context on both frames in file gqigHZRM1YIMU4xy9jfLYY and got full data

What happened: a bead whose Definition of Done was a Figma exact-state comparison was dispatched to a harness that cannot use the Figma MCP; the worker closed the gate as Unverified, and two further rounds went into re-opening and closing it.

- **A bead whose Definition of Done needs a specific MCP tool is dispatched to a harness that can use that tool (for Figma or PixelLab: `claude`), and the bead says which tool the gate needs. A worker's claim that a required tool was unavailable is checked before it is accepted — the orchestrator calls the tool itself or the next round does — and a gate is never recorded as Unverified on an unchecked claim.** Applies to: orchestrator prompt (rule 3 dispatch, rule 15 results), worker prompt (results block).

## 2026-09-18 — acme-portal-sample-016 (#9329): a fuzzy pixel count under-reports the diff

Source: batch acme-portal-sample-016 (#9329), bead acme-portal-sample-042 review round. The signal, quoted verbatim:

> The pixel-diff counts in REPORT.md, MANIFEST.md and the final message under-report the real deltas: quick-actions is reported as 1,841 px but 6,700 px actually differ, and welcome-card as 3,506 px but 10,185 px differ. `magick compare -metric AE` on this box (ImageMagick 7.1.2-29) applies an implicit fuzz, so it under-counts

- **Evidence that counts changed pixels does not use `magick compare -metric AE`, which applies an implicit fuzz and under-counts. Use a strict difference composite, and report the diff bounding box, which is the claim a reviewer can check, rather than a fuzzy total.** Applies to: worker prompt (evidence block).

## 2026-09-18 — acme-portal-sample-015: a bead that does not converge is not re-dispatched again

Source: an adaptive sidebar update (sample work item #9322), abandoned on 2026-09-18 after 8 tasks, 47 re-dispatches, 41.6 hours and $201.75 of worker cost. Three tasks in that update consumed most of the repeated reviews. One had 15 re-dispatches, another 10 and a third 6. A late-round signal said:

> The code on this branch is believed correct. One thing is missing, and it is the only reason this bead is still open: the live evidence in the 430-1023px band. Four previous rounds each reported a different blocker, and the reviewer has checked them all on thi

- **The orchestrator counts re-dispatches per bead, not per surface. After the third re-dispatch of the same bead it stops and puts the bead to the user: what is left, what it has cost so far, and the choice between splitting it, landing it as it is with `accept_review`, or closing it. Rule 4 already caps three review cycles "on the same surface"; a bead whose rounds move from surface to surface escapes that cap, and that is the one that runs away.** Applies to: orchestrator prompt (rule 4).

## 2026-09-18 — acme-portal-sample-015: a comment-only finding does not get its own round

Source: the same adaptive sidebar update, abandoned on 2026-09-18. Three of six rounds on one task changed nothing but comments. The signals, paraphrased from three re-dispatch instructions:

> Your work is committed on this branch and its behaviour is accepted. One finding is left, and it is documentation only, in the tier docblock of `src/composables/useViewport.ts`.

> Your work is committed and its behaviour is accepted. Two documentation findings remain, both under AC 20. Change no behaviour.

> This is the last round. Make exactly these two comment edits and nothing else. Do not reword any other line.

- **A finding whose whole content is a stale comment, docblock or documentation sentence is not re-dispatched on its own. Collect such findings and hand them to the bead's next round alongside code work, or to one closing documentation bead in the batch. A round costs a worker session; a comment does not earn one.** Applies to: orchestrator prompt (rule 4).

## 2026-09-18 — acme-portal-sample-015: the environment an evidence bead needs is checked before it is dispatched

Source: the same adaptive sidebar update. Five consecutive rounds were spent on missing live evidence, each blocked by a different precondition. The signals, paraphrased from three rounds:

> The backend is reachable now. Capture evidence from the real page at the required width, not a hand-built stand-in. The previous attempt used an ad hoc harness (`C:\Temp\record-flow-harness.ts`) with a bare input instead of the real page, so it did not prove the flow. Change nothing else.

> This round is approved. Capture live evidence using the port registered with the sign-in service; earlier login failures came from using another port. Change nothing else.

> Live responsive evidence for the required width band is still missing. `C:\Workspace\dev\.overseer\evidence\record-list-430\` is empty, so the evidence needs to be captured from the real page.

- **Before dispatching a bead whose Definition of Done includes live evidence, the orchestrator checks the preconditions and names them in the description: whether the backend needs the VPN up, which port the auth realm whitelists (a dev server on any other port cannot sign in), which seeded account the screen needs, and where the evidence must end up. After a round blocked by one of those, the bead is not re-dispatched until the precondition holds.** Applies to: orchestrator prompt (rules 3 and 13).

## 2026-09-18 — acme-portal-sample-015: a finding that says the prescription cannot be built goes to the user

Source: batch acme-portal-sample-015 (#9322 Tablet tier), abandoned by the user on 2026-09-18. Three consecutive rounds re-reported geometry that could not be built. The openings of rounds 13, 14 and 15, paraphrased:

> The requested narrow-screen rail cannot render because the sidebar root stays hidden at the required breakpoint.

> The requested narrow-screen rail cannot render because its parent stays hidden at that breakpoint.

> Live evidence confirms that the rail is absent across the required tablet-width band.

A separate second-round report said:

> The requested mechanism for step 3 / AC 10 cannot work, and the change resolves that unilaterally instead of surfacing it.

- **When a review round reports that the prescription itself cannot be built — a geometry that cannot render, a mechanism that cannot work — the same prescription is not re-dispatched. Verify the claim once, then put it to the user with `ask_user` and re-dispatch only with their new prescription. Repeating a finding that says "this cannot be built" cannot produce anything but the same finding.** Applies to: orchestrator prompt (rules 4 and 21).

## 2026-09-18 — acme-portal-sample-015: when nothing is needed, write nothing

Source: batch acme-portal-sample-015 (#9322 Tablet tier), abandoned by the user on 2026-09-18. The signal, quoted verbatim from the user during the batch:

> In the chat you are outputting reactions/your own thoughts to your own thinking blocks it seems? I don't want to see this in this chat as I'm getting notifications about you saying no response is needed.. If no response is needed I would expect for you to just be silent in the chat

- **This extends the existing entry "chat carries asks, not narration" (docs/lessons.md, 2026-09-16). A notice that needs no action gets no message at all. Lines like "nothing needed from you", "no action required" or an acknowledgement of a notice are themselves notifications on the user's phone; end the turn silently instead.** Applies to: orchestrator prompt (rule 9).

## 2026-09-18 — acme-portal-sample-018: a worker waits for delegated work inside its own turn

Source: batch acme-portal-sample-018. Four workers ended their session with no commits because each dispatched the work to a background agent and returned a promise instead of a result: beads acme-portal-sample-003, acme-portal-sample-041, acme-portal-sample-035 and acme-portal-sample-044 each lost a full worker session plus the review round that discovered HEAD unchanged. The final message of the first, quoted verbatim:

> The implementation work is running in the background with the implementer specialist. I'll report back once it completes.

And the review round on another, quoted verbatim:

> The re-dispatch landed no code. HEAD is still d43b0c98 - the same commit round 2 reviewed - and `git status` is clean ... The worker's final message confirms it only dispatched a background implementer and never collected the result.

- **A worker may delegate work to a background agent, but it waits for the delegated result inside its own turn, verifies it and commits it itself; it never ends a turn while work it started is still running elsewhere, and never ends with a promise to report later. When the delegated work is genuinely too long for one turn, it commits what exists in stages and reports what is unfinished, as the long-command rule already requires.** Applies to: worker prompt.

## 2026-09-18 — overseer-b106-3bfb: a silent Definition of Done forces claude before the worker starts

Source: batch overseer-b106-3bfb "Name the account in session-failure notices", merged 2026-09-18. Both of its beads were dispatched by tier, the tier chose opencode, and the orchestrator then had to stop each worker and re-dispatch it to claude. The 2026-09-18 overseer-b87-wpkx entry already carried the sentence "A task whose Definition of Done is a long, silent command — a slow test suite, a full build — is not dispatched to opencode", but the paragraph that lists the only cases in which the orchestrator may pass `harness` did not include that case, so the rule could only be honoured after the fact, by stopping a worker that had already started. The signals, quoted verbatim from `batch_retrospective`:

> overseer-dlvw, reason `stopped`: "stopped by the orchestrator: Wrong harness for this bead: its Definition of Done runs `pnpm test`, a long silent suite, which the opencode adapter cannot sit through. Re-dispatching to claude"

> overseer-h6nb, reason `stopped`: "stopped by the orchestrator: Wrong harness: this bead's Definition of Done runs `pnpm test`, a long silent suite the opencode adapter cannot sit through. Re-dispatching to claude"

- **A bead whose Definition of Done is a long, silent command — a slow test suite, a full build — is dispatched with `harness: "claude"` and no tier, which is the only way the orchestrator keeps it off opencode before the worker starts. This is an allowed reason to pass `harness` even though the user did not ask for one.** Applies to: orchestrator prompt (`spawn_worker` tool bullet, rule 3 of "How to work").

## 2026-09-18 — overseer-b80-s45y: a wall-clock Definition of Done is measured alone

Source: batch overseer-b80-s45y (merged 2026-09-18; 7 beads, 6 reopens, 26 re-dispatches, $58.78 of worker sessions over 36 hours). Four beads were stopped mid-round so the timing beads could run one at a time, a re-dispatch of overseer-346 resumed under the condition it had been paused for, and two review rounds measured their targets under load and said so. The signals, quoted verbatim from `batch_retrospective`:

> stopped by the orchestrator: Paused at the user's request: the slow-test tasks run one at a time after overseer-1xw lands, because parallel runs overloaded the machine and distorted every timing. No new commits in this round; the review findings stay in the notes for the sequential re-dispatch

> Picking this bead back up. The machine is idle now and you are the only worker running, which is the condition this bead was paused for: earlier rounds measured under load and every timing was distorted.

> The <10s DoD target for this file cannot be demonstrated on this host, and my own three committed-state runs confirm it is not met: 15.60s, 27.89s, 24.95s (6/6 pass each time). ... on this host a bare `git rev-parse` costs 207ms and a worktree add+remove+branch -D cycle 642ms (roughly 5x an idle Windows box)

> My own single runs (correct config, `--mode slow`) under the current load (59 node processes): `plans.test.ts` 10.9 s, `mcp.test.ts` 23.1 s, `app.test.ts` 24.0 s.

- **When a bead's Definition of Done is a wall clock (a timing target, a performance floor, a stability run), its beads are chained with `blocked-by:` and dispatched one at a time, never in parallel, and the bead description says the measurement runs with no other worker on the machine. A number measured while sibling workers run is not evidence, and a review round that measures under load reports the load with the number.** Applies to: orchestrator prompt (how such a batch is split and dispatched), worker prompt (a quoted timing carries the machine load it was measured under).

## 2026-09-18 — overseer-b80-s45y: an account-exhausted review round is not a failed bead

Source: batch overseer-b80-s45y. Three beads (overseer-ht13, overseer-l46t, overseer-qtc5) finished their work, committed it, and then reopened because the review round could not start for lack of an account. An earlier round of overseer-2gv reopened the same way and was re-dispatched to a worker with instructions beginning "Your previous round finished and committed its work; it was reopened only because the review could not run (the codex critic hit its usage limit). Do not redo the work." — a whole worker session spent to re-reach a state the branch was already in, while calling `retry_verification` on such a bead landed it with no worker at all. The reopen reason on overseer-ht13, quoted verbatim:

> no usable account for tier critic: account Work Account: weekly 95% >= 95%; account Secondary Account: weekly 100% >= 95%; codex: usage limit until 2026-09-20T10:18:00.000Z

The earlier reopen of overseer-2gv reported, quoted verbatim:

> Review round failed: the critic session failed: codex exited with code 1

- **A reopen whose reason is an unavailable account or a crashed critic is not a work failure: the commits are already on the bead branch, so it is re-verified with `retry_verification`, never re-dispatched to a worker. Re-dispatch only when the reopen names missing commits, a failed check or a merge conflict.** Applies to: orchestrator prompt.

## 2026-09-18 — overseer-b80-s45y: a bead that depends on a sibling's results gets them quoted, not a pointer

Source: batch overseer-b80-s45y. A bead's description told its worker to "Read their final notes (`bd show` on each sibling)". The worker could not read the notes and trusted a commit instead, dropping work the bead had asked for. The signal, quoted verbatim from the review round on overseer-br7:

> The worker instead kept retrospective and dropped beads.live + restart because it could not read the notes and trusted commit dcd01ac.

- **A bead whose work is decided by what sibling beads recorded never points at their notes: the orchestrator reads those notes and quotes the decisive results verbatim in the description. A worker cannot be relied on to read another bead's notes, and a wrong guess there costs a full review round.** Applies to: orchestrator prompt (rule 2).

## 2026-09-21 — overseer-b103-h7dt: a measured gap is closed on the side the task names

Source: batch overseer-b103-h7dt, bead overseer-6vbt, round 1. The bead asked for one thing: make the Board's loading placeholder model the worst-case wrapping so the reserved height matches what arrives. The worker instead changed the arrived rows to clip their title and branch to one line, which produced a zero delta and truncated both fields on a phone. The signal, quoted verbatim from the review round:

> packages/web/src/styles.css: The zero-delta result comes from changing arrived batch rows to clip the title and branch to one line, which is outside this narrow bead and contradicts its required mechanism: make BoardPlaceholder model the existing worst-case wrapping. The 390 px arrived capture visibly truncates both fields; restore the arrived wrapping behavior and close the measured shift by using placeholder content whose rendered wrapping matches the seeded worst case.

- **When a task measures the difference between two things and asks you to close it, close it by changing the one the task names. A placeholder, a reserve or a fixture moves to fit the product; the product does not move to fit them. Changing what ships so a number comes out right is a regression wearing a passing measurement, and it is reported as a `FAIL` line with the residual rather than made to pass.** Applies to: worker prompt (the layout-measurement bullet).

## 2026-09-21 — overseer-b112-ehut: a test of a real entry point calls that entry point

Source: batch overseer-b112-ehut, bead overseer-0lbo, both rounds. The bead required that holding requests until recovery finishes cannot deadlock the daemon, because recovery posts the notice that starts the orchestrator and the orchestrator's MCP server is that same daemon. Round 1 exempted the hard case from the gate and tested the exemption. Round 2's test posted the wake notice by hand instead of running recovery. The signals, quoted verbatim from the two review rounds:

> packages/daemon/src/app.ts: The ready hook exempts all of `/mcp` and `/mcp/:sessionId`, so MCP calls are still answered before both recoveries finish, contrary to the task: for example `worker_status` can report a session that `lifecycle.recover()` is about to end, and `list_servers` can report a running row that `servers.recover()` is about to stop. The no-deadlock test only proves this blanket bypass; cover the real recovery-notice startup path and hold arbitrary MCP tool calls until recovery completes.

> packages/daemon/src/startup-gate.test.ts: The no-deadlock case at lines 134-156 does not cover the requested recovery-notice startup path: line 150 calls `orchestrator.systemMessage(..., { wake: true })` directly and never calls `lifecycle.recover()`, so it can pass even if the real lost-worker recovery path fails before, during, or after posting that notice.

- **When the property under test belongs to a real entry point, the test calls that entry point. Reproducing its side effects by hand proves only that your reproduction works, and a test that exercises an exemption you added proves the exemption, not the requirement. Seed the state the real path needs and drive it, even when that costs a heavier fixture.** Applies to: worker prompt (the test-subject bullet).

## 2026-09-21 — overseer-b88-lcla: a round that ends with the work uncommitted is a lost round

Source: batch overseer-b88-lcla, merged 2026-09-21. Three signals: a review round that found a whole fix uncommitted, a re-dispatched worker whose fixes never landed, and a reopen with reason `uncommitted_changes` in the sibling batch acme-portal-sample-016. The signals, quoted verbatim:

> overseer-aj7q, review round 3: "This round's entire ghost fix is uncommitted and will be dropped at the merge. `git status` shows four modified files (`packages/daemon/src/bus.ts`, `src/lifecycle/lifecycle.ts`, `src/lifecycle/lifecycle.test.ts`, `src/office/office.ts`) carrying the whole fix"

> overseer-d1zr, review round 2: "The re-dispatched worker's fixes have not landed: the only commits on the branch are the three original ones (dated 00:01-00:03, before the hang), the worktree is clean, and the code is byte-identical to what round 1 flagged."

> acme-portal-sample-006 (batch acme-portal-sample-016), reopen reason `uncommitted_changes`: "modified: docs/product-guide.md"

- **A worker commits each finished piece of work as soon as it stands on its own and never ends a turn with changes in the worktree. Verification runs inside the worktree, so an uncommitted edit passes its checks and is then dropped at the merge; `git status` is checked and reported clean in the final message.** Applies to: worker prompt (the commit bullets and the results block).

## 2026-09-21 — overseer-b88-lcla: a seeded board is wiped by recovery if it is seeded before the daemon starts

Source: batch overseer-b88-lcla, merged 2026-09-21. A live responsive-evidence bead seeded a board before the daemon was up; the daemon's startup recovery ended every session whose pid was not alive, and the capture showed an empty install. The signals, quoted verbatim:

> overseer-ex1z, orchestrator note: "Seeding a live board for evidence: the daemon's startup calls lifecycle.recover() (packages/daemon/src/index.ts, right after listen), which ends sessions whose pid is not alive, then starts the reaper (OVERSEER_REAP_MIN, default 5 min) and the stall sweep (OVERSEER_STALL_MIN, default 15 min). Rows seeded before the daemon starts are ended by recovery; that is why round 2 captured Setup with no repository."

> overseer-ex1z, review round 2: "The required live responsive evidence is still missing. `C:\Workspace\dev\.overseer\evidence\office-tab\` contains only `390.png`, which shows Setup with no repository"

- **A bead whose evidence needs a seeded board seeds it after the daemon is up, runs with `OVERSEER_REAP_MIN=0` and a stall threshold larger than the run, and asserts the seeded state is on screen before any capture. Rows written before the daemon starts are ended by recovery, so a capture taken then shows an empty install.** Applies to: orchestrator prompt (rule 13, next to the live-evidence preconditions), worker prompt (the evidence block).

## 2026-09-21 — overseer-b118-dq6f: a Definition of Done the daemon cannot give before the merge

Source: batch overseer-b118-dq6f ("Workers can use the Figma MCP tools, not only its skills"), merged into main on 2026-09-21 (b6aff25). The batch had 4 tasks, 7 re-dispatches and no rejection or reopen. The task overseer-ylvs changed how the daemon starts a worker session, and its Definition of Done asked for a live proof that a worker session started by the daemon can call a Figma tool and get a result. That proof was not reachable from the task's own worker: the running daemon serves the code on `main`, not the branch under review, so a worker started by it cannot exhibit the branch's behaviour. The requirement cost a review round and was still not met at merge. The review finding, quoted verbatim from the re-dispatch instructions of 2026-09-21T14:44Z:

> [must] The required live proof is still missing: no daemon-started forced-Claude worker was shown with `plugin:figma:figma` connected and no Figma tool was called with a non-secret result shape quoted. The worker explicitly reported this check as NOT RUN, so the task's Definition of Done is incomplete.

What the task did prove, and what a Definition of Done should have asked for: the diagnosis task reproduced the mechanism outside the daemon by running the daemon's exact worker command line by hand, and recorded, quoted verbatim:

> case I, the full worker shape in a `git worktree add --detach` checkout of acme-portal with no account environment ... 0 figma tools. Case J, the same with only `CLAUDE_CODE_OAUTH_TOKEN` added ... 37 tools.

- **In the overseer repository itself, a task whose behaviour is only observable in a session the daemon starts cannot prove it live from its own worker, because the running daemon serves merged code and a restart is manual. Its Definition of Done is unit coverage plus a probe that exercises the mechanism outside the daemon in the shape Overseer uses for real; the live confirmation belongs after the merge and the daemon restart, stated as such in the review note rather than demanded from the worker. This sharpens, and does not replace, the existing 2026-09-15 entry about a daemon fix not being live until a restart and the 2026-09-15 entry about a live proof running in the shape Overseer uses for real.** Applies to: orchestrator prompt (rule 15, alongside rule 23 on the daemon restart).

## 2026-09-21 — overseer-b118-dq6f: an enumeration copied from a review finding is not a grep

Source: batch overseer-b118-dq6f, merged into main on 2026-09-21 (b6aff25). The closing documentation task overseer-vup2 was given the three surfaces the previous review had named; a fourth occurrence of the same sentence existed and the next review round found it, which cost a re-dispatch of a task whose whole content was wording. The finding, quoted verbatim from the re-dispatch instructions of 2026-09-21T21:25Z:

> [should] README.md: README.md:87 ('If a Claude worker or critic reaches its account limit ... otherwise it stays Ready with a Needs entry') carries the same unqualified ending this task fixes, for the same redispatchExhausted path a Claude rate_limit_event takes, so the README still contradicts itself: a forced, tierless Claude worker whose accounts are exhausted does not stay Ready, it starts degraded. Qualify it the same way, or point it at the Accounts paragraph.

The same class showed up one task earlier, on overseer-foq5, where the review found a second README paragraph stating the re-dispatch behaviour incorrectly:

> [must] README.md: The Models paragraph now reads 'Automatic retries after review findings or an exhausted account keep that harness and its recorded model, and reuse the recorded account only while its authorization still refreshes'. For the exhaustion path neither half is true ... The other three surfaces (root CLAUDE.md, packages/daemon/CLAUDE.md, the batches spec) and the README Accounts sentence describe it correctly.

- **When a task corrects a statement about behaviour, the list of places to correct is produced by grepping the repository for the claim itself — the distinctive phrases of what it asserts, in documents, comments and test names — not by copying the locations a review finding happened to name. A reviewer names the hits it saw; the orchestrator names every hit before dispatching, and the task description says which phrases were grepped so a worker can repeat the search. This is the documentation counterpart of the existing entries on enumerating every entry point by grepping the setter and on listing each documentation surface in the description.** Applies to: orchestrator prompt (rule 2, next to the sentences about enumerating entry points and naming documentation surfaces).

## 2026-09-22 — overseer-b120-xflu: a full test suite under parallel workers measures contention, not the change

Source: batch overseer-b120-xflu (task overseer-i5cm, raise the until cap). Four worker sessions and several review rounds were spent on a Definition of Done of two green `pnpm --filter @overseer/daemon test` runs while other workers ran on the same machine. Review round 1 of the second dispatch, quoted verbatim:

> Both of the worker's runs failed, and my own independent run on this HEAD (2580429) also failed: `Test Files 1 failed | 49 passed | 2 skipped (52)`, `Duration 427.24s` (tests 1051.40s cumulative), wall 428.45 s, exit 1, failing at `src/lifecycle/lifecycle.test.ts:2641` ('usage limit: a codex session on an account exhausts that account', `timed out waiting for account exhausted`) — a site that already passes the new `WAIT = 45_000`.

The idle baseline in the same batch was 172.93 s wall. The user's decision on 2026-09-22: "the tests themselves are worth keeping, the way we gate on them is what is burning the money."

- **An ordinary task's Definition of Done names the focused test files it touches and `pnpm typecheck`, never the full daemon suite and never a wall-clock or two-green-runs requirement, because a full run under parallel workers measures contention, not the change. The full suite runs once per batch instead, by the orchestrator, on an idle machine right before requesting review, and that one result goes into the review note; a failure there is investigated on the idle machine, not sent back to a task as a timeout finding. A reviewer runs only the files the change touches, not the whole suite, and reports a timeout in an untouched file as an environment observation, not a finding. A worker given only focused test files does not run the full suite on its own initiative.** Applies to: orchestrator prompt (rule 2, rule 15), critic prompt, worker prompt (results block).

## 2026-09-22 — overseer-b107-4j3t: merge resolutions match the code they land on

Source: batch overseer-b107-4j3t, bead overseer-3ny7. The review signals, quoted verbatim:

> CLAUDE.md and README.md now state a slow-file count the merged code contradicts. `packages/daemon/vitest.config.ts` in HEAD lists two slow files ... the merge correctly took main's two — but the doc paragraphs kept "the fifteen slow ones"

> The batch's re-added tests in this file wait with 5 000 ms caps and the synchronous tmpgit helpers, against main's convention for the same file.

- **A merge-from-base resolution is checked against the code it lands on, not only for conflict markers: every count, file name or claim in a touched document or spec is grepped against the merged code, and every re-added test block uses the file's current helpers and wait constants. Both checks are Definition-of-Done items.** Applies to: orchestrator prompt (rule 20), worker prompt.

## 2026-09-22 — overseer-b107-4j3t: wrappers prove the selection they run

Source: batch overseer-b107-4j3t, bead overseer-y2cd. The review signals, quoted verbatim:

> `pnpm --filter @overseer/daemon test:slow lifecycle` ran in fast mode, reported crash.test.ts, prompt.test.ts and verify.test.ts passing with exit 0, and silently excluded src/lifecycle/lifecycle.test.ts, probe.test.ts, reap.test.ts and retrospective.test.ts

> Any argument containing a space is silently truncated and the run reports green on a different test selection.

- **A wrapper, filter or router for a test or build command proves that it selects the same files and tests as the raw command. Its Definition of Done quotes both counts for the same arguments, including one argument with a space and one filter matching both lists; green on a different selection is a failure.** Applies to: orchestrator prompt (rule 2), worker prompt (results block), critic prompt.

## 2026-09-22 — overseer-b107-4j3t: wider autonomy is a user decision

Source: batch overseer-b107-4j3t, bead overseer-qx1m. A round-one finding asked to "add an actor-aware GitLab merge operation"; the user answered, quoted verbatim:

> Huh? The orchestrator should not automatically merge gitlab batches, those should always be under my control

- **A finding that would widen autonomous authority to merge, approve, delete or publish is put to the user with `ask_user` before re-dispatch, not relayed as an instruction; repository approval mode is the user's setting.** Applies to: orchestrator prompt (rule 4), critic prompt.

## 2026-09-22 — overseer-b107-4j3t: a critic never yields while a check runs

Source: batch overseer-b107-4j3t, bead overseer-y2cd. The critic's only finding, quoted verbatim:

> [must] Waiting on the slow daemon suite (`pnpm --filter @overseer/daemon test:slow`) to finish — I'll submit the review once it reports.

- **The critic runs checks in the foreground with bounded timeouts and never ends its turn to wait. Its verdict contains only completed findings; a waiting status is not a defect.** Applies to: critic prompt; orchestrator prompt rule 4 already classifies such a round as not a defect.

## 2026-09-22 — acme-portal-sample-022: an exported change sweeps every caller

Source: batch acme-portal-sample-022, bead acme-portal-sample-010, review round 2. The finding, quoted verbatim:

> The change breaks three tests in two specs it never touched or ran ... These are the only two other changeLocale call sites; the spec sweep missed them because they are not in the diff.

- **For every exported function, composable, component prop or type whose signature, timing or default changes, grep every caller, run every caller's spec, and list both in the final message. A diff-only spec sweep is not a sweep, and the orchestrator names this Definition-of-Done item.** Applies to: worker prompt, orchestrator prompt (rule 2).

## 2026-09-22 — acme-portal-sample-020: setup follows dependency changes from the base

Source: the acme-portal-sample-020 retrospective. The pre-review full run failed on a missing `analytics client` module after the base changed `package.json` and the lockfile following the merge-from-base bead.

- **After a merge-from-base bead lands, re-run the repository setup command in that worktree before the pre-review full suite when the base changed `package.json` or the lockfile. A module-not-found result before setup is an environment result, not a finding.** Applies to: orchestrator prompt (rules 15 and 20).

## 2026-09-22 — user: add lessons to the open lessons batch

Source: user feedback on 2026-09-22, quoted verbatim:

> wouldn't it be a better idea to bundle them together instead of creating separate batches? That way we avoid merge conflicts and save tokens + $$$ as we don't have to spawn multiple beads/agents for this.

- **While a lessons batch is open, add new lessons to its bead or to one chained bead after it. Open another lessons batch only when none is open.** Applies to: orchestrator prompt (Retrospective rules 3 and 4).

## 2026-09-22 — user: definitions and reviews cover unhappy paths

Source: user feedback after three manual rejections of MR 8433, quoted verbatim:

> We should make sure we don't only enforce the happy paths in all test/verify steps so we don't run into this issue anymore and catch this in the review rounds, not from my manual testing

> This applies to every managed repository.

- **Every Definition of Done, evidence bead and review names the applicable blank or empty, zero, new or placeholder, removed, duplicate, maximum, and user-visible count or label states, with one assertion or live read-back each. Evidence walks those states on the real screen and the critic tries them.** Applies to: orchestrator prompt (rules 2 and 13), worker prompt, critic prompt.

## 2026-09-22 — acme-portal-sample-021: consumer enumeration needs an effect assertion

Source: batch acme-portal-sample-021, second rejection. The user signal, quoted verbatim:

> The summary shows zero items for a new category, but its default record should always count once because the system creates it.

- **A consumer enumeration closes an entry only with an assertion showing the new kind's effect on that consumer. “Reads the same source, no change needed” is not evidence.** Applies to: orchestrator prompt (rule 2), critic prompt.

## 2026-09-22 — overseer-b117-zgdc: measure an unreproduced defect before naming its mechanism

Source: batch overseer-b117-zgdc, bead overseer-rug7. The review and orchestrator signals, quoted verbatim:

> The prescribed regression mechanism cannot occur on the comparison base: `packages/web/src/office/labelLayout.ts` already returns `[]` when either stage dimension is non-positive (line 179), and the base already tests the `{0,0}` case. This branch changes tests only, and the new remount test passes against unchanged production code, so none of the required tests fails on the current code and the reported defect has not been reproduced or fixed

> Four dispatches and three review rounds have all argued about a test for the frame clamp, while the defect the user reported has never been measured

- **When a user-reported defect has not been reproduced, the first bead measures named values, props, loop state or geometry and forbids product changes. A code-read mechanism is an unverified lead, not the test target; the later fix bead quotes the observed numbers.** Applies to: orchestrator prompt (rule 2).

## 2026-09-22 — acme-portal-sample-020: enum reuse enumerates every switch and lookup

Source: batch acme-portal-sample-020. The bead text, quoted verbatim:

> `recordType` stays DEFAULT, and `hasFixedTotal` distinguishes the two cases.

- **When a new kind reuses an enum value plus a flag, the description lists every site found by grepping the enum type and each value, including `Record<Enum, ...>` lookups, and says whether the new kind renders, labels or behaves like the old value at each site. The reviewer checks the same grep.** Applies to: orchestrator prompt (rule 2), critic prompt.

## 2026-09-22 — acme-portal-sample-020: evidence reaches the real consuming screen

Source: batch acme-portal-sample-020. The worker notes and user rejection, quoted verbatim:

> Keep the import dialog and the records step in their current layout. Show only the new problem reasons in the existing problem list.

> E2E Case 1 and Case 2 I did not run in this session

> Why does the import preview show the same category twice? Should the first row show the configured total instead?

- **When a story changes what a file, message or payload carries, evidence pushes the changed artefact through the real screen that consumes it and captures that screen. For an import file this is upload plus preview table; a cell-by-cell file check is not screen evidence.** Applies to: orchestrator prompt (rule 13).

## 2026-09-22 — acme-portal-sample-018: background subagents die with the headless turn

Source: batch acme-portal-sample-018. The worker final messages, quoted verbatim:

> The implementation work is running in the background with the implementer specialist. I'll report back once it completes.

> `setup-records.spec.ts` looks like the pattern I need. Let me read it.

> I've asked the verification agent for the detailed breakdown; I'll wait for its reply before continuing to the write-up step.

- **A worker never runs an Agent tool in the background and never ends its turn to wait for a subagent, reply or event: `end_turn` ends the headless session and its background tasks. A subagent runs in the foreground; a verify-only status line is no result and is re-dispatched with the single-thread constraint.** Applies to: worker prompt, orchestrator prompt (rule 17). This extends the 2026-09-18 background-session lesson with the Agent-tool case.

## 2026-09-22 — acme-portal-sample-018: a new list kind enumerates every secondary reader

Source: batch acme-portal-sample-018. The user rejection, quoted verbatim:

> Why does this category and default-record setup still download an empty spreadsheet instead of a prefilled one?

- **When a bead adds a kind to a screen or list, its description enumerates every path found by grepping the list's prop and getter names that reads it for exports, downloads, templates, imports, summaries or totals, and states whether the new kind is included, excluded or handled another way. The reviewer checks the same grep.** Applies to: orchestrator prompt (rule 2).

## 2026-09-22 — acme-portal-sample-022: a check that gates a pipeline job runs with that job's variables

Source: batch acme-portal-sample-022 (MR 8442 rejected). The signal, quoted verbatim from the pipeline trace:

> [check-bundle-budget] Total gzip size: 2129938 bytes (budget: 2124000 bytes) ... Total gzip size exceeds budget: 2129938 bytes; budget is 2124000 bytes.

The CI build job uses an output path based on the deployment environment. In the deployed environment, an analytics key adds a large analytics chunk. Local checks used the default build command, so they did not match the pipeline job.

- **A check that also gates a pipeline job (a build, a budget, a lint) is run with that job's variables read from `.gitlab-ci.yml`; a local run under other variables is not evidence the job passes.** Applies to: orchestrator prompt (rule 15), worker prompt.

## 2026-09-22 — overseer-b125-pvip: a stale Definition-of-Done command is fixed before dispatch

Source: batch overseer-b125-pvip. The signal, quoted verbatim from overseer-c1v6's parked review:

> [must] The required Definition-of-Done command `pnpm --filter @overseer/daemon exec vitest run --mode slow src/lifecycle/lifecycle.test.ts` cannot pass on the requested merged configuration: `vitest.config.ts` slow mode includes only `src/beads/beads.live.test.ts` and `src/daemon-restart.integration.test.ts`, so the command exits 1 with no test files found.

The same stale command sat in four more bead descriptions and needed correction notes.

- **Before dispatching a bead, the orchestrator checks that each Definition-of-Done command still selects what it names in the current configuration (a test file in the named mode, a script that exists), and fixes the description rather than adding a note.** Applies to: orchestrator prompt (rule 2).

## 2026-09-22 — overseer-b125-pvip: a case the new rule leaves as it is is described as unchanged

Source: batch overseer-b125-pvip. The signal, quoted verbatim from overseer-d9z9's round 2:

> [must] ... A hard bead still lands after a clean or should-only first round because the successful-round path calls `reviewsAgain`, which explicitly returns false for `tier === 'hard'`. The task requires hard beads to receive every round up to `repo.review_rounds`

The description had said "hard bead: `repo.review_rounds` rounds, all on `critic`" meaning today's behaviour, and the user landed it with the finding open.

- **When a bead's new rule leaves a case as it is, the description says "unchanged: <today's behaviour in one sentence>" instead of restating that case as a number or a new-sounding rule.** Applies to: orchestrator prompt (rule 2).

## 2026-09-23 — acme-portal-sample-020: a bead's counting rule is checked against the user's stated principles

Source: batch acme-portal-sample-020. The user on sibling MR 8438, a bead's specification, and the user's later decision, quoted verbatim:

> The count should always be one because the system creates a default record.

> A default record with every amount blank counts as zero items.

> Always include the default record.

- **Before a bead's description fixes a user-visible counting or behaviour rule, check it against principles the user already stated on the same subject in this batch or a sibling batch (their rejections and chat), and `ask_user` before dispatching a spec that contradicts one.** Applies to: orchestrator prompt (rule 2).

## 2026-09-23 — acme-portal-sample-020: a fixture seeds the value the real caller passes

Source: batch acme-portal-sample-020, the review of bead acme-portal-sample-011. The finding, quoted verbatim:

> The zero-value branch cannot be reached through the actual caller. The caller converts both zero and blank totals to null before passing them, so the test fixture used a value the application never produces.

The test passed only because its fixture used a value the host never produces.

- **A fixture that seeds a value another component passes in uses the value grepped from that component's call site; a value the real caller never produces is not coverage even when the test passes.** Applies to: worker prompt (the test-subject bullet, next to the real-entry-point rule).

## 2026-09-23 — acme-portal-sample-020: a test-file rewrite accounts for every removed assertion

Source: batch acme-portal-sample-020, the re-dispatch of bead acme-portal-sample-043. The instructions, quoted verbatim:

> Your rewrite replaced 336 lines with 184. Before you finish, diff your file against the version at the merge base and account for every assertion that disappeared: restore it, or name it in your final message with the reason it no longer applies.

- **A worker that edits an existing test file diffs it against the merge base before finishing, and every assertion the diff removes is restored or named in the final message with the reason it no longer applies.** Applies to: worker prompt (the Definition-of-Done / verification guidance).

## 2026-09-23 — overseer-b132-dimb: a transient UI state names its start, its end and the event orders its tests cover

Source: batch overseer-b132-dimb, five re-dispatches over three review cycles on bead overseer-gnsz (the Board action pending state) and the follow-up bead. The bead description said when the pending state starts ("within one frame") but not which event ends it, nor which event orders the tests must cover, so each review round found the next order. The signals, quoted verbatim from overseer-gnsz's review rounds:

> [must] packages/web/src/views/TaskPane.tsx: The pane treats a 202 as the end of the pending UI: `act` clears `pending` and sets `ack`, whose `!ack` guards remove the pressed button even while `pending_action` still reports a running job

> [must] A 409 can leave a target permanently disabled when its short running job finishes before the board fetch ever samples `pending_action`

> [must] ... If `action_result` arrives before the 202 is read, `whenJobEnds` invokes `settleAck` synchronously after `showAck`

- **A bead that adds a transient UI state (pending, loading, optimistic) names in its description the event that starts it, the event that ends it (for example the job's result, not the HTTP acknowledgement), what the user sees when it ends in failure, and the event orders the tests cover (result before acknowledgement, result before any refresh, a refresh that fails, a reload while pending).** Applies to: orchestrator prompt (rule 2).

## 2026-09-23 — acme-portal-sample-021: a branch's behaviour is checked against every touched story's acceptance criteria

Source: a category-rename update affecting item allocations (sample work item #9341) was rejected on 2026-09-23. The signal, paraphrased (rejection 4):

> The review found that an import changed how an existing category with a configured total of zero was sized, contrary to the earlier requirement to preserve that total and block excess items. A zero total is set and must remain set; a blank total can still be inferred from the file. The review also found no test for renaming a category with no allocations, and one verified criterion was missing from the review note.

After the earlier change merged into the base, a follow-up update changed the zero-total behavior and a later review note dropped a verified criterion. The branch went to the user with both issues uncaught; the user asked for each acceptance criterion to be checked.

- **Before requesting review, fetch the batch's story and every story whose code the branch changes (including stories merged in from the base), quote each one's current acceptance criteria, and give each a verdict against the branch with the test that covers it; a changed behaviour that contradicts an acceptance criterion goes to the user as a decision, and every acceptance criterion the first review note verified stays in the rewritten note.** Applies to: orchestrator prompt (rule 15).

## 2026-09-23 - overseer-b137-zfnw: an automatic recovery names its event orders

Source: batch overseer-b137-zfnw, "Survive Claude token rollovers without a re-login" (merged 2026-09-23 as 53055e9): 5 beads, 6 re-dispatches, 128 minutes and $14.38 of worker sessions. Two beads added automatic recovery, overseer-9p1k (the orchestrator resumes its session on a fresh token) and overseer-k72n (workers and critics resume once instead of parking the account), and neither description named the event orders around the recovery, so review rounds found them one surface at a time: 3 re-dispatches for 9p1k, and 2 for k72n. The signals, quoted verbatim from the review findings:

> [must] packages/daemon/src/orchestrator/orchestrator.ts: A proactive rollover can end a process with earlier deliveries still pending. If a notice or user message arrives after the account refresh while an earlier turn is running, `deliver()` takes the `tokenRollover` restart path; Claude's `end()` closes stdin and kills the process after 10 seconds, while `session:ended` clears `turns` without replaying them. A long-running earlier turn is lost from the native session and never retried.

> [must] packages/daemon/src/orchestrator/orchestrator.ts: Auth recovery refreshes the failed session's account in `recoverAuthFailure()`, but then clears `sessionId` and calls `deliver()`, which selects `settings.orchestrator().account` again. If the session started on a fallback account and the configured account has become usable, the native session resumes under a different account

> `settleWorker` computes `stopped` but attempts auth recovery before honoring it. If a user or orchestrator stops a worker after its `auth_failed` event, the ended event carries the stop yet this path starts a new worker and returns, undoing the requested stop.

> The one-resume guard is only the in-memory `authResumed` set. After a daemon restart adopts a still-running auth-resumed worker, or recovers a critic round, that set is empty; another 401 triggers another resume instead of parking, violating the one-resume limit.

> An `auth_failed` event without a subsequent `turn_end` cannot use the required same-native-session resume on a worker's first turn. The manager writes `native_session_id` only from `turn_end`

- **A bead that adds an automatic recovery (a retry, a resume, or a replay after a failure) states in its description, before dispatch: the session and account it recovers on; where its once-only guard lives, so that the guard survives a daemon restart and re-adoption; that a stop from the user or the orchestrator wins over it; the first-turn case before any turn end; and what happens to work still pending in a process it restarts. Its tests cover each of those event orders.** Applies to: orchestrator prompt (rule 2).

## 2026-09-23 — acme-portal-sample-021: check a data state is reachable before guarding it

Source: a data-import update (sample work item #9341) merged on 2026-09-23. It took 14 tasks, four rejections and nine re-dispatches. A rule for an existing category with a zero configured total was implemented and verified, but the live-check task could not create that state because the form requires a positive total. The rule then changed after another decision round. The signals, paraphrased:

> An import into an existing category with a zero total must preserve that total and block excess items. A blank total can still be inferred from the file.

> Check: live import, configured total zero - BLOCKED - the form requires a positive total, so setup cannot create this state.

> The zero-total rule is being removed: the imported file now supplies the total, so this live check no longer applies.

- **Before a bead builds or changes behaviour for a specific data state (a 0 total, an empty list, a missing field), check that the product can produce that state: the form's validation schema, the API, or an import path. Quote that check in the description. A state the product cannot produce goes to the user as a question before any bead guards it.** Applies to: orchestrator prompt (rule 2).

## 2026-09-23 — acme-portal-sample-022: verify beads say what PASS means

Source: a verification task ran a full integration suite to answer whether the branch added a failure. Its description did not say that failures already present on the development branch count as a pass. The worker marked the result as FAIL, so the task reopened and needed a re-dispatch to report the comparison correctly. Signal, quoted verbatim:

> acme-portal-sample-004 reopened: verification-only result is incomplete; the following Check: lines did not PASS:
> > Check: e2e regression (branch) - FAIL - 294 passed / 10 failed / 9 skipped / 11 did not run

In the same message, every one of the 10 per-failure lines read `PASS - pre-existing on dev (...)`.

- **A verify-only bead whose checks compare against a baseline states, for each `Check:` line, what makes it PASS; for example, PASS when no failure is branch-only and pre-existing failures are listed, not failed.** Applies to: orchestrator prompt (rule 17).

## 2026-09-23 — overseer-b140-ft5s: probe a bare CLI before relying on it

Source: batch overseer-b140-ft5s (Discussions, merged 2026-09-23 as 377ff52): 9 beads, 11 re-dispatches, $41.33. The eval bead overseer-y9d2's description said "The CLIs run on their own logins; never read or write the live accounts table." OpenCode's own CLI login has no model provider; Overseer supplies it through the api_key account. So run C got a blank OpenCode answer, the eval scored a two-model run as the three-model discussion, and it cost a review round and a re-run. Signal, quoted verbatim from the review:

> [must] packages/daemon/scripts/discussion-eval.ts: Run C never received an OpenCode answer: run-C.json has no OpenCode turn, and the report says its round-1 blank response excluded it. The script still scored its two-model synthesis as C and report.md declares 'NOT WORTH IT', although the specified three-model run did not happen. With the available OpenCode login/model, the requested C mechanism did not work; report this as an incomplete comparison rather than a verdict on three models.

- **A bead that runs a harness CLI outside the daemon (a probe, an eval, a script) states where that CLI's credentials and model come from, and requires a one-line probe per harness that must answer non-blank before the real run. A CLI's own login is not assumed to match what Overseer's accounts give it.** Applies to: orchestrator prompt, rule 2.

## 2026-09-23 — acme-portal-sample-023: evidence shows the whole screen a link opens

Source: a mobile list and details update (sample work item #9283) was rejected on 2026-09-23. The evidence captured only the detail header after "Open details"; it did not show the rest of the destination screen. The review note assumed a full desktop page, but the phone page body was blank. Signal, paraphrased:

> The details section is blank. Is that expected?

- **When a change adds or rewires a way into another screen (a button, link or route), the evidence captures the whole destination screen as the user lands on it, at each width that is checked, and the review note describes what that capture shows. It never describes what the code is expected to show. A destination this change doesn't build is named in the review note, with what the user sees there today.** Applies to: orchestrator prompt (rule 13 on evidence, rule 15 on review notes).

## 2026-09-23 — overseer-7yrh: merges on Windows keep files UTF-8

Source: batch overseer-b142-l4rv (Office page, merged 2026-09-23 as 2e6c835). Bead overseer-7yrh merged `main` into the batch branch and resolved a `CLAUDE.md` conflict, but the resolution garbled the file's encoding. The review round's finding, transcribed with mis-decoded sequences shown as Unicode code points:

> The merge resolution garbled the text encoding of the `packages/web` bullet: every em dash, arrow, ellipsis, middle dot and curly apostrophe now shows as a mis-decoded sequence ("—" became U+00D4 U+00C7 U+00F6, "→" became U+00D4 U+00E5 U+00C6, "…" became U+00D4 U+00C7 U+00AA, "·" became U+252C U+00C0, "’" became U+00D4 U+00C7 U+00D6). Neither parent has this

It cost a re-dispatch.

- **On Windows, a worker writes or resolves files through the Edit/Write tools or a Node script, never through PowerShell `Set-Content`/`Out-File`/`>` without an explicit UTF-8 (no BOM) encoding. After resolving a merge conflict, it greps touched files for mis-decoded sequences with `\x{00D4}\x{00C7}|\x{00D4}\x{00E5}|\x{252C}\x{00C0}` and confirms zero hits.** Applies to: worker prompt.

## 2026-09-24 — overseer-b149-m7fd: a tool limit is a finding, not a reopen

Source: batch overseer-b149-m7fd ("Chat opens at the latest message", merged 2026-09-24 as 01ce0d4). The verify-only measurement bead overseer-i1t6 measured a set of mobile layout cases; four `Check:` lines reported a case Playwright cannot drive at all. The reopen, quoted verbatim:

> the following Check: lines did not PASS:
> > Check: webkit dpr3 no-banner touch/wheel 0-arrivals - FAIL - Playwright: `Mouse wheel is not supported in mobile WebKit`; touch drag did not scroll

The other 28 cases were measured and were enough to write the fix. The bead reopened only because its description asked for an input the tool could not drive, and it was then closed by hand: "the only 4 non-PASS lines are touch-scroll cases that Playwright can't drive in mobile WebKit, and re-running would give the same result".

- **A measurement bead's description says how to report a case the tool cannot drive (`Check: <case> - PASS - not drivable: <tool error>`), so a tool limit is recorded as a finding instead of a non-PASS `Check:` line that reopens the bead.** Applies to: orchestrator prompt (rule 17).

## 2026-09-24 — overseer-b149-m7fd: jsdom cannot test scroll geometry

Source: the same batch; the finding the measurement bead produced, quoted verbatim:

> a measured `delta` of −2 or −3 failed the `>= -1` cleanup check, left `readThrough` at 50, and counted 100 or 102 unread on return.

The unit tests had all passed because, in jsdom, `scrollTop`, `clientHeight` and `scrollHeight` are all 0, so `scrollTop + clientHeight >= scrollHeight - 1` is always true there. The defect reached the user on an iPhone.

- **Scroll-position or geometry logic (at-bottom checks, `scrollTop`, element sizes) is not covered by jsdom unit tests alone, since jsdom reports 0 for every layout value; a change to it adds or extends a real-browser layout test (this repo's `test:*-layout` scripts) and asserts the measured values.** Applies to: worker prompt.

## 2026-09-24 — acme-portal-sample-023: align comparison evidence in one table

Source: the same mobile list and details update (sample work item #9283) was rejected on 2026-09-24. The review said comparison images were useful but scattered and misaligned, and suggested one standard layout. Signal, paraphrased:

> I like what the agent did by putting the comparisons side by side. Sometimes it seems the formatting is not correct though as it is not side by side but scattered and not aligned.
>
> Can we make tihs more standard/fix it? Maybe adjust the template in the write gitlab mr skill so it is enforced/standardized.

- **The review note puts each comparison in one Markdown table, with one row per width and state and the same width attribute on every image. It does not put images in bullet lists or inline runs, where the hosting service wraps them unevenly.** Applies to the repository merge-request template.

## 2026-09-24 — acme-portal-sample-023: audit every Figma frame element

Source: the same mobile list update (sample work item #9283) was rejected on 2026-09-24. A design parity review reported no gaps, but the built row was missing its trailing icon. Signal, paraphrased:

> The list row is missing its trailing icon.

- **A design parity audit lists every frame element, including icons, chevrons and dividers, as present or absent in the build. An absent element outside the accepted deviations is a gap, so a round cannot report zero gaps while one is missing.** Applies to the repository parity-check instructions.

## 2026-09-24 — acme-portal-sample-024: a decided change proceeds after a failed reproduction

Source: batch acme-portal-sample-024 (bundle budget raised to 5 MB), merged 2026-09-24. The user had already decided to raise the gzip budget. The bead also required reproducing an MR 8450 lint failure, but the worker treated reproduction as a gate and stopped before making the decided change. Signal, verbatim from the reopen note:

> Pipeline 9150830's failures did not reproduce. [...] No named root cause supports a change based on these runs, so I stopped before editing. The 5 MB change, lint, and build were not run; no commit was created.

- **When the user has already decided a change, reproduction of a reported failure is a finding to report when the description says so, not a gate. Stop after a failed reproduction only when the proposed change is derived from that failure; when the description states the user's decided change, report the non-reproduction and make the change.** Applies to: orchestrator prompt (rule 2) and worker prompt (reported-failure rule).

## 2026-09-24 — managed repository rules live with the repository

Source: user feedback after rejecting the prompt changes, 2026-09-24. Signal, quoted verbatim:

> I have an observation to make. Currently to fix these problems you are adjusting the worker/orchestrator prompts which is fine, but how are we handling the agentic instruction in that repo? Because otherwise this will only be fixed for me and not the team, how are we handling this? Are we then even going through/using the skills defined in that repo?

- **A lesson about a managed repository's work belongs in that repository's own instruction files, updated through a bead in that repository, so the team gets it. Only orchestration and worker-mechanics lessons go into this repository's prompts; workers read the repository's root and touched-directory `CLAUDE.md` and `AGENTS.md` files and read each `.claude/skills/` name and description, following every skill whose description matches the task, whatever harness runs them.** Applies to: orchestrator prompt (rule 13 and Retrospective item 3) and worker prompt (repository instructions and skills).


## 2026-09-24 — overseer-b159-nkp7: verify prescribed CLI flags before dispatch

Source: batch overseer-b159-nkp7, re-dispatch of overseer-xqca (2026-09-24). Signal, quoted verbatim:

> [must] packages/daemon/src/git/provider.ts: The source-only lookup passes `--state opened`, but `glab mr list` has no `--state` flag. `glab mr list --help` on the installed glab 1.117.0 lists only `--all`, `--closed` and `--merged`, and says it 'Defaults to open merge requests'. glab rejects the unknown flag, so openMr throws and every stacked batch with no stored mr_url fails to land. The bead description the orchestrator wrote said: "look the MR up by source branch alone (`state opened`) before creating".

- **Before dispatch, verify every CLI command and flag prescribed in a bead description against the installed CLI's `<cli> <subcommand> --help` or a read-only dry run, and quote the checked flag in the description. Workers also check each CLI invocation they add to code against the installed CLI's help and name the `--help` output checked in the final message.** Applies to: orchestrator prompt, rule 2; worker prompt.

## 2026-09-24 — acme-portal-sample-023: report a wrong CLI prescription as a prescription error

Source: batch acme-portal-sample-023, reopen of acme-portal-sample-048 (2026-09-24). Signal, quoted verbatim:

> Check: glab api --method POST projects/42/uploads -F file=@<path> - FAIL - 401 on the default host, then HTTP 400 with --hostname gitlab.example.com; uploaded through the same API with curl -F instead. The orchestrator had prescribed that `glab api ... -F file=@<path>` upload command in the bead description. Its own memory already recorded that uploads go through `curl`. The reopen then cost two more worker sessions (see `overseer-hpe1`'s false-fail count: "acme-portal-sample-048 (reopen 1) | The prescribed `glab api` upload was written as FAIL, although the same upload through `curl -F` worked").

- **Before using a prescribed CLI command or flag, check it against that installed CLI's help. If the prescription is wrong, report it as a wrong prescription and give the working equivalent, rather than recording the task as failed; use `Check: <prescribed command> - PASS - prescription wrong: <why>; ran <working command> instead`.** Applies to: worker prompt, beside the `Check:` line rules.

## 2026-09-24 — overseer-b160-s2cz: probe code-produced strings

Source: batch `overseer-b160-s2cz`, re-dispatch of `overseer-0gmn` (2026-09-24). Signal, quoted verbatim:

> [must] packages/daemon/src/lifecycle/mrWatcher.ts: The jobs endpoint is built as `${location.endpoint}/pipelines/<pid>/jobs?per_page=100`, i.e. `projects/<p>/merge_requests/<iid>/pipelines/<pid>/jobs`, which is not a GitLab API route (GitLab exposes `projects/<p>/pipelines/<pid>/jobs`). In production every jobs read would 404, so failed and warning notices never fire and the watcher retries forever. The probe used `projects/42/pipelines/9150838/jobs`, not the watcher's shape, so it did not catch this. Build the endpoint from the project path, not the MR endpoint. Then update the test that asserts the MR-scoped path, and re-probe with the exact string the code produces.

- **A live probe of code that builds a command, URL or query runs the exact string the code produces: printed from the code path itself (a debug export or the function's return value), never a hand-typed equivalent. The final message quotes that string. A unit test that asserts a built external path checks it against a real sample of the external API's route, not against the code's own output.** Applies to: worker prompt and orchestrator prompt (rule 2).

## 2026-09-24 — acme-portal-sample-025: out-of-repository failures go to the user

Source: an integration-suite update (sample work item, MR 8456) was merged on 2026-09-24. The user rejected a report that left several failures as known limits and asked whether the tests should be skipped until the external services support the flows. The relevant failures and request, paraphrased:

> Several integration tests still fail for reasons outside the repository. One upload is blocked by a storage service CORS rule; two reservation flows are unsupported by the backend or have no eligible records. The report should ask whether to skip each test, explain the cause and state when it should be enabled again.
>
> A browser upload is blocked by the storage service CORS policy for the application origin. The storage settings need to allow that origin.
> One reservation request is not supported by the current backend.
> Another reservation request fails because there are no eligible records for the owner.
>
> Should these checks stay disabled until the service supports the flow? Add a comment with the reason and what must change before re-enabling them.

- **When a batch's goal is a passing check (a CI job or suite) and failures remain whose cause is outside the repository (a backend that does not support the flow yet, or a bucket's CORS rules), the orchestrator does not request review with those failures written as Known limits. It first puts each one to the user with `ask_user`, asking whether to skip it with a comment that names the cause and when to re-enable it, following the repository's own workaround convention, or leave it failing; then it requests review with the user's answer.** Applies to: orchestrator prompt (rule 15).

## 2026-09-24 — acme-portal-sample-026 (#9363): every locale and wording variant is worst case

Source: a mobile summary-card layout update (sample work item #9363) took 12 tasks and 14 re-dispatches. The final parity check ran four times because each round covered too few wording variants. The first run captured one locale; each later run found another. The signals, paraphrased:

> **Finding:** at the narrow phone width, a translated label wraps to two lines and makes the summary card taller than the comparison card.

(second run, head 8a01770d)

> The third run still found a mismatch: the first language was fixed, but the other language and the alternate record type were not.

> **Alternate record type:** its translated labels wrap at narrow widths and increase the card height.

- **Every shipped locale and every data-driven wording variant count as worst-case content. The first parity or evidence run and every layout fix measure each caption and value in all variants at every required width, so a fix is never specified or checked for only one locale.** Applies to the orchestrator evidence rule.

## 2026-09-25 — overseer-fczf: a harness passed with a tier stays on that harness

Source: the user's decision "A" on 2026-09-25. PixelLab art needs Claude, the only harness whose sessions load the PixelLab MCP tools, at high effort or more; `harness` alone took the standard tier's `claude opus low`, and `harness` with `tier` could land on another harness.

- **To force a CLI at a tier's strength, call `spawn_worker` with both `harness` and `tier`: the daemon resolves only among that tier's candidates of that harness and refuses the dispatch with `no usable <harness> candidate in tier <tier>` when none is usable, and every retry keeps both. `harness` alone still scans the standard, chore and hard tiers.** Applies to: orchestrator `spawn_worker` tool bullet and rule 3.

## 2026-09-25 — acme-portal-sample-027: list every input path for a text field change

Source: batch `acme-portal-sample-027` (#9364). Signals, quoted verbatim:

> [must] `src/components/ui/AppNumericField.vue`: in integer mode with `groupThousands`, typing a value normally must keep working. Today, typing 1,0,0,0 shows "1,000", and the next "0" leaves "1,0000". `normalize()` splits that into ["1","0000"], sees a malformed group and emits "1,0000" as invalid. Deleting one digit from "150,000" (giving "150,00") and inserting a digit in the middle of a number fail the same way.

> Finding to fix ([must], verbatim): "When a grouped integer value already has a separator, replacing it with malformed digits-plus-separator input can silently turn that text into another number: with locale `nl-NL` and model `10000` (`10.000` displayed), replacing the value with `1.5` takes the `groups.every(...) && separators <= displayedSeps` branch and emits `15`. Preserve this replacement/paste as invalid text and add a regression starting from an already grouped value."

> [must] src/components/ui/AppNumericField.vue: The one-character text-diff heuristic also regroups one-character pastes or drops, although the chosen behavior requires malformed pasted/dropped text to stay invalid. For example, starting from grouped `1,234,567` and pasting `9` after `1,2` produces `1,2934,567`, which this code treats like a typed digit, emits `12934567`, and reformats as `12,934,567`; the handler ignores `InputEvent.inputType`.

- **A bead that changes how an input field reads, reformats or validates what the user enters lists every input path as a Definition-of-Done case with a test driven by real input events, not a whole-value set: typing key by key, deleting, inserting mid-value, pasting and dropping (whole and partial), replacing a selection, and each shipped locale's separators, each starting from an empty and from an already formatted value.** Applies to: orchestrator prompt (rule 2, the edge-state sentence).

## 2026-09-25 — user chat: documentation-only overlaps run in parallel

Source: the user's chat on 2026-09-25 (no batch). This supersedes the documentation part of the earlier entry "Beads of one batch that touch the same file are chained with `blocked-by`" (line 89). The signal, quoted verbatim:

> Question, do we HAVE to chain/hold one bead until another bead is fiinshed just for simple .md file changes? Would rather have the work be done in parallel and fix ocnflicts later

- **Beads that overlap only on documentation (including Markdown other than prompt files) are dispatched in parallel, not chained. When one reopens on a merge conflict in those files, re-dispatch it with instructions to merge the batch branch, keep both sides' text, and read the sentences around each resolved hunk.** Applies to: orchestrator prompt (rule 2).

## 2026-09-26 — overseer-b183-fsh6: delete unused PixelLab art after its batch

Source: batch `overseer-b183-fsh6` (Pixi office layout 2). The user's signals, quoted verbatim:

> Please remove the rejected character-art candidates when the work is complete.
>
> There are unused character assets in the external art workspace. Please clean them up after the related work is complete.

The unused character and object assets were deleted after the work was complete; no task or prompt rule had required removing rejected generations.

- **After a batch that generated PixelLab art is merged or abandoned, delete every PixelLab character, object and animation it made and did not use with the PixelLab MCP tools, but only when its repo `SOURCE.md` files or evidence notes record each item's id as not used; never delete an item those records do not identify as not used. Keep those candidates until the batch is merged or abandoned, since a review round could still choose one.** Applies to: `packages/daemon/prompts/orchestrator.md`.

## 2026-09-26 — overseer-b187-gh45: check present-day description claims against code

Source: batch `overseer-b187-gh45`. The review finding on `overseer-nuqg`, quoted verbatim:

> [must] packages/web/src/office/agentManager.ts: The folder never appears for a real critic session: `officeModel.reconcile()` assigns new sessions through `assignSpot()`, whose `DESKS` list includes only `run` and `orch` spots, so no critic can be seated at a `review` meeting-table seat. `readingFolderItems()` only draws for agents already assigned to those seats; route critic sessions to the requested meeting seats before this feature can work in the Office.

The orchestrator note on `overseer-w7s9`, quoted verbatim:

> monitors-orch.png shows only the monitors' backs, so it is treated like monitor-back: unchanged, no monitors-orch-off.png, no orchestrator off/on tests. The description was wrong to list it.

- **Before dispatch, check a bead description's claim about how the product behaves today (who is seated where, which art or state exists, or what a function returns) against the code that produces it, and quote the file and line checked in the description.** Applies to: orchestrator prompt (rule 2).

## 2026-09-26 — overseer-b187-gh45: reject merge markers before commit

Source: batch `overseer-b187-gh45`. The review finding on `overseer-1ni3`, quoted verbatim:

> [must] CLAUDE.md: The merge commit leaves conflict markers in CLAUDE.md (lines 13, 15 and 17): the Focused tests bullet appears twice, once per side. Resolve it by keeping only the HEAD version, which already includes main's text plus the test:office-strip-layout sentence, and delete the markers and main's copy.

- **Before committing a merge or conflict resolution, run `git grep -n -E '^(<<<<<<<|=======|>>>>>>>)'` over the whole tree, resolve every hit, and quote the empty result in the final message.** Applies to: worker prompt (merge and conflict guidance).

## 2026-09-26 — overseer-b185-bbur: ask user questions through the tool

Source: batch `overseer-b185-bbur`. The user's signal, quoted verbatim:

> "Also when you ask me a question always use askquestion"

- **Every question to the user, including "should I ...?" at the end of a proposal, goes through `ask_user`; never ask a question in a chat reply.** Applies to: `packages/daemon/prompts/orchestrator.md`, `ask_user` tool entry.

## 2026-09-26 — overseer-b185-bbur: keep selected animations on the character

Source: batch `overseer-b185-bbur`. The review finding, quoted verbatim:

> [must] The selected working pose is saved only as a gallery asset, not on the target character. This misses the requirement to keep each selected animation on the character for reuse; generate the typing animation on that character and update the source table with its animation identifiers.

- **`animate_with_skeleton_v3` output is not attached to a character; when an animation must live on the character, interpolate between the skeleton frames with `animate_character` (v3) on that character instead.** Applies to: `.claude/skills/pixellab/SKILL.md`, seated typing guidance.

## 2026-09-27 — overseer-b195-cpah: baseline loaded test files

Source: batch `overseer-b195-cpah` (merged 2026-09-27; 1 bead, 3 re-dispatches, $7.61 of worker sessions, 353 min). The signals, quoted verbatim from `batch_retrospective`:

> [must] The Definition of Done is not met, and the worker says so. Neither file passed 5 consecutive full-file runs under the 16-busy-loop load.

> [must] packages/daemon/src/harness/codex.test.ts: The required five consecutive loaded runs of this file did not pass: all five had at least one unrelated failure. [...] The target orphan cases passed, but the loaded-file DoD remains unmet; resolve or explicitly disposition these non-target failures before landing.

- **Before dispatching a bead whose Definition of Done requires a whole test file to pass N runs under load or another stress condition, run each file once on the base under that condition and list every failing test. Give each baseline failure its own bound in scope, or make the Definition of Done name only the target tests; never pair a whole-file pass requirement with "do not change other tests".** Applies to: orchestrator prompt.

## 2026-09-27 — acme-portal-sample-029: suite branch matches deployed base

Source: batch `acme-portal-sample-029` (merged 2026-09-27 as !8466). Signals, verbatim from the reopen notes:

> Round 5 on `e13d755d` fails on one test, and the cause is new this round: `dev` moved to `56c8b1e5` and alpha is now ahead of the branch.
>
> Both failures happen only because alpha serves a newer `dev` than the branch has, not because of anything on the branch.

- **Before a suite runs against an environment deployed from its base branch, fetch the base and merge it into the batch branch if it moved; otherwise newer base specs or app changes can look like branch failures.** Applies to: orchestrator prompt.

## 2026-09-27 — acme-portal-sample-029: long remote suites watch network health

Source: batch `acme-portal-sample-029` (merged 2026-09-27 as !8466). Signals, verbatim from the reopen notes:

> I think the failure and most of the flakes came from a network drop during the run, not from the branch.
>
> this run can't tell a network problem apart from a real failure.
>
> The monitor recorded zero failed probes across 50 checks for each of the application host, identity service and backend API.

- **During a long suite against remote hosts, probe every host every 30 seconds with a logged 10-second timeout for the whole run, and count connection errors in the log. Repeat a run with network errors instead of diagnosing tests one by one.** Applies to: orchestrator prompt.

## 2026-09-27 — overseer-b197-hpsi: measure the test's reporter duration

Source: batch `overseer-b197-hpsi` (merged 2026-09-27; 2 beads, 1 reopen, 1 re-dispatch). Signals, verbatim:

> Idle: 4.582 s, 4.136 s, 3.991 s.
>
> Under the specified 16-thread load: 4.012 s, 4.073 s, 4.154 s, 4.326 s, 4.052 s.
>
> The test already runs at 4.0 to 4.6 s against the 5 s limit, even idle
>
> the verbose runs showed the test itself takes 287–298 ms idle and 414–574 ms under the load recipe. The 4–6 s figures from round 1 were the whole run's Duration line, not the test.

- **Read a test's duration from its own reporter line (add `--reporter verbose` when needed), never from the run's `Duration` line, which also counts startup, transform, setup and collection.** Applies to: worker and orchestrator prompts.

## 2026-09-28 — overseer-b202-6kvl: helper reports and progress lines reach the chat

Source: batch `overseer-b202-6kvl`. Signal, quoted verbatim:

> Why are you putting all of this information into this chat?

- **Look things up with your own search and read tools. A helper agent's final report reaches the user's chat in full, so use a helper only when the search is too wide to do yourself and cap its report at about 100 words. Progress lines between tool calls ("I'm checking ...") are status recaps too and are not posted; keep the one-line note before a call expected to take over a minute.** Applies to: orchestrator prompt.

## 2026-09-28 — overseer-b208-ccap: score gates audit the committed head

Source: batch `overseer-b208-ccap` (CLAUDE.md audit, $27.00, 5 re-dispatches). Signals, verbatim:

> [must] The third fresh audit scored `CLAUDE.md` 88/100, `packages/daemon/CLAUDE.md` 85/100, and `packages/web/CLAUDE.md` 82/100, all below the explicit 90-point target. Commits `a76222cf` and `acfbb0c2` changed the docs after that audit without a fresh report, so the submitted state lacks the required passing final audit
>
> This merge commit's second parent is e4b62a54, while current main is 0f10d054; `git merge-tree --write-tree main HEAD` still exits 1.

The second signal is a missed existing rule, not a new one: another batch was merged into main while the merge-from-base bead was in flight, which the orchestrator prompt already forbids ("While a merge-from-base bead is in flight, merge nothing else into the base").

- **When a Definition of Done is a score or a critic verdict (an audit grade, `OFFICE-CRITIC` must/should counts), the final scoring run is of the committed head, with no commit after it, and the final message quotes that run with its head sha.** Applies to: orchestrator and worker prompts.

## 2026-09-28 — overseer-b204-pssb: captures prove production assets

Source: batch `overseer-b204-pssb` (office polish, 8 tasks, $84.78, 5 re-dispatches). Signals, verbatim:

> for the office refactor (pixel art) how come when I look at the evidence I see the old pixel characters and not the new ones? ... Did you polish the wrong ones?
>
> the fixture page replaced `fetch` for every address, so Pixi's request for `/office/pixi/characters.json` got a 404 error body. `loadOfficeArt` then logged `office sprite atlas TypeError`, and every character fell back to the blocky `charCanvas` placeholder.

Every capture and every critic verdict on characters, across six tasks, was taken on placeholder art. No gate checked that the capture rendered production assets.

- **A visual gate (screenshots, a critic, parity) first proves that the capture renders production assets: no fallback or placeholder art, no 404 for an asset in the console. The capture fails otherwise.** Applies to: orchestrator prompt (Evidence section) and worker prompt.

## 2026-09-28 — overseer-b204-pssb: critic gates match the task's scope

Source: batch `overseer-b204-pssb` (office polish, 8 tasks, $84.78, 5 re-dispatches). Task overseer-421w was told to keep the camera framing rules unchanged, but its gate was `/office-critic layout` with must=0 and should=0. Signal, verbatim:

> These are reported as camera/stage findings, while this task requires the camera framing rules and QA/meeting seats to remain unchanged, so the acceptance criteria conflict.

Task overseer-suzd was similar: its phone-zoom finding came from the same framing rule. Each cost a re-dispatch and an orchestrator decision.

- **A critic or score gate is scoped to what the task may change. The description lists the areas a documented rule keeps unchanged, and findings there are reported as out of scope, not counted against the gate.** Applies to: orchestrator prompt (description rules).

## 2026-09-28 — overseer-b214-boak: prefer the CLI with usage headroom

Source: batch `overseer-b214-boak`. Signals, verbatim:

> The user: "Make sure to split the usage between harnesses, cause you're burning use it very fast"
>
> The worker's reopen: "account Secondary Account hit its usage limit (five_hour)"
>
> The automatic re-dispatch of that and four other forced-claude beads: "no usable claude candidate in tier standard: account Work Account: weekly 96% >= 95%; account Secondary Account: exhausted until 2026-09-28T15:20:00.000Z"

This supersedes the earlier adapter-failure lesson's default to Claude.

- **When an explicit CLI is needed, choose another CLI with usage headroom that fits the work. Use Claude only when it is the sole fit or the user or a Claude-only MCP tool such as Figma requires it; forced harnesses keep their pin on automatic retries.** Applies to: orchestrator prompt (`packages/daemon/prompts/orchestrator.md`, `spawn_worker` harness rules).

## 2026-09-28 — programs-track-multi-story-fan-outs: a program for related stories

Source: batch `programs-track-multi-story-fan-outs` (bead `overseer-lmtk`), after a multi-story fan-out whose cross-batch order, shared-work owners and the user's decisions lived only in the orchestrator's context. Signal, quoted verbatim:

> for multi fan out work like this would it make sense to create a higher level plan to keep track of things/decisions?

- **A request of three or more related stories, or any cross-batch dependency, gets a program: its batches, lanes and waits recorded with the program tools, the owner of each piece of shared work logged as `ownership`, and the merge order set. Every user decision about the program is logged verbatim as a `decision`. A batch that depends on another is created at once and added with `after_batch_id` instead of waiting in the orchestrator's memory, and its beads are dispatched when the release notice arrives. The merge order is followed, and the review note names the program.** Applies to: orchestrator prompt. To stay inside the 33,600-character cap, the same change shortened existing sentences and dropped two that repeated another rule (the `claude` routing of a long, silent Definition of Done, already in the `harness` cases; "Tell the user which batch to merge first" on a held batch, already in Overlap and merge readiness) and one example.

## 2026-09-28 — overseer-z5ay: cache descriptions name file changes

Source: batch `evidence-page-loads-fast` (bead `overseer-z5ay`). The description and review finding, quoted verbatim:

> Description: "Cache the per-folder summaries, keyed on each folder's mtime (or recomputed in the background), so a repeat load is instant."

> Review: "[must] packages/daemon/src/api/evidence.ts: Cache freshness checks only descendant directory mtimes (lines 210–219), which do not change when an existing file is rewritten or its mtime changes."

- **A description that prescribes a cache or freshness key names each change the key must detect (a file added, removed, or rewritten in place), with a test for each.** Applies to: orchestrator prompt (Description rules).

## 2026-09-28 — overseer-4p27: preserve rule scope when shortening a prompt

Source: batch `programs-track-multi-story-fan-outs` (merge bead `overseer-4p27`). The same compression also occurred in beads `overseer-86pk` and `overseer-zg3c`. The review finding, quoted verbatim:

> The new wording forbids any commit in such a bead and addresses the upload step to no one. That drops a clause, which the task forbade.

- **A worker that shortens a prompt keeps each rule's subject, object and scope, never adds a second version of a rule beside the original, and quotes every changed sentence before and after in its final message.** Applies to: worker prompt.

## 2026-09-28 — acme-portal-sample-030: budget repeated harness eval calls

Source: batch `acme-portal-sample-030` ("CLAUDE.md audit with claude-md-improver"; merged 2026-09-28 as MR !8467). Signals:

> The skills audit ran skill-creator trigger evals with no call budget: 1,680 `claude -p` calls on `opus`, and should-trigger queries fired in 73 of 840 runs.
>
> Its task reopened twice with "account Secondary Account hit its usage limit (five_hour)". The user then answered, verbatim: "1 and make sure the evals are not taking a lot of usage".
>
> With 6 queries per description, 1 run each on `sonnet` and a cap of 100, the last pass used 86 calls.

- **A bead that runs a harness CLI repeatedly (evals, probes, benchmarks) states the call budget, runs per query and model, and requires the worker to count calls and stop at the budget.** Applies to: orchestrator prompt (`packages/daemon/prompts/orchestrator.md`, Description rules, next to the harness CLI rule).

## 2026-09-28 — acme-portal-sample-030: preserve the user's target over a round cap

Source: batch `acme-portal-sample-030` ("CLAUDE.md audit with claude-md-improver"; merged 2026-09-28 as MR !8467). Signals:

> The user asked, verbatim: "Fix anything that gets reported until a high score."
>
> The bead capped the work at 3 re-audits, and the worker stopped below the goal.
>
> [must] The task's headline goal is unmet: on the committed head 763016e six units still score below grade A
>
> The orchestrator had to write: "the user's goal (fix until a high score) wins over the orchestrator's 3-re-audit cap". After one more audit, three units were still below A and went to the user.

- **When the user states a target, any round or re-audit cap is a cost stop: if reached below the target, report what remains and what it cost to the user; never report the task as done.** Applies to: orchestrator prompt (`packages/daemon/prompts/orchestrator.md`, Description rules, score or verdict Definition of Done).

## 2026-09-29 — overseer-b212-64i4: store user references and name them in gates

Source: a character-art update (merged 2026-09-29; 11 re-dispatches, worker cost $132.96). The review signals, paraphrased:

> [must] The target character could not be checked against a stored reference image, so the worker compared only the written design notes and the shipped frames.
>
> A reference image had been shared in the conversation but was not saved under a named path, so it had to be requested again later.
>
> [must] The day comparison showed palette drift from the requested character designs: characters A, B and C each differed from their documented palettes.

- **A reference supplied in chat (a portrait, screenshot or design export) is copied at once to a named path outside the repository under the evidence folder. Every task whose gate compares against it names that path. A gate that requires a likeness or palette names the check that proves it, such as a side-by-side comparison or color values per region.** Applies to the orchestrator evidence section.

## 2026-09-29 — acme-portal-sample-031 (#9356): evidence beads capture the MR table inputs

Source: a mobile transaction-list update (sample work item #9356, MR !8470; 9 re-dispatches, worker cost $95.92). Signal, paraphrased:

> Why was the evidence table not used? The formatting is off; does the review template specify it?

- **Before dispatching an evidence bead in a repo whose MR skill defines an evidence layout, read that layout and have the bead capture and upload everything it needs (Figma exports, every width and locale column). Write the review note from the repo's MR template, not from memory.** Applies to: orchestrator prompt (`packages/daemon/prompts/orchestrator.md`, Evidence section and review-note rule).

## 2026-09-29 — [sample run]: keep private details out of committed files

Source: [sample run], 2026-09-29. Signal, paraphrased:

> A tracked note included private project details; replacing them with stand-ins kept the example useful without exposing those details.

- **Nothing committed to this repository may name the user, their employer, or a managed repository's host, or contain product or customer text, account names, email addresses, home paths, or likeness references. Replace those details with fictional stand-ins. The daemon test scans tracked files against a local denylist outside the repo and reports a skip when the file is absent.** Applies to: root `CLAUDE.md`, worker and orchestrator prompts, README and the daemon privacy guard.

## 2026-09-29 — sample-batch: preserve another author's issue description

Source: sample-batch. Signal, paraphrased with stand-ins:

> The user rejected the MR after a change replaced a teammate's issue description. Restore the original text, then put the specification in a comment or a new related story; have the MR close that new story so the user can move the original bug to QA.

- **A bead that writes a story for an existing issue checks the issue's author. If the user did not author it, create a new story linked with `relates_to` (or comment on the original), never replace its description, and have the MR close the new story.** Applies to: orchestrator prompt, Description rules.
- **Never replace or rewrite an issue or MR description written by someone else; add a comment or a linked issue instead, and stop and report if the task says otherwise.** Applies to: worker prompt.

## 2026-09-29 — final parity and story-criteria reports

Source: the 2026-09-29 review improvements for per-width Figma evidence and story acceptance criteria. Signals, paraphrased:

> Reviews repeatedly found parity measured against an earlier commit, missing widths or frame-level scores, partial evidence links, and acceptance-criteria tables rebuilt during review.

- **A Figma parity or live-capture task names its widths and, when needed, locales; its worker reports every upload with a full URL before per-frame, per-width, per-locale scores measured on final `HEAD`.** Applies to: orchestrator description rules and worker results block.
- **A story task that names acceptance criteria requires one verdict and covering-test row per criterion in the worker's results, and the review note reuses that table.** Applies to: orchestrator description and review rules; worker results block.

## 2026-09-29 — local evidence paths and percentage scores

Source: a local review held by evidence-format checks on 2026-09-29. Signal, paraphrased:

> The report used local capture paths and percentage scores, but the gate only accepted upload links and plain numeric scores.

- **When a task has no upload target, report each existing evidence file with a caption at an absolute path outside the worktree; parity scores may be percentages.** Applies to: worker and orchestrator prompts; evidence gate.

## 2026-09-29 — sample-site: framework version, MCP naming and toolchain

Source: retrospective for batch `sample-site-b1`, 2026-09-29. Signals, quoted verbatim:

> "Instead of Nuxt 3, can't we use Nuxt 4? You can get the latest docs via context7 ?"
>
> The bead descriptions said "Check APIs with context7 (`/nuxt/nuxt` v4, `/websites/content_nuxt`)". The worker reported: "The local Context7 tool isn't exposed here, so I verified the Nuxt Content query and SQLite connector APIs against the official Nuxt Content docs". The user asked: "how can we stop this from happening in the future?"
>
> "Out-of-scope build changes came with the Home work: the Content connector is switched to `node:sqlite`, `better-sqlite3` is dropped, `.npmrc` adds a project-wide `omit=peer`, and `engines.node` is lowered from `>=22.19.0` to `>=22.13.0`. That floor now advertises Node versions Nuxt 4.5.2 itself rejects (`^22.19.0 || ^24.11.0 || >=26.0.0`)."

- **Before beads scaffold a project on a framework named in a spec or handoff, check its current major version in Context7 or the framework's release notes. If the named version is older, ask the user which version to use before creating beads.** Applies to: orchestrator prompt, Description rules.
- **Name an MCP tool in a description only if the bead goes to a harness that has that tool; otherwise name the documentation source directly, such as a URL.** Applies to: orchestrator prompt, Description rules and harness selection.
- **A local toolchain failure, including a native module that does not build or an unsupported runtime version, is an environment reason. Report its exact error; do not change dependencies, `engines` or package-manager configuration to get past it unless the task asks for that change.** Applies to: worker prompt, results block.

## 2026-09-29 — sample-site: own server port per run

Source: `sample-site` parallel browser runs, 2026-09-29. Signals, quoted with the repository name replaced by a stand-in:

> "`npm run test:e2e` - FAIL - `32 failed` / `12 passed (2.1m)`: port 5200 is held by another worktree's dev server (`sample-site-hnu\...\nuxi.mjs dev --host 127.0.0.1 --port 5200 --strictPort`), and `reuseExistingServer` sent the tests to it"
>
> "the config reuses the server already on 127.0.0.1:5200, which is another session's build (31 of 44 failed against it)"
>
> "We should make sure this becomes an overseer instruction (when possible use different ports per worker/agent)"

- **Each server a worker starts uses a free or task-named port, and tests and captures use only the server that worktree started. Override pinned or reused test-server ports and report the port and its empty pre-run listener check.** Applies to: worker prompt.
- **When a repo pins a browser-test port or reuses an existing server, create a repo bead for per-run ports before parallel browser work; name the interim override in every browser bead.** Applies to: orchestrator prompt.

## 2026-09-29 — sample-site: submit the verdict and supply allowed task-count sources

Source: retrospective for `sample-site`, 2026-09-29. Signals, quoted with private references replaced by stand-ins:

> Review complete. I verified the CV content against all the profile screenshots (experience, education, skills, languages), confirmed the four development-role descriptions match the site's YAML verbatim, checked that the design tokens/fonts referenced in `cv/cv.html` exist and are correctly gated for light theme via `emulateMedia`, and confirmed the `@fontsource` packages are real dependencies. Everything matched except one flagged item: the education section's order deviates from the order given in the task and from the profile's own display order — the worker already surfaced this as a decision needing confirmation, so I reported it as a `should` finding rather than blocking the merge.

The critic made no `submit_review` call; its session log had no `mcp__overseer__*` tool call, although its init message listed `mcp__overseer__submit_review`. The daemon recorded the final text as a `[must]` finding and re-dispatched the worker onto approved work; this extends the 2026-09-17 entry “review findings live only in the critic's final message”.

> task counts from `bd` in each managed repository, read-only

> Check: bd task counts - NOT RUN - my rules say not to run bd; the task count comes from the database worktrees and batches tables

- **If `submit_review` is not loaded, load it before giving the verdict; never end the turn without that call or claim a finding was reported, submitted or recorded unless the call returned.** Applies to: critic prompt, How to finish.
- **A description never tells a worker to run `bd`, because workers are forbidden to; give the counts yourself or name a read-only source the worker may use.** Applies to: orchestrator prompt, Description rules.

## 2026-09-30 — sample-site: copy that lives in two places

Source: retrospective for `sample-site`, 2026-09-30. Signal, quoted verbatim:

> "Also about my feedback on the about section this means you should also adjust the CV"

The About paragraph lived in the site's content file and in the CV source, which builds a committed PDF. The task named only the content file, so the user had to name the CV too.

- **When a request changes user-facing copy, grep the repo for the old text's distinctive phrases, including sources of generated files such as a PDF or an image. The task description lists every place the copy lives, or says why a place stays unchanged.** Applies to: orchestrator prompt, Description rules.

## 2026-09-30 — acme-portal-sample-032: a breakpoint-change criterion covers every state of the view

Source: the retrospective of a phone-wizard batch in a managed repository (22 tasks, 41 re-dispatches, worker cost $830). The story's criterion "the wizard survives a breakpoint change" was covered only for a step page going phone to desktop and back; the entry chooser, which opens before any step, broke in the desktop-to-phone direction. The user's rejection, paraphrased with product names removed:

> When I start in desktop and open this modal and change my window width size to be on the mobile breakpoint I get this.

- **A criterion that a view survives a breakpoint change lists every state the view can be in when the width crosses — the entry chooser or sheet, each page kind, open prompts, busy, error and success — in both directions, each with its own test. A step page alone does not cover a view whose entry chooser opens before any step.** Applies to: orchestrator prompt (`packages/daemon/prompts/orchestrator.md`, the responsive-layout rule in the Evidence section).

## 2026-09-30 — acme-portal-sample-032: count a Figma evidence matrix before dispatching it

Source: the same retrospective. The last evidence task was re-dispatched 15 times at about $333 before the user capped it; the design had 182 frames, so the matrix was about 730 live captures for one task. The critic's finding, verbatim apart from product names:

> [must] The whole-flow evidence matrix is still incomplete and does not satisfy the exact-state comparison gate: inspected Rights captures show both switches off and no Days against Figma's switches on/Days=10, while Import Result has three differently allocated rows against four. Reconcile the full screen/state inventory, upload the required Figma/430 EN/390 EN/360 EN/360 NL rows with matching populated data and interactions, and record measurements/deviations before retaining the parity scores.

The same task was also sent back because its captures were taken before later commits:

> Parity line ... SHA "d610a31d" does not match head ...

- **Before dispatching Figma evidence, count the captures (frames or states times the live columns). Above about 50, ask the user the scope with the count and the cost of the last comparable pass, then split into tasks of bounded size (for example one per flow). Each description names the fixture data that reproduces each frame's state, and captures run in a verification-only task after the last code commit, so the parity SHA is the head.** Applies to: orchestrator prompt (`packages/daemon/prompts/orchestrator.md`, Evidence section).

## 2026-09-30 — overseer-b233-2k3w: answer the user's question before setup work

Source: batch `overseer-b233-2k3w` retrospective, 2026-09-30. The user's signal during the batch, quoted verbatim apart from the repository name:

> Also sometimes when I send you a message like when I asked you about the [sample-repo] evidence you take a long time to respond why? Is it cause you're thinking about the task I gave you? Would it be an idea that for exploratory work you spin a cheap model first and act on it's findings (if incomplete you do it yourself)?

What happened: a rejection also carried a direct question ("why didn't the evidence pass before?"), but the orchestrator read task notes, checked code, and wrote four task descriptions and a lessons batch before replying to it. The question waited behind all of that.

- **When a user message holds a direct question and also asks for work, answer the question first, in a line or two from what is already known, then do the setup work. A helper subagent is only worth it for a search too wide to do directly, since its report reaches the chat.** Applies to: `packages/daemon/prompts/orchestrator.md`, Chat section.
