import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLine, claudeArgs, ClaudeAdapter, CONTEXT_MODE_PLUGIN, sessionSettings, denyBackgroundSettings, evalSandboxSettings, DENY_BACKGROUND_HOOK, DENY_EVAL_SIDE_EFFECTS_HOOK, PROMPT_EVAL_TOOLS } from './claude';
import type { HarnessEvent } from './types';

const TEST_POLL_MS = 10;
const TEST_WAIT_MS = 5000;
/**
 * Wait for a killed process to leave the process table once the end-of-session sweep that killed it has finished.
 * The sweep's own PowerShell queries swing with machine load, so tests await the sweep itself (`onSweep`) instead of
 * polling on a clock that includes it; this bound then covers only `taskkill` taking effect.
 */
const KILLED_WAIT_MS = 1000;
import { spawnLines, killProcess, pidExists, descendantPids, fileHolders } from '../util/procs';
import type { LineProcess } from '../util/procs';
import { until } from '../test/until';
import { fakeBin, lingeringChildBody, lingeringOrphanBehindIntermediateBody } from '../test/fakeBin';
import { withStubbedProcessTable } from '../test/procTableStub';

vi.mock('node:child_process', async (orig) => (await import('../test/procTableStub')).stubbableChildProcess(await orig()));

describe('claudeArgs', () => {
  it('builds a new-session command line', () => {
    const a = claudeArgs({ cwd: '.', prompt: 'x' }, 'abc', false, null);
    expect(a).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--session-id', 'abc']);
  });
  it('builds a resume command line with prompt file and mcp config', () => {
    const a = claudeArgs({ cwd: '.', prompt: 'x', systemPromptFile: '/p.md', mcpServers: [{ name: 'overseer', url: 'http://127.0.0.1:4400/mcp' }] }, 'abc', true, '/tmp/mcp.json');
    expect(a).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--resume', 'abc', '--append-system-prompt-file', '/p.md', '--mcp-config', '/tmp/mcp.json']);
  });
  it('adds model and effort', () => {
    const a = claudeArgs({ cwd: '.', prompt: 'x', model: 'sonnet', effort: 'medium' }, 'abc', false, null);
    expect(a).toContain('--model'); expect(a).toContain('sonnet'); expect(a).toContain('--effort'); expect(a).toContain('medium');
  });
  it('restricts eval sessions to the read-oriented built-in tool set', () => {
    const a = claudeArgs({ cwd: '.', prompt: 'x', tools: [...PROMPT_EVAL_TOOLS] }, 'abc', false, null);
    expect(a.slice(-2)).toEqual(['--tools', 'Bash,Read,Grep,Glob']);
  });
  it('adds the strict MCP flag, the spending cap and no session persistence only when asked', () => {
    const a = claudeArgs({ cwd: '.', prompt: 'x', mcpServers: [{ name: 'overseer', url: 'http://127.0.0.1:5000/mcp' }], strictMcpConfig: true, maxBudgetUsd: 2.5, noSessionPersistence: true }, 'abc', false, '/tmp/mcp.json');
    expect(a.slice(-6)).toEqual(['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config', '--max-budget-usd', '2.50', '--no-session-persistence']);
    const plain = claudeArgs({ cwd: '.', prompt: 'x' }, 'abc', false, '/tmp/mcp.json');
    expect(plain).not.toContain('--strict-mcp-config');
    expect(plain).not.toContain('--max-budget-usd');
    expect(plain).not.toContain('--no-session-persistence');
  });
  it('passes the settings file when one is given', () => {
    const a = claudeArgs({ cwd: '.', prompt: 'x', denyBackground: true }, 'abc', false, null, '/tmp/settings.json');
    expect(a.slice(-2)).toEqual(['--settings', '/tmp/settings.json']);
  });
});

describe('denyBackgroundSettings', () => {
  it('wires the hook script as a PreToolUse hook on Bash with a shell-safe path', () => {
    const s = denyBackgroundSettings('C:\\ov er\\hooks\\deny-background.cjs') as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:/ov er/hooks/deny-background.cjs"' }] }]);
    expect(fs.existsSync(DENY_BACKGROUND_HOOK)).toBe(true);
  });
});

