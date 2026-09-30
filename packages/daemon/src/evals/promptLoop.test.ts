import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from './promptEval';
import {
  buildRewriterInput, checkRound0Report, keepDecision, runLoop, stopReason,
  type EvalReport, type LoopLimits, type RoundRecord, type Scored,
} from './promptLoop';

const CASES_DIR = fileURLToPath(new URL('../../evals/orchestrator/cases', import.meta.url));
const LIMITS: LoopLimits = { maxRounds: 5, budgetUsd: 300, targetChars: 30_000, targetHoldout: 0.9, rewriteCapUsd: 10 };

const report = (score: number, over: Partial<EvalReport> = {}): EvalReport => ({ prompt_chars: 0, complete: true, score, total_cost: 1, k: 3, cases: [], ...over });
const round = (cost: number): RoundRecord => ({ round: 1, chars: 1, train: 0, holdout: 0, rewrite_cost: 0, eval_cost: cost, cost, duration_ms: 0, kept: false, why: '' });

describe('keepDecision', () => {
  const best = { chars: 1000, train: 0.8, holdout: 0.7 };
  it('keeps a shorter candidate with equal scores', () => {
    expect(keepDecision(best, { chars: 999, train: 0.8, holdout: 0.7 }).keep).toBe(true);
  });
  it('does not keep a candidate with a lower holdout score', () => {
    expect(keepDecision(best, { chars: 500, train: 0.9, holdout: 0.6 }).keep).toBe(false);
  });
  it('does not keep a candidate with a lower train score', () => {
    expect(keepDecision(best, { chars: 500, train: 0.7, holdout: 0.8 }).keep).toBe(false);
  });
  it('keeps a candidate whose equal scores differ only in the last bit of the mean', () => {
    // 2026-09-26: 20 of 30 holdout runs scored 0.6666666666666667 for the start and 0.6666666666666666 for a 37,028-character
    // candidate, which was rejected as "holdout 0.667 is below the best's 0.667".
    const start = { chars: 54_238, train: 0.8666666666666666, holdout: 0.6666666666666667 };
    expect(keepDecision(start, { chars: 37_028, train: 0.9, holdout: 0.6666666666666666 }).keep).toBe(true);
    expect(keepDecision(start, { chars: 37_028, train: 0.8666666666666665, holdout: 0.6666666666666667 }).keep).toBe(true);
  });
  it('does not keep a candidate one run lower on a 30-run holdout or a 60-run train', () => {
    const start = { chars: 54_238, train: 52 / 60, holdout: 20 / 30 };
    expect(keepDecision(start, { chars: 37_028, train: 0.9, holdout: 19 / 30 }).keep).toBe(false);
    expect(keepDecision(start, { chars: 37_028, train: 51 / 60, holdout: 0.7 }).keep).toBe(false);
  });
  it('does not keep a candidate of the same length or longer', () => {
    expect([1000, 1001].map((chars) => keepDecision(best, { chars, train: 1, holdout: 1 }).keep)).toEqual([false, false]);
  });
});

describe('stopReason', () => {
  const far = { chars: 50_000, train: 0.8, holdout: 0.7 };
  it('stops when the best reaches the holdout target at the character target', () => {
    expect(stopReason({ best: { chars: 30_000, train: 0.8, holdout: 0.9 }, rounds: [], spend: 0, round0Cost: 40 }, LIMITS)).toMatch(/^target reached/);
  });
  it('reaches the holdout target on a mean one bit short of 0.9 and not on one run fewer', () => {
    expect(stopReason({ best: { chars: 30_000, train: 0.8, holdout: 0.8999999999999999 }, rounds: [], spend: 0, round0Cost: 40 }, LIMITS)).toMatch(/^target reached/);
    expect(stopReason({ best: { chars: 30_000, train: 0.8, holdout: 26 / 30 }, rounds: [], spend: 0, round0Cost: 40 }, LIMITS)).toBeNull();
  });
  it('stops after 5 rounds', () => {
    expect(stopReason({ best: far, rounds: Array.from({ length: 5 }, () => round(1)), spend: 5, round0Cost: 40 }, LIMITS)).toBe('5 rounds done');
  });
  it('stops when the spend reaches the budget', () => {
    expect(stopReason({ best: far, rounds: [round(1)], spend: 300, round0Cost: 40 }, LIMITS)).toMatch(/^budget reached/);
  });
  it("stops when the next round's estimate would take the spend past the budget", () => {
    // Two rounds at a mean of $60 with $250 spent: the next one is estimated at $60, which would reach $310.
    expect(stopReason({ best: far, rounds: [round(50), round(70)], spend: 250, round0Cost: 40 }, LIMITS)).toMatch(/estimate \$60\.00 would take the spend/);
  });
});

