import type { AssertionResult, EvalCase } from './promptEval';

/**
 * The shortening loop's decisions, kept free of processes so they are tested directly: `scripts/prompt-loop.ts` wires them to
 * the live rewriter session and to `scripts/prompt-eval.ts` runs. Holdout cases, transcripts and per-case results never reach
 * the rewriter: `buildRewriterInput` reads the train report and the train cases only.
 */

/** One run as `scripts/prompt-eval.ts` writes it to `report.json` (the fields the loop reads). */
export interface ReportRun { case: string; run: number; passed: boolean; stop: string | null; assertions: AssertionResult[]; transcript: string }
/** A `report.json` from `scripts/prompt-eval.ts` (the fields the loop reads). */
export interface EvalReport {
  prompt_chars: number; complete: boolean; score: number | null; total_cost: number; k: number;
  cases: { id: string; pass_rate: number | null; runs: ReportRun[] }[];
}

/** A prompt with its train and holdout scores. */
export interface Scored { text: string; chars: number; train: EvalReport; holdout: EvalReport }
export interface Scores { chars: number; train: number | null; holdout: number | null }
export const scoresOf = (s: Scored): Scores => ({ chars: s.chars, train: s.train.score, holdout: s.holdout.score });

export interface LoopLimits {
  maxRounds: number; budgetUsd: number; targetChars: number; targetHoldout: number;
  /** What one rewriter call may cost at most; the estimate for the rewriter before any round has run. */
  rewriteCapUsd: number;
}
export const LOOP_DEFAULTS = { k: 3, maxRounds: 5, budgetUsd: 300, targetChars: 30_000, targetHoldout: 0.9 } as const;

export interface RoundRecord {
  round: number; chars: number | null; train: number | null; holdout: number | null;
  rewrite_cost: number; eval_cost: number; cost: number; duration_ms: number; kept: boolean; why: string;
}

const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));

/**
 * Two scores closer than this are the same score. A score is a mean of pass rates, so the same passes summed in another order
 * can differ in the last bit (0.6666666666666666 against 0.6666666666666667 for 20 of 30 runs), while two different pass counts
 * differ by at least 1/(K × cases).
 */
export const SCORE_TOLERANCE = 1e-9;
const below = (a: number, b: number) => a < b - SCORE_TOLERANCE;

/**
 * The keep rule: a candidate replaces the best only when it is shorter, its holdout score is at least the best's and its train
 * score is at least the best's. A missing score (an incomplete eval) never counts as at least anything.
 */
export function keepDecision(best: Scores, cand: Scores): { keep: boolean; why: string } {
  if (cand.chars >= best.chars) return { keep: false, why: `not shorter: ${cand.chars} characters against the best's ${best.chars}` };
  if (cand.holdout === null || best.holdout === null || below(cand.holdout, best.holdout)) return { keep: false, why: `holdout ${fmt(cand.holdout)} is below the best's ${fmt(best.holdout)}` };
  if (cand.train === null || best.train === null || below(cand.train, best.train)) return { keep: false, why: `train ${fmt(cand.train)} is below the best's ${fmt(best.train)}` };
  return { keep: true, why: `shorter (${cand.chars} against ${best.chars} characters) with holdout ${fmt(cand.holdout)} ≥ ${fmt(best.holdout)} and train ${fmt(cand.train)} ≥ ${fmt(best.train)}` };
}

/** The next round's estimated cost: the mean cost of the rounds so far, or before round 1 the round-0 cost plus the rewriter's cap. */
export function nextRoundEstimate(rounds: readonly RoundRecord[], round0Cost: number, rewriteCapUsd: number): number {
  return rounds.length ? rounds.reduce((s, r) => s + r.cost, 0) / rounds.length : round0Cost + rewriteCapUsd;
}

