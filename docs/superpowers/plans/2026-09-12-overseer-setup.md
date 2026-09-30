# Overseer Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Command-free setup: the dashboard reports missing prerequisites, lets the user pick a folder, and registers, edits and removes repositories, with beads initialised by the daemon in stealth mode by default.

**Architecture:** The daemon gains a doctor module, a folder browse module, a repo inspect module, beads init through the task store, and PATCH/DELETE repo routes. The web app gains a Setup view (prerequisites panel, repo table, add/edit form) and a browse dialog, opened automatically when nothing is registered or a required tool is missing. Shared types and a `repos` WebSocket message tie the two together.

**Tech Stack:** TypeScript, Fastify, zod, node:sqlite, React, Vitest with Testing Library and jsdom. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-overseer-setup-design.md`

## Global Constraints

- No new npm dependencies. Node >= 22.13, pnpm 10.
- Daemon tests use real git repos from `src/test/tmpgit.ts`, `:memory:` SQLite, `MemoryTaskStore`, and `app.inject`. Test output must stay free of warnings and unhandled rejections.
- Every child process goes through `runCapture`/`spawnLines` from `src/util/procs.ts`; never `child_process` directly in new code.
- The exact beads init arguments are `['init', '--prefix', <id>, '--non-interactive']` plus `'--stealth'` unless the caller chose commit mode. Never pass `--json` to `bd init`.
- Repo ids match `^[a-z0-9][a-z0-9-]*$` (the id doubles as the beads prefix).
- Path comparisons on win32 are case-insensitive after `path.resolve`; git prints forward slashes, `path.resolve` gives backslashes.
- Web tests mock `fetch` with `mockApi` from `src/test/setup.ts`; every URL the component fetches must be handled by the mock or the test fails with an unhandled rejection.
- Inputs in forms carry `aria-label` equal to their visible label so tests select them with `getByLabelText`.
- Commit with explicit paths (`git add <files>` then `git commit`); never `git add -A`; never commit `docs/superpowers/plans/*.tasks.json`. End every commit message with the line `Claude-Session: https://claude.ai/code/session_01Caa5tHJmtUdPAyLCyDxx17`.
- Run `pnpm --filter @overseer/daemon typecheck` / `pnpm --filter @overseer/web typecheck` before each commit that touches that package.

**User decisions (already made):**
- Setup happens in the web UI only; no CLI wizard, no orchestrator tool.
- Path field plus daemon-backed folder browser; no native browser picker (it cannot return absolute paths).
- beads init is stealth by default with an opt-in "My team uses beads: commit its files" checkbox.
- Doctor reports and explains; it never installs anything.
- The dashboard adds, edits and removes repos.
- `AGENTS.md` is not set up; workers do not run `bd`.

---

### Task 1: Shared types, `repos` bus message, web client verbs

**Goal:** Every type the later tasks reference exists in `@overseer/shared`, the bus and socket forward a `repos` message, and the web client can send PATCH and DELETE.

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/daemon/src/bus.ts`
- Modify: `packages/daemon/src/api/ws.ts`
- Modify: `packages/daemon/src/app.test.ts` (WebSocket test)
- Modify: `packages/web/src/api.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`

**Acceptance Criteria:**
- [ ] `DoctorResponse`, `DoctorTool`, `DoctorToolName`, `BrowseEntry`, `BrowseResponse`, `InspectResponse`, `BeadsMode`, `RepoPatch`, `RepoCreate`, `DeleteRepoResponse` are exported from shared and `WsMessage` includes `{ type: 'repos' }`.
- [ ] `bus.emit('repos')` reaches a connected WebSocket client as `{"type":"repos"}`.
- [ ] `api.patch` and `api.delete` exist and send those HTTP methods.
- [ ] The App refetches `/api/repos` when a `repos` socket message arrives.

**Verify:** `pnpm typecheck && pnpm --filter @overseer/daemon exec vitest run app.test && pnpm --filter @overseer/web test -- App` → all green

**Steps:**

- [ ] **Step 1: Add the shared types**

Append to `packages/shared/src/index.ts` before the `WsMessage` union:

```ts
export type DoctorToolName = 'git' | 'bd' | 'claude' | 'codex' | 'opencode' | 'glab';

export interface DoctorTool {
  name: DoctorToolName;
  required: boolean;
  ok: boolean;
  version: string | null;
  fix: string | null;
}

export interface DoctorResponse {
  tools: DoctorTool[];
  data_dir: { path: string; ok: boolean; problem: string | null };
}

export interface BrowseEntry { name: string; path: string; is_git_repo: boolean }

export interface BrowseResponse {
  path: string | null;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface InspectResponse {
  path: string;
  exists: boolean;
  is_git_root: boolean;
  branch: string | null;
  has_beads: boolean;
  suggested_id: string;
  problems: string[];
}

export type BeadsMode = 'stealth' | 'commit';

export interface RepoPatch {
  base_branch?: string;
  verify_command?: string | null;
  merge_mode?: MergeMode;
  worker_limit?: number;
}

export interface RepoCreate extends RepoPatch { path: string; id?: string; beads?: BeadsMode }

export interface DeleteRepoResponse { ok: true; warnings: string[] }
```

Change the union to:

```ts
export type WsMessage =
  | { type: 'event'; event: EventRow }
  | { type: 'board' }
  | { type: 'chat' }
  | { type: 'status' }
  | { type: 'repos' };
```

- [ ] **Step 2: Write the failing WebSocket test**

In `packages/daemon/src/app.test.ts`, change the `forwards bus messages` test body to emit `repos` too:

```ts
    x.bus.emit('board');
    x.bus.emit('chat');
    x.bus.emit('status');
    x.bus.emit('repos');
    x.bus.emit('event', { id: 1, session_id: 's', seq: 1, type: 'assistant_text', payload: { text: 'x' }, ts: 't' });
    await until(() => got.length === 5);
    expect(got.map((g) => g.type)).toEqual(['board', 'chat', 'status', 'repos', 'event']);
```

Run: `pnpm --filter @overseer/daemon exec vitest run app.test` → typecheck error on `emit('repos')` or the test times out.

- [ ] **Step 3: Add the bus event and socket forwarding**

`packages/daemon/src/bus.ts`, inside `BusEvents`:

```ts
  repos: [];
```

`packages/daemon/src/api/ws.ts`, after the `status` line:

```ts
  bus.on('repos', () => broadcast({ type: 'repos' }));
```

Run: `pnpm --filter @overseer/daemon exec vitest run app.test` → PASS.

- [ ] **Step 4: Write the failing App test**

Append to `packages/web/src/App.test.tsx` inside `describe('App')`:

```tsx
  it('reloads repos on a repos socket message', async () => {
    let reposCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) { reposCalls++; return reposCalls === 1 ? [repo] : [repo, { ...repo, id: 'r2', path: 'E:/Projects/two' }]; }
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.endsWith('/api/chat')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTitle('E:/Projects/demo')).toBeTruthy());
    lastSocket().push({ type: 'repos' });
    await waitFor(() => expect(screen.getByTitle('E:/Projects/two')).toBeTruthy());
  });
```

Run: `pnpm --filter @overseer/web test -- App` → FAIL (second repo never appears).

- [ ] **Step 5: Extend the web client and App**

`packages/web/src/api.ts`: change the `request` signature and `api` object:

```ts
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  // body unchanged
```

```ts
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
```

`packages/web/src/App.tsx`: extract the repo load and react to the message:

```tsx
  const loadRepos = useCallback(() => { void api.get<Repo[]>('/repos').then(setRepos); }, []);
  const loadStatus = useCallback(() => { void api.get<StatusResponse>('/status').then(setStatus); }, []);
  useEffect(() => { loadRepos(); loadStatus(); }, [loadRepos, loadStatus]);
  useWs((m: WsMessage) => {
    if (m.type === 'board') setBoardVersion((v) => v + 1);
    if (m.type === 'chat') setChatVersion((v) => v + 1);
    if (m.type === 'status') loadStatus();
    if (m.type === 'repos') loadRepos();
  });
```

Run: `pnpm --filter @overseer/web test -- App` → PASS. `pnpm typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/daemon/src/bus.ts packages/daemon/src/api/ws.ts packages/daemon/src/app.test.ts packages/web/src/api.ts packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "Add setup types, the repos socket message and PATCH/DELETE client verbs"
```

---

### Task 2: Doctor module and `GET /api/doctor`

**Goal:** The daemon reports which CLIs are installed, their versions, a fix text for each missing one, and whether the data dir is writable.

**Files:**
- Create: `packages/daemon/src/doctor/doctor.ts`
- Create: `packages/daemon/src/doctor/doctor.test.ts`
- Modify: `packages/daemon/src/api/rest.ts`
- Modify: `packages/daemon/src/app.test.ts`

**Acceptance Criteria:**
- [ ] `runDoctor(config, runner, opts)` returns six tool rows in the order git, bd, claude, codex, opencode, glab with `required` true for the first three.
- [ ] A runner that throws (ENOENT), never resolves (timeout), or exits non-zero yields `ok: false`, `version: null`, and the tool's fix text.
- [ ] A successful run yields `ok: true` and `version` = first stdout line; the claude row still carries the login hint as `fix`.
- [ ] The binaries invoked are the config's `bdBin`, `claudeBin`, `codexBin`, `opencodeBin`, `glabBin` and `'git'`.
- [ ] `data_dir.ok` is true for a writable temp dir and false with a problem text for a path under a file.
- [ ] `GET /api/doctor` returns the shape with `tools.length === 6`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run doctor app.test` → all green

**Steps:**

- [ ] **Step 1: Write the failing unit test**

`packages/daemon/src/doctor/doctor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config';
import { runDoctor, type VersionRunner } from './doctor';

const runner: VersionRunner = async (bin) => {
  if (bin === 'git') return { code: 0, stdout: 'git version 2.45.0\nextra\n', stderr: '' };
  if (bin === '/custom/bd') return { code: 0, stdout: 'bd version 1.2.2', stderr: '' };
  if (bin === 'claude') throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  if (bin === 'codex') return new Promise(() => { /* never resolves: timeout */ });
  if (bin === 'opencode') return { code: 1, stdout: '', stderr: 'boom' };
  return { code: 0, stdout: 'glab 1.50', stderr: '' };
};

