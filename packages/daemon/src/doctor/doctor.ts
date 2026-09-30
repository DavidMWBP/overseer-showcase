import fs from 'node:fs';
import type { DoctorResponse, DoctorTool, DoctorToolName } from '@overseer/shared';
import type { Config } from '../config';

export type VersionRunner = (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Extract the installed Claude Code version from the same `claude --version` output used by Doctor. */
export function claudeCodeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(output)?.[1] ?? null;
}

export async function installedClaudeCodeVersion(config: Config, run: VersionRunner, timeoutMs = 5000): Promise<string | null> {
  try {
    const result = await withTimeout(run(config.claudeBin, ['--version']), timeoutMs);
    return result.code === 0 ? claudeCodeVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

const CLAUDE_LOGIN_HINT = 'Run `claude` once in a terminal to log in if you have not yet.';

const TOOLS: { name: DoctorToolName; required: boolean; bin: (c: Config) => string; fix: string }[] = [
  { name: 'git', required: true, bin: () => 'git', fix: 'Install git and make sure it is on PATH.' },
  { name: 'bd', required: true, bin: (c) => c.bdBin, fix: 'npm install -g @beads/bd\nOn Windows, if the npm postinstall fails, copy bd.exe from the GitHub release into the package\'s bin directory.' },
  { name: 'claude', required: true, bin: (c) => c.claudeBin, fix: `npm install -g @anthropic-ai/claude-code\n${CLAUDE_LOGIN_HINT}` },
  { name: 'codex', required: false, bin: (c) => c.codexBin, fix: 'npm install -g @openai/codex\nThen run `codex login`.' },
  { name: 'opencode', required: false, bin: (c) => c.opencodeBin, fix: 'npm install -g opencode-ai' },
  { name: 'glab', required: false, bin: (c) => c.glabBin, fix: 'Install glab (https://gitlab.com/gitlab-org/cli) and run `glab auth login`.' },
];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function checkTool(t: (typeof TOOLS)[number], config: Config, run: VersionRunner, timeoutMs: number): Promise<DoctorTool> {
  let ok = false;
  let version: string | null = null;
  try {
    const r = await withTimeout(run(t.bin(config), ['--version']), timeoutMs);
    ok = r.code === 0;
    version = ok ? (r.stdout.trim().split(/\r?\n/)[0] ?? '') || null : null;
  } catch {
    ok = false;
  }
  const fix = !ok ? t.fix : t.name === 'claude' ? CLAUDE_LOGIN_HINT : null;
  return { name: t.name, required: t.required, ok, version, fix };
}

function checkDataDir(dir: string): DoctorResponse['data_dir'] {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { path: dir, ok: true, problem: null };
  } catch (e) {
    return { path: dir, ok: false, problem: `cannot write to ${dir}: ${(e as Error).message}` };
  }
}

export async function runDoctor(config: Config, run: VersionRunner, opts: { timeoutMs?: number } = {}): Promise<DoctorResponse> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const tools = await Promise.all(TOOLS.map((t) => checkTool(t, config, run, timeoutMs)));
  return { tools, data_dir: checkDataDir(config.dataDir) };
}
