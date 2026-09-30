import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export type TmpRepo = { root: string; path: string; worktreesDir: string };

let fixture: string | undefined;

function fixtureRepo(): string {
  if (fixture) return fixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-git-fixture-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  sh(repo, ['init', '-q', '--template=', '-b', 'main']); // no sample hooks: every test copies this .git
  sh(repo, ['config', 'user.email', 'test@example.com']);
  sh(repo, ['config', 'user.name', 'Test']);
  sh(repo, ['config', 'core.autocrlf', 'false']);
  commitFile(repo, 'README.md', '# repo\n', 'init');
  fixture = repo;
  return repo;
}

export function mkTmpRepo(prefix = 'ov-git-'): TmpRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  // Each test gets its own writable .git directory. The fixture has no remote,
  // which keeps origin-specific lifecycle tests free to install their own.
  fs.cpSync(fixtureRepo(), repo, { recursive: true });
  return { root, path: repo, worktreesDir: path.join(root, 'worktrees') };
}

/** Copies a committed Git template so each test has an isolated repository without repeating initialization. */
export function copyTmpRepo(template: TmpRepo, prefix = 'ov-git-'): TmpRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.cpSync(template.path, repo, { recursive: true });
  return { root, path: repo, worktreesDir: path.join(root, 'worktrees') };
}

export function commitFile(cwd: string, file: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  sh(cwd, ['add', file]);
  sh(cwd, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message]);
  return sh(cwd, ['rev-parse', 'HEAD']);
}

const execFileAsync = promisify(execFile);

/** `sh` without blocking the event loop, for tests that run concurrently in one file. */
export async function shAsync(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

/** `commitFile` without blocking the event loop. */
export async function commitFileAsync(cwd: string, file: string, content: string, message: string): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  await shAsync(cwd, ['add', file]);
  await shAsync(cwd, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message]);
  return shAsync(cwd, ['rev-parse', 'HEAD']);
}
