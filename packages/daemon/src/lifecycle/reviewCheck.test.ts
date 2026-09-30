import { describe, expect, it } from 'vitest';
import { parseReviewCounts } from './reviewCheck';

describe('parseReviewCounts', () => {
  it('parses Vitest test totals', () => {
    expect(parseReviewCounts('Test Files  668 passed (668)\nTests  16940 passed | 21 skipped | 5 todo (16966)'))
      .toEqual({ passed: 16940, failed: 0, skipped: 21, todo: 5, flaky: 0 });
  });

  it('parses a passing Playwright summary', () => {
    expect(parseReviewCounts('Running 4 tests using 4 workers\n  4 passed (18.8s)'))
      .toEqual({ passed: 4, failed: 0, skipped: 0, todo: 0, flaky: 0 });
  });

  it('parses Playwright failures and flaky tests', () => {
    expect(parseReviewCounts('  14 failed\n  3 flaky'))
      .toEqual({ passed: 0, failed: 14, skipped: 0, todo: 0, flaky: 3 });
  });

  it('leaves counts absent for unknown output', () => {
    expect(parseReviewCounts('done, no test summary was printed')).toBeNull();
  });

  it('preserves zero totals', () => {
    expect(parseReviewCounts('Tests 0 passed | 0 skipped | 0 todo (0)'))
      .toEqual({ passed: 0, failed: 0, skipped: 0, todo: 0, flaky: 0 });
  });
});