describe('doctor', () => {
  it('reports each tool and the data dir', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-doctor-'));
    const config = loadConfig({ OVERSEER_BD: '/custom/bd', OVERSEER_DATA_DIR: dataDir });
    const r = await runDoctor(config, runner, { timeoutMs: 50 });
    expect(r.tools.map((t) => [t.name, t.required, t.ok, t.version])).toEqual([
      ['git', true, true, 'git version 2.45.0'],
      ['bd', true, true, 'bd version 1.2.2'],
      ['claude', true, false, null],
      ['codex', false, false, null],
      ['opencode', false, false, null],
      ['glab', false, true, 'glab 1.50'],
    ]);
    expect(r.tools[1]!.fix).toBeNull();
    expect(r.tools[2]!.fix).toContain('npm install -g @anthropic-ai/claude-code');
    expect(r.tools[3]!.fix).toContain('npm install -g @openai/codex');
    expect(r.data_dir).toEqual({ path: dataDir, ok: true, problem: null });
  });
  it('keeps the login hint on a healthy claude row and flags an unwritable data dir', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-doctor-')), 'file');
    fs.writeFileSync(file, 'x');
    const ok: VersionRunner = async () => ({ code: 0, stdout: 'v1', stderr: '' });
    const r = await runDoctor(loadConfig({ OVERSEER_DATA_DIR: path.join(file, 'sub') }), ok, { timeoutMs: 50 });
    expect(r.tools.every((t) => t.ok)).toBe(true);
    expect(r.tools.find((t) => t.name === 'claude')!.fix).toContain('claude');
    expect(r.data_dir.ok).toBe(false);
    expect(r.data_dir.problem).toBeTruthy();
  });
});
```

Run: `pnpm --filter @overseer/daemon exec vitest run doctor` → FAIL (module not found).

- [ ] **Step 2: Implement the module**

`packages/daemon/src/doctor/doctor.ts`:

```ts
import fs from 'node:fs';
import type { DoctorResponse, DoctorTool, DoctorToolName } from '@overseer/shared';
import type { Config } from '../config';

export type VersionRunner = (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const CLAUDE_LOGIN_HINT = 'Run `claude` once in a terminal to log in if you have not yet.';

const TOOLS: { name: DoctorToolName; required: boolean; bin: (c: Config) => string; fix: string }[] = [
  { name: 'git', required: true, bin: () => 'git', fix: 'Install git and make sure it is on PATH.' },
  { name: 'bd', required: true, bin: (c) => c.bdBin, fix: 'npm install -g @beads/bd\nOn Windows, if the npm postinstall fails, copy bd.exe from the GitHub release into the package\'s bin directory.' },
  { name: 'claude', required: true, bin: (c) => c.claudeBin, fix: `npm install -g @anthropic-ai/claude-code\n${CLAUDE_LOGIN_HINT}` },
  { name: 'codex', required: false, bin: (c) => c.codexBin, fix: 'npm install -g @openai/codex\nThen run `codex login`.' },
  { name: 'opencode', required: false, bin: (c) => c.opencodeBin, fix: 'npm install -g opencode-ai' },
  { name: 'glab', required: false, bin: (c) => c.glabBin, fix: 'Install glab (https://gitlab.com/gitlab-org/cli) and run `glab auth login`.' },
];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function checkTool(t: (typeof TOOLS)[number], config: Config, run: VersionRunner, timeoutMs: number): Promise<DoctorTool> {
  let ok = false;
  let version: string | null = null;
  try {
    const r = await withTimeout(run(t.bin(config), ['--version']), timeoutMs);
    ok = r.code === 0;
    version = ok ? (r.stdout.trim().split(/\r?\n/)[0] ?? '') || null : null;
  } catch {
    ok = false;
  }
  const fix = !ok ? t.fix : t.name === 'claude' ? CLAUDE_LOGIN_HINT : null;
  return { name: t.name, required: t.required, ok, version, fix };
}

function checkDataDir(dir: string): DoctorResponse['data_dir'] {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { path: dir, ok: true, problem: null };
  } catch (e) {
    return { path: dir, ok: false, problem: `cannot write to ${dir}: ${(e as Error).message}` };
  }
}

export async function runDoctor(config: Config, run: VersionRunner, opts: { timeoutMs?: number } = {}): Promise<DoctorResponse> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const tools = await Promise.all(TOOLS.map((t) => checkTool(t, config, run, timeoutMs)));
  return { tools, data_dir: checkDataDir(config.dataDir) };
}
```

Run: `pnpm --filter @overseer/daemon exec vitest run doctor` → PASS.

- [ ] **Step 3: Add the route and its test**

`packages/daemon/src/api/rest.ts`: add imports

```ts
import { runDoctor } from '../doctor/doctor';
import { runCapture } from '../util/procs';
```

and the route after `/api/health`:

```ts
  app.get('/api/doctor', async () => runDoctor(d.config, runCapture));
```

In `packages/daemon/src/app.test.ts`, add to the `REST` describe:

```ts
  it('reports the doctor', async () => {
    const r = await json('GET', '/api/doctor');
    expect(r.status).toBe(200);
    expect(r.body.tools).toHaveLength(6);
    expect(r.body.tools[0]).toMatchObject({ name: 'git', required: true, ok: true });
    expect(r.body.data_dir.ok).toBe(true);
  });
```

Run: `pnpm --filter @overseer/daemon exec vitest run doctor app.test` → PASS. `pnpm --filter @overseer/daemon typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/doctor/doctor.ts packages/daemon/src/doctor/doctor.test.ts packages/daemon/src/api/rest.ts packages/daemon/src/app.test.ts
git commit -m "Add the doctor: tool versions, fix hints and data dir check"
```

---

### Task 3: Folder browse and repo inspect

**Goal:** The daemon lists folders for the picker and reports whether a path can be registered.

**Files:**
- Create: `packages/daemon/src/fs/paths.ts`
- Create: `packages/daemon/src/fs/browse.ts`
- Create: `packages/daemon/src/fs/browse.test.ts`
- Create: `packages/daemon/src/fs/inspect.ts`
- Create: `packages/daemon/src/fs/inspect.test.ts`
- Modify: `packages/daemon/src/api/rest.ts`
- Modify: `packages/daemon/src/app.test.ts`

**Acceptance Criteria:**
- [ ] `browse(undefined)` returns roots: on win32 one entry per existing drive letter with `path` like `C:\`, elsewhere the home dir; `path` and `parent` are null.
- [ ] `browse(dir)` lists subfolders sorted by name, skips names starting with `.`, marks folders containing `.git` (file or dir) as `is_git_repo`, and sets `parent` to the parent dir or null at a filesystem root.
- [ ] `browse(missing)` and `browse(file)` throw `BrowseError`; the route maps it to 400.
- [ ] `inspectRepo` returns problems `folder does not exist`, `not the root of a git repository`, `already registered as <id>` in the right cases, and `has_beads`, `branch`, `suggested_id` for a good repo.
- [ ] `suggestId('My Repo.v2')` is `my-repo-v2`; an all-punctuation basename gives `repo`.
- [ ] Routes: `GET /api/fs/browse` and `POST /api/repos/inspect` are wired and covered in `app.test.ts`.

**Verify:** `pnpm --filter @overseer/daemon exec vitest run fs/ app.test` → all green

**Steps:**

- [ ] **Step 1: Path helpers**

`packages/daemon/src/fs/paths.ts`:

```ts
import path from 'node:path';

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function suggestId(p: string): string {
  const id = path.basename(path.resolve(p)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'repo';
}
```

- [ ] **Step 2: Write the failing browse test**

`packages/daemon/src/fs/browse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browse, BrowseError } from './browse';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-browse-'));
  fs.mkdirSync(path.join(root, 'b-plain'));
  fs.mkdirSync(path.join(root, 'a-repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'c-worktree'));
  fs.writeFileSync(path.join(root, 'c-worktree', '.git'), 'gitdir: elsewhere');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  return root;
}

describe('browse', () => {
  it('lists subfolders, marks git repos, skips dot folders and files', async () => {
    const root = tree();
    const r = await browse(root);
    expect(r.path).toBe(root);
    expect(r.parent).toBe(path.dirname(root));
    expect(r.entries).toEqual([
      { name: 'a-repo', path: path.join(root, 'a-repo'), is_git_repo: true },
      { name: 'b-plain', path: path.join(root, 'b-plain'), is_git_repo: false },
      { name: 'c-worktree', path: path.join(root, 'c-worktree'), is_git_repo: true },
    ]);
  });
  it('returns roots without a path', async () => {
    const r = await browse(undefined);
    expect(r.path).toBeNull();
    expect(r.parent).toBeNull();
    expect(r.entries.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(r.entries[0]!.path).toMatch(/^[A-Z]:\\$/);
    else expect(r.entries[0]!.path).toBe(os.homedir());
  });
  it('has a null parent at a filesystem root', async () => {
    const root = path.parse(os.tmpdir()).root;
    expect((await browse(root)).parent).toBeNull();
  });
  it('rejects missing paths and files', async () => {
    const root = tree();
    await expect(browse(path.join(root, 'nope'))).rejects.toBeInstanceOf(BrowseError);
    await expect(browse(path.join(root, 'file.txt'))).rejects.toBeInstanceOf(BrowseError);
  });
});
```

Run: `pnpm --filter @overseer/daemon exec vitest run fs/browse` → FAIL.

- [ ] **Step 3: Implement browse**

`packages/daemon/src/fs/browse.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowseEntry, BrowseResponse } from '@overseer/shared';

export class BrowseError extends Error {}

function roots(platform: NodeJS.Platform): BrowseEntry[] {
  if (platform !== 'win32') {
    const home = os.homedir();
    return [{ name: home, path: home, is_git_repo: fs.existsSync(path.join(home, '.git')) }];
  }
  const out: BrowseEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(p)) out.push({ name: p.slice(0, 2), path: p, is_git_repo: false });
  }
  return out;
}

