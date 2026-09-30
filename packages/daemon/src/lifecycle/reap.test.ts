import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchStatus, Repo } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { ensureWorktree } from '../git/git';
import { mkTmpRepo } from '../test/tmpgit';
import { pidExists, processRows } from '../util/procs';
import { log } from '../util/log';
import { until } from '../test/until';
import { withStubbedProcessTable } from '../test/procTableStub';
import { reapEndedSession, reapLeftoverFolders, reapOrphans, startReaper, type ReapDeps } from './reap';

const slashed = (p: string) => p.split(path.sep).join('/').toLowerCase();

vi.mock('node:child_process', async (orig) => (await import('../test/procTableStub')).stubbableChildProcess(await orig()));

// Every stand-in runs under a fresh temp data dir, and every pass asserts it reaped only stand-ins, so no real process is touched.
describe('orphan reaper', () => {
  let dataDir: string;
  let worktreesDir: string;
  let db: Db;
  let kids: ChildProcess[];
  let orphans: number[];
  let deps: ReapDeps;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-reap-'));
    worktreesDir = path.join(dataDir, 'worktrees');
    db = openDb(':memory:');
    kids = [];
    orphans = [];
    // The test runner is not the daemon here: its children are the stand-ins, and the daemon's descendants are spared.
    deps = { db, worktreesDir, keepPaths: [], selfPid: -1 };
  });

  afterEach(async () => {
    for (const pid of orphans) if (pidExists(pid)) process.kill(pid);
    await until(() => orphans.every((pid) => !pidExists(pid)), 15000, 'orphaned stand-ins to exit');
    await Promise.all(kids.map((k) => k.exitCode !== null || k.signalCode !== null ? null : new Promise((r) => { k.once('exit', r); k.kill(); })));
    // A killed stand-in's pid goes before Windows releases the cwd handle on its worktree, so wait for the removal itself.
    await until(() => {
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; }
      catch { return false; }
    }, 30000, 'the temp data dir to be removable');
  });

  const STAND_IN = ['-e', 'setInterval(() => {}, 1000)'];

  /**
   * A long-running node process with its cwd in `dir` and the path on its command line, as a worker's dev server has.
   * Its parent exits at once, so it is an orphan like one a crashed daemon's worker leaves behind.
   */
  function standIn(dir: string): number {
    fs.mkdirSync(dir, { recursive: true });
    const launch = `const c = require('child_process').spawn(process.execPath, ${JSON.stringify([...STAND_IN, dir])}, { cwd: ${JSON.stringify(dir)}, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid);`;
    const pid = Number(spawnSync(process.execPath, ['-e', launch], { encoding: 'utf8', windowsHide: true }).stdout.trim());
    expect(pid).toBeGreaterThan(0);
    orphans.push(pid);
    return pid;
  }

  function session(cwd: string, id = 's1'): void {
    db.sessions.insert({
      id, harness: 'codex', role: 'worker', bead_id: 'ov-1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null,
      start_commit: null, cwd, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null, batch_id: null,
      log_path: null, log_offset: 0, tier: 'standard', model: 'gpt-5.6-terra',
    });
  }

  /** Every end path reaches `SessionManager.finish`, which flips the row to ended before `session:ended` fires. */
  function endSession(id = 's1'): void {
    db.sessions.update(id, { status: 'ended', ended_at: new Date().toISOString(), pid: null });
  }

  /**
   * A long-running node process in `dir` that starts one child there and stays alive; both outlive their launcher, as a
   * dev server and its helper do. `dir` is passed as its own argument so the parent's command line names the worktree
   * with plain separators, the way `worktreeOf` reads it.
   */
  async function standInTree(dir: string): Promise<{ root: number; child: number }> {
    fs.mkdirSync(dir, { recursive: true });
    const parent = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[1]], { stdio: 'ignore', windowsHide: true }).unref(); setInterval(() => {}, 1000);`;
    const launch = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(parent)}, ${JSON.stringify(dir)}], { cwd: ${JSON.stringify(dir)}, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid);`;
    const root = Number(spawnSync(process.execPath, ['-e', launch], { encoding: 'utf8', windowsHide: true }).stdout.trim());
    expect(root).toBeGreaterThan(0);
    orphans.push(root);
    let child = 0;
    await until(async () => { child = (await processRows()).find((r) => r.ppid === root && r.cmd?.includes('setInterval'))?.pid ?? 0; return child > 0; }, 15000, 'stand-in child started');
    orphans.push(child);
    return { root, child };
  }

  async function reap(d: ReapDeps = deps): Promise<number[]> {
    const pids = (await reapOrphans(d)).map((r) => r.pid);
    const ours = new Set([...orphans, ...kids.map((k) => k.pid)]);
    expect(pids.every((p) => ours.has(p))).toBe(true);
    return pids;
  }

  it('kills a process in a worktree that has no running session', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    const pid = standIn(wt);
    const reaped = await reapOrphans(deps);
    expect(reaped.map((r) => r.pid)).toEqual([pid]);
    expect(reaped[0]?.worktree.toLowerCase()).toBe(slashed(wt));
    await until(() => !pidExists(pid), 15000, 'stand-in to die');
  });

  it('leaves a process alone while its worktree has a running session', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    session(wt);
    const pid = standIn(wt);
    expect(await reap()).toEqual([]);
    expect(pidExists(pid)).toBe(true);
  });

  it('leaves a process alone whose live parent names no worktree, as an editor or shell the user opened there', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    fs.mkdirSync(wt, { recursive: true });
    // The parent stays alive and its own command line names no worktree, like Explorer or a terminal.
    const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ${JSON.stringify([...STAND_IN, wt])}, { cwd: ${JSON.stringify(wt)}, stdio: 'ignore' }); setInterval(() => {}, 1000)`], { stdio: 'ignore', windowsHide: true });
    kids.push(parent);
    let child = 0;
    await until(async () => { child = (await processRows()).find((r) => r.ppid === parent.pid && r.cmd?.includes('setInterval'))?.pid ?? 0; return child > 0; }, 15000, 'stand-in started by the parent');
    orphans.push(child); // the parent's kill does not take the child with it on Windows
    expect(await reap()).toEqual([]);
    expect(pidExists(child)).toBe(true);
  });

  it('never touches a primary checkout, the base worktree, the daemon or what the daemon started', async () => {
    const primary = path.join(worktreesDir, 'r1', 'main');
    db.repos.insert({ id: 'r1', path: primary, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 2 });
    const inPrimary = standIn(primary);
    const inSource = standIn(path.join(worktreesDir, 'overseer', 'src-root'));
    const inBase = standIn(path.join(worktreesDir, 'r1', 'base'));
    // The daemon stand-in names an orphaned worktree on its command line, and so does a process it started.
    const orphan = path.join(worktreesDir, 'r1', 'ov-2');
    fs.mkdirSync(orphan, { recursive: true });
    const daemon = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(orphan)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`, orphan], { stdio: 'ignore', windowsHide: true });
    kids.push(daemon);
    let child = 0;
    await until(async () => { child = (await processRows()).find((r) => r.ppid === daemon.pid && r.cmd?.includes('setInterval'))?.pid ?? 0; return child > 0; }, 15000, "the daemon stand-in's child started");
    orphans.push(child); // the daemon stand-in's kill does not take the child with it on Windows
    expect(await reap({ ...deps, keepPaths: [path.join(worktreesDir, 'overseer', 'src-root')], selfPid: daemon.pid })).toEqual([]);
    for (const pid of [inPrimary, inSource, inBase, daemon.pid!]) expect(pidExists(pid)).toBe(true);
    // The daemon stand-in's own child names the orphaned worktree too and is spared as a descendant.
    expect(child && pidExists(child)).toBe(true);
  });

  it('stops a process left in a bead worktree when its session ends', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    session(wt);
    const pid = standIn(wt);
    endSession();
    const reaped = await reapEndedSession(deps, wt);
    expect(reaped.map((r) => r.pid)).toEqual([pid]);
    expect(reaped[0]?.worktree.toLowerCase()).toBe(slashed(wt));
    await until(() => !pidExists(pid), 15000, 'leftover stand-in to die');
  });

  it('spares a daemon bd call quoting the ended worktree and stops a descendant server running there', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    const bdPid = 9_100_001;
    const serverPid = 9_100_002;
    const cliPid = 9_100_003;
    const daemonPid = 9_100_000;
    const worktrees = new Map<number, string>([
      [bdPid, dataDir],
      [cliPid, dataDir],
      [serverPid, wt],
    ]);
    session(wt);
    endSession();
    const rows = [
      { pid: daemonPid, ppid: 1, created: null, cmd: 'node daemon.js' },
      { pid: bdPid, ppid: 9_100_000, created: null, cmd: `"C:\\Program Files\\nodejs\\node.exe" C:\\Workspace\\dev\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js update x --append-notes "Verification incomplete: [schema.ts](${wt}\\packages\\daemon\\src\\db\\schema.ts:5)" --json` },
      { pid: cliPid, ppid: daemonPid, created: null, cmd: '"C:\\Program Files\\OpenAI\\Codex\\codex.exe" exec' },
      { pid: serverPid, ppid: cliPid, created: null, cmd: '"C:\\Program Files\\nodejs\\node.exe" node_modules\\vite\\bin\\vite.js' },
    ];
    const killed: number[] = [];

    const reaped = await reapEndedSession({
      ...deps,
      selfPid: daemonPid,
      processRows: async () => rows,
      cwdOf: (pid) => worktrees.get(pid) ?? '',
      killProcess: async (pid) => { killed.push(pid); },
    }, wt);

    expect(reaped.map((r) => r.pid)).toEqual([serverPid]);
    expect(killed).toEqual([serverPid]);
  });

  it('spares a daemon git command whose -C argument names another worktree', async () => {
    const ended = path.join(worktreesDir, 'r1', 'ov-1');
    const other = path.join(worktreesDir, 'r1', 'ov-2');
    const daemonPid = 9_110_000;
    const gitPid = 9_110_001;
    session(ended);
    endSession();
    const rows = [
      { pid: daemonPid, ppid: 1, created: null, cmd: 'node daemon.js' },
      { pid: gitPid, ppid: daemonPid, created: null, cmd: `"C:\\Program Files\\Git\\cmd\\git.exe" -C "${other}" status --short` },
    ];
    const killed: number[] = [];

    const reaped = await reapEndedSession({
      ...deps,
      selfPid: daemonPid,
      processRows: async () => rows,
      cwdOf: () => dataDir,
      killProcess: async (pid) => { killed.push(pid); },
    }, ended);

    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('stops a daemon descendant whose executable is inside the ended worktree', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    const daemonPid = 9_120_000;
    const serverPid = 9_120_001;
    session(wt);
    endSession();
    const rows = [
      { pid: daemonPid, ppid: 1, created: null, cmd: 'node daemon.js' },
      { pid: serverPid, ppid: daemonPid, created: null, cmd: `"${path.join(wt, 'server.exe')}" --serve` },
    ];
    const killed: number[] = [];

    const reaped = await reapEndedSession({
      ...deps,
      selfPid: daemonPid,
      processRows: async () => rows,
      cwdOf: () => dataDir,
      killProcess: async (pid) => { killed.push(pid); },
    }, wt);

    expect(reaped.map((r) => r.pid)).toEqual([serverPid]);
    expect(killed).toEqual([serverPid]);
  });

  it('finds a daemon descendant by its cwd when its executable and arguments are outside the worktree', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    const daemonPid = 9_130_000;
    fs.mkdirSync(wt, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: wt, stdio: 'ignore', windowsHide: true });
    kids.push(child);
    expect(child.pid).toBeGreaterThan(0);
    session(wt);
    endSession();
    const rows = [
      { pid: daemonPid, ppid: 1, created: null, cmd: 'node daemon.js' },
      { pid: child.pid!, ppid: daemonPid, created: null, cmd: `"${process.execPath}" -e setInterval` },
    ];
    const killed: number[] = [];

    const reaped = await reapEndedSession({
      ...deps,
      selfPid: daemonPid,
      processRows: async () => rows,
      killProcess: async (pid) => { killed.push(pid); },
    }, wt);

    expect(reaped.map((r) => r.pid)).toEqual([child.pid]);
    expect(killed).toEqual([child.pid]);
  });

  it('stops the children with the process it stops', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    session(wt);
    const { root, child } = await standInTree(wt);
    endSession();
    const reaped = await reapEndedSession(deps, wt);
    expect(reaped.map((r) => r.pid)).toContain(root);
    await until(() => !pidExists(root) && !pidExists(child), 15000, 'stand-in and its child to die');
  });

  it("never touches a process in another still-running session's worktree", async () => {
    const ended = path.join(worktreesDir, 'r1', 'ov-1');
    const other = path.join(worktreesDir, 'r1', 'ov-2');
    session(ended, 's1');
    session(other, 's2');
    const stopped = standIn(ended);
    const kept = standIn(other);
    endSession('s1');
    const reaped = await reapEndedSession(deps, ended);
    expect(reaped.map((r) => r.pid)).toEqual([stopped]);
    await until(() => !pidExists(stopped), 15000, 'leftover stand-in to die');
    expect(pidExists(kept)).toBe(true);
  });

  it('stops nothing and says nothing when the ended session left nothing behind', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    session(wt);
    endSession();
    const notify = vi.fn();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      expect(await reapEndedSession(deps, wt, { notify })).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      expect(warn.mock.calls.filter(([m]) => String(m).startsWith('reaper:'))).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it('stops a server whose live parent names no worktree once its session ends', async () => {
    const wt = path.join(worktreesDir, 'r1', 'ov-1');
    session(wt);
    fs.mkdirSync(wt, { recursive: true });
    // The parent stays alive and names no worktree, as the worker's shell or CLI does; the periodic guard spares this.
    const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ${JSON.stringify([...STAND_IN, wt])}, { cwd: ${JSON.stringify(wt)}, stdio: 'ignore' }); setInterval(() => {}, 1000)`], { stdio: 'ignore', windowsHide: true });
    kids.push(parent);
    let child = 0;
    await until(async () => { child = (await processRows()).find((r) => r.ppid === parent.pid && r.cmd?.includes('setInterval'))?.pid ?? 0; return child > 0; }, 15000, 'stand-in started by the parent');
    orphans.push(child);
    endSession();
    expect(await reap()).toEqual([]); // the periodic pass still spares it: its live parent names no worktree
    const reaped = await reapEndedSession(deps, wt);
    expect(reaped.map((r) => r.pid)).toEqual([child]);
    await until(() => !pidExists(child), 15000, 'stand-in to die');
  });

  it('runs its first pass at startup', async () => {
    const pid = standIn(path.join(worktreesDir, 'r1', 'ov-1'));
    const stop = startReaper({ ...deps, intervalMs: 60 * 60_000 });
    try { await until(() => !pidExists(pid), 15000, 'stand-in reaped at startup'); } finally { stop?.(); }
    expect(startReaper({ ...deps, intervalMs: 0 })).toBeNull();
  });
});

describe('leftover worktree folders', () => {
  const ISO = '2026-09-18T00:00:00.000Z';
  let root: string;
  let worktreesDir: string;
  let repo: Repo;
  let db: Db;
  let deps: ReapDeps;

  beforeEach(() => {
    const t = mkTmpRepo('ov-reap-folder-');
    root = path.dirname(t.path);
    worktreesDir = t.worktreesDir;
    repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 2, model_filter: null };
    db = openDb(':memory:');
    db.repos.insert(repo);
    deps = { db, worktreesDir, keepPaths: [], selfPid: -1 };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function addBatch(id: string, status: BatchStatus): void {
    db.batches.insert({ id, repo_id: 'r1', title: id, branch: `feature/${id}`, base_branch: 'main', status, note: null, history: null, mr_url: null, conflict_files: null, created_at: ISO, updated_at: ISO, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
  }

  function addWorktree(beadId: string, overrides: Partial<Parameters<Db['worktrees']['upsert']>[0]> = {}): void {
    db.worktrees.upsert({ bead_id: beadId, repo_id: 'r1', path: path.join(worktreesDir, 'r1', beadId), branch: `bead/${beadId}`, base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, ...overrides });
  }

  function runningSession(cwd: string): void {
    db.sessions.insert({ id: 's1', harness: 'codex', role: 'worker', bead_id: 'ov-1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd, status: 'running', started_at: ISO, ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: 'standard', model: 'gpt-5.6-terra' });
  }

  /** A folder under the repo's worktrees dir that git does not list, holding one file so its size is not zero. */
  function leftover(name: string, mtime?: Date): string {
    const dir = path.join(worktreesDir, 'r1', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1000));
    if (mtime) fs.utimesSync(dir, mtime, mtime);
    return dir;
  }

  it('removes a merged batch folder git no longer lists', async () => {
    addBatch('r1-b2', 'merged');
    const dir = leftover('b2');
    expect(await reapLeftoverFolders(deps)).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes an abandoned batch folder git no longer lists', async () => {
    addBatch('r1-b3', 'abandoned');
    const dir = leftover('b3');
    expect(await reapLeftoverFolders(deps)).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes a folder whose worktree row is closed or merged', async () => {
    addWorktree('ov-1', { closed_at: ISO });
    addWorktree('ov-2', { merged_at: ISO });
    const closed = leftover('ov-1');
    const merged = leftover('ov-2');
    expect((await reapLeftoverFolders(deps)).sort()).toEqual([closed, merged].sort());
    expect(fs.existsSync(closed)).toBe(false);
    expect(fs.existsSync(merged)).toBe(false);
  });

  it('keeps a folder git still lists', async () => {
    const wt = await ensureWorktree(repo, 'ov-1', worktreesDir);
    addWorktree('ov-1', { path: wt.path, branch: wt.branch, merged_at: ISO });
    expect(await reapLeftoverFolders(deps)).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('keeps a folder with a running session', async () => {
    addBatch('r1-b2', 'merged');
    const dir = leftover('b2');
    runningSession(dir);
    expect(await reapLeftoverFolders(deps)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('refuses a leftover folder outside the worktrees dir', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'x'), { recursive: true });
    // A repo id that escapes its own directory is the only way git-unlisted dirs are found outside worktreesDir.
    db.repos.delete('r1');
    db.repos.insert({ ...repo, id: '../outside' });
    expect(await reapLeftoverFolders(deps)).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'x'))).toBe(true);
  });

  it('keeps an unlisted folder with no row that is younger than a day', async () => {
    const dir = leftover('ov-9');
    expect(await reapLeftoverFolders(deps)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes an unlisted folder with no row that is older than a day', async () => {
    const dir = leftover('ov-9', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    expect(await reapLeftoverFolders(deps)).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps an open batch folder that is not git-listed', async () => {
    addBatch('r1-b2', 'open');
    const dir = leftover('b2');
    expect(await reapLeftoverFolders(deps)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('retries a removal that fails with EBUSY', async () => {
    addBatch('r1-b2', 'merged');
    const dir = leftover('b2');
    const real = fs.rmSync;
    let attempts = 0;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, opts?: fs.RmDirOptions) => {
      if (path.resolve(String(p)) === path.resolve(dir) && attempts++ === 0) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return real(p, opts);
    }) as typeof fs.rmSync);
    try {
      expect(await reapLeftoverFolders(deps)).toEqual([dir]);
      expect(fs.existsSync(dir)).toBe(false);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('removes a leftover folder during the periodic orphan pass', withStubbedProcessTable(async () => {
    addBatch('r1-b2', 'merged');
    const dir = leftover('b2');
    await reapOrphans(deps);
    expect(fs.existsSync(dir)).toBe(false);
  }));
});