describe('sessionSettings', () => {
  it('disables the context-mode plugin for workers and critics only', () => {
    expect(CONTEXT_MODE_PLUGIN).toBe('context-mode@context-mode');
    const worker = sessionSettings({ cwd: '.', prompt: 'x', role: 'worker', denyBackground: true });
    expect(worker?.enabledPlugins).toEqual({ 'context-mode@context-mode': false });
    expect(worker?.hooks?.PreToolUse).toEqual((denyBackgroundSettings() as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse); // the Bash guard stays
    expect(sessionSettings({ cwd: '.', prompt: 'x', role: 'critic' })).toEqual({ enabledPlugins: { 'context-mode@context-mode': false } });
    expect(sessionSettings({ cwd: '.', prompt: 'x', role: 'orchestrator' })).toBeNull();
    expect(sessionSettings({ cwd: '.', prompt: 'x', role: 'discussion' })).toBeNull();
    expect(sessionSettings({ cwd: '.', prompt: 'x' })).toBeNull();
    expect(sessionSettings({ cwd: '.', prompt: 'x', role: 'orchestrator', evalSandbox: true })).not.toHaveProperty('enabledPlugins');
  });

  it.each(['worker', 'critic', 'orchestrator'] as const)('writes the %s settings file the CLI receives', (role) => withStubbedProcessTable(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-role-settings-'));
    const argvFile = path.join(dir, 'argv.json');
    const { bin } = fakeBin(`fake-claude-${role}-settings`, [
      "const fs = require('node:fs');",
      "const i = process.argv.indexOf('--settings');",
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(i < 0 ? null : JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'))));`,
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
    ].join('\n'));
    const a = new ClaudeAdapter(bin, TEST_POLL_MS);
    const h = a.start({ cwd: dir, prompt: 'go', role, denyBackground: role === 'worker' });
    try {
      await until(() => fs.existsSync(argvFile), TEST_WAIT_MS, 'the fake CLI recorded its settings');
      const settings = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as { enabledPlugins?: Record<string, boolean>; hooks?: unknown } | null;
      if (role === 'orchestrator') expect(settings).toBeNull(); // no --settings: the user's plugins, context-mode included, stay on
      else expect(settings?.enabledPlugins).toEqual({ 'context-mode@context-mode': false });
      if (role === 'worker') expect(settings?.hooks).toBeDefined();
    } finally {
      await a.interrupt(h); await a.end(h);
    }
  })(), 20000);
});

describe('evalSandboxSettings', () => {
  it('hooks network, port-probe, shell and file tools before they run', () => {
    const settings = evalSandboxSettings('C:\\eval hooks\\deny-eval-side-effects.cjs') as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
    expect(settings.hooks.PreToolUse.map((h) => h.matcher)).toEqual(['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'WebSearch', 'WebFetch', 'Task']);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('node "C:/eval hooks/deny-eval-side-effects.cjs"');
    expect(fs.existsSync(DENY_EVAL_SIDE_EFFECTS_HOOK)).toBe(true);
  });
});

describe.sequential('ClaudeAdapter generated session config', () => {
  it('writes it in the OS temp dir, not into the repository, and puts no credential in it', withStubbedProcessTable(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-mcp-'));
    const argvFile = path.join(dir, 'argv.json');
    const { bin } = fakeBin('fake-claude-mcp', [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));`,
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ].join('\n'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-repo-cwd-'));
    const a = new ClaudeAdapter(bin, TEST_POLL_MS);
    const h = a.start({ cwd, prompt: 'go', mcpServers: [{ name: 'overseer', url: 'http://127.0.0.1:5399/mcp' }] });
    try {
      await until(() => fs.existsSync(argvFile), TEST_WAIT_MS, 'the fake CLI recorded its arguments');
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
      const config = argv[argv.indexOf('--mcp-config') + 1]!;
      const outsideRepo = path.relative(cwd, config);
      const insideTemp = path.relative(os.tmpdir(), config);
      expect(outsideRepo.startsWith('..') || path.isAbsolute(outsideRepo)).toBe(true); // never inside the worktree it runs in
      expect(insideTemp && !insideTemp.startsWith('..') && !path.isAbsolute(insideTemp)).toBe(true); // the OS temp dir instead
      expect(fs.readdirSync(cwd)).toEqual([]); // nothing generated in the repository
      // The one generated config carries the daemon's URL and no account material.
      expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ mcpServers: { overseer: { type: 'http', url: 'http://127.0.0.1:5399/mcp' } } });
    } finally {
      await a.interrupt(h); await a.end(h);
    }
  }), 20000);

  it('passes the eval sandbox hook settings to the CLI without writing them into its cwd', withStubbedProcessTable(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-eval-settings-'));
    const argvFile = path.join(dir, 'argv.json');
    const { bin } = fakeBin('fake-claude-eval-settings', [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));`,
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
    ].join('\n'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-eval-cwd-'));
    const a = new ClaudeAdapter(bin, TEST_POLL_MS);
    const h = a.start({ cwd, prompt: 'go', evalSandbox: true, denyBackground: true, tools: [...PROMPT_EVAL_TOOLS] });
    try {
      await until(() => fs.existsSync(argvFile), TEST_WAIT_MS, 'the fake CLI recorded its eval arguments');
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
      const settingsPath = argv[argv.indexOf('--settings') + 1]!;
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
      expect(argv).toContain('--tools');
      expect(argv[argv.indexOf('--tools') + 1]).toBe('Bash,Read,Grep,Glob');
      expect(settings.hooks.PreToolUse.map((hook) => hook.matcher)).toEqual(['Bash', 'Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'WebSearch', 'WebFetch', 'Task']);
      const evalBashGuard = settings.hooks.PreToolUse.find((hook) => hook.matcher === 'Bash' && hook.hooks.some((item) => item.command.includes('deny-eval-side-effects.cjs')));
      expect(evalBashGuard).toBeDefined();
      const blocked = spawnSync(process.execPath, [DENY_EVAL_SIDE_EFFECTS_HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'glab api projects' }, cwd }), encoding: 'utf8',
      });
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toMatch(/network and local-port access are blocked/);
      expect(fs.readdirSync(cwd)).toEqual([]);
    } finally {
      await a.interrupt(h); await a.end(h);
    }
  }), 20000);
});

describe('parseClaudeLine', () => {
  it('maps assistant text and tool_use with file_change', () => {
    const line = JSON.stringify({ type: 'assistant', parent_tool_use_id: 'p1', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }] } });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'assistant_text', text: 'hi' },
      { type: 'tool_call', id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' }, parentId: 'p1' },
      { type: 'file_change', path: 'a.txt' },
    ]);
  });
  it('maps tool_result, result, system, garbage', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }))).toEqual([{ type: 'tool_result', id: 't1', output: 'ok' }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: 0.5 }))).toEqual([{ type: 'turn_end', nativeSessionId: 's', cost: 0.5 }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' }))).toEqual([{ type: 'error', message: 'error_max_turns' }, { type: 'turn_end', nativeSessionId: 's', cost: undefined }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789247400 } }))).toEqual([{ type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-12T21:10:00.000Z', raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789247400 } } }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual([{ type: 'rate_limit', kind: 'rate_limit', bucket: null, resetsAt: null, raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }))).toEqual([]);
    // Context: the main thread's usage per assistant message (input + cache creation + cache read), the windows per model at turn end; a subagent's message is not the orchestrator's context.
    const usage = { input_tokens: 2, cache_creation_input_tokens: 40, cache_read_input_tokens: 58 };
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { model: 'claude-x', usage, content: [{ type: 'text', text: 'hi' }] } }))).toEqual([{ type: 'context', tokens: 100, model: 'claude-x' }, { type: 'assistant_text', text: 'hi' }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'p1', message: { model: 'claude-x', usage, content: [] } }))).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, session_id: 's', total_cost_usd: 1, modelUsage: { 'claude-x': { contextWindow: 200000 }, other: {} } }))).toEqual([{ type: 'turn_end', nativeSessionId: 's', cost: 1, contextWindows: { 'claude-x': 200000 } }]);
    // The 1-hour cache slice (`cache_creation.ephemeral_1h_input_tokens`) is carried alongside the combined `cacheWrite` total.
    expect(parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, session_id: 's', usage: { input_tokens: 1, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 200 } } })))
      .toEqual([{ type: 'turn_end', nativeSessionId: 's', cost: undefined, usage: { input: 1, cacheWrite: 500, cacheWrite1h: 300 } }]);
    expect(parseClaudeLine('not json')).toEqual([{ type: 'raw', line: 'not json' }]);
  });
  it('parses the recorded fixture', () => {
    const lines = fs.readFileSync(new URL('./fixtures/claude.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
    const events = lines.flatMap(parseClaudeLine);
    expect(events.some((e) => e.type === 'assistant_text')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    const ends = events.filter((e) => e.type === 'turn_end');
    expect(ends).toHaveLength(1);
    expect((ends[0] as { nativeSessionId: string }).nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ends[0]).toMatchObject({ usage: { input: 34, output: 231, cacheRead: 43017, cacheWrite: 43514, cacheWrite1h: 43514, reasoning: 0 } });
    expect(events.filter((e) => e.type === 'raw')).toHaveLength(0);
    // The recorded events are `status: allowed` usage updates, not a stop condition.
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });
});

describe('parseClaudeLine auth failures', () => {
  // Three turns: the expired and revoked samples, then a recorded run with an invalid token. Each is api_retry line(s), assistant, result.
  const lines = fs.readFileSync(new URL('./fixtures/claude-auth-401.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
  const [expired, revoked, recorded] = [lines.slice(0, 3), lines.slice(3, 6), lines.slice(6)];
  const assistantEvents = (turn: string[]) => parseClaudeLine(turn.find((l) => JSON.parse(l).type === 'assistant')!).filter((e) => e.type !== 'context');

  it('turns the expired-token reply into one auth_failed event and no assistant_text', () => {
    expect(assistantEvents(expired)).toEqual([{ type: 'auth_failed', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.', error: 'authentication_failed' }]);
  });
  it('turns the revoked-token reply into one auth_failed event and no assistant_text', () => {
    expect(assistantEvents(revoked)).toEqual([{ type: 'auth_failed', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked. Re-authenticate to continue.', error: 'authentication_failed' }]);
  });
  it('turns the recorded invalid-token reply into one auth_failed event and no assistant_text', () => {
    expect(assistantEvents(recorded)).toEqual([{ type: 'auth_failed', text: 'Failed to authenticate. API Error: 401 Invalid bearer token', error: 'authentication_failed' }]);
    const all = recorded.flatMap(parseClaudeLine);
    expect(all.filter((e) => e.type === 'assistant_text')).toHaveLength(0);
    expect(all.filter((e) => e.type === 'auth_failed')).toHaveLength(1);
  });
  it('leaves api_retry lines unsurfaced', () => {
    const retries = lines.filter((l) => JSON.parse(l).subtype === 'api_retry');
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.flatMap(parseClaudeLine)).toEqual([]);
  });
  it('marks a 401 result turn_end as an auth failure and keeps its error event', () => {
    for (const turn of [expired, revoked, recorded]) {
      const events = parseClaudeLine(turn.at(-1)!);
      expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('401') });
      expect(events.find((e) => e.type === 'turn_end')).toMatchObject({ authFailed: true });
    }
  });
  it('does not mark a normal result or an error result with another status', () => {
    const normal = parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, session_id: 's' })).find((e) => e.type === 'turn_end');
    const overloaded = parseClaudeLine(JSON.stringify({ type: 'result', is_error: true, api_error_status: 529, session_id: 's', result: 'Overloaded' })).find((e) => e.type === 'turn_end');
    expect(normal).toBeDefined(); expect(normal).not.toHaveProperty('authFailed');
    expect(overloaded).toBeDefined(); expect(overloaded).not.toHaveProperty('authFailed');
  });
  it('keeps an ordinary text that mentions 401 OAuth as assistant_text', () => {
    const text = 'The server answered 401 OAuth access token has expired.';
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))).toEqual([{ type: 'assistant_text', text }]);
  });
  it('keeps assistant_text for authentication_failed without is_api_error_message', () => {
    const text = 'Failed to authenticate. API Error: 401 Invalid bearer token';
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text }] } }))).toEqual([{ type: 'assistant_text', text }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', error: 'authentication_failed', is_api_error_message: false, message: { content: [{ type: 'text', text }] } }))).toEqual([{ type: 'assistant_text', text }]);
  });
  it('emits one auth_failed event for an auth reply with two text blocks', () => {
    const line = JSON.stringify({ type: 'assistant', error: 'authentication_failed', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Failed to authenticate.' }, { type: 'text', text: 'API Error: 401' }] } });
    expect(parseClaudeLine(line)).toEqual([{ type: 'auth_failed', text: 'Failed to authenticate.\nAPI Error: 401', error: 'authentication_failed' }]);
  });
  it('keeps assistant_text for an error value other than authentication_failed', () => {
    const text = 'API Error: 529 Overloaded';
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', error: 'server_error', is_api_error_message: true, message: { content: [{ type: 'text', text }] } }))).toEqual([{ type: 'assistant_text', text }]);
  });
});

