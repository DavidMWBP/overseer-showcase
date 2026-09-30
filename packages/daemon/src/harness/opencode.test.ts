import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { OPENCODE_PERMISSION, OpencodeAdapter, OpencodeParser, SubagentWatcher, opencodeArgs, opencodeAuthPath, opencodeLoginHasKey } from './opencode';
import { killProcess, pidExists, spawnLines, type LineProcess } from '../util/procs';
import { EventQueue } from '../util/queue';
import { log } from '../util/log';
import { until } from '../test/until';
import { fakeBin, lingeringChildBody, orphanBehindIntermediateBody, lingeringOrphanBehindIntermediateBody } from '../test/fakeBin';
import type { HarnessEvent, SessionHandle, StartOpts } from './types';
import { withStubbedProcessTable } from '../test/procTableStub';

vi.mock('node:child_process', async (orig) => (await import('../test/procTableStub')).stubbableChildProcess(await orig()));

/** The log tail, adoption and sub-agent store poll for tests that do not wait on the production defaults. */
const TEST_POLL_MS = 20;

/** A store path under the temp dir that does not exist, so a test never opens the host's real opencode store. */
let absentSeq = 0;
const absentDbPath = () => path.join(os.tmpdir(), `ov-opencode-absent-${process.pid}-${absentSeq++}`, 'opencode.db');

function controlledLineSource() {
  const queue = new EventQueue<string>();
  let reads = 0;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
  const readWaiters = new Map<number, () => void>();
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      const iterator = queue[Symbol.asyncIterator]();
      return {
        next() {
          reads++;
          for (const [count, resolve] of readWaiters) {
            if (reads >= count) { readWaiters.delete(count); resolve(); }
          }
          return iterator.next();
        },
      };
    },
  };
  return {
    lines,
    push: (line: string) => queue.push(line),
    close: () => { queue.close(); resolveExit(0); },
    exit,
    waitForRead: (count: number) => reads >= count ? Promise.resolve() : new Promise<void>((resolve) => readWaiters.set(count, resolve)),
  };
}

function controlledLineProcess(source: ReturnType<typeof controlledLineSource>): LineProcess {
  return { pid: undefined, stdin: null, lines: source.lines, exit: source.exit, logOffset: () => 0 };
}

describe('opencodeArgs', () => {
  it('builds a first-turn and a continued-turn command line', () => {
    expect(opencodeArgs('/w', null)).toEqual(['run', '--format', 'json', '--dir', '/w']);
    expect(opencodeArgs('/w', 'ses_1')).toEqual(['run', '--format', 'json', '--dir', '/w', '--session', 'ses_1']);
  });
  it('does not pass --auto, which fails on opencode 1.18.19', () => {
    expect(opencodeArgs('/w', 'ses_1', { model: 'deepseek/deepseek-flash' })).not.toContain('--auto');
  });
  it('adds model flag', () => {
    expect(opencodeArgs('/w', null, { model: 'anthropic/claude' })).toEqual(['run', '--format', 'json', '--dir', '/w', '--model', 'anthropic/claude']);
  });
  it('passes an effort the deepseek model accepts as --variant', () => {
    expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-flash', effort: 'high' })).toEqual(['run', '--format', 'json', '--dir', '/w', '--model', 'deepseek/deepseek-flash', '--variant', 'high']);
    expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-flash', effort: 'low' })).toEqual(expect.arrayContaining(['--variant', 'low']));
    expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-v4-pro', effort: 'max' })).toEqual(expect.arrayContaining(['--variant', 'max']));
  });
  it('passes --variant only for an effort the model accepts', () => {
    expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-flash', effort: 'high' })).toEqual(expect.arrayContaining(['--variant', 'high']));
    expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-flash' })).not.toContain('--variant');
    for (const effort of ['medium', 'xhigh'] as const) expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-flash', effort })).not.toContain('--variant');
    expect(opencodeArgs('/w', null, { model: 'deepseek/deepseek-v4-pro', effort: 'low' })).not.toContain('--variant');
    expect(opencodeArgs('/w', null, { model: 'anthropic/claude', effort: 'high' })).not.toContain('--variant');
  });
});

describe('OPENCODE_PERMISSION', () => {
  it('allows external directories and the tools claude and codex workers already have', () => {
    expect(JSON.parse(OPENCODE_PERMISSION)).toEqual({ read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', list: 'allow', bash: 'allow', external_directory: 'allow', todowrite: 'allow', webfetch: 'allow' });
  });
});

describe('OpencodeAdapter account environment', () => {
  it('spawns a DeepSeek candidate with its resolved API key and unchanged model id', async () => {
    const procs = await import('../util/procs');
    const proc: LineProcess = { pid: 4242, stdin: null, lines: (async function* () {})(), exit: Promise.resolve(0), logOffset: () => 0 };
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(proc);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      new OpencodeAdapter('opencode', undefined, absentDbPath()).start({ cwd: '/w', prompt: 'go', model: 'deepseek/deepseek-chat', env: { DEEPSEEK_API_KEY: 'deepseek-key' } });
      expect(spawnSpy).toHaveBeenCalledWith('opencode', expect.arrayContaining(['--model', 'deepseek/deepseek-chat']), expect.objectContaining({ env: { DEEPSEEK_API_KEY: 'deepseek-key', OPENCODE_PERMISSION } }));
    } finally {
      spawnSpy.mockRestore();
      startSpy.mockRestore();
    }
  });

  it('spawns a candidate without an account environment unchanged', async () => {
    const procs = await import('../util/procs');
    const proc: LineProcess = { pid: 4242, stdin: null, lines: (async function* () {})(), exit: Promise.resolve(0), logOffset: () => 0 };
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(proc);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      new OpencodeAdapter('opencode', undefined, absentDbPath()).start({ cwd: '/w', prompt: 'go', model: 'deepseek/deepseek-chat' });
      expect(spawnSpy).toHaveBeenCalledWith('opencode', expect.any(Array), expect.objectContaining({ env: { OPENCODE_PERMISSION } }));
    } finally {
      spawnSpy.mockRestore();
      startSpy.mockRestore();
    }
  });
});

