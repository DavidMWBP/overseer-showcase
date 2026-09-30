import { describe, it, expect } from 'vitest';
import { selectTestRun } from './test-mode';

describe('selectTestRun', () => {
  it('runs a slow file under slow mode when the fast command names it', () => {
    expect(selectTestRun('fast', ['src/daemon-restart.integration.test.ts'])).toEqual({ mode: 'slow' });
  });

  it('runs a fast file under fast mode when the fast command names it', () => {
    expect(selectTestRun('fast', ['src/vitest-config.test.ts'])).toEqual({ mode: 'fast' });
  });

  it('keeps an explicit slow run slow when given a substring filter such as `daemon-restart`', () => {
    expect(selectTestRun('slow', ['daemon-restart'])).toEqual({ mode: 'slow' });
  });

  it('keeps an explicit slow run slow when given a slow file', () => {
    expect(selectTestRun('slow', ['src/beads/beads.live.test.ts'])).toEqual({ mode: 'slow' });
  });

  it('fails an explicit slow run that names only fast files, naming both commands', () => {
    const result = selectTestRun('slow', ['src/vitest-config.test.ts']);
    if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
    expect(result.error).toContain('pnpm --filter @overseer/daemon test');
    expect(result.error).toContain('pnpm --filter @overseer/daemon test:slow');
    expect(result.error).not.toContain('No test files found');
  });

  it('fails a run that names files from both lists, naming both commands', () => {
    const result = selectTestRun('fast', ['src/vitest-config.test.ts', 'src/beads/beads.live.test.ts']);
    if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
    expect(result.error).toContain('pnpm --filter @overseer/daemon test');
    expect(result.error).toContain('pnpm --filter @overseer/daemon test:slow');
  });

  it('runs the whole list matching the requested mode when no file is named', () => {
    expect(selectTestRun('fast', [])).toEqual({ mode: 'fast' });
    expect(selectTestRun('slow', [])).toEqual({ mode: 'slow' });
  });

  it('does not refuse a slow file paired with a bare filter word, in either mode', () => {
    expect(selectTestRun('slow', ['src/beads/beads.live.test.ts', 'renders'])).toEqual({
      mode: 'slow',
    });
    expect(selectTestRun('fast', ['src/beads/beads.live.test.ts', 'concurrent'])).toEqual({
      mode: 'slow',
    });
  });

  it('still refuses a genuine slow-file plus fast-file pair, naming both commands', () => {
    const result = selectTestRun('fast', [
      'src/beads/beads.live.test.ts',
      'src/util/stall.test.ts',
    ]);
    if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
    expect(result.error).toContain('pnpm --filter @overseer/daemon test');
    expect(result.error).toContain('pnpm --filter @overseer/daemon test:slow');
  });
});
