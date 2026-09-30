import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnLines, killProcess, sweepProcessTree, type LineProcess } from '../util/procs';
import { log } from '../util/log';
import { BaseAdapter, HarnessSession } from './base';
import type { AdoptOpts, HarnessEvent, StartOpts } from './types';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** PreToolUse hook that rejects a Bash call with `run_in_background`: a headless session exits when the model yields, so the job's result would be lost. */
export const DENY_BACKGROUND_HOOK = fileURLToPath(new URL('../../hooks/deny-background.cjs', import.meta.url));
export const DENY_EVAL_SIDE_EFFECTS_HOOK = fileURLToPath(new URL('../../hooks/deny-eval-side-effects.cjs', import.meta.url));
/** The prompt eval can inspect repositories, but it cannot use file-writing or network-capable built-in tools. */
export const PROMPT_EVAL_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'] as const;

type HookRule = { matcher: string; hooks: { type: 'command'; command: string }[] };
type ClaudeHookSettings = { hooks: { PreToolUse: HookRule[] } };

/** Settings passed with `--settings`; the hook command is quoted for the shell Claude Code runs hooks in (cmd.exe or sh). */
export function denyBackgroundSettings(hookPath = DENY_BACKGROUND_HOOK): object {
  return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${hookPath.replaceAll('\\', '/')}"` }] }] } };
}

/** Network and writes outside the per-run cwd are refused before an eval tool call executes. */
export function evalSandboxSettings(hookPath = DENY_EVAL_SIDE_EFFECTS_HOOK): ClaudeHookSettings {
  const command = `node "${hookPath.replaceAll('\\', '/')}"`;
  const tools = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'WebSearch', 'WebFetch', 'Task'];
  return { hooks: { PreToolUse: tools.map((matcher) => ({ matcher, hooks: [{ type: 'command', command }] })) } };
}

/** The context-mode plugin's id in the user's `enabledPlugins` (`~/.claude/settings.json`). */
export const CONTEXT_MODE_PLUGIN = 'context-mode@context-mode';

/**
 * The `--settings` object for one session, or null when it needs none. Workers and critics run without the context-mode plugin:
 * its MCP server opens every context-mode session database once a minute, and one server per headless session saturated the disk.
 */
export function sessionSettings(opts: StartOpts): (Partial<ClaudeHookSettings> & { enabledPlugins?: Record<string, boolean> }) | null {
  const PreToolUse: HookRule[] = [];
  if (opts.denyBackground) PreToolUse.push(...(denyBackgroundSettings() as ClaudeHookSettings).hooks.PreToolUse);
  if (opts.evalSandbox) PreToolUse.push(...evalSandboxSettings().hooks.PreToolUse);
  const noContextMode = opts.role === 'worker' || opts.role === 'critic';
  if (!PreToolUse.length && !noContextMode) return null;
  return { ...(PreToolUse.length ? { hooks: { PreToolUse } } : {}), ...(noContextMode ? { enabledPlugins: { [CONTEXT_MODE_PLUGIN]: false } } : {}) };
}

