/**
 * Prompt shortening loop: rewrites a prompt shorter, round by round, and keeps a rewrite only when it loses no score.
 *
 *   pnpm --filter @overseer/daemon eval:loop [--prompt <file>] [--train <dir>] [--holdout <dir>] [--k <n>] [--rounds <n>]
 *     [--budget-usd <n>] [--target-chars <n>] [--target-holdout <n>] [--max-rewrite-usd <n>]
 *     [--train-report <report.json>] [--holdout-report <report.json>] [--max-run-usd <n>] [--judge-model <model>]
 *
 * Defaults: `prompts/orchestrator.md`, `evals/orchestrator/cases/train` and `.../holdout`, K=3, 5 rounds, a $300 budget, a
 * 30,000-character and 0.9 holdout target, a $10 cap per rewriter call; `--max-run-usd` and `--judge-model` go to each eval.
 *
 * Round 0 is the starting prompt's train and holdout scores, from `scripts/prompt-eval.ts` runs or from the two reports given,
 * which are refused unless their `prompt_chars` equals the prompt file's character count and their `k` equals K
 * (`checkRound0Report`). Each round a
 * fresh rewriter session (`claudeCall` on the live orchestrator's model, effort and account, a temp cwd, no tools, no MCP
 * server, Git's system and global configuration switched off) writes one candidate from the current best, the train cases and
 * the failed train runs (`buildRewriterInput`); it never sees a holdout case, transcript or per-case result. Every candidate is
 * scored on train and holdout at K and kept per `keepDecision`; the loop stops per `stopReason`. Everything goes to
 * `<live data dir>/evidence/prompt-evals/loop-<run id>/`; nothing is written to `prompts/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnLines } from '../src/util/procs';
import { loadCases } from '../src/evals/promptEval';
import {
  LOOP_DEFAULTS, checkRound0Report, runLoop, type EvalReport, type LoopLimits, type LoopState, type Scored,
} from '../src/evals/promptLoop';
import { LIVE, claudeCall, envUntil, readLive } from './evalLive';

const DAEMON_DIR = fileURLToPath(new URL('..', import.meta.url));
const EVAL_SCRIPT = path.join(DAEMON_DIR, 'scripts', 'prompt-eval.ts');
const TSX_CLI = path.join(path.dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
const PROBE_CAP_USD = 1;
const TOKEN_MARGIN_MS = 30 * 60_000;

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
const CASES = path.join(DAEMON_DIR, 'evals', 'orchestrator', 'cases');
const PROMPT = path.resolve(flag('--prompt', path.join(DAEMON_DIR, 'prompts', 'orchestrator.md')));
const TRAIN = path.resolve(flag('--train', path.join(CASES, 'train')));
const HOLDOUT = path.resolve(flag('--holdout', path.join(CASES, 'holdout')));
const K = Number(flag('--k', String(LOOP_DEFAULTS.k)));
const TRAIN_REPORT = flag('--train-report', '');
const HOLDOUT_REPORT = flag('--holdout-report', '');
const LIMITS: LoopLimits = {
  maxRounds: Number(flag('--rounds', String(LOOP_DEFAULTS.maxRounds))),
  budgetUsd: Number(flag('--budget-usd', String(LOOP_DEFAULTS.budgetUsd))),
  targetChars: Number(flag('--target-chars', String(LOOP_DEFAULTS.targetChars))),
  targetHoldout: Number(flag('--target-holdout', String(LOOP_DEFAULTS.targetHoldout))),
  rewriteCapUsd: Number(flag('--max-rewrite-usd', '10')),
};
const PASS_THROUGH = ['--max-run-usd', '--judge-model'].flatMap((name) => (argv.includes(name) ? [name, flag(name, '')] : []));
if (!Number.isInteger(K) || K < 1) throw new Error(`--k must be a whole number of at least 1, got ${K}`);
if (!Number.isInteger(LIMITS.maxRounds) || LIMITS.maxRounds < 0) throw new Error(`--rounds must be a whole number, got ${LIMITS.maxRounds}`);
for (const [name, v] of [['--budget-usd', LIMITS.budgetUsd], ['--target-chars', LIMITS.targetChars], ['--max-rewrite-usd', LIMITS.rewriteCapUsd]] as const) {
  if (!(v > 0)) throw new Error(`${name} must be above 0, got ${v}`);
}
if (!(LIMITS.targetHoldout >= 0 && LIMITS.targetHoldout <= 1)) throw new Error(`--target-holdout must be between 0 and 1, got ${LIMITS.targetHoldout}`);
if (Boolean(TRAIN_REPORT) !== Boolean(HOLDOUT_REPORT)) throw new Error('--train-report and --holdout-report go together');

const money = (n: number) => `$${n.toFixed(2)}`;
const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
const score = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));
const readReport = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport;

/** Scores `promptFile` on `cases` with `scripts/prompt-eval.ts` in a child process, writing its report to `out`. */
async function evaluate(promptFile: string, cases: string, out: string): Promise<EvalReport> {
  const args = [TSX_CLI, '--disable-warning=ExperimentalWarning', EVAL_SCRIPT, '--prompt', promptFile, '--cases', cases, '--k', String(K), '--out', out, ...PASS_THROUGH];
  const p = spawnLines(process.execPath, args, { cwd: DAEMON_DIR });
  for await (const line of p.lines) console.log(`  ${line}`);
  const code = await p.exit;
  const file = path.join(out, 'report.json');
  if (code !== 0 || !fs.existsSync(file)) throw new Error(`prompt-eval on ${cases} exited ${code}: ${((p.child as { stderrText?: string } | undefined)?.stderrText ?? '').slice(-500)}`);
  return readReport(file);
}

