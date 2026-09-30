# Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load `andrej-karpathy-skills:karpathy-guidelines` first.

**Goal:** Stop dispatch while a repo's verify command fails on its own base branch, and classify worker crashes so a transient stream failure retries once and a harness bug never retries.

**Architecture:** A `Prober` (`lifecycle/probe.ts`) runs setup + verify in a throwaway detached worktree at the base head, stores each run in `preflight_runs`, and flips `repos.verify_suspect`. `Lifecycle.spawnWorker` refuses while the flag is set; every dispatch path (orchestrator, Board re-dispatch, rate-limit and crash retries) goes through it. A pure `classifyExit` (`lifecycle/crash.ts`) is called in `settleWorker`'s no-commits branch; the class is stored on `sessions.crash_class` and as a `crash` batch signal.

**Tech Stack:** TypeScript, Fastify, node:sqlite, vitest, React.

**Spec:** `docs/superpowers/specs/2026-09-16-preflight-design.md`

## Global Constraints

- Schema changes only through `SCHEMA` (new table) and `ADDED_COLUMNS` (new columns) in `packages/daemon/src/db/schema.ts`.
- Tests use real git repos (`src/test/tmpgit.ts`), `:memory:` SQLite, the fake adapter; test output stays free of warnings.
- Notice text is third person about the user; model guidance goes in `hint` only.
- Commits: Conventional Commits with explicit paths; never commit `docs/superpowers/plans/*.tasks.json`.
- Focused tests: `pnpm --filter @overseer/daemon exec vitest run <pattern>`; `pnpm --filter @overseer/web test -- <pattern>`.
- Refusal text, exactly: `verify command "<command>" exits <code> on <base> at <short sha>; fix it in Setup → Edit, then Re-probe` (`<code>` is `timed out` for a timeout).

**User decisions (already made):**
- A probe failure refuses dispatch and notifies (no warn-only mode, no force override).
- A transient crash retries automatically once on the same harness and model.
- Port reaping, dependency checks, commitlint, network checks and a Claude Code hook are out of scope.

**Refinements to the spec found while planning:**
- Plan approval does not dispatch (it only creates beads), so the gate in `spawnWorker` covers every dispatch path; no separate plan-approval gate.
- The probe uses a fresh detached worktree (`<worktreesDir>/<repo id>/probe`, `git worktree add --detach`), not the merge base worktree: a detached checkout never collides with the base branch being checked out in the primary checkout, and it cannot leave the merge worktree dirty.
- A probe result is `pass | fail | timeout | error`; `fail` and `timeout` set the flag, `error` (probe could not start) does not.

---

### Task 1: Schema, types and DAO

**Goal:** Add `preflight_runs`, `repos.verify_suspect`, `sessions.crash_class`, the `crash` signal kind and their shared types.

**Files:**
- Modify: `packages/daemon/src/db/schema.ts`
- Modify: `packages/daemon/src/db/db.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/daemon/src/db/db.test.ts`

**Acceptance Criteria:**
- [ ] `openDb(':memory:')` creates `preflight_runs`; an existing DB gains `repos.verify_suspect` and `sessions.crash_class`.
- [ ] `db.preflight.insert/finish/latest/recent` round-trip a run.
- [ ] `BatchSignalKind` includes `'crash'`; `Repo` has `verify_suspect: number | null`; `SessionRow` has `crash_class: CrashClass | null`.
- [ ] `pnpm typecheck` passes.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run db.test` → PASS; `pnpm typecheck` → exit 0

**Steps:**

- [ ] **Step 1: Write the failing test** (append to `db.test.ts`, reuse its imports)

```ts
describe('preflight runs', () => {
  it('records a probe run and finishes it', () => {
    const db = openDb(':memory:');
    db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: 'x', setup_command: null, merge_mode: 'local-merge', worker_limit: 1, review_rounds: 0 });
    const run = db.preflight.insert({ repo_id: 'r1', kind: 'verify_probe', command: 'x', head_sha: 'abc1234' });
    expect(db.preflight.latest('r1')).toMatchObject({ id: run.id, result: null });
    db.preflight.finish(run.id, { result: 'fail', exit_code: 1, output_tail: 'exit 1' });
    expect(db.preflight.latest('r1')).toMatchObject({ result: 'fail', exit_code: 1, output_tail: 'exit 1' });
    expect(db.preflight.recent('r1', 20)).toHaveLength(1);
    expect(db.repos.get('r1')!.verify_suspect).toBeNull();
  });
});
```

- [ ] **Step 2: Run it** — `pnpm --filter @overseer/daemon exec vitest run db.test` → FAIL (`db.preflight` undefined).

- [ ] **Step 3: Implement**

`schema.ts`, inside `SCHEMA` before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS preflight_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL,
  head_sha TEXT, result TEXT, exit_code INTEGER, output_tail TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE INDEX IF NOT EXISTS preflight_runs_repo ON preflight_runs(repo_id, id);
```

`ADDED_COLUMNS`, append:

```ts
  { table: 'repos', column: 'verify_suspect', ddl: 'INTEGER' },
  { table: 'sessions', column: 'crash_class', ddl: 'TEXT' },
```

