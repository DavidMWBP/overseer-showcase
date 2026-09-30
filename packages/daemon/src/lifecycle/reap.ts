import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import type { Db } from '../db/db';
import { removeWorktreeRetry } from '../git/git';
import { deregisteredWorktrees, dirBytes, formatBytes } from '../report/dayReport';
import { descendantsOf, killProcess, processRows, type ProcRow } from '../util/procs';
import { log } from '../util/log';

export interface ReapDeps {
  db: Db;
  worktreesDir: string;
  /** Checkouts never reaped besides the repos' own paths: the daemon's source root. */
  keepPaths: string[];
  /** The daemon's pid; on a periodic pass it, its ancestors and its descendants are never reaped. Defaults to this process. */
  selfPid?: number;
  /** Process seams keep reaper tests on a synthetic table and prevent signals to live processes. */
  processRows?: () => Promise<ProcRow[]>;
  cwdOf?: (pid: number) => string;
  killProcess?: typeof killProcess;
}

export interface Reaped { pid: number; worktree: string; cmd: string }

export interface ReapEndedOpts {
  /** Called once when one or more processes were stopped, with a line naming them, so a leak is visible rather than silent. */
  notify?: (text: string) => void;
}

interface ReapPassOpts {
  /** A worktree whose session just ended: candidates inside it are stopped even when a live ancestor names no worktree. */
  endedWorktree?: string;
}

const norm = (p: string) => {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const within = (a: string, b: string) => a === b || a.startsWith(b + '/');

/** Linux reports a process's working directory under /proc; elsewhere this is empty. */
function cwdOf(pid: number): string {
  if (process.platform !== 'linux') return '';
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; }
}

function executableOf(cmd?: string): string {
  const line = cmd?.trim() ?? '';
  return /^"([^"]+)"/.exec(line)?.[1] ?? /^(\S+)/.exec(line)?.[1] ?? '';
}

const WINDOWS_CWD_PS = String.raw`$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcessCwdReader {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicInfo {
    public int ExitStatus;
    public IntPtr PebBaseAddress;
    public IntPtr AffinityMask;
    public int BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  private static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref BasicInfo info, uint size, out uint returned);
  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
  private static extern int NtQueryInformationProcessPointer(IntPtr process, int infoClass, out IntPtr info, uint size, out uint returned);

  private static byte[] Read(IntPtr process, IntPtr address, int size) {
    byte[] bytes = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(process, address, bytes, size, out read) || read.ToInt64() != size) return null;
    return bytes;
  }

  private static IntPtr Pointer(byte[] bytes, int offset, int pointerSize) {
    if (pointerSize == 8) return new IntPtr(BitConverter.ToInt64(bytes, offset));
    long value = BitConverter.ToUInt32(bytes, offset);
    return IntPtr.Size == 4 ? new IntPtr(unchecked((int)value)) : new IntPtr(value);
  }

  public static string Get(int pid) {
    IntPtr process = OpenProcess(0x0410, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      int pointerSize = IntPtr.Size;
      IntPtr peb;
      bool wow64 = false;
      if (IntPtr.Size == 8 && IsWow64Process(process, out wow64) && wow64) {
        uint returned;
        if (NtQueryInformationProcessPointer(process, 26, out peb, (uint)IntPtr.Size, out returned) != 0) return "";
        pointerSize = 4;
      } else {
        BasicInfo info = new BasicInfo();
        uint returned;
        if (NtQueryInformationProcess(process, 0, ref info, (uint)Marshal.SizeOf(typeof(BasicInfo)), out returned) != 0) return "";
        peb = info.PebBaseAddress;
      }
      if (peb == IntPtr.Zero) return "";

      int parametersOffset = pointerSize == 8 ? 0x20 : 0x10;
      byte[] parameterPointer = Read(process, IntPtr.Add(peb, parametersOffset), pointerSize);
      if (parameterPointer == null) return "";
      IntPtr parameters = Pointer(parameterPointer, 0, pointerSize);
      int directoryOffset = pointerSize == 8 ? 0x38 : 0x24;
      byte[] directory = Read(process, IntPtr.Add(parameters, directoryOffset), pointerSize == 8 ? 16 : 8);
      if (directory == null) return "";
      int length = BitConverter.ToUInt16(directory, 0);
      if (length == 0 || length > 65534 || (length & 1) != 0) return "";
      int bufferOffset = pointerSize == 8 ? 8 : 4;
      IntPtr buffer = Pointer(directory, bufferOffset, pointerSize);
      byte[] value = Read(process, buffer, length);
      return value == null ? "" : Encoding.Unicode.GetString(value);
    } catch { return ""; }
    finally { CloseHandle(process); }
  }
}
'@
Add-Type -TypeDefinition $source
$pids = $env:OVERSEER_CWD_PIDS | ConvertFrom-Json
foreach ($id in $pids) {
  $cwd = [ProcessCwdReader]::Get([int]$id)
  if ($cwd) { [Console]::Out.WriteLine($id.ToString() + [char]9 + $cwd) }
}`;