export async function browse(p: string | undefined, platform: NodeJS.Platform = process.platform): Promise<BrowseResponse> {
  if (!p) return { path: null, parent: null, entries: roots(platform) };
  const dir = path.resolve(p);
  let names: fs.Dirent[];
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new BrowseError(`cannot read ${dir}: ${(e as Error).message}`);
  }
  const entries = names
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), is_git_repo: fs.existsSync(path.join(dir, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}
```

Run: `pnpm --filter @overseer/daemon exec vitest run fs/browse` → PASS.

- [ ] **Step 4: Write the failing inspect test**

`packages/daemon/src/fs/inspect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import { mkTmpRepo } from '../test/tmpgit';
import { inspectRepo } from './inspect';
import { suggestId } from './paths';

const reg = (p: string): Repo => ({ id: 'reg', path: p, base_branch: 'main', verify_command: null, merge_mode: 'local-merge', worker_limit: 2 });

describe('inspectRepo', () => {
  it('describes a registrable repo', async () => {
    const t = mkTmpRepo();
    const r = await inspectRepo(t.path, []);
    expect(r).toMatchObject({ path: t.path, exists: true, is_git_root: true, branch: 'main', has_beads: false, suggested_id: 'repo', problems: [] });
    fs.mkdirSync(path.join(t.path, '.beads'));
    expect((await inspectRepo(t.path, [])).has_beads).toBe(true);
  });
  it('reports the problems', async () => {
    const t = mkTmpRepo();
    expect((await inspectRepo(path.join(t.path, 'nope'), [])).problems).toEqual(['folder does not exist']);
    fs.mkdirSync(path.join(t.path, 'sub'));
    const sub = await inspectRepo(path.join(t.path, 'sub'), []);
    expect(sub.exists).toBe(true);
    expect(sub.problems).toEqual(['not the root of a git repository']);
    expect((await inspectRepo(path.dirname(t.path), [])).problems).toEqual(['not the root of a git repository']);
    const upper = process.platform === 'win32' ? t.path.toUpperCase() : t.path;
    expect((await inspectRepo(t.path, [reg(upper)])).problems).toEqual(['already registered as reg']);
  });
  it('suggests ids', () => {
    expect(suggestId('/x/My Repo.v2')).toBe('my-repo-v2');
    expect(suggestId('/x/---')).toBe('repo');
  });
});
```

Run: `pnpm --filter @overseer/daemon exec vitest run fs/inspect` → FAIL.

- [ ] **Step 5: Implement inspect**

`packages/daemon/src/fs/inspect.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { InspectResponse, Repo } from '@overseer/shared';
import { git } from '../git/git';
import { samePath, suggestId } from './paths';

export async function inspectRepo(raw: string, registered: Repo[]): Promise<InspectResponse> {
  const p = path.resolve(raw);
  const res: InspectResponse = { path: p, exists: false, is_git_root: false, branch: null, has_beads: false, suggested_id: suggestId(p), problems: [] };
  let isDir = false;
  try { isDir = fs.statSync(p).isDirectory(); } catch { /* missing */ }
  if (!isDir) { res.problems.push('folder does not exist'); return res; }
  res.exists = true;
  let top: string | null = null;
  try { top = await git(p, ['rev-parse', '--show-toplevel']); } catch { /* not inside a repo */ }
  if (!top || !samePath(top, p)) { res.problems.push('not the root of a git repository'); return res; }
  res.is_git_root = true;
  try { res.branch = await git(p, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { res.branch = null; }
  res.has_beads = fs.existsSync(path.join(p, '.beads'));
  const dup = registered.find((r) => samePath(r.path, p));
  if (dup) res.problems.push(`already registered as ${dup.id}`);
  return res;
}
```

Run: `pnpm --filter @overseer/daemon exec vitest run fs/` → PASS.

- [ ] **Step 6: Routes and route tests**

`packages/daemon/src/api/rest.ts`: imports

```ts
import { browse, BrowseError } from '../fs/browse';
import { inspectRepo } from '../fs/inspect';
```

Add to the error handler, before the `app.log.error(err)` line:

```ts
    if (err instanceof BrowseError) return reply.code(400).send({ error: err.message });
```

Routes, after `GET /api/repos`:

```ts
  app.get<{ Querystring: { path?: string } }>('/api/fs/browse', async (req) => browse(req.query.path || undefined));

  app.post('/api/repos/inspect', async (req) => {
    const { path: p } = z.object({ path: z.string().min(1) }).parse(req.body);
    return inspectRepo(p, d.db.repos.all());
  });
```

`packages/daemon/src/app.test.ts`, in the `REST` describe (before the merge test):

```ts
  it('browses folders and inspects paths', async () => {
    const roots = await json('GET', '/api/fs/browse');
    expect(roots.body.path).toBeNull();
    const parent = path.dirname(x.t.path);
    const listing = await json('GET', `/api/fs/browse?path=${encodeURIComponent(parent)}`);
    expect(listing.body.entries).toContainEqual({ name: 'repo', path: x.t.path, is_git_repo: true });
    expect((await json('GET', `/api/fs/browse?path=${encodeURIComponent(path.join(parent, 'nope'))}`)).status).toBe(400);
    const ins = await json('POST', '/api/repos/inspect', { path: x.t.path });
    expect(ins.body).toMatchObject({ is_git_root: true, branch: 'main', has_beads: true, problems: ['already registered as r1'] });
    expect((await json('POST', '/api/repos/inspect', { path: parent })).body.problems).toEqual(['not the root of a git repository']);
  });
```

Note: `x.t.path` is registered as `r1` by the first REST test, and its `.beads` dir is created in `setup()`.

Run: `pnpm --filter @overseer/daemon exec vitest run fs/ app.test` → PASS. `pnpm --filter @overseer/daemon typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/fs/paths.ts packages/daemon/src/fs/browse.ts packages/daemon/src/fs/browse.test.ts packages/daemon/src/fs/inspect.ts packages/daemon/src/fs/inspect.test.ts packages/daemon/src/api/rest.ts packages/daemon/src/app.test.ts
git commit -m "Add folder browse and repo inspect for the setup picker"
```

---

### Task 4: Registration with beads init, PATCH and DELETE

**Goal:** `POST /api/repos` initialises beads itself (stealth by default), and repos can be edited and removed.

**Files:**
- Modify: `packages/daemon/src/beads/store.ts`
- Modify: `packages/daemon/src/beads/beads.ts`
- Modify: `packages/daemon/src/beads/memory.ts`
- Modify: `packages/daemon/src/db/db.ts`
- Modify: `packages/daemon/src/git/git.ts`
- Modify: `packages/daemon/src/api/rest.ts`
- Modify: `packages/daemon/src/app.test.ts`
- Modify: `packages/daemon/src/beads/beads.test.ts` (or the existing file that tests `Beads` with a fake runner; create `beads.init.test.ts` if none uses a fake runner)

**Acceptance Criteria:**
- [ ] `TaskStore.init(repoPath, prefix, mode)` exists; `Beads.init` runs exactly `['init', '--prefix', prefix, '--non-interactive', '--stealth']` in `repoPath` for stealth and without `--stealth` for commit, never with `--json`, and rejects with an Error whose message contains bd's stderr on a non-zero exit.
- [ ] `POST /api/repos` on a repo without `.beads` calls init with the id as prefix and the requested mode (default stealth); with `.beads` present it does not call init.
- [ ] A failing init returns 400 with the message and inserts no row.
- [ ] Ids not matching `^[a-z0-9][a-z0-9-]*$` are 400; a non-root path is 400 with the inspect problem text; a duplicate id is 409.
- [ ] `PATCH /api/repos/:id` updates the given fields, returns the row, 404 for unknown, 400 for empty or unknown fields.
- [ ] `DELETE /api/repos/:id` is 409 with `sessions` while a running session belongs to the repo; otherwise removes the git worktrees and the worktree and repo rows, tolerates a worktree path that no longer exists, and returns `{ ok: true, warnings }`.
- [ ] Add, patch and delete emit `repos` and `board` on the bus.

**Verify:** `pnpm --filter @overseer/daemon test` → all green (78+ passed, no warnings)

**Steps:**

- [ ] **Step 1: Store interface and implementations**

`packages/daemon/src/beads/store.ts`: add to the imports `BeadsMode` from `@overseer/shared` and to `TaskStore`:

```ts
  /** Runs `bd init` in repoPath. Rejects with an Error whose message carries bd's output. */
  init(repoPath: string, prefix: string, mode: BeadsMode): Promise<void>;
```

`packages/daemon/src/beads/beads.ts`, inside `class Beads` after `available()`:

```ts
  async init(repoPath: string, prefix: string, mode: BeadsMode): Promise<void> {
    const args = ['init', '--prefix', prefix, '--non-interactive', ...(mode === 'stealth' ? ['--stealth'] : [])];
    const r = await this.run(repoPath, args);
    if (r.code !== 0) throw new Error(`bd init failed: ${(r.stderr || r.stdout).trim()}`);
  }
```

(import `BeadsMode` from `@overseer/shared` alongside `Bead, Phase`.)

`packages/daemon/src/beads/memory.ts`, inside `MemoryTaskStore`:

```ts
  inits: { repoPath: string; prefix: string; mode: BeadsMode }[] = [];
  failInit: string | null = null;

  async init(repoPath: string, prefix: string, mode: BeadsMode): Promise<void> {
    if (this.failInit) throw new Error(`bd init failed: ${this.failInit}`);
    this.inits.push({ repoPath, prefix, mode });
    fs.mkdirSync(path.join(repoPath, '.beads'), { recursive: true });
  }
```

(add `import fs from 'node:fs'; import path from 'node:path';` and the `BeadsMode` type import.)

- [ ] **Step 2: Test `Beads.init` with a fake runner**

Find the existing test that constructs `new Beads(fakeRunner)`; if there is none, create `packages/daemon/src/beads/beads.init.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Beads, type BdRunner } from './beads';

describe('Beads.init', () => {
  it('passes the exact arguments and surfaces failures', async () => {
    const calls: { cwd: string; args: string[] }[] = [];
    let code = 0;
    const run: BdRunner = async (cwd, args) => { calls.push({ cwd, args }); return { code, stdout: '', stderr: 'no dolt' }; };
    const b = new Beads(run);
    await b.init('/r', 'demo', 'stealth');
    await b.init('/r', 'demo', 'commit');
    expect(calls).toEqual([
      { cwd: '/r', args: ['init', '--prefix', 'demo', '--non-interactive', '--stealth'] },
      { cwd: '/r', args: ['init', '--prefix', 'demo', '--non-interactive'] },
    ]);
    code = 1;
    await expect(b.init('/r', 'demo', 'stealth')).rejects.toThrow('bd init failed: no dolt');
  });
});
```

Run: `pnpm --filter @overseer/daemon exec vitest run beads` → PASS.

- [ ] **Step 3: Db and git helpers**

`packages/daemon/src/db/db.ts`, inside `repos`:

```ts
    update: (id: string, patch: Partial<Repo>) => this.patch('repos', 'id', id, patch),
    delete: (id: string) => this.sql.prepare('DELETE FROM repos WHERE id=?').run(id),
```

`packages/daemon/src/git/git.ts`, after `removeWorktree`:

```ts
/** removeWorktree with one retry: antivirus scanners briefly lock fresh folders on Windows. */
export async function removeWorktreeRetry(repoPath: string, wtPath: string, branch: string, delayMs = 500): Promise<void> {
  try {
    await removeWorktree(repoPath, wtPath, branch);
  } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    await removeWorktree(repoPath, wtPath, branch);
  }
}
```

- [ ] **Step 4: Write the failing route tests**

In `packages/daemon/src/app.test.ts` add a second describe after `REST` (it needs its own repos so the existing tests keep their state):

```ts
describe('repo registration, patch and delete', () => {
  it('initialises beads in stealth mode by default and commit mode on request', async () => {
    const a = mkTmpRepo();
    const r = await json('POST', '/api/repos', { path: a.path, id: 'stealth-a' });
    expect(r.status).toBe(200);
    expect(x.store.inits.at(-1)).toEqual({ repoPath: a.path, prefix: 'stealth-a', mode: 'stealth' });
    expect(fs.existsSync(path.join(a.path, '.beads'))).toBe(true);
    const b = mkTmpRepo();
    expect((await json('POST', '/api/repos', { path: b.path, id: 'commit-b', beads: 'commit' })).status).toBe(200);
    expect(x.store.inits.at(-1)).toMatchObject({ prefix: 'commit-b', mode: 'commit' });
    const before = x.store.inits.length;
    const c = mkTmpRepo();
    fs.mkdirSync(path.join(c.path, '.beads'));
    expect((await json('POST', '/api/repos', { path: c.path, id: 'has-beads-c' })).status).toBe(200);
    expect(x.store.inits.length).toBe(before);
  });
  it('rejects bad ids, non-roots and failed inits without inserting', async () => {
    const t = mkTmpRepo();
    expect((await json('POST', '/api/repos', { path: t.path, id: 'Bad_Id' })).status).toBe(400);
    const sub = path.join(t.path, 'sub');
    fs.mkdirSync(sub);
    const nr = await json('POST', '/api/repos', { path: sub, id: 'sub' });
    expect(nr.status).toBe(400);
    expect(nr.body.error).toBe('not the root of a git repository');
    x.store.failInit = 'dolt exploded';
    const count = (await json('GET', '/api/repos')).body.length;
    const f = await json('POST', '/api/repos', { path: t.path, id: 'fail-t' });
    x.store.failInit = null;
    expect(f.status).toBe(400);
    expect(f.body.error).toContain('dolt exploded');
    expect((await json('GET', '/api/repos')).body.length).toBe(count);
    expect(fs.existsSync(path.join(t.path, '.beads'))).toBe(false);
  });
  it('patches fields and rejects empty or unknown patches', async () => {
    const t = mkTmpRepo();
    expect((await json('POST', '/api/repos', { path: t.path, id: 'patch-t' })).status).toBe(200);
    const seen: string[] = [];
    const off = x.bus.on('repos', () => seen.push('repos'));
    const r = await json('PATCH', '/api/repos/patch-t', { worker_limit: 3, verify_command: 'pnpm test' });
    off();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'patch-t', worker_limit: 3, verify_command: 'pnpm test', merge_mode: 'local-merge' });
    expect(seen).toEqual(['repos']);
    expect((await json('PATCH', '/api/repos/patch-t', {})).status).toBe(400);
    expect((await json('PATCH', '/api/repos/patch-t', { id: 'nope' })).status).toBe(400);
    expect((await json('PATCH', '/api/repos/missing', { worker_limit: 1 })).status).toBe(404);
  });
  it('refuses to delete while a session runs, then removes worktrees and rows', async () => {
    const t = mkTmpRepo();
    expect((await json('POST', '/api/repos', { path: t.path, id: 'del-t' })).status).toBe(200);
    const repo = x.db.repos.get('del-t')!;
    x.db.sessions.insert({ id: 'sess-run', harness: 'claude', role: 'worker', bead_id: 'ov-d1', repo_id: 'del-t', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: t.path, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null });
    const busy = await json('DELETE', '/api/repos/del-t');
    expect(busy.status).toBe(409);
    expect(busy.body.sessions).toEqual(['sess-run']);
    x.db.sessions.update('sess-run', { status: 'ended' });
    const wt = await ensureWorktree(repo, 'ov-d1', x.config.worktreesDir);
    x.db.worktrees.upsert({ bead_id: 'ov-d1', repo_id: 'del-t', path: wt.path, branch: wt.branch, base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null });
    x.db.worktrees.upsert({ bead_id: 'ov-d2', repo_id: 'del-t', path: path.join(x.config.worktreesDir, 'gone'), branch: 'bead/ov-d2', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null });
    const r = await json('DELETE', '/api/repos/del-t');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, warnings: [] });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.db.worktrees.forRepo('del-t')).toEqual([]);
    expect(x.db.repos.get('del-t')).toBeUndefined();
    expect((await json('DELETE', '/api/repos/del-t')).status).toBe(404);
  });
});
```

Add to the imports: `import { ensureWorktree } from './git/git';` and widen the `json` helper's method type to `'GET' | 'POST' | 'PATCH' | 'DELETE'`. If `SessionRow` has fields other than those listed, fill them with `null` so the object typechecks.

Run: `pnpm --filter @overseer/daemon exec vitest run app.test` → FAIL.

- [ ] **Step 5: Implement the routes**

`packages/daemon/src/api/rest.ts`: replace the `repoBody` schema and the `POST /api/repos` route, and add PATCH and DELETE.

```ts
const repoFields = {
  base_branch: z.string().min(1).optional(),
  verify_command: z.string().nullable().optional(),
  merge_mode: z.enum(['local-merge', 'gitlab-mr']).optional(),
  worker_limit: z.number().int().min(1).max(16).optional(),
};
const repoBody = z.object({
  path: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only').optional(),
  beads: z.enum(['stealth', 'commit']).optional(),
  ...repoFields,
});
const repoPatch = z.object(repoFields).strict();
```

```ts
  app.post('/api/repos', async (req, reply) => {
    const b = repoBody.parse(req.body);
    const info = await inspectRepo(b.path, d.db.repos.all());
    if (info.problems.length) return reply.code(400).send({ error: info.problems.join('; ') });
    const id = b.id ?? info.suggested_id;
    if (d.db.repos.get(id)) return reply.code(409).send({ error: `repo ${id} already registered` });
    if (!info.has_beads) {
      try { await d.store.init(info.path, id, b.beads ?? 'stealth'); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    }
    const repo: Repo = { id, path: info.path, base_branch: b.base_branch ?? info.branch ?? 'HEAD', verify_command: b.verify_command ?? null, merge_mode: b.merge_mode ?? 'local-merge', worker_limit: b.worker_limit ?? 2 };
    d.db.repos.insert(repo);
    d.bus.emit('repos');
    d.bus.emit('board');
    return repo;
  });

  app.patch<{ Params: { id: string } }>('/api/repos/:id', async (req, reply) => {
    const p = repoPatch.parse(req.body ?? {});
    if (Object.keys(p).length === 0) return reply.code(400).send({ error: 'nothing to update' });
    if (!d.db.repos.get(req.params.id)) return reply.code(404).send({ error: `repo ${req.params.id} not found` });
    d.db.repos.update(req.params.id, p);
    d.bus.emit('repos');
    d.bus.emit('board');
    return d.db.repos.get(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/repos/:id', async (req, reply) => {
    const id = req.params.id;
    const repo = d.db.repos.get(id);
    if (!repo) return reply.code(404).send({ error: `repo ${id} not found` });
    const running = d.db.sessions.running().filter((s) => s.repo_id === id);
    if (running.length) return reply.code(409).send({ error: `repo ${id} has running sessions`, sessions: running.map((s) => s.id) });
    const warnings: string[] = [];
    for (const wt of d.db.worktrees.forRepo(id)) {
      try { await removeWorktreeRetry(repo.path, wt.path, wt.branch); }
      catch (e) { warnings.push(`${wt.bead_id}: ${(e as Error).message}`); }
      d.db.worktrees.delete(wt.bead_id);
    }
    d.db.repos.delete(id);
    d.bus.emit('repos');
    d.bus.emit('board');
    const out: DeleteRepoResponse = { ok: true, warnings };
    return out;
  });
```

Imports to add: `DeleteRepoResponse` from `@overseer/shared`, `removeWorktreeRetry` from `../git/git`. Remove the now-unused `fs` import if nothing else in the file uses it (the task detail route still uses `fs.existsSync`, so keep it).

Run: `pnpm --filter @overseer/daemon test` → all green, no warnings. `pnpm --filter @overseer/daemon typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/beads/store.ts packages/daemon/src/beads/beads.ts packages/daemon/src/beads/memory.ts packages/daemon/src/beads/beads.init.test.ts packages/daemon/src/db/db.ts packages/daemon/src/git/git.ts packages/daemon/src/api/rest.ts packages/daemon/src/app.test.ts
git commit -m "Register repos with daemon-run beads init; add repo PATCH and DELETE"
```

(Adjust the test file name if you extended an existing beads test instead.)

---

### Task 5: Setup view with prerequisites panel, repo table and add/edit form

**Goal:** A Setup view that shows the doctor, lists repos with Edit and Remove, and adds repos through a form gated by live inspect.

**Files:**
- Create: `packages/web/src/components/RepoForm.tsx`
- Create: `packages/web/src/views/Setup.tsx`
- Create: `packages/web/src/views/Setup.test.tsx`
- Modify: `packages/web/src/test/fixtures.ts`
- Modify: `packages/web/src/styles.css`

**Acceptance Criteria:**
- [ ] Doctor rows show name, required/optional, version or "not found", and the fix text; the data dir row is last.
- [ ] Remove calls `confirm()`, then DELETE, and shows the 409 session list inline when refused.
- [ ] Edit replaces the row with the form; Save sends PATCH with base_branch, verify_command (null when empty), merge_mode, worker_limit (number).
- [ ] Add is disabled until an inspect result with no problems exists; typing a path calls `POST /api/repos/inspect` after a 300 ms debounce.
- [ ] Id and base branch are prefilled from inspect until the user edits them.
- [ ] The beads checkbox appears only when the inspected repo exists and has no `.beads`; unchecked sends `beads: 'stealth'`, checked sends `beads: 'commit'`.
- [ ] `doctorAlert(doctor)` is true when a required tool or the data dir is not ok.

**Verify:** `pnpm --filter @overseer/web test -- Setup && pnpm --filter @overseer/web typecheck` → green

**Steps:**

- [ ] **Step 1: Fixtures**

Append to `packages/web/src/test/fixtures.ts` (extend the type import with `DoctorResponse, InspectResponse`):

```ts
export const doctorOk: DoctorResponse = {
  tools: [
    { name: 'git', required: true, ok: true, version: 'git version 2.45.0', fix: null },
    { name: 'bd', required: true, ok: true, version: 'bd version 1.2.2', fix: null },
    { name: 'claude', required: true, ok: true, version: '2.1.269', fix: 'Run `claude` once in a terminal to log in if you have not yet.' },
    { name: 'codex', required: false, ok: false, version: null, fix: 'npm install -g @openai/codex\nThen run `codex login`.' },
    { name: 'opencode', required: false, ok: true, version: '1.0.0', fix: null },
    { name: 'glab', required: false, ok: false, version: null, fix: 'Install glab (https://gitlab.com/gitlab-org/cli) and run `glab auth login`.' },
  ],
  data_dir: { path: 'C:/Users/me/.overseer', ok: true, problem: null },
};

export const doctorBad: DoctorResponse = {
  ...doctorOk,
  tools: doctorOk.tools.map((t) => (t.name === 'claude' ? { ...t, ok: false, version: null, fix: 'npm install -g @anthropic-ai/claude-code\nRun `claude` once in a terminal to log in if you have not yet.' } : t)),
};

export const inspectNoBeads: InspectResponse = { path: 'E:\\Projects\\demo', exists: true, is_git_root: true, branch: 'main', has_beads: false, suggested_id: 'demo', problems: [] };
export const inspectBad: InspectResponse = { path: 'E:\\bad', exists: false, is_git_root: false, branch: null, has_beads: false, suggested_id: 'bad', problems: ['folder does not exist'] };
```

- [ ] **Step 2: Write the failing tests**

`packages/web/src/views/Setup.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Setup, doctorAlert } from './Setup';
import { mockApi } from '../test/setup';
import { repo, doctorOk, doctorBad, inspectNoBeads, inspectBad } from '../test/fixtures';

type Call = { method: string; url: string; body?: unknown };

describe('Setup', () => {
  it('computes the alert', () => {
    expect(doctorAlert(null)).toBe(false);
    expect(doctorAlert(doctorOk)).toBe(false);
    expect(doctorAlert(doctorBad)).toBe(true);
    expect(doctorAlert({ ...doctorOk, data_dir: { path: 'x', ok: false, problem: 'ro' } })).toBe(true);
  });

  it('renders doctor rows, removes and edits repos', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('confirm', () => true);
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'DELETE') throw Object.assign(new Error('repo r1 has running sessions'), { status: 409 });
      if (method === 'PATCH') return { ...repo, worker_limit: 3 };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[repo]} doctor={doctorBad} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(screen.getByText(/npm install -g @anthropic-ai\/claude-code/)).toBeTruthy();
    expect(screen.getAllByText('not found').length).toBe(3);
    expect(screen.getByText('C:/Users/me/.overseer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/repos/r1' }));
    await waitFor(() => expect(screen.getByText(/has running sessions/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Worker limit'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/repos/r1', body: { base_branch: 'main', verify_command: null, merge_mode: 'local-merge', worker_limit: 3 } }));
  });

  it('gates Add on inspect, prefills, shows the beads checkbox and posts', async () => {
    const calls: Call[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith('/api/repos/inspect')) return (body as { path: string }).path === 'E:\\bad' ? inspectBad : inspectNoBeads;
      if (method === 'POST' && url.endsWith('/api/repos')) return repo;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'E:\\bad' } });
    await waitFor(() => expect(screen.getByText('folder does not exist')).toBeTruthy());
    expect(add.disabled).toBe(true);
    expect(screen.queryByLabelText(/My team uses beads/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'E:\\Projects\\demo' } });
    await waitFor(() => expect(screen.getByText(/git repository on branch main/)).toBeTruthy());
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('demo');
    expect((screen.getByLabelText('Base branch') as HTMLInputElement).value).toBe('main');
    expect(add.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/My team uses beads/));
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: 'pnpm test' } });
    fireEvent.click(add);
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'POST', url: '/api/repos', body: { path: 'E:\\Projects\\demo', id: 'demo', base_branch: 'main', verify_command: 'pnpm test', merge_mode: 'local-merge', worker_limit: 2, beads: 'commit' } }));
    await waitFor(() => expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe(''));
  });
});
```

Run: `pnpm --filter @overseer/web test -- Setup` → FAIL (module not found).

- [ ] **Step 3: The form**

`packages/web/src/components/RepoForm.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { InspectResponse, MergeMode, Repo } from '@overseer/shared';
import { api } from '../api';

