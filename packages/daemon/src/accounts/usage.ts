import type { AccountUsage, UsageBucket } from '@overseer/shared';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { installedClaudeCodeVersion, type VersionRunner } from '../doctor/doctor';
import { refreshClaudeOAuth } from './login';
import { AUTH_HOLD_UNTIL } from './status';
import { runCapture } from '../util/procs';
import { log } from '../util/log';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 180_000;
const FALLBACK_CLAUDE_VERSION = '0.0.0';

type CacheEntry = { at: number; value?: AccountUsage; lastGood?: AccountUsage; flight?: Promise<AccountUsage> };
const cache = new Map<string, CacheEntry>();
const loggedUsageFailures = new Set<string>();

const bucket = (value: unknown): UsageBucket | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.percent !== 'number') return null;
  return { percent: record.percent, resetsAt: typeof record.resets_at === 'string' ? record.resets_at : null };
};

const fallbackBucket = (value: unknown): UsageBucket | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.utilization !== 'number') return null;
  return { percent: record.utilization, resetsAt: typeof record.resets_at === 'string' ? record.resets_at : null };
};

function fromLimits(limits: unknown[]): Pick<AccountUsage, 'session' | 'weekly' | 'models'> {
  let session: UsageBucket | null = null;
  let weekly: UsageBucket | null = null;
  const models: AccountUsage['models'] = [];
  for (const value of limits) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const parsed = bucket(record);
    if (!parsed) continue;
    const scope = record.scope;
    const model = scope && typeof scope === 'object' ? (scope as Record<string, unknown>).model : undefined;
    if (typeof model === 'string') {
      models.push({ ...parsed, model });
      continue;
    }
    const name = typeof scope === 'string' ? scope : scope && typeof scope === 'object'
      ? ['type', 'name', 'bucket'].map((key) => (scope as Record<string, unknown>)[key]).find((v): v is string => typeof v === 'string')
      : undefined;
    if (name === 'five_hour') session = parsed;
    if (name === 'seven_day') weekly = parsed;
  }
  return { session, weekly, models };
}

function normalize(body: unknown, fetchedAt: string): AccountUsage {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (Array.isArray(record.limits)) {
    const limits = fromLimits(record.limits);
    return { fetchedAt, session: limits.session ?? fallbackBucket(record.five_hour), weekly: limits.weekly ?? fallbackBucket(record.seven_day), models: limits.models };
  }
  return { fetchedAt, session: fallbackBucket(record.five_hour), weekly: fallbackBucket(record.seven_day), models: [] };
}

/** Fetches a stored Claude OAuth account's usage, at most once per account every three minutes. */
export async function fetchAccountUsage(db: Db, config: Config, accountId: string, versionRunner: VersionRunner = runCapture): Promise<AccountUsage | null> {
  const account = db.accounts.get(accountId);
  if (!account || account.harness !== 'claude' || account.kind !== 'oauth_token') return null;
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.flight ?? hit.value!;
  const fetchedAt = new Date().toISOString();
  const previous = hit?.lastGood;
  const flight = (async (): Promise<AccountUsage> => {
    try {
      const fresh = await refreshClaudeOAuth(db, config, account);
      if (!fresh.secret) throw new Error('account has no access token');
      const version = await installedClaudeCodeVersion(config, versionRunner) ?? FALLBACK_CLAUDE_VERSION;
      const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${fresh.secret}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `claude-code/${version}` }, signal: AbortSignal.timeout(config.anthropicTokenTimeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return normalize(await response.json(), fetchedAt);
    } catch (err) {
      return previous ? { ...previous, error: (err as Error).message } : { fetchedAt, session: null, weekly: null, models: [], error: (err as Error).message };
    }
  })();
  cache.set(accountId, { at: Date.now(), lastGood: previous, flight });
  void flight.then((value) => {
    if (cache.get(accountId)?.flight !== flight) return;
    cache.set(accountId, { at: Date.now(), value, lastGood: value.error ? previous : value });
  });
  return flight;
}

export function clearAccountUsageCache(): void { cache.clear(); loggedUsageFailures.clear(); }

export function clearAccountUsageCacheForAccount(accountId: string): void {
  cache.delete(accountId);
  for (const key of loggedUsageFailures) if (key.startsWith(`${accountId}:`)) loggedUsageFailures.delete(key);
}

export async function accountUsable(db: Db, config: Config, accountId: string, model: string, doctorRunner: VersionRunner = runCapture, threshold = config.usageThresholdPercent, sessionIdToExclude?: string): Promise<{ usable: true } | { usable: false; reason: string }> {
  const account = db.accounts.get(accountId);
  const name = account?.name ?? accountId;
  if (account?.exhausted_until && account.exhausted_until > Date.now()) {
    return account.exhausted_until === AUTH_HOLD_UNTIL
      ? { usable: false, reason: `account ${name}: authentication failed; log in again` }
      : { usable: false, reason: `account ${name}: exhausted until ${new Date(account.exhausted_until).toISOString()}` };
  }
  const usage = await fetchAccountUsage(db, config, accountId, doctorRunner);
  if (!usage) return { usable: true };
  if (usage.error && !usage.session && !usage.weekly && usage.models.length === 0) {
    const key = `${accountId}:${usage.error}`;
    if (!loggedUsageFailures.has(key)) { loggedUsageFailures.add(key); log.warn(`accounts: usage unavailable for ${accountId}; allowing dispatch`, new Error(usage.error)); }
    return { usable: true };
  }
  const runningSessions = db.sessions.running().filter((session) => session.account === accountId && session.id !== sessionIdToExclude).length;
  const unboundedThreshold = threshold - runningSessions * config.usageReservePerSessionPercent;
  const floor = threshold / 2;
  const effectiveThreshold = Math.max(floor, unboundedThreshold);
  const percentText = (percent: number) => String(Number(percent.toFixed(2)));
  const formula = `${percentText(threshold)}% - ${runningSessions} running x ${percentText(config.usageReservePerSessionPercent)}%${effectiveThreshold > unboundedThreshold ? `, floored at ${percentText(floor)}%` : ''}`;
  const blocked = (bucket: string, percent: number) => ({ usable: false as const, reason: `account ${name}: ${bucket} ${percent}% >= ${percentText(effectiveThreshold)}% (${formula})` });
  if (usage.session && usage.session.percent >= effectiveThreshold) return blocked('session', usage.session.percent);
  if (usage.weekly && usage.weekly.percent >= effectiveThreshold) return blocked('weekly', usage.weekly.percent);
  const exact = usage.models.find((entry) => entry.model === model);
  const family = exact ?? usage.models.find((entry) => model.startsWith(`${entry.model}-`) || entry.model.startsWith(`${model}-`));
  if (family && family.percent >= effectiveThreshold) return blocked(`model ${family.model}`, family.percent);
  return { usable: true };
}
