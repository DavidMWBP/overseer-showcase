import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { TierSettings } from '@overseer/shared';
import type { StoredAccount } from '../db/db';
import { applyEnv, assertNotLiveDb, beginScoring, blindKey, candidateEnv, critiqueCandidate, isSpendFile, leakHits, majorityQuote, majorityRank, majorityScores, openKeep, poolProposals, sessionCaps, takeCase, tierCandidates, verdictBlockers, type FactScore } from './eval';

describe('discussion eval helpers', () => {
  it('labels three runs X, Y, Z, each run once, in an order the random source decides', () => {
    const key = blindKey(['A', 'B', 'C'], () => 0);
    expect(Object.keys(key)).toEqual(['X', 'Y', 'Z']);
    expect(Object.values(key).sort()).toEqual(['A', 'B', 'C']);
    expect(key).toEqual({ X: 'B', Y: 'C', Z: 'A' }); // random() = 0 swaps each slot with slot 0
    expect(blindKey(['A', 'B', 'C'], () => 0.999)).toEqual({ X: 'A', Y: 'B', Z: 'C' }); // the identity shuffle
  });

  it('refuses a duplicate run, too few runs and too many', () => {
    expect(() => blindKey(['A', 'A', 'C'])).toThrow(/distinct/);
    expect(() => blindKey(['A', 'B'])).toThrow(/distinct/);
    expect(() => blindKey([])).toThrow(/distinct/);
    expect(() => blindKey(['A', 'B', 'C', 'D'])).toThrow(/distinct/);
  });

  it('reports every post-fix needle a log carries, case-insensitively, and none for a clean or empty log', () => {
    expect(leakHits('{"type":"AUTH_FAILED"} ... inside the Refresh Margin ... overseer-b137')).toEqual(['auth_failed', 'refresh margin', 'overseer-b137']);
    expect(leakHits('resumeWorkerAfterAuth()')).toEqual(['resumeWorkerAfterAuth']);
    expect(leakHits('401 OAuth access token has been revoked')).toEqual([]);
    expect(leakHits('')).toEqual([]);
  });

  it('refuses the live database path and accepts a temp one', () => {
    const live = path.join(os.homedir(), '.overseer');
    expect(() => assertNotLiveDb(path.join(live, 'overseer.db'), live)).toThrow(/live database/);
    expect(() => assertNotLiveDb(path.join(live, '.', 'OVERSEER.db'), live)).toThrow(/live database/);
    expect(() => assertNotLiveDb(path.join(os.tmpdir(), 'disc-eval', 'overseer.db'), live)).not.toThrow();
  });
});

describe('discussion eval tier and scoring helpers', () => {
  const settings: TierSettings = {
    tiers: [
      { name: 'hard', candidates: [
        { harness: 'claude', model: 'opus', effort: 'medium', account: 'a-1' },
        { harness: 'codex', model: 'gpt-x', effort: 'high' },
      ] },
      { name: 'critic', candidates: [{ harness: 'codex', model: 'gpt-critic', effort: 'high' }] },
    ],
    denyModels: ['denied'],
  };

  it('picks each harness candidate from the named tier, account included', () => {
    const picked = tierCandidates(settings, 'hard', ['claude', 'codex']);
    expect(picked.get('claude')).toEqual({ harness: 'claude', model: 'opus', effort: 'medium', account: 'a-1' });
    expect(picked.get('codex')!.model).toBe('gpt-x');
  });

  it('stops naming the harness a tier has no candidate for, a denied model, and an unknown tier', () => {
    expect(() => tierCandidates(settings, 'hard', ['claude', 'codex', 'opencode'])).toThrow('tier hard has no candidate for opencode');
    const denied = { ...settings, denyModels: ['gpt-x'] };
    expect(() => tierCandidates(denied, 'hard', ['codex'])).toThrow('no candidate for codex');
    expect(() => tierCandidates(settings, 'nope', ['claude', 'codex'])).toThrow('tier nope has no candidate for claude, codex');
  });

  it('critiques on the critic tier codex, falling back to the hard tier and saying so', () => {
    expect(critiqueCandidate(settings)).toMatchObject({ tier: 'critic', candidate: { model: 'gpt-critic' } });
    const noCritic = { ...settings, tiers: settings.tiers.filter((t) => t.name !== 'critic') };
    const fallback = critiqueCandidate(noCritic);
    expect(fallback).toMatchObject({ tier: 'hard', candidate: { model: 'gpt-x' } });
    expect(fallback.note).toMatch(/critic tier has no codex candidate/);
    expect(() => critiqueCandidate({ tiers: [], denyModels: [] })).toThrow('tier hard has no candidate for codex');
  });

  it('takes the majority per fact over three passes, with the mean total and its range', () => {
    const pass = (...s: (0 | 1)[]) => s.map((score, i) => ({ fact: i + 1, score, quote: '' }));
    const r = majorityScores([pass(1, 1, 0), pass(1, 0, 0), pass(0, 1, 1)], 3);
    expect(r.majority).toEqual([1, 1, 0]);
    expect(r.totals).toEqual([2, 1, 2]);
    expect(r.mean).toBeCloseTo(5 / 3);
    expect([r.min, r.max]).toEqual([1, 2]);
    // A fact missing from a pass counts 0, an even split counts 0, and all-zero passes give 0 everywhere.
    expect(majorityScores([pass(1), [] as FactScore[]], 1)).toMatchObject({ majority: [0], totals: [1, 0], mean: 0.5, min: 0, max: 1 });
    expect(majorityScores([pass(0, 0), pass(0, 0), pass(0, 0)], 2)).toMatchObject({ majority: [0, 0], mean: 0, min: 0, max: 0 });
    expect(() => majorityScores([], 9)).toThrow(/at least one/);
  });
});

