import type { ReviewCheckCounts } from '@overseer/shared';

const emptyCounts = (): ReviewCheckCounts => ({ passed: 0, failed: 0, skipped: 0, todo: 0, flaky: 0 });

/** Parse the final test totals emitted by Vitest or Playwright; unrelated output has no count summary. */
export function parseReviewCounts(output: string): ReviewCheckCounts | null {
  const vitest = output.split(/\r?\n/).find((line) => /^\s*Tests\s+/.test(line));
  if (vitest) {
    const counts = emptyCounts();
    let found = false;
    for (const match of vitest.matchAll(/(\d+)\s+(passed|failed|skipped|todo)\b/g)) {
      counts[match[2] as 'passed' | 'failed' | 'skipped' | 'todo'] = Number(match[1]);
      found = true;
    }
    if (found) return counts;
  }

  const counts = emptyCounts();
  let found = false;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(passed|failed|skipped|todo|flaky)(?:\s+\([^)]*\))?\s*$/.exec(line);
    if (!match) continue;
    counts[match[2] as keyof ReviewCheckCounts] = Number(match[1]);
    found = true;
  }
  return found ? counts : null;
}