`shared/src/index.ts`:

```ts
// in Repo, after review_rounds:
  /** The id of the failing `preflight_runs` row while the verify command fails on the base branch; null: dispatch allowed. */
  verify_suspect?: number | null;
// in SessionRow:
  crash_class?: CrashClass | null;
// new exports:
export type CrashClass = 'harness_bug' | 'transient' | 'task';
export type PreflightResult = 'pass' | 'fail' | 'timeout' | 'error';
export interface PreflightRun { id: number; repo_id: string; kind: 'verify_probe'; command: string; head_sha: string | null; result: PreflightResult | null; exit_code: number | null; output_tail: string | null; started_at: string; ended_at: string | null }
export interface PreflightReport { runs: PreflightRun[]; crashes: { harness: HarnessName; crash_class: CrashClass; count: number }[] }
// BatchSignalKind gains 'crash':
export type BatchSignalKind = 'rejection' | 'reopen' | 'redispatch' | 'closed' | 'correction' | 'crash';
```

(`verify_suspect`/`crash_class` are optional so existing object literals in tests keep compiling.)

`db.ts`, next to `signals`:

```ts
  preflight = {
    insert: (r: { repo_id: string; kind: 'verify_probe'; command: string; head_sha: string | null }): PreflightRun => {
      const started_at = now();
      const x = this.sql.prepare('INSERT INTO preflight_runs (repo_id,kind,command,head_sha,started_at) VALUES (?,?,?,?,?)').run(r.repo_id, r.kind, r.command, r.head_sha, started_at);
      return { id: Number(x.lastInsertRowid), ...r, result: null, exit_code: null, output_tail: null, started_at, ended_at: null };
    },
    finish: (id: number, f: { result: PreflightResult; exit_code: number | null; output_tail: string }) =>
      this.sql.prepare('UPDATE preflight_runs SET result=?, exit_code=?, output_tail=?, ended_at=? WHERE id=?').run(f.result, f.exit_code, f.output_tail, now(), id),
    latest: (repoId: string) => this.sql.prepare('SELECT * FROM preflight_runs WHERE repo_id=? ORDER BY id DESC LIMIT 1').get(repoId) as PreflightRun | undefined,
    get: (id: number) => this.sql.prepare('SELECT * FROM preflight_runs WHERE id=?').get(id) as PreflightRun | undefined,
    recent: (repoId: string, limit: number) => this.sql.prepare('SELECT * FROM preflight_runs WHERE repo_id=? ORDER BY id DESC LIMIT ?').all(repoId, limit) as unknown as PreflightRun[],
    crashCounts: (repoId: string) => this.sql.prepare("SELECT harness, crash_class, COUNT(*) AS count FROM sessions WHERE repo_id=? AND crash_class IS NOT NULL GROUP BY harness, crash_class ORDER BY harness, crash_class").all(repoId) as unknown as PreflightReport['crashes'],
  };
```

Import `PreflightRun`, `PreflightResult`, `PreflightReport` from `@overseer/shared`. If `repos.delete` removes dependent rows elsewhere, also `DELETE FROM preflight_runs WHERE repo_id=?` there.

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run db.test` → PASS; `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/db/schema.ts packages/daemon/src/db/db.ts packages/daemon/src/db/db.test.ts packages/shared/src/index.ts
git commit -m "feat(db): add preflight runs, verify_suspect and crash_class"
```

---

### Task 2: Prober

**Goal:** `Prober.probe(repoId)` runs setup + verify in a detached worktree at the base head, records the run, sets or clears `verify_suspect`, and notifies once on the transition to suspect.

**Files:**
- Create: `packages/daemon/src/lifecycle/probe.ts`
- Test: `packages/daemon/src/lifecycle/probe.test.ts`

**Acceptance Criteria:**
- [ ] `node -e "process.exit(1)"` → run `fail`, `exit_code` 1, `verify_suspect` = run id, exactly one notice containing the refusal text, one push.
- [ ] A second failing probe keeps the flag and sends no second notice.
- [ ] `node -e "process.exit(0)"` afterwards → run `pass`, flag null.
- [ ] No verify command → no run, flag null.
- [ ] A missing base branch → run `error`, flag unchanged, no notice.
- [ ] A failing setup command → run `fail` with the setup output.
- [ ] The probe worktree is removed after every run; concurrent `probe()` calls for one repo run one after the other and the last result wins.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run probe.test` → PASS

**Steps:**

- [ ] **Step 1: Write the failing tests** (`probe.test.ts`)

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { mkTmpRepo, sh } from '../test/tmpgit';
import { Prober, refusalText } from './probe';

function setup(verify: string | null, patch: Partial<Repo> = {}) {
  const t = mkTmpRepo();
  const db = openDb(':memory:');
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: verify, setup_command: null, merge_mode: 'local-merge', worker_limit: 1, review_rounds: 0, ...patch };
  db.repos.insert(repo);
  const notes: string[] = []; const pushes: string[] = [];
  const prober = new Prober({ db, bus: new Bus(), worktreesDir: t.worktreesDir,
    notify: async (m) => { notes.push(m); }, push: { notify: async (m: { title: string }) => { pushes.push(m.title); return []; } } as never });
  return { db, prober, notes, pushes, t };
}