describe('discussion eval accounts, budget and quotes', () => {
  const claudeAccount: StoredAccount = { id: 'a-claude', name: 'Claude', harness: 'claude', kind: 'oauth_token', provider: null, secret: 'tok', home: null, created_at: '2026-09-23', last_login_at: null, last_verified_at: null, token_expires_at: 10_000 };
  const codexAccount: StoredAccount = { id: 'a-codex', name: 'Codex', harness: 'codex', kind: 'codex_home', provider: null, secret: null, home: '/codex-home', created_at: '2026-09-23', last_login_at: null, last_verified_at: null };
  const accounts = new Map([[claudeAccount.id, claudeAccount], [codexAccount.id, codexAccount]]);

  it("gives the critic tier's codex candidate its account's CODEX_HOME, and a candidate without one nothing", () => {
    const settings: TierSettings = { tiers: [{ name: 'critic', candidates: [{ harness: 'codex', model: 'gpt-critic', effort: 'high', account: 'a-codex' }] }], denyModels: [] };
    const { candidate } = critiqueCandidate(settings);
    expect(candidateEnv(candidate, accounts, 0)).toEqual({ CODEX_HOME: '/codex-home' });
    expect(candidateEnv({ harness: 'codex', model: 'gpt-critic', effort: null }, accounts, 0)).toEqual({});
  });

  it('gives a Claude OAuth candidate its token, clears the API key, and stops on an expiring, missing or mismatched account', () => {
    expect(candidateEnv({ harness: 'claude', model: 'opus', effort: null, account: 'a-claude' }, accounts, 9_999)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: undefined });
    expect(() => candidateEnv({ harness: 'claude', model: 'opus', effort: null, account: 'a-claude' }, accounts, 10_001)).toThrow(/expires at .* inside the run/);
    expect(() => candidateEnv({ harness: 'claude', model: 'opus', effort: null, account: 'a-gone' }, accounts, 0)).toThrow(/a-gone, which was not read/);
    expect(() => candidateEnv({ harness: 'claude', model: 'opus', effort: null, account: 'a-codex' }, accounts, 0)).toThrow(/a-codex, a codex account/);
  });

  it('applies an environment, deleting undefined values instead of storing "undefined"', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'stale', KEEP: 'x' };
    applyEnv(env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: undefined });
    expect(env).toEqual({ KEEP: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    applyEnv(env, {});
    expect(env).toEqual({ KEEP: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });

  it("counts a tier's run and score files and their earlier attempts, and no other tier's", () => {
    for (const n of ['hard-run-A.json', 'hard-score.json', 'attempt1-hard-run-A.json', 'attempt12-hard-score.json']) expect(isSpendFile(n, 'hard-')).toBe(true);
    for (const n of ['run-A.json', 'score.json', 'hard-run-A.md', 'hard-run-D.json', 'hard-score-prompt-1.md', 'hard-report.md', 'attempt1-run-B.json']) expect(isSpendFile(n, 'hard-')).toBe(false);
    for (const n of ['run-C.json', 'score.json', 'attempt2-run-B.json', 'attempt3-score.json']) expect(isSpendFile(n, '')).toBe(true);
    for (const n of ['hard-run-A.json', 'attempt1-hard-run-A.json', 'run-A.md', 'score-prompt.md']) expect(isSpendFile(n, '')).toBe(false);
  });

  it('quotes a fact only when its majority is 1, from a pass that scored it', () => {
    const passes: FactScore[][] = [[{ fact: 1, score: 0, quote: '' }], [{ fact: 1, score: 1, quote: 'dissent' }], [{ fact: 1, score: 1, quote: 'second' }]];
    expect(majorityQuote(passes, 1, 1)).toBe('dissent');
    expect(majorityQuote(passes, 1, 0)).toBeNull();
    expect(majorityQuote([[{ fact: 1, score: 1, quote: 'lone' }], [], []], 1, 0)).toBeNull();
    expect(majorityQuote(passes, 2, 1)).toBeNull();
  });
});

