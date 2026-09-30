# Plan gate

> Historical design from 2026-09-16. The current app shows needs-you items in a strip above Office, and a cold plan link returns to Office; see `2026-09-13-batches-speed-ui-design.md` for the current UI.

Status: implemented, 2026-09-16.

## Why

Today a request goes straight from chat to work: `create_batch`, then beads, then `spawn_worker` (orchestrator prompt, How to work
rules 1–3). A request that was understood wrongly is only noticed once workers have spent tokens and a review round has
found the result. The plan gate puts one human checkpoint in front of that flow: when the user says to plan it out, the
orchestrator proposes the work as a plan, the user reads and edits it on one page, and only an approved plan becomes a batch
with beads.

The chat is not the place for this. It renders plain prose only (prompt rule 11), so a list of steps arrives as raw
characters, and a plan is a list.

## Decisions

- **The trigger is the user's words, not a setting.** When the user asks to plan something out, the orchestrator calls
  `propose_plan` instead of `create_batch`. A per-repo "always plan" flag is not part of this design; it is one column to add
  if the phrase turns out to be typed every time.
- **The plan is its own record, created before any batch.** `createBatch` cuts a branch and creates a worktree at once
  (`lifecycle.ts`), so a batch in a "planning" status would leave both behind for a plan the user then discards. A plan
  touches no git state and no bd state until it is approved.
- **A step has exactly the fields a bead needs** — title, description, dependencies — and approval creates the beads from
  those fields. What runs is generated from what was approved, not written again afterwards.
- **The user edits the plan in place**, on one page. Reviewing a plan by opening one bead card after another was rejected as
  poor UX.
- **The plan opens on its own page**, `#plan/<id>`, reached from the Needs view and from its chat notice. It is not a tab.
- **Discarding a plan costs nothing**: no branch, worktree, bead or batch exists to clean up.

## Data

New table, created with `CREATE TABLE IF NOT EXISTS` in `src/db/schema.ts` (`ADDED_COLUMNS` is for columns on existing
tables):

```
plans (
  id          TEXT PRIMARY KEY,       -- '<repo>-p<n>'
  repo_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  steps       TEXT NOT NULL,          -- JSON: PlanStep[]
  status      TEXT NOT NULL,          -- 'draft' | 'approved' | 'discarded'
  batch_id    TEXT,                   -- set on approval
  revision    INTEGER NOT NULL,       -- bumped on every save
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)
```

Shared types (`packages/shared`):

```ts
export interface PlanStep { title: string; description: string; dependsOn: number[] } // indexes into the same steps array
export type PlanStatus = 'draft' | 'approved' | 'discarded';
export interface Plan { id: string; repo_id: string; title: string; steps: PlanStep[]; status: PlanStatus;
  batch_id: string | null; revision: number; created_at: string; updated_at: string }
```

`dependsOn` holds indexes, not ids, because no bead exists yet. Validation, applied on every write: at least one step; every
title non-empty after trimming; every index in range, never the step itself, and no cycle. A write that fails validation is
refused with a message naming the step, and nothing is stored.

## Flow

### Proposing

MCP tool `propose_plan(repo, title, steps)`. It validates, inserts a `draft`, and posts a queued notice
`<title>: plan ready for review (<n> steps)` whose hint tells the orchestrator to stop and wait for the user. It pushes a
notification with `url: '#plan/<id>'`. It does not create a batch, a branch or a bead.

Orchestrator prompt, How to work: a new rule before rule 1 — when the user asks to plan the work out, call `propose_plan` with
the steps rule 2 would have turned into beads (same granularity, same splitting and `blocked-by` guidance), tell the user in
one line that the plan is waiting on its page, and end the turn. Rule 1 applies unchanged to every other request.

### Reviewing and editing

REST, in `src/api/rest.ts`:

- `GET /api/plans` — drafts, newest first (the Needs view reads these).
- `GET /api/plans/:id`
- `PUT /api/plans/:id` — body `{ title, steps, revision }`. Refused with 409 when `revision` is not the stored one, so a stale
  tab cannot overwrite a newer save; refused with 409 when the plan is not a draft.
- `POST /api/plans/:id/approve` — body `{ revision }`, same 409 rules.
- `POST /api/plans/:id/discard`

A `plans` event on the `/api/events` socket tells the web to refetch.

The web writes plan state. Everywhere else the daemon is the only writer of what the web shows; this is the one exception, and
it is kept narrow: a plan is a draft nobody else edits, and it never touches bead status or `overseer:*` labels. Approval hands
it to the daemon, and from then on the usual rule holds.

### Approving

`Lifecycle.approvePlan(id, revision)`:

1. Check the plan is a draft at that revision.
2. `createBatch(repo, title)` — the branch and worktree appear now, not before.
3. Create the beads in step order with `bd create`, each labelled for the batch at creation (as rule 2 requires) and with
   `--deps blocked-by:<id>` for every `dependsOn` index, resolved to the ids created earlier in the same loop. Indexes are
   validated acyclic, so creating in an order where every dependency precedes its dependent is always possible; the loop
   sorts topologically first.
4. Store `status: 'approved'` and `batch_id`.
5. Wake the orchestrator: `<title>: plan approved by the user; batch <id> created with beads <ids>`, with a hint to dispatch the
   ready beads under the existing rules.

A failure part-way (a bd write refused) leaves the plan a draft, removes the batch just created — closing the beads made so far,
deleting the worktree and branch — and answers the request with the bd message. The user can approve again. This reuses the
cleanup inside `abandonBatch` but not its notices or retrospective signals: a rolled-back approval is not an abandoned batch,
and must not produce a "Retrospective ready" notice or an abandon line in Chat.

The beads are created in `planOrder` from `packages/shared/src/plan.ts`: a topological sort over `dependsOn` so every
dependency exists, and is resolved to an id, before the step that depends on it is created. This is also why the plan page
keeps the list readable top to bottom — the dependency picker on a step offers only earlier steps plus any dependency already
selected, and `moveStep` refuses an adjacent move when either of the two steps depends on the other, rather than only checking
the one being moved.

`rollbackBatch` has no guard against a batch with a running worker, unlike the actions in `lifecycle.ts` that a user can invoke
on an in-progress batch: its only caller is `Plans.approve`, which runs it on a batch that has never been dispatched, so there
is never anything running to interrupt.

### Discarding

`status: 'discarded'`. Nothing else is touched, because nothing else exists.

## UI

### Needs

`needsYouItems` gains a fourth kind, `plan`, ordered first: while a plan waits, nothing runs for that request. Label: the
plan's title. Detail: `<n> steps awaiting your review`. The row routes to `#plan/<id>`.

### Plan page

`views/Plan.tsx`, one column, `max-width: 760px`, the same page on both widths.

- Header: a back control, the repo, and the title as an editable field.
- Steps, numbered because the order is real (it is the creation and dependency order). Each step: title field, description
  textarea that grows with its content, a "depends on" control listing only the earlier steps, and remove.
- Reorder with move up and move down buttons, not drag: they work with a thumb and a keyboard alike. Moving a step past one it
  depends on is refused with a line saying which.
- "Add step" at the end.
- Saving is automatic on blur, sending the current `revision`. A 409 shows "This plan changed elsewhere" with Reload, and
  keeps the user's unsaved text on screen so it is not lost.
- Footer: Approve plan (primary) and Discard. Discard asks for confirmation. Approve is disabled while a save is in flight or
  the plan fails validation, with the reason next to it.
- An approved or discarded plan is read-only and says which, linking to the batch when there is one.

Phone (below 768 px): full-screen, footer fixed above the tab bar with `env(safe-area-inset-bottom)`, controls at least 44 px,
inputs at 16 px so iOS does not zoom. Titles in the step list clip with an ellipsis rather than wrap, as the Needs view does;
the fields themselves show the full text.

## Testing

Daemon:

- `propose_plan` validation: empty steps, blank title, out-of-range index, self-dependency, cycle — each refused, nothing stored.
- `propose_plan` creates no branch, worktree, batch or bead.
- Approve creates the batch and one bead per step, labelled for the batch, with `blocked-by` matching `dependsOn`, including a
  dependency on a later-listed step (topological order).
- Approve and save at a stale revision answer 409 and change nothing.
- A bd failure during approval leaves the plan a draft and no batch, branch or bead behind.
- Discard leaves the repository and bd untouched.
- Prompt test: the new rule names `propose_plan` and ending the turn.

Web:

- `needsYouItems` lists a draft plan first.
- Plan page: edit, add, remove, reorder, the refusal when a move would break a dependency, save on blur with the revision, the
  409 path keeping unsaved text, Approve disabled while invalid, read-only after approval.

Browser, at 390 and 1280, with a plan whose step titles and descriptions are sentence-length and whose steps have
dependencies: no horizontal overflow, controls at least 44 px on the phone, the footer clear of the tab bar.

## Known limits

- If the daemon stops during an approval, after the batch was created and before the plan is marked approved, the plan stays a
  draft while the batch, its branch and worktree, and any beads already created remain. Approving again fails because the
  branch exists, and the leftover batch has to be abandoned from Review first.
- A plan whose title matches a batch that is still open gets the same `feature/<slug>` branch, so approving it fails with the
  existing "already has an open batch" error until that batch is merged or abandoned.

## Not in this design

- An "always plan" setting per repo.
- Per-bead implementation plans written by workers.
- Editing a plan after approval; the beads are the work from then on.
- Several people editing one plan at once, beyond refusing a stale save.
