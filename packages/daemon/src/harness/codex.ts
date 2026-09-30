import { randomUUID } from 'node:crypto';
import { spawnLines, linesUntil, TurnGrace, TURN_END_GRACE_MS, type LineProcess } from '../util/procs';
import { BaseAdapter, TurnSession } from './base';
import type { AdoptOpts, HarnessEvent, McpServerConfig, StartOpts, TokenUsage } from './types';

/**
 * The `-c` overrides that carry the Overseer MCP server into a codex turn.
 * codex has no `--mcp-config` flag; a server is a `[mcp_servers.<name>]` table in `$CODEX_HOME/config.toml`
 * (`codex mcp add overseer --url <url>` writes `[mcp_servers.overseer]` with `url = "<url>"`), and `codex --help`
 * documents `-c, --config <key=value>` as an override of "a configuration value that would otherwise be loaded from
 * `~/.codex/config.toml`", with a dotted path for nested values. A dotted path sets that leaf only, so the user's own
 * servers stay configured alongside this one and no file of theirs is written — `CODEX_HOME` already carries the
 * account, so it cannot be redirected at a scratch directory. The value is parsed as TOML, hence the quoted string.
 */
export function codexMcpArgs(servers: readonly McpServerConfig[] = []): string[] {
  return servers.flatMap((m) => ['-c', `mcp_servers.${m.name}.url=${JSON.stringify(m.url)}`]);
}

/** The prompt is not part of argv: `runTurn` writes it to stdin, which `codex exec` reads when no prompt argument is given. */
export function codexArgs(cwd: string, threadId: string | null, opts?: { model?: string; effort?: string; mcpServers?: readonly McpServerConfig[] }): string[] {
  const extra: string[] = [...codexMcpArgs(opts?.mcpServers)];
  if (opts?.model) extra.push('-m', opts.model);
  if (opts?.effort) extra.push('-c', `model_reasoning_effort=${opts.effort}`);
  // codex-cli 0.154.0 removed `--full-auto`; `exec resume` takes neither `--sandbox` nor `--cd`
  // (the resumed thread keeps its cwd, and the process is spawned in the worktree anyway),
  // so both variants set the sandbox and approval policy through `-c`.
  // workspace-write cannot write the worktree's git dir, which lives under the main checkout's
  // `.git/worktrees/<name>`, so `git commit` fails; the worktree is the isolation boundary, hence danger-full-access.
  const auto = ['-c', 'sandbox_mode=danger-full-access', '-c', 'approval_policy=never'];
  return threadId
    ? ['exec', 'resume', '--json', ...auto, ...extra, threadId]
    : ['exec', '--json', ...auto, '--cd', cwd, ...extra];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The reset time in a codex usage-limit message, as ISO. codex-rs `format_retry_timestamp` (protocol/src/error.rs) formats it in the
 *  machine's local zone, as `%b %-d{st|nd|rd|th}, %Y %-I:%M %p`, or `%-I:%M %p` alone when the reset is today; codex runs on this machine. */
export function parseCodexResetTime(message: string, now = new Date()): string | null {
  const m = /try again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)/i.exec(message);
  if (!m) return null;
  const month = m[1] ? MONTHS.indexOf(m[1]) : now.getMonth();
  if (month < 0) return null;
  const hour = (Number(m[4]) % 12) + (m[6]?.toUpperCase() === 'PM' ? 12 : 0);
  const at = m[1] ? new Date(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(m[5]));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

type Item = { id?: string; type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; changes?: { path: string; kind?: string }[]; server?: string; tool?: string; arguments?: unknown; result?: unknown };

export class CodexParser {
  threadId: string | null = null;
  /** Set by `turn.completed`; the session starts the exit grace on it (`TurnGrace`). */
  turnCompleted = false;
  private usage: TokenUsage | undefined;

  takeUsage(): TokenUsage | undefined { const usage = this.usage; this.usage = undefined; return usage; }

  /** codex writes the same usage-limit text as `error` and then `turn.failed`; only the first becomes a `usage_limit` event. */
  private usageLimitSeen = false;

  private failure(message: string): HarnessEvent[] {
    if (!/usage limit/i.test(message) || this.usageLimitSeen) return [{ type: 'error', message }];
    this.usageLimitSeen = true;
    return [{ type: 'usage_limit', resetsAt: parseCodexResetTime(message), message }, { type: 'error', message }];
  }

  parse(line: string): HarnessEvent[] {
    let msg: { type?: string; thread_id?: string; item?: Item; error?: { message?: string } | string; usage?: { input_tokens?: unknown; output_tokens?: unknown; cached_input_tokens?: unknown; cache_write_input_tokens?: unknown; reasoning_output_tokens?: unknown } };
    try { msg = JSON.parse(line); } catch { return [{ type: 'raw', line }]; }
    switch (msg.type) {
      case 'thread.started':
        if (typeof msg.thread_id === 'string') this.threadId = msg.thread_id;
        return [];
      case 'turn.completed':
        this.turnCompleted = true;
        const counts = { input: msg.usage?.input_tokens, output: msg.usage?.output_tokens, cacheRead: msg.usage?.cached_input_tokens, cacheWrite: msg.usage?.cache_write_input_tokens, reasoning: msg.usage?.reasoning_output_tokens };
        const usage = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === 'number'));
        this.usage = Object.keys(usage).length ? usage : undefined;
        return [];
      case 'turn.started':
      case 'item.started':
      case 'item.updated':
        return [];
      case 'turn.failed': {
        const m = typeof msg.error === 'string' ? msg.error : msg.error?.message ?? 'codex turn failed';
        return this.failure(m);
      }
      case 'error': {
        const m = typeof msg.error === 'string' ? msg.error : msg.error?.message ?? String((msg as { message?: string }).message ?? 'codex error');
        return this.failure(m);
      }
      case 'item.completed': {
        const it = msg.item ?? {};
        const id = it.id ?? randomUUID();
        switch (it.type) {
          case 'agent_message':
            return it.text ? [{ type: 'assistant_text', text: it.text }] : [];
          case 'command_execution':
            return [
              { type: 'tool_call', id, name: 'command_execution', input: { command: it.command } },
              { type: 'tool_result', id, output: it.aggregated_output },
            ];
          case 'file_change':
            return (it.changes ?? []).map((c) => ({ type: 'file_change', path: c.path }) as HarnessEvent);
          case 'mcp_tool_call':
            return [
              { type: 'tool_call', id, name: `${it.server ?? 'mcp'}.${it.tool ?? 'tool'}`, input: it.arguments },
              { type: 'tool_result', id, output: it.result },
            ];
          default:
            return [];
        }
      }
      default:
        return [{ type: 'raw', line }];
    }
  }
}

