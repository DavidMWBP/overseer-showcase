import type { UsageBreakdownRow, UsageDayBreakdownRow, UsageTotals } from '@overseer/shared';

/** The ranges the picker offers, in days ending today; 30 is the daemon's own default. */
export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = typeof RANGE_DAYS[number];

const DAY_MS = 86_400_000;
export const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The inclusive UTC range a picked button asks for: `days` calendar days ending today, the same arithmetic the daemon applies to its own default. */
export function rangeFor(days: RangeDays, today = toDay(Date.now())): { from: string; to: string } {
  return { from: toDay(Date.parse(`${today}T00:00:00.000Z`) - (days - 1) * DAY_MS), to: today };
}

/** Every token kind added together: the one number a summary card can carry. The kinds stay separate in the breakdown tooltips. */
export const tokenTotal = (t: UsageTotals): number =>
  t.tokens.input + t.tokens.output + t.tokens.cache_read + t.tokens.cache_write + t.tokens.reasoning;

/** Tokens are counted in millions here; the exact figure travels in the `title` the caller writes. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export type CostBasis = 'reported' | 'estimated';

/**
 * A money figure with the sessions that carried none named, never a bare `$0.00`: a bucket where every session is unpriced reads
 * "unknown", one where some are reads "≥ $x". Reported and estimated dollars are separate sums and are never added together.
 */
export function usageCost(t: UsageTotals, basis: CostBasis): { text: string; title?: string; floor: boolean } {
  const sum = basis === 'reported' ? t.reported_cost : t.estimated_cost;
  const unknown = basis === 'reported' ? t.reported_unknown : t.estimated_unknown;
  const what = basis === 'reported'
    ? 'reported no cost (a harness that reports none, such as codex, or a session that ended before its result)'
    : 'have no estimate (the model is not in the pricing catalog)';
  if (!unknown) return { text: `$${sum.toFixed(2)}`, floor: false };
  const title = `${unknown === 1 ? '1 session' : `${unknown} sessions`} of ${t.sessions} ${what}, so this is a floor.`;
  return { text: sum > 0 ? `≥ $${sum.toFixed(2)}` : 'unknown', title, floor: true };
}

/**
 * The caveat behind the `est.` label on a bucket that holds codex sessions. Codex's stream carries no per-request context size,
 * so its estimate is priced at the catalog's base context tier; claude and opencode read the real tier from their own responses
 * and must not carry this line.
 */
export const EST_TITLE = 'Estimated from this bucket’s tokens and the model’s catalog prices, not billed by the CLI.';
export const CODEX_EST_TITLE = `${EST_TITLE} Codex sessions are priced at the catalog’s base context tier, because the codex stream carries no per-request context size: a session whose requests crossed ~272k tokens is estimated up to 2x low.`;
export const estTitle = (t: UsageTotals): string => (t.codex_sessions > 0 ? CODEX_EST_TITLE : EST_TITLE);

/** The known limit the token counts carry, shown near the summary cards rather than only in the docs. */
export const RESTART_GAP_LIMIT = 'An opencode or codex turn that was in progress when the daemon restarted contributes no token counts, so totals can read slightly low.';

export type SortKey = 'key' | 'reported' | 'estimated' | 'tokens' | 'sessions';

const sortValue = (r: UsageBreakdownRow, key: SortKey): number | string => {
  switch (key) {
    case 'key': return (r.label ?? r.key ?? '').toLowerCase();
    case 'reported': return r.reported_cost;
    case 'estimated': return r.estimated_cost;
    case 'tokens': return tokenTotal(r);
    case 'sessions': return r.sessions;
  }
};

/** Sorts a breakdown without mutating it; `desc` reads highest-first for a number and Z→A for a name. */
export function sortRows(rows: UsageBreakdownRow[], key: SortKey, desc: boolean): UsageBreakdownRow[] {
  return [...rows].sort((a, b) => {
    const [x, y] = [sortValue(a, key), sortValue(b, key)];
    const cmp = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y);
    return desc ? -cmp : cmp;
  });
}

/** The measure the chart draws: one of the two cost sums, or tokens. */
export type Measure = CostBasis | 'tokens';
export const measureOf = (t: UsageTotals, m: Measure): number =>
  m === 'tokens' ? tokenTotal(t) : m === 'reported' ? t.reported_cost : t.estimated_cost;

/** The number of models drawn as their own colour; the rest fold into one "Other" band, never a generated hue. */
export const SERIES_MAX = 5;
export const OTHER = 'Other';

export interface StackDay { day: string; total: number; segments: { key: string; value: number; codex: boolean }[] }
export interface Stacks { series: string[]; days: StackDay[]; max: number }

/**
 * The stacked bars: one bar per calendar day in range (a day with no sessions keeps its empty slot, so the axis stays a calendar),
 * each split by model, largest models first and everything past `SERIES_MAX` folded into "Other".
 */
export function stackDays(rows: UsageDayBreakdownRow[], range: { from: string; to: string }, measure: Measure): Stacks {
  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(r.key ?? 'unknown model', (byModel.get(r.key ?? 'unknown model') ?? 0) + measureOf(r, measure));
  const ranked = [...byModel.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const named = ranked.slice(0, SERIES_MAX);
  const series = ranked.length > named.length ? [...named, OTHER] : named;
  const nameOf = (key: string | null) => { const k = key ?? 'unknown model'; return named.includes(k) ? k : OTHER; };

  const days: StackDay[] = [];
  for (let ms = Date.parse(`${range.from}T00:00:00.000Z`); ms <= Date.parse(`${range.to}T00:00:00.000Z`); ms += DAY_MS) {
    days.push({ day: toDay(ms), total: 0, segments: [] });
  }
  const index = new Map(days.map((d) => [d.day, d]));
  for (const r of rows) {
    const day = index.get(r.day);
    const value = measureOf(r, measure);
    if (!day || value <= 0) continue;
    const name = nameOf(r.key);
    const seen = day.segments.find((s) => s.key === name);
    if (seen) { seen.value += value; seen.codex ||= r.codex_sessions > 0; } else day.segments.push({ key: name, value, codex: r.codex_sessions > 0 });
    day.total += value;
  }
  for (const d of days) d.segments.sort((a, b) => series.indexOf(a.key) - series.indexOf(b.key));
  return { series, days, max: Math.max(0, ...days.map((d) => d.total)) };
}
