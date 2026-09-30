import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import { EventQueue } from './queue';
import { log } from './log';

export interface LineProcess {
  /** Absent when the process is adopted (started by an earlier daemon) or failed to spawn. */
  child?: ChildProcess;
  pid: number | undefined;
  stdin: Writable | null;
  lines: AsyncIterable<string>;
  /** Stderr lines are exposed for piped processes; log-file processes write them directly to `<logFile>.err`. */
  stderrLines?: AsyncIterable<string>;
  exit: Promise<number>;
  /** Bytes of `logFile` consumed as complete lines so far; 0 for a piped process. */
  logOffset: () => number;
  /** Resolves with the pid to record for the process: on Windows a log-file worker's pid arrives from its launcher after spawn. */
  pidReady?: Promise<number | undefined>;
}

// On win32 every argument of a `shell: true` spawn goes through cmd.exe, which truncates at newlines and
// expands %VAR%. So commands are resolved once to an .exe (spawned directly) or an npm .cmd shim (parsed
// for its node script / .exe target); only an unresolvable command falls back to cmd.exe plus quoting.
interface Resolved { file: string; prefix: string[]; shell: boolean }
const resolved = new Map<string, Resolved>();

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function findExecutable(cmd: string): string | null {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = (base: string) => (path.extname(base) ? [base] : exts.map((e) => base + e.toLowerCase()));
  const dirs = /[\\/]/.test(cmd) ? [''] : (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of dirs) for (const c of candidates(dir ? path.join(dir, cmd) : cmd)) if (isFile(c)) return c;
  return null;
}

function parseShim(shim: string): Pick<Resolved, 'file' | 'prefix'> | null {
  const text = fs.readFileSync(shim, 'utf8');
  const dir = path.dirname(shim);
  const js = /"%dp0%\\([^"]+\.js)"\s+%\*/i.exec(text);
  if (js) return { file: process.execPath, prefix: [path.join(dir, js[1]!)] };
  const exe = /"%dp0%\\([^"]+\.exe)"\s+%\*/i.exec(text);
  if (exe) return { file: path.join(dir, exe[1]!), prefix: [] };
  return null;
}

function resolveCommand(cmd: string): Resolved {
  if (process.platform !== 'win32') return { file: cmd, prefix: [], shell: false };
  const hit = resolved.get(cmd);
  if (hit) return hit;
  let r: Resolved | null = null;
  const found = findExecutable(cmd);
  const ext = found ? path.extname(found).toLowerCase() : '';
  if (found && (ext === '.exe' || ext === '.com')) r = { file: found, prefix: [], shell: false };
  else if (found && (ext === '.cmd' || ext === '.bat')) { const t = parseShim(found); if (t) r = { ...t, shell: false }; }
  if (!r) {
    // A missing binary is the doctor's report to make (codex and glab are optional); only an unreadable shim is worth a warning.
    if (found) log.warn(`procs: cannot resolve ${cmd} (${found}) to an executable; falling back to cmd.exe (arguments with newlines or %VAR% may be corrupted)`);
    r = { file: /\s/.test(cmd) ? `"${cmd}"` : cmd, prefix: [], shell: true };
  }
  resolved.set(cmd, r);
  return r;
}

function quoteArg(a: string): string {
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * Follows `file` from `offset`, yielding complete lines as they are appended, until `done` resolves and the rest is read.
 * Polling (200ms) rather than fs.watch: appends by another process are not reported reliably on Windows.
 */
function tailLines(file: string, offset: number, done: Promise<unknown>, pollMs: number): { lines: AsyncIterable<string>; offset: () => number; finished: Promise<void> } {
  const q = new EventQueue<string>();
  let finished = false;
  void done.then(() => { finished = true; });
  const readNew = (): void => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      const text = buf.subarray(0, n).toString('utf8');
      const last = text.lastIndexOf('\n');
      if (last < 0) return; // a partial line: wait for its newline
      for (const l of text.slice(0, last).split('\n')) q.push(l.endsWith('\r') ? l.slice(0, -1) : l);
      offset += Buffer.byteLength(text.slice(0, last + 1));
    } finally { fs.closeSync(fd); }
  };
  const end = (async () => {
    while (!finished) { readNew(); await new Promise((r) => setTimeout(r, pollMs)); }
    readNew();
    q.close();
  })();
  return { lines: q, offset: () => offset, finished: end };
}

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.cjs');