/** Why the loop stops before the next round, or null to run it. Checked in order: target, rounds, budget, the next round's estimate. */
export function stopReason(o: { best: Scores; rounds: readonly RoundRecord[]; spend: number; round0Cost: number }, limits: LoopLimits): string | null {
  const { best, rounds, spend } = o;
  if (best.holdout !== null && !below(best.holdout, limits.targetHoldout) && best.chars <= limits.targetChars) {
    return `target reached: holdout ${fmt(best.holdout)} ≥ ${limits.targetHoldout} at ${best.chars} ≤ ${limits.targetChars} characters`;
  }
  if (rounds.length >= limits.maxRounds) return `${limits.maxRounds} rounds done`;
  if (spend >= limits.budgetUsd) return `budget reached: $${spend.toFixed(2)} spent of $${limits.budgetUsd.toFixed(2)}`;
  const estimate = nextRoundEstimate(rounds, o.round0Cost, limits.rewriteCapUsd);
  if (spend + estimate > limits.budgetUsd) return `the next round's estimate $${estimate.toFixed(2)} would take the spend $${spend.toFixed(2)} past the budget $${limits.budgetUsd.toFixed(2)}`;
  return null;
}

/**
 * Refuses a round-0 report that does not belong to the prompt and the cases: its `prompt_chars` must equal the prompt file's
 * character count, its `k` must equal the loop's K (so the baseline and every candidate are scored on the same run count), it
 * must be complete with a score, and it must cover exactly the directory's case ids.
 */
export function checkRound0Report(report: EvalReport, promptText: string, k: number, caseIds: readonly string[], label: string): void {
  if (report.prompt_chars !== promptText.length) throw new Error(`the ${label} report scored a prompt of ${report.prompt_chars} characters, but the prompt file has ${promptText.length}`);
  if (report.k !== k) throw new Error(`the ${label} report ran each case ${report.k} time(s), but the loop runs K=${k}`);
  if (!report.complete || report.score === null) throw new Error(`the ${label} report is incomplete`);
  const got = report.cases.map((c) => c.id).sort().join(',');
  const want = [...caseIds].sort().join(',');
  if (got !== want) throw new Error(`the ${label} report covers cases ${got}, but the ${label} directory holds ${want}`);
}

const OPEN = '<prompt>';
const CLOSE = '</prompt>';

/**
 * The rewriter's whole input: the current best prompt and its length, the target, the train cases, and the transcript and
 * failing checks of every failed train run. It takes the best's train report only; nothing of `best.holdout` is read.
 */
