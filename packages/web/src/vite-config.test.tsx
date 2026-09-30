// @vitest-environment node
// Importing vite (through the config) needs Node globals; jsdom breaks esbuild's TextEncoder check.
import path from 'node:path';
import { loadEnv } from 'vite';
import { describe, it, expect, vi } from 'vitest';
import config from '../vite.config';

// The config is loaded by `vite` at start, not by typecheck: a bad import there (2026-09-14: `loadEnv` from 'vitest/config')
// passed every other check and broke `pnpm start`. Importing it here makes `pnpm test` fail the same way Vite would.
// The same merge the config uses, so a value in the repo-root .env is expected too.
const env = { ...loadEnv('', path.resolve(import.meta.dirname, '../../..'), 'OVERSEER_'), ...process.env };

describe('vite.config.ts', () => {
  it('loads and keeps the daemon proxy, the open host and the env-driven allowed hosts', () => {
    const c = config as { server: { host: unknown; port: number; proxy: Record<string, { target: string }>; allowedHosts: string[] } };
    expect(c.server.host).toBe(true);
    expect(c.server.port).toBe(Number(env.OVERSEER_WEB_PORT ?? 5173));
    // No strictPort: a second worktree's dev server must be free to move to the next port.
    expect((c.server as { strictPort?: boolean }).strictPort).toBeUndefined();
    expect(c.server.proxy['/api']?.target).toBe(`http://127.0.0.1:${Number(env.OVERSEER_PORT ?? 4400)}`);
    expect(Array.isArray(c.server.allowedHosts)).toBe(true);
  });

  it('follows OVERSEER_PORT for the daemon proxy target', async () => {
    process.env.OVERSEER_PORT = '4401';
    vi.resetModules();
    try {
      const { default: reloaded } = await import('../vite.config');
      const c = reloaded as { server: { proxy: Record<string, { target: string }> } };
      expect(c.server.proxy['/api']?.target).toBe('http://127.0.0.1:4401');
    } finally {
      delete process.env.OVERSEER_PORT;
    }
  });

  it('caps the fork pool at 4 and follows OVERSEER_VITEST_MAX_FORKS, ignoring empty and non-numeric values', async () => {
    const load = async () => {
      vi.resetModules();
      const { default: reloaded } = await import('../vite.config');
      return reloaded as { test: { poolOptions: { forks: { maxForks: number } } } };
    };

    delete process.env.OVERSEER_VITEST_MAX_FORKS;
    try {
      expect((await load()).test.poolOptions.forks.maxForks).toBe(4);

      process.env.OVERSEER_VITEST_MAX_FORKS = '8';
      expect((await load()).test.poolOptions.forks.maxForks).toBe(8);

      process.env.OVERSEER_VITEST_MAX_FORKS = '';
      expect((await load()).test.poolOptions.forks.maxForks).toBe(4);

      process.env.OVERSEER_VITEST_MAX_FORKS = 'abc';
      expect((await load()).test.poolOptions.forks.maxForks).toBe(4);
    } finally {
      delete process.env.OVERSEER_VITEST_MAX_FORKS;
    }
  });
});