/** The worker pid the launcher writes once the worker has started; undefined if the launcher exits without one. */
async function readPidFile(file: string, exit: Promise<unknown>, pollMs: number): Promise<number | undefined> {
  let exited = false;
  void exit.then(() => { exited = true; });
  for (;;) {
    const done = exited;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
    if (Number(text) > 0) return Number(text);
    if (done) return undefined;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * With `logFile` the child is detached from the daemon: stdout goes to the file (stderr to `<logFile>.err`), it gets its own
 * process group, and it is unref'd. Only stdin stays a pipe, so a daemon that dies leaves the child at
 * EOF on stdin rather than with a broken stdout (which is what killed workers on every restart) and `adoptLines` can pick
 * it up again from the file.
 *
 * On Windows a detached process has no console at all, so every console program it starts (cmd.exe from a Bash tool,
 * codex.exe from the codex npm shim) opened a visible console window. There the detached process is `launcher.cjs`, which
 * starts the worker with a hidden console that those programs share. `pid` is the launcher's until the launcher writes the
 * worker's pid to `<logFile>.pid`; then `pid` and `pidReady` carry the worker's, which the daemon records, adopts and kills.
 */
export function spawnLines(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; logFile?: string; pollMs?: number } = {}): LineProcess {
  const r = resolveCommand(cmd);
  const argv = [...r.prefix, ...(r.shell ? args.map(quoteArg) : args)];
  const env = { ...process.env, ...opts.env };
  if (opts.logFile) {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    const out = fs.openSync(opts.logFile, 'a');
    const err = fs.openSync(opts.logFile + '.err', 'a');
    const pidFile = opts.logFile + '.pid';
    const launch = process.platform === 'win32';
    if (launch) fs.rmSync(pidFile, { force: true });
    const [file, fileArgs] = launch ? [process.execPath, [LAUNCHER, pidFile, r.shell ? '1' : '0', r.file, ...argv]] : [r.file, argv];
    // Tail from the file's current size, not 0: a session log is appended to on every turn (codex spawns one process per
    // turn), and replaying the earlier turns' lines would re-emit their events and arm `TurnGrace` against the fresh process.
    const start = fs.fstatSync(out).size;
    const child = spawn(file, fileArgs, { cwd: opts.cwd, env, stdio: ['pipe', out, err], shell: !launch && r.shell, detached: true, windowsHide: true });
    fs.closeSync(out); fs.closeSync(err);
    child.unref();
    child.stdin?.on('error', () => { /* EPIPE when the harness exits before we stop writing */ });
    const exit = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
      child.on('error', () => resolve(-1));
    });
    const tail = tailLines(opts.logFile, start, exit, opts.pollMs ?? 200);
    const p: LineProcess = { child, pid: child.pid, stdin: child.stdin, lines: tail.lines, exit: exit.then(async (c) => { await tail.finished; return c; }), logOffset: tail.offset };
    p.pidReady = launch && child.pid ? readPidFile(pidFile, exit, opts.pollMs ?? 50).then((pid) => { if (pid) p.pid = pid; return p.pid; }) : Promise.resolve(child.pid);
    return p;
  }
  const child = spawn(r.file, argv, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: r.shell });
  child.stdin?.on('error', () => { /* EPIPE when the harness exits before we stop writing */ });
  const q = new EventQueue<string>();
  const eq = new EventQueue<string>();
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const erl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  rl.on('line', (l) => q.push(l));
  erl.on('line', (l) => eq.push(l));
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr += String(d); });
  const exit = new Promise<number>((resolve) => {
    child.on('close', (code) => { rl.close(); erl.close(); q.close(); eq.close(); resolve(code ?? -1); });
    child.on('error', () => { q.close(); eq.close(); resolve(-1); });
  });
  return { child, pid: child.pid, stdin: child.stdin, lines: q, stderrLines: eq, exit: exit.then((c) => { (child as ChildProcess & { stderrText?: string }).stderrText = stderr; return c; }), logOffset: () => 0 };
}

