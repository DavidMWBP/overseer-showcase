import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../util/log';
import { spawnLines, linesUntil, TurnGrace, TURN_END_GRACE_MS, type LineProcess } from '../util/procs';
import type { Effort } from '@overseer/shared';
import { BaseAdapter, TurnSession } from './base';
import type { AdoptOpts, HarnessEvent, McpServerConfig, StartOpts, TokenUsage } from './types';

const FILE_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch']);

/** What `--auto` granted; `opencode run --auto` fails with an UnknownError on 1.18.19, so runs pass it through the environment. */
// external_directory: a run that read the session log outside its worktree was auto-rejected and stopped. The other keys are
// tools claude and codex workers already have; task, question, websearch, lsp, doom_loop and skill are left at opencode's default.
export const OPENCODE_PERMISSION = '{"read":"allow","edit":"allow","glob":"allow","grep":"allow","list":"allow","bash":"allow","external_directory":"allow","todowrite":"allow","webfetch":"allow"}';

/** `--variant` values per deepseek model (models.dev `reasoning_options`); other providers and efforts get no flag. */
const DEEPSEEK_VARIANTS: Record<string, readonly string[]> = {
  'deepseek-flash': ['low', 'high', 'max'],
  'deepseek-v4-flash': ['low', 'high', 'max'],
  'deepseek-v4-flash-vision-exp': ['low', 'high', 'max'],
  'deepseek-v4-pro': ['high', 'max'],
};

function variantFor(model: string | undefined, effort: string | undefined): string | undefined {
  if (!model || !effort || !model.startsWith('deepseek/')) return undefined;
  return DEEPSEEK_VARIANTS[model.slice('deepseek/'.length)]?.includes(effort) ? effort : undefined;
}

/** The prompt is not part of argv: `spawnOpencode` writes it to stdin, which `opencode run` takes as the message when no message argument is given. */
export function opencodeArgs(cwd: string, sessionId: string | null, opts?: { model?: string; effort?: Effort }): string[] {
  const args = ['run', '--format', 'json', '--dir', cwd];
  if (opts?.model) args.push('--model', opts.model);
  const variant = variantFor(opts?.model, opts?.effort);
  if (variant) args.push('--variant', variant);
  if (sessionId) args.push('--session', sessionId);
  return args;
}

/**
 * Starts one `opencode run` turn; the worker session and the account Verify route both call this so they cannot diverge.
 * The prompt travels over stdin, not argv: a review prompt (description, instructions and the diff) exceeded the Windows
 * command-line limit and spawn failed with ENAMETOOLONG. `opencode run` reads piped stdin to EOF before it starts (an open
 * pipe hung it until killed), so the prompt is written and stdin closed at once; with no text it is closed empty.
 */
export function spawnOpencode(bin: string, cwd: string, sessionId: string | null, prompt: string, opts: { model?: string; effort?: Effort; env?: NodeJS.ProcessEnv; logFile?: string; pollMs?: number } = {}): LineProcess {
  const p = spawnLines(bin, opencodeArgs(cwd, sessionId, { model: opts.model, effort: opts.effort }), { cwd, logFile: opts.logFile, env: { ...opts.env, OPENCODE_PERMISSION }, pollMs: opts.pollMs });
  if (prompt) p.stdin?.end(prompt);
  else p.stdin?.end();
  return p;
}

/**
 * Writes the per-session opencode config that carries the Overseer MCP server, and returns its path.
 * opencode has no `--mcp-config` flag; its own help text documents the environment variable instead:
 * "`OPENCODE_CONFIG=/path/to/file.json`: load an additional explicit config" — additional, so this merges
 * on top of the user's `~/.config/opencode/config.json` and the project's `opencode.json` rather than
 * replacing either. The server entry is opencode's `McpRemoteConfig` (`type`, `url`, `enabled`, `headers`,
 * `timeout`), not claude's `{ type: 'http' }` shape.
 */
