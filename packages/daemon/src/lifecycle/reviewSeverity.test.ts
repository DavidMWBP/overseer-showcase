import { describe, expect, it } from 'vitest';
import { landsWithFindings } from './reviewSeverity';

describe('landsWithFindings', () => {
  it('lands a round whose findings are all should, in any case', () => {
    expect(landsWithFindings([{ file: 'a.ts', summary: 'x', severity: 'should' }, { file: null, summary: 'y', severity: 'SHOULD' as never }])).toBe(true);
  });

  it('keeps a round with a must finding, in any case', () => {
    expect(landsWithFindings([{ file: null, summary: 'y', severity: 'should' }, { file: 'a.ts', summary: 'x', severity: 'Must' as never }])).toBe(false);
  });

  it('treats a severity it cannot parse as must', () => {
    expect(landsWithFindings([{ file: 'a.ts', summary: 'x', severity: 'maybe' as never }])).toBe(false);
    expect(landsWithFindings([{ file: 'a.ts', summary: 'x', severity: undefined as never }])).toBe(false);
  });

  it('does not land a round with no findings at all', () => {
    expect(landsWithFindings([])).toBe(false);
  });

  it('does not land a round that reports it could not read the change', () => {
    expect(landsWithFindings([{ file: null, summary: 'I could not read the change: the diff was omitted.', severity: 'should' }])).toBe(false);
  });
});