export function buildRewriterInput(o: { best: Scored; trainCases: readonly EvalCase[]; targetChars: number }): string {
  const { best, trainCases, targetChars } = o;
  const failed = best.train.cases.flatMap((c) => c.runs.filter((r) => !r.passed));
  const failedText = failed.length
    ? failed.map((r) => `### ${r.case} run ${r.run}${r.stop ? ` (${r.stop})` : ''}\n\nFailing checks:\n${r.assertions.filter((a) => !a.pass).map((a) => `- ${a.assertion.kind === 'rubric' ? `rubric: ${a.assertion.line}` : JSON.stringify(a.assertion)}: ${a.detail}`).join('\n') || '- (none: the turn did not complete)'}\n\nTranscript:\n\n${r.transcript}`).join('\n\n')
    : 'Every train run passed.';
  return `You are shortening the system prompt of an AI coordinator that manages coding work for a user through tools. Write one shorter version of the prompt below.

The current prompt has ${best.chars} characters; the target is ${targetChars} characters or fewer. Any shorter version counts, but aim for the target.
You may reword, merge, compress or drop any rule, and you do not have to keep any sentence word for word. You must keep the behaviour the train cases below test: each case is an input the coordinator receives, the fixed tool replies it gets, and the checks its run must pass (exact tool-call checks and rubric lines a judge grades against the transcript). A shorter prompt that fails them is discarded. It is also scored on cases you do not see, so keep the general rules those train cases stand for, not only their literal wording.

Reply with the complete new prompt between ${OPEN} and ${CLOSE}, and nothing else.

## Current prompt (${best.chars} characters)

${best.text}

## Train cases (${trainCases.length})

${trainCases.map((c) => `### ${c.id}\n\n\`\`\`json\n${JSON.stringify(c, null, 2)}\n\`\`\``).join('\n\n')}

## Failed train runs of the current prompt (${failed.length}, train score ${fmt(best.train.score)})

${failedText}
`;
}

/** The candidate prompt between the rewriter's markers, trimmed; a reply without them, or with nothing between, is refused. */
export function extractCandidate(reply: string): string {
  const start = reply.indexOf(OPEN);
  const end = reply.lastIndexOf(CLOSE);
  if (start < 0 || end < start) throw new Error(`the reply holds no ${OPEN}…${CLOSE} block`);
  const text = reply.slice(start + OPEN.length, end).trim();
  if (!text) throw new Error(`the ${OPEN} block is empty`);
  return `${text}\n`;
}

export interface LoopDeps {
  /** One fresh rewriter session on `input`: its reply and cost. */
  rewrite(input: string, round: number): Promise<{ reply: string; cost: number; error: string | null }>;
  /** The candidate's train and holdout reports at K. */
  score(text: string, round: number): Promise<{ train: EvalReport; holdout: EvalReport }>;
  /** Called after round 0 and after every round with the state so far, so a partial loop is on disk when a later round throws. */
  onProgress?(state: LoopState): void;
  now?(): number;
}
export interface LoopState { start: Scored; best: Scored; bestRound: number; rounds: RoundRecord[]; spend: number; stop: string | null }

/**
 * Runs rounds until `stopReason` names a stop. Each round writes one candidate from the current best, scores it on train and
 * holdout (whatever its length, so every round records both scores), and keeps it per `keepDecision`. `round0.spend` is what
 * round 0 cost in this loop (0 when its reports were supplied); `round0.cost` is its recorded cost either way.
 */
export async function runLoop(start: Scored, trainCases: readonly EvalCase[], limits: LoopLimits, round0: { spend: number; cost: number }, deps: LoopDeps): Promise<LoopState> {
  const now = deps.now ?? Date.now;
  const state: LoopState = { start, best: start, bestRound: 0, rounds: [], spend: round0.spend, stop: null };
  deps.onProgress?.(state);
  for (;;) {
    state.stop = stopReason({ best: scoresOf(state.best), rounds: state.rounds, spend: state.spend, round0Cost: round0.cost }, limits);
    if (state.stop) break;
    const round = state.rounds.length + 1;
    const started = now();
    const rewritten = await deps.rewrite(buildRewriterInput({ best: state.best, trainCases, targetChars: limits.targetChars }), round);
    let text: string | null = null;
    let why = '';
    try {
      if (rewritten.error) throw new Error(rewritten.error);
      text = extractCandidate(rewritten.reply);
    } catch (err) {
      why = `the rewriter gave no candidate: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    }
    const record: RoundRecord = { round, chars: text?.length ?? null, train: null, holdout: null, rewrite_cost: rewritten.cost, eval_cost: 0, cost: rewritten.cost, duration_ms: 0, kept: false, why };
    if (text !== null) {
      const { train, holdout } = await deps.score(text, round);
      const cand: Scored = { text, chars: text.length, train, holdout };
      Object.assign(record, { train: train.score, holdout: holdout.score, eval_cost: train.total_cost + holdout.total_cost });
      record.cost += record.eval_cost;
      const decision = keepDecision(scoresOf(state.best), scoresOf(cand));
      record.kept = decision.keep;
      record.why = decision.why;
      if (decision.keep) { state.best = cand; state.bestRound = round; }
    }
    record.duration_ms = now() - started;
    state.rounds.push(record);
    state.spend += record.cost;
    deps.onProgress?.(state);
  }
  deps.onProgress?.(state);
  return state;
}
