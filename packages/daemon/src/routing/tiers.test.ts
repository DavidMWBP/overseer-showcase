import { describe, it, expect } from 'vitest';
import { candidateUsageKey, filterRepoTiers, resolveTier, TierError, NO_SERVER_HARNESSES } from './tiers';
import { DEFAULT_TIERS } from '../db/db';
import type { Repo, TierSettings } from '@overseer/shared';

describe('filterRepoTiers', () => {
  const settings: TierSettings = { denyModels: [], tiers: [{ name: 'standard', candidates: [
    { harness: 'claude', model: 'opus', effort: null, account: 'A' },
    { harness: 'codex', model: 'gpt-6-luna', effort: null },
    { harness: 'opencode', model: 'deepseek-flash', effort: null, account: 'O' },
    { harness: 'claude', model: 'opus', effort: null, account: 'P' },
  ] }] };
  const filter = (patch: Partial<NonNullable<Repo['model_filter']>>): NonNullable<Repo['model_filter']> =>
    ({ harnesses: [], models: [], accounts: [], ...patch });
  const accounts = (f: Repo['model_filter']) => filterRepoTiers(settings, f).tiers[0]!.candidates.map((c) => c.account ?? null);

  it('returns the original settings for null', () => {
    expect(filterRepoTiers(settings, null)).toBe(settings);
  });
  it('preserves Codex ultra effort through filtering and tier resolution', () => {
    const candidate = { harness: 'codex' as const, model: 'custom-codex', effort: 'ultra' as const, account: 'C' };
    const tiers: TierSettings = { ...settings, tiers: [{ name: 'hard', candidates: [settings.tiers[0]!.candidates[0]!, candidate] }] };
    const filtered = filterRepoTiers(tiers, filter({ harnesses: ['codex'], models: ['custom-codex'], accounts: ['C'] }));
    expect(filtered.tiers[0]!.candidates).toEqual([candidate]);
    expect(resolveTier(filtered, 'hard', { previousModels: [] })).toBe(candidate);
    expect(resolveTier(filtered, 'hard', { previousModels: ['custom-codex'], harness: 'codex' })).toBe(candidate);
    expect(candidate.effort).toBe('ultra');
  });
  it('applies each non-empty list, their intersection, and keeps configured order', () => {
    expect(accounts(filter({ harnesses: ['claude'] }))).toEqual(['A', 'P']);
    expect(accounts(filter({ models: ['opus'] }))).toEqual(['A', 'P']);
    expect(accounts(filter({ accounts: ['P', 'A'] }))).toEqual(['A', 'P']);
    expect(accounts(filter({ harnesses: ['claude'], models: ['opus'], accounts: ['P'] }))).toEqual(['P']);
    expect(settings.tiers[0]!.candidates).toHaveLength(4);
  });
  it('rejects an accountless candidate and a removed account id against an accounts list', () => {
    expect(accounts(filter({ accounts: ['missing'] }))).toEqual([]);
    expect(accounts(filter({ harnesses: ['codex'], accounts: ['P'] }))).toEqual([]);
  });
});