describe('discussion eval verdict and budget gates', () => {
  const done = { status: 'done', scored: true };

  it('gives a verdict only when both runs are done and all three passes are saved', () => {
    expect(verdictBlockers(done, done, 3, 3)).toEqual([]);
  });

  it('blocks the verdict after one or two passes at the cap, naming the saved pass count', () => {
    expect(verdictBlockers(done, done, 1, 3)).toEqual(['only 1 of 3 scoring passes saved']);
    expect(verdictBlockers(done, done, 2, 3)).toEqual(['only 2 of 3 scoring passes saved']);
  });

  it('blocks on a missing, unfinished or unscored run', () => {
    expect(verdictBlockers(undefined, done, 3, 3)).toEqual(['run B was not run']);
    expect(verdictBlockers(done, { status: 'stopped', stop_reason: 'cost cap', scored: true }, 3, 3)).toEqual(['run C is stopped (cost cap)']);
    expect(verdictBlockers({ ...done, scored: false }, { ...done, scored: false }, 0, 3)).toEqual(['runs B and C are not scored']);
  });

  it('refuses a retry at the cap before archiving the saved score file, and archives below it', () => {
    let archived = 0;
    expect(() => beginScoring(40, 40, () => archived++)).toThrow('budget: $40.00 already spent of $40');
    expect(() => beginScoring(41.5, 40, () => archived++)).toThrow(/budget/);
    expect(archived).toBe(0);
    beginScoring(39.99, 40, () => archived++);
    expect(archived).toBe(1);
  });
});

describe('discussion eval open-question case', () => {
  const files: Record<string, string> = { 'q.md': '  How can we improve the Office page?\n', 'blank.md': ' \n' };
  const read = (f: string) => files[f] ?? '';

  it('stays on the token case when no case flag is given, leaving the other arguments alone', () => {
    const argv = ['run', 'A', '--tier', 'hard'];
    expect(takeCase(argv, read)).toBeNull();
    expect(argv).toEqual(['run', 'A', '--tier', 'hard']);
    expect(takeCase([], read)).toBeNull();
  });

  it('takes the question from a file and the repo ref from a flag, removing all three flags', () => {
    const argv = ['run', '--case', 'office', 'C', '--question-file', 'q.md', '--repo-ref', '6087e2e', '--tier', 'hard'];
    expect(takeCase(argv, read)).toEqual({ name: 'office', question: 'How can we improve the Office page?', repoRef: '6087e2e' });
    expect(argv).toEqual(['run', 'C', '--tier', 'hard']);
  });

  it('refuses a partial set, a flag without a value, a blank question file and a bad case name', () => {
    expect(() => takeCase(['--case', 'office'], read)).toThrow(/needs --question-file, --repo-ref as well/);
    expect(() => takeCase(['--repo-ref', 'x', '--question-file', 'q.md'], read)).toThrow(/needs --case as well/);
    expect(() => takeCase(['--case'], read)).toThrow(/--case needs a value/);
    expect(() => takeCase(['--case', 'office', '--question-file', 'blank.md', '--repo-ref', 'x'], read)).toThrow(/holds no question/);
    expect(() => takeCase(['--case', 'Office page', '--question-file', 'q.md', '--repo-ref', 'x'], read)).toThrow(/lowercase/);
  });
});