describe('buildRewriterInput', () => {
  it('holds no holdout case id, input text or transcript, with a holdout directory present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-loop-split-'));
    try {
      fs.cpSync(path.join(CASES_DIR, 'train'), path.join(root, 'train'), { recursive: true });
      fs.cpSync(path.join(CASES_DIR, 'holdout'), path.join(root, 'holdout'), { recursive: true });
      const train = loadCases(path.join(root, 'train'));
      const holdout = loadCases(path.join(root, 'holdout'));
      const failedRun = (id: string, transcript: string) => ({ case: id, run: 1, passed: false, stop: null, assertions: [{ assertion: { kind: 'no_message' as const }, pass: false, detail: '1 message(s)' }], transcript });
      const best: Scored = {
        text: 'PROMPT', chars: 6,
        train: report(0.5, { cases: train.map((c) => ({ id: c.id, pass_rate: 0, runs: [failedRun(c.id, `TRAIN TRANSCRIPT ${c.id}`)] })) }),
        holdout: report(0.5, { cases: holdout.map((c) => ({ id: c.id, pass_rate: 0, runs: [failedRun(c.id, `HOLDOUT TRANSCRIPT ${c.id}`)] })) }),
      };
      const input = buildRewriterInput({ best, trainCases: train, targetChars: 30_000 });
      const leaks = holdout.flatMap((c) => [c.id, c.input, `HOLDOUT TRANSCRIPT ${c.id}`]).filter((s) => input.includes(s));
      expect({ leaks, trainTranscripts: train.every((c) => input.includes(`TRAIN TRANSCRIPT ${c.id}`)) }).toEqual({ leaks: [], trainTranscripts: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkRound0Report', () => {
  it("refuses a round-0 report whose prompt_chars does not match the prompt file", () => {
    expect(() => checkRound0Report(report(0.8, { prompt_chars: 11, cases: [{ id: 'a', pass_rate: 1, runs: [] }] }), 'ten chars!', 3, ['a'], 'train')).toThrow('the train report scored a prompt of 11 characters, but the prompt file has 10');
  });
  it("refuses a round-0 report whose k differs from the loop's K", () => {
    expect(() => checkRound0Report(report(0.8, { prompt_chars: 10, k: 1, cases: [{ id: 'a', pass_rate: 1, runs: [] }] }), 'ten chars!', 3, ['a'], 'holdout')).toThrow('the holdout report ran each case 1 time(s), but the loop runs K=3');
  });
  it('accepts a round-0 report that matches the prompt, K and the cases', () => {
    expect(() => checkRound0Report(report(0.8, { prompt_chars: 10, k: 3, cases: [{ id: 'a', pass_rate: 1, runs: [] }] }), 'ten chars!', 3, ['a'], 'train')).not.toThrow();
  });
});

describe('runLoop', () => {
  it('runs zero rounds and keeps the starting prompt as the winner when round 0 already meets the target', async () => {
    const start: Scored = { text: 'x'.repeat(20_000), chars: 20_000, train: report(0.95), holdout: report(0.9) };
    const unused = async () => { throw new Error('no round should run'); };
    const state = await runLoop(start, [], LIMITS, { spend: 0, cost: 40 }, { rewrite: unused, score: unused });
    expect({ rounds: state.rounds.length, winner: state.best === start, stop: state.stop?.startsWith('target reached') }).toEqual({ rounds: 0, winner: true, stop: true });
  });
  it('scores a candidate of the same length on train and holdout and records both scores without keeping it', async () => {
    const start: Scored = { text: 'x'.repeat(99) + '\n', chars: 100, train: report(0.5), holdout: report(0.5) };
    const scored: string[] = [];
    const state = await runLoop(start, [], { ...LIMITS, maxRounds: 1 }, { spend: 0, cost: 2 }, {
      rewrite: async () => ({ reply: `<prompt>${'y'.repeat(99)}</prompt>`, cost: 0.5, error: null }),
      score: async (text) => { scored.push(text); return { train: report(1, { total_cost: 1 }), holdout: report(1, { total_cost: 2 }) }; },
    });
    const r = state.rounds[0]!;
    expect({ scored: scored.length, chars: r.chars, train: r.train, holdout: r.holdout, cost: r.cost, kept: r.kept, winner: state.best === start, why: r.why.startsWith('not shorter') })
      .toEqual({ scored: 1, chars: 100, train: 1, holdout: 1, cost: 3.5, kept: false, winner: true, why: true });
  });
});
