import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CodexAdapter, CodexParser, codexArgs, parseCodexResetTime } from './codex';
import { killProcess, pidExists, spawnLines, type LineProcess } from '../util/procs';
import { until } from '../test/until';
import { fakeBin, lingeringChildBody, orphaningChildBody, orphanBehindIntermediateBody, lingeringOrphanBehindIntermediateBody } from '../test/fakeBin';
import type { HarnessEvent, StartOpts } from './types';
import { log } from '../util/log';
import { withStubbedProcessTable } from '../test/procTableStub';

vi.mock('node:child_process', async (orig) => (await import('../test/procTableStub')).stubbableChildProcess(await orig()));

const TEST_GRACE_MS = 50;
const TEST_POLL_MS = 10;
/**
 * Bound for the separate lingering-process case below: idle turns took 0.7-1.4 s, one loaded run took 5.4 s, and restoring
 * the production 5 s grace took 6.1-6.6 s. The orphan cases use the last-output-to-warning bound instead, so startup and
 * descendant-sweep time do not count against them.
 */
const TURN_MAX_MS = 5500;
/**
 * Upper bound from the last assistant output to the grace warning. The 50 ms test grace plus 10 ms log poll measured
 * 74 ms with 16 busy loops, so 2.5 s allows over 30x that scheduler delay while staying below the production 5 s grace.
 */
const GRACE_FIRE_MAX_MS = 2500;