describe('Prober', () => {
  it('flags a verify command that fails on the base branch and notifies once', async () => {
    const x = setup('node -e "process.exit(1)"');
    await x.prober.probe('r1');
    const run = x.db.preflight.latest('r1')!;
    expect(run).toMatchObject({ result: 'fail', exit_code: 1 });
    expect(x.db.repos.get('r1')!.verify_suspect).toBe(run.id);
    const sha = sh(x.t.path, ['rev-parse', '--short', 'main']);
    expect(x.notes).toHaveLength(1);
    expect(x.notes[0]).toContain(`verify command "node -e "process.exit(1)"" exits 1 on main at ${sha}`);
    expect(x.pushes).toEqual(['r1: verify command fails on main']);
    await x.prober.probe('r1');
    expect(x.notes).toHaveLength(1);
    expect(fs.existsSync(path.join(x.t.worktreesDir, 'r1', 'probe'))).toBe(false);
  });

  it('clears the flag when the command passes', async () => {
    const x = setup('node -e "process.exit(1)"');
    await x.prober.probe('r1');
    x.db.repos.update('r1', { verify_command: 'node -e "process.exit(0)"' });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')!.result).toBe('pass');
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
  });

  it('records nothing and clears the flag without a verify command', async () => {
    const x = setup(null);
    x.db.repos.update('r1', { verify_suspect: 99 });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')).toBeUndefined();
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
  });

  it('records a probe that cannot start as an error without flagging the repo', async () => {
    const x = setup('node -e "process.exit(1)"', { base_branch: 'nope' });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')!.result).toBe('error');
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
    expect(x.notes).toEqual([]);
  });

  it('fails the probe on a failing setup command', async () => {
    const x = setup('node -e "process.exit(0)"', { setup_command: 'node -e "process.exit(4)"' });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')).toMatchObject({ result: 'fail', exit_code: 4 });
  });

  it('runs concurrent probes one after the other; the last result wins', async () => {
    const x = setup('node -e "process.exit(1)"');
    const first = x.prober.probe('r1');
    x.db.repos.update('r1', { verify_command: 'node -e "process.exit(0)"' });
    await Promise.all([first, x.prober.probe('r1')]);
    expect(x.db.preflight.recent('r1', 5).map((r) => r.result)).toEqual(['pass', expect.any(String)]);
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
  });

  it('words the refusal', () => {
    expect(refusalText({ command: 'c', exit_code: null, result: 'timeout', head_sha: 'abcdef1234' }, 'main')).toBe('verify command "c" exits timed out on main at abcdef1; fix it in Setup → Edit, then Re-probe');
  });
});
```

Check `../bus` is the real import path of `Bus` (as in `lifecycle.test.ts`) and adjust if not.

- [ ] **Step 2: Run** `pnpm --filter @overseer/daemon exec vitest run probe.test` → FAIL (module not found).

- [ ] **Step 3: Implement** `probe.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { PreflightResult, PreflightRun } from '@overseer/shared';
import type { Db } from '../db/db';
import type { Bus } from '../bus';
import type { Push } from '../push/push';
import { git, removeWorktree } from '../git/git';
import { log } from '../util/log';
import { runSetup, runVerify, type VerifyResult } from './verify';

export interface ProberDeps { db: Db; bus: Bus; worktreesDir: string; notify: (text: string, opts?: { wake?: boolean; hint?: string }) => Promise<void>; push?: Push }

/** The reason `spawnWorker` refuses a dispatch while a repo's verify command fails on its own base branch. */
export const refusalText = (run: Pick<PreflightRun, 'command' | 'exit_code' | 'result' | 'head_sha'>, base: string) =>
  `verify command "${run.command}" exits ${run.result === 'timeout' ? 'timed out' : run.exit_code} on ${base} at ${(run.head_sha ?? '?').slice(0, 7)}; fix it in Setup → Edit, then Re-probe`;

/** `runShell` ends its output with `exit <code>` or `(timed out)`. */
function outcome(r: VerifyResult): { result: PreflightResult; exit_code: number | null } {
  if (r.output.endsWith('(timed out)')) return { result: 'timeout', exit_code: null };
  const m = /exit (-?\d+|null)$/.exec(r.output);
  const code = m && m[1] !== 'null' ? Number(m[1]) : null;
  return { result: r.status === 'pass' ? 'pass' : 'fail', exit_code: code };
}

/** Runs the repo's setup and verify commands on its base head, so a command that can never pass stops dispatch before a worker runs. */
export class Prober {
  private chains = new Map<string, Promise<void>>();
  constructor(private d: ProberDeps) {}

  probe(repoId: string): Promise<void> {
    const next = (this.chains.get(repoId) ?? Promise.resolve()).then(() => this.run(repoId)).catch((err) => log.error(`probe: ${repoId} failed`, err));
    this.chains.set(repoId, next);
    return next;
  }