describe('OpencodeAdapter MCP configuration', () => {
  /** Runs `start` with a stubbed spawn and returns the environment the CLI would have been given. */
  async function startWith(opts: Partial<StartOpts>): Promise<NodeJS.ProcessEnv> {
    const procs = await import('../util/procs');
    const proc: LineProcess = { pid: 4242, stdin: null, lines: (async function* () {})(), exit: Promise.resolve(0), logOffset: () => 0 };
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(proc);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      new OpencodeAdapter('opencode', undefined, absentDbPath()).start({ cwd: '/w', prompt: 'go', ...opts });
      return (spawnSpy.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env;
    } finally {
      spawnSpy.mockRestore();
      startSpy.mockRestore();
    }
  }

  it('writes a config naming the server and its url, and points OPENCODE_CONFIG at it', async () => {
    const env = await startWith({ mcpServers: [{ name: 'overseer', url: 'http://127.0.0.1:4411/mcp' }] });
    const file = env.OPENCODE_CONFIG!;
    expect(file).toBeTruthy();
    try {
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcp).toEqual({ overseer: { type: 'remote', url: 'http://127.0.0.1:4411/mcp', enabled: true } });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('keeps the account environment alongside the config', async () => {
    const env = await startWith({ mcpServers: [{ name: 'overseer', url: 'http://127.0.0.1:4411/mcp' }], env: { DEEPSEEK_API_KEY: 'deepseek-key' } });
    expect(env.DEEPSEEK_API_KEY).toBe('deepseek-key');
    fs.rmSync(env.OPENCODE_CONFIG!, { force: true });
  });

  it('writes no config and sets no OPENCODE_CONFIG when no server is passed', async () => {
    expect(await startWith({})).not.toHaveProperty('OPENCODE_CONFIG');
    expect(await startWith({ mcpServers: [] })).not.toHaveProperty('OPENCODE_CONFIG');
  });
});

// A stand-in for the npm-installed CLI (a .cmd shim on Windows, as the real opencode.cmd is): like
// `opencode run` it reads piped stdin to EOF before doing anything, then records what it was started with.
// Each run appends one JSON line with its argv and the stdin it read.
function stubOpencode(): { bin: string; record: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-opencode-'));
  const record = path.join(dir, 'record.jsonl');
  const source = `let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { stdin += d; }); process.stdin.on('end', () => {
    require('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin, permission: process.env.OPENCODE_PERMISSION ?? null, key: process.env.DEEPSEEK_API_KEY ?? null }) + '\\n');
    console.log(JSON.stringify({ type: 'text', sessionID: 'ses_stub', part: { type: 'text', text: 'ok' } }));
  });`;
  fs.writeFileSync(path.join(dir, 'target.js'), source);
  if (process.platform === 'win32') {
    const bin = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(bin, `@ECHO off\r\nSET dp0=%~dp0\r\n"${process.execPath}" "%dp0%\\target.js" %*\r\n`);
    return { bin, record };
  }
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/target.js" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, record };
}

type Run = { args: string[]; stdin: string; permission: string | null; key: string | null };
const readRecords = (record: string): Run[] => fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Run);

async function turn(a: OpencodeAdapter, h: SessionHandle): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const ev of a.events(h)) { events.push(ev); if (ev.type === 'turn_end') break; }
  return events;
}

