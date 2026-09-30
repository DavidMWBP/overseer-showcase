# Model routing, review rounds and chat parity

Date: 2026-09-14. Builds on `2026-09-12-overseer-design.md` and `2026-09-13-batches-speed-ui-design.md`.

## Why

Overseer chooses a harness per worker and nothing else. Every session runs the CLI's own default model
(Claude Code's saved `/model` for the orchestrator and Claude workers, `~/.codex/config.toml` for Codex,
OpenCode's config for OpenCode). There is no way to spend less on a rename and more on a hard change, no
automated review of a worker's work before it lands, and four actions (merge, reject, abandon, close bead,
retry verification) can only be done by clicking in the UI although the user drives everything else from Chat.

This spec adds:

1. **Tiers** — named model tiers, configured in Setup, resolved by the daemon at dispatch time.
2. **Orchestrator settings** — model, effort and prompt override for the orchestrator, configured in Setup.
3. **Review rounds** — a critic session reviews every verified bead before it lands, on a different model
   than the one that did the work, with automatic re-dispatch and a human decision after the last round.
4. **Chat parity** — the UI-only actions become MCP tools the orchestrator may call after the user asked.

Decisions taken with the user during the brainstorm: Codex models are the primary workers, Claude models the
fallback; `gpt-6-astra` is never used (cost); Fable is the critic and planning model; two review rounds and
then a discussion in Chat, with the orchestrator acting on the outcome; a retry after a failed review steps the
bead up one tier.

## 1. Settings and data model

### `settings` table

```sql
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
```

`value` is JSON. Keys:

- `orchestrator` — `{ model: string | null, effort: Effort | null, promptOverride: string | null }`.
  `null` means "the CLI default", which is today's behaviour. When `promptOverride` is set the daemon writes it
  to `<dataDir>/orchestrator/prompt.md` at session start and passes that file as the system prompt instead of
  `prompts/orchestrator.md`.
- `tiers` — `{ tiers: Tier[], denyModels: string[] }` where
  `Tier = { name: TierName, candidates: TierCandidate[] }` and
  `TierCandidate = { harness: HarnessName, model: string, effort: Effort | null }`.
  `TierName = 'chore' | 'standard' | 'hard' | 'critic' | 'critic-chore'`, from the shared `TIER_NAMES` list the
  UI and the settings `PUT` both read. The candidate order is the fallback order. Tier names are fixed
  identifiers the prompt relies on; the UI edits candidates only (and can create an optional tier it does not
  hold yet, `critic-chore`, by adding its first candidate).
- `Effort = 'low' | 'medium' | 'high' | 'xhigh'`. OpenCode has no effort dial; the value is ignored there.

Seeded on first run (when the key is missing):

| Tier | Candidates, in fallback order | Use |
|---|---|---|
| chore | codex `gpt-5.6-luna`, claude `haiku` | docs, config, renames, single-file edits with an obvious answer |
| standard | codex `gpt-5.6-terra`, claude `sonnet` | normal implementation work |
| hard | codex `gpt-5.6-sol`, claude `opus` | work a standard attempt could not finish, or the user asked |
| critic | claude `fable` | review rounds, planning |
| critic-chore | *unset* | the review round for `chore` beads, when the user wants a cheaper critic there |

`critic-chore` is optional: it is absent from the seeded tiers, and a `PUT` may include or omit it (the other
four are required). When it is configured, a bead whose worker ran on `chore` is reviewed through it, falling
back to `critic` when it is absent or exhausted; every other bead reviews on `critic` as before.

`denyModels` is seeded with `['gpt-6-astra']`. A `PUT` of tiers that names a denied model is refused with 400.

### Added columns (`ADDED_COLUMNS`)

- `sessions.tier TEXT`, `sessions.model TEXT` — what actually ran, for cards, traces and cost lines. Effort is
  not stored; nobody reads it back.
- `worktrees.review_round INTEGER` — critic rounds in the current dispatch cycle. Reset to 0 by a fresh dispatch
  from the orchestrator after a decision and by `accept_review`.
- `worktrees.review_findings TEXT` — latest critic output as JSON (`Finding[]`), for the card and the batch note.
- `worktrees.review_note TEXT` already exists and keeps its meaning; `accept_review` stores its note in a new
  `worktrees.accepted_note TEXT`.