  private async run(repoId: string): Promise<void> {
    const { db, bus } = this.d;
    const repo = db.repos.get(repoId);
    if (!repo) return;
    if (!repo.verify_command) {
      if (repo.verify_suspect != null) { db.repos.update(repoId, { verify_suspect: null }); bus.emit('repos'); }
      return;
    }
    const command = repo.verify_command;
    const wtPath = path.join(this.d.worktreesDir, repoId, 'probe');
    let head: string | null = null;
    try { head = await git(repo.path, ['rev-parse', repo.base_branch]); } catch { /* recorded as an error below */ }
    const run = db.preflight.insert({ repo_id: repoId, kind: 'verify_probe', command, head_sha: head });
    let finished: { result: PreflightResult; exit_code: number | null; output_tail: string };
    try {
      if (!head) throw new Error(`base branch ${repo.base_branch} not found`);
      await git(repo.path, ['worktree', 'prune']);
      if (fs.existsSync(wtPath)) await removeWorktree(repo.path, wtPath, null);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      await git(repo.path, ['worktree', 'add', '--detach', wtPath, head]);
      const setup = repo.setup_command ? await runSetup(repo.setup_command, wtPath) : null;
      const result = setup && setup.status !== 'pass' ? setup : await runVerify(command, wtPath);
      finished = { ...outcome(result), output_tail: result.output.slice(-600) };
    } catch (err) {
      finished = { result: 'error', exit_code: null, output_tail: (err instanceof Error ? err.message : String(err)).slice(-600) };
    } finally {
      if (fs.existsSync(wtPath)) await removeWorktree(repo.path, wtPath, null).catch((err) => log.error(`probe: could not remove ${wtPath}`, err));
    }
    db.preflight.finish(run.id, finished);
    const was = db.repos.get(repoId)?.verify_suspect ?? null;
    if (finished.result === 'pass') {
      if (was != null) db.repos.update(repoId, { verify_suspect: null });
    } else if (finished.result !== 'error') {
      db.repos.update(repoId, { verify_suspect: run.id });
      if (was == null) {
        const reason = refusalText({ ...run, ...finished }, repo.base_branch);
        await this.d.notify(`Dispatch to ${repoId} is paused: ${reason}.`, { hint: 'Do not dispatch or re-dispatch beads of this repo; spawn_worker refuses until the user fixes the command and the probe passes. Tell the user once.' })
          .catch((err) => log.error('probe: notify failed', err));
        void this.d.push?.notify({ title: `${repoId}: verify command fails on ${repo.base_branch}`, body: command, url: '#setup' });
      }
    }
    bus.emit('repos');
  }
}
```

Check `removeWorktree`'s behaviour with `branch: null` (it must not delete a branch) and that `git()` trims output; adjust the imports to the real module paths (`../bus`, `../push/push`).

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run probe.test` → PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/lifecycle/probe.ts packages/daemon/src/lifecycle/probe.test.ts
git commit -m "feat(lifecycle): probe the verify command on the base branch"
```

---

### Task 3: Dispatch gate and REST wiring

**Goal:** `spawnWorker` refuses while `verify_suspect` is set; saving a repo with a changed setup or verify command, and `POST /api/repos/:id/probe`, start a probe; `GET /api/repos/:id/preflight` returns the history.

**Files:**
- Modify: `packages/daemon/src/lifecycle/lifecycle.ts` (`spawnWorker`, near line 117)
- Modify: `packages/daemon/src/api/rest.ts` (repo routes, lines 210-252)
- Modify: `packages/daemon/src/app.ts` (`AppDeps` gains `prober: Prober`)
- Modify: `packages/daemon/src/index.ts` (construct `Prober`, pass to `buildApp`)
- Modify: `packages/daemon/src/app.test.ts` (construct `Prober` in its setup)
- Test: `packages/daemon/src/lifecycle/lifecycle.test.ts`, `packages/daemon/src/app.test.ts`

**Acceptance Criteria:**
- [ ] With `verify_suspect` set, `spawnWorker` throws `LifecycleError` whose message is `refusalText(run, base)`; `redispatch` surfaces the same error; no session row is created.
- [ ] `POST /api/repos` with a verify command, and `PATCH /api/repos/:id` changing `verify_command` or `setup_command`, answer at once and a probe run appears afterwards.
- [ ] A `PATCH` that changes neither starts no probe.
- [ ] `POST /api/repos/:id/probe` → 202; unknown repo → 404.
- [ ] `GET /api/repos/:id/preflight` → `{ runs, crashes }` (`PreflightReport`), newest run first, at most 20.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run lifecycle.test app.test` → PASS

**Steps:**

- [ ] **Step 1: Write the failing tests**

In `lifecycle.test.ts`:

```ts
  it('refuses to dispatch while the verify command fails on the base branch', async () => {
    const x = setup();
    const run = x.db.preflight.insert({ repo_id: 'r1', kind: 'verify_probe', command: 'bad', head_sha: 'abcdef1234' });
    x.db.preflight.finish(run.id, { result: 'fail', exit_code: 1, output_tail: 'exit 1' });
    x.db.repos.update('r1', { verify_suspect: run.id });
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow('verify command "bad" exits 1 on main at abcdef1; fix it in Setup → Edit, then Re-probe');
    expect(x.db.sessions.forBead('ov-1')).toEqual([]);
    x.db.repos.update('r1', { verify_suspect: null });
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).resolves.toEqual(expect.any(String));
  });
```

