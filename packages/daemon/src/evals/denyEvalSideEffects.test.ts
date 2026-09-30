import { describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (orig) => (await import('../test/procTableStub')).stubbableChildProcess(await orig()));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { ClaudeAdapter } from '../harness/claude';
import { SessionManager } from '../sessions/manager';
import { fakeBin } from '../test/fakeBin';
import { until } from '../test/until';
import { withStubbedProcessTable } from '../test/procTableStub';
import { evalGitEnv, evalSessionEnv } from './gitEnv';

const HOOK = fileURLToPath(new URL('../../hooks/deny-eval-side-effects.cjs', import.meta.url));

interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }

/** Runs a child process without blocking the event loop, so the Vitest worker keeps answering its RPC calls while the git and hook runs add up. */
function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, timeout: 20000 });
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => { error = err; });
    child.on('close', (status) => resolve({ status, stdout, stderr, error }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  });
}

async function command(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await run('git', args, { cwd, env });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertTempRepoIsOutsideCheckout(repo: string): Promise<void> {
  const root = (await command(process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
  const worktrees = (await command(root, ['worktree', 'list', '--porcelain']))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
  const target = path.resolve(repo);
  expect(isInside(os.tmpdir(), target), 'temp repository must be under the OS temp dir').toBe(true);
  expect(isInside(root, target), 'temp repository must not be inside the source checkout').toBe(false);
  expect(worktrees.some((worktree) => isInside(worktree, target)), 'temp repository must not be inside any source worktree').toBe(false);
}

interface TempRepo { root: string; repo: string; marker: string; helperCommand: string; env: NodeJS.ProcessEnv }

/** A two-commit repo under the OS temp dir whose `.gitattributes` maps `*.guard` to the `guard` diff driver and filter, plus a marker-writing helper and the runner's eval environment for it. */
async function createTempRepo(): Promise<TempRepo> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-eval-git-helper-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  await assertTempRepoIsOutsideCheckout(repo);
  await command(repo, ['init', '--quiet']);
  await command(repo, ['config', 'user.name', 'Prompt Eval Guard']);
  await command(repo, ['config', 'user.email', 'prompt-eval@example.invalid']);

  const marker = path.join(root, 'helper-ran.txt');
  const helper = path.join(root, 'helper.cjs');
  fs.writeFileSync(helper, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  const helperCommand = `node "${helper.replace(/\\/g, '/')}"`;
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.guard diff=guard filter=guard\n');
  fs.writeFileSync(path.join(repo, 'sample.guard'), 'before\n');
  await command(repo, ['add', '.gitattributes', 'sample.guard']);
  await command(repo, ['commit', '--quiet', '-m', 'seed helper fixture']);
  fs.writeFileSync(path.join(repo, 'sample.guard'), 'middle\n');
  await command(repo, ['commit', '--quiet', '-am', 'second commit']);
  fs.writeFileSync(path.join(repo, 'sample.guard'), 'after\n');
  const envDir = path.join(root, 'env');
  fs.mkdirSync(envDir);
  return { root, repo, marker, helperCommand, env: { ...process.env, ...evalGitEnv(envDir) } };
}

/** A gitconfig file that sets every helper key the guard knows to the marker helper. */
function helperConfigFile(temp: TempRepo, name: string): string {
  const file = path.join(temp.root, name);
  const value = temp.helperCommand.replace(/"/g, '\\"');
  fs.writeFileSync(file, [
    '[diff]', `\texternal = "${value}"`,
    '[diff "guard"]', `\ttextconv = "${value}"`, `\tcommand = "${value}"`,
    '[filter "guard"]', `\tclean = "${value}"`, `\tsmudge = "${value}"`,
    '[core]', `\tfsmonitor = "${value}"`,
    '',
  ].join('\n'));
  return file;
}

function runHook(repo: string, bashCommand: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return run(process.execPath, [HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: bashCommand }, cwd: repo }),
  });
}

/** The Git reads a reviewer showed reaching a helper through a patch form, or refused on a stock Git for Windows install. */
const GIT_READS = [
  'git diff',
  'git diff --stat',
  'git show HEAD --stat',
  'git log -p',
  'git log -u -1',
  'git log -U1 -1',
  'git log --cc -1',
  'git blame sample.guard',
];

function withTemp(body: (temp: TempRepo) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const temp = await createTempRepo();
    try { await body(temp); } finally { fs.rmSync(temp.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  };
}

describe('prompt-eval Git environment', () => {
  it.each([
    ['system', 'GIT_CONFIG_SYSTEM'],
    ['global', 'GIT_CONFIG_GLOBAL'],
  ])('switches a %s-level helper off, so every Git read passes the hook and runs without it', (level, variable) => withTemp(async (temp) => {
    const outside: NodeJS.ProcessEnv = { ...process.env, [variable]: helperConfigFile(temp, `${level}.gitconfig`) };
    // The fixture's helper is live: without the eval environment a plain `git diff` runs it.
    await run('git', ['diff'], { cwd: temp.repo, env: outside });
    expect(fs.existsSync(temp.marker), `a ${level} helper runs outside the eval environment`).toBe(true);
    fs.rmSync(temp.marker);

    const envDir = path.join(temp.root, 'env');
    const env: NodeJS.ProcessEnv = { ...outside, ...evalGitEnv(envDir, outside) };
    for (const bashCommand of GIT_READS) {
      const hook = await runHook(temp.repo, bashCommand, env);
      expect(hook.stderr, bashCommand).toBe('');
      expect(hook.status, bashCommand).toBe(0);
      const git = await run('git', bashCommand.split(' ').slice(1), { cwd: temp.repo, env });
      expect(git.status, `${bashCommand}: ${git.stderr}`).toBe(0);
    }
    expect(fs.existsSync(temp.marker), `no Git read under the eval environment runs a ${level} helper`).toBe(false);
  })());

  it('drops an inherited GIT_EXTERNAL_DIFF, so git diff runs no helper from it', withTemp(async (temp) => {
    const outside: NodeJS.ProcessEnv = { ...process.env, GIT_EXTERNAL_DIFF: temp.helperCommand };
    const env: NodeJS.ProcessEnv = { ...outside, ...evalGitEnv(path.join(temp.root, 'env'), outside) };
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect((await runHook(temp.repo, 'git diff', env)).status).toBe(0);
    expect((await run('git', ['diff'], { cwd: temp.repo, env })).status).toBe(0);
    expect(fs.existsSync(temp.marker)).toBe(false);
  }));

  it('is the environment the runner hands the session it starts', withStubbedProcessTable(withTemp(async (temp) => {
    const out = path.join(temp.root, 'session-git.json');
    const { bin } = fakeBin('fake-claude-eval-env', [
      "const fs = require('node:fs'); const { spawnSync } = require('node:child_process');",
      "const diff = spawnSync('git', ['diff'], { encoding: 'utf8', windowsHide: true });",
      "const scopes = spawnSync('git', ['config', '--show-scope', '--get-regexp', '^diff\\\\.'], { encoding: 'utf8', windowsHide: true });",
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ nosystem: process.env.GIT_CONFIG_NOSYSTEM ?? null, global: process.env.GIT_CONFIG_GLOBAL ?? null, external: process.env.GIT_EXTERNAL_DIFF ?? null, diff: diff.status, scopes: scopes.stdout }));`,
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
    ].join('\n'));
    // A system-level helper and an external diff in the environment the runner itself inherits.
    const saved = { system: process.env.GIT_CONFIG_SYSTEM, external: process.env.GIT_EXTERNAL_DIFF };
    process.env.GIT_CONFIG_SYSTEM = helperConfigFile(temp, 'system.gitconfig');
    process.env.GIT_EXTERNAL_DIFF = temp.helperCommand;
    const sessionsDir = path.join(temp.root, 'sessions');
    fs.mkdirSync(sessionsDir);
    const db = openDb(':memory:');
    const bus = new Bus();
    const sessions = new SessionManager(db, { claude: new ClaudeAdapter(bin, 10) }, bus, sessionsDir);
    const envDir = path.join(temp.root, 'env');
    let id: string | null = null;
    try {
      const row = sessions.start({ role: 'orchestrator', harness: 'claude', cwd: temp.repo, prompt: 'go', keepAlive: false, env: evalSessionEnv({}, envDir) });
      id = row.id;
      await until(() => fs.existsSync(out), 20000, 'the fake CLI recorded its Git environment');
      const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as { nosystem: string | null; global: string | null; external: string | null; diff: number; scopes: string };
      expect(seen).toMatchObject({ nosystem: '1', global: path.join(envDir, 'empty-gitconfig'), external: null, diff: 0 });
      expect(seen.scopes).not.toMatch(/^system/m);
      expect(fs.existsSync(temp.marker), 'the session ran a system helper').toBe(false);
    } finally {
      if (id) {
        const ended = new Promise<void>((resolve) => { const off = bus.on('session:ended', ({ session }) => { if (session.id === id) { off(); resolve(); } }); });
        await sessions.interrupt(id);
        await ended;
      }
      for (const [key, value] of [['GIT_CONFIG_SYSTEM', saved.system], ['GIT_EXTERNAL_DIFF', saved.external]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  })));
});

describe('prompt-eval Git helper guard', () => {
  it.each([
    'diff.external',
    'diff.guard.command',
    'diff.guard.textconv',
    'filter.guard.clean',
    'core.fsmonitor',
  ])('refuses every Git read when the repository\'s local config sets %s', (key) => withTemp(async (temp) => {
    await command(temp.repo, ['config', key, temp.helperCommand]);
    for (const bashCommand of [...GIT_READS, 'git status --short', 'git log --oneline -3', 'git diff --textconv', 'git grep --textconv sample -- sample.guard']) {
      const result = await runHook(temp.repo, bashCommand, temp.env);
      expect(result.status, bashCommand).toBe(2);
      expect(result.stderr, bashCommand).toContain(`in this repository, because its local config sets ${key}, a command Git may run during a read`);
    }
    expect(fs.existsSync(temp.marker), 'a refused Git read must not run its configured helper').toBe(false);
  })());

  it('refuses a system-level helper when the session did not get the eval environment, and says so', withTemp(async (temp) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_SYSTEM: helperConfigFile(temp, 'system.gitconfig') };
    delete env.GIT_CONFIG_NOSYSTEM;
    const result = await runHook(temp.repo, 'git log --oneline -3', env);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/the system Git config sets diff\.\S+, a command Git may run during a read; the eval runner's environment switches system and global Git config off, and this session did not get it/);
  }));

  it.each([
    ['core.pager', 'git log --oneline -3', /core pager commands/],
    ['pager.log', 'git log --oneline -3', /pager\.log commands/],
  ])('rejects an effective %s helper', (key, bashCommand, reason) => withTemp(async (temp) => {
    await command(temp.repo, ['config', key, temp.helperCommand]);
    const result = await runHook(temp.repo, bashCommand, temp.env);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(reason);
    expect(fs.existsSync(temp.marker)).toBe(false);
  })());

  it.each([
    ['GIT_EXTERNAL_DIFF', 'git diff', /while GIT_EXTERNAL_DIFF names a diff helper/],
    ['GIT_PAGER', 'git log --oneline -3', /pager environment commands/],
    ['PAGER', 'git log --oneline -3', /pager environment commands/],
  ])('rejects the %s helper environment override', (key, bashCommand, reason) => withTemp(async (temp) => {
    const env: NodeJS.ProcessEnv = { ...temp.env, [key]: temp.helperCommand };
    if (key === 'PAGER') delete env.GIT_PAGER;
    const result = await runHook(temp.repo, bashCommand, env);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(reason);
    expect(fs.existsSync(temp.marker)).toBe(false);
  })());

  it.each(['git log --oneline -3', 'git status --short'])('allows %s in a repository with no configured helpers', (bashCommand) => withTemp(async (temp) => {
    const result = await runHook(temp.repo, bashCommand, temp.env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.existsSync(temp.marker)).toBe(false);
  })());
});
