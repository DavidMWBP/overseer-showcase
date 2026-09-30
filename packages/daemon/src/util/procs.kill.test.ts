import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `killProcess` reaches the OS through `execFile` (powershell, taskkill) and `process.kill(pid, 0)` only; both are faked
// here so the walk's decisions can be asserted without spawning anything. Windows branch only.
const calls: string[][] = [];
let cim = '';
let startTime = '';
const startTimes: Record<number, string> = {}; // per-pid Get-Process answers; `startTime` is the fallback
let holders = ''; // the Restart Manager answer: pids holding the session logs
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      calls.push([cmd, ...args]);
      const script = args.join(' ');
      if (cmd === 'powershell' && script.includes('Get-CimInstance')) return cb(null, cim);
      if (cmd === 'powershell' && script.includes('RmGetList')) return cb(null, holders);
      if (cmd === 'powershell' && script.includes('Get-Process')) return cb(null, startTimes[Number(script.match(/-Id (\d+)/)?.[1])] ?? startTime);
      return cb(null, '');
    },
  };
});

import { killProcess, TurnGrace, type LineProcess } from './procs';
import { log } from './log';

const taskkilled = () => calls.filter((c) => c[0] === 'taskkill').map((c) => Number(c[2]));
const cimQueried = () => calls.some((c) => c[0] === 'powershell' && c.join(' ').includes('Get-CimInstance'));
const iso = (ms: number) => new Date(ms).toISOString();
// One `Get-CimInstance Win32_Process` line as `processRows` receives it: tab-separated pid, ppid, start time and command line.
const procRow = (pid: number, ppid: number, ms: number, cmd = 'node worker.js') => `${pid}\t${ppid}\t${iso(ms)}\t${cmd}`;

describe.runIf(process.platform === 'win32')('killProcess on Windows', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    calls.length = 0;
    cim = '';
    startTime = '';
    holders = '';
    for (const k of Object.keys(startTimes)) delete startTimes[Number(k)];
    vi.spyOn(process, 'kill').mockImplementation(() => true); // every pid "exists"
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not walk descendants for a gone pid with no start time', async () => {
    // 900 lists 100 as its parent: an unrelated process whose parent exited with the pid the CLI got later.
    cim = procRow(900, 100, 500);
    await killProcess(100);
    expect(cimQueried()).toBe(false);
    expect(taskkilled()).toEqual([100]);
  });

  it('with a known start time kills only descendants started after it', async () => {
    cim = [procRow(200, 100, 1100), procRow(300, 200, 1200), procRow(900, 100, 500), procRow(901, 900, 600)].join('\n');
    await killProcess(100, 1000);
    expect(cimQueried()).toBe(true);
    expect(taskkilled()).toEqual([100, 200, 300]);
    expect(warn).not.toHaveBeenCalled(); // the recycled-pid skip is routine and goes to the file only
  });

  it('looks the start time up while the pid is still alive', async () => {
    startTime = iso(1000);
    cim = [procRow(200, 100, 1100), procRow(900, 100, 500)].join('\n');
    await killProcess(100);
    expect(taskkilled()).toEqual([100, 200]);
  });
});

describe.runIf(process.platform === 'win32')('TurnGrace.sweep on Windows', () => {
  beforeEach(() => {
    calls.length = 0;
    cim = '';
    holders = '';
    for (const k of Object.keys(startTimes)) delete startTimes[Number(k)];
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("bounds a log holder's descendant walk by the holder's own start time, not the CLI's", async () => {
    // CLI 100 started at 1000 and is gone. 900 holds the session logs, is not in 100's tree and started at 2000.
    // 950 lists 900 as its parent, but started at 1500: before 900 existed, so its parent was an earlier holder of
    // that pid. Bounded by the CLI's start (1000) it would pass the filter and be killed with 900.
    cim = [procRow(900, 500, 2000), procRow(950, 900, 1500)].join('\n');
    holders = '900';
    startTimes[900] = iso(2000);
    const p = { pid: 100, exit: Promise.resolve(0) } as unknown as LineProcess;
    const grace = new TurnGrace(p, 60_000, 'test', 'C:\\tmp\\s.log', iso(1000));
    grace.arm();
    expect(await grace.exitCode()).toBe(0);
    expect(taskkilled()).toEqual([900]);
  });
});
