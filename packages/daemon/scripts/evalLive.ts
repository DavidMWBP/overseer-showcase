/**
 * What `scripts/prompt-eval.ts` and `scripts/prompt-loop.ts` share about the live install: its config, the live orchestrator's
 * settings and account read from a read-only database handle, the account's environment without a refresh, and one fresh
 * `claude -p` call with no tools, no MCP server and no saved session. Importing this module drops the calling session's own
 * Claude variables from `process.env`, so every CLI started afterwards is a fresh session on the account given to it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OrchestratorSettings } from '@overseer/shared';
import { loadConfig } from '../src/config';
import type { StoredAccount } from '../src/db/db';
import { killProcess, spawnLines } from '../src/util/procs';
import { candidateEnv } from '../src/discussions/eval';
import { claudeProjectDir } from '../src/evals/promptEval';
import { evalSessionEnv } from '../src/evals/gitEnv';

/** The live install, read before anything else: its database is only ever opened read-only, and its port is never served. */
export const LIVE = loadConfig(process.env);

for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC_API_KEY)/.test(key)) delete process.env[key];

export interface Live { settings: OrchestratorSettings; account: StoredAccount | null }
/** The live orchestrator settings and its account row, from a read-only handle; read again before each run to pick up a refreshed token. */
export function readLive(): Live {
  const db = new DatabaseSync(path.join(LIVE.dataDir, 'overseer.db'), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='orchestrator'").get() as { value: string } | undefined;
    const settings: OrchestratorSettings = row ? JSON.parse(row.value) as OrchestratorSettings : { model: null, effort: null, promptOverride: null };
    const account = settings.account ? db.prepare('SELECT * FROM accounts WHERE id=?').get(settings.account) as unknown as StoredAccount | undefined : null;
    if (account === undefined) throw new Error(`the live orchestrator names account ${settings.account}, which is missing`);
    return { settings, account };
  } finally {
    db.close();
  }
}

/** The account's environment, refused when its token would expire before `until`: refreshing it here would revoke the live install's. */
export function envUntil(live: Live, until: number): NodeJS.ProcessEnv {
  const { settings, account } = live;
  return candidateEnv({ harness: 'claude', model: settings.model ?? '', effort: settings.effort, account: account?.id ?? null }, new Map(account ? [[account.id, account]] : []), until);
}

export interface ClaudeResult { text: string; cost: number; error: string | null }
/** How long one `claudeCall` may run before its process tree is killed; a rewriter call on a 200k-character input took 5 minutes. */
export const CLAUDE_CALL_TIMEOUT_MS = 30 * 60_000;
/**
 * One fresh `claude -p` call with no tools, no MCP server and no saved session, capped at `cap` dollars; no model is the CLI
 * default. `effort` passes `--effort`; `evalEnv` starts it with Git's system and global configuration switched off, the way
 * eval sessions start (`evalSessionEnv`). A call still running after `timeoutMs` (default `CLAUDE_CALL_TIMEOUT_MS`) has its
 * process tree killed and returns an error naming the timeout, so a stalled CLI cannot hold the probe, a judge or a rewrite.
 */
export async function claudeCall(prompt: string, model: string | undefined, env: NodeJS.ProcessEnv, cap: number, opts: { effort?: string; evalEnv?: boolean; timeoutMs?: number } = {}): Promise<ClaudeResult> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-eval-call-'));
  try {
    const args = ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), ...(opts.effort ? ['--effort', opts.effort] : []), '--max-budget-usd', cap.toFixed(2), '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
    const p = spawnLines(LIVE.claudeBin, args, { cwd, env: opts.evalEnv ? evalSessionEnv(env, cwd) : env });
    const timeoutMs = opts.timeoutMs ?? CLAUDE_CALL_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (p.pid) void killProcess(p.pid); }, timeoutMs);
    p.stdin?.end(prompt);
    const lines: string[] = [];
    let code: number;
    try {
      for await (const line of p.lines) lines.push(line);
      code = await p.exit;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return { text: '', cost: 0, error: `claude timed out after ${Math.round(timeoutMs / 1000)} s and its process tree was killed` };
    let parsed: { result?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string } = {};
    try { parsed = JSON.parse(lines.join('\n')) as typeof parsed; } catch { /* no JSON: the cost is unknown and counted as 0 */ }
    const failed = code !== 0 || parsed.is_error || parsed.result === undefined;
    const stderr = (p.child as { stderrText?: string } | undefined)?.stderrText ?? '';
    return { text: parsed.result ?? '', cost: parsed.total_cost_usd ?? 0, error: failed ? `claude exited ${code}${parsed.subtype ? ` (${parsed.subtype})` : ''}: ${(stderr || lines.join('\n')).slice(-500)}` : null };
  } finally {
    removeClaudeLeftover(cwd);
    removeTemp(cwd);
  }
}

/** Removes a temp dir; a file a just-exited process still holds on Windows leaves it for the OS temp cleanup rather than failing the run. */
export function removeTemp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`left ${dir}: ${err instanceof Error ? err.message : String(err)}`); }
}

/**
 * Removes the folder the Claude CLI made for an ended run's temp `cwd` under the user's projects (see `claudeProjectDir`), and
 * only while it holds no file: with `--no-session-persistence` it is empty folders, and anything more is kept and named.
 */
export function removeClaudeLeftover(cwd: string): void {
  const dir = claudeProjectDir(cwd, path.join(os.homedir(), '.claude'));
  if (!fs.existsSync(dir)) return;
  const holdsFile = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => !e.isDirectory() || holdsFile(path.join(d, e.name)));
  if (holdsFile(dir)) { console.warn(`kept ${dir}: the CLI saved files there`); return; }
  removeTemp(dir);
}