export function writeOpencodeMcpConfig(id: string, servers: readonly McpServerConfig[]): string {
  const file = path.join(os.tmpdir(), `overseer-opencode-mcp-${id}.json`);
  const mcp = Object.fromEntries(servers.map((m) => [m.name, { type: 'remote', url: m.url, enabled: true }]));
  fs.writeFileSync(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp }));
  return file;
}

type Part = { type?: string; text?: string; tool?: string; callID?: string; cost?: number; reason?: string; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }; state?: { status?: string; input?: unknown; output?: unknown } };

export class OpencodeParser {
  sessionId: string | null = null;
  cost = 0;
  private usage: TokenUsage = {};
  /** One entry per `step_finish` (one model response), with that response's own counters; `input` is the non-cached slice. */
  private requests: TokenUsage[] = [];
  /** Set by a `step_finish` whose reason is `stop`, a turn's last step (`tool-calls` marks an intermediate one); the session starts the exit grace on it (`TurnGrace`). */
  turnCompleted = false;

  takeUsage(): TokenUsage | undefined { const usage = this.usage; this.usage = {}; return Object.keys(usage).length ? usage : undefined; }

  takeRequests(): TokenUsage[] | undefined { const requests = this.requests; this.requests = []; return requests.length ? requests : undefined; }

  parse(line: string): HarnessEvent[] {
    let msg: { type?: string; sessionID?: string; part?: Part & { sessionID?: string }; error?: { name?: string; message?: string; data?: { message?: string } } | string };
    try { msg = JSON.parse(line); } catch { return [{ type: 'raw', line }]; }
    const sid = msg.sessionID ?? msg.part?.sessionID;
    if (typeof sid === 'string' && sid) this.sessionId = sid;
    const part = msg.part ?? {};
    if (msg.type === 'error') {
      // 1.18.19 nests the text under `data` beside the error's `name` (`UnknownError`, `APIError`); read only at the top, it was lost.
      const e = msg.error;
      const m = typeof e === 'string' ? e : e?.data?.message ? `${e.name ? `${e.name}: ` : ''}${e.data.message}` : e?.message ?? 'opencode error';
      return [{ type: 'error', message: m }];
    }
    switch (part.type) {
      case 'text':
        return part.text ? [{ type: 'assistant_text', text: part.text }] : [];
      case 'tool': {
        const id = String(part.callID ?? randomUUID());
        const out: HarnessEvent[] = [{ type: 'tool_call', id, name: String(part.tool ?? 'tool'), input: part.state?.input }];
        const input = (part.state?.input ?? {}) as { filePath?: string };
        if (FILE_TOOLS.has(String(part.tool)) && input.filePath) out.push({ type: 'file_change', path: input.filePath });
        if (part.state?.status === 'completed' || part.state?.status === 'error') out.push({ type: 'tool_result', id, output: part.state.output });
        return out;
      }
      case 'step_finish':
      case 'step-finish': {
        if (typeof part.cost === 'number') this.cost += part.cost;
        if (part.reason === 'stop') this.turnCompleted = true;
        const step: TokenUsage = {};
        for (const [key, value] of Object.entries({ input: part.tokens?.input, output: part.tokens?.output, reasoning: part.tokens?.reasoning, cacheRead: part.tokens?.cache?.read, cacheWrite: part.tokens?.cache?.write })) {
          if (typeof value !== 'number') continue;
          step[key as keyof TokenUsage] = value;
          this.usage[key as keyof TokenUsage] = (this.usage[key as keyof TokenUsage] ?? 0) + value;
        }
        // Kept per response: the tier is selected from each response's own input, not from the turn's aggregate.
        if (Object.keys(step).length) this.requests.push(step);
        return [];
      }
      case 'step_start':
      case 'step-start':
      case 'reasoning':
      case undefined:
        return [];
      default:
        return [];
    }
  }
}

/** opencode's session store (docs: "%USERPROFILE%\.local\share\opencode" on Windows, `~/.local/share/opencode` elsewhere). */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
}