export function parseClaudeLine(line: string): HarnessEvent[] {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(line); } catch { return [{ type: 'raw', line }]; }
  const parentId = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined;
  const content = ((msg.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
  switch (msg.type) {
    case 'rate_limit_event': {
      // Recorded Claude Code messages put the limit details in rate_limit_info. Keep the raw message because older/newer CLIs
      // may move these fields; an absent or unparseable reset deliberately falls back to the lifecycle's five-hour hold.
      const info = msg.rate_limit_info as Record<string, unknown> | undefined;
      // Claude emits these as ordinary usage updates too. Only a rejected request means this session has actually hit its limit;
      // `allowed_warning` remains runnable, so it must not trigger account failover.
      if (info?.status !== 'rejected') return [];
      const reset = info?.resetsAt ?? msg.resetsAt;
      const millis = typeof reset === 'number' ? (reset < 10_000_000_000 ? reset * 1000 : reset) : Date.parse(String(reset ?? ''));
      return [{ type: 'rate_limit', kind: 'rate_limit', resetsAt: Number.isFinite(millis) ? new Date(millis).toISOString() : null,
        bucket: typeof info?.rateLimitType === 'string' ? info.rateLimitType : typeof msg.rateLimitType === 'string' ? msg.rateLimitType : null, raw: msg }];
    }
    case 'assistant': {
      const out: HarnessEvent[] = [];
      const m = msg.message as { model?: string; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } | undefined;
      if (!parentId && m?.usage && typeof m.model === 'string') out.push({ type: 'context', tokens: (m.usage.input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0), model: m.model });
      // Only the CLI's structured API-error reply is an auth failure; its text blocks become one `auth_failed` event.
      const authError = msg.error === 'authentication_failed' && msg.is_api_error_message === true ? msg.error : undefined;
      const authTexts: string[] = [];
      for (const c of content) {
        if (authError && c.type === 'text' && typeof c.text === 'string') { if (c.text) authTexts.push(c.text); continue; }
        if (c.type === 'text' && typeof c.text === 'string' && c.text) out.push({ type: 'assistant_text', text: c.text });
        if (c.type === 'tool_use') {
          out.push({ type: 'tool_call', id: String(c.id), name: String(c.name), input: c.input, parentId });
          const input = (c.input ?? {}) as { file_path?: string; notebook_path?: string };
          const p = FILE_TOOLS.has(String(c.name)) ? input.file_path ?? input.notebook_path : undefined;
          if (p) out.push({ type: 'file_change', path: p });
        }
      }
      if (authError) out.push({ type: 'auth_failed', text: authTexts.join('\n'), error: authError });
      return out;
    }
    case 'user':
      return content.filter((c) => c.type === 'tool_result').map((c) => ({ type: 'tool_result', id: String(c.tool_use_id), output: c.content }));
    case 'result': {
      const out: HarnessEvent[] = [];
      if (msg.is_error) out.push({ type: 'error', message: String(msg.result ?? msg.subtype ?? 'error') });
      const windows = Object.entries((msg.modelUsage ?? {}) as Record<string, { contextWindow?: unknown }>).flatMap(([k, v]) => (typeof v?.contextWindow === 'number' ? [[k, v.contextWindow] as const] : []));
      const usage = msg.usage as { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_creation?: { ephemeral_1h_input_tokens?: unknown }; output_tokens_details?: { thinking_tokens?: unknown } } | undefined;
      const counts = { input: usage?.input_tokens, output: usage?.output_tokens, cacheRead: usage?.cache_read_input_tokens, cacheWrite: usage?.cache_creation_input_tokens, cacheWrite1h: usage?.cache_creation?.ephemeral_1h_input_tokens, reasoning: usage?.output_tokens_details?.thinking_tokens };
      const tokenUsage = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === 'number'));
      out.push({ type: 'turn_end', nativeSessionId: String(msg.session_id ?? ''), cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined, ...(Object.keys(tokenUsage).length ? { usage: tokenUsage } : {}), ...(windows.length ? { contextWindows: Object.fromEntries(windows) } : {}), ...(msg.api_error_status === 401 ? { authFailed: true } : {}) });
      return out;
    }
    case 'system':
    case 'stream_event':
      return [];
    default:
      return [{ type: 'raw', line }];
  }
}

export function claudeArgs(o: StartOpts, nativeId: string, resume: boolean, mcpConfigFile: string | null, settingsFile: string | null = null): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  args.push(...(resume ? ['--resume', nativeId] : ['--session-id', nativeId]));
  if (o.systemPromptFile) args.push('--append-system-prompt-file', o.systemPromptFile);
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);
  if (o.strictMcpConfig) args.push('--strict-mcp-config');
  if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', o.maxBudgetUsd.toFixed(2));
  if (o.noSessionPersistence) args.push('--no-session-persistence');
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.tools?.length) args.push('--tools', o.tools.join(','));
  if (settingsFile) args.push('--settings', settingsFile);
  return args;
}

class ClaudeSession extends HarnessSession {
  /** Set by `interrupt()`: it sweeps what the CLI started itself, so `end()` does not sweep a second time. */
  private interrupted = false;
  private mcpConfigFile: string | null = null;
  private settingsFile: string | null = null;

  constructor(private bin: string, private opts: StartOpts, readonly nativeId: string, private resume: boolean, pollMs?: number, private warn: (message: string) => void = log.warn, private onSweep?: (swept: Promise<void>) => void) {
    super(opts.logFile, nativeId, pollMs);
    if (opts.mcpServers?.length) {
      this.mcpConfigFile = path.join(os.tmpdir(), `overseer-mcp-${nativeId}.json`);
      fs.writeFileSync(this.mcpConfigFile, JSON.stringify({ mcpServers: Object.fromEntries(opts.mcpServers.map((m) => [m.name, { type: 'http', url: m.url }])) }));
    }
    const settings = sessionSettings(opts);
    if (settings) {
      this.settingsFile = path.join(os.tmpdir(), `overseer-settings-${nativeId}.json`);
      fs.writeFileSync(this.settingsFile, JSON.stringify(settings));
    }
  }