describe('codexArgs', () => {
  it('builds first and resumed turns', () => {
    expect(codexArgs('/w', null)).toEqual(['exec', '--json', '-c', 'sandbox_mode=danger-full-access', '-c', 'approval_policy=never', '--cd', '/w']);
    expect(codexArgs('/w', 'thr_1')).toEqual(['exec', 'resume', '--json', '-c', 'sandbox_mode=danger-full-access', '-c', 'approval_policy=never', 'thr_1']);
  });
  it('adds model and effort flags for new and resumed turns', () => {
    expect(codexArgs('/w', null, { model: 'gpt-5.6-terra', effort: 'high' })).toEqual(['exec', '--json', '-c', 'sandbox_mode=danger-full-access', '-c', 'approval_policy=never', '--cd', '/w', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=high']);
    expect(codexArgs('/w', 'thr_1', { model: 'gpt-5.6-terra', effort: 'high' })).toEqual(['exec', 'resume', '--json', '-c', 'sandbox_mode=danger-full-access', '-c', 'approval_policy=never', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=high', 'thr_1']);
  });
  it('passes ultra to the CLI for a supporting Codex model', () => {
    expect(codexArgs('/w', null, { model: 'gpt-6.1-sol', effort: 'ultra' })).toEqual(['exec', '--json', '-c', 'sandbox_mode=danger-full-access', '-c', 'approval_policy=never', '--cd', '/w', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=ultra']);
  });
});

describe('codexArgs MCP configuration', () => {
  it('names the server and the url it was given, on a first and a resumed turn', () => {
    const servers = [{ name: 'overseer', url: 'http://127.0.0.1:4411/mcp' }];
    expect(codexArgs('/w', null, { mcpServers: servers })).toContain('mcp_servers.overseer.url="http://127.0.0.1:4411/mcp"');
    expect(codexArgs('/w', 'thr_1', { mcpServers: servers })).toContain('mcp_servers.overseer.url="http://127.0.0.1:4411/mcp"');
  });
  it('adds no mcp_servers override when no server is passed', () => {
    expect(codexArgs('/w', null).some((a) => a.startsWith('mcp_servers.'))).toBe(false);
    expect(codexArgs('/w', null, { mcpServers: [] }).some((a) => a.startsWith('mcp_servers.'))).toBe(false);
  });
});

describe('CodexAdapter MCP configuration', () => {
  /** Runs `start` with a stubbed spawn and returns the argv the CLI would have been given. */
  async function startWith(opts: Partial<StartOpts>): Promise<string[]> {
    const procs = await import('../util/procs');
    const proc: LineProcess = { pid: 4242, stdin: null, lines: (async function* () {})(), exit: Promise.resolve(0), logOffset: () => 0 };
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(proc);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      new CodexAdapter('codex').start({ cwd: '/w', prompt: 'go', ...opts });
      return spawnSpy.mock.calls.at(-1)![1] as string[];
    } finally {
      spawnSpy.mockRestore();
      startSpy.mockRestore();
    }
  }

  it('passes the server as a config override', async () => {
    const args = await startWith({ mcpServers: [{ name: 'overseer', url: 'http://127.0.0.1:4411/mcp' }] });
    expect(args).toContain('mcp_servers.overseer.url="http://127.0.0.1:4411/mcp"');
  });

  it('passes no mcp_servers override when no server is given', async () => {
    expect((await startWith({})).some((a) => a.startsWith('mcp_servers.'))).toBe(false);
  });
});

describe('CodexParser', () => {
  // The last two lines of a real critic session log from 2026-09-17, verbatim.
  const LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 20th, 2026 12:18 PM.";
  it('turns the real usage-limit lines into one usage_limit event with the local reset time', () => {
    const p = new CodexParser();
    const reset = new Date(2026, 8, 20, 12, 18).toISOString(); // codex formats the reset in the machine's local zone
    expect(p.parse(JSON.stringify({ type: 'error', message: LIMIT }))).toEqual([{ type: 'usage_limit', resetsAt: reset, message: LIMIT }, { type: 'error', message: LIMIT }]);
    expect(p.parse(JSON.stringify({ type: 'turn.failed', error: { message: LIMIT } }))).toEqual([{ type: 'error', message: LIMIT }]);
  });
  it('reads the capitalised phrasing and a lowercase meridiem', () => {
    const reset = new Date(2026, 8, 20, 12, 18).toISOString();
    expect(parseCodexResetTime("You've hit your usage limit. Try again at Sep 20th, 2026 12:18 PM.")).toBe(reset);
    expect(parseCodexResetTime("You've hit your usage limit. Try again at Sep 20th, 2026 12:18 pm.")).toBe(reset);
  });
  it('reads a same-day reset time and keeps an unreadable one as null', () => {
    expect(parseCodexResetTime('You’ve hit your usage limit. Upgrade or try again at 3:05 AM.', new Date(2026, 8, 17, 1, 0))).toBe(new Date(2026, 8, 17, 3, 5).toISOString());
    const p = new CodexParser();
    expect(p.parse(JSON.stringify({ type: 'error', message: 'You’ve hit your usage limit. Try again later.' }))[0]).toEqual({ type: 'usage_limit', resetsAt: null, message: 'You’ve hit your usage limit. Try again later.' });
  });

  it('maps the documented event types', () => {
    const p = new CodexParser();
    expect(p.parse(JSON.stringify({ type: 'thread.started', thread_id: 'thr_1' }))).toEqual([]);
    expect(p.threadId).toBe('thr_1');
    expect(p.parse(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } }))).toEqual([{ type: 'assistant_text', text: 'hi' }]);
    expect(p.parse(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0 } }))).toEqual([
      { type: 'tool_call', id: 'i2', name: 'command_execution', input: { command: 'ls' } },
      { type: 'tool_result', id: 'i2', output: 'a\n' },
    ]);
    expect(p.parse(JSON.stringify({ type: 'item.completed', item: { id: 'i3', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] } }))).toEqual([
      { type: 'file_change', path: 'a.ts' },
      { type: 'file_change', path: 'b.ts' },
    ]);
    expect(p.parse(JSON.stringify({ type: 'item.completed', item: { id: 'i4', type: 'mcp_tool_call', server: 'overseer', tool: 'bd', arguments: { args: ['list'] }, result: { ok: true } } }))).toEqual([
      { type: 'tool_call', id: 'i4', name: 'overseer.bd', input: { args: ['list'] } },
      { type: 'tool_result', id: 'i4', output: { ok: true } },
    ]);
    expect(p.parse(JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } }))).toEqual([{ type: 'error', message: 'nope' }]);
    expect(p.parse(JSON.stringify({ type: 'item.started', item: { id: 'i5', type: 'reasoning' } }))).toEqual([]);
    expect(p.parse('??')).toEqual([{ type: 'raw', line: '??' }]);
  });
  it('parses the fixture', () => {
    const p = new CodexParser();
    const lines = fs.readFileSync(new URL('./fixtures/codex.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
    const events = lines.flatMap((l) => p.parse(l));
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'file_change')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'raw')).toHaveLength(0);
    expect(p.threadId).toBe('thr_123');
  });
  it('reads every token count from a recorded turn.completed line', () => {
    const p = new CodexParser();
    p.parse('{"type":"turn.completed","usage":{"input_tokens":2080066,"cached_input_tokens":1979648,"cache_write_input_tokens":0,"output_tokens":8353,"reasoning_output_tokens":2233}}');
    expect(p.takeUsage()).toEqual({ input: 2080066, cacheRead: 1979648, cacheWrite: 0, output: 8353, reasoning: 2233 });
  });
});

