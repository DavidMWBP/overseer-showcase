import type { Finding } from '@overseer/shared';

/**
 * Whether a findings round lands like a clean one: every finding is `should` (case-insensitive). A severity that cannot be
 * parsed counts as `must`, and a round that reports it could not read the change is not a findings-free round.
 */
export const landsWithFindings = (findings: Finding[]): boolean =>
  findings.length > 0 &&
  findings.every((f) => typeof f.severity === 'string' && f.severity.trim().toLowerCase() === 'should') &&
  !findings.some((f) => /\b(could not|couldn't|cannot|can't|unable to) (read|see|open|access) the (change|diff)/i.test(f.summary));
