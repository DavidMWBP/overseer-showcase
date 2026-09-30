import { z } from 'zod';
import type { UsageGroup, UsageResponse } from '@overseer/shared';
import type { Db } from '../db/db';

/** The breakdown dimensions, in the order `GET /api/usage` returns them when `group` is omitted. */
export const USAGE_GROUPS: UsageGroup[] = ['model', 'account', 'harness', 'repo', 'batch'];
/** `from`/`to` are inclusive UTC calendar days. */
export const DEFAULT_USAGE_DAYS = 30;

const DAY_MS = 86_400_000;
const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const atMidnight = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

/** A real `YYYY-MM-DD` day: the regex alone accepts `2026-02-31`, and an out-of-range month or day (`2026-13-01`, `2026-09-00`) parses to NaN, which must be a validation error rather than a `RangeError` from the formatter. */
const isRealDay = (v: string): boolean => { const ms = atMidnight(v); return !Number.isNaN(ms) && toDay(ms) === v; };
const usageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine(isRealDay, 'not a real date');
const usageQuerySchema = z.object({
  from: usageDay.optional(),
  to: usageDay.optional(),
  // `group=model,repo` narrows which breakdowns are computed; omitted, all of them. An unknown name is a 400.
  group: z.string().optional().transform((v) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(z.enum(['model', 'account', 'harness', 'repo', 'batch'])).optional()),
});

/** The inclusive range a request covers; default: the last 30 days ending today. */
export function usageRange(from: string | undefined, to: string | undefined, today = toDay(Date.now())): { from: string; to: string } {
  const end = to ?? today;
  return { from: from ?? toDay(atMidnight(end) - (DEFAULT_USAGE_DAYS - 1) * DAY_MS), to: end };
}

/** Validate and normalise a `GET /api/usage` query into the report's arguments. */
export function usageQuery(query: unknown, today = toDay(Date.now())): { from: string; to: string; groups: UsageGroup[] } {
  const q = usageQuerySchema.parse(query ?? {});
  return { ...usageRange(q.from, q.to, today), groups: [...new Set(q.group ?? USAGE_GROUPS)] };
}

/** `to` is inclusive, so the SQL filter runs up to the midnight after it. */
export function usageReport(db: Db, q: { from: string; to: string; groups: UsageGroup[] }): UsageResponse {
  const toExclusive = toDay(atMidnight(q.to) + DAY_MS);
  const groups: UsageResponse['groups'] = {};
  for (const group of q.groups) groups[group] = db.usage.by(group, q.from, toExclusive);
  const days_by_model = q.groups.includes('model') ? db.usage.daysBy('model', q.from, toExclusive) : [];
  return { from: q.from, to: q.to, totals: db.usage.totals(q.from, toExclusive), days: db.usage.days(q.from, toExclusive), groups, days_by_model };
}