/** Where `opencode auth login` keeps its credentials, keyed by provider id (`opencode auth list` prints this path). */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(opencodeDbPath(env)), 'auth.json');
}

/**
 * Whether the CLI's own login can reach `provider` without an Overseer account: the provider's key variable (`envVar`) is set,
 * or `opencode auth login` stored a credential for it. opencode 1.18.19 given neither exits 1 at the first request with only
 * `{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. ..."}}}` and an empty stderr
 * (four account-less critics on 2026-09-28), while a key it has but the provider rejects is a 401 `APIError`.
 */
export function opencodeLoginHasKey(provider: string, envVar: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[envVar]) return true;
  try { return Object.hasOwn(JSON.parse(fs.readFileSync(opencodeAuthPath(env), 'utf8')) as object, provider); } catch { return false; }
}

const SUBAGENT_POLL_MS = 2000;

/**
 * How long a turn may print nothing (no line of its own, no sub-agent event) past its latest running tool deadline before
 * it is ended like a `stop` grace. opencode 1.18.19 hangs silently on a `step_start` when a shell command leaves a
 * grandchild holding the output pipe (the tool's timeout races only the shell's exit code) or when the provider stream
 * stalls (overseer-ialj). A shell call is printed only when it completes, and a call may ask for any timeout: on
 * 2026-09-17 a vitest call with `timeout: 1500000` was ended 19 minutes in, still inside it. opencode writes the tool part
 * to its store as the call starts (`state.status` `running`, `state.time.start`, optional `state.input.timeout`), so each
 * running part of the root session or a known sub-agent session has the deadline `start + (timeout ??
 * OPENCODE_DEFAULT_TOOL_TIMEOUT_MS)` (`runningToolDeadlines`), and the turn is ended only once this long has passed since
 * the later of the last event and the latest such deadline. A hung call stays `running` in the store forever, so its
 * deadline, not its status, decides; a part an earlier turn left `running` has a past deadline and changes nothing.
 */
export const TURN_SILENCE_MS = 20 * 60 * 1000;

/** A tool call's timeout when its input names none: opencode's bash default; all 6725 such calls in the store ended within 120 s. */
export const OPENCODE_DEFAULT_TOOL_TIMEOUT_MS = 2 * 60 * 1000;

export type RunningToolDeadline = { sessionId: string; callId: string; tool: string; start: number; deadline: number };

/**
 * Every tool part of `sessions` still `running` in opencode's store, with its deadline `state.time.start +
 * (state.input.timeout ?? defaultTimeoutMs)`. Opens the store read-only and throws when it is missing, cannot be read or
 * holds a running row that is not JSON, so the caller falls back to the plain silence.
 */
