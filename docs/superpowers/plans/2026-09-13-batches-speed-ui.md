# Feature branches, board speed, orchestrator sessions, traces, UI redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every request on one feature branch reviewed once, make the board load in ~2 s, cap orchestrator context cost with idle session expiry, expose session traces and cost, and restyle the UI as a slate control room.

**Architecture:** The daemon gets a `batches` table and a batch worktree per feature branch; verified beads merge into the batch branch automatically and the batch is reviewed once (Review view or GitLab MR). `Beads.list` becomes one `bd` call and the board builds repos in parallel. The orchestrator ends idle sessions and starts fresh ones with a preamble. REST exposes sessions, events and costs. The web app gets design tokens, a rail with counts, an activity strip, batch rows on the board, a fixed chat composer and a batch-aware Review view.

**Tech Stack:** Node 22 (`node:sqlite`), Fastify, zod, MCP SDK, React 19, Vite, vitest, @testing-library/react. Windows dev machine (PowerShell); tests use real git repos.

**Spec:** `docs/superpowers/specs/2026-09-13-batches-speed-ui-design.md`

## Global Constraints

- Every child process goes through `spawnLines`/`runCapture` (`src/util/procs.ts`) or the `git()` helper; never `shell: true` except `verify.ts`.
- The daemon is the only writer of bead status and `overseer:*` labels.
- Tests use real git repos (`src/test/tmpgit.ts`), `openDb(':memory:')`, `MemoryTaskStore`, `FakeAdapter`; test output must stay free of warnings.
- Commit with explicit paths; never commit `docs/superpowers/plans/*.tasks.json`.
- Commands: `pnpm --filter @overseer/daemon exec vitest run <pattern>` for daemon tests, `pnpm --filter @overseer/web test -- <pattern>` for web tests, `pnpm typecheck` for all packages.
- Keep existing web tests passing unless a task explicitly changes them; the redesign keeps every text, placeholder, aria-label and button name the tests query.
- Web tokens, exact values: `--bg #151b23 --surface #1c2430 --surface-2 #232d3a --line #2e3a48 --text #e7ebf0 --muted #8d99a8 --accent #6f9ad1 --ready #6f9ad1 --blocked #c96a5c --running #d9a441 --verifying #9a7fd1 --review #3fb1a3 --done #6fae6f`. Fonts: IBM Plex Sans (interface), IBM Plex Mono (ids, branches, costs, diffs). No uppercase label styling, no tracked-out eyebrows, no gradient decoration.
- Every git commit message ends with `Claude-Session: https://claude.ai/code/session_01VLgLJgpzfTncAwtSyCUrUW`.

**User decisions (already made):**
- "I would expect for all work on a specific task to end up on a feature branch (with a MR created that has the details as to what has changed and I can review that). Either way work should always be done on a feature branch that then gets merged into whatever main branch I selected, so dev or main."
- Scope selected: board speed fix, UI redesign as proposed, orchestrator idle reset, session trace + cost export, fix the merge error, cancel work from the UI.
- Design direction: slate control room (dark, dense, status colours as the only accents, IBM Plex).

---

### Task 1: One `bd list` per repo and a cached `available()`

**Goal:** `Beads.list` runs a single `bd list --all -n 0 --json` and `Beads.available()` remembers a positive answer for 60 s.

**Files:**
- Modify: `packages/daemon/src/beads/beads.ts:31-39,61-68`
- Test: `packages/daemon/src/beads/beads.test.ts:18-24`

**Acceptance Criteria:**
- [ ] `list()` issues exactly one runner call with args `['list', '--all', '-n', '0', '--json']`.
- [ ] `available()` calls the runner once, then returns `true` without a runner call within 60 s.
- [ ] `STATUSES` constant is removed (no unused code).

**Verify:** `pnpm --filter @overseer/daemon exec vitest run beads` → all green.

**Steps:**

- [ ] **Step 1: Replace the list test and add the cache test** in `beads.test.ts`, replacing the `lists across statuses` test:

```ts
  it('lists with one --all call, no row limit, --json and repo cwd', async () => {
    const f = fakeRunner({ list: fixture('list.json') });
    const beads = await new Beads(f.run).list('/repo');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ cwd: '/repo', args: ['list', '--all', '-n', '0', '--json'] });
    expect(beads.length).toBeGreaterThan(0);
  });
  it('caches a positive available() for 60 s', async () => {
    const f = fakeRunner({});
    const b = new Beads(f.run);
    expect(await b.available()).toBe(true);
    expect(await b.available()).toBe(true);
    expect(f.calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
  });
```

Check how `fakeRunner` answers `--version` (top of the file): if it returns code 0 for unknown commands the test works as written; if it errors, register `'--version': 'bd version 1.2.2'` in the map the same way `list` is registered.

- [ ] **Step 2: Run to see the list test fail**

Run: `pnpm --filter @overseer/daemon exec vitest run beads`
Expected: FAIL, `f.calls` has length 4.

- [ ] **Step 3: Implement** in `beads.ts`. Delete the `STATUSES` line and change `available` and `list`:

```ts
export class Beads implements TaskStore {
  private tails = new Map<string, Promise<unknown>>();
  private availableUntil = 0;
  constructor(private run: BdRunner) {}

  async available(): Promise<boolean> {
    if (Date.now() < this.availableUntil) return true;
    try {
      const ok = (await this.run('.', ['--version'])).code === 0;
      if (ok) this.availableUntil = Date.now() + 60_000;
      return ok;
    } catch { return false; }
  }
  // ... init/exec unchanged ...
  async list(repoPath: string): Promise<Bead[]> {
    const rows = (await this.exec(repoPath, ['list', '--all', '-n', '0'])) as unknown[] | null;
    return (rows ?? []).map((r) => parseBead(r as Record<string, unknown>));
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @overseer/daemon exec vitest run beads`
Expected: PASS (the live test is skipped without `OVERSEER_LIVE=1`).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/beads/beads.ts packages/daemon/src/beads/beads.test.ts
git commit -m "Load beads with one bd list call and cache bd availability"
```

---

### Task 2: Parallel, coalesced board build and stale-while-refresh in the web Board

**Goal:** `GET /api/board` builds repos concurrently and shares one in-flight build; the web Board keeps the old board while refetching and debounces refetches.

**Files:**
- Modify: `packages/daemon/src/api/board.ts`
- Modify: `packages/daemon/src/api/rest.ts:101`
- Modify: `packages/web/src/views/Board.tsx:15,22`
- Test: `packages/daemon/src/api/board.test.ts`, `packages/web/src/views/Board.test.tsx`

**Acceptance Criteria:**
- [ ] With two repos whose store calls each take 50 ms, `buildBoard` finishes in under 150 ms (parallel), not 200+ ms.
- [ ] Two concurrent `buildBoard` calls through `coalesced()` share a single underlying build.
- [ ] Web Board: after the first load, a `version` change does not render "Loading board…" again.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run board` and `pnpm --filter @overseer/web test -- Board` → green.

**Steps:**

- [ ] **Step 1: Daemon tests.** Append to `board.test.ts`:

```ts
  it('builds repos in parallel and coalesces concurrent builds', async () => {
    const db = openDb(':memory:');
    const store = new MemoryTaskStore();
    const slow = { ...store, list: async (p: string) => { await new Promise((r) => setTimeout(r, 50)); return store.list(p); } } as MemoryTaskStore;
    for (const id of ['a', 'b', 'c']) {
      db.repos.insert({ id, path: `/${id}`, base_branch: 'main', verify_command: null, merge_mode: 'local-merge', worker_limit: 2 });
      store.add(`/${id}`, { id: `${id}-1` });
    }
    const t0 = Date.now();
    const b = await buildBoard(db, slow);
    expect(Date.now() - t0).toBeLessThan(140);
    expect(b.repos.map((r) => r.cards.length)).toEqual([1, 1, 1]);
    let builds = 0;
    const get = coalesced(async () => { builds++; return buildBoard(db, slow); });
    await Promise.all([get(), get(), get()]);
    expect(builds).toBe(1);
    await get();
    expect(builds).toBe(2);
  });
```

Add `coalesced` to the import from `./board`.

- [ ] **Step 2: Run** `pnpm --filter @overseer/daemon exec vitest run board` → FAIL (`coalesced` missing, timing).

- [ ] **Step 3: Implement** in `board.ts`:

```ts
export async function buildBoard(db: Db, store: TaskStore): Promise<BoardResponse> {
  const bd_ok = await store.available();
  const repos = await Promise.all(db.repos.all().map(async (repo) => ({ repo, cards: bd_ok ? await cardsFor(db, store, repo) : [] })));
  return { bd_ok, repos };
}

/** Shares one in-flight promise between callers; a call after settlement starts a new build. */
export function coalesced<T>(build: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    if (!inflight) inflight = build().finally(() => { inflight = null; });
    return inflight;
  };
}
```

In `rest.ts` replace the board route:

```ts
  const board = coalesced(() => buildBoard(d.db, d.store));
  app.get('/api/board', async () => board());
```

and import `coalesced` next to `buildBoard`.

- [ ] **Step 4: Web test.** Add to `Board.test.tsx`:

```ts
  it('keeps the previous board while refetching', async () => {
    let calls = 0;
    mockApi((_m, url) => {
      if (url.endsWith('/api/board')) { calls++; return board; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board version={0} onOpenReview={() => {}} />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    rerender(<Board version={1} onOpenReview={() => {}} />);
    expect(screen.queryByText(/loading board/i)).toBeNull();
    expect(screen.getByText('Ready task')).toBeTruthy();
    await waitFor(() => expect(calls).toBe(2));
  });
```

- [ ] **Step 5: Implement** in `Board.tsx`: replace the board-loading effect:

```ts
  useEffect(() => {
    const t = setTimeout(() => { void api.get<BoardResponse>('/board').then(setBoard); }, p.version === 0 ? 0 : 300);
    return () => clearTimeout(t);
  }, [p.version]);
```

`setBoard` only replaces state when the response arrives, so the old board stays rendered. Keep `if (!board) return <div>Loading board…</div>;`.

- [ ] **Step 6: Run both** test commands → PASS. Then `pnpm typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/api/board.ts packages/daemon/src/api/board.test.ts packages/daemon/src/api/rest.ts packages/web/src/views/Board.tsx packages/web/src/views/Board.test.tsx
git commit -m "Build the board per repo in parallel, coalesce builds, keep the old board while refetching"
```

---

### Task 3: Let git decide on a dirty primary checkout

**Goal:** `mergeLocal` no longer refuses up front when the checkout has uncommitted changes; git's own overwrite error surfaces instead.

**Files:**
- Modify: `packages/daemon/src/git/git.ts:65-70`
- Test: `packages/daemon/src/git/git.test.ts:66-77`

**Acceptance Criteria:**
- [ ] A dirty unrelated file does not block the merge; the merge succeeds and the dirty file stays dirty.
- [ ] A dirty file that the branch also changes fails with a `GitError` whose message matches `/would be overwritten/`.
- [ ] Off-base checkout still fails with `/expected main/`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run git` → green.

**Steps:**

- [ ] **Step 1: Rewrite the test** `refuses when primary checkout is off base or dirty`:

```ts
  it('merges over unrelated dirty files, refuses overlapping ones, refuses off-base', async () => {
    const { repo, worktreesDir } = setup();
    const wt = await ensureWorktree(repo, 'ov-4', worktreesDir);
    commitFile(wt.path, 'feature.txt', 'f\n', 'feature');
    fs.writeFileSync(`${repo.path}/dirty.txt`, 'x');
    await expect(mergeLocal(repo.path, wt.branch, 'main', 'm')).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(`${repo.path}/dirty.txt`, 'utf8')).toBe('x');
    const wt2 = await ensureWorktree(repo, 'ov-4b', worktreesDir);
    commitFile(wt2.path, 'README.md', '# changed\n', 'touch readme');
    fs.writeFileSync(`${repo.path}/README.md`, '# local edit\n');
    await expect(mergeLocal(repo.path, wt2.branch, 'main', 'm')).rejects.toThrow(/would be overwritten/);
    sh(repo.path, ['checkout', '-q', '--', 'README.md']);
    sh(repo.path, ['checkout', '-q', '-b', 'other']);
    await expect(mergeLocal(repo.path, wt2.branch, 'main', 'm')).rejects.toThrow(/expected main/);
  });
```

- [ ] **Step 2: Run** → FAIL on the first `resolves` (GitError "uncommitted changes").

- [ ] **Step 3: Implement.** In `git.ts` delete these two lines from `mergeLocal`:

```ts
  // `.beads/` is excluded: bd rewrites its tracked bookkeeping files there on every call the daemon makes.
  if (await git(repoPath, ['status', '--porcelain', '--', '.', ':(exclude).beads'])) throw new GitError('primary checkout has uncommitted changes', '');
```

The existing `.beads` test (`git.test.ts:55-64`) still passes: git itself reports "would be overwritten" for the tracked `.beads/issues.jsonl`.

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run git lifecycle` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/git/git.ts packages/daemon/src/git/git.test.ts
git commit -m "Let git decide whether a dirty checkout blocks a local merge"
```

---

### Task 4: Shared types, `batches` table, `worktrees.batch_id`, column migration

**Goal:** The schema, `Db` accessors and shared types for batches exist and round-trip.

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/daemon/src/db/schema.ts`
- Modify: `packages/daemon/src/db/db.ts`
- Modify: `packages/daemon/src/db/db.test.ts`, `packages/daemon/src/api/board.test.ts:209`, `packages/daemon/src/lifecycle/lifecycle.ts:52`, `packages/web/src/test/fixtures.ts` (add `batch_id: null` to every `WorktreeRow` literal)

**Acceptance Criteria:**
- [ ] `db.batches.insert/get/forRepo/update/nextId` work; `conflict_files` round-trips as an array.
- [ ] `db.worktrees.forBatch(id)` returns the worktrees whose `batch_id` matches.
- [ ] Opening a database created with the old schema (no `batch_id` column) adds the column.
- [ ] `pnpm typecheck` passes.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run db board` and `pnpm typecheck` → green.

**Steps:**

- [ ] **Step 1: Shared types.** In `packages/shared/src/index.ts` add after `WorktreeRow` (and add `batch_id: string | null;` as the last field of `WorktreeRow`):

```ts
export type BatchStatus = 'open' | 'review' | 'merged' | 'abandoned';