describe('OpencodeAdapter prompt over stdin', () => {
  // 2026-09-17: reviews on opencode failed with `spawn ENAMETOOLONG`, the prompt (with the whole diff) being in argv.
  it('keeps the first and the follow-up prompt out of argv and writes each to stdin', async () => {
    const { bin, record } = stubOpencode();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-opencode-cwd-'));
    try {
      const a = new OpencodeAdapter(bin, undefined, undefined, undefined, TEST_POLL_MS);
      const h = a.start({ cwd, prompt: 'first prompt\nwith "quotes" and a second line' });
      expect((await turn(a, h)).some((e) => e.type === 'error')).toBe(false);
      await a.send(h, 'follow-up prompt');
      expect((await turn(a, h)).some((e) => e.type === 'error')).toBe(false);
      await a.end(h);
      const runs = readRecords(record);
      expect(runs.map((r) => r.stdin)).toEqual(['first prompt\nwith "quotes" and a second line', 'follow-up prompt']);
      expect(runs[0]!.args).toEqual(['run', '--format', 'json', '--dir', cwd]);
      expect(runs[1]!.args).toEqual(['run', '--format', 'json', '--dir', cwd, '--session', 'ses_stub']);
      for (const r of runs) expect(r.args.join(' ')).not.toMatch(/prompt/);
    } finally {
      fs.rmSync(path.dirname(record), { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it('spawns and completes a prompt longer than 40 000 characters', async () => {
    const { bin, record } = stubOpencode();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-opencode-cwd-'));
    const prompt = `review this diff\n${'+ a changed line of the diff\n'.repeat(1600)}`;
    expect(prompt.length).toBeGreaterThan(40_000);
    try {
      const a = new OpencodeAdapter(bin, undefined, undefined, undefined, TEST_POLL_MS);
      const h = a.start({ cwd, prompt });
      const events = await turn(a, h);
      await a.end(h);
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(events).toContainEqual({ type: 'assistant_text', text: 'ok' });
      expect(events.at(-1)).toMatchObject({ type: 'turn_end', nativeSessionId: 'ses_stub' });
      expect(readRecords(record).map((r) => r.stdin)).toEqual([prompt]);
    } finally {
      fs.rmSync(path.dirname(record), { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('OpencodeAdapter spawn', () => {
  it('runs a stand-in CLI to completion with stdin closed, no --auto and OPENCODE_PERMISSION set', async () => {
    const { bin, record } = stubOpencode();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-opencode-cwd-'));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const a = new OpencodeAdapter(bin, undefined, absentDbPath(), undefined, TEST_POLL_MS);
      const h = a.start({ cwd, prompt: 'go', model: 'deepseek/deepseek-flash', effort: 'high', env: { DEEPSEEK_API_KEY: 'k' } });
      const events = [];
      for await (const ev of a.events(h)) { events.push(ev); if (ev.type === 'turn_end') break; }
      await a.end(h);
      expect(events).toContainEqual({ type: 'assistant_text', text: 'ok' });
      expect(events.some((e) => e.type === 'error')).toBe(false);
      const [seen] = readRecords(record);
      expect(seen!.args).toEqual(['run', '--format', 'json', '--dir', cwd, '--model', 'deepseek/deepseek-flash', '--variant', 'high']);
      expect(seen!.args).not.toContain('--auto');
      expect(seen!.permission).toBe(OPENCODE_PERMISSION);
      expect(seen!.key).toBe('k');
    } finally {
      warn.mockRestore();
      fs.rmSync(path.dirname(record), { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('opencode without a provider key', () => {
  // The line opencode 1.18.19 printed for each of the four critics on 2026-09-28 (stderr empty, exit 1), and again for
  // `echo say ok | opencode run --format json --dir <worktree> --model deepseek/deepseek-flash` with no DEEPSEEK_API_KEY.
  const noKey = { type: 'error', timestamp: 1790585059826, sessionID: 'ses_nokey', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_05210ec8' } } };
  const body = `process.stdin.resume(); process.stdin.on('end', () => {
    if (!process.env.DEEPSEEK_API_KEY) { console.log(${JSON.stringify(JSON.stringify(noKey))}); process.exit(1); }
    console.log(${JSON.stringify(JSON.stringify({ type: 'text', sessionID: 'ses_key', part: { type: 'text', text: 'ok' } }))});
  });`;

  it('ends the turn with its error and exit code 1 when started without the key, and runs with it', async () => {
    const { bin, dir } = fakeBin('fake-opencode', body);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-opencode-cwd-'));
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY; // an account-less session inherits the daemon's environment
    try {
      const a = new OpencodeAdapter(bin, undefined, absentDbPath(), undefined, TEST_POLL_MS);
      const without = a.start({ cwd, prompt: 'review', model: 'deepseek/deepseek-flash', role: 'critic' });
      const failed = await turn(a, without);
      expect(failed.filter((e) => e.type === 'error')).toEqual([
        { type: 'error', message: 'UnknownError: Unexpected server error. Check server logs for details.' },
        { type: 'error', message: 'opencode exited with code 1' },
      ]);
      expect(failed.some((e) => e.type === 'assistant_text')).toBe(false);
      await a.end(without);

      const withKey = a.start({ cwd, prompt: 'review', model: 'deepseek/deepseek-flash', role: 'critic', env: { DEEPSEEK_API_KEY: 'k' } });
      const ran = await turn(a, withKey);
      expect(ran.filter((e) => e.type === 'error')).toEqual([]);
      expect(ran).toContainEqual({ type: 'assistant_text', text: 'ok' });
      await a.end(withKey);
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it('opencodeLoginHasKey reads the key variable, then the provider entry of the opencode login', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-auth-'));
    const env = { XDG_DATA_HOME: data };
    const auth = opencodeAuthPath(env);
    try {
      expect(auth).toBe(path.join(data, 'opencode', 'auth.json'));
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', env)).toBe(false); // no login file
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', { ...env, DEEPSEEK_API_KEY: '' })).toBe(false); // blank variable
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', { ...env, DEEPSEEK_API_KEY: 'k' })).toBe(true);
      fs.mkdirSync(path.dirname(auth), { recursive: true });
      fs.writeFileSync(auth, '{}'); // `opencode auth list`: 0 credentials
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', env)).toBe(false);
      fs.writeFileSync(auth, JSON.stringify({ openai: { type: 'api', key: 'o' } }));
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', env)).toBe(false);
      fs.writeFileSync(auth, 'not json');
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', env)).toBe(false);
      fs.writeFileSync(auth, JSON.stringify({ deepseek: { type: 'api', key: 'd' } }));
      expect(opencodeLoginHasKey('deepseek', 'DEEPSEEK_API_KEY', env)).toBe(true);
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
  });
});

describe('OpencodeParser', () => {
  it('maps text, tool, step_finish and error events', () => {
    const p = new OpencodeParser();
    expect(p.parse(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'hello' } }))).toEqual([{ type: 'assistant_text', text: 'hello' }]);
    expect(p.parse(JSON.stringify({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'write', callID: 'c1', state: { status: 'completed', input: { filePath: 'a.txt', content: 'x' }, output: 'ok' } } }))).toEqual([
      { type: 'tool_call', id: 'c1', name: 'write', input: { filePath: 'a.txt', content: 'x' } },
      { type: 'file_change', path: 'a.txt' },
      { type: 'tool_result', id: 'c1', output: 'ok' },
    ]);
    expect(p.parse(JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step_finish', cost: 0.02 } }))).toEqual([]);
    expect(p.parse(JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step_finish', cost: 0.03 } }))).toEqual([]);
    expect(p.parse(JSON.stringify({ type: 'error', sessionID: 'ses_1', error: { message: 'boom' } }))).toEqual([{ type: 'error', message: 'boom' }]);
    // 1.18.19 with a key DeepSeek rejects (probe 2026-09-28): the text is nested under `data`
    expect(p.parse(JSON.stringify({ type: 'error', sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'Authentication Fails, Your api key: ****robe is invalid', statusCode: 401, isRetryable: false } } }))).toEqual([{ type: 'error', message: 'APIError: Authentication Fails, Your api key: ****robe is invalid' }]);
    expect(p.parse('garbage')).toEqual([{ type: 'raw', line: 'garbage' }]);
    expect(p.sessionId).toBe('ses_1');
    expect(p.cost).toBeCloseTo(0.05);
  });
  it('keeps the cost opencode reports on step-finish, including zero, without estimating from tokens', () => {
    // Shapes copied from two real DeepSeek worker logs: one where opencode priced the step,
    // one where it reported cost 0 on every step, even an uncached 16384-token input.
    const step = (tokens: object, cost: number) => JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'tool-calls', tokens, cost } });
    const zero = new OpencodeParser();
    zero.parse(step({ total: 16453, input: 16384, output: 69, reasoning: 0, cache: { write: 0, read: 0 } }, 0));
    zero.parse(step({ total: 25882, input: 355, output: 183, reasoning: 0, cache: { write: 0, read: 25344 } }, 0));
    expect(zero.cost).toBe(0);
    const priced = new OpencodeParser();
    priced.parse(step({ total: 16064, input: 14169, output: 202, reasoning: 29, cache: { write: 0, read: 1664 } }, 0.002268942));
    expect(priced.cost).toBe(0.002268942);
  });
  it('keeps each step-finish response separately for per-response tier selection', () => {
    const p = new OpencodeParser();
    const step = (tokens: object) => JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', tokens } });
    p.parse(step({ input: 100, output: 10, reasoning: 5, cache: { read: 7, write: 0 } }));
    p.parse(step({ input: 200_000, output: 20, cache: { read: 0, write: 0 } }));
    expect(p.takeRequests()).toEqual([
      { input: 100, output: 10, reasoning: 5, cacheRead: 7, cacheWrite: 0 },
      { input: 200_000, output: 20, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(p.takeRequests()).toBeUndefined();
  });
  it('accumulates cost from a hyphenated step-finish part and correlates tool ids without callID', () => {
    const p = new OpencodeParser();
    expect(p.parse(JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', cost: 0.07 } }))).toEqual([]);
    expect(p.cost).toBeCloseTo(0.07);
    const [call, result] = p.parse(JSON.stringify({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } } }));
    expect(call).toMatchObject({ type: 'tool_call' });
    expect(result).toMatchObject({ type: 'tool_result' });
    expect((call as { id: string }).id).toBe((result as { id: string }).id);
    expect((call as { id: string }).id).toBeTruthy();
  });
  it('parses the recorded fixture', () => {
    const p = new OpencodeParser();
    const lines = fs.readFileSync(new URL('./fixtures/opencode.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
    const events = lines.flatMap((l) => p.parse(l));
    expect(events.some((e) => e.type === 'assistant_text')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.filter((e) => e.type === 'raw')).toHaveLength(0);
    expect(p.sessionId).toBeTruthy();
    expect(p.takeUsage()).toEqual({ input: 9169, output: 88, reasoning: 0, cacheRead: 12608, cacheWrite: 0 });
  });
});

const step = (reason: string) => ({ type: 'step_finish', sessionID: 'ses_g', part: { type: 'step-finish', reason, cost: 0.001 } });
const said = { type: 'text', sessionID: 'ses_g', part: { type: 'text', text: 'done' } };

describe('OpencodeSession step_finish grace', () => {
  it('ends the turn and kills the lingering process tree after a stop step', withStubbedProcessTable(async () => {
    // 2026-09-17: a DeepSeek worker started a dev server that held the CLI's stdio; the session ran until interrupted.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-grace-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-opencode', lingeringChildBody([said, step('stop')], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const a = new OpencodeAdapter(bin, 300, absentDbPath());
      const started = Date.now();
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      const events: HarnessEvent[] = [];
      for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      expect(Date.now() - started).toBeLessThan(8000);
      expect(events.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
      expect(events.at(-1)).toEqual({ type: 'turn_end', nativeSessionId: 'ses_g', cost: 0.001 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^opencode session s \(pid \d+\) reported step_finish with reason stop but the process is still alive after 0.3 s; killing the process tree$/));
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => !pidExists(childPid), 5000, 'lingering child killed');
      await a.end(h);
    } finally {
      warn.mockRestore();
    }
  }), 30000);

  it('does not arm the grace on a tool-calls step', withStubbedProcessTable(async () => {
    // tool-calls, then 0.5 s of silence (five times the 100 ms grace), then the stop step; the turn must outlive the silence.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-tools-')), 'child.pid');
    const body = [
      "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
      `console.log(${JSON.stringify(JSON.stringify(step('tool-calls')))});`,
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      `setTimeout(() => console.log(${JSON.stringify(JSON.stringify(step('stop')))}), 500);`,
      "c.on('exit', () => process.exit(0));",
    ].join('\n');
    const { bin, dir } = fakeBin('fake-opencode', body);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const a = new OpencodeAdapter(bin, 100, absentDbPath());
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      let spawnedAt = 0;
      for await (const e of a.events(h)) {
        if (e.type === 'process_start') spawnedAt = Date.now();
        if (e.type === 'turn_end') break;
      }
      expect(Date.now() - spawnedAt).toBeGreaterThanOrEqual(400);
      const graceKills = warn.mock.calls.filter(([m]) => String(m).includes('reported step_finish with reason'));
      expect(graceKills).toHaveLength(1);
      expect(String(graceKills[0]?.[0])).toContain('reason stop');
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => !pidExists(childPid), 5000, 'lingering child killed');
      await a.end(h);
    } finally {
      warn.mockRestore();
    }
  }), 30000);

  it.skipIf(process.platform !== 'win32')('sweeps an orphan that holds the session log after the CLI exits on its own', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-orphan-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-opencode', orphanBehindIntermediateBody([said, step('stop')], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const a = new OpencodeAdapter(bin, 300, absentDbPath());
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      const events: HarnessEvent[] = [];
      for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      expect(events.at(-1)).toEqual({ type: 'turn_end', nativeSessionId: 'ses_g', cost: 0.001 });
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(childPid).toBeGreaterThan(0);
      await until(() => !pidExists(childPid), 5000, 'orphan holding the session log killed');
      expect(warn.mock.calls.some(([m]) => String(m).includes('descendant process(es) survived') && String(m).includes(String(childPid)))).toBe(true);
      await a.end(h);
    } finally {
      warn.mockRestore();
    }
  }, 30000);
});

const stepStart = { type: 'step_start', sessionID: 'ses_p', part: { type: 'step-start' } };

describe('OpencodeSession silence grace', () => {
  it('ends a turn silent after a step_start and kills its lingering child', withStubbedProcessTable(async () => {
    // overseer-ialj: a shell call whose grandchild held the output pipe never settled; the log's last line was a step_start.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-silent-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-opencode', lingeringChildBody([stepStart], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const a = new OpencodeAdapter(bin, 5000, absentDbPath(), 500);
      const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      const events: HarnessEvent[] = [];
      for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      expect(events.filter((e) => e.type !== 'process_start')).toEqual([
        { type: 'error', message: 'opencode printed nothing for 0.5 s after its last event (step_start); the turn was ended' },
        { type: 'turn_end', nativeSessionId: 'ses_p', cost: 0 },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^opencode session s \(pid \d+\) printed nothing for 0.5 s after its last event \(step_start\) but the process is still alive after 0 s; killing the process tree$/));
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => !pidExists(childPid), 5000, 'lingering child killed');
      await a.end(h);
    } finally {
      warn.mockRestore();
    }
  }), 30000);

  it('does not end a turn that keeps printing past the silence length', withStubbedProcessTable(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const procs = await import('../util/procs');
    const spawnSpy = vi.spyOn(procs, 'spawnLines');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const startTurn = async (silenceMs = 300) => {
      const source = controlledLineSource();
      spawnSpy.mockReturnValue(controlledLineProcess(source));
      const a = new OpencodeAdapter('opencode', 5000, absentDbPath(), silenceMs, 5000);
      const h = a.start({ cwd: process.cwd(), prompt: 'go' });
      const events: HarnessEvent[] = [];
      const done = (async () => {
        for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      })();
      await source.waitForRead(1);
      return { a, h, source, events, done, end: async () => { source.close(); await a.end(h); } };
    };
    const printedNothingWarnings = () => warn.mock.calls.filter(([m]) => String(m).includes('printed nothing'));
    try {
      const oneLine = await startTurn();
      oneLine.source.push(JSON.stringify(stepStart));
      await oneLine.source.waitForRead(2);
      await vi.advanceTimersByTimeAsync(299);
      expect(oneLine.events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await oneLine.done;
      expect(oneLine.events.map((e) => e.type)).toEqual(['error', 'turn_end']);
      expect(printedNothingWarnings()).toHaveLength(1);
      await oneLine.end();

      warn.mockClear();
      const printing = await startTurn();
      printing.source.push(JSON.stringify(stepStart));
      await printing.source.waitForRead(2);
      const feed = setInterval(() => printing.source.push(JSON.stringify(stepStart)), 250);
      await vi.advanceTimersByTimeAsync(750);
      clearInterval(feed);
      await printing.source.waitForRead(5);
      expect(printing.events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(299);
      expect(printing.events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await printing.done;
      expect(printing.events.map((e) => e.type)).toEqual(['error', 'turn_end']);
      expect(printedNothingWarnings()).toHaveLength(1);
      await printing.end();

      warn.mockClear();
      const exactGap = await startTurn();
      exactGap.source.push(JSON.stringify(stepStart));
      await exactGap.source.waitForRead(2);
      const boundaryLine = new Promise<void>((resolve) => setTimeout(() => {
        exactGap.source.push(JSON.stringify(stepStart));
        resolve();
      }, 300));
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(1);
      await boundaryLine;
      await exactGap.done;
      expect(exactGap.events.map((e) => e.type)).toEqual(['error', 'turn_end']);
      expect(printedNothingWarnings()).toHaveLength(1);
      await exactGap.end();
    } finally {
      spawnSpy.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  }), 30000);

  it('a sub-agent event resets the silence', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_2', 'ses_p', runningTask);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const procs = await import('../util/procs');
    const source = controlledLineSource();
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(controlledLineProcess(source));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let n = 0;
    let feed: NodeJS.Timeout | undefined;
    let adapter: OpencodeAdapter | undefined;
    let handle: SessionHandle | undefined;
    try {
      const a = adapter = new OpencodeAdapter('opencode', 5000, dbPath, 500, TEST_POLL_MS);
      const h = handle = a.start({ cwd: process.cwd(), prompt: 'go' });
      const events: HarnessEvent[] = [];
      const done = (async () => {
        for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
      })();
      await source.waitForRead(1);
      source.push(JSON.stringify(stepStart));
      await source.waitForRead(2);
      feed = setInterval(() => { if (n < 8) add(`prt_c${n}`, 'ses_child', { ...childRead, callID: `call_${n++}` }); }, 100);
      await vi.advanceTimersByTimeAsync(800);
      clearInterval(feed);
      await vi.advanceTimersByTimeAsync(TEST_POLL_MS);
      expect(events.filter((e) => e.type === 'tool_call').length).toBe(8);
      expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(499);
      expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('printed nothing for 0.5 s after its last event (sub-agent tool_call)'));
      expect(warn.mock.calls.filter(([m]) => String(m).includes('printed nothing'))).toHaveLength(1);
    } finally {
      clearInterval(feed);
      source.close();
      if (adapter && handle) await adapter.end(handle);
      spawnSpy.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  }), 30000);
});

describe('OpencodeSession running tool deadline', () => {
  // The part shape opencode 1.18.19 wrote for ses_f4e5b0ae6ffeUC9uNq175q22pw when a bash call started (2026-09-17).
  const bashPart = (callID: string, status: string, start: number, timeout?: number) => ({ type: 'tool', tool: 'bash', callID, state: { status, input: { command: 'pnpm test', ...(timeout === undefined ? {} : { timeout }) }, time: { start, ...(status === 'running' ? {} : { end: start + 1 }) }, metadata: { output: '' } } });
  const silenceMs = 300;
  const silenceError = { type: 'error', message: 'opencode printed nothing for 0.3 s after its last event (step_start); the turn was ended' };

  /** Starts the fake clock before a part's start is taken from it, so its deadline is exact on that clock. */
  const fakeClock = () => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); return Date.now(); };

  /** Runs `body` against one controlled turn whose store is `dbPath`, on the clock `fakeClock` started; the turn has read its step_start at that clock's start. */
  async function withTurn(dbPath: string, body: (t: { events: HarnessEvent[]; source: ReturnType<typeof controlledLineSource>; done: Promise<void>; ended: () => boolean; warn: ReturnType<typeof vi.spyOn> }) => Promise<void>) {
    const procs = await import('../util/procs');
    const source = controlledLineSource();
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(controlledLineProcess(source));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const a = new OpencodeAdapter('opencode', 5000, dbPath, silenceMs, 5000);
    const h = a.start({ cwd: process.cwd(), prompt: 'go' });
    try {
      const events: HarnessEvent[] = [];
      const done = (async () => { for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; } })();
      await source.waitForRead(1);
      source.push(JSON.stringify(stepStart));
      await source.waitForRead(2);
      await body({ events, source, done, ended: () => events.some((e) => e.type === 'turn_end'), warn });
    } finally {
      source.close();
      await a.end(h);
      spawnSpy.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  }

  /** Advances to `at - 1` ms after the step_start and checks the turn is alive, then to `at` and checks it ended as silent. */
  async function expectSilentEndAt(t: { events: HarnessEvent[]; done: Promise<void>; ended: () => boolean }, at: number, elapsed = 0) {
    await vi.advanceTimersByTimeAsync(at - 1 - elapsed);
    expect(t.ended()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    await t.done;
    expect(t.events.filter((e) => e.type === 'error' || e.type === 'turn_end')).toEqual([silenceError, { type: 'turn_end', nativeSessionId: 'ses_p', cost: 0 }]);
  }

  it('a running call whose deadline is past the silence defers the end to the deadline plus the silence', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_b', 'ses_p', bashPart('call_b', 'running', fakeClock(), 1000));
    await withTurn(dbPath, async (t) => {
      await vi.advanceTimersByTimeAsync(silenceMs);
      expect(t.ended()).toBe(false); // today's rule would have ended it here
      await expectSilentEndAt(t, 1000 + silenceMs, silenceMs);
      expect(t.warn.mock.calls.filter(([m]) => String(m).includes('printed nothing'))).toHaveLength(1);
    });
  }), 30000);

  it('of two running calls the later deadline decides', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    const now = fakeClock();
    add('prt_b1', 'ses_p', bashPart('call_1', 'running', now, 600));
    add('prt_b2', 'ses_p', bashPart('call_2', 'running', now, 1000));
    await withTurn(dbPath, (t) => expectSilentEndAt(t, 1000 + silenceMs));
  }), 30000);

  it('a running call with no timeout input gets the 120000 ms default', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_b', 'ses_p', bashPart('call_b', 'running', fakeClock()));
    await withTurn(dbPath, (t) => expectSilentEndAt(t, 120000 + silenceMs));
  }), 30000);

  it('a call an earlier turn left running with a past deadline keeps the normal silence', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_old', 'ses_p', bashPart('call_old', 'running', fakeClock() - 10000, 1000));
    await withTurn(dbPath, (t) => expectSilentEndAt(t, silenceMs));
  }), 30000);

  it('a call that completes and prints its line resets the silence from that line', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    const start = fakeClock();
    add('prt_b', 'ses_p', bashPart('call_b', 'running', start, 1000));
    await withTurn(dbPath, async (t) => {
      await vi.advanceTimersByTimeAsync(200);
      add('prt_b', 'ses_p', bashPart('call_b', 'completed', start, 1000));
      t.source.push(JSON.stringify({ type: 'tool_use', sessionID: 'ses_p', part: { type: 'tool', tool: 'bash', callID: 'call_b', state: { status: 'completed', input: { command: 'pnpm test' }, output: 'ok' } } }));
      await t.source.waitForRead(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
      await vi.advanceTimersByTimeAsync(silenceMs - 1);
      expect(t.ended()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await t.done;
      expect(t.events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'error', 'turn_end']);
      expect(t.events.find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'opencode printed nothing for 0.3 s after its last event (tool_use); the turn was ended' });
    });
  }), 30000);

  it('a missing store keeps the normal silence and says so once', withStubbedProcessTable(async () => {
    fakeClock();
    await withTurn(absentDbPath(), async (t) => {
      await expectSilentEndAt(t, silenceMs);
      expect(t.warn.mock.calls.filter(([m]) => String(m).includes('could not be read for running tool calls'))).toHaveLength(1);
    });
  }), 30000);

  it('a running row that is not JSON keeps the normal silence', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_b', 'ses_p', bashPart('call_b', 'running', fakeClock(), 1000));
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('prt_bad', 'msg_1', 'ses_p', 99, 99, '{"type":"tool","state":{"status":"running"');
    db.close();
    await withTurn(dbPath, async (t) => {
      await expectSilentEndAt(t, silenceMs);
      expect(t.warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read for running tool calls, the silence counts from the last event only: .*JSON/));
    });
  }), 30000);

  it('ignores completed and error parts however far their timeout reaches', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    const now = fakeClock();
    add('prt_c', 'ses_p', bashPart('call_c', 'completed', now, 1500000));
    add('prt_e', 'ses_p', bashPart('call_e', 'error', now, 1500000));
    await withTurn(dbPath, (t) => expectSilentEndAt(t, silenceMs));
  }), 30000);

  it('an interrupt ends the turn at once while a call is running', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_b', 'ses_p', bashPart('call_b', 'running', Date.now(), 1500000));
    const { bin, dir } = fakeBin('fake-opencode', `console.log(${JSON.stringify(JSON.stringify(stepStart))});\nsetInterval(() => {}, 1000);`);
    const logFile = path.join(dir, 's.log');
    // The silence is far past the test's own timeout, so only the interrupt can end this turn.
    const a = new OpencodeAdapter(bin, 5000, dbPath, 10 * 60 * 1000, TEST_POLL_MS);
    const h = a.start({ cwd: dir, prompt: 'go', logFile });
    await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('step_start'), 10000, 'step_start printed');
    await a.interrupt(h);
    const events: HarnessEvent[] = [];
    for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', nativeSessionId: 'ses_p' });
    expect(events.some((e) => e.type === 'error' && e.message.includes('printed nothing'))).toBe(false);
    await a.end(h);
  }), 30000);
});

