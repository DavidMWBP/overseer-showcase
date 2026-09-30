// The config file is not typechecked (tsconfig includes only `src`) and is only loaded by vitest itself,
// so a change to the worker cap or its override would pass every other check. Importing it here makes
// `pnpm test` fail the same way vitest would.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { slowTestFiles } from '../vitest.config';

type ResolvedDaemonConfig = {
  test: { poolOptions: { forks: { maxForks: number } }; include: string[]; exclude: string[] };
};

async function loadMode(mode: string): Promise<ResolvedDaemonConfig> {
  vi.resetModules();
  const { default: factory } = await import('../vitest.config');
  return (factory as unknown as (env: { mode: string }) => ResolvedDaemonConfig)({ mode });
}

const load = () => loadMode('test');

// The only pattern either list uses is `src/**/*.test.ts` (matches any depth) or a literal path;
// this is not a general glob matcher, just enough to check the one shape this config produces.
function matchesPattern(pattern: string, file: string): boolean {
  if (!pattern.includes('*')) return pattern === file;
  const regex = new RegExp(
    '^' +
      pattern
        .split('**/')
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('(?:.*/)?') +
      '$'
  );
  return regex.test(file);
}

const srcDir = __dirname;

function findTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findTestFiles(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push('src/' + relative(srcDir, full).split(sep).join('/'));
  }
  return out;
}

describe('vitest.config.ts', () => {
  it('caps the fork pool at 4 by default', async () => {
    delete process.env.OVERSEER_VITEST_MAX_FORKS;
    expect((await load()).test.poolOptions.forks.maxForks).toBe(4);
  });

  it('follows OVERSEER_VITEST_MAX_FORKS and ignores empty or non-numeric values', async () => {
    try {
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

describe('slowTestFiles', () => {
  it('names only files that exist on disk', () => {
    const onDisk = new Set(findTestFiles(srcDir));
    const missing = slowTestFiles.filter((f) => !onDisk.has(f));
    expect(missing).toEqual([]);
  });

  it('keeps large evidence listings in the slow run', async () => {
    const file = 'src/api/evidence.performance.test.ts';
    const fast = (await loadMode('test')).test;
    const slow = (await loadMode('slow')).test;
    expect({
      listed: slowTestFiles.includes(file),
      reachedByFast: fast.include.some((pattern) => matchesPattern(pattern, file)) && !fast.exclude.some((pattern) => matchesPattern(pattern, file)),
      reachedBySlow: slow.include.some((pattern) => matchesPattern(pattern, file)),
    }).toEqual({ listed: true, reachedByFast: false, reachedBySlow: true });
  });

  it('covers every test file with exactly one run: the fast default run, or the slow run', async () => {
    const onDisk = findTestFiles(srcDir);
    const fast = (await loadMode('test')).test;
    const slow = (await loadMode('slow')).test;

    const reachedByFast = (f: string) =>
      fast.include.some((p) => matchesPattern(p, f)) && !fast.exclude.some((p) => matchesPattern(p, f));
    const reachedBySlow = (f: string) => slow.include.some((p) => matchesPattern(p, f));

    const neither = onDisk.filter((f) => !reachedByFast(f) && !reachedBySlow(f));
    const both = onDisk.filter((f) => reachedByFast(f) && reachedBySlow(f));
    expect(neither).toEqual([]);
    expect(both).toEqual([]);
  });
});