export interface BatchRow {
  id: string;
  repo_id: string;
  title: string;
  branch: string;
  base_branch: string;
  status: BatchStatus;
  note: string | null;
  mr_url: string | null;
  conflict_files: string[] | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface BatchSummary extends BatchRow {
  beads_total: number;
  beads_done: number;
  cost: number;
}

export interface BatchDetail {
  batch: BatchRow;
  repo: Repo;
  beads: BoardCard[];
  diff: string | null;
  cost: number;
}

export interface CostsResponse {
  repos: { repo_id: string; total: number; today: number }[];
  batches: { batch_id: string; total: number }[];
}
```

Change `BoardCard` to add `batch_id: string | null;` after `repo_id`, and `BoardResponse.repos` items to `{ repo: Repo; batches: BatchSummary[]; cards: BoardCard[] }`. Add `| { type: 'batches' }` is NOT needed; the `board` message covers it.

- [ ] **Step 2: Schema.** In `schema.ts` add to `SCHEMA` before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL,
  base_branch TEXT NOT NULL, status TEXT NOT NULL, note TEXT, mr_url TEXT, conflict_files TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_at TEXT);
```

and export the migration list:

```ts
/** Columns added after v1. openDb adds each one that is missing (CREATE TABLE IF NOT EXISTS never alters). */
export const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'worktrees', column: 'batch_id', ddl: 'TEXT' },
];
```

- [ ] **Step 3: Db.** In `db.ts`:

Import `ADDED_COLUMNS` and `BatchRow`. In `openDb` after `sql.exec(SCHEMA);`:

```ts
  for (const c of ADDED_COLUMNS) {
    const cols = (sql.prepare(`PRAGMA table_info(${c.table})`).all() as { name: string }[]).map((r) => r.name);
    if (!cols.includes(c.column)) sql.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.ddl}`);
  }