In `app.test.ts` (follow the file's existing request helper and repo fixture; `until` from `./test/until`):

```ts
  it('probes on save and serves the preflight history', async () => {
    // register or patch the fixture repo with verify_command 'node -e "process.exit(1)"'
    // PATCH /api/repos/:id { verify_command: 'node -e "process.exit(1)"' } → 200
    await until(async () => db.preflight.latest(repoId)?.result === 'fail', 10_000, 'probe');
    const res = await app.inject({ method: 'GET', url: `/api/repos/${repoId}/preflight` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runs: [{ result: 'fail', exit_code: 1 }], crashes: [] });
    expect((await app.inject({ method: 'POST', url: `/api/repos/${repoId}/probe` })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/repos/nope/probe' })).statusCode).toBe(404);
  });

  it('does not probe when a save leaves both commands alone', async () => {
    // PATCH /api/repos/:id { worker_limit: 3 } → 200
    expect(db.preflight.latest(repoId)).toBeUndefined();
  });
```

Replace the comments with the file's real fixture names when writing the test (read `app.test.ts` around its setup first).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`lifecycle.ts`, in `spawnWorker` right after the `repo not found` check:

```ts
    if (repo.verify_suspect != null) {
      const run = db.preflight.get(repo.verify_suspect);
      if (run) throw new LifecycleError(refusalText(run, repo.base_branch));
    }
```

with `import { refusalText } from './probe';`. A missing run row (deleted DB rows) does not block.

`app.ts`: add `prober: Prober` to `AppDeps` (import type from `./lifecycle/probe`).

`rest.ts`:

```ts
  // POST /api/repos, after d.db.repos.insert(repo):
    if (repo.verify_command) void d.prober.probe(repo.id);
  // PATCH /api/repos/:id, after computing `after`:
    if (after.verify_command !== before.verify_command || after.setup_command !== before.setup_command) void d.prober.probe(after.id);

  app.post<{ Params: { id: string } }>('/api/repos/:id/probe', async (req, reply) => {
    if (!d.db.repos.get(req.params.id)) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    void d.prober.probe(req.params.id);
    return reply.code(202).send({ started: true });
  });

  app.get<{ Params: { id: string } }>('/api/repos/:id/preflight', async (req, reply): Promise<PreflightReport | void> => {
    if (!d.db.repos.get(req.params.id)) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    return { runs: d.db.preflight.recent(req.params.id, 20), crashes: d.db.preflight.crashCounts(req.params.id) };
  });
```

`index.ts`, after `lifecycle` is built:

```ts
const prober = new Prober({ db, bus, worktreesDir: config.worktreesDir, notify: (m, o) => orchestrator.systemMessage(m, o), push });
```

and pass `prober` to `buildApp`. `app.test.ts`: build a `Prober` the same way with its `db`, `bus`, a tmp `worktreesDir` and a no-op notify, and pass it.

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run lifecycle.test app.test` → PASS; `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/lifecycle/lifecycle.ts packages/daemon/src/lifecycle/lifecycle.test.ts packages/daemon/src/api/rest.ts packages/daemon/src/app.ts packages/daemon/src/app.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): refuse dispatch while the verify probe fails"
```

---

### Task 4: Worker-exit classifier and transient retry

**Goal:** Classify a worker that ended without commits, store the class, record a `crash` signal, retry a first transient crash once on the same harness and model, and tell the orchestrator not to retry a harness bug.

**Files:**
- Create: `packages/daemon/src/lifecycle/crash.ts`
- Create: `packages/daemon/src/lifecycle/crash.test.ts`
- Modify: `packages/daemon/src/lifecycle/lifecycle.ts` (`settleWorker`, the `if (missing || (commits === 0 && crashed))` branch, near line 334)
- Modify: `packages/daemon/src/lifecycle/retrospective.ts` and `packages/shared/src/index.ts` (`BatchRetrospective` gains `crashes`)
- Test: `packages/daemon/src/lifecycle/lifecycle.test.ts`, `packages/daemon/src/lifecycle/retrospective.test.ts`

**Acceptance Criteria:**
- [ ] `classifyExit` returns `harness_bug` for the four recorded clap samples, `transient` for `event stream failed: …`, `task` for `apply_patch verification failed`, a sandbox `CreateProcess` rejection, `codex exited with code 1` and `no output`.
- [ ] A clean-exit worker with no commits (no `lastError`) gets no class and no `crash` signal: it is not a crash.
- [ ] First transient crash of a bead: bead re-dispatched once, same harness and model, notice `<bead> re-dispatched after a transient stream failure (<reason>).` with a no-action hint, no wake.
- [ ] Second consecutive transient crash: reopens like today, no third session.
- [ ] Harness bug: reopens like today (same note and notice text), the hint says not to re-dispatch on the same harness, no retry.
- [ ] Each classified crash writes `sessions.crash_class` and one `crash` signal `<class>: <reason>` when the bead is in a batch; `batch_retrospective` lists them under `crashes`.
- [ ] The existing startup-crash tests (lines 144-196) still pass unchanged.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run crash.test lifecycle.test retrospective.test` → PASS