describe('discussion eval pooling and ranks', () => {
  const runs = ['A', 'B', 'C'];

  it('merges duplicates across runs into one entry, counting each run once per entry and its unique finds', () => {
    const valid = ['A#1', 'B#1', 'C#1', 'C#2', 'C#3', 'B#2'];
    const { pooled, counts, unique } = poolProposals(valid, [
      { title: 'memoise labels', members: ['A#1', 'B#1', 'C#1'] },
      { title: 'pause loop', members: ['C#2', 'C#3'] }, // C said it twice: one distinct proposal
      { title: 'aria labels', members: ['B#2'] },
    ], runs);
    expect(pooled.map((p) => p.runs)).toEqual([['A', 'B', 'C'], ['C'], ['B']]);
    expect(counts).toEqual({ A: 1, B: 2, C: 2 });
    expect(unique).toEqual({ A: 0, B: 1, C: 1 });
  });

  it('counts zero for a run with no valid proposal and an empty pool', () => {
    expect(poolProposals([], [], runs)).toEqual({ pooled: [], counts: { A: 0, B: 0, C: 0 }, unique: { A: 0, B: 0, C: 0 } });
  });

  it('refuses a pool that drops, repeats, or invents a proposal, or lists an invalid one', () => {
    expect(() => poolProposals(['A#1', 'B#1'], [{ title: 't', members: ['A#1'] }], runs)).toThrow(/leaves out B#1/);
    expect(() => poolProposals(['A#1'], [{ title: 't', members: ['A#1'] }, { title: 'u', members: ['A#1'] }], runs)).toThrow(/groups 1 and 2/);
    expect(() => poolProposals(['A#1'], [{ title: 't', members: ['A#1', 'A#2'] }], runs)).toThrow(/A#2, which is not a valid/);
  });

  it('takes the rank most judges gave, and none when the three judges all differ', () => {
    const j = [{ A: 3, B: 1, C: 2 }, { A: 3, B: 2, C: 1 }, { A: 2, B: 1, C: 3 }];
    expect(majorityRank(j, 'A')).toBe(3);
    expect(majorityRank(j, 'B')).toBe(1);
    expect(majorityRank(j, 'C')).toBeNull();
    expect(majorityRank([], 'A')).toBeNull();
  });

  it('keeps C on 2+ more valid proposals or a better rank, only within 3x B cost, and reports both parts', () => {
    expect(openKeep({ valid: 5, rank: 2, cost: 1 }, { valid: 7, rank: 2, cost: 3 })).toMatchObject({ moreValid: true, rankBeats: false, keep: true });
    expect(openKeep({ valid: 5, rank: 2, cost: 1 }, { valid: 6, rank: 1, cost: 2 })).toMatchObject({ moreValid: false, rankBeats: true, keep: true });
    expect(openKeep({ valid: 5, rank: 2, cost: 1 }, { valid: 9, rank: 1, cost: 3.1 })).toMatchObject({ moreValid: true, rankBeats: true, keep: false });
    expect(openKeep({ valid: 5, rank: null, cost: 1 }, { valid: 6, rank: 1, cost: 1 })).toMatchObject({ moreValid: false, rankBeats: false, keep: false });
  });
});

describe('discussion eval session caps', () => {
  it('splits what is left equally over the sessions, less the margin each, so their caps sum within the budget', () => {
    const caps = sessionCaps(10, 4, 1, 0.25);
    expect(caps).toEqual([2.25, 2.25, 2.25, 2.25]);
    expect(caps.reduce((a, b) => a + b, 0) + caps.length * 0.25).toBeLessThanOrEqual(10);
  });

  it('starts fewer sessions near the limit, and none when one share would fall below the minimum', () => {
    expect(sessionCaps(3.1, 4, 1, 0.25)).toEqual([1.3, 1.3]);
    expect(sessionCaps(1.25, 4, 1, 0.25)).toEqual([1]);
    expect(sessionCaps(1.2, 4, 1, 0.25)).toEqual([]);
    expect(sessionCaps(0, 4, 1, 0.25)).toEqual([]);
    expect(sessionCaps(-3, 1, 1, 0.25)).toEqual([]);
    expect(sessionCaps(10, 0, 1, 0.25)).toEqual([]);
  });
});
