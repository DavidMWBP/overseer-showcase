import { describe, it, expect } from 'vitest';
import { mergeMessage, mergeScope, messageArgs, wrapLine, HEADER_MAX, BODY_MAX } from './message';

describe('mergeMessage', () => {
  it('builds a Conventional Commits header with the title and source branch in the body', () => {
    const m = mergeMessage({ target: 'feature/9310-admin-summary-chart', id: 'acme-portal-case-01', title: '#9310 (2/5) Update AdminSummaryChart: flat fill, readable axis labels, sample defaults', source: 'bead/acme-portal-case-01' });
    expect(m).toBe('chore(9310-admin-summary-chart): merge acme-portal-case-01\n\n#9310 (2/5) Update AdminSummaryChart: flat fill, readable axis labels, sample defaults\nSource: bead/acme-portal-case-01');
  });

  it('sanitises the scope to [a-z0-9-]', () => {
    expect(mergeScope('feature/Trend Chart_v2 (WIP)!')).toBe('trend-chart-v2-wip');
    expect(mergeScope('bead/ov-1')).toBe('ov-1');
    expect(mergeScope('main')).toBe('main');
    expect(mergeScope('feature/---')).toBe('merge');
  });

  it('wraps body lines at 100 characters, the commitlint default the hook enforced on a refresh line', () => {
    const title = 'Refresh feature/9317-update-record-save-feedback from the development branch after batch acme-portal-sample-028 merged';
    expect(title.length).toBeGreaterThan(BODY_MAX);
    const m = mergeMessage({ target: 'feature/9317-update-record-save-feedback', id: 'dev', title, source: 'dev', description: 'a '.repeat(80) + 'https://example.invalid/' + 'x'.repeat(120) });
    for (const line of m.split('\n').slice(2)) expect(line.length <= BODY_MAX || !line.includes(' ')).toBe(true); // a lone over-long word (a URL) stays whole
    expect(m.split('\n').slice(2, 4).join(' ')).toBe(title);
    expect(wrapLine('one two', 3)).toEqual(['one', 'two']);
  });
  it('caps the header at 72 characters by truncating the scope, never the id', () => {
    const m = mergeMessage({ target: `feature/${'a'.repeat(120)}`, id: 'ov-123', title: 't', source: 'bead/ov-123' });
    const header = m.split('\n')[0]!;
    expect(header.length).toBeLessThanOrEqual(HEADER_MAX);
    expect(header).toMatch(/^chore\(a+\): merge ov-123$/);
  });

  it('appends the description after a blank line and passes each paragraph as its own -m', () => {
    const m = mergeMessage({ target: 'feature/x', id: 'r1-b1', title: 'Batch title', source: 'feature/x', description: 'Review note\nsecond line' });
    expect(m).toBe('chore(x): merge r1-b1\n\nBatch title\nSource: feature/x\n\nReview note\nsecond line');
    expect(messageArgs(m)).toEqual(['-m', 'chore(x): merge r1-b1', '-m', 'Batch title\nSource: feature/x', '-m', 'Review note\nsecond line']);
  });
});