**Steps:**

- [ ] **Step 1: Write the failing tests**

`crash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyExit } from './crash';

const CLAP = "error: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS] <COMMAND> [ARGS]\n\nFor more information, try '--help'.\n";

describe('classifyExit', () => {
  it.each([
    ['codex exited with code 2', CLAP, 'harness_bug'],
    ['codex exited with code 2', "       codex exec [OPTIONS] <COMMAND> [ARGS]\nFor more information, try '--help'.\n", 'harness_bug'],
    ['event stream failed: codex session 5ba969b9 closed', 'Reading additional input from stdin...', 'transient'],
    ['event stream failed: socket hang up', null, 'transient'],
    ['codex exited with code 1', 'ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines', 'task'],
    ['codex exited with code 1', 'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected', 'task'],
    ['codex exited with code 1', null, 'task'],
    ['no output', null, 'task'],
  ])('%s → %s', (reason, stderr, expected) => {
    expect(classifyExit(reason, stderr)).toBe(expected);
  });
});
```

`lifecycle.test.ts`, next to the startup-crash tests (same `setup()` and `until`):

```ts
  it('re-dispatches a first transient stream failure once on the same model', async () => {
    const x = setup();
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: undefined });
    const model = x.db.sessions.get(first)!.model;
    const h = x.sessions.handleOf(first)!;
    const fakeFor = x.db.sessions.get(first)!.harness === 'codex' ? x.codex : x.fake;
    fakeFor.emit(h, { type: 'error', message: 'event stream failed: socket hang up' });
    fakeFor.emit(h, { type: 'turn_end', nativeSessionId: '' });
    await until(async () => x.db.sessions.forBead('ov-1').length === 2, 5000, 'retry');
    const second = x.db.sessions.forBead('ov-1')[1]!;
    expect(second).toMatchObject({ harness: x.db.sessions.get(first)!.harness, model });
    expect(x.db.sessions.get(first)!.crash_class).toBe('transient');
    expect(x.notes).toEqual(['ov-1 re-dispatched after a transient stream failure (event stream failed: socket hang up).']);
    expect(x.wakes).toEqual([]);

    const h2 = x.sessions.handleOf(second.id)!;
    fakeFor.emit(h2, { type: 'error', message: 'event stream failed: socket hang up' });
    fakeFor.emit(h2, { type: 'turn_end', nativeSessionId: '' });
    await until(async () => (await x.status()) === 'open', 5000, 'reopen');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(2);
    expect(x.wakes).toEqual(['ov-1 reopened: worker ended without commits: event stream failed: socket hang up']);
  });

  it('never retries a harness bug and says so in the hint', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', "error: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS]\n");
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 2' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', 5000, 'reopen');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
      expect(x.db.sessions.get(sid)!.crash_class).toBe('harness_bug');
      expect(x.hints.at(-1)).toBe('The codex CLI failed to start (a harness bug, not the task): do not re-dispatch this bead on codex; pass harness claude or ask the user.');
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });
```

If the fake emits no `error` → `lastError` mapping for `event stream failed` messages, check how `sessions/manager.ts` sets `lastError` from an `error` event and use that path. For the batch `crash` signal, add to `retrospective.test.ts` a case that creates a batch, crashes a worker with `event stream failed` twice, and expects `retrospective.crashes` to have two entries `{ bead_id: 'ov-1', crash_class: 'transient', reason: 'event stream failed: …' }`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`crash.ts`:

```ts
import type { CrashClass } from '@overseer/shared';

const USAGE = /(^|\n)\s*Usage: |For more information, try '--help'|\s\[OPTIONS\] <COMMAND>/;

/**
 * Why a worker ended without commits, from its exit reason and the head of its stderr (evidence: ~/.overseer/sessions, 2026-09-16).
 * harness_bug: the CLI rejected its arguments (clap usage text), so any model fails the same way.
 * transient: the event stream broke; the same model usually succeeds on a second try.
 * task: everything else, left to the orchestrator.
 */
export function classifyExit(reason: string, stderr: string | null): CrashClass {
  if (reason.startsWith('event stream failed')) return 'transient';
  if (/exited with code 2$/.test(reason) && stderr && USAGE.test(stderr)) return 'harness_bug';
  return 'task';
}
```

