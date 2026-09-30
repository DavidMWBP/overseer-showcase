# Model routing, review rounds and chat parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the orchestrator route each worker to a named model tier (Codex primary, Claude fallback), run a different-model critic review before a bead lands, expose the orchestrator's model/effort/prompt and the tier map in Setup, and give the orchestrator MCP tools for the actions that were UI-only.

**Architecture:** The daemon stays the only writer of state. A new `settings` table holds the orchestrator config and the tier map. A pure `resolveTier` function maps a tier name plus history to one `{harness, model, effort}`, which flows through `StartOpts` into the three adapters as CLI flags. The review round sits in the existing worker-settled handler: on verify pass, a critic session reviews the diff and reports through a new MCP tool; findings re-dispatch the worker (stepped up a tier) up to a per-repo limit, then park the bead for a Chat decision. Five parity tools wrap existing lifecycle methods.

**Tech Stack:** TypeScript, Fastify, node:sqlite, zod, MCP SDK, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-model-routing-review-rounds-design.md`

## Global Constraints

- **bd writes:** one write per lifecycle transition (`store.update` takes status, phase and note together). Do not add extra bd calls.
- **Card actions** are driven by `BoardCard.state`, never inferred in the web from separate fields.
- **Notices** have two readers: `text` (third-person log line, shown in Chat) and `hint` (model-only guidance, never rendered).
- **Windows:** all child processes go through `spawnLines`/`runCapture` with `shell: false`. Do not add a shell spawn.
- **Migrations:** extend `ADDED_COLUMNS` and the `CREATE TABLE IF NOT EXISTS` schema string; no other migration mechanism.
- **Tests:** real git repos, `:memory:` SQLite, the fake adapter, the in-process MCP client. Test output must stay free of warnings.
- **Tier names are fixed:** `chore | standard | hard | critic`. The UI edits candidates only.
- **Model IDs (seed):** chore `gpt-5.6-luna`→`haiku`; standard `gpt-5.6-terra`→`sonnet`; hard `gpt-5.6-sol`→`opus`; critic `fable`. Deny list seed: `['gpt-6-astra']`.
- **CLI flags (verified against installed CLIs):** Claude `--model <m>` and `--effort <low|medium|high|xhigh|max>`; Codex `-m <m>` and `-c model_reasoning_effort=<level>`; OpenCode `--model <m>`, no effort.
- **Backward compatibility:** `spawn_worker` must keep working when called with `harness` and no `tier` (CLI default, no model flag). Existing sessions have null `tier`/`model`.

**User decisions (already made):**
- "Codex models should be our workers"; Claude models are the per-tier fallback.
- "avoid astra as the costs are astronomical, would rather use fable then if required" — Astra is on the deny list; Fable is the critic tier.
- Tiers: "opus should be the fallback for hard work, fable for critic/planning, sonnet for normal work, haiku for chores/docs/simple edits."
- "reviewing rounds ... always be a different model than the one that did the work."
- Two review rounds, then "step up a tier on retry", then "tell me in the chat with the findings so I can discuss and have the overseer decide."
- Chat parity: keep UI buttons as the escape hatch; orchestrator may call the action tools only after the user asked, confirming first for merge/abandon.

---

### Task 1: Shared types and settings/schema foundations

**Goal:** Add every shared type and every schema change the rest of the plan builds on, with a settings db accessor that seeds defaults.

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/daemon/src/db/schema.ts`
- Modify: `packages/daemon/src/db/db.ts`
- Test: `packages/daemon/src/db/db.test.ts`

**Acceptance Criteria:**
- [ ] `Effort`, `TierName`, `TierCandidate`, `Tier`, `TierSettings`, `OrchestratorSettings`, `Finding` exported from shared.
- [ ] `SessionRole` includes `'critic'`; `SessionRow` has `tier` and `model` (both nullable); `Repo` has `review_rounds`; `WorktreeRow` has `review_round`, `review_findings`, `accepted_note`; `CardState` includes `'reviewing'` and `'awaiting_decision'`; `BoardCard` has `tier`, `model`, `findings`, `accepted_note`.
- [ ] `settings` table created; `db.settings.get(key)`/`db.settings.set(key, value)` round-trip JSON; `db.settings.orchestrator()` and `db.settings.tiers()` return seeded defaults when unset.
- [ ] New `ADDED_COLUMNS` entries applied on an existing db without data loss.
- [ ] `db.sessions.insert`/`update` and `db.repos.insert` handle the new columns.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run db` → PASS

**Steps:**

- [ ] **Step 1: Shared types.** In `packages/shared/src/index.ts` add near the top:

```ts
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TierName = 'chore' | 'standard' | 'hard' | 'critic';
export interface TierCandidate { harness: HarnessName; model: string; effort: Effort | null }
export interface Tier { name: TierName; candidates: TierCandidate[] }
export interface TierSettings { tiers: Tier[]; denyModels: string[] }
export interface OrchestratorSettings { model: string | null; effort: Effort | null; promptOverride: string | null }
export interface Finding { file: string | null; summary: string; severity: 'must' | 'should' }
```

Change `SessionRole` to `'orchestrator' | 'worker' | 'critic'`. Add to `SessionRow`: `tier: TierName | null; model: string | null;`. Add to `Repo`: `review_rounds: number;`. Add to `WorktreeRow`: `review_round: number | null; review_findings: Finding[] | null; accepted_note: string | null;`. Change `CardState` to include `'reviewing'` and `'awaiting_decision'`. Add to `BoardCard`: `tier: TierName | null; model: string | null; findings: Finding[] | null; accepted_note: string | null;`.

- [ ] **Step 2: Schema string + ADDED_COLUMNS.** In `schema.ts`, add to the `SCHEMA` template:

```sql
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Append to `ADDED_COLUMNS`:

```ts
{ table: 'sessions', column: 'tier', ddl: 'TEXT' },
{ table: 'sessions', column: 'model', ddl: 'TEXT' },
{ table: 'repos', column: 'review_rounds', ddl: 'INTEGER NOT NULL DEFAULT 2' },
{ table: 'worktrees', column: 'review_round', ddl: 'INTEGER' },
{ table: 'worktrees', column: 'review_findings', ddl: 'TEXT' },
{ table: 'worktrees', column: 'accepted_note', ddl: 'TEXT' },
```

- [ ] **Step 3: db accessors.** In `db.ts`: extend `repos.insert` to include `review_rounds` (add the column to the INSERT and the value list; default to 2 if undefined). Extend `sessions.insert` to include `tier`, `model`. Extend `worktrees.upsert` to include `review_round`, `review_findings` (JSON-stringify the `Finding[]`), `accepted_note`; update `parseWt` to JSON-parse `review_findings`. Add a `settings` accessor block:

```ts
settings = {
  get: (key: string) => { const r = this.sql.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return r ? JSON.parse(r.value) : undefined; },
  set: (key: string, value: unknown) => this.sql.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), now()),
  orchestrator: (): OrchestratorSettings => this.settings.get('orchestrator') ?? { model: null, effort: null, promptOverride: null },
  tiers: (): TierSettings => this.settings.get('tiers') ?? DEFAULT_TIERS,
};
```

Add `DEFAULT_TIERS` as a module constant in `db.ts` (imported type from shared):

```ts
export const DEFAULT_TIERS: TierSettings = {
  tiers: [
    { name: 'chore', candidates: [{ harness: 'codex', model: 'gpt-5.6-luna', effort: null }, { harness: 'claude', model: 'haiku', effort: null }] },
    { name: 'standard', candidates: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }, { harness: 'claude', model: 'sonnet', effort: null }] },
    { name: 'hard', candidates: [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }, { harness: 'claude', model: 'opus', effort: null }] },
    { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
  ],
  denyModels: ['gpt-6-astra'],
};
```

Fix the INSERT column counts: `repos` INSERT and `sessions` INSERT have positional `VALUES (?,...)`; add the new columns explicitly by switching those two inserts to a named-column form (e.g. `INSERT INTO repos (id,path,base_branch,verify_command,merge_mode,worker_limit,review_rounds) VALUES (?,?,?,?,?,?,?)`), so column order is unambiguous.

- [ ] **Step 4: Tests.** In `db.test.ts` add cases: a fresh `:memory:` db returns `DEFAULT_TIERS` from `db.settings.tiers()` and the null orchestrator default; `db.settings.set('tiers', custom)` then `tiers()` returns `custom`; inserting a session with `tier: 'standard', model: 'gpt-5.6-terra'` reads back those values; a repo inserted without `review_rounds` reads back `2`; a worktree upsert with `review_findings` round-trips the array.

- [ ] **Step 5: Run and commit.** `pnpm --filter @overseer/daemon exec vitest run db` → PASS. Commit with explicit paths.

```json:metadata
{"files": ["packages/shared/src/index.ts", "packages/daemon/src/db/schema.ts", "packages/daemon/src/db/db.ts", "packages/daemon/src/db/db.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run db", "acceptanceCriteria": ["new shared types exported", "settings table + accessor round-trips and seeds defaults", "new columns applied and read back"], "modelTier": "standard"}
```

---

### Task 2: `resolveTier` pure function

**Goal:** A tested pure function that turns a tier name plus dispatch history into one concrete `{harness, model, effort}`, applying step-up, fallback, different-model and deny-list rules.

**Files:**
- Create: `packages/daemon/src/routing/tiers.ts`
- Test: `packages/daemon/src/routing/tiers.test.ts`

**Acceptance Criteria:**
- [ ] `resolveTier(settings, tier, opts)` returns the first candidate not excluded and not in `previousModels` and not denied.
- [ ] `stepUp` bumps chore→standard→hard; hard stays hard; critic never steps up.
- [ ] Within a tier, candidates already in `previousModels` are skipped; if all are used, it restarts from the first non-denied candidate.
- [ ] `excludeModel` skips that model; if it exhausts the critic tier, it falls through hard→standard→chore with the same exclusion.
- [ ] Denied models are never returned.
- [ ] Throws `TierError` when nothing remains.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run tiers` → PASS

**Steps:**

- [ ] **Step 1: Write the failing tests** in `tiers.test.ts`, using `DEFAULT_TIERS`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveTier, TierError } from './tiers';
import { DEFAULT_TIERS } from '../db/db';

describe('resolveTier', () => {
  it('returns the first candidate of the tier', () => {
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: [] })).toEqual({ harness: 'codex', model: 'gpt-5.6-terra', effort: null });
  });
  it('falls back within a tier past used models', () => {
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: ['gpt-5.6-terra'] })).toMatchObject({ harness: 'claude', model: 'sonnet' });
  });
  it('wraps to the first candidate when all were used', () => {
    expect(resolveTier(DEFAULT_TIERS, 'chore', { previousModels: ['gpt-5.6-luna', 'haiku'] })).toMatchObject({ model: 'gpt-5.6-luna' });
  });
  it('steps up chore to standard, hard stays hard, critic never', () => {
    expect(resolveTier(DEFAULT_TIERS, 'chore', { previousModels: [], stepUp: true })).toMatchObject({ model: 'gpt-5.6-terra' });
    expect(resolveTier(DEFAULT_TIERS, 'hard', { previousModels: [], stepUp: true })).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], stepUp: true })).toMatchObject({ model: 'fable' });
  });
  it('excludes the working model for a critic and falls through when the critic tier is that model', () => {
    expect(resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], excludeModel: 'gpt-5.6-terra' })).toMatchObject({ model: 'fable' });
    expect(resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], excludeModel: 'fable' })).toMatchObject({ model: 'gpt-5.6-sol' });
  });
  it('never returns a denied model', () => {
    const s = { ...DEFAULT_TIERS, tiers: DEFAULT_TIERS.tiers.map((t) => t.name === 'hard' ? { ...t, candidates: [{ harness: 'codex' as const, model: 'gpt-6-astra', effort: null }, ...t.candidates] } : t) };
    expect(resolveTier(s, 'hard', { previousModels: [] })).toMatchObject({ model: 'gpt-5.6-sol' });
  });
  it('throws when nothing remains', () => {
    const s = { tiers: [{ name: 'critic' as const, candidates: [{ harness: 'claude' as const, model: 'fable', effort: null }] }], denyModels: [] };
    expect(() => resolveTier(s, 'critic', { previousModels: [], excludeModel: 'fable' })).toThrow(TierError);
  });
});
```

- [ ] **Step 2: Run to confirm failure** (`function not defined`).

- [ ] **Step 3: Implement** `tiers.ts`:

```ts
import type { TierSettings, TierName, TierCandidate } from '@overseer/shared';

export class TierError extends Error {}

const ORDER: TierName[] = ['chore', 'standard', 'hard'];

export interface ResolveOpts { previousModels: string[]; excludeModel?: string; stepUp?: boolean }

export function resolveTier(settings: TierSettings, tier: TierName, opts: ResolveOpts): TierCandidate {
  const deny = new Set(settings.denyModels);
  const byName = (n: TierName) => settings.tiers.find((t) => t.name === n)?.candidates ?? [];
  let start = tier;
  if (opts.stepUp && tier !== 'critic') { const i = ORDER.indexOf(tier); if (i >= 0 && i < ORDER.length - 1) start = ORDER[i + 1]!; }

  // Candidate lists to try in order: the chosen tier, then (only when excludeModel forces it) the fall-through chain.
  const chain: TierName[] = start === 'critic' ? ['critic', 'hard', 'standard', 'chore'] : [start];
  const ok = (c: TierCandidate) => !deny.has(c.model) && c.model !== opts.excludeModel;

  for (const name of chain) {
    const cands = byName(name).filter(ok);
    if (cands.length === 0) continue;
    const fresh = cands.find((c) => !opts.previousModels.includes(c.model));
    return fresh ?? cands[0]!;
  }
  throw new TierError(`no model available for tier ${tier}${opts.excludeModel ? ` excluding ${opts.excludeModel}` : ''}`);
}
```

- [ ] **Step 4: Run to confirm pass.**

- [ ] **Step 5: Commit.**

```json:metadata
{"files": ["packages/daemon/src/routing/tiers.ts", "packages/daemon/src/routing/tiers.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run tiers", "acceptanceCriteria": ["step-up, fallback, wrap, exclude, fall-through, deny, throw all covered"], "modelTier": "standard"}
```

---

### Task 3: Adapter model/effort flags

**Goal:** Carry `model` and `effort` through `StartOpts` into the three adapters' argument builders as CLI flags, leaving current behaviour unchanged when unset.

**Files:**
- Modify: `packages/daemon/src/harness/types.ts`
- Modify: `packages/daemon/src/harness/claude.ts`
- Modify: `packages/daemon/src/harness/codex.ts`
- Modify: `packages/daemon/src/harness/opencode.ts`
- Test: `packages/daemon/src/harness/claude.test.ts`, `codex.test.ts`, `opencode.test.ts`

**Acceptance Criteria:**
- [ ] `StartOpts` has optional `model` and `effort`.
- [ ] `claudeArgs` appends `--model <m>` and `--effort <level>` when set, after the existing flags.
- [ ] `codexArgs` appends `-m <m>` and `-c model_reasoning_effort=<level>` when set, for both new and resume turns.
- [ ] `opencodeArgs` appends `--model <m>` when set; effort ignored.
- [ ] With neither set, all three produce their current output exactly.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run harness` → PASS

**Steps:**

- [ ] **Step 1: types.** In `types.ts` add to `StartOpts`: `model?: string; effort?: import('@overseer/shared').Effort;`.

- [ ] **Step 2: claude.** Change `claudeArgs(o, nativeId, resume, mcpConfigFile)` to append before `return args`:

```ts
if (o.model) args.push('--model', o.model);
if (o.effort) args.push('--effort', o.effort);
```

- [ ] **Step 3: codex.** Change `codexArgs` signature to `codexArgs(cwd, threadId, prompt, opts?: { model?: string; effort?: string })` and build the extra flags once:

```ts
const extra: string[] = [];
if (opts?.model) extra.push('-m', opts.model);
if (opts?.effort) extra.push('-c', `model_reasoning_effort=${opts.effort}`);
return threadId
  ? ['exec', 'resume', '--json', '--full-auto', '--cd', cwd, ...extra, threadId, prompt]
  : ['exec', '--json', '--full-auto', '--cd', cwd, ...extra, prompt];