export type RepoFormProps =
  | { mode: 'add'; onDone: () => void }
  | { mode: 'edit'; repo: Repo; onDone: () => void; onCancel: () => void };

export function RepoForm(p: RepoFormProps) {
  const existing = p.mode === 'edit' ? p.repo : null;
  const [path, setPath] = useState('');
  const [inspect, setInspect] = useState<InspectResponse | null>(null);
  const [id, setId] = useState(existing?.id ?? '');
  const [branch, setBranch] = useState(existing?.base_branch ?? '');
  const [verify, setVerify] = useState(existing?.verify_command ?? '');
  const [limit, setLimit] = useState(String(existing?.worker_limit ?? 2));
  const [merge, setMerge] = useState<MergeMode>(existing?.merge_mode ?? 'local-merge');
  const [commitBeads, setCommitBeads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idTouched = useRef(false);
  const branchTouched = useRef(false);

  useEffect(() => {
    if (p.mode !== 'add') return;
    const value = path.trim();
    if (!value) { setInspect(null); return; }
    const t = setTimeout(() => {
      api.post<InspectResponse>('/repos/inspect', { path: value }).then((r) => {
        setInspect(r);
        if (!idTouched.current) setId(r.suggested_id);
        if (!branchTouched.current && r.branch) setBranch(r.branch);
      }).catch((e: Error) => setError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [path, p.mode]);

  const canSubmit = p.mode === 'edit' || (inspect !== null && inspect.problems.length === 0);
  const showBeads = p.mode === 'add' && inspect !== null && inspect.exists && !inspect.has_beads;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const fields = { base_branch: branch.trim(), verify_command: verify.trim() || null, merge_mode: merge, worker_limit: Number(limit) };
      if (p.mode === 'edit') {
        await api.patch(`/repos/${p.repo.id}`, fields);
      } else {
        await api.post('/repos', { path: path.trim(), id: id.trim(), ...fields, ...(showBeads ? { beads: commitBeads ? 'commit' : 'stealth' } : {}) });
        setPath(''); setInspect(null); setId(''); setBranch(''); setVerify(''); setLimit('2'); setMerge('local-merge'); setCommitBeads(false);
        idTouched.current = false; branchTouched.current = false;
      }
      p.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="repo-form">
      {p.mode === 'add' && (
        <label>Path
          <input aria-label="Path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="E:\Projects\my-repo" />
          {inspect && (inspect.problems.length === 0
            ? <div className="ok">git repository on branch {inspect.branch}</div>
            : <div className="badge-warn">{inspect.problems.join('; ')}</div>)}
        </label>
      )}
      {p.mode === 'add' && <label>Id<input aria-label="Id" value={id} onChange={(e) => { idTouched.current = true; setId(e.target.value); }} /></label>}
      <label>Base branch<input aria-label="Base branch" value={branch} onChange={(e) => { branchTouched.current = true; setBranch(e.target.value); }} /></label>
      <label>Verify command<input aria-label="Verify command" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="pnpm test (empty: no verification)" /></label>
      <label>Worker limit<input aria-label="Worker limit" type="number" min={1} max={16} value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
      <label>Merge mode
        <select aria-label="Merge mode" value={merge} onChange={(e) => setMerge(e.target.value as MergeMode)}>
          <option value="local-merge">local-merge</option>
          <option value="gitlab-mr">gitlab-mr</option>
        </select>
      </label>
      {showBeads && (
        <label className="checkbox">
          <input type="checkbox" aria-label="My team uses beads: commit its files" checked={commitBeads} onChange={(e) => setCommitBeads(e.target.checked)} /> My team uses beads: commit its files
          <div className="muted">Unchecked: beads is set up in stealth mode, nothing is committed and teammates see nothing.</div>
        </label>
      )}
      <div className="form-actions">
        <button disabled={!canSubmit || busy} onClick={() => void submit()}>{p.mode === 'add' ? 'Add' : 'Save'}</button>
        {p.mode === 'edit' && <button onClick={p.onCancel}>Cancel</button>}
        {error && <span className="badge-warn">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: The view**

`packages/web/src/views/Setup.tsx`:

```tsx
import { useState } from 'react';
import type { DoctorResponse, Repo } from '@overseer/shared';
import { api, ApiError } from '../api';
import { RepoForm } from '../components/RepoForm';

export function doctorAlert(d: DoctorResponse | null): boolean {
  return d !== null && (d.tools.some((t) => t.required && !t.ok) || !d.data_dir.ok);
}

export function Setup(p: { repos: Repo[]; doctor: DoctorResponse | null; onRefreshDoctor: () => void; onReposChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (r: Repo) => {
    if (!confirm(`Remove ${r.id} from Overseer? Its worktrees are deleted; the repository and its beads data stay.`)) return;
    setError(null);
    try {
      await api.delete(`/repos/${r.id}`);
      p.onReposChanged();
    } catch (e) {
      const err = e as ApiError;
      const sessions = (err.body as { sessions?: string[] } | null)?.sessions;
      setError(sessions?.length ? `${err.message}: ${sessions.join(', ')}` : err.message);
    }
  };

  const d = p.doctor;
  return (
    <div className="setup">
      <section>
        <h2>Prerequisites <button onClick={p.onRefreshDoctor}>Refresh</button></h2>
        {!d ? <div className="muted">checking…</div> : (
          <table className="doctor">
            <tbody>
              {d.tools.map((t) => (
                <tr key={t.name} className={t.ok ? '' : t.required ? 'row-bad' : 'row-warn'}>
                  <td>{t.name}</td>
                  <td>{t.required ? 'required' : 'optional'}</td>
                  <td>{t.ok ? t.version ?? 'ok' : 'not found'}</td>
                  <td>{t.fix && <pre className="fix">{t.fix}</pre>}</td>
                </tr>
              ))}
              <tr className={d.data_dir.ok ? '' : 'row-bad'}>
                <td>data dir</td><td>required</td><td>{d.data_dir.ok ? d.data_dir.path : 'not writable'}</td><td>{d.data_dir.problem}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h2>Repositories</h2>
        {p.repos.length === 0 && <div className="muted">No repositories registered yet.</div>}
        {p.repos.length > 0 && (
          <table className="repos">
            <thead><tr><th>id</th><th>path</th><th>base</th><th>merge</th><th>workers</th><th>verify</th><th /></tr></thead>
            <tbody>
              {p.repos.map((r) => editing === r.id ? (
                <tr key={r.id}><td colSpan={7}>
                  <RepoForm mode="edit" repo={r} onDone={() => { setEditing(null); p.onReposChanged(); }} onCancel={() => setEditing(null)} />
                </td></tr>
              ) : (
                <tr key={r.id}>
                  <td>{r.id}</td><td title={r.path}>{r.path}</td><td>{r.base_branch}</td><td>{r.merge_mode}</td><td>{r.worker_limit}</td><td>{r.verify_command ?? ''}</td>
                  <td><button onClick={() => setEditing(r.id)}>Edit</button> <button onClick={() => void remove(r)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <div className="badge-warn">{error}</div>}
      </section>
      <section>
        <h2>Add repository</h2>
        <RepoForm mode="add" onDone={p.onReposChanged} />
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Styles**

Append to `packages/web/src/styles.css`:

```css
.setup { display: flex; flex-direction: column; gap: 24px; max-width: 960px; }
.setup h2 { display: flex; align-items: center; gap: 12px; font-size: 16px; margin: 0 0 8px; }
.setup table { border-collapse: collapse; width: 100%; }
.setup td, .setup th { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 13px; }
.row-bad td:first-child { color: var(--warn); font-weight: 600; }
.row-warn td:first-child { color: var(--muted); }
.fix { margin: 0; white-space: pre-wrap; font-size: 12px; }
.repo-form { display: grid; gap: 8px; max-width: 640px; }
.repo-form label { display: grid; gap: 4px; font-size: 13px; }
.repo-form label.checkbox { display: block; }
.form-actions { display: flex; gap: 8px; align-items: center; }
.ok { color: var(--ok); }
```

Run: `pnpm --filter @overseer/web test -- Setup` → PASS. `pnpm --filter @overseer/web typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/RepoForm.tsx packages/web/src/views/Setup.tsx packages/web/src/views/Setup.test.tsx packages/web/src/test/fixtures.ts packages/web/src/styles.css
git commit -m "Add the Setup view: prerequisites, repo table and add/edit form"
```

---

### Task 6: Browse dialog, rail entry and Setup routing

**Goal:** The form gets a Browse button backed by the daemon's folder listing, the rail shows Setup with an alert dot, and the app opens Setup when nothing is registered or a required tool is missing.

**Files:**
- Create: `packages/web/src/components/BrowseDialog.tsx`
- Create: `packages/web/src/components/BrowseDialog.test.tsx`
- Modify: `packages/web/src/components/RepoForm.tsx`
- Modify: `packages/web/src/components/Rail.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`
- Modify: `packages/web/src/styles.css`

**Acceptance Criteria:**
- [ ] `parentOf('E:\\Projects\\demo')` is `E:\\Projects`, `parentOf('E:\\Projects')` is `E:\\`, `parentOf('E:\\')` and `parentOf('/home')` are null, `parentOf('/home/x')` is `/home`.
- [ ] The dialog starts at the parent of the current path value (roots when empty or when that request fails), lists entries, opens a folder on click, goes Up, and Select fills the path and closes.
- [ ] The rail lists Setup after Review and shows an element with `aria-label="setup needs attention"` when `doctorAlert` is true.
- [ ] On first load the app shows Setup when the repo list is empty or the doctor has a red item, else Board.
- [ ] Existing App tests still pass with `/api/doctor` mocked.

**Verify:** `pnpm --filter @overseer/web test && pnpm --filter @overseer/web typecheck` → green

**Steps:**

- [ ] **Step 1: Write the failing dialog test**

`packages/web/src/components/BrowseDialog.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowseDialog, parentOf } from './BrowseDialog';
import { mockApi } from '../test/setup';

describe('BrowseDialog', () => {
  it('computes parents', () => {
    expect(parentOf('E:\\Projects\\demo')).toBe('E:\\Projects');
    expect(parentOf('E:\\Projects')).toBe('E:\\');
    expect(parentOf('E:\\')).toBeNull();
    expect(parentOf('/home/x')).toBe('/home');
    expect(parentOf('/home')).toBeNull();
  });
  it('starts at the parent, navigates and selects', async () => {
    const urls: string[] = [];
    mockApi((_m, url) => {
      urls.push(url);
      if (url === '/api/fs/browse') return { path: null, parent: null, entries: [{ name: 'E:', path: 'E:\\', is_git_repo: false }] };
      const p = decodeURIComponent(url.split('?path=')[1] ?? '');
      if (p === 'E:\\Projects') return { path: 'E:\\Projects', parent: 'E:\\', entries: [{ name: 'demo', path: 'E:\\Projects\\demo', is_git_repo: true }, { name: 'plain', path: 'E:\\Projects\\plain', is_git_repo: false }] };
      if (p === 'E:\\Projects\\plain') return { path: 'E:\\Projects\\plain', parent: 'E:\\Projects', entries: [] };
      if (p === 'E:\\') return { path: 'E:\\', parent: null, entries: [{ name: 'Projects', path: 'E:\\Projects', is_git_repo: false }] };
      throw Object.assign(new Error('cannot read ' + p), { status: 400 });
    });
    let picked = '';
    render(<BrowseDialog initialPath={'E:\\Projects\\demo'} onPick={(p) => { picked = p; }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('E:\\Projects')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Select' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'plain' }));
    await waitFor(() => expect(screen.getByText('E:\\Projects\\plain')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(() => expect(screen.getByText('E:\\Projects')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(picked).toBe('E:\\Projects\\demo');
  });
  it('falls back to the roots when the start folder cannot be read', async () => {
    mockApi((_m, url) => {
      if (url === '/api/fs/browse') return { path: null, parent: null, entries: [{ name: 'C:', path: 'C:\\', is_git_repo: false }] };
      throw Object.assign(new Error('cannot read'), { status: 400 });
    });
    render(<BrowseDialog initialPath={'Z:\\nope\\x'} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'C:' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Up' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

Run: `pnpm --filter @overseer/web test -- BrowseDialog` → FAIL.

- [ ] **Step 2: Implement the dialog**

`packages/web/src/components/BrowseDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { BrowseResponse } from '@overseer/shared';
import { api } from '../api';

export function parentOf(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (i <= 0) return null;
  const parent = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

const url = (path: string | null) => (path ? `/fs/browse?path=${encodeURIComponent(path)}` : '/fs/browse');

export function BrowseDialog(p: { initialPath: string; onPick: (path: string) => void; onClose: () => void }) {
  const [state, setState] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = (path: string | null) => {
    setError(null);
    return api.get<BrowseResponse>(url(path)).then(setState).catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    const start = p.initialPath.trim() ? parentOf(p.initialPath.trim()) : null;
    api.get<BrowseResponse>(url(start)).then(setState).catch(() => open(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dialog-backdrop" onClick={p.onClose}>
      <div className="dialog" role="dialog" aria-label="Browse folders" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <button disabled={!state || state.path === null} onClick={() => void open(state?.parent ?? null)}>Up</button>
          <span className="dialog-path">{state?.path ?? 'Drives'}</span>
          <button onClick={p.onClose}>Close</button>
        </div>
        {error && <div className="badge-warn">{error}</div>}
        <ul className="browse-list">
          {state?.entries.map((e) => (
            <li key={e.path}>
              <button className="link" onClick={() => void open(e.path)}>{e.name}</button>
              {e.is_git_repo && <button onClick={() => p.onPick(e.path)}>Select</button>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

If the project has no eslint react-hooks rule, drop the disable comment.

Append to `packages/web/src/styles.css`:

```css
.dot-warn { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); margin-left: 6px; }
.dialog-backdrop { position: fixed; inset: 0; background: #0006; display: flex; align-items: center; justify-content: center; }
.dialog { background: Canvas; color: CanvasText; border: 1px solid var(--border); border-radius: 6px; padding: 12px; width: 520px; max-width: 90vw; max-height: 70vh; display: flex; flex-direction: column; gap: 8px; }
.dialog-head { display: flex; gap: 8px; align-items: center; }
.dialog-path { flex: 1; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browse-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.browse-list li { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; }
```

Run: `pnpm --filter @overseer/web test -- BrowseDialog` → PASS.

- [ ] **Step 3: Browse button in the form**

`packages/web/src/components/RepoForm.tsx`: add `import { BrowseDialog } from './BrowseDialog';`, a state `const [browsing, setBrowsing] = useState(false);`, and change the Path label to:

```tsx
        <label>Path
          <div className="path-row">
            <input aria-label="Path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="E:\Projects\my-repo" />
            <button type="button" onClick={() => setBrowsing(true)}>Browse</button>
          </div>
          {inspect && (inspect.problems.length === 0
            ? <div className="ok">git repository on branch {inspect.branch}</div>
            : <div className="badge-warn">{inspect.problems.join('; ')}</div>)}
        </label>
```

and render, just before the closing `</div>` of `.repo-form`:

```tsx
      {browsing && <BrowseDialog initialPath={path} onPick={(picked) => { setPath(picked); setBrowsing(false); }} onClose={() => setBrowsing(false)} />}
```

Add `.path-row { display: flex; gap: 8px; } .path-row input { flex: 1; }` to the stylesheet.

- [ ] **Step 4: Write the failing App tests**

In `packages/web/src/App.test.tsx`: import `doctorOk, doctorBad` from fixtures; add `if (url.endsWith('/api/doctor')) return doctorOk;` to the mock in every existing test; append:

```tsx
  it('opens Setup when no repo is registered', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.endsWith('/api/chat')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeTruthy());
    expect(screen.queryByLabelText('setup needs attention')).toBeNull();
  });

  it('opens Setup and marks the rail when a required tool is missing', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorBad;
      if (url.endsWith('/api/board')) return board;
      if (url.endsWith('/api/chat')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeTruthy());
    expect(screen.getByLabelText('setup needs attention')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
  });
```

Run: `pnpm --filter @overseer/web test -- App` → FAIL.

- [ ] **Step 5: Rail and App**

`packages/web/src/components/Rail.tsx`:

```tsx
import type { Repo, StatusResponse } from '@overseer/shared';

export type View = 'board' | 'chat' | 'review' | 'setup';

export function Rail(p: { repos: Repo[]; status: StatusResponse | null; view: View; onView: (v: View) => void; setupAlert: boolean }) {
  const views: View[] = ['board', 'chat', 'review', 'setup'];
  return (
    <nav className="rail">
      <h1>Overseer</h1>
      <div className="rail-views">
        {views.map((v) => (
          <button key={v} className={v === p.view ? 'active' : ''} onClick={() => p.onView(v)}>
            {v[0]!.toUpperCase() + v.slice(1)}
            {v === 'setup' && p.setupAlert && <span className="dot-warn" aria-label="setup needs attention" />}
          </button>
        ))}
      </div>
      <h2>Repos</h2>
      <ul>{p.repos.map((r) => <li key={r.id} title={r.path}>{r.id}</li>)}</ul>
      <div className="rail-status">
        <div>orchestrator: {p.status?.orchestrator.status ?? '…'}</div>
        {p.status && !p.status.bd_ok && <div className="badge-warn">bd unavailable</div>}
      </div>
    </nav>
  );
}
```

`packages/web/src/App.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DoctorResponse, Repo, StatusResponse, WsMessage } from '@overseer/shared';
import { api, useWs } from './api';
import { Rail, type View } from './components/Rail';
import { Board } from './views/Board';
import { Chat } from './views/Chat';
import { Review } from './views/Review';
import { Setup, doctorAlert } from './views/Setup';

export function App() {
  const [view, setView] = useState<View>('board');
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [boardVersion, setBoardVersion] = useState(0);
  const [chatVersion, setChatVersion] = useState(0);
  const [reviewTask, setReviewTask] = useState<string | null>(null);
  const decided = useRef(false);

  const loadRepos = useCallback(() => { void api.get<Repo[]>('/repos').then(setRepos); }, []);
  const loadStatus = useCallback(() => { void api.get<StatusResponse>('/status').then(setStatus); }, []);
  const loadDoctor = useCallback(() => { void api.get<DoctorResponse>('/doctor').then(setDoctor); }, []);
  useEffect(() => { loadRepos(); loadStatus(); loadDoctor(); }, [loadRepos, loadStatus, loadDoctor]);
  useEffect(() => {
    if (decided.current || repos === null || doctor === null) return;
    decided.current = true;
    if (repos.length === 0 || doctorAlert(doctor)) setView('setup');
  }, [repos, doctor]);
  useWs((m: WsMessage) => {
    if (m.type === 'board') setBoardVersion((v) => v + 1);
    if (m.type === 'chat') setChatVersion((v) => v + 1);
    if (m.type === 'status') loadStatus();
    if (m.type === 'repos') loadRepos();
  });

  const list = repos ?? [];
  return (
    <div className="app">
      <Rail repos={list} status={status} view={view} onView={setView} setupAlert={doctorAlert(doctor)} />
      <main>
        {view === 'board' && <Board version={boardVersion} onOpenReview={(id) => { setReviewTask(id); setView('review'); }} />}
        {view === 'chat' && <Chat version={chatVersion} repos={list} />}
        {view === 'review' && <Review version={boardVersion} selected={reviewTask} onSelect={setReviewTask} />}
        {view === 'setup' && <Setup repos={list} doctor={doctor} onRefreshDoctor={loadDoctor} onReposChanged={loadRepos} />}
      </main>
    </div>
  );
}
```

Run: `pnpm --filter @overseer/web test` → all PASS. `pnpm --filter @overseer/web typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/BrowseDialog.tsx packages/web/src/components/BrowseDialog.test.tsx packages/web/src/components/RepoForm.tsx packages/web/src/components/Rail.tsx packages/web/src/App.tsx packages/web/src/App.test.tsx packages/web/src/styles.css
git commit -m "Add the folder browse dialog and open Setup when the dashboard needs it"
```

---

### Task 7: README and CLAUDE.md

**Goal:** The docs describe the command-free flow and the smoke script uses the dashboard.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] README "First use" has no `bd init` and no curl in its numbered steps; it explains stealth mode and the commit checkbox; the curl example lives under a new "Scripting the API" subsection that also lists PATCH and DELETE.
- [ ] README "How it works" State bullet mentions that the daemon initialises beads.
- [ ] CLAUDE.md smoke step 1 has no `bd init`; step 3 registers through Setup and checks `git status --porcelain --ignored` shows `!! .beads/`; the Windows variant no longer says `bd init` commits files.
- [ ] CLAUDE.md Layout lists `src/doctor/` and `src/fs/`.

**Verify:** `grep -n "bd init" README.md CLAUDE.md` → only the "Scripting the API" note and the stealth explanation mention it, never as a step the user runs.

**Steps:**

- [ ] **Step 1: README**

Replace the "First use" section with:

```markdown
## First use

1. Run `pnpm dev` and open http://127.0.0.1:5173. The dashboard opens on Setup until a repository is registered.
2. Under Prerequisites, fix anything shown in red. Each missing tool lists the install command; nothing is installed for you.
3. Under Add repository, click Browse and pick the root folder of a git repository (or type its path). The form checks the folder as you go and fills in the id and base branch. Set a verify command if you want each worker's result tested, then click Add.
4. Overseer initialises beads in that repository itself. By default this is stealth mode: `.beads/` is created and added to `.git/info/exclude`, nothing is committed and no `AGENTS.md` is written, so teammates who do not use Overseer see nothing. Tick "My team uses beads: commit its files" only for repositories that have adopted beads.
5. In Chat, select the repo and describe what you want. The orchestrator creates beads, dispatches workers, and reports back. Cards move across the Board: Ready, Blocked, Running, Verifying, Review, Done.
6. In Review, read the diff, the verification output and the orchestrator's note, then Merge or Reject with a note. A rejected task returns to Ready with the note and the orchestrator re-dispatches it.

Edit or remove a repository under Setup at any time. Removing deletes its worktrees and forgets it; the repository and its `.beads/` stay untouched.

The full manual smoke script, including the crash-recovery check, is in `CLAUDE.md`.

### Scripting the API

Everything Setup does is plain REST on the daemon:

```bash
curl -s http://127.0.0.1:4400/api/doctor
curl -s -X POST http://127.0.0.1:4400/api/repos -H 'content-type: application/json' \
  -d '{"path":"/path/to/repo","id":"myrepo","verify_command":"pnpm test","beads":"stealth"}'
curl -s -X PATCH http://127.0.0.1:4400/api/repos/myrepo -H 'content-type: application/json' -d '{"worker_limit":3}'
curl -s -X DELETE http://127.0.0.1:4400/api/repos/myrepo
```

`beads` is `stealth` (default) or `commit` and only matters when the repository has no `.beads/` yet. `verify_command` runs in the worker's worktree after the worker finishes; on Windows it runs through `cmd.exe`.
```

In "How it works", change the State bullet to:

```markdown
- **State.** beads owns the work (status, dependencies, `overseer:*` phase labels, `harness:*` labels); the daemon initialises it in each repository (`bd init --stealth` unless you opt into committing). SQLite owns the machinery (repos, sessions, worktrees, events, chat). The daemon is the only writer of bead status.
```

- [ ] **Step 2: CLAUDE.md**

Layout: add under `packages/daemon`:

```markdown
  - `src/doctor/doctor.ts` — prerequisite checks behind `GET /api/doctor`; `src/fs/` — folder browse and repo inspect behind the Setup view. `POST /api/repos` runs `bd init --stealth --non-interactive` itself when `.beads` is missing.
```

Smoke script step 1:

```markdown
1. Make a throwaway repo:
   ```bash
   mkdir /tmp/ov-demo && cd /tmp/ov-demo && git init -b main
   echo "# demo" > README.md && git add . && git commit -m init
   ```
```

Step 3:

```markdown
3. Register the repo in the dashboard: Setup → Add repository → Browse to `/tmp/ov-demo` → Select. Set verify command `test -f hello.txt` and click Add (leave the beads checkbox unchecked).
   Expect: the repo in the rail, an empty six-column row on the Board, and `git -C /tmp/ov-demo status --porcelain --ignored` showing `!! .beads/` with no new commit.
```

Windows variant: replace the first bullet with:

```markdown
- Repo at `C:/tmp/ov-demo`; step 1 as above in PowerShell (`"# demo" | Set-Content README.md`). Registration through Setup (or `POST /api/repos`) initialises beads in stealth mode; `git status --porcelain --ignored` shows `!! .beads/` and the log still has one commit.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document command-free setup and the stealth beads default"
```

---

### Task 8: Live check against real bd through the daemon

**Goal:** Prove with the real `bd` 1.2.2 on this machine that registering a fresh repo through the daemon leaves `.beads/` excluded and uncommitted, and that remove cleans up.

**Files:**
- None modified. Findings go in the task report; a defect found here becomes a fix commit in the file it belongs to.

**Acceptance Criteria:**
- [ ] `GET /api/doctor` reports git, bd and claude with `ok: true`.
- [ ] `POST /api/repos` for a fresh temp repo returns 200; afterwards `git status --porcelain --ignored` in that repo prints exactly `!! .beads/`, `git log --oneline | wc -l` is 1, and no `AGENTS.md` exists.
- [ ] `GET /api/fs/browse?path=<temp parent>` lists the repo with `is_git_repo: true`.
- [ ] `DELETE /api/repos/<id>` returns `{ ok: true, warnings: [] }` and the repo folder still contains `.beads/`.

**Verify:** the PowerShell transcript below, pasted into the report

**Steps:**

- [ ] **Step 1: Start the daemon on a scratch data dir**

In PowerShell from the repo root (background job so the shell stays usable):

```powershell
$env:OVERSEER_DATA_DIR = Join-Path $env:TEMP "ov-live-data"
$job = Start-Job -ScriptBlock { param($root) Set-Location $root; pnpm --filter @overseer/daemon start 2>&1 } -ArgumentList (Get-Location).Path
Start-Sleep -Seconds 6
Invoke-RestMethod http://127.0.0.1:4400/api/health
```

- [ ] **Step 2: Doctor, repo, browse, register, inspect the repo, delete**

```powershell
(Invoke-RestMethod http://127.0.0.1:4400/api/doctor).tools | Format-Table name, required, ok, version
$S = Join-Path $env:TEMP "ov-live-repo"; if (Test-Path $S) { Remove-Item -Recurse -Force $S }
New-Item -ItemType Directory $S | Out-Null; Set-Location $S; git init -q -b main .; "x" | Set-Content a.txt; git add a.txt; git commit -qm init
(Invoke-RestMethod ("http://127.0.0.1:4400/api/fs/browse?path=" + [uri]::EscapeDataString($env:TEMP))).entries | Where-Object name -eq 'ov-live-repo'
Invoke-RestMethod -Method Post -ContentType 'application/json' http://127.0.0.1:4400/api/repos -Body (@{ path = $S; id = 'live' } | ConvertTo-Json)
git status --porcelain --ignored
git log --oneline
Test-Path AGENTS.md
Get-Content .git/info/exclude | Select-String beads
Invoke-RestMethod -Method Delete http://127.0.0.1:4400/api/repos/live
Test-Path .beads
```

Expected: doctor rows git/bd/claude ok; browse entry `is_git_repo True`; POST returns the repo JSON with `base_branch main`; status prints `!! .beads/` only; log has one line; `Test-Path AGENTS.md` is False; the exclude file contains `.beads/`; DELETE returns `ok True` with empty warnings; `.beads` still exists.

- [ ] **Step 3: Stop the daemon and clean up**

```powershell
Set-Location $env:TEMP
Stop-Job $job; Remove-Job $job
Get-Process node | Where-Object { $_.CommandLine -like '*overseer*daemon*' } | Stop-Process -Force
Remove-Item -Recurse -Force (Join-Path $env:TEMP "ov-live-repo"), (Join-Path $env:TEMP "ov-live-data") -ErrorAction SilentlyContinue
```

If the repo folder refuses deletion once, wait a second and retry (antivirus lock).

- [ ] **Step 4: Report**

Paste the transcript into the task report. Any deviation from the expected output is a defect: fix it in the owning file with a test, commit, and rerun this task.