```

Replace the worktrees accessor:

```ts
  worktrees = {
    upsert: (w: WorktreeRow) => this.sql.prepare('INSERT OR REPLACE INTO worktrees (bead_id,repo_id,path,branch,base_branch,verify_status,verify_output,review_note,conflict_files,merged_at,mr_url,batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(w.bead_id, w.repo_id, w.path, w.branch, w.base_branch, w.verify_status, w.verify_output, w.review_note, w.conflict_files ? JSON.stringify(w.conflict_files) : null, w.merged_at, w.mr_url, w.batch_id),
    update: (beadId: string, patch: Partial<WorktreeRow>) => this.patch('worktrees', 'bead_id', beadId, { ...patch, ...(patch.conflict_files !== undefined ? { conflict_files: patch.conflict_files ? JSON.stringify(patch.conflict_files) : null } : {}) } as Row),
    get: (beadId: string) => this.parseWt(this.sql.prepare('SELECT * FROM worktrees WHERE bead_id=?').get(beadId) as Row | undefined),
    forRepo: (repoId: string) => (this.sql.prepare('SELECT * FROM worktrees WHERE repo_id=?').all(repoId) as Row[]).map((r) => this.parseWt(r)!),
    forBatch: (batchId: string) => (this.sql.prepare('SELECT * FROM worktrees WHERE batch_id=?').all(batchId) as Row[]).map((r) => this.parseWt(r)!),
    delete: (beadId: string) => this.sql.prepare('DELETE FROM worktrees WHERE bead_id=?').run(beadId),
  };

  batches = {
    nextId: (repoId: string) => `${repoId}-b${(this.sql.prepare('SELECT COUNT(*) AS n FROM batches WHERE repo_id=?').get(repoId) as { n: number }).n + 1}`,
    insert: (b: BatchRow) => this.sql.prepare('INSERT INTO batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(b.id, b.repo_id, b.title, b.branch, b.base_branch, b.status, b.note, b.mr_url, b.conflict_files ? JSON.stringify(b.conflict_files) : null, b.created_at, b.updated_at, b.merged_at),
    get: (id: string) => this.parseBatch(this.sql.prepare('SELECT * FROM batches WHERE id=?').get(id) as Row | undefined),
    forRepo: (repoId: string) => (this.sql.prepare('SELECT * FROM batches WHERE repo_id=? ORDER BY created_at').all(repoId) as Row[]).map((r) => this.parseBatch(r)!),
    all: () => (this.sql.prepare('SELECT * FROM batches ORDER BY created_at').all() as Row[]).map((r) => this.parseBatch(r)!),
    update: (id: string, patch: Partial<BatchRow>) => this.patch('batches', 'id', id, { ...patch, updated_at: now(), ...(patch.conflict_files !== undefined ? { conflict_files: patch.conflict_files ? JSON.stringify(patch.conflict_files) : null } : {}) } as Row),
  };
```

and the parser next to `parseWt`:

```ts
  private parseBatch(r: Row | undefined): BatchRow | undefined {
    if (!r) return undefined;
    return { ...(r as unknown as BatchRow), conflict_files: r.conflict_files ? JSON.parse(String(r.conflict_files)) : null };
  }
```

- [ ] **Step 4: Tests.** In `db.test.ts` add `batch_id: null` to the `worktrees.upsert` literal and append inside the same `it`:

```ts
    expect(db.batches.nextId('r1')).toBe('r1-b1');
    db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Trend chart', branch: 'feature/trend-chart', base_branch: 'main', status: 'open', note: null, mr_url: null, conflict_files: null, created_at: 't0', updated_at: 't0', merged_at: null });
    expect(db.batches.nextId('r1')).toBe('r1-b2');
    db.batches.update('r1-b1', { status: 'review', note: 'done', conflict_files: ['x.ts'] });
    expect(db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'done', conflict_files: ['x.ts'] });
    expect(db.batches.forRepo('r1')).toHaveLength(1);
    db.worktrees.update('b1', { batch_id: 'r1-b1' });
    expect(db.worktrees.forBatch('r1-b1').map((w) => w.bead_id)).toEqual(['b1']);
```

Add a second test:

```ts
  it('adds batch_id to a worktrees table created without it', () => {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE worktrees (bead_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, verify_status TEXT, verify_output TEXT, review_note TEXT, conflict_files TEXT, merged_at TEXT, mr_url TEXT)');
    old.close();
    const db = openDb(file);
    db.worktrees.upsert({ bead_id: 'b9', repo_id: 'r', path: '/p', branch: 'bead/b9', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: 'r-b1' });
    expect(db.worktrees.get('b9')?.batch_id).toBe('r-b1');
  });
```

Use ESM imports at the top instead of `require`: `import { DatabaseSync } from 'node:sqlite'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';`.

Add `batch_id: null` to the `worktrees.upsert` literals in `board.test.ts:209`, `lifecycle.ts:52`, and to `reviewDetail.worktree` in `packages/web/src/test/fixtures.ts`. In `fixtures.ts` also add `batch_id: null` to every card and `batches: []` to the repo entry so `BoardResponse` typechecks.

- [ ] **Step 5: Run** `pnpm --filter @overseer/daemon exec vitest run db board` and `pnpm typecheck` → PASS (board.test's second test compares with `toEqual` on `{ repo, cards: [] }`: update it to `{ repo: expect.objectContaining({ id: 'r1' }), batches: [], cards: [] }` — `buildBoard` gains `batches` in Task 8; until then add the field as `batches: []` in `board.ts` now so the type compiles: `repos.push({ repo, batches: [], cards })`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/daemon/src/db packages/daemon/src/api/board.ts packages/daemon/src/api/board.test.ts packages/daemon/src/lifecycle/lifecycle.ts packages/web/src/test/fixtures.ts
git commit -m "Add the batches table, worktrees.batch_id and a column migration"
```

---

### Task 5: Git helpers for batch branches and batch worktrees

**Goal:** Create a branch from base, keep a worktree for it, merge a bead branch into it, diff two refs, and clean up.

**Files:**
- Modify: `packages/daemon/src/git/git.ts`
- Test: `packages/daemon/src/git/git.test.ts`

**Acceptance Criteria:**
- [ ] `createBranch(repoPath, branch, from)` creates the branch without switching the checkout; calling it twice is a no-op.
- [ ] `ensureBranchWorktree(repo, branch, dir)` checks the branch out at `dir` and is idempotent.
- [ ] `ensureWorktree(repo, beadId, worktreesDir, from)` starts a new bead branch from `from` (batch branch) when given.
- [ ] `mergeInto(wtPath, branch, message)` returns `{ ok: true }` or `{ ok: false, conflicts }` and leaves no merge in progress after a conflict.
- [ ] `diffRefs(repoPath, base, head)` returns `git diff base...head`.
- [ ] `deleteBranch(repoPath, branch)` ignores a missing branch.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run git` → green.

**Steps:**

- [ ] **Step 1: Test.** Append to `git.test.ts`:

```ts
describe('batch branches', () => {
  it('creates a branch and worktree, merges beads into it, diffs, cleans up', async () => {
    const { repo, worktreesDir } = setup();
    await createBranch(repo.path, 'feature/x', 'main');
    await createBranch(repo.path, 'feature/x', 'main');
    expect(sh(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    const dir = `${worktreesDir}/r1/batch-r1-b1`;
    const bw = await ensureBranchWorktree(repo, 'feature/x', dir);
    expect(bw).toEqual({ path: dir, created: true });
    expect((await ensureBranchWorktree(repo, 'feature/x', dir)).created).toBe(false);
    expect(sh(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/x');

    const wt = await ensureWorktree(repo, 'ov-9', worktreesDir, 'feature/x');
    commitFile(wt.path, 'a.txt', 'a\n', 'add a');
    expect(await mergeInto(dir, 'bead/ov-9', 'Merge bead/ov-9')).toEqual({ ok: true });
    expect(fs.existsSync(`${dir}/a.txt`)).toBe(true);
    expect(await diffRefs(repo.path, 'main', 'feature/x')).toContain('+a');
    expect(await diffAgainstBase(wt.path, 'feature/x')).toBe('');

    const wt2 = await ensureWorktree(repo, 'ov-10', worktreesDir, 'feature/x');
    commitFile(wt2.path, 'a.txt', 'conflict\n', 'clash');
    commitFile(dir, 'a.txt', 'batch side\n', 'batch side');
    expect(await mergeInto(dir, 'bead/ov-10', 'Merge bead/ov-10')).toEqual({ ok: false, conflicts: ['a.txt'] });
    expect(sh(dir, ['status', '--porcelain'])).toBe('');

    await removeWorktree(repo.path, wt.path, wt.branch);
    await removeWorktree(repo.path, wt2.path, wt2.branch);
    await removeWorktree(repo.path, dir, 'feature/x');
    await deleteBranch(repo.path, 'feature/x');
    expect(sh(repo.path, ['branch', '--list', 'feature/x'])).toBe('');
  });
});
```

Extend the import line with `createBranch, ensureBranchWorktree, mergeInto, diffRefs, deleteBranch`.

- [ ] **Step 2: Run** → FAIL (missing exports).

- [ ] **Step 3: Implement** in `git.ts`. Change `ensureWorktree`'s signature and the `-b` line:

```ts
export async function ensureWorktree(repo: Repo, beadId: string, worktreesDir: string, from: string = repo.base_branch): Promise<{ path: string; branch: string; created: boolean }> {
  ...
  else await git(repo.path, ['worktree', 'add', '-b', branch, wt, from]);
```

Add:

```ts
export async function createBranch(repoPath: string, branch: string, from: string): Promise<void> {
  if (await git(repoPath, ['branch', '--list', branch])) return;
  await git(repoPath, ['branch', branch, from]);
}

export async function ensureBranchWorktree(repo: Repo, branch: string, dir: string): Promise<{ path: string; created: boolean }> {
  await git(repo.path, ['worktree', 'prune']);
  if (fs.existsSync(dir)) {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return { path: dir, created: false };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.path, ['worktree', 'add', dir, branch]);
  return { path: dir, created: true };
}

/** Merges `branch` into the branch checked out at `wtPath`. Aborts and reports the conflicting files on conflict. */
export async function mergeInto(wtPath: string, branch: string, message: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  try {
    await git(wtPath, ['merge', '--no-ff', '-m', message, branch]);
    return { ok: true };
  } catch (e) {
    let conflicts: string[] = [];
    try { conflicts = (await git(wtPath, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean); } catch { /* listing failed; rethrow below */ }
    try { await git(wtPath, ['merge', '--abort']); } catch { /* nothing to abort */ }
    if (conflicts.length) return { ok: false, conflicts };
    throw e;
  }
}

export const diffRefs = (repoPath: string, base: string, head: string) => git(repoPath, ['diff', `${base}...${head}`]);

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (await git(repoPath, ['branch', '--list', branch])) await git(repoPath, ['branch', '-D', branch]);
}
```

`mergeLocal`'s try/catch body is now duplicated by `mergeInto`; make `mergeLocal` call it after the base-branch check:

```ts
export async function mergeLocal(repoPath: string, branch: string, base: string, message: string) {
  const current = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== base) throw new GitError(`primary checkout is on ${current}, expected ${base}`, '');
  return mergeInto(repoPath, branch, message);
}
```

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run git lifecycle` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/git/git.ts packages/daemon/src/git/git.test.ts
git commit -m "Add git helpers for feature branches and batch worktrees"
```

---

### Task 6: Batch lifecycle

**Goal:** `Lifecycle` can create a batch, dispatch beads onto it, integrate verified beads into the batch branch, request batch review, merge, reject, abandon, and interrupt a bead's worker.

**Files:**
- Modify: `packages/daemon/src/lifecycle/lifecycle.ts`
- Modify: `packages/daemon/src/git/provider.ts` (add `landBatch`)
- Modify: `packages/daemon/src/bus.ts` (no change needed; `board` covers batches)
- Test: `packages/daemon/src/lifecycle/lifecycle.test.ts`, `packages/daemon/src/git/provider.test.ts`

**Acceptance Criteria:**
- [ ] `createBatch('r1', 'Trend chart')` → row `r1-b1`, branch `feature/trend-chart` exists, batch worktree at `<worktreesDir>/r1/batch-r1-b1`.
- [ ] `spawnWorker('r1', 'ov-1', 'claude', undefined, 'r1-b1')`: worktree `batch_id` is set, branch starts from the batch branch, prompt says `based on \`feature/trend-chart\``.
- [ ] Worker commits + verify pass → bead closed with phase `merged`, bead worktree removed, batch branch contains the commit, notify text `ov-1 landed on feature/trend-chart (1/1 beads done)`.
- [ ] Verify fail in a batch → bead status `open`, phase `null`, notes contain `Verification failed`, notify text starts with `ov-1 reopened: verification failed`.
- [ ] Integration conflict → bead reopened, `conflict_files` set, notify mentions `conflicted`.
- [ ] `requestBatchReview` refuses while a bead is `open`/`in_progress`; otherwise status `review`, note stored.
- [ ] `mergeBatch` (local-merge) merges the feature branch into `main`, status `merged`, worktree and branches gone.
- [ ] `rejectBatch` → status `open`, note appended, notify `Batch r1-b1 rejected: ...`.
- [ ] `abandonBatch` → running workers interrupted, beads closed, worktrees and branch gone, status `abandoned`.
- [ ] `interruptBead('ov-1')` interrupts the running session; `LifecycleError` when none is running.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run lifecycle provider` → green.

**Steps:**

- [ ] **Step 1: Provider.** In `provider.ts` add to the `GitProvider` interface:

```ts
  landBatch(repo: Repo, batch: BatchRow, wtPath: string, mr: { title: string; description: string }): Promise<LandResult>;
```

Implementations:

```ts
// LocalMergeProvider
  async landBatch(repo: Repo, batch: BatchRow, _wtPath: string, mr: { title: string; description: string }): Promise<LandResult> {
    const r = await mergeLocal(repo.path, batch.branch, repo.base_branch, `Merge ${batch.branch}: ${mr.title}\n\n${mr.description}`);
    return r.ok ? { ok: true } : { ok: false, conflicts: r.conflicts };
  }
// GitlabMrProvider
  async landBatch(repo: Repo, batch: BatchRow, wtPath: string, mr: { title: string; description: string }): Promise<LandResult> {
    await pushBranch(wtPath, batch.branch);
    const r = await this.glab(repo.path, ['mr', 'create', '--source-branch', batch.branch, '--target-branch', repo.base_branch, '--title', mr.title, '--description', mr.description, '--yes']);
    if (r.code !== 0) throw new Error(`glab mr create failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return { ok: true, mrUrl: r.stdout.match(/https?:\/\/\S+/)?.[0] };
  }
```

Import `BatchRow` from `@overseer/shared`. In `provider.test.ts` copy the existing gitlab `land` test for `landBatch` with a `BatchRow` literal (`{ id: 'r1-b1', repo_id: 'r1', title: 'T', branch: 'feature/t', base_branch: 'main', status: 'review', note: null, mr_url: null, conflict_files: null, created_at: 't', updated_at: 't', merged_at: null }`) and assert the glab args contain `'--source-branch', 'feature/t'`.

- [ ] **Step 2: Lifecycle tests.** Append to `lifecycle.test.ts` (inside `describe('Lifecycle')`):

```ts
  it('batches: create, dispatch onto the branch, integrate on pass, review, merge', async () => {
    const x = setup();
    const b = await x.lc.createBatch('r1', 'Trend chart');
    expect(b).toMatchObject({ id: 'r1-b1', branch: 'feature/trend-chart', status: 'open' });
    expect(sh(x.repo.path, ['branch', '--list', 'feature/trend-chart'])).toContain('feature/trend-chart');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', 'claude', undefined, 'r1-b1');
    const wt = x.db.worktrees.get('ov-1')!;
    expect(wt.batch_id).toBe('r1-b1');
    expect(wt.base_branch).toBe('feature/trend-chart');
    expect(x.fake.sent(x.sessions.handleOf(sid)!)[0]).toContain('based on `feature/trend-chart`');
    commitFile(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'closed', 5000, 'integrated');
    expect(await x.phase()).toBe('merged');
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(sh(x.repo.path, ['show', 'feature/trend-chart:hello.txt'])).toBe('hi');
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/trend-chart (1/1 beads done)');

    await x.lc.requestBatchReview('r1', 'r1-b1', 'Adds hello.txt');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'Adds hello.txt' });
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b1')?.status).toBe('merged');
    expect(fs.existsSync(path.join(x.repo.path, 'hello.txt'))).toBe(true);
    expect(sh(x.repo.path, ['branch', '--list', 'feature/trend-chart'])).toBe('');
    expect(fs.existsSync(path.join(path.dirname(wt.path), 'batch-r1-b1'))).toBe(false);
  });

  it('batches: verification failure reopens the bead without user review', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Fails');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', 'claude', undefined, 'r1-b1');
    commitFile(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && (await x.phase()) === null, 5000, 'reopened');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Verification failed');
    expect(x.notes.at(-1)).toMatch(/^ov-1 reopened: verification failed/);
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'n')).rejects.toThrow(/still open/);
  });

  it('batches: integration conflict reopens the bead with conflict files', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Clash');
    const batchWt = path.join(path.dirname(x.db.worktrees.get('ov-1')?.path ?? path.join(x.repo.path, '..', 'worktrees', 'r1', 'x')), 'batch-r1-b1');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', 'claude', undefined, 'r1-b1');
    const wt = x.db.worktrees.get('ov-1')!;
    commitFile(wt.path, 'README.md', '# bead\n', 'bead side');
    commitFile(path.join(path.dirname(wt.path), 'batch-r1-b1'), 'README.md', '# batch\n', 'batch side');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', 5000, 'reopened');
    expect(x.db.worktrees.get('ov-1')?.conflict_files).toEqual(['README.md']);
    expect(x.notes.at(-1)).toMatch(/conflicted in: README.md/);
    void batchWt;
  });

  it('batches: reject, abandon and interrupt', async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Second' });
    await x.lc.createBatch('r1', 'Two beads');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', 'claude', undefined, 'r1-b1');
    commitFile(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'closed', 5000, 'integrated');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'first pass');
    await x.lc.rejectBatch('r1-b1', 'needs the second file');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'open' });
    expect(x.db.batches.get('r1-b1')?.note).toContain('Rejected: needs the second file');
    expect(x.notes.at(-1)).toBe('Batch r1-b1 rejected: needs the second file');

    const sid2 = await x.lc.spawnWorker('r1', 'ov-2', 'claude', undefined, 'r1-b1');
    await expect(x.lc.interruptBead('ov-1')).rejects.toBeInstanceOf(LifecycleError);
    await x.lc.abandonBatch('r1-b1');
    await until(() => x.db.sessions.get(sid2)?.status !== 'running', 5000, 'worker stopped');
    expect(x.fake.sessions.get(x.sessions.handleOf(sid2)?.id ?? '')?.interrupted ?? true).toBe(true);
    expect(await x.status('ov-2')).toBe('closed');
    expect(x.db.batches.get('r1-b1')?.status).toBe('abandoned');
    expect(sh(x.repo.path, ['branch', '--list', 'feature/two-beads'])).toBe('');
    expect(x.db.worktrees.forBatch('r1-b1')).toHaveLength(0);
    expect(x.notes.at(-1)).toBe('Batch r1-b1 abandoned by the user');

    const sid3 = await x.lc.spawnWorker('r1', 'ov-1', 'claude');
    await x.lc.interruptBead('ov-1');
    await until(() => x.db.sessions.get(sid3)?.status !== 'running', 5000, 'interrupted');
  });
```

Note for the abandon assertion on `interrupted`: `sessions.handleOf` returns `undefined` once the session finished, so the expression falls back to `true`; the meaningful checks are the status transitions.

- [ ] **Step 3: Run** → FAIL (methods missing).

- [ ] **Step 4: Implement** in `lifecycle.ts`.

Imports: add `BatchRow` to the shared type import; from `../git/git` import `createBranch, ensureBranchWorktree, mergeInto, deleteBranch, diffRefs, removeWorktree, removeWorktreeRetry` alongside the existing ones.

Helper at module level:

```ts
export function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'batch';
}
const batchWorktreePath = (worktreesDir: string, repoId: string, batchId: string) => path.join(worktreesDir, repoId, `batch-${batchId}`);
```

`spawnWorker` gains a fifth parameter `batchId?: string`:

```ts
  async spawnWorker(repoId: string, beadId: string, harness: HarnessName, instructions?: string, batchId?: string): Promise<string> {
    ... (existing checks) ...
    const batch = batchId ? db.batches.get(batchId) : undefined;
    if (batchId && (!batch || batch.repo_id !== repoId)) throw new LifecycleError(`batch ${batchId} not found in ${repoId}`);
    if (batch && batch.status !== 'open') throw new LifecycleError(`batch ${batchId} is ${batch.status}`);
    const base = batch?.branch ?? repo.base_branch;
    if (batch) await ensureBranchWorktree(repo, batch.branch, batchWorktreePath(config.worktreesDir, repo.id, batch.id));
    const wt = await ensureWorktree(repo, beadId, config.worktreesDir, base);
    const existing = db.worktrees.get(beadId);
    const conflicts = existing?.conflict_files ?? [];
    db.worktrees.upsert({ bead_id: beadId, repo_id: repoId, path: wt.path, branch: wt.branch, base_branch: base, verify_status: null, verify_output: null, review_note: null, conflict_files: existing?.conflict_files ?? null, merged_at: null, mr_url: null, batch_id: batch?.id ?? null });
    const prompt = buildWorkerPrompt(this.workerTemplate, { bead, branch: wt.branch, base, conflicts, instructions });
    ... (rest unchanged) ...
  }
```

`onWorkerEnded`: replace the `else` branch:

```ts
    } else if (wt.batch_id) {
      await this.integrate(repo, wt, session.bead_id);
    } else {
      const status = await this.verify(repo, wt, session.bead_id);
      await notify(`${session.bead_id} is in review; verification ${status}`).catch((err) => console.error('lifecycle: review notify failed', err));
    }
```

New private method:

```ts
  private async integrate(repo: Repo, wt: WorktreeRow, beadId: string): Promise<void> {
    const { db, store, notify, config } = this.d;
    const batch = db.batches.get(wt.batch_id!)!;
    const status = await this.verify(repo, wt, beadId);
    if (status !== 'pass') {
      const tail = (db.worktrees.get(beadId)?.verify_output ?? '').slice(-2000);
      await store.setStatus(repo.path, beadId, 'open');
      await store.setPhase(repo.path, beadId, null);
      await store.appendNote(repo.path, beadId, `Verification failed:\n${tail}`);
      await notify(`${beadId} reopened: verification failed on ${batch.branch}. Fix it and re-dispatch with instructions.\n${tail.slice(-600)}`).catch((err) => console.error('lifecycle: verify-fail notify failed', err));
      return;
    }
    const batchWt = await ensureBranchWorktree(repo, batch.branch, batchWorktreePath(config.worktreesDir, repo.id, batch.id));
    const bead = await store.show(repo.path, beadId);
    const r = await mergeInto(batchWt.path, wt.branch, `Merge ${wt.branch}: ${bead?.title ?? beadId}`);
    if (!r.ok) {
      db.worktrees.update(beadId, { conflict_files: r.conflicts });
      await store.setStatus(repo.path, beadId, 'open');
      await store.setPhase(repo.path, beadId, null);
      await notify(`${beadId} conflicted in: ${r.conflicts.join(', ')} when merging into ${batch.branch}. Re-dispatch with spawn_worker (same batch_id) to rebase; the worker prompt lists the files.`).catch((err) => console.error('lifecycle: integrate-conflict notify failed', err));
      return;
    }
    await store.close(repo.path, beadId, `merged into ${batch.branch}`);
    await store.setPhase(repo.path, beadId, 'merged');
    db.worktrees.update(beadId, { merged_at: new Date().toISOString(), conflict_files: null });
    await removeWorktreeRetry(repo.path, wt.path, wt.branch);
    const all = db.worktrees.forBatch(batch.id);
    const done = all.filter((w) => w.merged_at).length;
    await notify(`${beadId} landed on ${batch.branch} (${done}/${all.length} beads done)`).catch((err) => console.error('lifecycle: landed notify failed', err));
  }
```

`verify` must not set phase `review` for batch beads. Change its last line to take the target phase: `await store.setPhase(repo.path, beadId, wt.batch_id ? 'verifying' : 'review');` is wrong for the fail path; simplest: give `verify` a third parameter `finalPhase: Phase` and pass `'review'` from the v1 path and `'verifying'` from `integrate` (integrate then sets the real phase). Import `Phase` from shared.

Batch methods:

```ts
  async createBatch(repoId: string, title: string, branch?: string): Promise<BatchRow> {
    const { db, config } = this.d;
    const repo = db.repos.get(repoId);
    if (!repo) throw new LifecycleError(`repo ${repoId} not found`);
    const name = branch?.trim() || `feature/${slug(title)}`;
    if (db.batches.all().some((b) => b.repo_id === repoId && b.branch === name && b.status !== 'merged' && b.status !== 'abandoned')) throw new LifecycleError(`branch ${name} already has an open batch`);
    await createBranch(repo.path, name, repo.base_branch);
    const id = db.batches.nextId(repoId);
    await ensureBranchWorktree(repo, name, batchWorktreePath(config.worktreesDir, repo.id, id));
    const ts = new Date().toISOString();
    const row: BatchRow = { id, repo_id: repoId, title, branch: name, base_branch: repo.base_branch, status: 'open', note: null, mr_url: null, conflict_files: null, created_at: ts, updated_at: ts, merged_at: null };
    db.batches.insert(row);
    this.d.bus.emit('board');
    return row;
  }

  async requestBatchReview(repoId: string, batchId: string, note: string): Promise<{ mrUrl?: string }> {
    const { db, store, notify, config } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch || batch.repo_id !== repoId) throw new LifecycleError(`batch ${batchId} not found in ${repoId}`);
    if (batch.status !== 'open') throw new LifecycleError(`batch ${batchId} is ${batch.status}`);
    const repo = db.repos.get(repoId)!;
    const open: string[] = [];
    for (const w of db.worktrees.forBatch(batchId)) {
      const bead = await store.show(repo.path, w.bead_id);
      if (bead && bead.status !== 'closed') open.push(bead.id);
    }
    if (open.length) throw new LifecycleError(`batch ${batchId} still open: ${open.join(', ')} not done`);
    db.batches.update(batchId, { status: 'review', note });
    let mrUrl: string | undefined;
    if (repo.merge_mode === 'gitlab-mr') {
      const r = await this.d.provider(repo).landBatch(repo, { ...batch, note }, batchWorktreePath(config.worktreesDir, repo.id, batch.id), { title: batch.title, description: note });
      mrUrl = r.ok ? r.mrUrl : undefined;
      db.batches.update(batchId, { mr_url: mrUrl ?? null });
      await notify(`Batch ${batchId} is ready for review: ${mrUrl ?? 'MR created'}`).catch((err) => console.error('lifecycle: mr notify failed', err));
    }
    this.d.bus.emit('board');
    return { mrUrl };
  }

  async mergeBatch(batchId: string): Promise<{ mrUrl?: string }> {
    const { db, bus, notify, config } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    if (batch.status !== 'review') throw new LifecycleError(`batch ${batchId} is not in review`);
    const repo = db.repos.get(batch.repo_id)!;
    const wtPath = batchWorktreePath(config.worktreesDir, repo.id, batch.id);
    if (repo.merge_mode === 'local-merge') {
      const r = await this.d.provider(repo).landBatch(repo, batch, wtPath, { title: batch.title, description: batch.note ?? batch.title });
      if (!r.ok) {
        db.batches.update(batchId, { conflict_files: r.conflicts });
        await notify(`Merge of batch ${batchId} (${batch.branch}) into ${repo.base_branch} conflicted in: ${r.conflicts.join(', ')}. Add a bead to the batch that rebases ${batch.branch} onto ${repo.base_branch}.`).catch((err) => console.error('lifecycle: batch-conflict notify failed', err));
        bus.emit('board');
        throw new MergeConflictError(r.conflicts);
      }
    }
    db.batches.update(batchId, { status: 'merged', merged_at: new Date().toISOString(), conflict_files: null });
    await this.cleanupBatch(repo, batch);
    bus.emit('board');
    return { mrUrl: batch.mr_url ?? undefined };
  }

  async rejectBatch(batchId: string, note: string): Promise<void> {
    const { db, bus, notify } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    if (batch.status !== 'review') throw new LifecycleError(`batch ${batchId} is not in review`);
    db.batches.update(batchId, { status: 'open', note: `${batch.note ?? ''}\n\nRejected: ${note}`.trim() });
    await notify(`Batch ${batchId} rejected: ${note}`).catch((err) => console.error('lifecycle: reject notify failed', err));
    bus.emit('board');
  }

  async abandonBatch(batchId: string): Promise<void> {
    const { db, store, sessions, bus, notify } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    if (batch.status === 'merged' || batch.status === 'abandoned') throw new LifecycleError(`batch ${batchId} is ${batch.status}`);
    const repo = db.repos.get(batch.repo_id)!;
    for (const w of db.worktrees.forBatch(batchId)) {
      for (const s of db.sessions.forBead(w.bead_id)) if (s.status === 'running' && sessions.isLive(s.id)) await sessions.interrupt(s.id);
      const bead = await store.show(repo.path, w.bead_id);
      if (bead && bead.status !== 'closed') { await store.close(repo.path, w.bead_id, 'abandoned'); await store.setPhase(repo.path, w.bead_id, null); }
    }
    db.batches.update(batchId, { status: 'abandoned' });
    await this.cleanupBatch(repo, batch);
    await notify(`Batch ${batchId} abandoned by the user`).catch((err) => console.error('lifecycle: abandon notify failed', err));
    bus.emit('board');
  }

  async interruptBead(beadId: string): Promise<void> {
    const s = this.d.db.sessions.forBead(beadId).find((r) => r.status === 'running');
    if (!s || !this.d.sessions.isLive(s.id)) throw new LifecycleError(`no running worker for ${beadId}`);
    await this.d.sessions.interrupt(s.id);
  }

  private async cleanupBatch(repo: Repo, batch: BatchRow): Promise<void> {
    const { db, config } = this.d;
    for (const w of db.worktrees.forBatch(batch.id)) {
      try { await removeWorktreeRetry(repo.path, w.path, w.branch); } catch (err) { console.error(`lifecycle: could not remove ${w.path}`, err); }
      db.worktrees.delete(w.bead_id);
    }
    const wtPath = batchWorktreePath(config.worktreesDir, repo.id, batch.id);
    try { await removeWorktreeRetry(repo.path, wtPath, batch.branch); } catch (err) { console.error(`lifecycle: could not remove ${wtPath}`, err); }
    await deleteBranch(repo.path, batch.branch);
  }
```

Note: `abandonBatch` interrupts before closing beads; the session-end handler will then see the bead and may try to verify/integrate. Guard the top of `onWorkerEnded`: `if (wt.batch_id && db.batches.get(wt.batch_id)?.status === 'abandoned') return;` and in `interruptBead`/abandon rely on the existing `interrupt → end` path. Because `abandonBatch` deletes the worktree rows, `onWorkerEnded` finds `wt` undefined and returns early — that is enough; add the guard anyway for the window before deletion.

`recover()` unchanged.

- [ ] **Step 5: Run** `pnpm --filter @overseer/daemon exec vitest run lifecycle provider git` → PASS. Fix timing or path issues in the tests rather than weakening assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/lifecycle/lifecycle.ts packages/daemon/src/lifecycle/lifecycle.test.ts packages/daemon/src/git/provider.ts packages/daemon/src/git/provider.test.ts
git commit -m "Add the batch lifecycle: feature branch per request, auto-integration, batch review"
```

---

### Task 7: MCP tools and prompts for batches

**Goal:** The orchestrator can create batches, dispatch onto them, list them and request batch review; the prompts describe the new flow.

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts`
- Modify: `packages/daemon/prompts/orchestrator.md`
- Modify: `packages/daemon/prompts/worker.md` (one sentence)
- Test: `packages/daemon/src/mcp/mcp.test.ts`, `packages/daemon/src/orchestrator/orchestrator.test.ts:574-578`

**Acceptance Criteria:**
- [ ] Tool list has 13 tools: the ten existing plus `create_batch`, `list_batches`, `request_batch_review`.
- [ ] `spawn_worker` accepts optional `batch_id` and passes it through.
- [ ] `list_batches(repo)` returns batches with `beads_total` and `beads_done`.
- [ ] `orchestrator.md` mentions `create_batch`, `batch_id`, `request_batch_review`, and still contains `blocked-by:` and not `blocks:`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run mcp orchestrator` → green.

**Steps:**

- [ ] **Step 1: Tests.** In `mcp.test.ts` change `lists the ten tools` to expect the thirteen names (sorted), and add:

```ts
  it('create_batch, spawn onto it, list_batches, request_batch_review', async () => {
    const x = await setupClient(); // reuse the file's existing client setup helper
    const created = await call('create_batch', { repo: 'r1', title: 'Trend chart' });
    expect(created).toMatchObject({ batch_id: 'r1-b1', branch: 'feature/trend-chart' });
    const spawned = await call('spawn_worker', { repo: 'r1', bead_id: 'ov-1', harness: 'claude', batch_id: 'r1-b1' });
    expect(spawned).toMatchObject({ bead_id: 'ov-1', batch_id: 'r1-b1' });
    expect(x.db.worktrees.get('ov-1')?.batch_id).toBe('r1-b1');
    const list = await call('list_batches', { repo: 'r1' });
    expect(list).toEqual([expect.objectContaining({ id: 'r1-b1', beads_total: 1, beads_done: 0 })]);
    const r = await call('request_batch_review', { repo: 'r1', batch_id: 'r1-b1', note: 'n' });
    expect(String(r)).toMatch(/still open/);
  });
```

Adapt `setupClient`/`call` names to the helpers that already exist in the file (read its first 55 lines). `call` must return the parsed JSON for `ok` results and the error text for `isError` results.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** in `tools.ts`:

```ts
  server.tool('create_batch', 'Create a batch: one feature branch for one user request. Every bead of the request is dispatched with this batch_id and merges into the branch automatically once verified. Optional branch name, default feature/<slug of title>.', { repo: z.string(), title: z.string().min(1), branch: z.string().optional() }, guard(async ({ repo, title, branch }) => {
    const b = await d.lifecycle.createBatch(repoOf(repo).id, title, branch);
    return { batch_id: b.id, branch: b.branch, base_branch: b.base_branch };
  }));

  server.tool('list_batches', 'Batches of a repo with bead counts and status (open, review, merged, abandoned).', { repo: z.string() }, guard(async ({ repo }) => {
    const r = repoOf(repo);
    return d.db.batches.forRepo(r.id).map((b) => {
      const wts = d.db.worktrees.forBatch(b.id);
      return { ...b, beads_total: wts.length, beads_done: wts.filter((w) => w.merged_at).length };
    });
  }));

  server.tool('request_batch_review', 'When every bead of the batch is done, hand the feature branch to the user: the note is the review summary and the merge-request description (what changed and why, how it was verified). In gitlab-mr repos this pushes and opens the MR.', { repo: z.string(), batch_id: z.string(), note: z.string().min(1) }, guard(async ({ repo, batch_id, note }) => {
    const r = await d.lifecycle.requestBatchReview(repoOf(repo).id, batch_id, note);
    return { in_review: true, batch_id, mr_url: r.mrUrl ?? null };
  }));
```

Change `spawn_worker`'s schema to `{ repo: z.string(), bead_id: z.string(), harness, instructions: z.string().optional(), batch_id: z.string().optional() }`, the call to `d.lifecycle.spawnWorker(repo, bead_id, h as HarnessName, instructions, batch_id)`, and the result to `{ session_id: id, bead_id, harness: h, batch_id: batch_id ?? null }`. Update its description: "Pass batch_id so the worker branches from the batch's feature branch."

- [ ] **Step 4: Prompts.** Replace the `## How to work` section of `orchestrator.md` with:

```markdown
## How to work

1. Every user request becomes one batch: call `create_batch(repo, title)` first (title from the request, e.g. the work item number and name). The batch owns a feature branch; all work for the request lands there and the user reviews it once.
2. Look at the repo with `list_tasks`, then create small beads with clear descriptions and `blocked-by:` dependencies (the new bead depends on the given id).
3. Dispatch ready beads with `spawn_worker(..., batch_id)`. Prefer `claude` unless the user asks for another harness. One worker per bead; the repo has a worker limit.
4. When a worker finishes, Overseer verifies the branch and merges it into the batch branch, or reopens the bead (no commits, failed verification, or a merge conflict) and tells you why in a `[Overseer]` message. Re-dispatch reopened beads with `instructions` that address the note; keep the same `batch_id`.
5. When `list_batches` shows every bead of the batch done, call `request_batch_review(repo, batch_id, note)`. The note is what the user reads: what changed, why, and how it was verified. In `gitlab-mr` repos it becomes the MR description.
6. The user merges, rejects or abandons the batch in the Review view. A rejection arrives as `[Overseer] Batch <id> rejected: <note>`; add beads to the same batch that address it and request review again.
7. `request_merge` (per-bead review) exists for beads dispatched without a batch; do not use it for batch beads.
8. Keep chat replies short. Report what you did and what you are waiting on.
```

Also add `create_batch`, `list_batches` and `request_batch_review` lines to the `## Tools` list, and change the `spawn_worker` line to mention `batch_id`. In `worker.md` change the first sentence to: "You are working on one task in an isolated git worktree on branch `{{branch}}` (based on `{{base}}`, which is the branch your work is merged into). Commit your work on this branch. Do not switch branches, push, or open pull requests."

In `orchestrator.test.ts` extend the prompt test:

```ts
    expect(prompt).toContain('create_batch');
    expect(prompt).toContain('request_batch_review');
```

- [ ] **Step 5: Run** `pnpm --filter @overseer/daemon exec vitest run mcp orchestrator lifecycle` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/mcp/tools.ts packages/daemon/src/mcp/mcp.test.ts packages/daemon/prompts/orchestrator.md packages/daemon/prompts/worker.md packages/daemon/src/orchestrator/orchestrator.test.ts
git commit -m "Expose batches to the orchestrator and describe the feature-branch flow in the prompts"
```

---

### Task 8: REST: batches on the board, batch endpoints, interrupt, sessions, events, costs

**Goal:** The web app can read batches, act on them, stop a worker, and read traces and costs.

**Files:**
- Modify: `packages/daemon/src/api/board.ts`
- Modify: `packages/daemon/src/api/rest.ts`
- Test: `packages/daemon/src/api/board.test.ts`, `packages/daemon/src/app.test.ts`

**Acceptance Criteria:**
- [ ] `GET /api/board` repos carry `batches: BatchSummary[]` (with `beads_total`, `beads_done`, `cost`) and cards carry `batch_id`.
- [ ] `GET /api/batches/:id` → `BatchDetail` with `diff` from `diffRefs(base, branch)`; 404 when unknown.
- [ ] `POST /api/batches/:id/merge|reject|abandon` map to the lifecycle; reject requires `note`.
- [ ] `POST /api/tasks/:id/interrupt` → 200 with `{ ok: true }` when a worker runs, 400 otherwise.
- [ ] `GET /api/sessions?bead_id=` and `?repo=` filter; `GET /api/sessions/:id/events` returns the ordered events; 404 for an unknown session.
- [ ] `GET /api/costs` sums `sessions.cost` per repo (total and today, UTC date) and per batch.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run board app` → green.

**Steps:**

- [ ] **Step 1: Board.** In `board.ts`:

```ts
export function batchSummaries(db: Db, repoId: string): BatchSummary[] {
  return db.batches.forRepo(repoId).map((b) => {
    const wts = db.worktrees.forBatch(b.id);
    const cost = wts.reduce((sum, w) => sum + db.sessions.forBead(w.bead_id).reduce((s, x) => s + (x.cost ?? 0), 0), 0);
    return { ...b, beads_total: wts.length, beads_done: wts.filter((w) => w.merged_at).length, cost };
  });
}
```

In `buildBoard` use `batches: batchSummaries(db, repo.id)`; in `cardsFor` add `batch_id: wt?.batch_id ?? null` to the card. Import `BatchSummary`.

Test in `board.test.ts` (extend the first test): insert a batch row and set `batch_id: 'r1-b1'` on the `ov-3` worktree, then:

```ts
    expect(board.repos[0]!.batches).toEqual([expect.objectContaining({ id: 'r1-b1', beads_total: 1, beads_done: 0, cost: 0.4 })]);
    expect(running.batch_id).toBe('r1-b1');
```

- [ ] **Step 2: REST.** In `rest.ts` add (imports: `diffRefs` from `../git/git`, `BatchDetail`, `CostsResponse`, `SessionRow` from shared; `batchSummaries` not needed here):

```ts
  app.get<{ Params: { id: string } }>('/api/batches/:id', async (req, reply) => {
    const batch = d.db.batches.get(req.params.id);
    if (!batch) return reply.code(404).send({ error: `batch ${req.params.id} not found` });
    const repo = d.db.repos.get(batch.repo_id)!;
    const board = await buildBoard(d.db, d.store);
    const cards = board.repos.find((r) => r.repo.id === repo.id)?.cards.filter((c) => c.batch_id === batch.id) ?? [];
    const summary = board.repos.find((r) => r.repo.id === repo.id)?.batches.find((b) => b.id === batch.id);
    const diff = batch.status === 'merged' || batch.status === 'abandoned' ? null : await diffRefs(repo.path, batch.base_branch, batch.branch).catch(() => null);
    const detail: BatchDetail = { batch, repo, beads: cards, diff, cost: summary?.cost ?? 0 };
    return detail;
  });

  app.post<{ Params: { id: string } }>('/api/batches/:id/merge', async (req) => {
    const r = await d.lifecycle.mergeBatch(req.params.id);
    return { ok: true, mr_url: r.mrUrl ?? null };
  });
  app.post<{ Params: { id: string } }>('/api/batches/:id/reject', async (req) => {
    const { note } = z.object({ note: z.string().min(1) }).parse(req.body ?? {});
    await d.lifecycle.rejectBatch(req.params.id, note);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/batches/:id/abandon', async (req) => {
    await d.lifecycle.abandonBatch(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/interrupt', async (req) => {
    await d.lifecycle.interruptBead(req.params.id);
    return { ok: true };
  });

  app.get('/api/sessions', async (req) => {
    const q = z.object({ bead_id: z.string().optional(), repo: z.string().optional() }).parse(req.query ?? {});
    const rows = q.bead_id ? d.db.sessions.forBead(q.bead_id) : d.db.sessions.all();
    return q.repo ? rows.filter((s) => s.repo_id === q.repo) : rows;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/events', async (req, reply) => {
    if (!d.db.sessions.get(req.params.id)) return reply.code(404).send({ error: `session ${req.params.id} not found` });
    return d.db.events.forSession(req.params.id);
  });

  app.get('/api/costs', async (): Promise<CostsResponse> => {
    const today = new Date().toISOString().slice(0, 10);
    const all = d.db.sessions.all();
    const repos = d.db.repos.all().map((r) => {
      const mine = all.filter((s) => s.repo_id === r.id);
      const sum = (rows: SessionRow[]) => rows.reduce((a, s) => a + (s.cost ?? 0), 0);
      return { repo_id: r.id, total: sum(mine), today: sum(mine.filter((s) => s.started_at.slice(0, 10) === today)) };
    });
    const batches = d.db.batches.all().map((b) => ({ batch_id: b.id, total: d.db.worktrees.forBatch(b.id).reduce((a, w) => a + d.db.sessions.forBead(w.bead_id).reduce((x, s) => x + (s.cost ?? 0), 0), 0) }));
    return { repos, batches };
  });
```

Add `all: () => this.sql.prepare('SELECT * FROM sessions ORDER BY started_at').all() as unknown as SessionRow[],` to `db.sessions` in `db.ts`.

- [ ] **Step 3: app.test.** Append a test:

```ts
  it('batches, interrupt, sessions, events and costs over REST', async () => {
    x.store.add(x.t.path, { id: 'ov-b1', title: 'Batch bead' });
    const b = await x.lifecycle.createBatch('r1', 'Rest batch');
    expect((await json('GET', `/api/batches/${b.id}`)).body).toMatchObject({ batch: { id: b.id, status: 'open' }, beads: [], diff: '' });
    expect((await json('GET', '/api/batches/nope')).status).toBe(404);
    const sid = await x.lifecycle.spawnWorker('r1', 'ov-b1', 'claude', undefined, b.id);
    const board = (await json('GET', '/api/board')).body as BoardResponse;
    expect(board.repos[0]!.batches[0]).toMatchObject({ id: b.id, beads_total: 1, beads_done: 0 });
    expect((await json('GET', `/api/sessions?bead_id=ov-b1`)).body).toHaveLength(1);
    expect((await json('GET', `/api/sessions/${sid}/events`)).body[0]).toMatchObject({ type: 'process_start' });
    expect((await json('GET', '/api/sessions/nope/events')).status).toBe(404);
    expect((await json('POST', '/api/tasks/ov-b1/interrupt')).status).toBe(200);
    await until(() => x.db.sessions.get(sid)?.status !== 'running');
    expect((await json('POST', '/api/tasks/ov-b1/interrupt')).status).toBe(400);
    expect((await json('POST', `/api/batches/${b.id}/reject`, {})).status).toBe(400);
    expect((await json('POST', `/api/batches/${b.id}/abandon`)).status).toBe(200);
    expect(x.db.batches.get(b.id)?.status).toBe('abandoned');
    const costs = (await json('GET', '/api/costs')).body;
    expect(costs.repos).toEqual([expect.objectContaining({ repo_id: 'r1' })]);
  });
```

This test assumes repo `r1` was registered by the earlier test in the same file (it is; the tests share `x`). If `ov-b1` needs `.beads`, the earlier setup already created it.

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon exec vitest run board app` and `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/api packages/daemon/src/db/db.ts packages/daemon/src/app.test.ts
git commit -m "Expose batches, worker interrupt, session traces and costs over REST"
```

---

### Task 9: Orchestrator idle expiry, preamble and reset

**Goal:** Idle orchestrator sessions end; the next message starts fresh with a preamble; a reset endpoint and button do the same on demand.

**Files:**
- Modify: `packages/daemon/src/config.ts` (add `orchestratorIdleMs`)
- Modify: `packages/daemon/src/orchestrator/orchestrator.ts`
- Modify: `packages/daemon/src/api/rest.ts` (reset route, status age)
- Modify: `packages/shared/src/index.ts` (`StatusResponse.orchestrator.last_activity_at`)
- Test: `packages/daemon/src/orchestrator/orchestrator.test.ts`, `packages/daemon/src/config.test.ts`

**Acceptance Criteria:**
- [ ] `OVERSEER_ORCHESTRATOR_IDLE_MIN` (default 30) → `config.orchestratorIdleMs`.
- [ ] A message after `idleMs` of inactivity ends the live session and starts a new one without `resumeId`, whose first prompt starts with `[Overseer] New orchestrator session` and lists open batches.
- [ ] A restart resumes the previous native session only when its last activity is within `idleMs`.
- [ ] `reset()` ends the live session; the next message starts fresh. `POST /api/orchestrator/reset` → `{ ok: true }`.
- [ ] `status()` includes `last_activity_at`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run orchestrator config app` → green.

**Steps:**

- [ ] **Step 1: Config.** Add `orchestratorIdleMs: number;` to `Config` and `orchestratorIdleMs: Number(env.OVERSEER_ORCHESTRATOR_IDLE_MIN ?? 30) * 60_000,` to `loadConfig`. In `config.test.ts` add an assertion that `loadConfig({ OVERSEER_ORCHESTRATOR_IDLE_MIN: '5' }).orchestratorIdleMs` is `300000` and the default is `1800000`.

- [ ] **Step 2: Tests.** In `orchestrator.test.ts` change the restart test's `ended_at` to `new Date(Date.now() - 60_000).toISOString()` (still resumes), and add:

```ts
  it('does not resume a session older than the idle window and sends a preamble', async () => {
    const x = setup();
    x.db.repos.insert({ id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, merge_mode: 'local-merge', worker_limit: 2 });
    x.db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Trend chart', branch: 'feature/trend-chart', base_branch: 'main', status: 'open', note: null, mr_url: null, conflict_files: null, created_at: 't', updated_at: 't', merged_at: null });
    x.db.sessions.insert({ id: 'old', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: 'native-old', pid: null, pid_started_at: null, start_commit: null, cwd: x.config.orchestratorDir, status: 'ended', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z', cost: null });
    await x.orch.sendUser('hello again');
    const row = x.db.sessions.latest('orchestrator')!;
    const s = x.fake.sessions.get(x.sessions.handleOf(row.id)!.id)!;
    expect(s.opts.resumeId).toBeUndefined();
    expect(s.opts.prompt).toMatch(/^\[Overseer\] New orchestrator session/);
    expect(s.opts.prompt).toContain('r1-b1 "Trend chart" on feature/trend-chart (0/0 beads done)');
    expect(s.opts.prompt.endsWith('hello again')).toBe(true);
  });

  it('ends an idle live session before delivering and on reset', async () => {
    const x = setup();
    x.config.orchestratorIdleMs = 50;
    await x.orch.sendUser('one');
    const first = x.db.sessions.latest('orchestrator')!;
    await new Promise((r) => setTimeout(r, 80));
    await x.orch.sendUser('two');
    await until(() => x.db.sessions.get(first.id)?.status === 'ended');
    const second = x.db.sessions.latest('orchestrator')!;
    expect(second.id).not.toBe(first.id);
    expect(x.fake.sessions.get(x.sessions.handleOf(second.id)!.id)!.opts.prompt).toContain('two');
    await x.orch.reset();
    await until(() => x.db.sessions.get(second.id)?.status === 'ended');
    expect(x.orch.status().status).toBe('ended');
    expect(x.orch.status().last_activity_at).toBeTruthy();
  });
```

`setup()` in that file builds `config` with spread; `orchestratorIdleMs` is mutable on the object, so `x.config.orchestratorIdleMs = 50` works because `Orchestrator` keeps the same object reference.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** in `orchestrator.ts`:

```ts
export class Orchestrator {
  private sessionId: string | null = null;
  private lastActivityAt: number = 0;
  private fresh = false;

  constructor(private d: OrchestratorDeps) {
    d.bus.on('event', (e) => {
      if (e.session_id !== this.sessionId) return;
      this.lastActivityAt = Date.now();
      if (e.type !== 'assistant_text') return;
      ...unchanged...
    });
    d.bus.on('session:ended', (e) => { if (e.session.id === this.sessionId) d.bus.emit('status'); });
  }

  status(): StatusResponse['orchestrator'] {
    const row = this.sessionId ? this.d.db.sessions.get(this.sessionId) : this.d.db.sessions.latest('orchestrator');
    const last = this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : row?.ended_at ?? row?.started_at ?? null;
    if (!row) return { status: 'idle', native_session_id: null, last_activity_at: null };
    return { status: row.status, native_session_id: row.native_session_id, last_activity_at: last };
  }

  /** Ends the live session (if any); the next message starts a fresh one. */
  async reset(): Promise<void> {
    if (this.sessionId && this.d.sessions.isLive(this.sessionId)) await this.d.sessions.end(this.sessionId);
    this.fresh = true;
    this.d.bus.emit('status');
  }

  private async deliver(text: string): Promise<void> {
    const { config, db, sessions } = this.d;
    const idle = Date.now() - this.lastActivityAt > config.orchestratorIdleMs;
    if (this.sessionId && sessions.isLive(this.sessionId)) {
      if (!idle) { this.lastActivityAt = Date.now(); await sessions.send(this.sessionId, text); return; }
      await sessions.end(this.sessionId);
      this.fresh = true;
    }
    fs.mkdirSync(config.orchestratorDir, { recursive: true });
    const previous = db.sessions.latest('orchestrator');
    const previousAt = previous ? Date.parse(previous.ended_at ?? previous.started_at) : 0;
    const resume = !this.fresh && previous?.native_session_id && Date.now() - previousAt <= config.orchestratorIdleMs ? previous.native_session_id : undefined;
    const prompt = resume ? text : `${this.preamble()}\n\n${text}`;
    const row = sessions.start({ role: 'orchestrator', harness: 'claude', cwd: config.orchestratorDir, prompt, systemPromptFile: path.join(config.promptsDir, 'orchestrator.md'), mcpServers: [{ name: 'overseer', url: `http://127.0.0.1:${config.port}/mcp` }], resumeId: resume, keepAlive: true });
    this.sessionId = row.id;
    this.fresh = false;
    this.lastActivityAt = Date.now();
    this.d.bus.emit('status');
  }

  private preamble(): string {
    const open = this.d.db.batches.all().filter((b) => b.status === 'open' || b.status === 'review').map((b) => {
      const wts = this.d.db.worktrees.forBatch(b.id);
      return `${b.id} "${b.title}" on ${b.branch} (${wts.filter((w) => w.merged_at).length}/${wts.length} beads done, ${b.status})`;
    });
    return `[Overseer] New orchestrator session (the previous one expired after inactivity or was reset). State lives in beads and the board, not in this chat. Open batches: ${open.length ? open.join('; ') : 'none'}. Call list_tasks before acting.`;
  }
```

Note the very first session of a fresh install has no previous row, so `resume` is undefined and the preamble is sent; the existing test `starts lazily...` asserts `s.opts.prompt` is `'hello'` — change that assertion to `expect(s.opts.prompt.endsWith('hello')).toBe(true)`.

Shared: `orchestrator: { status: SessionStatus | 'idle'; native_session_id: string | null; last_activity_at: string | null }`. Update `packages/web/src/test/fixtures.ts` `status` with `last_activity_at: '2026-09-12T10:00:00.000Z'`.

REST: `app.post('/api/orchestrator/reset', async () => { await d.orchestrator.reset(); return { ok: true }; });`

- [ ] **Step 5: Run** `pnpm --filter @overseer/daemon exec vitest run orchestrator config app` and `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/config.ts packages/daemon/src/config.test.ts packages/daemon/src/orchestrator packages/daemon/src/api/rest.ts packages/shared/src/index.ts packages/web/src/test/fixtures.ts
git commit -m "Expire idle orchestrator sessions, start fresh with a preamble, add reset"
```

---

### Task 10: Daemon log file

**Goal:** Daemon diagnostics go to `<dataDir>/daemon.log` as JSON lines and to the console.

**Files:**
- Create: `packages/daemon/src/util/log.ts`
- Modify: `packages/daemon/src/index.ts`, `packages/daemon/src/lifecycle/lifecycle.ts`, `packages/daemon/src/sessions/manager.ts`, `packages/daemon/src/util/procs.ts` (replace `console.error/warn/log` calls)
- Test: `packages/daemon/src/util/log.test.ts`

**Acceptance Criteria:**
- [ ] `initLog(file)` then `log.error('x', { a: 1 })` appends `{"ts":...,"level":"error","msg":"x","a":1}` to the file.
- [ ] Before `initLog`, calls only print to the console (tests stay file-free).
- [ ] No `console.` call remains in daemon `src/` outside `log.ts` and tests.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run log` and `grep -rn "console\." packages/daemon/src --include=*.ts | grep -v test | grep -v util/log.ts` → only the log test passes and the grep prints nothing.

**Steps:**

- [ ] **Step 1: Test** `log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLog, log } from './log';

describe('log', () => {
  it('appends JSON lines once a file is set', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-log-')), 'daemon.log');
    initLog(file);
    log.error('boom', { a: 1 });
    log.warn('careful');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', a: 1 });
    expect(lines[1]).toMatchObject({ level: 'warn', msg: 'careful' });
    expect(typeof lines[0].ts).toBe('string');
    initLog(null);
  });
});
```

- [ ] **Step 2: Implement** `log.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

let file: string | null = null;
export function initLog(f: string | null): void { file = f; if (f) fs.mkdirSync(path.dirname(f), { recursive: true }); }

type Level = 'info' | 'warn' | 'error';
function write(level: Level, msg: string, data?: Record<string, unknown> | unknown): void {
  const extra = data instanceof Error ? { error: data.message, stack: data.stack } : (data as Record<string, unknown> | undefined) ?? {};
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  if (file) { try { fs.appendFileSync(file, line + '\n'); } catch { /* disk problems must not take the daemon down */ } }
  (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(msg, data instanceof Error ? data.message : data ?? '');
}
export const log = {
  info: (msg: string, data?: unknown) => write('info', msg, data),
  warn: (msg: string, data?: unknown) => write('warn', msg, data),
  error: (msg: string, data?: unknown) => write('error', msg, data),
};
```

- [ ] **Step 3: Replace calls.** `index.ts`: `initLog(path.join(config.dataDir, 'daemon.log'))` right after `loadConfig()`, then `log.warn(...)` / `log.info(...)`. `lifecycle.ts`, `sessions/manager.ts`, `util/procs.ts`: replace each `console.error('msg', err)` with `log.error('msg', err)` and `console.warn` with `log.warn`. Keep messages verbatim.

- [ ] **Step 4: Run** `pnpm --filter @overseer/daemon test` (whole suite, output must stay free of warnings) and the grep → PASS / empty.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/util/log.ts packages/daemon/src/util/log.test.ts packages/daemon/src/index.ts packages/daemon/src/lifecycle/lifecycle.ts packages/daemon/src/sessions/manager.ts packages/daemon/src/util/procs.ts
git commit -m "Write daemon diagnostics to daemon.log as JSON lines"
```

---

### Task 11: Web design tokens, fonts, app shell and rail

**Goal:** The slate token system, IBM Plex, the app grid and a rail with counts, repo costs and orchestrator state.

**Files:**
- Modify: `packages/web/index.html` (font link)
- Modify: `packages/web/src/styles.css` (rewrite; keep every class name the views use today, restyle them)
- Modify: `packages/web/src/components/Rail.tsx`, `packages/web/src/App.tsx`
- Test: `packages/web/src/App.test.tsx` (extend)

**Acceptance Criteria:**
- [ ] `index.html` loads `IBM+Plex+Sans:wght@400;500;600` and `IBM+Plex+Mono:wght@400;500` from Google Fonts with `preconnect`.
- [ ] `:root` defines exactly the token values listed in Global Constraints; `body` uses `var(--bg)` and `var(--text)`; `font-family: 'IBM Plex Sans', system-ui, sans-serif`.
- [ ] Rail shows: view buttons with a count badge for Board (running cards), Chat (unanswered questions), Review (batches in review + beads in review); repos with their total cost from `/api/costs`; `orchestrator: <status>` text (kept for the tests) plus a relative "last active" line and a "New session" button that posts to `/api/orchestrator/reset`.
- [ ] Existing `App.test.tsx` passes; new assertions: the rail shows `$3.10` for `r1` and clicking "New session" posts to `/api/orchestrator/reset`.

**Verify:** `pnpm --filter @overseer/web test -- App` and `pnpm typecheck` → green.

**Steps:**

- [ ] **Step 1: Test.** In `App.test.tsx`'s first test add to `mockApi`: `if (url.endsWith('/api/costs')) return { repos: [{ repo_id: 'r1', total: 3.1, today: 0.5 }], batches: [] };` and `if (method === 'POST' && url.endsWith('/api/orchestrator/reset')) { resets++; return { ok: true }; }` with `let resets = 0;`. After the existing assertions add:

```ts
    await waitFor(() => expect(screen.getByText('$3.10')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await waitFor(() => expect(resets).toBe(1));
```

Every other test in the file that mocks `/api/status` must also answer `/api/costs` (return `{ repos: [], batches: [] }`) or the unexpected-URL throw fires; add that line to each `mockApi` in the file.

- [ ] **Step 2: index.html.** Inside `<head>` add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
```

- [ ] **Step 3: styles.css.** Rewrite the file. Keep every selector that exists today (views still use them) and add the new ones below. Full content:

```css
:root {
  --bg: #151b23; --surface: #1c2430; --surface-2: #232d3a; --line: #2e3a48;
  --text: #e7ebf0; --muted: #8d99a8; --accent: #6f9ad1;
  --ready: #6f9ad1; --blocked: #c96a5c; --running: #d9a441; --verifying: #9a7fd1; --review: #3fb1a3; --done: #6fae6f;
  --warn: #c96a5c; --ok: #6fae6f; --border: var(--line);
  --sans: 'IBM Plex Sans', system-ui, sans-serif; --mono: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
  --radius: 6px;
  color-scheme: dark;
  font-family: var(--sans); font-size: 14px; line-height: 1.5; color: var(--text);
}
body { margin: 0; background: var(--bg); color: var(--text); }
h1, h2, h3, h4 { font-weight: 600; margin: 0; }
h2 { font-size: 16px; } h3 { font-size: 13px; } h4 { font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
a { color: var(--accent); }
button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #0e141b; font-weight: 500; }
button.danger { border-color: var(--blocked); color: var(--blocked); background: transparent; }
button.link { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 6px 8px; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
code, pre, .mono { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--muted); font-weight: normal; font-size: 12px; }
.ok { color: var(--ok); }
.badge-warn { color: var(--warn); font-weight: 500; }
.banner-warn { border: 1px solid var(--warn); color: var(--warn); padding: 8px 10px; border-radius: var(--radius); margin-bottom: 8px; background: color-mix(in srgb, var(--warn) 10%, transparent); }

.app { display: grid; grid-template-columns: 232px 1fr; height: 100vh; }
main { overflow: auto; padding: 16px 20px; }

/* rail */
.rail { border-right: 1px solid var(--line); background: var(--surface); padding: 14px 12px; display: flex; flex-direction: column; gap: 14px; }
.rail h1 { font-size: 17px; display: flex; align-items: center; gap: 8px; }
.rail h2 { font-size: 12px; color: var(--muted); font-weight: 500; }
.rail ul { list-style: none; padding: 0; margin: 0; }
.rail-views { display: flex; flex-direction: column; gap: 2px; }
.rail-views button { display: flex; justify-content: space-between; align-items: center; text-align: left; padding: 7px 10px; border: none; background: transparent; border-radius: var(--radius); }
.rail-views button:hover { background: var(--surface-2); }
.rail-views button.active { background: var(--surface-2); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
.count { min-width: 18px; padding: 0 6px; border-radius: 9px; font-size: 11px; font-weight: 600; text-align: center; background: var(--line); color: var(--text); }
.count.running { background: var(--running); color: #1a1408; }
.count.review { background: var(--review); color: #07201d; }
.count.chat { background: var(--accent); color: #0e141b; }
.rail-repo { display: flex; justify-content: space-between; padding: 4px 10px; border-radius: var(--radius); }
.rail-repo .mono { color: var(--muted); }
.rail-status { margin-top: auto; font-size: 12px; color: var(--muted); display: grid; gap: 6px; padding: 0 10px; }
.pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.pulse.running { background: var(--running); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .pulse.running { animation: none; } }
.dot-warn { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); margin-left: 6px; }

/* board */
.board-layout { display: grid; grid-template-columns: 1fr auto; gap: 16px; }
.board section { margin-bottom: 20px; }
.board-repo { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.batches { display: grid; gap: 6px; margin-bottom: 10px; }
.batch { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center; padding: 8px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); cursor: pointer; }
.batch:hover { border-color: var(--accent); }
.batch-title { font-weight: 500; }
.batch .progress { height: 4px; width: 120px; background: var(--line); border-radius: 2px; overflow: hidden; }
.batch .progress > div { height: 100%; background: var(--done); }
.chip { font-size: 11px; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--line); color: var(--muted); }
.chip.open { color: var(--running); border-color: var(--running); }
.chip.review { color: var(--review); border-color: var(--review); }
.chip.merged { color: var(--done); border-color: var(--done); }
.chip.abandoned { color: var(--muted); }
.columns { display: grid; grid-template-columns: repeat(6, minmax(150px, 1fr)); gap: 8px; }
.column { background: var(--surface); border-radius: var(--radius); padding: 8px; min-height: 120px; border-top: 2px solid var(--line); }
.column h3 { font-size: 12px; margin: 0 0 8px; color: var(--muted); font-weight: 500; }
.column.ready { border-top-color: var(--ready); } .column.blocked { border-top-color: var(--blocked); } .column.running { border-top-color: var(--running); }
.column.verifying { border-top-color: var(--verifying); } .column.review { border-top-color: var(--review); } .column.done { border-top-color: var(--done); }
.card { background: var(--surface-2); border-left: 3px solid var(--line); border-radius: 4px; padding: 7px 9px; margin-bottom: 6px; cursor: pointer; }
.card:hover { outline: 1px solid var(--accent); }
.card-selected { outline: 2px solid var(--accent); }
.card-failed { border-left-color: var(--blocked); }
.column.ready .card { border-left-color: var(--ready); } .column.blocked .card { border-left-color: var(--blocked); } .column.running .card { border-left-color: var(--running); }
.column.verifying .card { border-left-color: var(--verifying); } .column.review .card { border-left-color: var(--review); } .column.done .card { border-left-color: var(--done); }
.card-title { font-weight: 500; }
.card-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--muted); font-family: var(--mono); margin-top: 3px; }
.detail { width: 380px; background: var(--surface); border-radius: var(--radius); padding: 14px; align-self: start; position: sticky; top: 0; }
.detail pre, .pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.detail-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.activity { display: grid; gap: 4px; margin-bottom: 16px; }
.activity-row { display: grid; grid-template-columns: 180px 1fr auto auto; gap: 12px; align-items: center; font-size: 12px; }
.activity-bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.activity-bar > div { height: 100%; background: var(--running); }
.activity-empty { color: var(--muted); font-size: 12px; margin-bottom: 16px; }

/* chat */
.chat { display: flex; flex-direction: column; height: calc(100vh - 32px); gap: 10px; }
.pinned { border: 1px solid var(--accent); border-radius: var(--radius); padding: 10px; background: var(--surface); }
.question { display: grid; gap: 6px; margin-bottom: 8px; }
.question-text { font-weight: 500; }
.thread { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.msg { border-radius: var(--radius); padding: 8px 12px; max-width: 72ch; }
.msg-user { align-self: flex-end; background: var(--surface-2); border: 1px solid var(--line); }
.msg-assistant { background: var(--surface); }
.msg-system { border: 1px dashed var(--line); color: var(--muted); font-size: 13px; }
.msg-role { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.msg-answer { margin-top: 4px; font-style: italic; }
.composer { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: end; background: var(--surface); padding: 10px; border-radius: var(--radius); }
.composer select { max-width: 160px; }
.composer textarea { width: 100%; min-height: 64px; resize: vertical; box-sizing: border-box; }
.composer .badge-warn { grid-column: 1 / -1; }

/* review */
.review-layout { display: grid; grid-template-columns: 260px 1fr; gap: 16px; }
.review-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
.review-list li { padding: 8px 10px; cursor: pointer; border-radius: var(--radius); background: var(--surface); }
.review-list li.active { box-shadow: inset 3px 0 0 var(--review); font-weight: 500; }
.review-list .muted { display: block; }
.review-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; position: sticky; top: -16px; background: var(--bg); padding: 4px 0 8px; }
.review-actions { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
.review-actions input { flex: 1; min-width: 240px; }
.diff details { background: var(--surface); border-radius: var(--radius); margin-bottom: 6px; }
.diff summary { padding: 6px 10px; cursor: pointer; font-family: var(--mono); font-size: 12px; }
.diff pre { font-size: 12px; margin: 0; overflow-x: auto; padding: 4px 10px 8px; }
.diff-add { background: color-mix(in srgb, var(--done) 18%, transparent); }
.diff-del { background: color-mix(in srgb, var(--blocked) 18%, transparent); }
.diff-hunk { color: var(--accent); }
.diff-meta { color: var(--muted); }

/* setup */
.setup { display: flex; flex-direction: column; gap: 24px; max-width: 960px; }
.setup section { background: var(--surface); border-radius: var(--radius); padding: 14px 16px; }
.setup h2 { display: flex; align-items: center; gap: 12px; font-size: 16px; margin: 0 0 10px; }
.setup table { border-collapse: collapse; width: 100%; }
.setup td, .setup th { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 13px; }
.setup th { color: var(--muted); font-weight: 500; }
.row-bad td:first-child { color: var(--warn); font-weight: 600; }
.row-warn td:first-child { color: var(--muted); }
.fix { margin: 0; white-space: pre-wrap; font-size: 12px; }
.repo-form { display: grid; gap: 10px; max-width: 640px; }
.repo-form label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.repo-form label.checkbox { display: block; }
.form-actions { display: flex; gap: 8px; align-items: center; }
.path-row { display: flex; gap: 8px; } .path-row input { flex: 1; }

/* dialog */
.dialog-backdrop { position: fixed; inset: 0; background: #0009; display: flex; align-items: center; justify-content: center; }
.dialog { background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; width: 520px; max-width: 90vw; max-height: 70vh; display: flex; flex-direction: column; gap: 8px; }
.dialog-head { display: flex; gap: 8px; align-items: center; }
.dialog-path { flex: 1; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browse-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.browse-list li { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; }
```

- [ ] **Step 4: Rail.** Replace `Rail.tsx`:

```tsx
import type { CostsResponse, Repo, StatusResponse } from '@overseer/shared';
import { fmtCost } from '../api';

export type View = 'board' | 'chat' | 'review' | 'setup';
export interface RailCounts { running: number; questions: number; review: number }

export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

export function Rail(p: { repos: Repo[]; status: StatusResponse | null; costs: CostsResponse | null; counts: RailCounts; view: View; onView: (v: View) => void; setupAlert: boolean; onNewSession: () => void }) {
  const views: { v: View; label: string; count: number; cls: string }[] = [
    { v: 'board', label: 'Board', count: p.counts.running, cls: 'running' },
    { v: 'chat', label: 'Chat', count: p.counts.questions, cls: 'chat' },
    { v: 'review', label: 'Review', count: p.counts.review, cls: 'review' },
    { v: 'setup', label: 'Setup', count: 0, cls: '' },
  ];
  const orch = p.status?.orchestrator;
  const costOf = (id: string) => p.costs?.repos.find((r) => r.repo_id === id)?.total ?? null;
  return (
    <nav className="rail">
      <h1>Overseer</h1>
      <div className="rail-views">
        {views.map(({ v, label, count, cls }) => (
          <button key={v} className={v === p.view ? 'active' : ''} onClick={() => p.onView(v)}>
            <span>{label}{v === 'setup' && p.setupAlert && <span className="dot-warn" aria-label="setup needs attention" />}</span>
            {count > 0 && <span className={`count ${cls}`}>{count}</span>}
          </button>
        ))}
      </div>
      <h2>Repos</h2>
      <ul>{p.repos.map((r) => <li key={r.id} className="rail-repo" title={r.path}><span>{r.id}</span><span className="mono">{fmtCost(costOf(r.id))}</span></li>)}</ul>
      <div className="rail-status">
        <div><span className={`pulse ${orch?.status === 'running' ? 'running' : ''}`} /> orchestrator: {orch?.status ?? '…'}</div>
        {orch?.last_activity_at && <div>last active {relTime(orch.last_activity_at)}</div>}
        <button onClick={p.onNewSession}>New session</button>
        {p.status && !p.status.bd_ok && <div className="badge-warn">bd unavailable</div>}
      </div>
    </nav>
  );
}
```

`fmtCost(null)` returns `''`; keep that.

- [ ] **Step 5: App.** In `App.tsx` add state `costs` (`CostsResponse | null`), `board` (`BoardResponse | null`) and `chatRows` (`ChatRow[]`) loaded on mount and on the matching WS messages (`board` → reload board and costs, `chat` → reload chat rows). Derive counts:

```ts
  const counts = {
    running: board?.repos.flatMap((r) => r.cards).filter((c) => c.column === 'running').length ?? 0,
    questions: chatRows.filter((c) => c.kind === 'question' && c.answered_at === null).length,
    review: (board?.repos.flatMap((r) => r.batches).filter((b) => b.status === 'review').length ?? 0) + (board?.repos.flatMap((r) => r.cards).filter((c) => c.column === 'review' && !c.batch_id).length ?? 0),
  };
  const newSession = () => { void api.post('/orchestrator/reset').then(loadStatus); };
```

Pass `costs`, `counts`, `onNewSession={newSession}` to `Rail`. Debounce the board reload in App the same way as Task 2 (300 ms timer keyed on `boardVersion`). Board view keeps its own fetch (it needs the freshest data on open); the App copy only feeds the counts.

- [ ] **Step 6: Run** `pnpm --filter @overseer/web test` (whole web suite) and `pnpm typecheck` → PASS. Every test that mocks `/api/status` also needs `/api/costs`, `/api/board` and `/api/chat` answers now; add them where missing.

- [ ] **Step 7: Commit**

```bash
git add packages/web/index.html packages/web/src/styles.css packages/web/src/components/Rail.tsx packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "Add the slate design tokens, IBM Plex and a rail with counts, costs and session reset"
```

---

### Task 12: Board: activity strip, batch rows, column hues, detail actions

**Goal:** The Board shows running sessions as timelines, batches per repo, coloured columns, and a detail pane with Stop, Open in Review and Trace.

**Files:**
- Modify: `packages/web/src/views/Board.tsx`, `packages/web/src/components/Card.tsx`
- Create: `packages/web/src/components/Activity.tsx`, `packages/web/src/components/BatchRow.tsx`
- Test: `packages/web/src/views/Board.test.tsx`, `packages/web/src/test/fixtures.ts`

**Acceptance Criteria:**
- [ ] Activity strip lists every card with `session_status === 'running'`: title, a bar whose width grows with elapsed time (capped at 60 min = 100%), elapsed text, cost text. Empty: "No workers running."
- [ ] Each repo section renders its batches as rows: title, `mono` branch, `done/total`, cost, status chip; clicking calls `onOpenBatch(id)`.
- [ ] Column `div` has class `column <key>`.
- [ ] Detail pane: "Stop worker" button when the card's session is running, posts `/api/tasks/:id/interrupt`; "Trace" link `href="/api/sessions/<last session id>/events"` (opens JSON in a tab) when the detail has sessions; "Open in Review" as today.
- [ ] Existing Board tests pass; new test covers the activity strip, batch row click and Stop.

**Verify:** `pnpm --filter @overseer/web test -- Board` → green.

**Steps:**

- [ ] **Step 1: Fixtures.** In `fixtures.ts` add to the repo entry `batches: [{ id: 'r1-b1', repo_id: 'r1', title: '#9310 Trend chart', branch: 'feature/9310-trend-chart', base_branch: 'main', status: 'open', note: null, mr_url: null, conflict_files: null, created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z', merged_at: null, beads_total: 4, beads_done: 2, cost: 1.2 }]` and set `batch_id: 'r1-b1'` on the `ov-3` card. Export `batchDetail: BatchDetail` = `{ batch: <the row above without the summary fields>, repo, beads: [board cards ov-3], diff: reviewDetail.diff, cost: 1.2 }`. Add `sessions: [{ id: 'sess-5', harness: 'opencode', role: 'worker', bead_id: 'ov-5', repo_id: 'r1', native_session_id: 'n', pid: null, pid_started_at: null, start_commit: 'a', cwd: '/wt', status: 'ended', started_at: '2026-09-12T10:00:00.000Z', ended_at: '2026-09-12T10:06:40.000Z', cost: 1.2 }]` to `reviewDetail`.

- [ ] **Step 2: Test.** Append to `Board.test.tsx`:

```ts
  it('shows the activity strip, batch rows, and stops a worker from the detail pane', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/board')) return board;
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: board.repos[0]!.cards[2]!.bead, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', bead_id: 'ov-3', status: 'running', ended_at: null }] };
      if (method === 'POST' && url.endsWith('/api/tasks/ov-3/interrupt')) { posts.push(url); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onOpenBatch = vi.fn();
    render(<Board version={0} onOpenReview={() => {}} onOpenBatch={onOpenBatch} />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    const strip = screen.getByRole('region', { name: 'Running workers' });
    expect(within(strip).getByText('Running task')).toBeTruthy();
    expect(within(strip).getByText('$0.42')).toBeTruthy();
    fireEvent.click(screen.getByText('#9310 Trend chart'));
    expect(onOpenBatch).toHaveBeenCalledWith('r1-b1');
    expect(screen.getByText('2/4')).toBeTruthy();
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop worker' })).toBeTruthy());
    expect((screen.getByRole('link', { name: 'Trace' }) as HTMLAnchorElement).getAttribute('href')).toBe('/api/sessions/sess-3/events');
    fireEvent.click(screen.getByRole('button', { name: 'Stop worker' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-3/interrupt']));
  });
```

The first test's `getByText('Running task')` now matches twice (strip + card); change that line to `screen.getByText('Running task', { selector: '.card-title' })` and update the `onOpenReview` prop usage: the first test renders `<Board version={0} onOpenReview={onOpenReview} onOpenBatch={() => {}} />`.

- [ ] **Step 3: Components.** `Activity.tsx`:

```tsx
import type { BoardCard } from '@overseer/shared';
import { fmtCost, fmtElapsed } from '../api';

const CAP_MS = 60 * 60_000;

export function Activity(p: { cards: BoardCard[] }) {
  const running = p.cards.filter((c) => c.session_status === 'running');
  if (running.length === 0) return <div className="activity-empty">No workers running.</div>;
  return (
    <section className="activity" role="region" aria-label="Running workers">
      {running.map((c) => (
        <div key={c.bead.id} className="activity-row">
          <span>{c.bead.title}</span>
          <div className="activity-bar"><div style={{ width: `${Math.min(100, ((c.elapsed_ms ?? 0) / CAP_MS) * 100)}%` }} /></div>
          <span className="mono">{fmtElapsed(c.elapsed_ms)}</span>
          <span className="mono">{fmtCost(c.cost)}</span>
        </div>
      ))}
    </section>
  );
}
```

`BatchRow.tsx`:

```tsx
import type { BatchSummary } from '@overseer/shared';
import { fmtCost } from '../api';

export function BatchRow(p: { batch: BatchSummary; onClick: () => void }) {
  const b = p.batch;
  const pct = b.beads_total ? (b.beads_done / b.beads_total) * 100 : 0;
  return (
    <div className="batch" role="button" tabIndex={0} onClick={p.onClick} onKeyDown={(e) => { if (e.key === 'Enter') p.onClick(); }}>
      <div><div className="batch-title">{b.title}</div><div className="mono muted">{b.branch} → {b.base_branch}</div></div>
      <div><div className="progress"><div style={{ width: `${pct}%` }} /></div><div className="mono muted">{b.beads_done}/{b.beads_total}</div></div>
      <span className="mono">{fmtCost(b.cost)}</span>
      <span className={`chip ${b.status}`}>{b.status === 'review' ? 'in review' : b.status}</span>
    </div>
  );
}
```

`Card.tsx`: add `{card.batch_id && <span>{card.batch_id}</span>}` to the meta row.

- [ ] **Step 4: Board.tsx.** New signature `Board(p: { version: number; onOpenReview: (beadId: string) => void; onOpenBatch: (batchId: string) => void })`. Render:

```tsx
  const all = board.repos.flatMap((r) => r.cards);
  const last = detail?.sessions[detail.sessions.length - 1];
  const stop = () => { if (detail) void api.post(`/tasks/${detail.bead.id}/interrupt`).catch(() => {}); };
  return (
    <div className="board-layout">
      <div className="board">
        {!board.bd_ok && <div className="banner-warn">…unchanged…</div>}
        <Activity cards={all} />
        {board.repos.map(({ repo, batches, cards }) => (
          <section key={repo.id}>
            <div className="board-repo"><h2>{repo.id}</h2><span className="mono muted">{repo.base_branch}</span></div>
            {batches.filter((b) => b.status !== 'merged' && b.status !== 'abandoned').length > 0 && (
              <div className="batches">{batches.filter((b) => b.status !== 'merged' && b.status !== 'abandoned').map((b) => <BatchRow key={b.id} batch={b} onClick={() => p.onOpenBatch(b.id)} />)}</div>
            )}
            <div className="columns">
              {COLUMNS.map((col) => {
                const inCol = cards.filter((c) => c.column === col.key);
                return (
                  <div key={col.key} className={`column ${col.key}`}>
                    <h3>{col.label} ({inCol.length})</h3>
                    {inCol.map((c) => <Card key={c.bead.id} card={c} selected={c.bead.id === selected} onClick={() => setSelected(c.bead.id)} />)}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {detail && (
        <aside className="detail">
          <h2>{detail.bead.title} <span className="muted mono">{detail.bead.id}</span></h2>
          <p className="pre">{detail.bead.description || '(no description)'}</p>
          {detail.bead.notes && <><h4>Notes</h4><pre>{detail.bead.notes}</pre></>}
          {detail.last_assistant_text && <><h4>Last assistant text</h4><p className="pre">{detail.last_assistant_text}</p></>}
          {detail.worktree?.verify_output && <><h4>Verification: {detail.worktree.verify_status}</h4><pre>{detail.worktree.verify_output}</pre></>}
          <div className="detail-actions">
            {last?.status === 'running' && <button className="danger" onClick={stop}>Stop worker</button>}
            {detail.bead.labels.includes('overseer:review') && <button className="primary" onClick={() => p.onOpenReview(detail.bead.id)}>Open in Review</button>}
            {last && <a href={`/api/sessions/${last.id}/events`} target="_blank" rel="noreferrer">Trace</a>}
            <button className="link" onClick={() => setSelected(null)}>Close</button>
          </div>
        </aside>
      )}
    </div>
  );
```

In `App.tsx` pass `onOpenBatch={(id) => { setReviewBatch(id); onView('review'); }}` (state `reviewBatch` added here; Task 14 consumes it in Review). Until Task 14, `Review` ignores it: add the prop as optional there now (`selectedBatch?: string | null`).

- [ ] **Step 5: Run** `pnpm --filter @overseer/web test` and `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/views/Board.tsx packages/web/src/views/Board.test.tsx packages/web/src/components/Activity.tsx packages/web/src/components/BatchRow.tsx packages/web/src/components/Card.tsx packages/web/src/test/fixtures.ts packages/web/src/App.tsx packages/web/src/views/Review.tsx
git commit -m "Board: activity strip, batch rows, column hues, stop and trace actions"
```

---

### Task 13: Chat composer and thread

**Goal:** The composer gives the textarea the flexible column; the thread reads well; a "New session" affordance is also in Chat.

**Files:**
- Modify: `packages/web/src/views/Chat.tsx`
- Test: `packages/web/src/views/Chat.test.tsx`

**Acceptance Criteria:**
- [ ] Composer DOM order: `select` (aria-label "Repo"), `textarea` (placeholder "Message the orchestrator"), `button` "Send". No separate "Repo" text span; the select's first option reads "all repos".
- [ ] Textarea auto-grows from 3 to 8 rows with content.
- [ ] Message roles render as "You", "Orchestrator", "Overseer" (test still finds `Overseer` in the system message; existing role queries in tests are by text content of the message, unaffected).
- [ ] The existing Chat test passes; new assertion: the textarea's `offsetParent`-independent check that `select` precedes `textarea` in the composer (`compareDocumentPosition`).

**Verify:** `pnpm --filter @overseer/web test -- Chat` → green.

**Steps:**

- [ ] **Step 1: Test.** Append to the existing Chat test, before the first `fireEvent.change`:

```ts
    const select = screen.getByLabelText('Repo');
    expect(select.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Repo', { selector: 'span' })).toBeNull();
```

- [ ] **Step 2: Implement.** In `Chat.tsx` replace the composer:

```tsx
      <div className="composer">
        <select aria-label="Repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">all repos</option>
          {p.repos.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
        </select>
        <textarea value={text} placeholder="Message the orchestrator" rows={Math.min(8, Math.max(3, text.split('\n').length))} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="primary" onClick={() => void send()}>Send</button>
        {error && <div className="badge-warn">{error}</div>}
      </div>
```

and the role label: `<div className="msg-role">{r.role === 'system' ? 'Overseer' : r.role === 'user' ? 'You' : 'Orchestrator'}</div>`.

- [ ] **Step 3: Run** `pnpm --filter @overseer/web test -- Chat App` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/Chat.tsx packages/web/src/views/Chat.test.tsx
git commit -m "Chat: give the composer textarea the flexible column and name the roles"
```

---

### Task 14: Review view for batches and legacy beads; Setup restyle

**Goal:** Review lists batches in review first, then per-bead reviews; a batch shows its beads, note, verification summary, diff, and Merge / Mark merged / Reject / Abandon.

**Files:**
- Modify: `packages/web/src/views/Review.tsx`, `packages/web/src/App.tsx`
- Test: `packages/web/src/views/Review.test.tsx`

**Acceptance Criteria:**
- [ ] List shows batches with status `review` or `open` (open ones labelled "in progress", not actionable except Abandon), then beads in review without a `batch_id`.
- [ ] Selecting a batch loads `/api/batches/:id` and shows title, `branch → base`, cost, the note (or "The orchestrator has not requested review yet."), the bead list with columns, and the diff.
- [ ] Buttons: for `local-merge` repos "Merge" (posts `/api/batches/:id/merge`), for `gitlab-mr` "Mark merged" and a link to `mr_url`; "Reject" requires a note (posts `/reject`); "Abandon" asks `confirm()` then posts `/abandon`.
- [ ] Merge conflict (409) shows the error text under the actions.
- [ ] Existing Review test passes unchanged for the legacy bead path.

**Verify:** `pnpm --filter @overseer/web test -- Review` → green.

**Steps:**

- [ ] **Step 1: Test.** Append to `Review.test.tsx`:

```ts
  it('reviews a batch: lists it first, merges, rejects with a note, abandons', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/board')) return { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', note: 'All four beads landed. Verified with pnpm test.' }] }] };
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'All four beads landed. Verified with pnpm test.' } };
      if (method === 'POST' && url.includes('/api/batches/r1-b1/')) { posts.push({ url, body }); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    vi.stubGlobal('confirm', () => true);
    render(<Review version={0} selected={null} selectedBatch="r1-b1" onSelect={() => {}} onSelectBatch={() => {}} />);
    await waitFor(() => expect(screen.getByText('All four beads landed. Verified with pnpm test.')).toBeTruthy());
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('#9310 Trend chart');
    expect(screen.getByText('feature/9310-trend-chart → main')).toBeTruthy();
    expect(screen.getByText('$1.20')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(posts.at(-1)?.url).toBe('/api/batches/r1-b1/merge'));
    fireEvent.change(screen.getByPlaceholderText(/why/i), { target: { value: 'missing TC-005' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/batches/r1-b1/reject', body: { note: 'missing TC-005' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Abandon' }));
    await waitFor(() => expect(posts.at(-1)?.url).toBe('/api/batches/r1-b1/abandon'));
  });
