import type { HarnessName, Effort, SessionRole } from '@overseer/shared';

export type HarnessEvent =
  | { type: 'assistant_text'; text: string; parentId?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; parentId?: string }
  | { type: 'tool_result'; id: string; output: unknown }
  | { type: 'file_change'; path: string }
  /** Context the main thread's last request used (input + cache creation + cache read tokens); subagent messages are not counted. */
  | { type: 'context'; tokens: number; model: string }
  /** `contextWindows`: model id → context window in tokens, from the harness's per-model usage at turn end. */
  /** One completed turn's token counters, its own and (for opencode) broken down per model response in `requests`. */
  /** `authFailed`: the turn ended on an API 401 (claude's `api_error_status`). */
  | { type: 'turn_end'; nativeSessionId: string; cost?: number; usage?: TokenUsage; requests?: TokenUsage[]; contextWindows?: Record<string, number>; authFailed?: boolean }
  | { type: 'process_start'; pid: number; pidStartedAt: string | null }
  | { type: 'rate_limit'; kind: 'rate_limit'; resetsAt: string | null; bucket: string | null; raw: unknown }
  /** A CLI's own usage-limit refusal (codex): `resetsAt` is null when the message names no readable time, `message` is kept whole. */
  | { type: 'usage_limit'; resetsAt: string | null; message: string }
  /** The CLI's synthetic reply to a rejected credential (claude `error: "authentication_failed"`), in place of `assistant_text`. */
  | { type: 'auth_failed'; text: string; error: string }
  | { type: 'raw'; line: string }
  | { type: 'error'; message: string };

/** Token counters a harness reports for one completed turn. Missing counters were not reported by that CLI. */
export interface TokenUsage {
  /** Input tokens as the CLI reports them: opencode's is the non-cached slice, codex's includes the cache counters. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** The slice of `cacheWrite` written with Claude's 1-hour cache TTL (`cache_creation.ephemeral_1h_input_tokens`), billed at 2x the input rate rather than the 5-minute `cacheWrite` rate. */
  cacheWrite1h?: number;
  reasoning?: number;
}

export interface McpServerConfig { name: string; url: string }

export interface StartOpts {
  cwd: string;
  prompt: string;
  systemPromptFile?: string;
  mcpServers?: McpServerConfig[];
  resumeId?: string;
  model?: string;
  effort?: Effort;
  /** The session's role; claude runs workers and critics without the context-mode plugin. */
  role?: SessionRole;
  /** Reject Bash calls with `run_in_background` (workers): the session ends when the model yields, so a background job's result is lost. */
  denyBackground?: boolean;
  /** Add prompt-eval-only PreToolUse guards for network access and file writes outside the eval cwd. */
  evalSandbox?: boolean;
  /** Limit Claude's built-in tools for a hermetic prompt-eval session. MCP tools remain configured separately. */
  tools?: string[];
  /** Load only `mcpServers`, none of the user's configured MCP servers (claude `--strict-mcp-config`); the prompt eval sets it, the daemon does not. */
  strictMcpConfig?: boolean;
  /** Stop the session once it has spent this many dollars (claude `--max-budget-usd`, checked after each API call); the prompt eval sets it. */
  maxBudgetUsd?: number;
  /** Save no native session under the user's Claude config (claude `--no-session-persistence`), so a run keeps its state in its own temp dir; the prompt eval sets it. */
  noSessionPersistence?: boolean;
  /** Where the harness process writes its stdout (stderr to `<logFile>.err`); the daemon tails it, so the process outlives the daemon. */
  logFile?: string;
  /** Called with the byte offset of the log consumed so far, so a later daemon can adopt the process and resume from there. */
  onLogOffset?: (offset: number) => void;
  env?: NodeJS.ProcessEnv;
}

/** A harness process a previous daemon spawned: it is followed from `logOffset` in its log until the pid is gone. */
export interface AdoptOpts {
  pid: number;
  cwd: string;
  logFile: string;
  logOffset: number;
  nativeSessionId: string | null;
  onLogOffset?: (offset: number) => void;
  env?: NodeJS.ProcessEnv;
}

/** `nativeId` is the CLI's own session id when the adapter chose it at spawn (claude's `--session-id`), before any turn reports one. */
export interface SessionHandle { id: string; pid?: number; nativeId?: string }

export interface HarnessAdapter {
  name: HarnessName;
  start(opts: StartOpts): SessionHandle;
  adopt(opts: AdoptOpts): SessionHandle;
  send(handle: SessionHandle, text: string): Promise<void>;
  interrupt(handle: SessionHandle): Promise<void>;
  end(handle: SessionHandle): Promise<void>;
  events(handle: SessionHandle): AsyncIterable<HarnessEvent>;
}