export function runningToolDeadlines(dbPath: string, sessions: readonly string[], defaultTimeoutMs = OPENCODE_DEFAULT_TOOL_TIMEOUT_MS): RunningToolDeadline[] {
  if (!fs.existsSync(dbPath)) throw new Error('the store does not exist');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, data FROM part WHERE session_id = ? AND data LIKE '%"status":"running"%' ORDER BY time_created, id`);
    const out: RunningToolDeadline[] = [];
    for (const sessionId of sessions) {
      for (const row of rows.all(sessionId) as { id: string; data: string }[]) {
        const p = JSON.parse(row.data) as Part & { state?: { time?: { start?: unknown }; input?: { timeout?: unknown } } };
        const start = p.state?.time?.start;
        if (p.type !== 'tool' || p.state?.status !== 'running' || typeof start !== 'number') continue;
        const timeout = p.state.input?.timeout;
        out.push({ sessionId, callId: String(p.callID ?? row.id), tool: String(p.tool ?? 'tool'), start, deadline: start + (typeof timeout === 'number' ? timeout : defaultTimeoutMs) });
      }
    }
    return out;
  } finally { db.close(); }
}

/**
 * `opencode run --format json` prints a `task` tool call only once its sub-agent has finished, so the parent looks silent meanwhile.
 * opencode writes the running task part (with `state.metadata.sessionId`, the child session) and the child's parts to its SQLite
 * store as they happen; this follows them there and reports each child tool call and finished text with the task's call id as `parentId`.
 */
export class SubagentWatcher {
  /** child session id -> the parent's task call id */
  private children = new Map<string, string>();
  private seen = new Set<string>();
  /**
   * A resumed or adopted session's store already holds every earlier turn's parts. Its first poll only records what is
   * there (`seen`, `children`) and reports none of it, so a continuation does not replay finished sub-agents into a trace
   * that already has them; a fresh session starts primed because it has no earlier parts.
   */
  private primed: boolean;
  private warned = false;

  constructor(private dbPath: string, private rootSession: () => string | null, prime = false) {
    this.primed = !prime;
  }

  /** The sub-agent (task) sessions found so far. */
  childSessions(): string[] { return [...this.children.keys()]; }

  poll(): HarnessEvent[] {
    const root = this.rootSession();
    if (!root) return [];
    if (!fs.existsSync(this.dbPath)) {
      if (!this.warned) {
        this.warned = true;
        log.warn(`opencode sub-agent store ${this.dbPath} does not exist, sub-agent activity is not followed`);
      }
      return [];
    }
    let db: DatabaseSync | undefined;
    const out: HarnessEvent[] = [];
    const emitting = this.primed;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      // The root's own parts are already in its stream, so only its task calls are read; a child is read whole.
      const tasks = db.prepare(`SELECT id, data FROM part WHERE session_id = ? AND data LIKE '%"tool":"task"%' ORDER BY time_created, id`);
      const parts = db.prepare('SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created, id');
      const sessions = [root, ...this.children.keys()];
      for (const sid of sessions) { // a child found on the way is appended and still visited
        const parentId = this.children.get(sid);
        for (const row of (parentId ? parts : tasks).all(sid) as { id: string; data: string }[]) {
          let p: Part & { time?: { end?: number }; state?: { metadata?: { sessionId?: string } } };
          try { p = JSON.parse(row.data); } catch { continue; }
          const child = p.type === 'tool' && p.tool === 'task' ? p.state?.metadata?.sessionId : undefined;
          if (child && p.callID && !this.children.has(child)) { this.children.set(child, p.callID); sessions.push(child); }
          if (!parentId || this.seen.has(row.id)) continue;
          if (p.type === 'tool' && p.state?.status && p.state.status !== 'pending') {
            this.seen.add(row.id);
            if (!emitting) continue;
            out.push({ type: 'tool_call', id: String(p.callID ?? row.id), name: String(p.tool ?? 'tool'), input: p.state?.input, parentId });
            const input = (p.state?.input ?? {}) as { filePath?: string };
            if (FILE_TOOLS.has(String(p.tool)) && input.filePath) out.push({ type: 'file_change', path: input.filePath }); // as the parser does for the parent
          } else if (p.type === 'text' && p.text && p.time?.end) {
            this.seen.add(row.id);
            if (emitting) out.push({ type: 'assistant_text', text: p.text, parentId });
          }
        }
      }
      this.primed = true;
    } catch (err) {
      // store locked or of another shape: the parent's own stream is unaffected, but say so once per session
      if (!this.warned) {
        this.warned = true;
        log.warn(`opencode sub-agent store ${this.dbPath} could not be read, sub-agent activity is not followed: ${(err as Error).message}`);
      }
    }
    finally { db?.close(); }
    return out;
  }
}

/** The first `sessionID` in the log's first `end` bytes, or null. */
function sessionIdInLog(logFile: string, end: number): string | null {
  let text: string;
  try {
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, end));
      text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  return /"sessionID":"([^"]+)"/.exec(text)?.[1] ?? null;
}

/** A log line's top-level `type` (`step_start`, `tool_use`, ...), for the silence warning. */
function lineType(line: string): string {
  try { const t = (JSON.parse(line) as { type?: unknown }).type; return typeof t === 'string' ? t : 'unknown'; } catch { return 'unparsed line'; }
}

class OpencodeSession extends TurnSession {
  protected readonly harness = 'opencode' as const;
  readonly parser = new OpencodeParser();
  private subagents: SubagentWatcher;
  private deadlinesWarned = false;

  constructor(id: string, private bin: string, private cwd: string, resumeId: string | undefined, private model?: string, private effort?: Effort, private log: Pick<StartOpts, 'logFile' | 'onLogOffset' | 'env'> = {}, private graceMs = TURN_END_GRACE_MS, private dbPath = opencodeDbPath(), prime = !!resumeId, private silenceMs = TURN_SILENCE_MS, pollMs?: number) {
    super(log.logFile, id, pollMs);
    this.parser.sessionId = resumeId ?? null;
    // A resumed (or adopted) session already has parts in the store: its watcher primes first so earlier turns stay out of the trace.
    // Adoption primes whatever the row holds: a worker adopted during its first turn has no recorded native session id yet.
    this.subagents = new SubagentWatcher(dbPath, () => this.parser.sessionId, prime);
  }

  /** The latest deadline among the running tool calls of this session and its sub-agents, or undefined (none, or the store unreadable). */
  private latestToolDeadline(): number | undefined {
    const root = this.parser.sessionId;
    if (!root) return undefined;
    try {
      const deadlines = runningToolDeadlines(this.dbPath, [root, ...this.subagents.childSessions()]);
      return deadlines.length ? Math.max(...deadlines.map((d) => d.deadline)) : undefined;
    } catch (err) {
      if (!this.deadlinesWarned) {
        this.deadlinesWarned = true;
        log.warn(`opencode store ${this.dbPath} could not be read for running tool calls, the silence counts from the last event only: ${(err as Error).message}`);
      }
      return undefined;
    }
  }

  /** Follows a turn an earlier daemon started; the turn ends when the process is gone. */
  adopt(o: AdoptOpts): void {
    // The row holds the native id only after a turn_end, and the CLI prints nothing during a task call, so an adoption
    // mid-turn takes the id from the lines already in the log, then primes the watcher so only later sub-agent work is reported.
    if (!this.parser.sessionId) {
      this.parser.sessionId = sessionIdInLog(o.logFile, o.logOffset);
      this.subagents.poll();
    }
    super.adopt(o); // at `adoptLines`' defaults unless the adapter was given `pollMs`
  }

  protected runTurn(text: string): void {
    const p = spawnOpencode(this.bin, this.cwd, this.parser.sessionId, text, { model: this.model, effort: this.effort, logFile: this.log.logFile, env: this.log.env, pollMs: this.pollMs });
    this.follow(p, false);
  }

  protected async pump(p: LineProcess, adopted: boolean): Promise<void> {
    const { pid, pidStartedAt, spawnedAt } = await this.processStarted(p, adopted);
    const grace = new TurnGrace(p, this.graceMs, `opencode session ${this.sessionLabel()} (pid ${pid}) reported step_finish with reason stop`, this.log.logFile, pidStartedAt ?? new Date(spawnedAt).toISOString());
    this.parser.turnCompleted = false;
    // Silence: every event resets the timer; on expiry a running tool call's later deadline defers it to that deadline plus
    // the silence, and otherwise a zero-length TurnGrace kills and sweeps like the `stop` grace.
    let lastType = 'none';
    let silentGrace: TurnGrace | null = null;
    let silentReason = '';
    let silenced!: () => void;
    const silentFired = new Promise<void>((r) => { silenced = r; });
    const silenceSeconds = this.silenceMs / 1000;
    let silence: NodeJS.Timeout | null = null;
    const heard = (type: string) => {
      lastType = type;
      if (silence) clearTimeout(silence);
      const expire = () => {
        const deadline = this.latestToolDeadline();
        const wait = deadline === undefined ? 0 : deadline + this.silenceMs - Date.now();
        if (wait > 0) { silence = setTimeout(expire, wait); silence.unref(); return; }
        silentReason = `printed nothing for ${silenceSeconds} s after its last event (${lastType})`;
        silentGrace = new TurnGrace(p, 0, `opencode session ${this.sessionLabel()} (pid ${pid}) ${silentReason}`, this.log.logFile, pidStartedAt ?? new Date(spawnedAt).toISOString());
        silentGrace.arm();
        void silentGrace.fired.then(silenced);
      };
      silence = setTimeout(expire, this.silenceMs);
      silence.unref();
    };
    heard(lastType);
    const followSubagents = () => { for (const ev of this.subagents.poll()) { heard(`sub-agent ${ev.type}`); this.queue.push(ev); } };
    const timer = setInterval(followSubagents, this.pollMs ?? SUBAGENT_POLL_MS);
    timer.unref();
    for await (const line of linesUntil(p.lines, Promise.race([grace.fired, silentFired]))) {
      heard(lineType(line));
      if (line.includes('"tool":"task"')) followSubagents(); // the sub-agent's work goes before its finished task call
      for (const ev of this.parser.parse(line)) this.queue.push(ev);
      this.log.onLogOffset?.(p.logOffset());
      if (this.parser.turnCompleted) grace.arm();
    }
    if (silence) clearTimeout(silence);
    const ended = silentGrace as TurnGrace | null;
    const code = await (ended ?? grace).exitCode();
    grace.clear();
    clearInterval(timer);
    followSubagents();
    if (silence) clearTimeout(silence);
    this.proc = null;
    // An error before turn_end leaves the session ended, but its reason on the row, so the reopen note says why.
    if (ended) this.queue.push({ type: 'error', message: `opencode ${silentReason}; the turn was ended` });
    else if (code !== 0) this.queue.push({ type: 'error', message: `opencode exited with code ${code}` });
    const usage = this.parser.takeUsage();
    const requests = this.parser.takeRequests();
    this.finishTurn({ type: 'turn_end', nativeSessionId: this.parser.sessionId ?? '', cost: this.parser.cost, ...(usage ? { usage } : {}), ...(requests ? { requests } : {}) });
  }
}

export class OpencodeAdapter extends BaseAdapter<OpencodeSession> {
  readonly name = 'opencode' as const;
  /** `graceMs`: see `TurnGrace`; tests pass a small value. */
  /** `dbPath`: opencode's session store, followed for sub-agent activity (`SubagentWatcher`); tests pass their own. */
  /** `silenceMs`: see `TURN_SILENCE_MS`; tests pass a small value. */
  /** `pollMs`: the log tail, adoption and sub-agent store polls (their production defaults when unset); tests pass a small value. */
  constructor(private bin = 'opencode', private graceMs = TURN_END_GRACE_MS, private dbPath = opencodeDbPath(), private silenceMs = TURN_SILENCE_MS, private pollMs?: number) { super(); }

  protected create(id: string, opts: StartOpts): OpencodeSession {
    // A critic session is started with the Overseer server so it can call `submit_review`; without this the option was
    // dropped and the verdict was lost. The config travels in the environment, which every turn of the session reuses.
    const started = opts.mcpServers?.length ? { ...opts, env: { ...opts.env, OPENCODE_CONFIG: writeOpencodeMcpConfig(id, opts.mcpServers) } } : opts;
    return new OpencodeSession(id, this.bin, opts.cwd, opts.resumeId, opts.model, opts.effort, started, this.graceMs, this.dbPath, !!opts.resumeId, this.silenceMs, this.pollMs);
  }
  protected createAdopted(id: string, o: AdoptOpts): OpencodeSession {
    return new OpencodeSession(id, this.bin, o.cwd, o.nativeSessionId ?? undefined, undefined, undefined, o, this.graceMs, this.dbPath, true, this.silenceMs, this.pollMs);
  }
}
