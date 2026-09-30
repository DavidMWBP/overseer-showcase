import type { TierSettings, TierName, TierCandidate, HarnessName, Repo } from '@overseer/shared';
import type { PriceSource } from '../pricing/catalog';

export class TierError extends Error {}

const ORDER: TierName[] = ['chore', 'standard', 'hard'];

/**
 * The standard tier's candidate for one harness, or undefined when the tier has none for it. A discussion participant
 * runs on the standard tier's model for its own harness and is refused when there is none, rather than being moved to
 * another harness; a candidate whose model is denied counts as absent, exactly as `resolveTier` reads the deny list.
 */
export function standardCandidate(settings: TierSettings, harness: HarnessName): TierCandidate | undefined {
  const deny = new Set(settings.denyModels);
  return settings.tiers.find((t) => t.name === 'standard')?.candidates.find((c) => c.harness === harness && !deny.has(c.model));
}

/**
 * The harnesses whose shell tool cannot leave a long-running process alive, with the reason to report: a dispatch that
 * needs a server, a daemon or a browser is refused on them. One edit adds or clears a harness here.
 * opencode 1.18.19: a backgrounded start is reaped with the tool call's host, and a detached one blocks the tool for good
 * (measured in docs/server-start-in-a-worker-shell.md).
 */
export const NO_SERVER_HARNESSES = new Map<TierCandidate['harness'], string>([
  ['opencode', 'opencode cannot keep a server, daemon or browser running: its shell tool reaps a backgrounded process and blocks for good on a detached one (docs/server-start-in-a-worker-shell.md)'],
]);

/** `available`: whether a harness CLI is installed; a candidate on a missing one is skipped (the seeded tiers list codex first, and codex is optional). */
export interface ResolveOpts { previousModels: string[]; excludeModel?: string; /** Pins the resolved candidate to this exact model (a crash retry pinned to the crashed session's model); still subject to deny/availability/usage checks below. */ model?: string; stepUp?: boolean; available?: (harness: TierCandidate['harness']) => boolean; unusableCandidates?: Map<string, string>; /** Whole harnesses this dispatch must not pick (the latest worker session there hung or failed to start, or the task needs a server and the harness cannot hold one), each with the reason to report. */ unusableHarnesses?: Map<TierCandidate['harness'], string>; /** The loaded price catalog: a first chore or standard dispatch takes the usable candidate with the lowest input price. Absent means configured order. */ prices?: PriceSource; /** A forced harness: only this tier's candidates of that harness count, in configured order (never price-sorted), with no step-up and no fall-through, and a refusal names the harness and the tier. */ harness?: HarnessName }

/** Tiers whose first dispatch is price-sorted; hard and the review tiers keep configured order, so important work gets the stronger model. */
const PRICE_SORTED = new Set<TierName>(['chore', 'standard']);

export const candidateUsageKey = (c: TierCandidate) => `${c.account ?? c.harness}\u0000${c.model}`;

/** Keep only candidates permitted by a repository, without changing the global settings or candidate order. */
export function filterRepoTiers(settings: TierSettings, filter: Repo['model_filter']): TierSettings {
  if (!filter) return settings;
  return { ...settings, tiers: settings.tiers.map((tier) => ({
    ...tier,
    candidates: tier.candidates.filter((c) =>
      (!filter.harnesses.length || filter.harnesses.includes(c.harness))
      && (!filter.models.length || filter.models.includes(c.model))
      && (!filter.accounts.length || (c.account != null && filter.accounts.includes(c.account))),
    ),
  })) };
}

export function resolveTier(settings: TierSettings, tier: TierName, opts: ResolveOpts): TierCandidate {
  const deny = new Set(settings.denyModels);
  const byName = (n: TierName) => settings.tiers.find((t) => t.name === n)?.candidates ?? [];
  let start = tier;
  if (opts.stepUp && tier !== 'critic' && !opts.harness) { const i = ORDER.indexOf(tier); if (i >= 0 && i < ORDER.length - 1) start = ORDER[i + 1]!; }

  // Candidate lists to try in order: the chosen tier, then (for a review tier) the critic chain, so an unconfigured or
  // fully unusable cheaper critic falls back to the normal one instead of failing the round.
  const criticChain: TierName[] = ['critic', 'hard', 'standard', 'chore'];
  const chain: TierName[] = opts.harness ? [start] : start === 'critic' ? criticChain : start === 'critic-chore' ? [start, ...criticChain] : [start];
  const ok = (c: TierCandidate) => (!opts.harness || c.harness === opts.harness) && !deny.has(c.model) && c.model !== opts.excludeModel && (!opts.model || c.model === opts.model) && (opts.available?.(c.harness) ?? true) && !opts.unusableCandidates?.has(candidateUsageKey(c)) && !opts.unusableHarnesses?.has(c.harness);

  for (const name of chain) {
    const cands = byName(name).filter(ok);
    if (cands.length === 0) continue;
    // A forced harness keeps its candidates in configured order: the user ordered them, and the harness was chosen for the work, not for price.
    if (opts.prices && !opts.harness && opts.previousModels.length === 0 && PRICE_SORTED.has(name)) {
      // Cheapest input price first; an unpriced model sorts after every priced one. The sort is stable, so ties keep configured order.
      const price = (c: TierCandidate) => opts.prices!.priceFor(c.harness, c.model)?.input ?? Infinity;
      return [...cands].sort((a, b) => price(a) - price(b))[0]!;
    }
    const fresh = cands.find((c) => !opts.previousModels.includes(c.model));
    return fresh ?? cands[0]!;
  }
  if (opts.harness) {
    // A forced harness is never moved to another harness or tier: the refusal names both, with whatever made each candidate unusable.
    const own = byName(start).filter((c) => c.harness === opts.harness);
    const reasons = [...new Set([...own.map((c) => opts.unusableCandidates?.get(candidateUsageKey(c))), own.length ? opts.unusableHarnesses?.get(opts.harness) : undefined].filter((reason): reason is string => !!reason))];
    throw new TierError(`no usable ${opts.harness} candidate in tier ${tier}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
  }
  const usageReasons = [...new Set(chain.flatMap(byName).map(candidateUsageKey).map((key) => opts.unusableCandidates?.get(key)).filter((reason): reason is string => !!reason))];
  if (usageReasons.length) throw new TierError(`no usable account for tier ${tier}: ${usageReasons.join('; ')}`);
  const harnessReasons = [...new Set(chain.flatMap(byName).map((c) => c.harness).map((h) => opts.unusableHarnesses?.get(h)).filter((reason): reason is string => !!reason))];
  if (harnessReasons.length) throw new TierError(`no usable harness for tier ${tier}: ${harnessReasons.join('; ')}`);
  throw new TierError(`no model available for tier ${tier}${opts.excludeModel ? ` excluding ${opts.excludeModel}` : ''}: every candidate is denied or its CLI is not installed (Setup → Models)`);
}