describe('CodexSession stdin', () => {
  it('writes the prompt to stdin and ends it right after spawning codex exec, before any output is consumed', async () => {
    const procs = await import('../util/procs');
    const end = vi.fn();
    let linesRead = false;
    const fake: LineProcess = {
      pid: 4242,
      stdin: { end } as unknown as LineProcess['stdin'],
      lines: (async function* () { linesRead = true; })(),
      exit: Promise.resolve(0),
      logOffset: () => 0,
    };
    const spy = vi.spyOn(procs, 'spawnLines').mockReturnValue(fake);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      const a = new CodexAdapter('codex');
      const env = { CODEX_HOME: 'C:/accounts/a1' };
      const h = a.start({ cwd: '/w', prompt: 'go', env });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith('go');
      expect(spy.mock.calls[0]?.[1]).not.toContain('go');
      expect(spy.mock.calls[0]?.[2]?.env).toEqual(env);
      expect(linesRead).toBe(false);
      const types: string[] = [];
      for await (const e of a.events(h)) { types.push(e.type); if (e.type === 'turn_end') break; }
      expect(types).toEqual(['process_start', 'turn_end']);
    } finally {
      spy.mockRestore();
      startSpy.mockRestore();
    }
  });

  it('a turn run after adopt carries the adopted account env (overseer-wcw: an adopted worker must keep CODEX_HOME on its next turn)', async () => {
    const procs = await import('../util/procs');
    const env = { CODEX_HOME: 'C:/accounts/a1' };
    const adoptedProc: LineProcess = { pid: 4242, stdin: undefined as unknown as LineProcess['stdin'], lines: (async function* () {})(), exit: Promise.resolve(0), logOffset: () => 0 };
    const nextProc: LineProcess = {
      pid: 4243,
      stdin: { end: vi.fn() } as unknown as LineProcess['stdin'],
      lines: (async function* () {})(),
      exit: new Promise(() => {}),
      logOffset: () => 0,
    };
    const adoptSpy = vi.spyOn(procs, 'adoptLines').mockReturnValue(adoptedProc);
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(nextProc);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      const a = new CodexAdapter('codex');
      const h = a.adopt({ pid: 4242, cwd: '/w', logFile: '/logs/a.log', logOffset: 0, nativeSessionId: null, env });
      const events = a.events(h);
      await a.send(h, 'follow up');
      const types: string[] = [];
      for await (const e of events) { types.push(e.type); if (e.type === 'turn_end') break; }
      expect(types).toEqual(['turn_end']);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[2]?.env).toEqual(env);
    } finally {
      adoptSpy.mockRestore();
      spawnSpy.mockRestore();
      startSpy.mockRestore();
    }
  });
});