```

Update the adapter's `runTurn` to read `this.opts.model`/`this.opts.effort` (store the `StartOpts` on the adapter — check the constructor; if it only keeps `cwd`, keep `model`/`effort` fields too) and pass `{ model, effort }`.

- [ ] **Step 4: opencode.** Change `opencodeArgs(cwd, sessionId, prompt, opts?: { model?: string })` to push `--model <m>` after `--dir <cwd>`; thread the adapter's stored `model` through `runTurn`.

- [ ] **Step 5: tests.** Extend each arg test with a model/effort case and keep the existing no-flag case. Claude example:

```ts
it('adds model and effort', () => {
  const a = claudeArgs({ cwd: '.', prompt: 'x', model: 'sonnet', effort: 'medium' }, 'abc', false, null);
  expect(a).toContain('--model'); expect(a).toContain('sonnet'); expect(a).toContain('--effort'); expect(a).toContain('medium');
});
```

Codex: `expect(codexArgs('/w', null, 'go', { model: 'gpt-5.6-terra', effort: 'high' })).toEqual(['exec','--json','--full-auto','--cd','/w','-m','gpt-5.6-terra','-c','model_reasoning_effort=high','go'])`. Opencode: `expect(opencodeArgs('/w', null, 'do it', { model: 'anthropic/claude' })).toEqual(['run','--format','json','--auto','--dir','/w','--model','anthropic/claude','do it'])`.

- [ ] **Step 6: Run and commit.**

```json:metadata
{"files": ["packages/daemon/src/harness/types.ts", "packages/daemon/src/harness/claude.ts", "packages/daemon/src/harness/codex.ts", "packages/daemon/src/harness/opencode.ts", "packages/daemon/src/harness/claude.test.ts", "packages/daemon/src/harness/codex.test.ts", "packages/daemon/src/harness/opencode.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run harness", "acceptanceCriteria": ["model/effort become CLI flags for all three", "unset produces unchanged output"], "modelTier": "standard"}
```

---

### Task 4: SessionManager carries tier/model

**Goal:** `SessionManager.start` accepts `tier`, `model`, `effort`, records `tier` and `model` on the session row, and passes `model`/`effort` to the adapter.

**Files:**
- Modify: `packages/daemon/src/sessions/manager.ts`
- Test: `packages/daemon/src/sessions/manager.test.ts`

**Acceptance Criteria:**
- [ ] `StartSessionOpts` has optional `tier`, `model`, `effort`.
- [ ] The inserted `SessionRow` carries `tier ?? null` and `model ?? null`.
- [ ] `adapter.start` receives `model` and `effort`.
- [ ] Existing callers that pass none still work (row has null tier/model).

**Verify:** `pnpm --filter @overseer/daemon exec vitest run manager` → PASS

**Steps:**

- [ ] **Step 1:** Add `tier?: TierName; model?: string; effort?: Effort;` to `StartSessionOpts` (import the types from shared).
- [ ] **Step 2:** In `start`, add `tier: o.tier ?? null, model: o.model ?? null,` to the `row` object, and pass `model: o.model, effort: o.effort` in the `adapter.start({...})` call.
- [ ] **Step 3:** Test: `mgr.start({ ...opts, tier: 'standard', model: 'gpt-5.6-terra', effort: 'high' })` then `db.sessions.get(id)` has `tier: 'standard', model: 'gpt-5.6-terra'`; the fake adapter's session `opts.model === 'gpt-5.6-terra'` and `opts.effort === 'high'`. Keep an existing no-tier start asserting null.
- [ ] **Step 4:** Run and commit.

```json:metadata
{"files": ["packages/daemon/src/sessions/manager.ts", "packages/daemon/src/sessions/manager.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run manager", "acceptanceCriteria": ["tier/model stored on the row", "model/effort passed to adapter", "no-tier callers unaffected"], "modelTier": "standard"}
```

---

### Task 5: Orchestrator uses its settings; status reports model

**Goal:** A fresh orchestrator session reads the `orchestrator` setting for its model, effort and prompt override; `status()` returns the current model.

**Files:**
- Modify: `packages/daemon/src/orchestrator/orchestrator.ts`
- Modify: `packages/shared/src/index.ts` (StatusResponse)
- Test: `packages/daemon/src/orchestrator/orchestrator.test.ts` (or the nearest existing orchestrator test file)

**Acceptance Criteria:**
- [ ] When `settings.orchestrator()` has a model/effort, the started session carries them.
- [ ] When `promptOverride` is set, the daemon writes it to `<orchestratorDir>/prompt.md` and passes that as `systemPromptFile`; otherwise it passes `prompts/orchestrator.md`.
- [ ] `StatusResponse.orchestrator` includes `model: string | null` (the current/last session's model).
- [ ] With no settings row, behaviour is unchanged (no model flag, shipped prompt).

**Verify:** `pnpm --filter @overseer/daemon exec vitest run orchestrator` → PASS

**Steps:**

- [ ] **Step 1:** In `orchestrator.ts` `start`, before `sessions.start`, read `const os = db.settings.orchestrator();`. Compute the prompt file: if `os.promptOverride`, write it to `path.join(config.orchestratorDir, 'prompt.md')` (dir already ensured above) and use that path; else `path.join(config.promptsDir, 'orchestrator.md')`. Pass `model: os.model ?? undefined, effort: os.effort ?? undefined` to `sessions.start`, and the computed `systemPromptFile`.
- [ ] **Step 2:** Add `model: string | null` to `StatusResponse.orchestrator` in shared. In `status()`, return `model: row?.model ?? null` in all branches.
- [ ] **Step 3:** Test: set `db.settings.set('orchestrator', { model: 'fable', effort: 'high', promptOverride: 'CUSTOM PROMPT' })`, send a message, assert the orchestrator session row has `model: 'fable'`, the fake adapter got `effort: 'high'`, the `systemPromptFile` points at `orchestrator/prompt.md` and that file contains `CUSTOM PROMPT`; `orchestrator.status().model === 'fable'`.
- [ ] **Step 4:** Run and commit.

```json:metadata
{"files": ["packages/daemon/src/orchestrator/orchestrator.ts", "packages/shared/src/index.ts", "packages/daemon/src/orchestrator/orchestrator.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run orchestrator", "acceptanceCriteria": ["settings drive model/effort/prompt", "status returns model", "unset = unchanged"], "modelTier": "standard"}
```

---

### Task 6: `spawn_worker` resolves a tier

**Goal:** `lifecycle.spawnWorker` accepts an optional `tier`, resolves it to a concrete model with step-up and fallback, records tier/model on the session, and the MCP tool exposes `tier`. `harness` without `tier` keeps the CLI-default path.

**Files:**
- Modify: `packages/daemon/src/lifecycle/lifecycle.ts`
- Modify: `packages/daemon/src/mcp/tools.ts`
- Modify: `packages/daemon/src/lifecycle/lifecycle.test.ts`
- Modify: `packages/daemon/src/mcp/mcp.test.ts`

**Acceptance Criteria:**
- [ ] `spawnWorker(repoId, beadId, opts)` where `opts = { tier?, harness?, instructions?, batchId?, stepUp? }` (refactor the positional params into one options object, updating all callers).
- [ ] With a `tier`, it calls `resolveTier(db.settings.tiers(), tier, { previousModels, stepUp })` where `previousModels` is the models of the bead's prior worker sessions, and starts the session with the resolved harness/model/effort/tier.
- [ ] With `harness` and no `tier`, it starts with that harness and no model (current behaviour).
- [ ] With neither, it defaults to `tier: 'standard'`.
- [ ] The `harness:` label written for the bead reflects the resolved harness.
- [ ] MCP `spawn_worker` accepts `tier` (enum) and optional `harness`; returns the resolved `harness`, `model`, `tier`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run "lifecycle|mcp"` → PASS

**Steps:**

- [ ] **Step 1:** Refactor `spawnWorker` to an options object. Update every caller: `redispatch`, `recover` path (none call it directly), tests, MCP tool. Keep the label-writing and guard logic unchanged.
- [ ] **Step 2:** At the top of the guarded body, resolve the run config:

```ts
const priorModels = db.sessions.forBead(beadId).filter((s) => s.role === 'worker' && s.model).map((s) => s.model!) as string[];
let run: { harness: HarnessName; model?: string; effort?: Effort; tier?: TierName };
if (opts.tier || (!opts.harness)) {
  const tier = opts.tier ?? 'standard';
  const c = resolveTier(db.settings.tiers(), tier, { previousModels: priorModels, stepUp: opts.stepUp });
  run = { harness: c.harness, model: c.model, effort: c.effort ?? undefined, tier };
} else {
  run = { harness: opts.harness };
}
```

Use `run.harness` for the label and the note; pass `tier: run.tier, model: run.model, effort: run.effort` to `sessions.start`.

- [ ] **Step 3:** MCP tool: change the schema to `{ repo, bead_id, tier: tierEnum.optional(), harness: harness.optional(), instructions: ..., batch_id: ... }` where `tierEnum = z.enum(['chore','standard','hard','critic'])` (workers never use `critic`, but validation stays simple; document in the description that `critic` is internal). Return `{ session_id, bead_id, harness: run.harness, model, tier }` — have `spawnWorker` return `{ id, harness, model, tier }` or expose them via the session row read after start.
- [ ] **Step 4:** Tests. Lifecycle: seed default tiers; `spawnWorker('r1','ov-1',{tier:'standard'})` starts a codex session with `model: 'gpt-5.6-terra'` (register a `codex: fake2` adapter in the test setup, or map both names to one fake — see note); a second dispatch after the first with `previousModels` containing terra and `stepUp:true` resolves `gpt-5.6-sol`; `spawnWorker('r1','ov-1',{harness:'claude'})` starts with null model. MCP: `spawn_worker` with `tier:'chore'` returns `harness:'codex', model:'gpt-5.6-luna'`.

  **Test-setup note:** the fake adapter has a fixed `name='claude'`. Add a `codex` entry to the `adapters` map in the daemon test setups pointing at a second `FakeAdapter` whose `name` is overridden to `'codex'` (allow the constructor or a field to set the name), so tier resolution to codex can start. Keep this change minimal and local to test wiring.

- [ ] **Step 5:** Run and commit.

```json:metadata
{"files": ["packages/daemon/src/lifecycle/lifecycle.ts", "packages/daemon/src/mcp/tools.ts", "packages/daemon/src/lifecycle/lifecycle.test.ts", "packages/daemon/src/mcp/mcp.test.ts", "packages/daemon/src/harness/fake.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run \"lifecycle|mcp\"", "acceptanceCriteria": ["tier resolves to harness/model with step-up/fallback", "harness-only keeps CLI default", "label + return reflect resolved harness"], "modelTier": "frontier"}
```

---

### Task 7: Review round — critic session and verdict

**Goal:** After a worker's verification passes, start a critic session against the diff instead of landing immediately; land on `pass`, re-dispatch (stepped up) on findings below the limit, park the bead on findings at the limit. Add `submit_review` and `accept_review`.

**Files:**
- Modify: `packages/daemon/src/lifecycle/lifecycle.ts`
- Create: `packages/daemon/prompts/critic.md`
- Modify: `packages/daemon/src/mcp/tools.ts`
- Modify: `packages/daemon/src/lifecycle/lifecycle.test.ts`
- Modify: `packages/daemon/src/mcp/mcp.test.ts`

**Acceptance Criteria:**
- [ ] With `repo.review_rounds > 0`, a verify pass starts a critic session (role `critic`, tier `critic`, `excludeModel` = the worker's model) with a prompt carrying the diff, and does not land yet; `review_round` is incremented.
- [ ] `submit_review(verdict, findings)` from the critic: `pass` lands via the existing path (notice names the critic model); `findings` below the limit re-dispatches the worker with `stepUp: true` and the findings as instructions; `findings` at the limit sets the bead to `awaiting_decision` with `review_findings` stored and a wake notice carrying the findings.
- [ ] A critic session that ends without `submit_review` counts as one `must` finding (its last text).
- [ ] The critic's working-tree edits are discarded (`git checkout -- . && git clean -fd` in the worktree) before landing.
- [ ] `accept_review(repo, bead_id, note)` lands the bead through the existing path, stores `accepted_note`, resets `review_round`.
- [ ] `review_rounds = 0` lands immediately with no critic (current behaviour).
- [ ] Both batch and non-batch beads run the round (non-batch: review before `request_merge` eligibility — see step note).

**Verify:** `pnpm --filter @overseer/daemon exec vitest run "lifecycle|mcp"` → PASS

**Steps:**

- [ ] **Step 1: critic.md.** Write the prompt: role (a reviewer, not an implementer), inputs (bead title, worker's final message, instructions, unified diff), the read-only rule (may read files and run tests, must not edit or commit), and the instruction to end by calling `submit_review` with `verdict` and `findings`. Plain prose; no markdown the chat can't render is needed here since it is a system prompt for the critic, not the user chat.

- [ ] **Step 2: start the critic.** Add a `startReview(repo, wt, beadId, workerModel)` method. It sets phase/card to reviewing (a bd `store.update` with a note is not needed every round; use `db.worktrees.update(beadId, { review_round: (prev+1) })` and emit board; the card state derives from a new signal — see Task 9). Build the critic prompt via a small `buildCriticPrompt(template, { bead, diff, instructions, workerText })` (diff from `diffAgainstBase(wt.path, wt.base_branch)` for non-batch, or against the batch branch for batch beads). Resolve `critic` tier with `excludeModel: workerModel`. Start a `role:'critic'` session in the bead's worktree. Track the mapping session→bead so the settle handler routes critic ends.

- [ ] **Step 3: route critic ends.** In the bus `session:ended` handler, branch on `role === 'critic'` to a new `onCriticEnded(e)`. There, read the stored verdict (see step 4) or, if none, synthesize `{ verdict: 'findings', findings: [{ file: null, summary: e.lastText ?? 'critic ended without a verdict', severity: 'must' }] }`. Then apply the outcome (step 5).

- [ ] **Step 4: submit_review tool.** Register `submit_review` in MCP with `{ verdict: z.enum(['pass','findings']), findings: z.array(...).optional() }`. It records the verdict on the critic's worktree/session context (store on a `Map<sessionId, Review>` in Lifecycle keyed like `stops`, resolved from the current critic session for the bead) and returns `{ recorded: true }`. Expose it only to critic sessions: since every MCP request builds its own server (`registerTools`), gating by role requires knowing the caller. Simplest available mechanism: accept the call from anyone but have it no-op with an error unless a critic session is currently active for that bead. Document that the orchestrator never calls it. (Do not over-engineer per-role MCP configs.)

- [ ] **Step 5: apply outcome.** New `applyReview(repo, wt, beadId, review)`:
  - Discard critic edits: `await git(wt.path, ['checkout','--','.'])` then `await git(wt.path, ['clean','-fd'])`, logging on error.
  - `pass`: call the existing landing path (`integrate` for batch beads is already past verify — refactor so the land-after-verify step is callable directly: extract the "verify passed → merge/land" tail of `integrate` into `landVerified(repo, wt, beadId, batch, criticModel?)`, and have both the no-review path and `applyReview` call it). Notice names the critic model.
  - `findings`, `review_round < repo.review_rounds`: re-dispatch via `spawnWorker(repo.id, beadId, { tier: <bead's tier>, stepUp: true, instructions: renderFindings(findings), batchId: wt.batch_id ?? undefined })`. Queued notice.
  - `findings`, `review_round >= repo.review_rounds`: `db.worktrees.update(beadId, { review_findings: findings })`, leave the bead open (status open, phase null) but flag awaiting decision via a `review_findings` presence signal, and wake-notify with the findings text and the hint to discuss then call `spawn_worker` or `accept_review`.

- [ ] **Step 6: wire review into settle.** In `settleWorker`, where a batch bead currently calls `integrate` and a non-batch bead calls `verify(...'review')`: after a `pass` verify, if `repo.review_rounds > 0`, call `startReview` instead of landing/marking review; else land as today. For batch beads, `integrate` must stop after the verify-pass and hand off to the review round (restructure so the merge happens only in `landVerified`).

- [ ] **Step 7: accept_review tool + lifecycle.** `lifecycle.acceptReview(repo, beadId, note)`: resolve the worktree, call `landVerified` with a null critic model, set `accepted_note`, reset `review_round` to null, clear `review_findings`. MCP `accept_review(repo, bead_id, note)` wraps it. Notice: "landed with open findings by the user through the orchestrator".

- [ ] **Step 8: tests.** Lifecycle with `review_rounds` (default 2) and both fake adapters: worker commits + verify pass → a critic session exists and the bead is not landed; emit `submit_review pass` via the MCP client (or call the lifecycle verdict path directly in a lifecycle unit test) → bead lands, notice names critic; findings once → worker re-dispatched with stepped tier and findings in the prompt; findings twice → `review_findings` set, wake notice fired, bead not landed; `acceptReview` → lands with `accepted_note`; a critic that ends with no verdict → treated as findings; `review_rounds = 0` → lands with no critic session; critic edits in the worktree are gone after landing. Add MCP tests for `submit_review` and `accept_review`.

- [ ] **Step 9: Run and commit.**

```json:metadata
{"files": ["packages/daemon/src/lifecycle/lifecycle.ts", "packages/daemon/prompts/critic.md", "packages/daemon/src/mcp/tools.ts", "packages/daemon/src/lifecycle/lifecycle.test.ts", "packages/daemon/src/mcp/mcp.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run \"lifecycle|mcp\"", "acceptanceCriteria": ["critic runs on verify pass and gates landing", "pass lands, findings re-dispatch stepped-up, limit parks the bead", "no verdict = findings; critic edits discarded", "accept_review lands with note; review_rounds=0 skips"], "modelTier": "frontier"}
```

---

### Task 8: Crash recovery and Stop for critic sessions

**Goal:** A critic session found dead on restart is restarted; Stop worker on a reviewing bead stops the critic and reopens the bead. Batches count reviewing/awaiting beads as not landed.

**Files:**
- Modify: `packages/daemon/src/lifecycle/lifecycle.ts`
- Modify: `packages/daemon/src/lifecycle/lifecycle.test.ts`

**Acceptance Criteria:**
- [ ] `recover()` restarts a critic session (re-runs `startReview` for its bead) instead of routing it through the worker-ended path.
- [ ] `interruptBead` on a bead whose current session is a critic stops it and reopens the bead with a "Stopped during review" note, without landing.
- [ ] `request_batch_review` / batch counts treat a bead with `review_round` set and not landed as not complete.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run lifecycle` → PASS

**Steps:**

- [ ] **Step 1:** In `recover()`, for `s.role === 'critic'` running sessions, after killing the pid and marking the row ended, re-invoke `startReview` for the bead (guarded), rather than `onWorkerEnded`.
- [ ] **Step 2:** In `interruptBead`, detect a critic session (the running session for the bead has `role: 'critic'`): stop it, and in `onCriticEnded` treat a stopped critic as "reopen without landing" (note "Stopped during review by the user"), not as findings.
- [ ] **Step 3:** Confirm the batch-complete check (in `batchCount`/`request_batch_review` guard) counts a bead with `review_round` set and no `merged_at`/`closed_at` as outstanding. Adjust if it currently keys only on merged/closed.
- [ ] **Step 4:** Tests for each of the three.
- [ ] **Step 5:** Run and commit.

```json:metadata
{"files": ["packages/daemon/src/lifecycle/lifecycle.ts", "packages/daemon/src/lifecycle/lifecycle.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run lifecycle", "acceptanceCriteria": ["dead critic restarted", "stop during review reopens without landing", "reviewing bead counts as outstanding for its batch"], "modelTier": "standard"}
```

---

### Task 9: Board card states, chip fields, and chat-parity MCP tools + prompt

**Goal:** Compute `reviewing`/`awaiting_decision` states and the `tier`/`model`/`findings`/`accepted_note` fields on `BoardCard`; add the five parity MCP tools; update the orchestrator prompt.

**Files:**
- Modify: `packages/daemon/src/api/board.ts`
- Modify: `packages/daemon/src/mcp/tools.ts`
- Modify: `packages/daemon/prompts/orchestrator.md`
- Modify: `packages/daemon/src/api/board.test.ts` (or nearest), `packages/daemon/src/mcp/mcp.test.ts`

**Acceptance Criteria:**
- [ ] A bead with a running critic session → `state: 'reviewing'`; a bead with `review_findings` set and not landed → `state: 'awaiting_decision'`.
- [ ] `BoardCard` carries `tier`/`model` from the last session, `findings` from the worktree, `accepted_note`.
- [ ] MCP `merge_batch`, `reject_batch`, `abandon_batch`, `close_bead`, `retry_verification` wrap the matching lifecycle methods and post notices worded "by the user through the orchestrator".
- [ ] The orchestrator prompt documents `tier` on `spawn_worker`, the review round, and the parity tools with the "only after the user asked; confirm merge/abandon" rule.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run "board|mcp"` → PASS

**Steps:**

- [ ] **Step 1: board state.** In `cardsFor`, compute reviewing (`s?.role === 'critic' && s.status === 'running'`) and awaiting (`wt?.review_findings && !wt.merged_at && bead.status !== 'closed'`) before the existing chain; slot them into the `state` derivation. Add `tier: s?.tier ?? null, model: s?.model ?? null, findings: wt?.review_findings ?? null, accepted_note: wt?.accepted_note ?? null` to the returned card. Note the worker/critic role: the card's `harness`/`model` should reflect the last worker, not the critic, for the tier chip — pick the last `role:'worker'` session for `tier`/`model`.
- [ ] **Step 2: parity tools.** Add the five tools, each `guard`-wrapped, calling `d.lifecycle.mergeBatch(...)` etc. Post the notice via `d.lifecycle`/`notify` already done inside those methods; if a method does not already notify with the right wording, pass a flag or add a short "through the orchestrator" note. Keep bd writes to the existing one per transition.
- [ ] **Step 3: prompt.** Edit `orchestrator.md` per the spec: `spawn_worker(repo, bead_id, tier, instructions?, batch_id?)` line with the tier-choice sentence; a review-round paragraph; a parity-tools paragraph; rewrite the "you cannot close beads / merge" sentences to name the buttons as the alternative.
- [ ] **Step 4: tests.** Board: a reviewing card and an awaiting card render the right state and carry findings. MCP: each parity tool calls through (assert lifecycle side effect and a notice). Update the "lists the N tools" count test.
- [ ] **Step 5: Run and commit.**

```json:metadata
{"files": ["packages/daemon/src/api/board.ts", "packages/daemon/src/mcp/tools.ts", "packages/daemon/prompts/orchestrator.md", "packages/daemon/src/mcp/mcp.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run \"board|mcp\"", "acceptanceCriteria": ["reviewing/awaiting states + chip fields", "five parity tools call through with correct notices", "prompt documents tier, review, parity"], "modelTier": "frontier"}
```

---

### Task 10: REST — settings routes, repo review_rounds, accept-review

**Goal:** Expose the settings and the new repo field and card action over REST, with validation and the Astra refusal.

**Files:**
- Modify: `packages/daemon/src/api/rest.ts`
- Modify: `packages/daemon/src/api/rest.test.ts` (create if missing — see note) or `packages/daemon/src/app.test.ts`

**Acceptance Criteria:**
- [ ] `GET /api/settings/orchestrator` and `PUT` (zod: model/effort/promptOverride nullable) round-trip; PUT response includes `{ applies_to: 'next-session' }`.
- [ ] `GET /api/settings/tiers` and `PUT` validate the tier shape; a PUT naming a denied model returns 400 with the model named; unknown tier name returns 400.
- [ ] `PATCH /api/repos/:id` accepts `review_rounds` (int 0–5).
- [ ] `POST /api/tasks/:id/accept-review` with `{ note }` calls `lifecycle.acceptReview`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run "rest|app"` → PASS

**Steps:**

- [ ] **Step 1:** Add `review_rounds: z.number().int().min(0).max(5).optional()` to `repoFields`.
- [ ] **Step 2:** Add the four settings/action routes. For tiers PUT, after zod-parsing, reject if any candidate's model is in the submitted (or stored) `denyModels`; validate tier names against the fixed set; then `db.settings.set('tiers', body)`. Orchestrator PUT: `db.settings.set('orchestrator', body)`; return `{ ...body, applies_to: 'next-session' }`.
- [ ] **Step 3:** Tests: round-trip both settings; Astra in a tier → 400; `review_rounds` PATCH persists; accept-review route calls through.

  **Test note:** if `rest.test.ts` does not exist, add these assertions to `app.test.ts` (which already boots the app with `buildApp`), using `app.inject`.

- [ ] **Step 4:** Run and commit.

```json:metadata
{"files": ["packages/daemon/src/api/rest.ts", "packages/daemon/src/app.test.ts"], "verifyCommand": "pnpm --filter @overseer/daemon exec vitest run \"rest|app\"", "acceptanceCriteria": ["settings routes round-trip", "Astra + unknown tier refused", "review_rounds PATCH", "accept-review route"], "modelTier": "standard"}
```

---

### Task 11: Web — Setup Models section (orchestrator + tiers) and API client

**Goal:** A "Models" section in Setup to edit the orchestrator model/effort/prompt and the tier candidates, saved via the new routes.

**Files:**
- Modify: `packages/web/src/views/Setup.tsx`
- Create: `packages/web/src/components/ModelsSettings.tsx`
- Modify: `packages/web/src/api.ts` (types only if needed)
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/src/views/Setup.test.tsx` (or a new `ModelsSettings.test.tsx`)

**Acceptance Criteria:**
- [ ] The section loads both settings on mount and renders the orchestrator block (model text, effort select with a blank "CLI default", prompt override textarea with a reset link) and a tiers table (per tier: candidates with harness select, model text, effort select; add/remove/move).
- [ ] Save posts to the two PUT routes and shows the "Applies to the next orchestrator session" line with a "Reset now" link that calls `POST /api/orchestrator/reset`.
- [ ] Editing is per block (orchestrator save, tiers save).

**Verify:** `pnpm --filter @overseer/web test -- Setup` (or `ModelsSettings`) → PASS

**Steps:**

- [ ] **Step 1:** Build `ModelsSettings.tsx` as a self-contained component fetching `/settings/orchestrator` and `/settings/tiers`, with local state and the two save handlers. Follow the RepoForm pattern for inputs and `api.patch`/`api.put` usage (add `put` to the api client if absent — check `api.ts`; it has `post`/`patch`/`delete`; add a `put` mirroring `patch`).
- [ ] **Step 2:** Render it in `Setup.tsx` above the Repositories `<h2>`.
- [ ] **Step 3:** Styles for the tiers table, reusing existing tokens.
- [ ] **Step 4:** Test with `mockApi`: renders seeded values, edits a tier model, Save issues the PUT with the changed body; the reset link posts to the reset route.
- [ ] **Step 5:** Run and commit.

```json:metadata
{"files": ["packages/web/src/views/Setup.tsx", "packages/web/src/components/ModelsSettings.tsx", "packages/web/src/api.ts", "packages/web/src/styles.css", "packages/web/src/views/Setup.test.tsx"], "verifyCommand": "pnpm --filter @overseer/web test -- Setup", "acceptanceCriteria": ["orchestrator + tiers editable and saved", "next-session line + reset link"], "modelTier": "standard"}
```

---

### Task 12: Web — repo form review rounds

**Goal:** A "Review rounds" field in the repo add/edit form.

**Files:**
- Modify: `packages/web/src/components/RepoForm.tsx`
- Test: `packages/web/src/components/RepoForm.test.tsx` (or the Setup test that covers the form)

**Acceptance Criteria:**
- [ ] The form shows a numeric "Review rounds" input (0–5), defaulting to the repo's value or 2.
- [ ] Save includes `review_rounds` in the PATCH/POST body.

**Verify:** `pnpm --filter @overseer/web test -- RepoForm` → PASS (or the Setup test file)

**Steps:**

- [ ] **Step 1:** Add `const [rounds, setRounds] = useState(String(existing?.review_rounds ?? 2));` and a `<label>Review rounds<input aria-label="Review rounds" type="number" min={0} max={5} .../></label>` next to the Verify command field.
- [ ] **Step 2:** Include `review_rounds: Number(rounds)` in the `fields` object.
- [ ] **Step 3:** Test the field renders and is sent.
- [ ] **Step 4:** Run and commit.

```json:metadata
{"files": ["packages/web/src/components/RepoForm.tsx", "packages/web/src/components/RepoForm.test.tsx"], "verifyCommand": "pnpm --filter @overseer/web test -- RepoForm", "acceptanceCriteria": ["review rounds field renders and is sent"], "modelTier": "mechanical"}
```

---

### Task 13: Web — card chip, reviewing/awaiting states and pane actions

**Goal:** Show the tier/model chip; render the reviewing and awaiting-decision states with the right actions, including "Land anyway".

**Files:**
- Modify: `packages/web/src/components/Card.tsx`
- Modify: `packages/web/src/views/Board.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/src/views/Board.test.tsx`

**Acceptance Criteria:**
- [ ] A card with `tier`/`model` shows a chip like `standard · gpt-5.6-terra`.
- [ ] `reviewing` renders like Verifying with "reviewed by <model>"; the pane shows the critic is running and offers Stop worker.
- [ ] `awaiting_decision` sorts to the top of its column with an amber rule and a "needs decision" chip; the pane lists `findings` and offers Re-dispatch, Close bead, and **Land anyway** (a note prompt → `POST /api/tasks/:id/accept-review`).
- [ ] Actions are disabled during an outage, like the existing ones.

**Verify:** `pnpm --filter @overseer/web test -- Board` → PASS

**Steps:**

- [ ] **Step 1:** Card chip: add `{card.tier && card.model && <span className="chip">{card.tier} · {card.model}</span>}` in `card-meta`. Add an amber `card-awaiting` class when `card.state === 'awaiting_decision'`.
- [ ] **Step 2:** Board pane: add branches for `reviewing` (muted "reviewing… a <model> critic is checking the change") and `awaiting_decision` (render `detail.worktree?.review_findings` / `card.findings` as a list, plus buttons). Add `act('accept-review', note)` wired to the new route with a note prompt reusing the Close-bead note pattern.
- [ ] **Step 3:** Sorting: extend `failedFirst` (or the column sort) so `awaiting_decision` sorts first alongside `verify_failed`.
- [ ] **Step 4:** Styles for `card-awaiting` and the findings list.
- [ ] **Step 5:** Tests: a reviewing card, an awaiting card with findings and the three buttons, Land anyway posts to accept-review.
- [ ] **Step 6:** Run and commit.

```json:metadata
{"files": ["packages/web/src/components/Card.tsx", "packages/web/src/views/Board.tsx", "packages/web/src/styles.css", "packages/web/src/views/Board.test.tsx"], "verifyCommand": "pnpm --filter @overseer/web test -- Board", "acceptanceCriteria": ["tier/model chip", "reviewing + awaiting states render", "Land anyway posts accept-review", "outage disables actions"], "modelTier": "frontier"}
```

---

### Task 14: Web — Review "landed with open findings" and Rail model

**Goal:** Show accepted-with-findings beads in the Review batch summary and the orchestrator model in the Rail.

**Files:**
- Modify: `packages/web/src/views/Review.tsx`
- Modify: `packages/web/src/components/Rail.tsx`
- Test: `packages/web/src/views/Review.test.tsx`

**Acceptance Criteria:**
- [ ] A bead with `accepted_note` is shown under "landed with open findings" in the batch bead list with its note and findings.
- [ ] The Rail status line shows the orchestrator model when present, e.g. `orchestrator: idle · fable`.

**Verify:** `pnpm --filter @overseer/web test -- "Review|Rail"` → PASS

**Steps:**

- [ ] **Step 1:** Review: in the bead list, when `c.accepted_note` is set, label it "landed with open findings" and render the note and `c.findings`.
- [ ] **Step 2:** Rail: append `{orch?.model ? ` · ${orch.model}` : ''}` to the status line (guard for offline).
- [ ] **Step 3:** Tests.
- [ ] **Step 4:** Run and commit.

```json:metadata
{"files": ["packages/web/src/views/Review.tsx", "packages/web/src/components/Rail.tsx", "packages/web/src/views/Review.test.tsx"], "verifyCommand": "pnpm --filter @overseer/web test -- \"Review|Rail\"", "acceptanceCriteria": ["accepted-with-findings shown in Review", "Rail shows orchestrator model"], "modelTier": "mechanical"}
```

---

### Task 15: Full suite, typecheck, docs and smoke step

**Goal:** Everything green together, and the docs reflect the new behaviour.

**Files:**
- Modify: `CLAUDE.md` (smoke script + harness-status Codex note), `README.md` (models section)
- Modify: `docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md` only if a documented behaviour changed materially (optional; note in the commit if skipped).

**Acceptance Criteria:**
- [ ] `pnpm -r test` passes with no warnings.
- [ ] `pnpm -r typecheck` passes.
- [ ] `CLAUDE.md` documents tiers, review rounds and the parity tools; the smoke script gains a review step and sets `review_rounds`; the stale "Codex not installed" note is corrected.
- [ ] `README.md` describes the Models settings.

**Verify:** `pnpm -r test && pnpm -r typecheck` → PASS

**Steps:**

- [ ] **Step 1:** `pnpm -r test` and `pnpm -r typecheck`; fix any cross-package fallout (shared type changes ripple to web).
- [ ] **Step 2:** Update `CLAUDE.md`: the daemon-layout bullets for tiers/settings/review; correct the harness-status Codex line ("Codex CLI 0.154.0 installed; models gpt-5.6-luna/terra/sol"); add a smoke step: set `review_rounds` to 1 for the demo repo and show a critic round.
- [ ] **Step 3:** Update `README.md` with a short "Models and review" section.
- [ ] **Step 4:** Commit.

```json:metadata
{"files": ["CLAUDE.md", "README.md"], "verifyCommand": "pnpm -r test && pnpm -r typecheck", "acceptanceCriteria": ["whole suite + typecheck green", "docs updated", "smoke script has a review step"], "modelTier": "standard"}
```

---

## Self-Review

- **Spec coverage:** settings/data model (T1), resolveTier (T2), adapters (T3), session plumbing (T4), orchestrator settings + status (T5), spawn_worker tier (T6), review round + submit/accept (T7), recovery/stop/batch-count (T8), board states + parity tools + prompt (T9), REST (T10), Setup UI (T11), repo form (T12), card/pane (T13), Review/Rail (T14), tests/docs/smoke (T15). All spec sections map to a task.
- **Placeholder scan:** each code step carries concrete code or an exact edit. The one genuinely open implementation choice — how `submit_review` is gated to critic sessions — is spelled out as "no-op unless a critic session is active for that bead", not left as TODO.
- **Type consistency:** `resolveTier`, `TierCandidate`, `TierSettings`, `Finding`, `review_round`, `review_findings`, `accepted_note`, `acceptReview`, `landVerified`, `startReview` are used consistently across tasks.