// A temp opencode store holding the part shapes opencode 1.18.19 wrote for ses_f5089ad2cffe1KEIT75S6ec5X6 on 2026-09-17.
function subagentStore(): { dbPath: string; add: (id: string, session: string, part: object) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-store-'));
  const dbPath = path.join(dir, 'opencode.db');
  // Each add commits synchronously in the test process, so a slow disk flush would block the event loop that drives the
  // feeds. The pragma is per connection: one add took 10.7-11.0 ms with the default and 1.0-1.4 ms with it off.
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA synchronous=OFF');
  db.exec('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)');
  db.close();
  let t = 1;
  const add = (id: string, session: string, part: object) => {
    const d = new DatabaseSync(dbPath);
    d.exec('PRAGMA synchronous=OFF');
    d.prepare('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)').run(id, 'msg_1', session, t, t, JSON.stringify(part));
    t++;
    d.close();
  };
  return { dbPath, add };
}
const runningTask = { type: 'tool', tool: 'task', callID: 'call_task', state: { status: 'running', input: { description: 'Explore locale code and tests', subagent_type: 'explore' }, metadata: { parentSessionId: 'ses_p', sessionId: 'ses_child' }, time: { start: 1 } } };
const childRead = { type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'completed', input: { filePath: 'src/lib/locale.ts' }, output: '<content>' } };
const childText = { type: 'text', text: 'Found the locale module.', time: { start: 1, end: 2 } };

