import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Repo } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { Bus } from '../bus';
import { loadConfig } from '../config';
import { MemoryTaskStore } from '../beads/memory';
import { ActionJobs } from './jobs';
import { registerRest } from './rest';
import type { AppDeps } from '../app';

interface Context {
  app: FastifyInstance;
  db: Db;
  root: string;
  repoPath: string;
  homeDir: string;
  setNow(value: number): void;
}

async function setup(): Promise<Context> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-command-rest-'));
  const repoPath = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  expect(path.resolve(homeDir)).not.toBe(path.resolve(os.homedir()));
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const db = openDb(':memory:');
  const repo: Repo = {
    id: 'r1', path: repoPath, base_branch: 'main', verify_command: null, setup_command: null,
    merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null,
  };
  db.repos.insert(repo);
  const bus = new Bus();
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), worktreesDir: path.join(dataDir, 'worktrees') };
  const app = Fastify({ logger: false });
  registerRest(app, { db, bus, config, store: new MemoryTaskStore(), jobs: new ActionJobs(bus) } as unknown as AppDeps);
  await app.ready();
  return { app, db, root, repoPath, homeDir, setNow: (value) => { now = value; } };
}

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

const url = '/api/repos/r1/commands';

describe('repo commands REST', () => {
  let x: Context;
  beforeEach(async () => { x = await setup(); });
  afterEach(async () => {
    await x.app.close();
    vi.restoreAllMocks();
    x.db.sql.close();
    fs.rmSync(x.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('returns repo commands sorted by name', async () => {
    write(x.repoPath, '.claude/commands/zeta.md', '---\ndescription: Last\n---\n');
    write(x.repoPath, '.claude/commands/alpha.md', '---\ndescription: First\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([
      { name: 'alpha', description: 'First', kind: 'command', source: 'repo' },
      { name: 'zeta', description: 'Last', kind: 'command', source: 'repo' },
    ]);
  });

  it('uses colons for nested command path segments', async () => {
    write(x.repoPath, '.claude/commands/frontend/component.md', '---\ndescription: Component work\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'frontend:component', description: 'Component work', kind: 'command', source: 'repo' }]);
  });

  it('uses a skill frontmatter name and description', async () => {
    write(x.repoPath, '.claude/skills/review/SKILL.md', '---\nname: code-review\ndescription: Review changes\n---\nInstructions.\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'code-review', description: 'Review changes', kind: 'skill', source: 'repo' }]);
  });

  it('reads frontmatter after a UTF-8 BOM', async () => {
    write(x.repoPath, '.claude/commands/bom.md', '\uFEFF---\nname: ignored\ndescription: Read the metadata\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'bom', description: 'Read the metadata', kind: 'command', source: 'repo' }]);
  });

  it('trims whitespace from frontmatter fence lines', async () => {
    write(x.repoPath, '.claude/commands/fenced.md', '---  \ndescription: Trim the fences\n  ---\t\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'fenced', description: 'Trim the fences', kind: 'command', source: 'repo' }]);
  });

  it('falls back to the skill folder name without a frontmatter name', async () => {
    write(x.repoPath, '.claude/skills/release-notes/SKILL.md', '---\ndescription: Summarize releases\n---\nInstructions.\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'release-notes', description: 'Summarize releases', kind: 'skill', source: 'repo' }]);
  });

  it('includes global commands from the injected home directory', async () => {
    write(x.homeDir, '.claude/commands/cleanup.md', '---\ndescription: Clean generated files\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'cleanup', description: 'Clean generated files', kind: 'command', source: 'global' }]);
  });

  it('keeps a repo entry when a global entry has the same name', async () => {
    write(x.repoPath, '.claude/commands/deploy.md', '---\ndescription: Repo deploy\n---\n');
    write(x.homeDir, '.claude/commands/deploy.md', '---\ndescription: Global deploy\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'deploy', description: 'Repo deploy', kind: 'command', source: 'repo' }]);
  });

  it('prefers a repo skill over a repo command with the same name', async () => {
    write(x.repoPath, '.claude/commands/deploy.md', '---\ndescription: Command description\n---\n');
    write(x.repoPath, '.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Skill description\n---\nInstructions.\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'deploy', description: 'Skill description', kind: 'skill', source: 'repo' }]);
  });

  it('lists a command with empty description when frontmatter is broken', async () => {
    write(x.repoPath, '.claude/commands/broken.md', '---\ndescription: [unclosed\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'broken', description: '', kind: 'command', source: 'repo' }]);
  });

  it('returns an empty list when command and skill folders are missing', async () => {
    fs.mkdirSync(path.join(x.repoPath, '.claude'));
    fs.mkdirSync(path.join(x.homeDir, '.claude'));
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([]);
  });

  it('returns 404 for an unknown repo', async () => {
    const response = await x.app.inject({ method: 'GET', url: '/api/repos/missing/commands' });
    expect([response.statusCode, response.json()]).toEqual([404, { error: 'repo missing not found' }]);
  });

  it('trims a multi-line description to its first line', async () => {
    write(x.repoPath, '.claude/commands/report.md', '---\ndescription: |\n  First line\n  Second line\n---\n');
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'report', description: 'First line', kind: 'command', source: 'repo' }]);
  });

  it('refreshes the per-repo cache after 30 seconds', async () => {
    x.setNow(100);
    write(x.repoPath, '.claude/commands/first.md', '');
    const first = await x.app.inject({ method: 'GET', url });
    write(x.repoPath, '.claude/commands/second.md', '');
    x.setNow(30_099);
    const cached = await x.app.inject({ method: 'GET', url });
    x.setNow(30_100);
    const refreshed = await x.app.inject({ method: 'GET', url });
    expect([first.json().map((entry: { name: string }) => entry.name), cached.json().map((entry: { name: string }) => entry.name), refreshed.json().map((entry: { name: string }) => entry.name)])
      .toEqual([['first'], ['first'], ['first', 'second']]);
  });

  it('does not follow a command directory symlink outside the repo command folder', async ({ skip }) => {
    const outside = path.join(x.root, 'outside');
    const commands = path.join(x.repoPath, '.claude', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(commands, 'local.md'), '', 'utf8');
    fs.writeFileSync(path.join(outside, 'nested', 'escaped.md'), '', 'utf8');
    try {
      fs.symlinkSync(outside, path.join(commands, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') { skip(); return; }
      throw error;
    }
    const response = await x.app.inject({ method: 'GET', url });
    expect(response.json()).toEqual([{ name: 'local', description: '', kind: 'command', source: 'repo' }]);
  });
});