describe('ClaudeAdapter crash', () => {
  it('closes queue and completes iteration on abnormal exit', async () => {
    const adapter = new ClaudeAdapter('node');
    const handle = adapter.start({ cwd: process.cwd(), prompt: 'x' });
    const events = [];
    for await (const ev of adapter.events(handle)) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'process_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect((events.find((e) => e.type === 'error') as { message: string } | undefined)?.message).toMatch(/exited with code \d+/);
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(0);
    await adapter.end(handle);
  }, 15000);
});

describe.sequential('ClaudeAdapter after result', () => {
  function orphanBeforeResult(warn: (message: string) => void = () => {}) {
    const { bin, dir } = fakeBin('fake-claude-orphan-before-result', [
      "const fs = require('node:fs'); const { spawnSync } = require('node:child_process');",
      "process.stdin.once('data', () => {",
      `  spawnSync(process.execPath, ['-e', ${JSON.stringify([
        "const fs = require('node:fs');",
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
        "c.unref(); fs.writeFileSync('pids.json', JSON.stringify({ parent: process.pid, child: c.pid }));",
      ].join('\n'))}], { stdio: 'ignore' });`,
      `  console.log(${JSON.stringify(JSON.stringify({ type: 'result', is_error: false, session_id: 'n1' }))});`,
      '});',
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ].join('\n'));
    const logFile = path.join(dir, 's.log');
    const pidFile = path.join(dir, 'pids.json');
    const sweeps: Promise<void>[] = [];
    const a = new ClaudeAdapter(bin, TEST_POLL_MS, warn, (s) => sweeps.push(s));
    const h = a.start({ cwd: dir, prompt: 'go', logFile });
    return { a, h, logFile, pidFile, sweeps };
  }

  it('records the missing detached child after its intermediate exits before result', async () => {
    const { a, h, logFile, pidFile } = orphanBeforeResult();
    let child: number | undefined;
    try {
      for await (const e of a.events(h)) { if (e.type === 'turn_end') break; }
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { parent: number; child: number };
      child = pids.child;
      expect(pidExists(h.pid!)).toBe(true);
      expect(pidExists(pids.parent)).toBe(false);
      expect(pidExists(child)).toBe(true);
      // Two independent PowerShell queries: run them together so the test pays one startup instead of two.
      const [tree, holders] = await Promise.all([descendantPids(h.pid!), fileHolders(logFile, logFile + '.err')]);
      expect(tree).not.toContain(child);
      expect(holders).not.toContain(child);
    } finally {
      if (child && pidExists(child)) await killProcess(child);
      await a.interrupt(h); await a.end(h);
    }
  }, 30000);

  // Known failure (overseer-xnj): both prescribed snapshots happen after the intermediate exits, so neither can
  // discover this child. Keep the desired cleanup assertion as an expected failure until capture timing is resolved.
  it.fails('end() removes the recorded detached child', async () => {
    const { a, h, pidFile, sweeps } = orphanBeforeResult();
    let ended = false;
    try {
      for await (const e of a.events(h)) { if (e.type === 'turn_end') break; }
      const { child } = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { child: number };
      await a.end(h);
      ended = true;
      await Promise.all(sweeps);
      await until(() => !pidExists(child), KILLED_WAIT_MS, 'detached child gone after end');
    } finally {
      if (!ended) { await a.interrupt(h); await a.end(h); }
      if (fs.existsSync(pidFile)) {
        const { child } = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { child: number };
        if (pidExists(child)) await killProcess(child);
        await until(() => !pidExists(child), TEST_WAIT_MS, 'proof child cleaned up');
      }
    }
  }, 30000);

  it('leaves the process alive after its result line: one claude process serves the whole session', withStubbedProcessTable(async () => {
    // Unlike codex, `claude -p --input-format stream-json` idles between messages by design (a keepAlive orchestrator
    // session), so a result line must not arm a kill; the process goes when the session ends.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-linger-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-claude', lingeringChildBody([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', is_error: false, session_id: 'n1', total_cost_usd: 0.1 },
    ], pidFile));
    const warnings: string[] = [];
    const a = new ClaudeAdapter(bin, TEST_POLL_MS, (m) => warnings.push(m));
    const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
    const events: HarnessEvent[] = [];
    for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
    expect(events.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
    await until(() => fs.existsSync(pidFile), TEST_WAIT_MS, 'lingering child pid written');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pidExists(h.pid!)).toBe(true);
    expect(pidExists(childPid)).toBe(true);
    expect(warnings).toEqual([]);
    await a.interrupt(h);
    await a.end(h);
    await until(() => !pidExists(childPid), TEST_WAIT_MS, 'child gone after end');
  }), 15000);

  // Windows only: on POSIX a detached orphan is re-parented to init and escapes the parent-pid walk.
  it.skipIf(process.platform !== 'win32')('end() sweeps a detached child that holds the session log after the CLI exits at stdin EOF', async () => {
    // With a log file the CLI's stdout is a file handle: a dev server the worker left running keeps it open after
    // `claude -p` exits, so nothing in end() would otherwise reach it and the orphaned tree outlives the session.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-orphan-')), 'child.pid');
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', is_error: false, session_id: 'n1', total_cost_usd: 0.1 },
    ];
    const { bin, dir } = fakeBin('fake-claude', [
      "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
      ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit', detached: true });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref();`,
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));", // like claude -p: exits at stdin EOF
    ].join('\n'));
    const warnings: string[] = [];
    const sweeps: Promise<void>[] = [];
    const a = new ClaudeAdapter(bin, TEST_POLL_MS, (m) => warnings.push(m), (s) => sweeps.push(s));
    const h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
    const events: HarnessEvent[] = [];
    for await (const e of a.events(h)) { events.push(e); if (e.type === 'turn_end') break; }
    expect(events.map((e) => e.type)).toEqual(['process_start', 'assistant_text', 'turn_end']);
    await until(() => fs.existsSync(pidFile), TEST_WAIT_MS, 'child pid written');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pidExists(childPid)).toBe(true);
    await a.end(h);
    expect(pidExists(h.pid!)).toBe(false);
    // end() runs the sweep detached, and its PowerShell queries take seconds under load: await the sweep, then the kill.
    expect(sweeps).toHaveLength(1);
    await sweeps[0];
    await until(() => !pidExists(childPid), KILLED_WAIT_MS, 'orphaned child killed at end()');
    expect(warnings).toContainEqual(expect.stringMatching(/killing/));
  }, 30000);
});