describe('SubagentWatcher', () => {
  it('reports a running sub-agent\'s tool calls and finished text with the task call id, once each', () => {
    const { dbPath, add } = subagentStore();
    add('prt_1', 'ses_p', { type: 'text', text: 'parent text', time: { start: 1, end: 2 } });
    add('prt_2', 'ses_p', runningTask);
    add('prt_3', 'ses_child', { type: 'step-start' });
    add('prt_4', 'ses_child', childRead);
    add('prt_5', 'ses_child', { type: 'text', text: 'still streaming', time: { start: 3 } });
    const w = new SubagentWatcher(dbPath, () => 'ses_p');
    expect(w.poll()).toEqual([
      { type: 'tool_call', id: 'call_read', name: 'read', input: { filePath: 'src/lib/locale.ts' }, parentId: 'call_task' },
    ]);
    add('prt_5', 'ses_child', childText);
    add('prt_6', 'ses_child', { type: 'tool', tool: 'edit', callID: 'call_pending', state: { status: 'pending', input: {} } });
    expect(w.poll()).toEqual([{ type: 'assistant_text', text: 'Found the locale module.', parentId: 'call_task' }]);
    expect(w.poll()).toEqual([]);
  });

  it('reports a sub-agent file edit as a file change, as the parent stream does', () => {
    const { dbPath, add } = subagentStore();
    add('prt_2', 'ses_p', runningTask);
    add('prt_4', 'ses_child', { type: 'tool', tool: 'edit', callID: 'call_edit', state: { status: 'completed', input: { filePath: 'src/lib/locale.ts', oldString: 'a', newString: 'b' }, output: 'ok' } });
    add('prt_5', 'ses_child', { type: 'tool', tool: 'write', callID: 'call_write', state: { status: 'completed', input: { filePath: 'src/lib/new.ts', content: 'x' }, output: 'ok' } });
    const events = new SubagentWatcher(dbPath, () => 'ses_p').poll();
    expect(events.filter((e) => e.type === 'file_change')).toEqual([
      { type: 'file_change', path: 'src/lib/locale.ts' },
      { type: 'file_change', path: 'src/lib/new.ts' },
    ]);
  });

  it('reports nothing for a session without sub-agents or without a store', () => {
    const { dbPath, add } = subagentStore();
    add('prt_1', 'ses_p', { type: 'text', text: 'parent text', time: { start: 1, end: 2 } });
    add('prt_2', 'ses_p', { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed', input: { filePath: 'a' }, output: 'x' } });
    expect(new SubagentWatcher(dbPath, () => 'ses_p').poll()).toEqual([]);
    const missing = path.join(path.dirname(dbPath), 'missing.db');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      expect(new SubagentWatcher(missing, () => 'ses_p').poll()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`opencode sub-agent store ${missing} does not exist, sub-agent activity is not followed`);
    } finally { warn.mockRestore(); }
  });

  it('a resumed watcher reports only sub-agent activity that appears after its first poll', () => {
    const { dbPath, add } = subagentStore();
    add('prt_2', 'ses_p', { ...runningTask, state: { ...runningTask.state, status: 'completed', output: 'report' } });
    add('prt_4', 'ses_child', childRead);
    add('prt_5', 'ses_child', childText);
    const w = new SubagentWatcher(dbPath, () => 'ses_p', true);
    expect(w.poll()).toEqual([]);
    add('prt_6', 'ses_child', { type: 'tool', tool: 'grep', callID: 'call_grep', state: { status: 'completed', input: { pattern: 'x' }, output: '' } });
    expect(w.poll()).toEqual([{ type: 'tool_call', id: 'call_grep', name: 'grep', input: { pattern: 'x' }, parentId: 'call_task' }]);
  });
});

describe('OpencodeSession sub-agent activity', () => {
  it('streams the sub-agent\'s events before the parent\'s finished task call, which stays unchanged', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_2', 'ses_p', runningTask);
    add('prt_4', 'ses_child', childRead);
    add('prt_5', 'ses_child', childText);
    const task = { type: 'tool_use', sessionID: 'ses_p', part: { ...runningTask, state: { ...runningTask.state, status: 'completed', output: 'report' } } };
    const lines = [{ type: 'step_start', sessionID: 'ses_p', part: { type: 'step-start' } }, task, { ...step('stop'), sessionID: 'ses_p' }];
    const { bin, dir } = fakeBin('fake-opencode', lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n'));
    const a = new OpencodeAdapter(bin, 5000, dbPath, undefined, TEST_POLL_MS);
    const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
    const events: HarnessEvent[] = [];
    for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
    await a.end(h);
    expect(events.filter((e) => e.type !== 'process_start')).toEqual([
      { type: 'tool_call', id: 'call_read', name: 'read', input: { filePath: 'src/lib/locale.ts' }, parentId: 'call_task' },
      { type: 'assistant_text', text: 'Found the locale module.', parentId: 'call_task' },
      { type: 'tool_call', id: 'call_task', name: 'task', input: runningTask.state.input },
      { type: 'tool_result', id: 'call_task', output: 'report' },
      { type: 'turn_end', nativeSessionId: 'ses_p', cost: 0.001 },
    ]);
  }), 30000);

  it('a resumed session does not replay sub-agent activity from earlier turns', withStubbedProcessTable(async () => {
    const { dbPath, add } = subagentStore();
    add('prt_2', 'ses_p', { ...runningTask, state: { ...runningTask.state, status: 'completed', output: 'report' } });
    add('prt_4', 'ses_child', childRead);
    add('prt_5', 'ses_child', childText);
    const lines = [{ type: 'step_start', sessionID: 'ses_p', part: { type: 'step-start' } }, { ...step('stop'), sessionID: 'ses_p' }];
    const { bin, dir } = fakeBin('fake-opencode', lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n'));
    const a = new OpencodeAdapter(bin, 5000, dbPath, undefined, TEST_POLL_MS);
    const h = a.start({ cwd: dir, prompt: 'go', resumeId: 'ses_p', logFile: path.join(dir, 's.log') });
    const events: HarnessEvent[] = [];
    for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
    await a.end(h);
    expect(events.filter((e) => e.type !== 'process_start')).toEqual([{ type: 'turn_end', nativeSessionId: 'ses_p', cost: 0.001 }]);
  }), 30000);

  it('logs once when the sub-agent store cannot be read', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-store-')), 'opencode.db');
    new DatabaseSync(dbPath).close(); // a store without the part table
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const w = new SubagentWatcher(dbPath, () => 'ses_p');
      expect(w.poll()).toEqual([]);
      expect(w.poll()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(dbPath);
    } finally { warn.mockRestore(); }
  });

  it('an adopted session without a recorded native session id does not replay sub-agent activity', withStubbedProcessTable(async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const { dbPath, add } = subagentStore();
      add('prt_2', 'ses_p', { ...runningTask, state: { ...runningTask.state, status: 'completed', output: 'report' } });
      add('prt_4', 'ses_child', childRead);
      add('prt_5', 'ses_child', childText);
      const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-adopt-')), 'w.log');
      const p = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
      const a = new OpencodeAdapter('opencode', 100, dbPath, undefined, TEST_POLL_MS);
      const h = a.adopt({ pid: p.pid!, cwd: '.', logFile, logOffset: 0, nativeSessionId: null }); // the row is written at turn_end, so a first-turn adoption has none
      const events: HarnessEvent[] = [];
      const consumed = (async () => { for await (const e of a.events(h)) events.push(e); })();
      fs.appendFileSync(logFile, JSON.stringify({ type: 'step_start', sessionID: 'ses_p', part: { type: 'step-start' } }) + '\n');
      fs.appendFileSync(logFile, JSON.stringify({ ...step('stop'), sessionID: 'ses_p' }) + '\n');
      await until(() => events.some((e) => e.type === 'turn_end'), 10000, 'turn end from the adopted log');
      await a.end(h);
      await consumed;
      expect(events.filter((e) => e.type !== 'process_start')).toEqual([{ type: 'turn_end', nativeSessionId: 'ses_p', cost: 0.001 }]);
      await p.exit;
    } finally { warn.mockRestore(); }
  }), 30000);

  it('an adopted session takes the native id from its log and reports sub-agent work while the parent is silent', withStubbedProcessTable(async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const { dbPath, add } = subagentStore();
      add('prt_2', 'ses_p', runningTask);
      add('prt_4', 'ses_child', childRead);
      const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-adopt-')), 'w.log');
      const p = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
      fs.appendFileSync(logFile, JSON.stringify({ type: 'step_start', sessionID: 'ses_p', part: { type: 'step-start' } }) + '\n');
      const offset = fs.statSync(logFile).size; // the earlier daemon consumed the line, and the row holds no native id yet
      const a = new OpencodeAdapter('opencode', 100, dbPath, undefined, TEST_POLL_MS);
      const h = a.adopt({ pid: p.pid!, cwd: '.', logFile, logOffset: offset, nativeSessionId: null });
      const events: HarnessEvent[] = [];
      const consumed = (async () => { for await (const e of a.events(h)) events.push(e); })();
      add('prt_6', 'ses_child', { type: 'tool', tool: 'grep', callID: 'call_grep', state: { status: 'completed', input: { pattern: 'x' }, output: '' } });
      await until(() => events.some((e) => e.type === 'tool_call'), 10000, 'sub-agent activity with no new log line');
      fs.appendFileSync(logFile, JSON.stringify({ ...step('stop'), sessionID: 'ses_p' }) + '\n');
      await until(() => events.some((e) => e.type === 'turn_end'), 10000, 'turn end from the adopted log');
      await a.end(h);
      await consumed;
      expect(events.filter((e) => e.type !== 'process_start')).toEqual([
        { type: 'tool_call', id: 'call_grep', name: 'grep', input: { pattern: 'x' }, parentId: 'call_task' },
        { type: 'turn_end', nativeSessionId: 'ses_p', cost: 0.001 },
      ]);
      await p.exit;
    } finally { warn.mockRestore(); }
  }), 30000);
});