- `repos.review_rounds INTEGER` — default 2; 0 disables review rounds for that repo.

### Shared types

`TierName`, `TierCandidate`, `Tier`, `TierSettings`, `OrchestratorSettings`, `Effort`, `Finding`,
`Session.tier`, `Session.model`, `SessionRole` gains `'critic'`, `Repo.review_rounds`,
`CardState` gains `'reviewing'` and `'awaiting_decision'`, `BoardCard` gains `tier`, `model`, `findings`,
`accepted_note`.

## 2. Tier resolution and adapters

### `resolveTier`

`packages/daemon/src/routing/tiers.ts`, a pure function:

```ts
resolveTier(settings: TierSettings, tier: TierName, opts: { previousModels: string[]; excludeModel?: string; stepUp?: boolean }): TierCandidate
```

Rules, in order:

1. **Step-up.** `stepUp` bumps the tier along chore → standard → hard. Hard stays hard. Critic never steps up.
2. **Fallback.** Skip candidates whose model is in `previousModels`. If every candidate was used, start again
   from the first.
3. **Different model.** Skip the candidate whose model equals `excludeModel`. If that exhausts the tier, fall
   through to the hard tier's candidates, then standard, then chore, with the same exclusion. Used for critic
   dispatches with the worker's model excluded, so fable never reviews fable. `critic-chore` falls through its
   own candidates first and then the critic chain, so an unconfigured or exhausted cheaper critic still reviews
   on `critic` instead of failing the round.
4. A denied model is never returned; it is skipped like an excluded one.

Throws `TierError` with a readable message when nothing is left; the MCP tool returns that text.

### Callers

- `spawn_worker(repo, bead_id, tier?, harness?, instructions?, batch_id?)`. `tier` defaults to `standard` when
  neither is given. `harness` without `tier` keeps the old behaviour: that harness, no model, CLI default. Both
  given: the tier's first candidate on that harness, then the tier's other candidates.
  The lifecycle computes `previousModels` from the bead's earlier worker sessions and sets `stepUp` when the
  bead's last worker session ended with a failed verification or a failed review round.
- Critic dispatch (section 3) resolves `critic`, or `critic-chore` when the bead's last worker ran on `chore` and
  that tier is configured, with `excludeModel` = the worker's model.
- The orchestrator start reads the `orchestrator` setting and passes `model` and `effort` straight through.
- Re-dispatch from the Board uses the last session's tier (or `standard` if it had none) with `stepUp` true when
  the last verification or review failed, as the orchestrator path does.

### Adapters

`StartOpts` gains `model?: string` and `effort?: Effort`. Only the pure arg builders change:

- `claudeArgs`: `--model <model>` when set; effort through the CLI's effort flag when set. The exact flag name is
  verified against the installed CLI during implementation; if the CLI has no flag, effort is passed with
  `--settings '{"effort":"<level>"}'`.
- `codexArgs`: `-m <model>` and `-c model_reasoning_effort=<level>` when set.
- `opencodeArgs`: `--model <model>` when set. Effort ignored.

Recorded fixtures stay valid: without model and effort the args are unchanged.

## 3. Review rounds

The round sits where landing happens today: in the worker-settled handler, after verification passes.

1. **Start.** With `repo.review_rounds > 0`: the card goes to `reviewing`, `review_round` is incremented, and a
   critic session starts: role `critic`, tier `critic` (or the optional `critic-chore` for a `chore` bead) with
   `excludeModel` the worker's model, cwd the bead's
   worktree, system prompt `prompts/critic.md`, user prompt carrying the bead title, the worker's final message,
   the instructions the worker got, and the diff against the batch branch (or the base branch without a batch).
   The critic may read and run tests; it must not edit or commit. The daemon checks `git status --porcelain`
   when the critic ends and discards any change with `git checkout -- . && git clean -fd` before proceeding,
   logging a warning.
2. **Verdict.** The critic reports through `submit_review(verdict: 'pass' | 'findings', findings: Finding[])`,
   `Finding = { file: string | null, summary: string, severity: 'must' | 'should' }`. The tool is exposed only to
   critic sessions (the MCP config lists it for that role). A critic that ends without calling it counts as
   `findings` with its final text as one `must` finding, so silence cannot land a bead.