describe('ClaudeAdapter interrupt sweep', () => {
  // Windows only: on POSIX a detached orphan is re-parented to init and escapes the parent-pid walk.
  it.skipIf(process.platform !== 'win32')('interrupt kills a detached child left behind an exited intermediate', async () => {
    // 2026-09-17: a stopped worker's dev server and test daemons were still running hours later. The parent-pid walk
    // from the CLI cannot reach one left behind an exited intermediate, but it holds both session logs.
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-interrupt-')), 'child.pid');
    const { bin, dir } = fakeBin('fake-claude', lingeringOrphanBehindIntermediateBody([], pidFile));
    const warnings: string[] = [];
    const sweeps: Promise<void>[] = [];
    const a = new ClaudeAdapter(bin, TEST_POLL_MS, (m) => warnings.push(m), (s) => sweeps.push(s));
    let h: ReturnType<ClaudeAdapter['start']> | undefined;
    let childPid = 0;
    try {
      h = a.start({ cwd: dir, prompt: 'go', logFile: path.join(dir, 's.log') });
      await until(() => fs.existsSync(pidFile) && fs.existsSync(pidFile + '.ready'), TEST_WAIT_MS, 'orphan started, intermediate exited');
      childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(pidExists(childPid)).toBe(true);
      await a.interrupt(h);
      // The interrupt sweep runs detached: await it, then the kill, instead of racing a shared log spy.
      expect(sweeps).toHaveLength(1);
      await sweeps[0];
      await until(() => !pidExists(childPid), KILLED_WAIT_MS, 'detached child killed at interrupt');
      expect(warnings).toContainEqual(expect.stringMatching(/descendant process\(es\) survived/));
    } finally {
      if (h) await a.end(h);
      if (childPid && pidExists(childPid)) await killProcess(childPid);
    }
  }, 20000);
});