function writeLoopReport(dir: string, state: LoopState, meta: { runId: string; model: string; effort: string; who: string; probe: string; round0: string; error: string | null }): void {
  const { start, best, bestRound, rounds } = state;
  fs.writeFileSync(path.join(dir, 'loop.json'), JSON.stringify({
    run_id: meta.runId, prompt_file: PROMPT, train_dir: TRAIN, holdout_dir: HOLDOUT, k: K, limits: LIMITS, model: meta.model, effort: meta.effort, account: meta.who,
    probe: meta.probe, round0: { source: meta.round0, chars: start.chars, train: start.train.score, holdout: start.holdout.score, cost: start.train.total_cost + start.holdout.total_cost },
    rounds, spend: state.spend, stop: state.stop, error: meta.error, winner: { round: bestRound, chars: best.chars, train: best.train.score, holdout: best.holdout.score },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'winner.md'), best.text);
  const md = `# Prompt shortening loop ${meta.runId}

Prompt \`${PROMPT}\`. Train \`${TRAIN}\`, holdout \`${HOLDOUT}\`, K=${K}. Rewriter and runs on ${meta.model} (effort ${meta.effort}), ${meta.who}.
Limits: ${LIMITS.maxRounds} rounds, ${money(LIMITS.budgetUsd)} budget, target holdout ≥ ${LIMITS.targetHoldout} at ≤ ${LIMITS.targetChars} characters, ${money(LIMITS.rewriteCapUsd)} per rewriter call.
Probe: ${meta.probe}

| Round | Characters | Train | Holdout | Cost | Duration | Kept | Why |
|---|---|---|---|---|---|---|---|
| 0 | ${start.chars} | ${score(start.train.score)} | ${score(start.holdout.score)} | ${money(start.train.total_cost + start.holdout.total_cost)} | - | start | ${meta.round0} |
${rounds.map((r) => `| ${r.round} | ${r.chars ?? '-'} | ${score(r.train)} | ${score(r.holdout)} | ${money(r.cost)} (rewriter ${money(r.rewrite_cost)}) | ${minutes(r.duration_ms)} | ${r.kept ? 'yes' : 'no'} | ${r.why.replace(/\|/g, '/')} |`).join('\n')}

Spend: ${money(state.spend)} (rewriter, runs and judges of this loop; supplied round-0 reports cost nothing here).
Stop: ${state.stop ?? 'not stopped'}${meta.error ? `\nError: ${meta.error}` : ''}

**Winner: round ${bestRound}**, ${best.chars} characters, train ${score(best.train.score)}, holdout ${score(best.holdout.score)} (\`winner.md\`).
`;
  fs.writeFileSync(path.join(dir, 'report.md'), md);
}

async function main(): Promise<void> {
  const promptText = fs.readFileSync(PROMPT, 'utf8');
  const trainCases = loadCases(TRAIN);
  const holdoutCases = loadCases(HOLDOUT);
  const live = readLive();
  const model = live.settings.model ?? 'the CLI default';
  const effort = live.settings.effort ?? 'default';
  const who = live.account ? `account ${live.account.name} (${live.account.id})` : 'the CLI login';
  const probe = await claudeCall('Reply with the single word ok.', live.settings.model ?? undefined, envUntil(live, Date.now() + TOKEN_MARGIN_MS), PROBE_CAP_USD);
  const probeLine = `claude ${model} on ${who} answered ${JSON.stringify(probe.text.trim())} (${money(probe.cost)})`;
  console.log(`probe: ${probeLine}`);
  if (probe.error || !probe.text.trim()) throw new Error(`the probe did not answer, so the loop does not start: ${probe.error ?? 'blank answer'}`);

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(LIVE.dataDir, 'evidence', 'prompt-evals', `loop-${runId}`);
  const roundDir = (n: number) => path.join(dir, `round-${n}`);
  fs.mkdirSync(roundDir(0), { recursive: true });
  const startFile = path.join(roundDir(0), 'candidate.md');
  fs.writeFileSync(startFile, promptText);
  console.log(`loop on ${PROMPT} (${promptText.length} chars), ${trainCases.length} train and ${holdoutCases.length} holdout cases at K=${K}; output in ${dir}`);

  let train: EvalReport;
  let holdout: EvalReport;
  let round0Spend: number;
  let round0Source: string;
  if (TRAIN_REPORT) {
    train = readReport(path.resolve(TRAIN_REPORT));
    holdout = readReport(path.resolve(HOLDOUT_REPORT));
    checkRound0Report(train, promptText, K, trainCases.map((c) => c.id), 'train');
    checkRound0Report(holdout, promptText, K, holdoutCases.map((c) => c.id), 'holdout');
    round0Spend = probe.cost;
    round0Source = `reports ${path.resolve(TRAIN_REPORT)} and ${path.resolve(HOLDOUT_REPORT)}`;
  } else {
    train = await evaluate(startFile, TRAIN, path.join(roundDir(0), 'train'));
    holdout = await evaluate(startFile, HOLDOUT, path.join(roundDir(0), 'holdout'));
    round0Spend = probe.cost + train.total_cost + holdout.total_cost;
    round0Source = 'scored in this loop';
  }
  fs.writeFileSync(path.join(roundDir(0), 'scores.json'), JSON.stringify({ chars: promptText.length, train: train.score, holdout: holdout.score, source: round0Source }, null, 2));
  console.log(`round 0: ${promptText.length} chars, train ${score(train.score)}, holdout ${score(holdout.score)} (${round0Source})`);
  const start: Scored = { text: promptText, chars: promptText.length, train, holdout };

  const meta = { runId, model, effort, who, probe: probeLine, round0: round0Source, error: null as string | null };
  let last = null as LoopState | null;
  try {
    const state = await runLoop(start, trainCases, LIMITS, { spend: round0Spend, cost: train.total_cost + holdout.total_cost }, {
      rewrite: async (input, n) => {
        fs.mkdirSync(roundDir(n), { recursive: true });
        fs.writeFileSync(path.join(roundDir(n), 'rewriter-input.md'), input);
        console.log(`round ${n}: rewriting (${input.length} chars of input)`);
        const l = readLive();
        const res = await claudeCall(input, l.settings.model ?? undefined, envUntil(l, Date.now() + TOKEN_MARGIN_MS), LIMITS.rewriteCapUsd, { effort: l.settings.effort ?? undefined, evalEnv: true });
        fs.writeFileSync(path.join(roundDir(n), 'rewriter-reply.md'), res.error ? `${res.error}\n\n${res.text}` : res.text);
        return { reply: res.text, cost: res.cost, error: res.error };
      },
      score: async (text, n) => {
        const file = path.join(roundDir(n), 'candidate.md');
        fs.writeFileSync(file, text);
        console.log(`round ${n}: scoring a ${text.length}-char candidate`);
        return { train: await evaluate(file, TRAIN, path.join(roundDir(n), 'train')), holdout: await evaluate(file, HOLDOUT, path.join(roundDir(n), 'holdout')) };
      },
      onProgress: (s) => {
        last = s;
        const r = s.rounds.at(-1);
        if (r && !fs.existsSync(path.join(roundDir(r.round), 'round.json'))) {
          fs.writeFileSync(path.join(roundDir(r.round), 'round.json'), JSON.stringify(r, null, 2));
          console.log(`round ${r.round}: ${r.chars ?? '-'} chars, train ${score(r.train)}, holdout ${score(r.holdout)}, ${money(r.cost)}, ${minutes(r.duration_ms)}, ${r.kept ? 'kept' : 'not kept'}: ${r.why}`);
        }
        writeLoopReport(dir, s, meta);
      },
    });
    console.log(`stop: ${state.stop}; winner round ${state.bestRound}, ${state.best.chars} chars, train ${score(state.best.train.score)}, holdout ${score(state.best.holdout.score)}; spend ${money(state.spend)}; report ${path.join(dir, 'report.md')}`);
  } catch (err) {
    meta.error = err instanceof Error ? err.message : String(err);
    if (last) writeLoopReport(dir, last, meta);
    throw err;
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
