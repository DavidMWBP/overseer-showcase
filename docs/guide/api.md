# API and run inspection

## Scripting the API

Everything the UI does is plain REST on the daemon, plus a WebSocket at `/api/events` for change notices. The socket also carries the office view's feed: an `office` message per session state change (`walking_in`, `working`, `verifying`, `reviewing` or `leaving`, with the session's role, harness, configured model and the resolved model its CLI reported, account label, bead and its title, batch, repository and `stalled_since`, the ISO time a session was marked stalled or null). Every socket that connects also gets one `office_snapshot` carrying the whole current set — empty when nothing is running — so a view draws the running work at once and can tell an empty office from one whose set has not loaded yet; the snapshot replaces whatever the view held. The socket also sends a one-shot `office_milestone` message `{ type: 'office_milestone'; kind: 'verify_passed' | 'verify_failed' | 'review_ready' | 'merged'; repo_id: string; batch_id: string | null; bead_id: string | null; at: string }`. A verify result fires only when its command ran; `review_ready` fires when a batch is handed to the user for review; `merged` fires when a batch merges into its base. `at` is the event time in ISO format. The milestone is never included in the connect snapshot or replayed.

The read-only evidence API serves files from the configured data directory's `evidence` folder, beside `overseer.db` (by default, `~/.overseer/evidence`).

```bash
# setup
curl -s http://127.0.0.1:4400/api/doctor
curl -s http://127.0.0.1:4400/api/repos
curl -s -X POST http://127.0.0.1:4400/api/repos -H 'content-type: application/json' \
  -d '{"path":"/path/to/repo","id":"myrepo","verify_command":"pnpm test","beads":"stealth"}'
curl -s http://127.0.0.1:4400/api/repos/myrepo/commands # [{name, description, kind: command|skill, source: repo|global}]
curl -s -X PATCH http://127.0.0.1:4400/api/repos/myrepo -H 'content-type: application/json' -d '{"worker_limit":3}'
curl -s -X DELETE http://127.0.0.1:4400/api/repos/myrepo

# board and chat
curl -s http://127.0.0.1:4400/api/board
curl -s http://127.0.0.1:4400/api/status
curl -s -X POST http://127.0.0.1:4400/api/chat -H 'content-type: application/json' -d '{"repo":"myrepo","text":"..."}'
curl -s http://127.0.0.1:4400/api/chat
curl -s -X POST http://127.0.0.1:4400/api/chat/answer -H 'content-type: application/json' -d '{"question_id":1,"text":"..."}'
curl -s -X POST http://127.0.0.1:4400/api/chat/dismiss -H 'content-type: application/json' -d '{"question_id":1}'
curl -s -X POST http://127.0.0.1:4400/api/orchestrator/reset

# one bead
curl -s http://127.0.0.1:4400/api/tasks/myrepo-3
curl -s -X POST http://127.0.0.1:4400/api/tasks/myrepo-3/interrupt      # Stop worker
curl -s -X POST http://127.0.0.1:4400/api/tasks/myrepo-3/verify         # Retry verification
curl -s -X POST http://127.0.0.1:4400/api/tasks/myrepo-3/redispatch     # Re-dispatch
curl -s -X POST http://127.0.0.1:4400/api/tasks/myrepo-3/close -H 'content-type: application/json' -d '{"note":"not needed"}'

# one batch
curl -s http://127.0.0.1:4400/api/batches/myrepo-b1-k4tq
curl -s -X POST http://127.0.0.1:4400/api/batches/myrepo-b1-k4tq/merge
curl -s -X POST http://127.0.0.1:4400/api/batches/myrepo-b1-k4tq/reject -H 'content-type: application/json' -d '{"note":"..."}'
curl -s -X POST http://127.0.0.1:4400/api/batches/myrepo-b1-k4tq/abandon

# one multi-story program: grouped batches, bead counts, waits, entries and merge order
curl -s 'http://127.0.0.1:4400/api/programs?repo=myrepo'
curl -s http://127.0.0.1:4400/api/programs/my-program-id

# usage
curl -s 'http://127.0.0.1:4400/api/usage?from=2026-09-01&to=2026-09-17&group=model,account'

# evidence
curl -s http://127.0.0.1:4400/api/evidence
curl -s http://127.0.0.1:4400/api/evidence/batch-id
curl -s http://127.0.0.1:4400/api/evidence/batch-id/screenshots/phone.png
```

`POST /api/repos` fills in defaults for anything omitted: `id` defaults to the folder name, `base_branch` to the current branch, `merge_mode` to `local-merge`, `batch_approver` to `user`, `worker_limit` to 2, and `beads` to `stealth`. `beads` is `stealth` (default) or `commit` and only matters when the repository has no `.beads/` yet.

A refused action answers 400 with the reason (`bead <id> is busy: …`, `batch <id> is merged`), a merge conflict answers 409 with the conflicting files, and every unhandled 500 is written to `daemon.log`.

## Inspecting runs

`GET /api/sessions?bead_id=|repo=` lists worker sessions; `GET /api/sessions/:id/events` returns one session's event log (with `?after=<seq>`, only the events newer than that sequence, which the Trace view uses for live updates), and the harness's raw stdout and stderr are in `~/.overseer/sessions/<session id>.log` and `.log.err`. The Board's card pane has a **Trace** button that opens the last session's events under the pane — one row per event with the raw JSON behind a disclosure and a link to the endpoint — and follows a session that is still running. An OpenCode worker's `task` sub-agent shows up in that trace while it runs, its tool calls and finished texts appearing as their own trace rows while the task call is still running, and its file edits count as the session's changed files. `GET /api/costs` totals spend per repository and per batch; `GET /api/usage?from=&to=&group=` sums reported and estimated dollars, tokens by kind and sessions over a day range (default the last 30 days), with a per-day series and breakdowns by model, account, harness, repo and batch; each dollar total is a floor and carries the count of sessions that reported no such figure. The daemon's own log is `~/.overseer/daemon.log`, one JSON object per line. A stored `tool_result` is capped at 16 KB (the byte count beyond it is recorded as `truncated_bytes`), since a tool result is over 90% of the events table and every reader clips far shorter.