/** Whether `pid` exists right now (no start-time check; `isAlive` does that once, at adoption). */
export function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * A process an earlier daemon spawned with `spawnLines({ logFile })`: its output is followed from `offset` and `exit` resolves
 * when the pid is gone (polled every second; the exit code is unknown and reported as 0).
 */
export function adoptLines(o: { pid: number; logFile: string; offset: number; pollMs?: number }): LineProcess {
  const exit = (async () => {
    while (pidExists(o.pid)) await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
    return 0;
  })();
  const tail = tailLines(o.logFile, o.offset, exit, o.pollMs ?? 200);
  return { pid: o.pid, stdin: null, lines: tail.lines, exit: exit.then(async (c) => { await tail.finished; return c; }), logOffset: tail.offset };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (_e, out) => resolve(String(out ?? '').trim())));
}

export async function processStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    const out = await run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('o')`]);
    return out || null;
  }
  const out = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  return out || null;
}

export async function isAlive(pid: number, startedAt: string | null): Promise<boolean> {
  const now = await processStartTime(pid);
  if (!now) return false;
  return startedAt === null ? true : now === startedAt;
}

/** One row of the process list: a pid, its parent pid and, when the OS reports it, the process start time (ms) and command line. */
export interface ProcRow { pid: number; ppid: number; created: number | null; cmd?: string }

/**
 * The pids descended from `pid` in `rows`, walked over parent pids. A candidate that started before `notBefore` is
 * dropped and logged: Windows keeps a dead parent's pid in ParentProcessId forever, so once the pid is recycled an
 * unrelated process whose own parent exited earlier with that same pid would match the walk. Nothing that started
 * before the CLI can be its descendant.
 */
export function descendantsOf(rows: ProcRow[], pid: number, notBefore?: number): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const next = queue.shift()!;
    for (const c of children.get(next) ?? []) {
      if (found.includes(c) || c === pid) continue;
      const created = byPid.get(c)?.created ?? null;
      if (notBefore !== undefined && created !== null && created < notBefore) {
        log.debug(`pid ${c} lists ${next} as its parent but started before the CLI (recycled pid); not treating it as a descendant`);
        continue;
      }
      found.push(c); queue.push(c);
    }
  }
  return found;
}

/**
 * The live process table with each command line (`Get-CimInstance Win32_Process`, tab-separated, on Windows; `ps -e -o
 * pid=,ppid=,lstart=,args=` elsewhere, where `lstart` is always five words and the command line is the rest).
 */
export async function processRows(): Promise<ProcRow[]> {
  const out = process.platform === 'win32'
    ? await run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToString(\"o\") })`t$($_.CommandLine -replace \"\\s+\", \" \")" }'])
    : await run('ps', ['-e', '-o', 'pid=,ppid=,lstart=,args=']);
  const rows: ProcRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = process.platform === 'win32'
      ? line.match(/^\s*(\d+)\t(\d+)\t([^\t]*)\t?(.*)$/)
      : line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s*(.*)$/);
    if (!m) continue;
    const t = m[3] ? Date.parse(m[3]) : NaN;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number.isNaN(t) ? null : t, cmd: m[4] || undefined });
  }
  return rows;
}

/**
 * Pids of every live process descended from `pid` (`Get-CimInstance Win32_Process` on Windows, `ps -e -o pid=,ppid=,lstart=`
 * elsewhere), see `descendantsOf`. Works after `pid` itself has exited on Windows, where a child keeps its dead parent's
 * pid as ParentProcessId; on Linux orphans are re-parented and drop out of the walk, which is why `killProcess` signals
 * the process group there. `notBefore` (ms) is the start time of `pid`: anything older is a recycled-pid impostor.
 */
