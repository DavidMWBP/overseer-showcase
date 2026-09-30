// Chooses which vitest mode a focused daemon test run needs, so a caller does not have to know
// whether a file lives in slowTestFiles or the fast default. `scripts/test.mts` is the thin CLI over
// this; keeping the decision here lets a test cover it without spawning vitest.
import { slowTestFiles } from '../../vitest.config';

const slowSet = new Set(slowTestFiles);

export function isSlowFile(arg: string): boolean {
  const normalized = arg.replace(/\\/g, '/');
  return [...slowSet].some(
    (f) => normalized === f || normalized.endsWith('/' + f) || f.endsWith('/' + normalized)
  );
}

// A positional that ends in `.test.ts` and is not in slowTestFiles names a fast test file. Anything
// else (a bare substring such as `lifecycle`, or a directory) is a vitest filter, not a named file.
function namesFastFile(arg: string): boolean {
  return !isSlowFile(arg) && arg.replace(/\\/g, '/').endsWith('.test.ts');
}

export type TestRun = { mode: 'fast' | 'slow' } | { error: string };

export function splitRunMessage(slowFiles: string[], fastFiles: string[]): string {
  const clause = (files: string[], fallback: string) =>
    files.length > 0 ? `${files.join(', ')} ${files.length > 1 ? 'run' : 'runs'}` : `${fallback} run`;
  return (
    `${clause(slowFiles, 'the slow files')} under "pnpm --filter @overseer/daemon test:slow", ` +
    `while ${clause(fastFiles, 'the fast files')} under "pnpm --filter @overseer/daemon test". ` +
    `Run them separately.`
  );
}

export function selectTestRun(requestedMode: string, positional: string[]): TestRun {
  const slowArgs = positional.filter(isSlowFile);
  const fastArgs = positional.filter(namesFastFile);

  // One vitest invocation cannot include files from both lists, so name the two commands instead.
  if (slowArgs.length > 0 && fastArgs.length > 0) {
    return { error: splitRunMessage(slowArgs, fastArgs) };
  }

  if (requestedMode === 'slow') {
    // The heuristic may only upgrade a fast request to slow. An explicit slow run stays slow for a
    // filter, and fails only when every positional names a file that lives in the fast list.
    if (positional.length > 0 && positional.every(namesFastFile)) {
      return { error: splitRunMessage([], positional) };
    }
    return { mode: 'slow' };
  }

  return { mode: slowArgs.length > 0 ? 'slow' : 'fast' };
}