3. **Pass.** The existing landing code runs unchanged. The landed notice names the critic model:
   `<bead> landed on <branch> (…; reviewed by claude fable)`.
4. **Findings, below the limit.** The daemon re-dispatches the worker itself with the findings rendered as
   instructions, and how it does so depends on which round failed.

   The **first** failed round is a continuation (`SpawnOpts.continuation`): no `stepUp`, an empty `previousModels`,
   and the previous worker's own harness session resumed through `resumeId`. The findings are a list to apply, not a
   problem to solve again, so a fresh model that must read the branch from scratch buys nothing. Resume needs the
   same harness and the same model; an empty or null `native_session_id` (codex and opencode report `''` when the CLI
   gave them no thread) starts a fresh session instead of passing an empty id to `--resume`.

   **Later** rounds escalate as before: `stepUp` along the tier chain with `previousModels` carrying every model that
   already failed on the bead, and no resume.

   Verification and review run again either way. Notice (queued, not wake): `<bead> review round 1 found 2 issues;
   re-dispatched to codex gpt-5.6-terra`.
5. **Findings, at the limit.** The card goes to `awaiting_decision` with `review_findings` set. A wake notice
   carries the findings text to the orchestrator with the hint: *discuss the findings with the user, then either
   `spawn_worker` with the agreed instructions or `accept_review`; do not decide alone.* The orchestrator
   summarises to the user in Chat and acts on the outcome. Both tools reset `review_round` to 0.
6. **`accept_review(repo, bead_id, note)`** lands the bead through the existing landing path, stores `note` in
   `accepted_note`, and the batch review note lists the bead under "landed with open findings" with the
   findings and the note.

The user can also Close bead from the Board as today, or press **Land anyway** on the card, which calls the same
lifecycle method as `accept_review` with the note typed in a prompt.

Batches count a `reviewing` or `awaiting_decision` bead as not landed; `request_batch_review` refuses until every
bead has landed or been closed, as it does today for running beads.

**Crash recovery.** A critic session found dead on restart is started again with the same inputs; it has no side
effects. **Stop worker** on a reviewing card stops the critic and reopens the bead with a "Stopped by the user
during review" note, as it does for a worker.

**Cost.** With two rounds, the worst case per bead is three worker sessions and two critic sessions. The critic
gets a diff, not the codebase, so its sessions stay short. `review_rounds = 0` restores today's flow; the smoke
script sets it for its throwaway repo.

## 4. MCP surface, chat parity and orchestrator settings

### Tools (`mcp/tools.ts`, thin over lifecycle methods)

- `spawn_worker` — `tier` added, `harness` optional (section 2).
- `submit_review`, `accept_review` — section 3.
- **Chat parity:** `merge_batch(repo, batch_id)`, `reject_batch(repo, batch_id, note)`,
  `abandon_batch(repo, batch_id)`, `close_bead(repo, bead_id, note)`, `retry_verification(repo, bead_id)`.
  Each calls the lifecycle method its REST route calls; the notice text says "by the user through the
  orchestrator" so the Chat log tells the two routes apart. `merge_batch` also refuses when the batch is not in
  review, as the route does.

### Prompt changes (`prompts/orchestrator.md`)

- Dispatch rule: *pass `tier`: `chore` for docs, config, renames and single-file edits with an obvious answer;
  `standard` for everything else; `hard` only when the user asks or a standard attempt failed on its own. Never
  name a model; the tiers are configured in Setup.*
- Review rule: *after verification a critic reviews the change; you are not involved until a
  `[Overseer] <bead> awaits a decision` notice arrives with the findings. Summarise them, discuss, then call
  `spawn_worker` with the agreed instructions or `accept_review` with the agreed note.*
- Chat parity rule: *call `merge_batch`, `reject_batch`, `abandon_batch`, `close_bead` and `retry_verification`
  only after the user asked for that action in this conversation. For `merge_batch` and `abandon_batch` ask a
  one-line confirmation first unless the user's message already was one.* The paragraphs that say the
  orchestrator cannot close beads or merge are rewritten: the Board and Review buttons still exist and are named
  as the alternative.

