import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openHandleSummary, relaunchDaemon } from './util/daemon';

describe('openHandleSummary', () => {
  it('counts the live resources by kind', async () => {
    const servers = [createServer(), createServer(), createServer()];
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
    try {
      const summary = openHandleSummary();
      expect(summary).toMatch(/TCPServerWrap=[1-9]/);
      expect(summary.split(', ').every((part) => /^\w+=\d+$/.test(part))).toBe(true);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  });
});

describe('relaunchDaemon shutdown diagnostics', () => {
  it('names the open handles when the shutdown bound is reached', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-shutdown-'));
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
    const child = { pid: 9876, once: (event: string, callback: () => void) => { if (event === 'spawn') callback(); }, unref: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await relaunchDaemon({ close: () => new Promise<void>(() => {}) } as unknown as FastifyInstance, dataDir, {
        spawn: (() => child) as never,
        waitForSuccessor: async () => {},
        exit: vi.fn(),
        closeTimeoutMs: 1,
      });
      const message = String(error.mock.calls[0]?.[0]);
      expect(message).toContain('could not close cleanly; exiting so successor 9876 can start');
      expect(message).toMatch(/open handles: .*TCPServerWrap=[1-9]/);
    } finally {
      error.mockRestore();
      await new Promise<void>((resolve) => held.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