  send(text: string): void {
    if (!this.proc) this.spawn();
    if (!this.proc!.stdin) throw new Error('an adopted claude session cannot take input: its stdin belongs to the daemon that started it');
    this.proc!.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  }

  private spawn(): void {
    const args = claudeArgs(this.opts, this.nativeId, this.resume, this.mcpConfigFile, this.settingsFile);
    const p = spawnLines(this.bin, args, { cwd: this.opts.cwd, logFile: this.opts.logFile, env: this.opts.env, pollMs: this.pollMs });
    this.resume = true;
    this.follow(p, false);
  }

  // An adopted process (`HarnessSession.adopt`): a turn end still arrives from its log, or the process is found gone.
  protected async pump(p: LineProcess, adopted: boolean): Promise<void> {
    await this.processStarted(p, adopted);
    let turnEnded = false;
    for await (const line of p.lines) {
      for (const ev of parseClaudeLine(line)) { if (ev.type === 'turn_end') turnEnded = true; this.queue.push(ev); }
      this.opts.onLogOffset?.(p.logOffset());
    }
    const code = await p.exit;
    if (this.proc === p) this.proc = null;
    // An adopted process reports no exit code: a process that is gone without a result line was killed or crashed.
    if (!this.ending && (code !== 0 || (adopted && !turnEnded))) {
      this.queue.push({ type: 'error', message: adopted && code === 0 ? 'claude exited without finishing its turn' : `claude exited with code ${code}` });
      this.queue.close();
      return;
    }
    if (this.ending) this.queue.close();
  }

  async end(): Promise<void> {
    this.ending = true;
    const p = this.proc;
    if (!p) { this.queue.close(); return; }
    // An adopted process already has EOF on stdin (the daemon that held the pipe is gone) and exits once its turn is over.
    p.stdin?.end();
    const timer = setTimeout(() => { if (p.pid) void killProcess(p.pid); }, 10_000);
    await p.exit;
    clearTimeout(timer);
    // Detached: the sweep is a few PowerShell queries (seconds), and a session's end must not wait on them.
    // An interrupted session already swept in `interrupt()`; sweeping again would only repeat the queries.
    if (!this.interrupted) {
      const swept = this.sweep(p.pid, 'claude exited at session end').catch((err) => log.error('claude: orphan sweep at session end failed', err));
      this.onSweep?.(swept);
    }
  }

  /**
   * After the CLI is gone: with `logFile` its stdout is a file handle, so `claude -p` exits at stdin EOF while a dev
   * server it started still holds that handle and outlives the session. Same rule as codex's `TurnGrace.sweep`: kill
   * the live descendants and any process that holds both session logs, each only when it started after the CLI did.
   */
  private async sweep(pid: number | undefined, label: string): Promise<void> {
    if (this.startedAt === undefined) return;
    await sweepProcessTree({ pid, startedAt: this.startedAt, logFile: this.opts.logFile, label, warn: this.warn });
  }

  async interrupt(): Promise<void> {
    const pid = this.proc?.pid;
    if (pid) await killProcess(pid, this.startedAt);
    this.interrupted = true;
    // Detached like `end()`'s sweep: a stop must not wait on the PowerShell queries, and `abandonBatch` stops every
    // running session one after another. The sweep still runs once the CLI is gone; the next `end()` skips its own.
    const swept = this.sweep(pid, `claude session ${this.sessionLabel()} (pid ${pid}) was interrupted`).catch((err) => log.error('claude: orphan sweep at interrupt failed', err));
    this.onSweep?.(swept);
  }
}

export class ClaudeAdapter extends BaseAdapter<ClaudeSession> {
  readonly name = 'claude' as const;
  /**
   * Tests can shorten polling waits, capture sweep warnings and await a detached sweep (`onSweep`) — the end-of-session
   * one and the interrupt one — without changing production timing or a shared log spy.
   */
  constructor(private bin = 'claude', private pollMs?: number, private warn?: (message: string) => void, private onSweep?: (swept: Promise<void>) => void) { super(); }

  protected create(_id: string, opts: StartOpts): ClaudeSession {
    return new ClaudeSession(this.bin, opts, opts.resumeId ?? randomUUID(), !!opts.resumeId, this.pollMs, this.warn, this.onSweep);
  }
  protected createAdopted(_id: string, o: AdoptOpts): ClaudeSession {
    return new ClaudeSession(this.bin, { cwd: o.cwd, prompt: '', logFile: o.logFile, onLogOffset: o.onLogOffset, env: o.env }, o.nativeSessionId ?? randomUUID(), !!o.nativeSessionId, this.pollMs, this.warn, this.onSweep);
  }
}