describe('resolveTier', () => {
  it('returns the first candidate of the tier', () => {
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: [] })).toEqual({ harness: 'codex', model: 'gpt-5.6-terra', effort: null });
  });
  it('falls back within a tier past used models', () => {
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: ['gpt-5.6-terra'] })).toMatchObject({ harness: 'claude', model: 'sonnet' });
  });
  it('wraps to the first candidate when all were used', () => {
    expect(resolveTier(DEFAULT_TIERS, 'chore', { previousModels: ['gpt-5.6-luna', 'haiku'] })).toMatchObject({ model: 'gpt-5.6-luna' });
  });
  it('steps up chore to standard, hard stays hard, critic never', () => {
    expect(resolveTier(DEFAULT_TIERS, 'chore', { previousModels: [], stepUp: true })).toMatchObject({ model: 'gpt-5.6-terra' });
    expect(resolveTier(DEFAULT_TIERS, 'hard', { previousModels: [], stepUp: true })).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], stepUp: true })).toMatchObject({ model: 'fable' });
  });
  it('excludes the working model for a critic and falls through when the critic tier is that model', () => {
    expect(resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], excludeModel: 'gpt-5.6-terra' })).toMatchObject({ model: 'fable' });
    expect(resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], excludeModel: 'fable' })).toMatchObject({ model: 'gpt-5.6-sol' });
  });
  it('never returns a denied model', () => {
    const s = { ...DEFAULT_TIERS, tiers: DEFAULT_TIERS.tiers.map((t) => t.name === 'hard' ? { ...t, candidates: [{ harness: 'codex' as const, model: 'gpt-6-astra', effort: null }, ...t.candidates] } : t) };
    expect(resolveTier(s, 'hard', { previousModels: [] })).toMatchObject({ model: 'gpt-5.6-sol' });
  });
  it('skips candidates whose CLI is not installed', () => {
    const available = (h: string) => h !== 'codex';
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: [], available })).toEqual({ harness: 'claude', model: 'sonnet', effort: null });
    expect(() => resolveTier(DEFAULT_TIERS, 'critic', { previousModels: [], available: () => false })).toThrow(/not installed/);
  });
  it('skips a candidate whose account is usage-gated', () => {
    const first = DEFAULT_TIERS.tiers.find((tier) => tier.name === 'standard')!.candidates[0]!;
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: [], unusableCandidates: new Map([[candidateUsageKey(first), 'account A: weekly 96% >= 95%']]) })).toMatchObject({ model: 'sonnet' });
  });
  it('skips every candidate on a harness the task must avoid, reporting it when nothing remains', () => {
    const avoid = new Map([['codex' as const, 'codex was stopped for inactivity']]);
    expect(resolveTier(DEFAULT_TIERS, 'standard', { previousModels: [], unusableHarnesses: avoid })).toMatchObject({ harness: 'claude', model: 'sonnet' });
    const only = { tiers: [{ name: 'standard' as const, candidates: [{ harness: 'codex' as const, model: 'gpt-5.6-terra', effort: null }] }], denyModels: [] };
    expect(() => resolveTier(only, 'standard', { previousModels: [], unusableHarnesses: avoid })).toThrow('no usable harness for tier standard: codex was stopped for inactivity');
  });
  it('names the limitation when a server-needing task leaves no harness', () => {
    // NO_SERVER_HARNESSES is what a needs_server dispatch passes as unusableHarnesses.
    expect([...NO_SERVER_HARNESSES.keys()]).toEqual(['opencode']);
    const mixed = { tiers: [{ name: 'standard' as const, candidates: [{ harness: 'opencode' as const, model: 'deepseek/flash', effort: null }, { harness: 'claude' as const, model: 'sonnet', effort: null }] }], denyModels: [] };
    expect(resolveTier(mixed, 'standard', { previousModels: [], unusableHarnesses: NO_SERVER_HARNESSES })).toMatchObject({ harness: 'claude' });
    expect(resolveTier(mixed, 'standard', { previousModels: [] })).toMatchObject({ harness: 'opencode' }); // unchanged without the flag
    const only = { tiers: [{ name: 'standard' as const, candidates: [{ harness: 'opencode' as const, model: 'deepseek/flash', effort: null }] }], denyModels: [] };
    expect(() => resolveTier(only, 'standard', { previousModels: [], unusableHarnesses: NO_SERVER_HARNESSES }))
      .toThrow(/no usable harness for tier standard: opencode cannot keep a server, daemon or browser running.*docs\/server-start-in-a-worker-shell\.md/);
  });
  it('resolves the cheaper chore critic, falling through to the critic tier when it is unconfigured or unusable', () => {
    expect(resolveTier(DEFAULT_TIERS, 'critic-chore', { previousModels: [] })).toMatchObject({ harness: 'claude', model: 'fable' });
    const s = { ...DEFAULT_TIERS, tiers: [...DEFAULT_TIERS.tiers, { name: 'critic-chore' as const, candidates: [{ harness: 'claude' as const, model: 'haiku', effort: null }] }] };
    expect(resolveTier(s, 'critic-chore', { previousModels: [] })).toMatchObject({ model: 'haiku' });
    expect(resolveTier(s, 'critic-chore', { previousModels: [], excludeModel: 'haiku' })).toMatchObject({ model: 'fable' });
  });
  it('throws when nothing remains', () => {
    const s = { tiers: [{ name: 'critic' as const, candidates: [{ harness: 'claude' as const, model: 'fable', effort: null }] }], denyModels: [] };
    expect(() => resolveTier(s, 'critic', { previousModels: [], excludeModel: 'fable' })).toThrow(TierError);
  });
});

