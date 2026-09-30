import type { TierName } from '@overseer/shared';

/** A standard bead whose diff against its base is larger than this (insertions plus deletions) gets a second review round. */
export const BIG_DIFF_LINES = 400;

export interface ReviewPlanInput {
  /** The tier the bead was dispatched with; null (a forced harness without a tier) counts as standard. */
  tier: TierName | null;
  mustInRound1: boolean;
  diffLines: number;
  /** `repo.review_rounds`: the most rounds any bead gets; 0 means no review. */
  cap: number;
}

/** How many review rounds a bead gets: chore one, standard one (two after a round-1 must or a large diff), hard the cap. */
export function reviewRoundLimit({ tier, mustInRound1, diffLines, cap }: ReviewPlanInput): number {
  if (tier === 'chore') return Math.min(cap, 1);
  if (tier === 'hard') return cap;
  return Math.min(cap, mustInRound1 || diffLines > BIG_DIFF_LINES ? 2 : 1);
}

/** The critic tier for a round: `critic-chore` (when configured) for a chore bead and a standard bead's first round, else `critic`. */
export function reviewTierFor(tier: TierName | null, round: number, criticChoreConfigured: boolean): TierName {
  const cheap = tier === 'chore' || (tier !== 'hard' && round === 1);
  return cheap && criticChoreConfigured ? 'critic-chore' : 'critic';
}

/** A standard bead over the diff threshold is reviewed a second time even when its first round found no `[must]`. */
export function reviewsAgain({ tier, round, diffLines, cap }: { tier: TierName | null; round: number; diffLines: number; cap: number }): boolean {
  return tier !== 'chore' && tier !== 'hard' && round === 1 && diffLines > BIG_DIFF_LINES && cap >= 2;
}
