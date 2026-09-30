import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnLines, adoptLines, killProcess, processStartTime, isAlive, pidExists, runCapture, descendantsOf } from './procs';
import { log } from './log';
import { until } from '../test/until';

const TRICKY = 'line one\nline two %PATH% "quoted" \\ end';
const PRINT_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(-1)))';

describe('procs', () => {
  it('streams lines and exit code', async () => {
    const p = spawnLines(process.execPath, ['-e', 'console.log(1);console.log(2);process.exit(3)']);
    const lines: string[] = [];
    for await (const l of p.lines) lines.push(l);
    expect(lines).toEqual(['1', '2']);
    expect(await p.exit).toBe(3);
  });
  it('reports start time and liveness', async () => {
    const t = await processStartTime(process.pid);
    expect(t).toBeTruthy();
    expect(await isAlive(process.pid, t)).toBe(true);
    expect(await isAlive(999999, t)).toBe(false);
  });
  it('passes newlines and %VAR% through spawnLines and runCapture intact', async () => {
    const p = spawnLines(process.execPath, ['-e', PRINT_ARGV, TRICKY]);
    let out = '';
    for await (const l of p.lines) out += l;
    expect(await p.exit).toBe(0);
    expect(JSON.parse(out)).toEqual([TRICKY]);
    const r = await runCapture(process.execPath, ['-e', PRINT_ARGV, TRICKY]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([TRICKY]);
  });
  it.skipIf(process.platform !== 'win32')('spawns an npm .cmd shim as its node target without a shell', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-shim-'));
    const name = `ov-shim-${process.pid}`;
    fs.writeFileSync(path.join(dir, 'target.js'), PRINT_ARGV);
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\target.js" %*\r\n`);
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir};${savedPath}`;
    try {
      const p = spawnLines(name, [TRICKY]);
      expect(p.child!.spawnfile).toBe(process.execPath); // pid is node's, not cmd.exe's
      expect(p.child!.spawnargs[1]).toBe(path.join(dir, 'target.js'));
      let out = '';
      for await (const l of p.lines) out += l;
      expect(await p.exit).toBe(0);
      expect(JSON.parse(out)).toEqual([TRICKY]);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.concurrent('procs: detached spawn and adoption', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ov-procs-'));

  it('spawnLines with logFile sends stdout to the file, streams it back and leaves no stdout pipe', async () => {
    const logFile = path.join(tmp(), 's.log');
    const p = spawnLines(process.execPath, ['-e', 'console.log("a");console.error("oops");setTimeout(()=>{console.log("b");process.exit(4)},100)'], { logFile });
    const lines: string[] = [];
    for await (const l of p.lines) lines.push(l);
    expect(lines).toEqual(['a', 'b']);
    expect(await p.exit).toBe(4);
    expect(p.pid).toBeGreaterThan(0);
    expect(p.stdin).not.toBeNull();
    expect(fs.readFileSync(logFile, 'utf8')).toBe('a\nb\n');
    expect(fs.readFileSync(logFile + '.err', 'utf8')).toBe('oops\n');
    expect(p.logOffset()).toBe(4);
  });

  it('adoptLines tails the log from an offset and ends when the pid dies', async () => {
    const logFile = path.join(tmp(), 's.log');
    const p = spawnLines(process.execPath, ['-e', 'console.log("old");setTimeout(()=>console.log("new"),30);setTimeout(()=>{},200)'], { logFile, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 15));
    const a = adoptLines({ pid: p.pid!, logFile, offset: 4, pollMs: 10 });
    const lines: string[] = [];
    const seen = (async () => { for await (const l of a.lines) lines.push(l); })();
    // The child prints "new" at 30ms and adoptLines polls the file every 10ms: waiting for the line rather than for a fixed
    // stretch keeps the test honest on a loaded machine, where those ticks do not land inside an arbitrary sleep.
    await until(() => lines.length > 0, 10000, 'the adopted line');
    expect(lines).toEqual(['new']);
    await killProcess(p.pid!);
    await seen;
    expect(await a.exit).toBe(0);
    expect(a.logOffset()).toBe(8);
    await p.exit;
  });

  it.skipIf(process.platform !== 'win32')('keeps a log-file worker alive after its parent exits', async () => {
    const dir = tmp();
    const logFile = path.join(dir, 'worker.log');
    const pidFile = path.join(dir, 'worker.pid');
    const parentFile = path.join(dir, 'parent.mts');
    const procsUrl = pathToFileURL(path.join(process.cwd(), 'src', 'util', 'procs.ts')).href;
    fs.writeFileSync(parentFile, [
      `import { spawnLines } from ${JSON.stringify(procsUrl)};`,
      "import fs from 'node:fs';",
      'const [logFile, pidFile] = process.argv.slice(2);',
      "const worker = spawnLines(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { logFile });",
      'fs.writeFileSync(pidFile, String(await worker.pidReady));',
      'process.exit(0);',
    ].join('\n'));
    const parent = spawn(process.execPath, ['--import', 'tsx/esm', parentFile, logFile, pidFile], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
    await once(parent, 'exit');
    await until(() => fs.existsSync(pidFile), 5000, 'the parent to record the worker pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const startedAt = await processStartTime(pid);
    try {
      expect(startedAt).toBeTruthy();
      expect(await isAlive(pid, startedAt)).toBe(true);
      expect(pid).toBe(Number(fs.readFileSync(logFile + '.pid', 'utf8'))); // the worker's pid, not the launcher's
      // The daemon that started it is gone: a new one adopts the worker from its log.
      const a = adoptLines({ pid, logFile, offset: 0, pollMs: 10 });
      await killProcess(pid);
      expect(await a.exit).toBe(0);
    } finally {
      await killProcess(pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const winOnly = it.skipIf(process.platform !== 'win32');
  const idle = ['-e', 'setInterval(() => {}, 1000)'];

  winOnly('records the worker pid the launcher reports, not the launcher pid', async () => {
    const logFile = path.join(tmp(), 'w.log');
    const p = spawnLines(process.execPath, ['-e', 'console.log(process.pid);setTimeout(()=>{},500)'], { logFile });
    const launcherPid = p.pid;
    const pid = await p.pidReady;
    const lines: string[] = [];
    for await (const l of p.lines) lines.push(l);
    expect(await p.exit).toBe(0);
    expect(pid).not.toBe(launcherPid);
    expect(p.pid).toBe(pid);
    expect(lines).toEqual([String(pid)]);
  });

  winOnly('passes stdin through the launcher and reports the worker exit code', async () => {
    const logFile = path.join(tmp(), 'w.log');
    const p = spawnLines(process.execPath, ['-e', 'process.stdin.on("data",d=>process.stdout.write(d));process.stdin.on("end",()=>process.exit(5))'], { logFile });
    p.stdin!.end('hello\n');
    const lines: string[] = [];
    for await (const l of p.lines) lines.push(l);
    expect(lines).toEqual(['hello']);
    expect(await p.exit).toBe(5);
  });

  winOnly('a kill of the recorded pid reaches the worker and ends the launcher', async () => {
    const p = spawnLines(process.execPath, idle, { logFile: path.join(tmp(), 'w.log') });
    const pid = (await p.pidReady)!;
    expect(await isAlive(pid, null)).toBe(true);
    await killProcess(pid);
    expect(await p.exit).not.toBe(0);
    expect(await isAlive(pid, null)).toBe(false);
  });

  winOnly('a killed launcher takes its worker with it', async () => {
    const p = spawnLines(process.execPath, idle, { logFile: path.join(tmp(), 'w.log') });
    const launcherPid = p.pid!;
    const pid = (await p.pidReady)!;
    process.kill(launcherPid);
    await p.exit;
    await until(() => !pidExists(pid), 5000, 'the worker to die with its launcher');
  });

  winOnly('gives the worker a console, so its console children do not open their own', async () => {
    const logFile = path.join(tmp(), 'w.log');
    // A detached process has no console, so a console program it starts gets a new, visible one of its own. Under the launcher
    // the worker owns a hidden console, which shows as a conhost.exe child of the worker.
    const script = 'const {execFileSync}=require("child_process");console.log(execFileSync("powershell",["-NoProfile","-Command",`(Get-CimInstance Win32_Process -Filter ParentProcessId=${process.pid}).Name`],{windowsHide:true}).toString().trim())';
    const p = spawnLines(process.execPath, ['-e', script], { logFile });
    const lines: string[] = [];
    for await (const l of p.lines) lines.push(l);
    expect(await p.exit).toBe(0);
    expect(lines.join(' ')).toMatch(/conhost\.exe/i);
  }, 20000);
});

describe('descendantsOf', () => {
  const cli = { pid: 100, ppid: 1, created: 1000 };
  it('walks children and grandchildren by parent pid', () => {
    const rows = [cli, { pid: 200, ppid: 100, created: 1100 }, { pid: 300, ppid: 200, created: 1200 }, { pid: 400, ppid: 1, created: 1300 }];
    expect(descendantsOf(rows, 100, 1000)).toEqual([200, 300]);
  });
  it('drops a recycled-pid impostor that started before the CLI and logs it at debug (a routine Windows condition)', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {});
    try {
      // 900 was started long ago by a process that had pid 100 before the CLI got it; 901 is its child and must go too.
      const rows = [cli, { pid: 200, ppid: 100, created: 1100 }, { pid: 900, ppid: 100, created: 500 }, { pid: 901, ppid: 900, created: 600 }];
      expect(descendantsOf(rows, 100, 1000)).toEqual([200]);
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain('pid 900');
      expect(String(debug.mock.calls[0]?.[0])).toContain('recycled pid');
      // Without a start time, or when the OS reports none for the row, the walk keeps the candidate.
      expect(descendantsOf(rows, 100)).toEqual([200, 900, 901]);
      expect(descendantsOf([cli, { pid: 900, ppid: 100, created: null }], 100, 1000)).toEqual([900]);
    } finally { warn.mockRestore(); debug.mockRestore(); }
  });
});
