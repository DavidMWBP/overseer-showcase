import type { HarnessName } from '@overseer/shared';
import type { Db } from '../db/db';

/** Usage-limit holds for harnesses that run on the CLI's own login (no account row): one `harness_limits` setting, harness → epoch ms. */
const KEY = 'harness_limits';

export function setHarnessLimit(db: Db, harness: HarnessName, until: number): void {
  db.settings.set(KEY, { ...(db.settings.get(KEY) ?? {}), [harness]: until });
}

export function harnessLimitReason(db: Db, harness: HarnessName, now = Date.now()): string | null {
  const until = (db.settings.get(KEY) as Record<string, number> | undefined)?.[harness];
  return until && until > now ? `${harness}: usage limit until ${new Date(until).toISOString()}` : null;
}
