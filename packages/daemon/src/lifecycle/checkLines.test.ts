import { describe, expect, it } from 'vitest';
import { parseCheckLines } from './checkLines';

describe('parseCheckLines', () => {
  it('accepts one or more PASS check lines', () => {
    expect(parseCheckLines([
      'Done.',
      'Check: pnpm test - PASS - Tests 12 passed (12)',
      'Check: pnpm typecheck - PASS - no errors',
    ].join('\n'))).toEqual({ pass: true, checkLines: [
      'Check: pnpm test - PASS - Tests 12 passed (12)',
      'Check: pnpm typecheck - PASS - no errors',
    ], nonPassLines: [] });
  });

  it.each(['-', '–', '—'])(`accepts PASS check lines with %s separators`, (dash) => {
    expect(parseCheckLines(`Check: pnpm test ${dash} PASS ${dash} Tests 12 passed (12)`)).toEqual({
      pass: true,
      checkLines: [`Check: pnpm test ${dash} PASS ${dash} Tests 12 passed (12)`],
      nonPassLines: [],
    });
  });

  it('accepts a PASS check line with mixed dash separators', () => {
    expect(parseCheckLines('Check: pnpm test – PASS — Tests 12 passed (12)')).toEqual({
      pass: true,
      checkLines: ['Check: pnpm test – PASS — Tests 12 passed (12)'],
      nonPassLines: [],
    });
  });

  it.each(['-', '–', '—'])(`rejects FAIL check lines with %s separators`, (dash) => {
    expect(parseCheckLines(`Check: pnpm test ${dash} FAIL ${dash} one error`)).toEqual({
      pass: false,
      checkLines: [`Check: pnpm test ${dash} FAIL ${dash} one error`],
      nonPassLines: [`Check: pnpm test ${dash} FAIL ${dash} one error`],
    });
  });

  it('rejects a FAIL line among PASS lines', () => {
    expect(parseCheckLines([
      'Check: pnpm test - PASS - Tests 12 passed (12)',
      'Check: pnpm typecheck - FAIL - one error',
    ].join('\n'))).toEqual({ pass: false, checkLines: [
      'Check: pnpm test - PASS - Tests 12 passed (12)',
      'Check: pnpm typecheck - FAIL - one error',
    ], nonPassLines: ['Check: pnpm typecheck - FAIL - one error'] });
  });

  it('rejects a NOT RUN result', () => {
    expect(parseCheckLines('Check: pnpm test - NOT RUN - service unavailable')).toEqual({
      pass: false,
      checkLines: ['Check: pnpm test - NOT RUN - service unavailable'],
      nonPassLines: ['Check: pnpm test - NOT RUN - service unavailable'],
    });
  });

  it('rejects a PASS result with no summary', () => {
    expect(parseCheckLines('Check: pnpm test - PASS -')).toEqual({
      pass: false,
      checkLines: ['Check: pnpm test - PASS -'],
      nonPassLines: ['Check: pnpm test - PASS -'],
    });
  });

  it('rejects a bare PASS word without separators', () => {
    expect(parseCheckLines('Check: foo PASS')).toEqual({
      pass: false,
      checkLines: ['Check: foo PASS'],
      nonPassLines: ['Check: foo PASS'],
    });
  });

  it('rejects a message with no Check line', () => {
    expect(parseCheckLines('All tests passed.')).toEqual({ pass: false, checkLines: [], nonPassLines: [] });
  });

  it('parses the Check prefix and PASS result case-insensitively', () => {
    expect(parseCheckLines('check: pnpm test - pass - Tests 12 passed (12)')).toEqual({
      pass: true,
      checkLines: ['check: pnpm test - pass - Tests 12 passed (12)'],
      nonPassLines: [],
    });
  });

  it('accepts a PASS check written as a markdown bullet', () => {
    expect(parseCheckLines('- Check: pnpm test - PASS - Tests 12 passed (12)')).toEqual({
      pass: true,
      checkLines: ['- Check: pnpm test - PASS - Tests 12 passed (12)'],
      nonPassLines: [],
    });
  });

  it.each(['-', '*', '>'])(`accepts a PASS check with a %s markdown prefix`, (prefix) => {
    const line = `${prefix} Check: pnpm test - PASS - Tests 12 passed (12)`;
    expect(parseCheckLines(line)).toEqual({ pass: true, checkLines: [line], nonPassLines: [] });
  });

  it('accepts a PASS check with a bold markdown label', () => {
    expect(parseCheckLines('**Check:** pnpm test - PASS - Tests 12 passed (12)')).toEqual({
      pass: true,
      checkLines: ['**Check:** pnpm test - PASS - Tests 12 passed (12)'],
      nonPassLines: [],
    });
  });

  it('rejects a status-line message', () => {
    expect(parseCheckLines("I'll wait for its reply\nrunning in the background")).toEqual({ pass: false, checkLines: [], nonPassLines: [] });
  });

  it('rejects an unparseable Check line', () => {
    expect(parseCheckLines('Check: still running')).toEqual({
      pass: false,
      checkLines: ['Check: still running'],
      nonPassLines: ['Check: still running'],
    });
  });
});
