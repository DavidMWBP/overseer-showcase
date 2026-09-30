import { describe, it, expect } from 'vitest';
import type { UsageBreakdownRow, UsageDayBreakdownRow, UsageTotals } from '@overseer/shared';
import { CODEX_EST_TITLE, EST_TITLE, estTitle, fmtTokens, rangeFor, sortRows, stackDays, tokenTotal, usageCost } from './usage';

const totals = (o: Partial<UsageTotals> = {}): UsageTotals => ({
  sessions: 1, reported_cost: 0, reported_unknown: 0, estimated_cost: 0, estimated_unknown: 0, codex_sessions: 0,
  tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 },
  ...o,
});
const row = (key: string, o: Partial<UsageBreakdownRow> = {}): UsageBreakdownRow => ({ key, label: null, ...totals(), ...o });
const dayRow = (day: string, key: string, o: Partial<UsageDayBreakdownRow> = {}): UsageDayBreakdownRow => ({ day, ...row(key), ...o });

describe('usage helpers', () => {
  it('asks for the picked number of calendar days ending today, inclusive of both ends', () => {
    expect(rangeFor(7, '2026-09-17')).toEqual({ from: '2026-09-11', to: '2026-09-17' });
    expect(rangeFor(30, '2026-09-17')).toEqual({ from: '2026-08-19', to: '2026-09-17' });
    expect(rangeFor(90, '2026-09-17')).toEqual({ from: '2026-06-20', to: '2026-09-17' });
  });

  it('never adds the two cost sums together and shows an unpriced bucket as unknown rather than $0.00', () => {
    const t = totals({ sessions: 3, reported_cost: 1.5, reported_unknown: 1, estimated_cost: 2.25, estimated_unknown: 0 });
    expect(usageCost(t, 'reported')).toMatchObject({ text: '≥ $1.50', floor: true });
    expect(usageCost(t, 'reported').title).toContain('1 session of 3');
    expect(usageCost(t, 'estimated')).toEqual({ text: '$2.25', floor: false });
    // A bucket where every session is unpriced: a floor of $0.00 would read as a free run.
    const none = totals({ sessions: 2, reported_cost: 0, reported_unknown: 2 });
    expect(usageCost(none, 'reported').text).toBe('unknown');
    expect(usageCost(none, 'reported').title).toContain('2 sessions of 2');
  });

  it('puts the base-context-tier caveat on a bucket with codex sessions and on no other', () => {
    expect(estTitle(totals({ codex_sessions: 1 }))).toBe(CODEX_EST_TITLE);
    expect(CODEX_EST_TITLE).toContain('272k');
    expect(estTitle(totals({ codex_sessions: 0 }))).toBe(EST_TITLE);
    expect(EST_TITLE).not.toContain('272k');
  });

  it('counts every token kind once and abbreviates the total', () => {
    expect(tokenTotal(totals({ tokens: { input: 10, output: 5, cache_read: 3, cache_write: 2, cache_write_1h: 1, reasoning: 4 } }))).toBe(24);
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(12_400)).toBe('12k');
    expect(fmtTokens(2_450_000)).toBe('2.5M');
  });

  it('sorts a breakdown by the column asked for, in both directions', () => {
    const rows = [row('b', { reported_cost: 1, sessions: 5 }), row('a', { reported_cost: 3, sessions: 1 })];
    expect(sortRows(rows, 'reported', true).map((r) => r.key)).toEqual(['a', 'b']);
    expect(sortRows(rows, 'reported', false).map((r) => r.key)).toEqual(['b', 'a']);
    expect(sortRows(rows, 'sessions', true).map((r) => r.key)).toEqual(['b', 'a']);
    expect(sortRows(rows, 'key', false).map((r) => r.key)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.key)).toEqual(['b', 'a']); // the input is left alone
  });

  it('stacks every day in range by model, keeps empty days and folds a seventh model into Other', () => {
    const rows = [
      ...['m1', 'm2', 'm3', 'm4', 'm5'].map((m, i) => dayRow('2026-09-02', m, { reported_cost: 10 - i })),
      dayRow('2026-09-02', 'm6', { reported_cost: 1 }),
      dayRow('2026-09-02', 'm7', { reported_cost: 1 }),
      dayRow('2026-09-03', 'm1', { reported_cost: 4 }),
    ];
    const s = stackDays(rows, { from: '2026-09-01', to: '2026-09-03' }, 'reported');
    expect(s.series).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'Other']);
    expect(s.days.map((d) => d.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(s.days[0]!.segments).toEqual([]); // a day with no sessions keeps its slot
    expect(s.days[1]!.segments.map((x) => [x.key, x.value])).toEqual([['m1', 10], ['m2', 9], ['m3', 8], ['m4', 7], ['m5', 6], ['Other', 2]]);
    expect(s.max).toBe(42);
  });

  it('stacks tokens and the estimate from the same rows when the chart is switched', () => {
    const rows = [dayRow('2026-09-02', 'm1', { reported_cost: 0, estimated_cost: 3, tokens: { input: 100, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } })];
    expect(stackDays(rows, { from: '2026-09-02', to: '2026-09-02' }, 'reported').max).toBe(0);
    expect(stackDays(rows, { from: '2026-09-02', to: '2026-09-02' }, 'estimated').max).toBe(3);
    expect(stackDays(rows, { from: '2026-09-02', to: '2026-09-02' }, 'tokens').max).toBe(100);
  });
});
