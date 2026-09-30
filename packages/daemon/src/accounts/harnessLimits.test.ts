import { describe, it, expect } from 'vitest';
import { openDb } from '../db/db';
import { harnessLimitReason, setHarnessLimit } from './harnessLimits';

describe('harness limits', () => {
  it('names the reset time until it passes, per harness', () => {
    const db = openDb(':memory:');
    const until = Date.parse('2026-09-20T10:18:00.000Z');
    setHarnessLimit(db, 'codex', until);
    expect(harnessLimitReason(db, 'codex', until - 1)).toBe('codex: usage limit until 2026-09-20T10:18:00.000Z');
    expect(harnessLimitReason(db, 'codex', until)).toBeNull();
    expect(harnessLimitReason(db, 'opencode', until - 1)).toBeNull();
  });
});