`prompts/critic.md` is new: the role, the inputs, the read-only rule, and the instruction to end with
`submit_review`.

### REST

- `GET/PUT /api/settings/orchestrator` and `GET/PUT /api/settings/tiers`, zod-validated like the repo routes.
  The tiers PUT refuses denied models (400 with the model named) and unknown tier names. The response to either
  PUT carries `appliesTo: 'next-session'`; the Save dialog offers `POST /api/orchestrator/reset` for "now".
- `PATCH /api/repos/:id` accepts `review_rounds`.
- `POST /api/tasks/:id/accept-review` with `{ note }` for the Land anyway button.
- The `status` socket message gains `orchestrator.model` (from the last started session, or `null`).

## 5. UI

- **Setup → Models** (above repositories). *Orchestrator* block: model text field, effort dropdown with a blank
  "CLI default" option, prompt override textarea with "Reset to shipped prompt". *Tiers* table: one row per tier,
  candidates in order, each a harness dropdown, model text field and effort dropdown, with add, remove, move up
  and move down. Text fields, not model dropdowns: model IDs change faster than releases and the CLI is the
  authority. Save per block; the confirmation line reads "Applies to the next orchestrator session" with a
  "Reset now" link.
- **Repo edit** gains "Review rounds" (number, 0–5) next to the verify command.
- **Board card**: a chip `standard · gpt-5.6-terra` on running, reviewing and done cards. `reviewing` renders
  like Verifying with "reviewed by claude fable". `awaiting_decision` sorts to the top of its column with an
  amber left rule and a "needs decision" chip; the pane lists the findings and offers Stop worker (disabled),
  Re-dispatch, Close bead and **Land anyway**.
- **Review view**: beads with an `accepted_note` are listed under "landed with open findings" with findings and
  note.
- **Rail**: the mascot label announces the orchestrator state; the rail shows no model row.

## 6. Testing

Conventions unchanged: real git repos, `:memory:` SQLite, the fake adapter, the in-process MCP client, no
warnings in test output.

- `routing/tiers.test.ts`: step-up (each tier, hard stays hard, critic never), fallback order and wrap-around,
  exclude, fall-through when the critic tier is exhausted, denied model skipped, `TierError` when nothing is left.
- Adapter arg tests: each `*Args` with and without model and effort; unchanged output when unset.
- Lifecycle with the fake adapter: verify pass starts a critic; `pass` lands and the notice names the critic;
  `findings` re-dispatches on the same model with the findings as instructions and the worker's session resumed, a
  round after that steps the tier up to a fresh model without resuming, and an empty `native_session_id` starts
  afresh; second `findings` parks the
  bead in `awaiting_decision` with a wake notice; `accept_review` lands and resets the round; a critic that edits
  has its changes discarded; `review_rounds = 0` skips the round; a dead critic is restarted on recovery; Stop
  during review reopens the bead.
- MCP through the in-process client: `spawn_worker` with tier, with harness only, with both; `submit_review`
  hidden from worker and orchestrator sessions; the five parity tools call the lifecycle and post notices.
- REST: settings round-trip, Astra refused, unknown tier refused, `review_rounds` on PATCH, accept-review route.
- Web: the Setup blocks save and show the next-session line; the two new card states render with the right
  actions. Rail coverage keeps the mascot label as the orchestrator state indicator; it has no model row.
- One live smoke run at the end; the smoke script in `CLAUDE.md` gains a review step and sets `review_rounds`.

## 7. Rollout and compatibility

- No migration beyond `ADDED_COLUMNS` and the seeded settings rows. An existing install keeps CLI defaults for
  the orchestrator and gets the seeded tiers.
- `spawn_worker(harness)` without `tier` keeps working, so a running orchestrator session survives the upgrade.
- `sessions.tier` and `sessions.model` are `null` for sessions started before this change; the card chip is
  hidden when both are null.

## Out of scope

Renaming or adding tiers; automatic tier choice by the daemon from bead content; per-repo tier maps; effort for
OpenCode; pricing or budget tracking; a critic for the orchestrator's own plans.