async function windowsCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (!pids.length) return cwds;
  const powershell = process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432
    ? path.join(process.env.WINDIR ?? 'C:\\Windows', 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell';
  const out = await new Promise<string>((resolve) => execFile(
    powershell,
    ['-NoProfile', '-Command', WINDOWS_CWD_PS],
    { windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, OVERSEER_CWD_PIDS: JSON.stringify(pids) } },
    (_err, stdout) => resolve(String(stdout ?? '')),
  ));
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\t(.*)$/);
    if (match?.[2]) cwds.set(Number(match[1]), match[2]);
  }
  return cwds;
}

/** The ancestors of `pid` in `rows`, nearest first. */
function ancestorsOf(rows: ProcRow[], pid: number): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const found: number[] = [];
  for (let r = byPid.get(pid); r && !found.includes(r.ppid) && r.ppid !== pid; r = byPid.get(r.ppid)) found.push(r.ppid);
  return found;
}

/**
 * The live parent of `r`, or undefined when it has none: a parent pid missing from `rows`, one that started after `r`
 * (Windows keeps a dead parent's pid, which may since be recycled), or pid 1, which adopts every POSIX orphan.
 */
function liveParent(byPid: Map<number, ProcRow>, r: ProcRow): ProcRow | undefined {
  const p = r.ppid > 1 ? byPid.get(r.ppid) : undefined;
  if (!p || p.pid === r.pid) return undefined;
  if (p.created !== null && r.created !== null && p.created > r.created) return undefined;
  return p;
}

/**
 * One pass: kills every process whose command line (or, on Linux, working directory) names a worktree
 * `<worktreesDir>/<repo>/<name>` that no running session uses. A crash or restart leaves such processes behind (a dev
 * server a worker started), which the sweep at a session's end never reaches. Never reaped: a process naming any
 * protected worktree (a running session's cwd, a repo's `base` worktree, anything inside or around a primary checkout
 * or `keepPaths`), the daemon itself and its ancestors. Its descendants (a setup, verify or probe command, a worker
 * being started) are spared on a periodic pass, where another candidate is killed only when every live ancestor is a
 * candidate too, so an editor or shell the user opened on a worktree path (its chain leads to
 * Explorer or a terminal, which name no worktree) is never touched, while an orphaned tree whose root lost its parent
 * in the crash is. An orphan tree with an intermediate that names no worktree (a bare `cmd.exe`) is spared as well;
 * that is the safe miss. With `endedWorktree` (a pass run the moment that worktree's session ends) only candidates in
 * that worktree are considered and the live-ancestor guard is not consulted. The daemon and its ancestors stay safe;
 * one of its descendants is a candidate only when its cwd or executable path is inside the ended worktree, and text
 * in its other arguments does not count. This still reaches a server whose parent chain was broken, whose surviving
 * ancestor names no worktree, or that remains below the CLI through the daemon when the server itself is in that
 * worktree. The ended session is the authority that the worktree is disposable. The process table comes from
 * `processRows`, the same listing `descendantPids` walks.
 */
