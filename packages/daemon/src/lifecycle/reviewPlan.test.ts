import { describe, expect, it } from 'vitest';
import { BIG_DIFF_LINES, reviewRoundLimit, reviewsAgain, reviewTierFor } from './reviewPlan';

const base = { mustInRound1: false, diffLines: 10, cap: 2 };

describe('reviewRoundLimit', () => {
  it('gives a chore bead one round, within the cap', () => {
    expect(reviewRoundLimit({ ...base, tier: 'chore', cap: 5, mustInRound1: true, diffLines: 5000 })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: 'chore', cap: 1 })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: 'chore', cap: 0 })).toBe(0);
  });

  it('gives a standard bead one round unless round 1 found a must or the diff is large', () => {
    expect(reviewRoundLimit({ ...base, tier: 'standard' })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: 'standard', mustInRound1: true })).toBe(2);
    expect(reviewRoundLimit({ ...base, tier: 'standard', diffLines: BIG_DIFF_LINES })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: 'standard', diffLines: BIG_DIFF_LINES + 1 })).toBe(2);
    expect(reviewRoundLimit({ ...base, tier: 'standard', cap: 5, mustInRound1: true, diffLines: 5000 })).toBe(2);
  });

  it('caps a standard bead at 1 and at 0', () => {
    expect(reviewRoundLimit({ ...base, tier: 'standard', cap: 1, mustInRound1: true, diffLines: 5000 })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: 'standard', cap: 0, mustInRound1: true })).toBe(0);
  });

  it('counts a forced dispatch without a tier as standard', () => {
    expect(reviewRoundLimit({ ...base, tier: null })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: null, diffLines: BIG_DIFF_LINES + 1 })).toBe(2);
  });

  it('gives a hard bead the repo cap', () => {
    expect(reviewRoundLimit({ ...base, tier: 'hard', cap: 4 })).toBe(4);
    expect(reviewRoundLimit({ ...base, tier: 'hard', cap: 1 })).toBe(1);
    expect(reviewRoundLimit({ ...base, tier: 'hard', cap: 0 })).toBe(0);
  });
});

describe('reviewTierFor', () => {
  it('reviews a chore bead on critic-chore when configured, else critic', () => {
    expect(reviewTierFor('chore', 1, true)).toBe('critic-chore');
    expect(reviewTierFor('chore', 1, false)).toBe('critic');
  });

  it('reviews a standard bead round 1 on critic-chore and round 2 on critic', () => {
    expect(reviewTierFor('standard', 1, true)).toBe('critic-chore');
    expect(reviewTierFor('standard', 1, false)).toBe('critic');
    expect(reviewTierFor('standard', 2, true)).toBe('critic');
    expect(reviewTierFor(null, 1, true)).toBe('critic-chore');
    expect(reviewTierFor(null, 2, true)).toBe('critic');
  });

  it('reviews a hard bead on critic every round', () => {
    expect(reviewTierFor('hard', 1, true)).toBe('critic');
    expect(reviewTierFor('hard', 3, true)).toBe('critic');
  });
});

describe('reviewsAgain', () => {
  const clean = { round: 1, diffLines: BIG_DIFF_LINES + 1, cap: 2 };
  it('gives a large standard diff a second round after a clean first one', () => {
    expect(reviewsAgain({ ...clean, tier: 'standard' })).toBe(true);
    expect(reviewsAgain({ ...clean, tier: null })).toBe(true);
  });
  it('lands a small diff, a later round, a capped repo, a chore or a hard bead', () => {
    expect(reviewsAgain({ ...clean, tier: 'standard', diffLines: BIG_DIFF_LINES })).toBe(false);
    expect(reviewsAgain({ ...clean, tier: 'standard', round: 2 })).toBe(false);
    expect(reviewsAgain({ ...clean, tier: 'standard', cap: 1 })).toBe(false);
    expect(reviewsAgain({ ...clean, tier: 'chore' })).toBe(false);
    expect(reviewsAgain({ ...clean, tier: 'hard', cap: 3 })).toBe(false);
  });
});