(The spec's "exit 2 in under 2 s" alternative is dropped: all four recorded samples carry usage text, and a bare fast exit 2 is not enough evidence to forbid a harness.)

`lifecycle.ts`, inside `if (missing || (commits === 0 && crashed))`, after `reason` is computed (the stderr head is already read there into `stderr`; hoist it to a `let stderr: string | null = null` so the classifier can use it):

```ts
      const crashClass = e.lastError && !crashed ? classifyExit(e.lastError, stderr ?? (session.log_path ? stderrHead(session.log_path + '.err') : null)) : null;
      if (crashClass) {
        db.sessions.update(session.id, { crash_class: crashClass });
        this.signal(wt.batch_id, session.bead_id, 'crash', `${crashClass}: ${reason}`);
      }
      const previous = db.sessions.forBead(session.bead_id).filter((s) => s.role === 'worker' && s.id !== session.id).at(-1);
      if (crashClass === 'transient' && previous?.crash_class !== 'transient') {
        try {
          const how: SpawnOpts = session.tier ? { tier: session.tier, continuation: true } : { harness: session.harness };
          await this.spawnWorker(repo.id, session.bead_id, { ...how, batchId: session.batch_id ?? undefined, instructions: this.lastInstructions.get(session.bead_id), rateLimit: true });
          await notify(`${session.bead_id} re-dispatched after a transient stream failure (${e.lastError}).`, { hint: 'This automatic re-dispatch needs no action.' }).catch((err) => log.error('lifecycle: transient notify failed', err));
          return;
        } catch (err) {
          log.error(`lifecycle: transient retry of ${session.bead_id} failed`, err);
        }
      }
```

Place this block after `db.sessions.update(session.id, { status: 'failed' })` and before the `store.update(... ended without new commits ...)`; the reopen that follows is unchanged except the notice's options:

```ts
      const hint = crashClass === 'harness_bug'
        ? `The ${session.harness} CLI failed to start (a harness bug, not the task): do not re-dispatch this bead on ${session.harness}; pass harness ${session.harness === 'claude' ? 'codex' : 'claude'} or ask the user.`
        : undefined;
      await notify(`${session.bead_id} reopened: worker ended without commits${why}: ${reason}`, { wake: true, hint })...
```

Check that `continuation: true` with a tier keeps the model (it is how the review round resumes a worker) and that `rateLimit: true` keeps the attempt from counting as a failed model; if `continuation` needs a non-empty `native_session_id`, it starts afresh on the same model, which is what we want. Import `classifyExit` from `./crash`.

`retrospective.ts`: add `crashes: rows.filter((r) => r.kind === 'crash').map((r) => { const i = r.text.indexOf(': '); return { bead_id: r.bead_id ?? '', crash_class: r.text.slice(0, i) as CrashClass, reason: r.text.slice(i + 2), ts: r.ts }; })`, and add `crashes: { bead_id: string; crash_class: CrashClass; reason: string; ts: string }[]` to `BatchRetrospective` in shared. If `retrospectiveSummary` counts signals, include crashes in the count.

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run crash.test lifecycle.test retrospective.test` → PASS; `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/lifecycle/crash.ts packages/daemon/src/lifecycle/crash.test.ts packages/daemon/src/lifecycle/lifecycle.ts packages/daemon/src/lifecycle/lifecycle.test.ts packages/daemon/src/lifecycle/retrospective.ts packages/daemon/src/lifecycle/retrospective.test.ts packages/shared/src/index.ts
git commit -m "feat(lifecycle): classify worker crashes and retry transient ones once"
```

---

### Task 5: Web — Needs row and Setup probe status

**Goal:** A suspect repo appears on Needs; each Setup repo row shows the last probe result, crash counts and a Re-probe button.

**Files:**
- Modify: `packages/web/src/lib/needsYou.ts` (kind `repo`, `needsYouItems` gains a `repos` argument)
- Modify: `packages/web/src/views/Needs.tsx` and its caller in `App.tsx` (pass repos; a `repo` row opens `#setup`)
- Modify: `packages/web/src/views/Setup.tsx` (repo row, near line 198)
- Modify: the web API helper module used by `Setup.tsx` for repo calls
- Test: `packages/web/src/lib/needsYou.test.tsx`, `packages/web/src/views/Setup.test.tsx`

**Acceptance Criteria:**
- [ ] `needsYouItems(board, chat, plans, repos)` adds `{ kind: 'repo', id, repoId: id, label: 'Verify command fails on <base>', detail: '<command>' }` for each repo with `verify_suspect != null`; order is `plan, repo, …` (a suspect repo blocks everything in it).
- [ ] Setup's repo row shows `probe: pass`, `probe: fails (exit N)`, `probe: timed out`, `probe: could not run` or `probe: —`, plus `crashes: <n>` when non-zero, from `GET /api/repos/:id/preflight`; it refetches on the `repos` socket message.
- [ ] A Re-probe button calls `POST /api/repos/:id/probe` and is disabled while that request is in flight.
- [ ] A 390 px Playwright screenshot of Setup with a failing repo shows the row without horizontal overflow (evidence kept outside the repo).

**Verify:** `pnpm --filter @overseer/web test -- needsYou Setup` → PASS; `pnpm typecheck` → exit 0

**Steps:**

- [ ] **Step 1: Write the failing tests**

`needsYou.test.tsx`:

```ts
  it('lists a repo whose verify command fails on its base branch, right after plans', () => {
    const repos = [{ id: 'r1', path: '/r1', base_branch: 'main', verify_command: 'bad', setup_command: null, merge_mode: 'local-merge', worker_limit: 1, review_rounds: 0, verify_suspect: 3 }] as Repo[];
    const items = needsYouItems(null, [], [], repos);
    expect(items).toEqual([{ kind: 'repo', id: 'r1', repoId: 'r1', label: 'Verify command fails on main', detail: 'bad' }]);
  });
```

`Setup.test.tsx` (follow the file's existing fetch mock): mock `GET /api/repos/r1/preflight` → `{ runs: [{ id: 3, result: 'fail', exit_code: 1, … }], crashes: [{ harness: 'codex', crash_class: 'transient', count: 2 }] }`, render Setup, expect text `probe: fails (exit 1)` and `crashes: 2`; click `Re-probe`, expect a `POST /api/repos/r1/probe` call and the button disabled until it resolves.

- [ ] **Step 2: Run** `pnpm --filter @overseer/web test -- needsYou Setup` → FAIL.

- [ ] **Step 3: Implement**

`needsYou.ts`:

```ts
export type NeedsYouKind = 'plan' | 'repo' | 'question' | 'decision' | 'batch' | 'failed';
// ORDER: insert 'repo' right after 'plan'.
export function needsYouItems(board: BoardResponse | null, chat: ChatRow[], plans: Plan[] = [], repos: Repo[] = []): NeedsYouItem[] {
  // ... existing plan loop, then:
  for (const r of repos) {
    if (r.verify_suspect == null) continue;
    items.push({ kind: 'repo', id: r.id, repoId: r.id, label: `Verify command fails on ${r.base_branch}`, detail: r.verify_command ?? '' });
  }
```

`Needs.tsx`/`App.tsx`: pass the repos list the shell already holds; a `repo` row navigates to `#setup`. Add a readable state word for the kind where the view maps kinds to labels (`'paused'`).

`Setup.tsx`: a small `ProbeStatus({ repoId })` component in the same file, fetching `/api/repos/${repoId}/preflight` on mount and on the `repos` socket message the view already listens to, rendering:

```tsx
const word = (r?: PreflightRun) => !r ? 'probe: —' : r.result === 'pass' ? 'probe: pass' : r.result === 'fail' ? `probe: fails (exit ${r.exit_code})` : r.result === 'timeout' ? 'probe: timed out' : r.result === 'error' ? 'probe: could not run' : 'probe: running';
```

plus `crashes: <sum of counts>` when above zero, and a `Re-probe` button with local `busy` state. Put it in a new `<td data-label="probe">` in the repo row, matching the row's existing cells, and add the column header.

- [ ] **Step 4: Run** tests → PASS; `pnpm typecheck` → exit 0. Start `pnpm dev`, set a repo's verify command to `node -e "process.exit(1)"`, take a 390 px screenshot of Setup and of Needs with `playwright-cli`, store them in the scratchpad, confirm no horizontal overflow.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/needsYou.ts packages/web/src/lib/needsYou.test.tsx packages/web/src/views/Needs.tsx packages/web/src/App.tsx packages/web/src/views/Setup.tsx packages/web/src/views/Setup.test.tsx
git commit -m "feat(web): show verify probe status and paused repos"
```

(Add the API helper file to `git add` if it changed.)

---

### Task 6: Documentation and prompt rule 22

**Goal:** Every documentation surface describes the gate and the crash classes, and the orchestrator prompt knows the gate exists.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md` (dispatch and worker-end sections)
- Modify: `README.md` (Setup section and Needs view)
- Modify: `CLAUDE.md` (Layout: `lifecycle/probe.ts`, `lifecycle/crash.ts`, `preflight_runs`, the two routes, the `repo` Needs kind)
- Modify: `packages/daemon/prompts/orchestrator.md` (rule 22)
- Modify: `docs/lessons.md` (one dated entry)
- Test: `packages/daemon/src/orchestrator/orchestrator.test.ts` or `lifecycle/prompt.test.ts` (whichever asserts rule 22 today)

**Acceptance Criteria:**
- [ ] Rule 22 gains exactly this sentence at its end: `Overseer also probes the command on the base branch when it is saved; while that probe fails, spawn_worker refuses with the command and exit code, so relay that refusal to the user instead of retrying.`
- [ ] Rule 4 or 3 gains: `An "[Overseer] … re-dispatched after a transient stream failure" notice needs no action; a reopen whose hint names a harness bug must not be re-dispatched on that harness.`
- [ ] The prompt test asserts both sentences.
- [ ] `docs/lessons.md` has a `## 2026-09-16 — /insights report over 2026-09-09 to 2026-09-16` entry quoting the an7 triple reopen and the four codex exit-2 startups, naming both prompt additions.
- [ ] `pnpm test` and `pnpm typecheck` pass for all packages.

**Verify:** `pnpm test` → all pass; `pnpm typecheck` → exit 0

**Steps:**

- [ ] **Step 1:** Add the two assertions to the prompt test (`expect(prompt).toContain('<sentence>')`), run it → FAIL.
- [ ] **Step 2:** Edit `orchestrator.md` with the two sentences, run the prompt test → PASS.
- [ ] **Step 3:** Update the spec, README, CLAUDE.md and lessons entry as listed in Files; keep each change to the section named.
- [ ] **Step 4:** Run `pnpm test` and `pnpm typecheck` → pass.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md README.md CLAUDE.md packages/daemon/prompts/orchestrator.md docs/lessons.md packages/daemon/src/orchestrator/orchestrator.test.ts
git commit -m "docs(preflight): describe the dispatch gate and crash classes"
```

(Use the prompt test file that actually changed.)