describe.sequential('CodexSession turn.completed grace', () => {
  it('ends the turn and kills the lingering process tree when codex stays alive after turn.completed', withStubbedProcessTable(async () => {
    // Bead overseer-41x: the worker left dev servers running; they held codex's stdio and the session never ended.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-grace-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-codex', lingeringChildBody([
      { type: 'thread.started', thread_id: 'thr_g' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: {} },
    ], pidFile));
    const warnings: string[] = [];
    let warnedAt = 0;
    try {
      const a = new CodexAdapter(bin, TEST_GRACE_MS, TEST_POLL_MS, (m) => { warnedAt ||= Date.now(); warnings.push(m); });
      const started = Date.now();
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      const events: HarnessEvent[] = [];
      let outputAt = 0;
      for await (const e of a.events(h)) { events.push(e); if (e.type === 'assistant_text') outputAt = Date.now(); if (e.type === 'turn_end') break; }
      expect(Date.now() - started).toBeLessThan(TURN_MAX_MS);
      expect(warnedAt - outputAt).toBeLessThan(GRACE_FIRE_MAX_MS);
      expect(events.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
      expect(events.at(-1)).toEqual({ type: 'turn_end', nativeSessionId: 'thr_g' });
      expect(events.some((e) => e.type === 'error')).toBe(false); // the turn completed: a killed tree is not an error exit
      expect(warnings).toContainEqual(expect.stringMatching(/^codex session .* \(pid \d+\) reported turn.completed but the process is still alive after 0.05 s; killing the process tree$/));
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => !pidExists(childPid), 5000, 'lingering child killed');
      await a.end(h);
    } finally { /* the process tree is removed by the assertion above */ }
  }), 20000);

  // Under 16 busy loops, the two shapes took 19,497 ms and 16,134 ms; allow additional scheduler margin.
  for (const shape of ['log file', 'pipe'] as const) {
    // Windows only: on POSIX a detached orphan is re-parented to init and escapes the group kill and the parent-pid walk.
    it.skipIf(process.platform !== 'win32')(`ends the turn and kills the orphaned descendant when codex exits first but a grandchild keeps stdout (${shape})`, async () => {
      // The observed case: codex exited after turn.completed while a vite dev server it started kept its stdio.
      // With a pipe stdout `lines` never closes, so the grace must fire although the CLI is gone; with the session log
      // (what the daemon uses) the turn ends on its own and the descendant sweep after exit must still kill the child.
      const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-orphan-')), 'child.pid');
      const { bin, dir } = fakeBin('fake-codex', orphaningChildBody([
        { type: 'thread.started', thread_id: 'thr_o' },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: {} },
      ], pidFile));
      const warnings: string[] = [];
      let outputAt = 0;
      let warnedAt = 0;
      try {
        const a = new CodexAdapter(bin, TEST_GRACE_MS, TEST_POLL_MS, (m) => {
          if (m.includes('reported turn.completed')) warnedAt ||= Date.now();
          warnings.push(m);
        });
        const h = a.start({ cwd: dir, prompt: 'go', logFile: shape === 'log file' ? path.join(dir, 's.log') : undefined });
        const events: HarnessEvent[] = [];
        for await (const e of a.events(h)) {
          events.push(e);
          if (e.type === 'assistant_text') outputAt = Date.now();
          if (e.type === 'turn_end') break;
        }
        if (shape === 'pipe') {
          expect(warnedAt).toBeGreaterThan(0);
          const outputToWarningMs = warnedAt - outputAt;
          expect(outputToWarningMs).toBeLessThan(GRACE_FIRE_MAX_MS);
        }
        expect(events.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
        expect(events.at(-1)).toEqual({ type: 'turn_end', nativeSessionId: 'thr_o' });
        const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
        await until(() => !pidExists(childPid), 5000, 'orphaned child killed');
        expect(warnings).toContainEqual(expect.stringMatching(/killing/));
        await a.end(h);
      } finally { /* the process tree is removed by the assertion above */ }
    }, 60_000);
  }

  it.skipIf(process.platform !== 'win32')('kills an orphan whose intermediate parents exited, found by its handle on the session log', async () => {
    // The 2026-09-15 live proof: codex -> pwsh -> `node bg.js` -> detached node; the two in the middle were gone when codex
    // exited, so the parent-pid walk stopped short. With a log file the orphan still holds the inherited stdout handle,
    // and `fileHolders` (Restart Manager, Windows only) lists it.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-orphan2-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-codex', orphanBehindIntermediateBody([
      { type: 'thread.started', thread_id: 'thr_h' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: {} },
    ], pidFile));
    const warnings: string[] = [];
    try {
      const a = new CodexAdapter(bin, TEST_GRACE_MS, TEST_POLL_MS, (m) => warnings.push(m));
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      const events: HarnessEvent[] = [];
      for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      expect(events.at(-1)).toEqual({ type: 'turn_end', nativeSessionId: 'thr_h' });
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(childPid).toBeGreaterThan(0);
      await until(() => !pidExists(childPid), 5000, 'orphan behind an exited intermediate killed');
      expect(warnings.some((m) => m.includes('descendant process(es) survived') && m.includes(String(childPid)))).toBe(true);
      await a.end(h);
    } finally { /* the process tree is removed by the assertion above */ }
  }, 20000);

  it.skipIf(process.platform !== 'win32')('uses the original CLI start time when an adopted turn sweeps an orphan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-adopt-'));
    const pidFile = path.join(root, 'child.pid');
    const inner = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit', detached: true }); c.unref(); require('node:fs').writeFileSync(process.argv[1], String(c.pid));";
    const { bin, dir } = fakeBin('fake-codex', [
      "const { spawnSync } = require('node:child_process');",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr_a' }));",
      "console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));",
      `spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}, ${JSON.stringify(pidFile)}], { stdio: 'inherit' });`,
      'setInterval(()=>{},1000);',
    ].join('\n'));
    const logFile = path.join(dir, 's.log');
    const original = spawnLines(bin, [], { cwd: dir, logFile });
    let childPid = 0;
    try {
      await until(() => fs.existsSync(pidFile), 5000, 'adopted orphan started');
      childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      const originalPid = (await original.pidReady)!; // on Windows the worker's pid, which the launcher reports after spawn
      const a = new CodexAdapter(bin, TEST_GRACE_MS, TEST_POLL_MS, () => {});
      const h = a.adopt({ pid: originalPid, cwd: dir, logFile, logOffset: 0, nativeSessionId: null });
      const events: HarnessEvent[] = [];
      for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      expect(events.at(-1)).toEqual({ type: 'turn_end', nativeSessionId: 'thr_a' });
      await until(() => !pidExists(childPid), 5000, 'adopted orphan killed');
      await a.end(h);
    } finally {
      if (original.pid && pidExists(original.pid)) await killProcess(original.pid);
      if (childPid && pidExists(childPid)) await killProcess(childPid);
    }
  }, 20000);

  it.skipIf(process.platform !== 'win32')('does not kill a process that only tails the stdout session log', async () => {
    const { bin, dir } = fakeBin('fake-codex', [
      "setTimeout(() => { console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr_t' })); console.log(JSON.stringify({ type: 'turn.completed', usage: {} })); }, 100);",
    ].join('\n'));
    const logFile = path.join(dir, 's.log');
    const a = new CodexAdapter(bin, TEST_GRACE_MS, TEST_POLL_MS, () => {});
    const h = a.start({ cwd: dir, prompt: 'go', logFile });
    await until(() => fs.existsSync(logFile), 5000, 'session log created');
    const reader = spawn(process.execPath, ['-e', "require('node:fs').openSync(process.argv[1], 'r'); setInterval(()=>{},1000)", logFile], { stdio: 'ignore' });
    try {
      await until(() => pidExists(reader.pid!), 5000, 'log reader started');
      for await (const e of a.events(h)) { if (e.type === 'turn_end') break; }
      expect(pidExists(reader.pid!)).toBe(true);
      await a.end(h);
    } finally {
      if (reader.pid && pidExists(reader.pid)) await killProcess(reader.pid);
    }
  }, 20000);

  it('does not arm the grace on a previous turn replayed from the session log: a slower second turn survives', withStubbedProcessTable(async () => {
    // Every turn appends to the same logFile; the tail must start at the file's current size, or the first turn's
    // turn.completed arms the grace against the fresh process before it has answered.
    const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-turns-'));
    const countFile = path.join(dir0, 'runs');
    const { bin, dir } = fakeBin('fake-codex', [
      "const fs = require('node:fs');",
      `const f = ${JSON.stringify(countFile)}; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 1; fs.writeFileSync(f, String(n));`,
      "const say = (t) => { console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr_2' })); console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i' + n, type: 'agent_message', text: t } })); console.log(JSON.stringify({ type: 'turn.completed', usage: {} })); };",
      "if (n === 1) say('first'); else setTimeout(() => say('second'), 100);",
    ].join('\n'));
    const warnings: string[] = [];
    try {
      const a = new CodexAdapter(bin, TEST_GRACE_MS, TEST_POLL_MS, (m) => warnings.push(m));
      const h = a.start({ cwd: dir, prompt: 'one', logFile: path.join(dir, 's.log') });
      const it = a.events(h)[Symbol.asyncIterator]();
      const turn = async () => { const out: HarnessEvent[] = []; for (;;) { const r = await it.next(); if (r.done) break; out.push(r.value); if (r.value.type === 'turn_end') break; } return out; };
      const first = await turn();
      expect(first.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
      // With 16 busy loops a fake CLI outlived its own turn.completed past the 50 ms grace, so the grace fired after
      // each turn's answer. Only a warning before the second answer means the replayed turn.completed armed it.
      const sentAt = warnings.length;
      await a.send(h, 'two');
      const second: HarnessEvent[] = [];
      let beforeAnswer: string[] | undefined;
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        second.push(r.value);
        if (r.value.type === 'assistant_text') beforeAnswer ??= warnings.slice(sentAt);
        if (r.value.type === 'turn_end') break;
      }
      expect(second.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
      expect(second.find((e) => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', text: 'second' });
      expect(beforeAnswer).toEqual([]);
      await a.end(h);
    } finally { /* no process survives this completed turn */ }
  }), 15000);
});

// The sweep's process scan is slow under load: with 16 busy loops a 5 s wait for the kill failed in 5 of 5 runs and the
// 20 s cap in 2 of 5, so the waits are 15 s as in the opencode sweep tests. A lost sweep never kills the child at all.
describe('CodexSession interrupt sweep', () => {
  it.skipIf(process.platform !== 'win32')('interrupt kills a detached child left behind an exited intermediate', async () => {
    // 2026-09-17: an interrupted worker left the dev server it had started running. A parent-pid walk from the CLI
    // cannot reach it (the intermediate that started it has exited), but it holds both session logs.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-interrupt-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-codex', lingeringOrphanBehindIntermediateBody([
      { type: 'thread.started', thread_id: 'thr_i' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'working' } },
    ], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let childPid = 0;
    try {
      const a = new CodexAdapter(bin, 300);
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      await until(() => fs.existsSync(pidFile) && fs.existsSync(pidFile + '.ready'), 5000, 'orphan started, intermediate exited');
      childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(pidExists(childPid)).toBe(true);
      await a.interrupt(h);
      await until(() => !pidExists(childPid), 15000, 'detached child killed at interrupt');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/descendant process\(es\) survived/));
      await a.end(h);
    } finally {
      warn.mockRestore();
      if (childPid && pidExists(childPid)) await killProcess(childPid);
    }
  }, 40000);

  it.skipIf(process.platform !== 'win32')('interrupt leaves a log holder that started before the session alone', async () => {
    // The sweep's notBefore guard: a process holding the session logs that predates the CLI is not a descendant and
    // must survive, even as the sweep kills the child the interrupted worker started.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-predate-'));
    const logFile = path.join(dir, 's.log');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(logFile + '.err', '');
    const holder = spawn(process.execPath, ['-e', "require('node:fs').openSync(process.argv[1], 'r'); require('node:fs').openSync(process.argv[2], 'r'); setInterval(()=>{},1000)", logFile, logFile + '.err'], { stdio: 'ignore' });
    const pidFile = path.join(dir, 'child.pid');
    const { bin, dir: binDir } = fakeBin('fake-codex', lingeringOrphanBehindIntermediateBody([
      { type: 'thread.started', thread_id: 'thr_p' },
    ], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let childPid = 0;
    try {
      await until(() => pidExists(holder.pid!), 5000, 'pre-session holder started');
      const a = new CodexAdapter(bin, 300);
      const h = a.start({ cwd: binDir, prompt: 'go', logFile });
      await until(() => fs.existsSync(pidFile) && fs.existsSync(pidFile + '.ready'), 5000, 'orphan started, intermediate exited');
      childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await a.interrupt(h);
      await until(() => !pidExists(childPid), 15000, 'detached child killed at interrupt');
      expect(pidExists(holder.pid!)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`pid ${holder.pid} holds the session logs but started before the CLI`));
      await a.end(h);
    } finally {
      warn.mockRestore();
      if (childPid && pidExists(childPid)) await killProcess(childPid);
      if (holder.pid && pidExists(holder.pid)) await killProcess(holder.pid);
    }
  }, 40000);
});