export async function descendantPids(pid: number, notBefore?: number): Promise<number[]> {
  return descendantsOf(await processRows(), pid, notBefore);
}

/** The process table as `descendantPids` reads it, for a caller that needs several walks and start times from one query. */
export const processTable = processRows;

/** Start time (ms) of `pid` from a `processTable` snapshot, looked up on its own when the snapshot has none; null once gone. */
export async function startTimeIn(rows: ProcRow[], pid: number): Promise<number | null> {
  const created = rows.find((r) => r.pid === pid)?.created;
  if (created != null) return created;
  const t = await processStartTime(pid);
  return t ? Date.parse(t) : null;
}

// Restart Manager query: the pids of every process with `file` open. Compiled per call (about 1.5 s); only run at a turn end.
const FILE_HOLDERS_PS = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Rm {
  [StructLayout(LayoutKind.Sequential)] public struct UP { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME t; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct PI { public UP p; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string a; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string s; public int ty; public uint st; public uint ts; [MarshalAs(UnmanagedType.Bool)] public bool r; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint h, int f, string k);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint h, uint n, string[] f, uint na, UP[] a, uint ns, string[] s);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint h, out uint need, ref uint n, [In,Out] PI[] i, ref uint re);
  public static int[] Holders(string file) {
    uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString("N")) != 0) return new int[0];
    try {
      if (RmRegisterResources(h, 1, new[]{file}, 0, null, 0, null) != 0) return new int[0];
      uint need = 0, n = 0, re = 0; RmGetList(h, out need, ref n, null, ref re);
      if (need == 0) return new int[0];
      var arr = new PI[need]; n = need; if (RmGetList(h, out need, ref n, arr, ref re) != 0) return new int[0];
      var r = new int[n]; for (int k = 0; k < n; k++) r[k] = arr[k].p.pid; return r;
    } finally { RmEndSession(h); }
  }
}
"@
$stdout = [Rm]::Holders($env:OVERSEER_HOLDERS_FILE)
if ($env:OVERSEER_HOLDERS_FILE_2) {
  $stderr = [Rm]::Holders($env:OVERSEER_HOLDERS_FILE_2)
  ($stdout | Where-Object { $stderr -contains $_ }) -join ' '
} else { $stdout -join ' ' }
`;

/**
 * Pids of every other process that has `file` open, or both files when `alsoFile` is supplied (Windows only, via Restart
 * Manager; `[]` elsewhere). A worker's lingering server inherited both session-log handles: this finds it even when the
 * processes between the CLI and it have exited, without mistaking a process that independently tails only stdout.
 */
export async function fileHolders(file: string, alsoFile?: string): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const out = await new Promise<string>((resolve) => execFile('powershell', ['-NoProfile', '-Command', FILE_HOLDERS_PS],
    { windowsHide: true, env: { ...process.env, OVERSEER_HOLDERS_FILE: file, OVERSEER_HOLDERS_FILE_2: alsoFile ?? '' } }, (_e, o) => resolve(String(o ?? '').trim())));
  return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

/**
 * Kills `pid` and everything it started: `taskkill /T /F` on Windows, the process group on POSIX. `spawnLines` spawns
 * with `detached: true`, so the child leads its own group and a lingering grandchild (a dev server a worker left
 * running) is signalled too; a child that is not a group leader answers ESRCH and takes the single-pid fallback.
 * On Windows `taskkill /T` cannot walk the children of a pid that already exited, so the descendants are listed
 * first (`descendantPids`) and each survivor is killed by its own pid afterwards. `startedAt` (ms) is when `pid`
 * started; when it is not given and `pid` is still alive it is looked up. When `pid` is gone and no start time is
 * known the walk is skipped entirely: Windows keeps a dead parent's pid in ParentProcessId, so without a start time
 * bound the walk could only kill by a recycled parent pid. `rows`, a `processTable` snapshot the caller already took,
 * replaces the walk's own query.
 */
export async function killProcess(pid: number, startedAt?: number, rows?: ProcRow[]): Promise<void> {
  if (process.platform === 'win32') {
    if (startedAt === undefined) { const t = await processStartTime(pid); if (t) startedAt = Date.parse(t); }
    const kids = startedAt === undefined ? [] : rows ? descendantsOf(rows, pid, startedAt) : await descendantPids(pid, startedAt);
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    for (const k of kids) if (pidExists(k)) await run('taskkill', ['/PID', String(k), '/T', '/F']);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); return; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return; // EPERM and the rest: nothing better to try
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** Stops one process and nothing below it: a daemon we replace must die without taking its detached workers with it. */
export async function stopProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') { await run('taskkill', ['/PID', String(pid), '/F']); return; }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

export function runCapture(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const r = resolveCommand(cmd);
    execFile(r.file, [...r.prefix, ...(r.shell ? args.map(quoteArg) : args)], { cwd: opts.cwd, shell: r.shell, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (err && !stderr ? String(err.message) : '') });
    });
  });
}

const existsCache = new Map<string, { ok: boolean; at: number }>();
/** Whether `cmd` (a bare name or a path) resolves to an executable on PATH; cached for a minute so a freshly installed CLI is picked up. */
export function commandExists(cmd: string): boolean {
  const hit = existsCache.get(cmd);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  let ok: boolean;
  if (process.platform === 'win32') ok = findExecutable(cmd) !== null;
  else if (cmd.includes('/')) ok = isExecutable(cmd);
  else ok = (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && isExecutable(path.join(dir, cmd)));
  existsCache.set(cmd, { ok, at: Date.now() });
  return ok;
}
function isExecutable(file: string): boolean { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }

/** How long an adapter waits after the CLI reports its turn complete before it kills a process that has not exited. */
export const TURN_END_GRACE_MS = 5000;

/**
 * Kills what a CLI left behind once it has exited: the live descendants of `pid` and any process that holds both
 * session logs (`fileHolders`), each only when it started at or after `startedAt` (ms). A descendant that predates the
 * CLI is dropped by `descendantsOf` (a recycled parent pid), and a log holder that started before it is skipped here, so
 * a process that predates the session is never touched. Descendants are killed with `taskkill /T` from the one process
 * table read; a log holder outside the tree goes through `killProcess`, bounded by the holder's own start time.
 *
 * Every path a session can end on reaches this: `TurnGrace.exitCode` (codex/opencode turn end) and the claude adapter's
 * `end()` call it, and so does each adapter's `interrupt()` after it has killed the CLI, so stopping a worker sweeps
 * what it started instead of leaving it running.
 */
export async function sweepProcessTree(o: { pid?: number; startedAt: number; logFile?: string; label: string; warn?: (message: string) => void }): Promise<void> {
  const warn = o.warn ?? log.warn;
  // Each query pays a PowerShell startup: take the process table once, alongside the Restart Manager query, and read
  // the descendants, the holders' start times and the holders' own children from that one snapshot.
  const [rows, holders] = await Promise.all([
    processTable(),
    o.logFile ? fileHolders(o.logFile, o.logFile + '.err') : Promise.resolve([] as number[]),
  ]);
  const kids = o.pid ? descendantsOf(rows, o.pid, o.startedAt) : [];
  const alive = new Set(kids.filter((k) => k !== o.pid && pidExists(k)));
  const holderStart = new Map<number, number>(); // a log holder outside the tree, with its own start time (ms)
  for (const h of holders) {
    if (h === o.pid) continue;
    const hStart = await startTimeIn(rows, h);
    if (hStart === null) continue; // gone already
    if (hStart < o.startedAt) {
      warn(`${o.label}; pid ${h} holds the session logs but started before the CLI; not killing it`);
      continue;
    }
    alive.add(h);
    holderStart.set(h, hStart);
  }
  if (!alive.size) return;
  warn(`${o.label} and its process is gone, but ${alive.size} descendant process(es) survived (pids ${[...alive].join(', ')}); killing them`);
  // The descendants are already resolved from one process-table enumeration; `taskkill /T` on each is enough.
  // A log holder outside the tree goes through `killProcess` so its own children are walked too, bounded by the
  // holder's own start time: a process that lists the holder's pid as a recycled parent and started after the CLI
  // but before the holder is not the holder's child.
  const kidSet = new Set(kids);
  for (const k of alive) {
    if (kidSet.has(k)) await run('taskkill', ['/PID', String(k), '/T', '/F']);
    else await killProcess(k, holderStart.get(k), rows);
  }
}

/**
 * Ends a turn the CLI reported complete even when the process lingers (2026-09-15, bead overseer-41x: a codex worker
 * left two vite dev servers running; they inherited its stdio, codex never exited, `lines` never ended and the session
 * stayed running for 75 minutes). `arm()` is called on the CLI's turn-complete line; if `lines` has not ended `graceMs`
 * later, the process tree is killed (`killProcess`) and `fired` resolves, which `linesUntil` and the exit race in the
 * adapters use to carry on with the normal turn-end path. The timer is not cancelled by `p.exit`: with a pipe stdout a
 * CLI that exited while a grandchild holds the pipe never closes `lines`, and with a log file `exitCode()` sweeps the
 * descendants that outlived the CLI (`descendantPids` walks parent pids, which Windows keeps after the parent is gone,
 * plus `fileHolders` of `logFile`, which reaches an orphan whose intermediate parents are gone too).
 */
export class TurnGrace {
  readonly fired: Promise<void>;
  private resolveFired!: () => void;
  private armed = false;
  private hasFired = false;
  private timer: NodeJS.Timeout | null = null;
  /** When the CLI started: its own process start time when known, else the moment the adapter spawned it (see `sweep`). */
  private startedAt: number;

  constructor(private p: LineProcess, private graceMs: number, private label: string, private logFile?: string, pidStartedAt?: string | null, private warn: (message: string) => void = log.warn) {
    this.fired = new Promise<void>((r) => { this.resolveFired = r; });
    const t = pidStartedAt ? Date.parse(pidStartedAt) : NaN;
    this.startedAt = Number.isNaN(t) ? Date.now() : t;
  }

  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.timer = setTimeout(async () => {
      this.hasFired = true;
      this.warn(`${this.label} but the process is still alive after ${this.graceMs / 1000} s; killing the process tree`);
      if (this.p.pid) await killProcess(this.p.pid, this.startedAt);
      this.resolveFired();
    }, this.graceMs);
  }

  clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /**
   * `p.exit`, or 0 whenever the grace fired: the turn completed, so a kill is not an error exit, whichever of the two
   * settles first. Either way, once the process is gone, any descendant it left behind is killed (`sweep`).
   */
  async exitCode(): Promise<number> {
    const code = await Promise.race([this.p.exit, this.fired.then(() => 0)]).finally(() => this.clear());
    if (this.armed) await this.sweep();
    return this.hasFired ? 0 : code;
  }

  /** Kills live descendants and any process holding both session logs, each only when it started after the CLI did. */
  private async sweep(): Promise<void> {
    await sweepProcessTree({ pid: this.p.pid, startedAt: this.startedAt, logFile: this.logFile, label: this.label, warn: this.warn });
  }
}

/** Yields `lines` until they end or `stop` resolves, whichever comes first. */
export async function* linesUntil<T>(lines: AsyncIterable<T>, stop: Promise<void>): AsyncGenerator<T> {
  const it = lines[Symbol.asyncIterator]();
  const stopped = stop.then(() => null);
  for (;;) {
    const r = await Promise.race([it.next(), stopped]);
    if (r === null || r.done) return;
    yield r.value;
  }
}