async function reapPass(deps: ReapDeps, opts: ReapPassOpts = {}): Promise<Reaped[]> {
  const self = deps.selfPid ?? process.pid;
  const rows = await (deps.processRows ?? processRows)();
  const readCwd = deps.cwdOf ?? cwdOf;
  const stop = deps.killProcess ?? killProcess;
  const root = norm(deps.worktreesDir);
  const ended = opts.endedWorktree ?? null;
  const keep = [...deps.db.repos.all().map((r) => r.path), ...deps.keepPaths].map(norm);
  const busy = new Set(deps.db.sessions.running().map((s) => norm(s.cwd)));
  const selfRow = rows.find((r) => r.pid === self);
  const ancestors = new Set(ancestorsOf(rows, self));
  const descendants = new Set(descendantsOf(rows, self, selfRow?.created ?? undefined));
  const descendantCwds = new Map<number, string>();
  if (ended) {
    if (deps.cwdOf) for (const pid of descendants) descendantCwds.set(pid, deps.cwdOf(pid));
    else if (process.platform === 'win32') {
      for (const [pid, cwd] of await windowsCwds([...descendants])) descendantCwds.set(pid, cwd);
    } else for (const pid of descendants) descendantCwds.set(pid, cwdOf(pid));
  }
  const spared = new Set([self, ...ancestors, ...descendants]);
  const re = new RegExp(`${escape(root)}/([^/\\s"']+)/([^/\\s"']+)`, 'g');
  const protectedKey = (key: string, name: string) =>
    name === 'base' || [...busy].some((b) => within(b, key)) || keep.some((k) => within(k, key) || within(key, k));

  // The daemon and whatever it started are spared on a periodic pass. A session-end pass sees daemon descendants only
  // when their own cwd or executable path places them in the ended worktree.
  const worktreeOf = (r: ProcRow, spareSelf: boolean): string | null => {
    if (spareSelf && spared.has(r.pid)) return null;
    if (ended && (r.pid === self || ancestors.has(r.pid))) return null;
    const daemonDescendant = !!ended && descendants.has(r.pid);
    const cwd = daemonDescendant ? descendantCwds.get(r.pid) ?? '' : readCwd(r.pid);
    let text = daemonDescendant
      ? `${executableOf(r.cmd)} ${cwd}`
      : `${r.cmd ?? ''} ${cwd}`;
    text = text.replace(/\\/g, '/');
    if (process.platform === 'win32') text = text.toLowerCase();
    const keys = [...text.matchAll(re)].map((m) => ({ key: `${root}/${m[1]}/${m[2]}`, name: m[2] ?? '' }));
    if (!keys[0] || keys.some((k) => protectedKey(k.key, k.name))) return null;
    if (daemonDescendant) return keys.find((k) => k.key === ended)?.key ?? null;
    return keys[0].key;
  };
  const candidates = new Map<number, string>();
  for (const r of rows) {
    const w = worktreeOf(r, !ended);
    if (!w || (ended && w !== ended)) continue;
    candidates.set(r.pid, w);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const leftBehind = (r: ProcRow): boolean => {
    const seen = new Set([r.pid]);
    for (let p = liveParent(byPid, r); p; p = liveParent(byPid, p)) {
      if (seen.has(p.pid) || !candidates.has(p.pid)) return false;
      seen.add(p.pid);
    }
    return true;
  };

  const reaped: Reaped[] = [];
  for (const r of rows) {
    const worktree = candidates.get(r.pid);
    if (!worktree || (!ended && !leftBehind(r))) continue;
    log.warn(`reaper: killing pid ${r.pid} in ${worktree}, which has no running session: ${r.cmd ?? ''}`);
    await stop(r.pid, r.created ?? undefined);
    reaped.push({ pid: r.pid, worktree, cmd: r.cmd ?? '' });
  }
  if (ended && reaped.length) log.warn(`reaper: stopped ${reaped.length} process(es) left in ${ended} when its session ended: ${reaped.map((r) => r.pid).join(', ')}`);
  return reaped;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a folder git no longer lists holds nothing worth keeping: its worktree row is closed or merged, or its
 * batch is merged or abandoned. A folder that matches a batch row instead of a worktree row follows that batch. A
 * folder with no row at all is disposable only once it has sat there longer than a day.
 */
function disposable(repo: Repo, dir: string, db: Db): boolean {
  const name = path.basename(dir);
  const worktree = db.worktrees.get(name);
  if (worktree) {
    if (worktree.closed_at || worktree.merged_at) return true;
    if (worktree.batch_id) {
      const batch = db.batches.get(worktree.batch_id);
      if (batch && (batch.status === 'merged' || batch.status === 'abandoned')) return true;
    }
    return false;
  }
  const batch = db.batches.get(`${repo.id}-${name}`) ?? db.batches.get(name);
  if (batch) return batch.status === 'merged' || batch.status === 'abandoned';
  try { return Date.now() - fs.statSync(dir).mtimeMs > DAY_MS; } catch { return false; }
}

/**
 * Removes the folders under the worktrees directory that git no longer lists and whose record says their work is
 * done, using `deregisteredWorktrees` (the same detection the day report reads). A folder git still lists, one a
 * running session sits in, and any resolved path outside the worktrees directory are left alone. Each removal is
 * retried like every other worktree removal, and the folder's size is logged so a reclaimed leak is visible.
 */
export async function reapLeftoverFolders(deps: ReapDeps): Promise<string[]> {
  const root = norm(deps.worktreesDir);
  const busy = deps.db.sessions.running().map((s) => norm(s.cwd));
  const removed: string[] = [];
  for (const repo of deps.db.repos.all()) {
    let paths: string[];
    try {
      paths = (await deregisteredWorktrees(repo, deps.worktreesDir)).paths;
    } catch (err) {
      log.debug(`reaper: cannot list the worktrees of ${repo.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const dir of paths) {
      const resolved = path.resolve(dir);
      if (!within(norm(resolved), root)) {
        log.warn(`reaper: refusing to remove ${resolved}, which is outside ${deps.worktreesDir}`);
        continue;
      }
      if (busy.some((b) => within(b, norm(resolved)))) continue;
      if (!disposable(repo, resolved, deps.db)) continue;
      let bytes = 0;
      try { bytes = dirBytes(resolved); } catch { /* the folder vanished between the listing and the scan */ }
      try {
        await removeWorktreeRetry(repo.path, resolved, null);
      } catch (err) {
        log.error(`reaper: could not remove leftover worktree folder ${resolved}`, err);
        continue;
      }
      if (fs.existsSync(resolved)) {
        log.error(`reaper: leftover worktree folder ${resolved} survived removal`);
        continue;
      }
      log.warn(`reaper: removed leftover worktree folder ${resolved} (${formatBytes(bytes)})`);
      removed.push(dir);
    }
  }
  return removed;
}

/** The periodic pass (and the startup one): never consults the ended-session scope. */
export async function reapOrphans(deps: ReapDeps): Promise<Reaped[]> {
  const reaped = await reapPass(deps);
  await reapLeftoverFolders(deps).catch((err) => log.error('reaper: leftover folder sweep failed', err));
  return reaped;
}

/**
 * The pass run when a session ends, whatever ended it: stops, with their process trees, the processes left in that
 * session's bead worktree. Scoping to the ended worktree is what identifies them (`worktreeOf`), so a process in
 * another live session's worktree is never touched, and the live-ancestor guard can be dropped because the session
 * that owned the worktree is gone. `notify` carries one line naming the pids, worktree and commands stopped.
 */
export async function reapEndedSession(deps: ReapDeps, worktree: string, opts: ReapEndedOpts = {}): Promise<Reaped[]> {
  const reaped = await reapPass(deps, { endedWorktree: norm(worktree) });
  if (reaped.length) opts.notify?.(`Stopped ${reaped.length} process(es) left running in ${norm(worktree)}: ${reaped.map((r) => `${r.pid} (${r.cmd || 'unknown'})`).join('; ')}`);
  return reaped;
}

/**
 * Runs a pass now (a crash leaves the most behind at startup) and then every `intervalMs`; returns the stop function,
 * or null when the interval is 0 and nothing runs. A pass still running when the timer fires is not doubled.
 */
export function startReaper(deps: ReapDeps & { intervalMs: number }): (() => void) | null {
  if (deps.intervalMs <= 0) return null;
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    void reapOrphans(deps).catch((err) => log.error('reaper: pass failed', err)).finally(() => { running = false; });
  };
  pass();
  const timer = setInterval(pass, deps.intervalMs);
  timer.unref(); // the reaper must never be the reason the process stays alive
  return () => clearInterval(timer);
}
