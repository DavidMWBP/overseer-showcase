import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relaunchDaemon, RESTART_INSTALL_COMMAND, RESTART_INSTALL_TIMEOUT_MS, restartInputHash, startupRestartInputHash } from './daemon';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkout(): { dataDir: string; sourceRoot: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-daemon-restart-'));
  const sourceRoot = path.join(dataDir, 'checkout');
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"test"}\n');
  fs.writeFileSync(path.join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.mkdirSync(path.join(sourceRoot, 'packages', 'daemon'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'daemon', 'package.json'), '{"name":"@test/daemon"}\n');
  fs.mkdirSync(path.join(sourceRoot, 'packages', 'web'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'packages', 'web', 'package.json'), '{"name":"@test/web"}\n');
  roots.push(dataDir);
  return { dataDir, sourceRoot };
}

function child(onExit = false) {
  return {
    pid: 4321,
    once: vi.fn((event: string, callback: () => void) => {
      if (event === 'spawn' || (event === 'exit' && onExit)) callback();
      return child;
    }),
    unref: vi.fn(),
  } as never;
}

const app = { close: vi.fn(async () => {}) } as unknown as FastifyInstance;

describe('daemon restart dependency install', () => {
  it('keeps an unknown startup hash safe and installs on the next restart', async () => {
    const { dataDir, sourceRoot } = checkout();
    fs.rmSync(path.join(sourceRoot, 'pnpm-lock.yaml'));
    const startupInputHash = startupRestartInputHash(sourceRoot);
    expect(startupInputHash).toBeUndefined();

    fs.writeFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const installRunner = vi.fn(async () => ({ code: 0, output: '', timedOut: false }));
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash,
      installRunner,
      spawn: (() => child()) as never,
      waitForSuccessor: async () => {},
      exit: vi.fn(),
    });
    expect(installRunner).toHaveBeenCalledWith(RESTART_INSTALL_COMMAND, sourceRoot, RESTART_INSTALL_TIMEOUT_MS);
  });

  it('reports the missing file when restart inputs cannot be read during relaunch', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.rmSync(path.join(sourceRoot, 'pnpm-lock.yaml'));
    const spawn = vi.fn(() => child());
    let failure: unknown;
    try {
      await relaunchDaemon(app, dataDir, { pid: 4321, sourceRoot, startupInputHash, spawn: spawn as never });
    } catch (error) { failure = error; }
    const reported = failure as Error & { restartFailure?: { reason: string; output: string[] } };
    expect({ reason: reported?.restartFailure?.reason, output: reported?.restartFailure?.output, spawned: spawn.mock.calls.length })
      .toEqual({
        reason: expect.stringContaining('Could not calculate restart input hash: ENOENT'),
        output: [],
        spawned: 0,
      });
    expect(reported.restartFailure?.reason).toContain('pnpm-lock.yaml');
  });

  it('does not install when the startup lockfile and manifests are unchanged', async () => {
    const { dataDir, sourceRoot } = checkout();
    const installRunner = vi.fn(async () => ({ code: 0, output: '', timedOut: false }));
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash: restartInputHash(sourceRoot),
      installRunner,
      spawn: (() => child()) as never,
      waitForSuccessor: async () => {},
      exit: vi.fn(),
    });
    expect(installRunner).not.toHaveBeenCalled();
  });

  it('installs after a lockfile change and before spawning the successor', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.appendFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'importers: {}\n');
    const order: string[] = [];
    const installRunner = vi.fn(async (...args: [string, string, number]) => {
      void args;
      order.push('install');
      return { code: 0, output: '', timedOut: false };
    });
    const spawn = vi.fn(() => { order.push('spawn'); return child(); });
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash,
      installRunner,
      spawn: spawn as never,
      waitForSuccessor: async () => { order.push('ready'); },
      exit: vi.fn(),
    });
    expect({ order, install: installRunner.mock.calls[0] }).toEqual({
      order: ['install', 'spawn', 'ready'],
      install: [RESTART_INSTALL_COMMAND, sourceRoot, RESTART_INSTALL_TIMEOUT_MS],
    });
  });

  it('installs when a package manifest changes without a lockfile change', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'packages', 'daemon', 'package.json'), '{"name":"@test/daemon","dependencies":{"yaml":"^2.8.1"}}\n');
    const installRunner = vi.fn(async () => ({ code: 0, output: '', timedOut: false }));
    const spawn = vi.fn(() => child());
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash,
      installRunner,
      spawn: spawn as never,
      waitForSuccessor: async () => {},
      exit: vi.fn(),
    });
    expect({ installs: installRunner.mock.calls.length, spawned: spawn.mock.calls.length }).toEqual({ installs: 1, spawned: 1 });
  });

  it('installs when the packages/web manifest changes', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'packages', 'web', 'package.json'), '{"name":"@test/web","dependencies":{"react":"^19"}}\n');
    const installRunner = vi.fn(async () => ({ code: 0, output: '', timedOut: false }));
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash,
      installRunner,
      spawn: (() => child()) as never,
      waitForSuccessor: async () => {},
      exit: vi.fn(),
    });
    expect(installRunner).toHaveBeenCalledOnce();
  });

  it('installs when pnpm-workspace.yaml changes', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.appendFileSync(path.join(sourceRoot, 'pnpm-workspace.yaml'), '# workspace changed\n');
    const installRunner = vi.fn(async () => ({ code: 0, output: '', timedOut: false }));
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash,
      installRunner,
      spawn: (() => child()) as never,
      waitForSuccessor: async () => {},
      exit: vi.fn(),
    });
    expect(installRunner).toHaveBeenCalledOnce();
  });

  it('skips install when manifests change under .claude/worktrees and .ds-sync', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    const claudeWorktrees = path.join(sourceRoot, '.claude', 'worktrees', 'temporary');
    const dsSync = path.join(sourceRoot, '.ds-sync');
    fs.mkdirSync(claudeWorktrees, { recursive: true });
    fs.mkdirSync(dsSync, { recursive: true });
    fs.writeFileSync(path.join(claudeWorktrees, 'package.json'), '{"name":"temporary"}\n');
    fs.writeFileSync(path.join(dsSync, 'package.json'), '{"name":"sync"}\n');
    const installRunner = vi.fn(async () => ({ code: 0, output: '', timedOut: false }));
    await relaunchDaemon(app, dataDir, {
      pid: 4321,
      sourceRoot,
      startupInputHash,
      installRunner,
      spawn: (() => child()) as never,
      waitForSuccessor: async () => {},
      exit: vi.fn(),
    });
    expect(installRunner).not.toHaveBeenCalled();
  });

  it('includes the root package.json in the restart input hash', () => {
    const { sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.appendFileSync(path.join(sourceRoot, 'package.json'), '{"scripts":{"changed":true}}\n');
    expect(restartInputHash(sourceRoot)).not.toBe(startupInputHash);
  });

  it('stops before successor spawn when dependency installation fails', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.appendFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'changed: true\n');
    const output = Array.from({ length: 22 }, (_, index) => `install line ${index + 1}`).join('\n');
    const installRunner = vi.fn(async () => ({ code: 23, output, timedOut: false }));
    const spawn = vi.fn(() => child());
    let failure: unknown;
    try {
      await relaunchDaemon(app, dataDir, { pid: 4321, sourceRoot, startupInputHash, installRunner, spawn: spawn as never });
    } catch (error) { failure = error; }
    const reported = failure as Error & { restartFailure?: { reason: string; output: string[] } };
    expect({
      reason: reported?.restartFailure?.reason,
      output: reported?.restartFailure?.output,
      spawned: spawn.mock.calls.length,
      install: installRunner.mock.calls[0],
    }).toEqual({
      reason: `${RESTART_INSTALL_COMMAND} exited with code 23`,
      output: Array.from({ length: 20 }, (_, index) => `install line ${index + 3}`),
      spawned: 0,
      install: [RESTART_INSTALL_COMMAND, sourceRoot, RESTART_INSTALL_TIMEOUT_MS],
    });
  });

  it('records a bounded dependency install timeout and its output without spawning', async () => {
    const { dataDir, sourceRoot } = checkout();
    const startupInputHash = restartInputHash(sourceRoot);
    fs.appendFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'changed: true\n');
    const installRunner = vi.fn(async (...args: [string, string, number]) => {
      void args;
      return { code: 1, output: 'pnpm was still downloading packages', timedOut: true };
    });
    const spawn = vi.fn(() => child());
    let failure: unknown;
    try {
      await relaunchDaemon(app, dataDir, { pid: 4321, sourceRoot, startupInputHash, installRunner, spawn: spawn as never });
    } catch (error) { failure = error; }
    const reported = failure as Error & { restartFailure?: { reason: string; output: string[] } };
    expect({
      reason: reported?.restartFailure?.reason,
      output: reported?.restartFailure?.output,
      timeout: installRunner.mock.calls[0]?.[2],
      spawned: spawn.mock.calls.length,
    }).toEqual({
      reason: `${RESTART_INSTALL_COMMAND} timed out after 300 seconds`,
      output: ['pnpm was still downloading packages'],
      timeout: RESTART_INSTALL_TIMEOUT_MS,
      spawned: 0,
    });
  });

  it('records the last twenty successor output lines when it exits before startup', async () => {
    const { dataDir, sourceRoot } = checkout();
    const logFile = path.join(dataDir, 'daemon-restart.log');
    const output = Array.from({ length: 22 }, (_, index) => `successor line ${index + 1}`).join('\n') + '\n';
    let failure: unknown;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await relaunchDaemon(app, dataDir, {
        pid: 4321,
        sourceRoot,
        startupInputHash: restartInputHash(sourceRoot),
        spawn: (() => { fs.appendFileSync(logFile, output); return child(true); }) as never,
        exit: vi.fn(),
      });
    } catch (error) { failure = error; }
    const reported = failure as Error & { restartFailure?: { reason: string; output: string[] } };
    try {
      expect({ reason: reported?.restartFailure?.reason, output: reported?.restartFailure?.output }).toEqual({
        reason: 'restart successor 4321 exited before it reached startup',
        output: Array.from({ length: 20 }, (_, index) => `successor line ${index + 3}`),
      });
    } finally { kill.mockRestore(); }
  });
});