describe('OpencodeSession interrupt sweep', () => {
  it.skipIf(process.platform !== 'win32')('interrupt kills a detached child left behind an exited intermediate', async () => {
    // 2026-09-17: an interrupted worker left the dev server it had started running. A parent-pid walk from the CLI
    // cannot reach it (the intermediate that started it has exited), but it holds both session logs.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-interrupt-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-opencode', lingeringOrphanBehindIntermediateBody([said], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let childPid = 0;
    try {
      const a = new OpencodeAdapter(bin, 300, absentDbPath());
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
  }, 30000);

  it.skipIf(process.platform !== 'win32')('interrupt leaves a log holder that started before the session alone', async () => {
    // The sweep's notBefore guard: a process holding the session logs that predates the CLI is not a descendant and
    // must survive, even as the sweep kills the child the interrupted worker started.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opencode-predate-'));
    const logFile = path.join(dir, 's.log');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(logFile + '.err', '');
    const holder = spawn(process.execPath, ['-e', "require('node:fs').openSync(process.argv[1], 'r'); require('node:fs').openSync(process.argv[2], 'r'); setInterval(()=>{},1000)", logFile, logFile + '.err'], { stdio: 'ignore' });
    const pidFile = path.join(dir, 'child.pid');
    const { bin, dir: binDir } = fakeBin('fake-opencode', lingeringOrphanBehindIntermediateBody([said], pidFile));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let childPid = 0;
    try {
      await until(() => pidExists(holder.pid!), 5000, 'pre-session holder started');
      const a = new OpencodeAdapter(bin, 300, absentDbPath());
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
  }, 30000);
});