describe.sequential('ClaudeAdapter adoption', () => {
  const child = (logFile: string) => spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile, pollMs: TEST_POLL_MS });

  it('reads a turn end appended to the log of an adopted process and ends once it exits', withStubbedProcessTable(async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-')), 'w.log');
    const p = child(logFile);
    const offsets: number[] = [];
    const a = new ClaudeAdapter('claude', TEST_POLL_MS);
    const h = a.adopt({ pid: p.pid!, cwd: '.', logFile, logOffset: 0, nativeSessionId: 'n1', onLogOffset: (o) => offsets.push(o) });
    expect(h.pid).toBe(p.pid);
    const events: HarnessEvent[] = [];
    const consumed = (async () => { for await (const ev of a.events(h)) events.push(ev); })();
    fs.appendFileSync(logFile, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }) + '\n');
    fs.appendFileSync(logFile, JSON.stringify({ type: 'result', is_error: false, session_id: 'n1', total_cost_usd: 0.1 }) + '\n');
    await until(() => events.some((e) => e.type === 'turn_end'), TEST_WAIT_MS, 'turn end from the log');
    expect(events).toEqual([{ type: 'assistant_text', text: 'done' }, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 }]);
    expect(offsets.at(-1)).toBe(fs.statSync(logFile).size);
    await killProcess(p.pid!); // claude exits on its own after the turn; the fake child does not
    await a.end(h);
    await consumed;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    await p.exit;
  }));

  it('interrupt kills an adopted process and reports the unfinished turn', withStubbedProcessTable(async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-')), 'w.log');
    const p = child(logFile);
    const a = new ClaudeAdapter('claude', TEST_POLL_MS);
    const h = a.adopt({ pid: p.pid!, cwd: '.', logFile, logOffset: 0, nativeSessionId: null });
    const events: HarnessEvent[] = [];
    const consumed = (async () => { for await (const ev of a.events(h)) events.push(ev); })();
    await a.interrupt(h);
    await until(() => !pidExists(p.pid!), TEST_WAIT_MS, 'adopted process killed');
    await consumed;
    expect(events).toEqual([{ type: 'error', message: 'claude exited without finishing its turn' }]);
    await p.exit;
  }));
});