describe('resolveTier price order', () => {
  const s = { ...DEFAULT_TIERS, tiers: DEFAULT_TIERS.tiers.map((t) => ({ ...t, candidates: [
    { harness: 'claude' as const, model: 'pricey', effort: null },
    { harness: 'codex' as const, model: 'unpriced', effort: null },
    { harness: 'codex' as const, model: 'cheap', effort: null },
    { harness: 'opencode' as const, model: 'cheap2', effort: null },
  ] })) };
  const table: Record<string, number> = { pricey: 15, cheap: 1, cheap2: 1 };
  const prices = { priceFor: (_h: string, m: string) => (m in table ? { input: table[m]!, output: 1 } : null) };
  it('picks the cheapest usable candidate on a first chore or standard dispatch, tie in configured order', () => {
    expect(resolveTier(s, 'chore', { previousModels: [], prices })).toMatchObject({ model: 'cheap' });
    expect(resolveTier(s, 'standard', { previousModels: [], prices })).toMatchObject({ model: 'cheap' });
  });
  it('keeps configured order for hard, critic and critic-chore', () => {
    for (const t of ['hard', 'critic', 'critic-chore'] as const) expect(resolveTier(s, t, { previousModels: [], prices })).toMatchObject({ model: 'pricey' });
  });
  it('sorts an unpriced model after every priced one', () => {
    const only = { ...s, tiers: s.tiers.map((t) => ({ ...t, candidates: [t.candidates[1]!, t.candidates[0]!] })) };
    expect(resolveTier(only, 'chore', { previousModels: [], prices })).toMatchObject({ model: 'pricey' });
  });
  it('ignores price on a re-dispatch and never returns a previous model', () => {
    const c = resolveTier(s, 'chore', { previousModels: ['cheap'], prices });
    expect(c).toMatchObject({ model: 'pricey' });
    expect(['cheap']).not.toContain(c.model);
  });
  it('falls back to configured order without a catalog', () => {
    expect(resolveTier(s, 'chore', { previousModels: [] })).toMatchObject({ model: 'pricey' });
  });
  it('keeps a forced harness in configured order: of two same-harness candidates the first wins though the second is cheaper', () => {
    const reversed = { ...s, tiers: s.tiers.map((t) => ({ ...t, candidates: [
      { harness: 'codex' as const, model: 'cheap', effort: null },
      { harness: 'claude' as const, model: 'pricey', effort: null },
      { harness: 'claude' as const, model: 'cheap2', effort: null },
    ] })) };
    expect((['chore', 'standard'] as const).map((t) => resolveTier(reversed, t, { previousModels: [], prices, harness: 'claude' }).model)).toEqual(['pricey', 'pricey']);
  });
  it('skips an unusable cheapest candidate', () => {
    expect(resolveTier(s, 'standard', { previousModels: [], prices, available: (h) => h !== 'codex' })).toMatchObject({ model: 'cheap2' });
  });
});