class CodexSession extends TurnSession {
  protected readonly harness = 'codex' as const;
  readonly parser = new CodexParser();

  constructor(id: string, private bin: string, private cwd: string, resumeId: string | undefined, private model?: string, private effort?: string, private log: Pick<StartOpts, 'logFile' | 'onLogOffset' | 'env' | 'mcpServers'> = {}, private graceMs = TURN_END_GRACE_MS, pollMs?: number, private warn?: (message: string) => void) {
    super(log.logFile, id, pollMs);
    this.parser.threadId = resumeId ?? null;
  }

  protected runTurn(text: string): void {
    // Every turn, not just the first: a resumed turn is a fresh CLI process and needs the server again.
    const args = codexArgs(this.cwd, this.parser.threadId, { model: this.model, effort: this.effort, mcpServers: this.log.mcpServers });
    const p = spawnLines(this.bin, args, { cwd: this.cwd, logFile: this.log.logFile, env: this.log.env, pollMs: this.pollMs });
    // The prompt travels over stdin, not argv: a review prompt (description, instructions and the diff) exceeded
    // the Windows command-line limit and spawn failed with ENAMETOOLONG. codex exec reads the prompt from stdin
    // and starts the turn at EOF, so it is written and closed at once. spawnLines already swallows EPIPE on stdin.
    p.stdin?.end(text);
    this.follow(p, false);
  }

  // An adopted turn (`HarnessSession.adopt`) ends when the process is gone.
  protected async pump(p: LineProcess, adopted: boolean): Promise<void> {
    const { pid, pidStartedAt, spawnedAt } = await this.processStarted(p, adopted);
    const grace = new TurnGrace(p, this.graceMs, `codex session ${this.sessionLabel()} (pid ${pid}) reported turn.completed`, this.log.logFile, pidStartedAt ?? new Date(spawnedAt).toISOString(), this.warn);
    this.parser.turnCompleted = false;
    for await (const line of linesUntil(p.lines, grace.fired)) {
      for (const ev of this.parser.parse(line)) this.queue.push(ev);
      this.log.onLogOffset?.(p.logOffset());
      if (this.parser.turnCompleted) grace.arm();
    }
    const code = await grace.exitCode();
    this.proc = null;
    if (code !== 0) this.queue.push({ type: 'error', message: `codex exited with code ${code}` });
    const usage = this.parser.takeUsage();
    this.finishTurn({ type: 'turn_end', nativeSessionId: this.parser.threadId ?? '', ...(usage ? { usage } : {}) });
  }
}

export class CodexAdapter extends BaseAdapter<CodexSession> {
  readonly name = 'codex' as const;
  /** Tests can shorten the grace and polling waits without changing production timing. */
  constructor(private bin = 'codex', private graceMs = TURN_END_GRACE_MS, private pollMs?: number, private warn?: (message: string) => void) { super(); }

  protected create(id: string, opts: StartOpts): CodexSession {
    return new CodexSession(id, this.bin, opts.cwd, opts.resumeId, opts.model, opts.effort, opts, this.graceMs, this.pollMs, this.warn);
  }
  protected createAdopted(id: string, o: AdoptOpts): CodexSession {
    return new CodexSession(id, this.bin, o.cwd, o.nativeSessionId ?? undefined, undefined, undefined, o, this.graceMs, this.pollMs, this.warn);
  }
}