describe('ClaudeSession env after adopt', () => {
  it('a turn run after adopt carries the adopted account env (overseer-wcw: an adopted worker must keep its account login on its next turn)', async () => {
    const procs = await import('../util/procs');
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'tok-1' };
    const adoptedProc: LineProcess = {
      pid: 4242,
      stdin: undefined as unknown as LineProcess['stdin'],
      lines: (async function* () { yield JSON.stringify({ type: 'result', is_error: false, session_id: 'n1', total_cost_usd: 0.1 }); })(),
      exit: Promise.resolve(0),
      logOffset: () => 0,
    };
    const nextProc: LineProcess = {
      pid: 4243,
      stdin: { write: vi.fn() } as unknown as LineProcess['stdin'],
      lines: (async function* () {})(),
      exit: new Promise(() => {}),
      logOffset: () => 0,
    };
    const adoptSpy = vi.spyOn(procs, 'adoptLines').mockReturnValue(adoptedProc);
    const spawnSpy = vi.spyOn(procs, 'spawnLines').mockReturnValue(nextProc);
    const startSpy = vi.spyOn(procs, 'processStartTime').mockResolvedValue('0');
    try {
      const a = new ClaudeAdapter('claude');
      const h = a.adopt({ pid: 4242, cwd: '/w', logFile: '/logs/a.log', logOffset: 0, nativeSessionId: 'n1', env });
      for await (const e of a.events(h)) if (e.type === 'turn_end') break;
      // The adopted process is gone once its turn ends; a macrotask lets pump clear it before the next turn spawns.
      await new Promise((r) => setImmediate(r));
      await a.send(h, 'follow up');
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[2]?.env).toEqual(env);
    } finally {
      adoptSpy.mockRestore();
      spawnSpy.mockRestore();
      startSpy.mockRestore();
    }
  });
});