```

Import `batchDetail` from fixtures and `vi` from vitest. The legacy test renders `<Review version={0} selected="ov-5" onSelect={() => {}} />`; add `selectedBatch={null} onSelectBatch={() => {}}` there.

- [ ] **Step 2: Implement** `Review.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { BatchDetail, BatchSummary, BoardCard, BoardResponse, TaskDetail } from '@overseer/shared';
import { api, ApiError, fmtCost } from '../api';
import { Diff } from '../components/Diff';

interface Props { version: number; selected: string | null; selectedBatch: string | null; onSelect: (id: string | null) => void; onSelectBatch: (id: string | null) => void }

export function Review(p: Props) {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<BoardResponse>('/board').then((b) => {
      const inReview = b.repos.flatMap((r) => r.cards).filter((c) => c.column === 'review' && !c.batch_id);
      const bs = b.repos.flatMap((r) => r.batches).filter((x) => x.status === 'review' || x.status === 'open').sort((x, y) => (x.status === 'review' ? 0 : 1) - (y.status === 'review' ? 0 : 1));
      setCards(inReview); setBatches(bs);
      if (!p.selected && !p.selectedBatch) { if (bs[0]) p.onSelectBatch(bs[0].id); else if (inReview[0]) p.onSelect(inReview[0].bead.id); }
    });
  }, [p.version]);
  useEffect(() => {
    if (!p.selected) { setDetail(null); return; }
    void api.get<TaskDetail>(`/tasks/${p.selected}`).then(setDetail).catch(() => setDetail(null));
  }, [p.selected, p.version]);
  useEffect(() => {
    if (!p.selectedBatch) { setBatch(null); return; }
    void api.get<BatchDetail>(`/batches/${p.selectedBatch}`).then(setBatch).catch(() => setBatch(null));
  }, [p.selectedBatch, p.version]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };
  const pickBatch = (id: string) => { p.onSelect(null); p.onSelectBatch(id); };
  const pickBead = (id: string) => { p.onSelectBatch(null); p.onSelect(id); };

  // legacy bead actions (unchanged)
  const merge = () => act(async () => { await api.post(`/tasks/${p.selected}/merge`); p.onSelect(null); });
  const reject = () => { if (!note.trim()) { setError('A rejection note is required.'); return; } void act(async () => { await api.post(`/tasks/${p.selected}/reject`, { note: note.trim() }); setNote(''); p.onSelect(null); }); };
  // batch actions
  const mergeBatch = () => act(async () => { await api.post(`/batches/${p.selectedBatch}/merge`); p.onSelectBatch(null); });
  const rejectBatch = () => { if (!note.trim()) { setError('A rejection note is required.'); return; } void act(async () => { await api.post(`/batches/${p.selectedBatch}/reject`, { note: note.trim() }); setNote(''); p.onSelectBatch(null); }); };
  const abandonBatch = () => { if (!confirm('Abandon this batch? Running workers are stopped, the feature branch and its worktrees are deleted, and its beads are closed.')) return; void act(async () => { await api.post(`/batches/${p.selectedBatch}/abandon`); p.onSelectBatch(null); }); };

  const wt = detail?.worktree;
  const b = batch?.batch;
  return (
    <div className="review-layout">
      <ul className="review-list">
        {batches.length === 0 && cards.length === 0 && <li className="muted">Nothing to review.</li>}
        {batches.map((x) => (
          <li key={x.id} className={x.id === p.selectedBatch ? 'active' : ''} onClick={() => pickBatch(x.id)}>
            {x.title}<span className="muted mono">{x.branch} · {x.beads_done}/{x.beads_total} · {x.status === 'review' ? 'in review' : 'in progress'}</span>
          </li>
        ))}
        {cards.map((c) => <li key={c.bead.id} className={c.bead.id === p.selected ? 'active' : ''} onClick={() => pickBead(c.bead.id)}>{c.bead.title}</li>)}
      </ul>
      {batch && b && (
        <div className="review-detail">
          <div className="review-head">
            <h2>{b.title}</h2>
            <span className="mono muted">{b.branch} → {b.base_branch}</span>
            <span className="mono">{fmtCost(batch.cost)}</span>
            <span className={`chip ${b.status}`}>{b.status === 'review' ? 'in review' : 'in progress'}</span>
          </div>
          <h4>Summary from the orchestrator</h4>
          <p className="pre">{b.note ?? 'The orchestrator has not requested review yet.'}</p>
          <h4>Beads</h4>
          <ul className="review-beads">{batch.beads.map((c) => <li key={c.bead.id}><span className="mono">{c.bead.id}</span> {c.bead.title} <span className="muted">{c.column}</span></li>)}</ul>
          {b.conflict_files && b.conflict_files.length > 0 && <div className="banner-warn">Last merge into {b.base_branch} conflicted in: {b.conflict_files.join(', ')}</div>}
          <div className="review-actions">
            {b.status === 'review' && batch.repo.merge_mode === 'local-merge' && <button className="primary" disabled={busy} onClick={() => void mergeBatch()}>Merge</button>}
            {b.status === 'review' && batch.repo.merge_mode === 'gitlab-mr' && <>
              {b.mr_url && <a href={b.mr_url} target="_blank" rel="noreferrer">Open merge request</a>}
              <button className="primary" disabled={busy} onClick={() => void mergeBatch()}>Mark merged</button>
            </>}
            {b.status === 'review' && <><input value={note} placeholder="Why? (required to reject)" onChange={(e) => setNote(e.target.value)} /><button disabled={busy} onClick={rejectBatch}>Reject</button></>}
            <button className="danger" disabled={busy} onClick={abandonBatch}>Abandon</button>
          </div>
          {error && <div className="badge-warn">{error}</div>}
          <h4>Diff against {b.base_branch}</h4>
          <Diff diff={batch.diff} />
        </div>
      )}
      {!batch && detail && (
        <div className="review-detail">
          ...the existing bead detail block, unchanged, with the `h2` wrapped in `<div className="review-head">`...
        </div>
      )}
    </div>
  );
}
```

In `App.tsx`: state `reviewBatch`, pass `selectedBatch={reviewBatch} onSelectBatch={setReviewBatch}` to `Review`.

- [ ] **Step 3: Run** `pnpm --filter @overseer/web test` and `pnpm typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/Review.tsx packages/web/src/views/Review.test.tsx packages/web/src/App.tsx
git commit -m "Review: batches first, with merge, reject, abandon and the combined diff"
```

---

### Task 15: Docs and smoke

**Goal:** README, CLAUDE.md and the spec index reflect batches, the idle rule, traces, the log file and the new env var; the full suite passes.

**Files:**
- Modify: `README.md` (How it works, env table, API list), `CLAUDE.md` (Layout: batches in lifecycle; Configuration: `OVERSEER_ORCHESTRATOR_IDLE_MIN`, `daemon.log`; Smoke script step 4–6 now go through a batch)

**Acceptance Criteria:**
- [ ] README describes: one feature branch per request, automatic bead integration, single review (Review view or MR), Abandon and Stop, idle session expiry, `GET /api/sessions/:id/events`, `GET /api/costs`, `~/.overseer/daemon.log`.
- [ ] CLAUDE.md smoke script expects a batch row on the Board and the Review view showing the batch.
- [ ] `pnpm -r test` and `pnpm typecheck` pass with no warnings in the output.

**Verify:** `pnpm -r test` and `pnpm typecheck` → green; `grep -n "batch" README.md CLAUDE.md` shows the additions.

**Steps:**

- [ ] **Step 1: README.** Under "How it works" replace the workers/review bullets with: "**Batches.** Every request becomes a batch with its own feature branch (`feature/<slug>`), created from the repo's base branch. Workers branch from the batch branch; when a worker's verification passes, the daemon merges its bead into the batch branch and closes the bead. You review the batch once: in the Review view for `local-merge` repos, or as a GitLab MR for `gitlab-mr` repos. Reject sends your note to the orchestrator, which adds beads to the same batch. Abandon stops its workers, deletes the branch and worktrees, and closes its beads. Stop on a running card interrupts that worker." Add to the env table: `OVERSEER_ORCHESTRATOR_IDLE_MIN | 30 | minutes of inactivity after which the next message starts a fresh orchestrator session`. Add an "Inspecting runs" paragraph naming `GET /api/sessions?bead_id=`, `GET /api/sessions/:id/events`, `GET /api/costs`, the Trace link in the Board detail pane, and `~/.overseer/daemon.log`.

- [ ] **Step 2: CLAUDE.md.** In Layout add under lifecycle: "batches (feature branch per request, `batch-<id>` worktree, automatic bead integration) live in `lifecycle.ts` too; `git/git.ts` has `mergeInto`/`ensureBranchWorktree`." In Configuration add `OVERSEER_ORCHESTRATOR_IDLE_MIN` and `daemon.log` in the data dir. In the smoke script, step 4 expects "a batch row under the repo on the Board", step 5 "Open Review: the batch is listed with the combined diff once the orchestrator calls `request_batch_review`", step 6 "Click Merge on the batch".

- [ ] **Step 3: Run** `pnpm -r test` and `pnpm typecheck`; paste the summary lines into the commit body if anything is skipped (live tests are).

- [ ] **Step 4: Visual check with the playwright-cli skill.** Start `pnpm dev` in the background (daemon :4400, web :5173; use `OVERSEER_DATA_DIR` pointed at a scratch dir so the real database is untouched). Invoke the `playwright-cli` skill and, at a 1280×800 viewport, open `http://127.0.0.1:5173`, register a throwaway repo through Setup (or `POST /api/repos`), then screenshot Board, Chat, Review and Setup. Check against the spec's layout section: rail 232 px with counts, IBM Plex rendering (not a fallback face), activity strip "No workers running." before any dispatch, the composer with the textarea taking the flexible column, column top rules in the six hues, no horizontal scrollbar at 1280 and at 1024. Fix any CSS finding in `styles.css` and re-screenshot; note the findings and fixes in the commit body. Stop the dev processes afterwards.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document batches, idle orchestrator sessions, traces, costs and the daemon log"
```

---

## Self-review

- Spec coverage: board speed (1, 2), merge check (3), batches data (4), git (5), lifecycle (6), MCP + prompts (7), REST incl. interrupt/sessions/costs (8), idle rule + reset (9), log (10), UI tokens/rail (11), board (12), chat (13), review (14), docs (15). Cancel-from-UI: Stop (12) and Abandon (14) over `POST /api/tasks/:id/interrupt` and `/api/batches/:id/abandon` (8).
- Type consistency: `BatchRow`, `BatchSummary`, `BatchDetail`, `CostsResponse` defined in Task 4 and used unchanged in 6–14; `spawnWorker(repoId, beadId, harness, instructions?, batchId?)` in 6, 7, 8; `requestBatchReview(repoId, batchId, note)` in 6, 7; `mergeBatch/rejectBatch/abandonBatch/interruptBead` in 6, 8, 14; `StatusResponse.orchestrator.last_activity_at` in 9, 11; `Board` props `onOpenBatch` in 12 and App; `Review` props `selectedBatch/onSelectBatch` in 12 (stub), 14.
- Known judgment calls: `verify()` gets a `finalPhase` parameter (Task 6) rather than branching on `batch_id`, so the v1 path is untouched. The first-ever orchestrator session now receives the preamble (harmless, and the test is adjusted).
