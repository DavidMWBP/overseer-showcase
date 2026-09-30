/**
 * Prompt eval: scores one orchestrator prompt file against a directory of cases, outside the live daemon.
 *
 *   pnpm --filter @overseer/daemon eval:prompt [--prompt <file>] [--cases <dir>] [--k <n>] [--max-run-usd <n>] [--judge-model <model>] [--out <dir>]
 *
 * Defaults: `prompts/orchestrator.md`, `evals/orchestrator/cases/train`, K=3, a $5 cap per orchestrator run, `sonnet` as the judge.
 * The cases are split into `train/` (the default) and `holdout/`; a holdout case is never shown to anything that rewrites a
 * prompt, so `--cases evals/orchestrator/cases/holdout` measures a rewrite on cases it was not written against.
 * Relative paths resolve from the working directory, which pnpm sets to `packages/daemon`.
 *
 * Each case runs K times. A run starts the orchestrator as the daemon does (`SessionManager.start` with `role: 'orchestrator'`,
 * the prompt file as its appended system prompt, the fresh-session preamble rendered from the case's state before the case's
 * input), on a temp database, sessions dir and cwd, with a mock `overseer` MCP server (`src/evals/mockMcp.ts`) that answers
 * from the case's fixtures and records every call. `--strict-mcp-config` loads no other MCP server, `--max-budget-usd` caps
 * the run, and `--no-session-persistence` saves no native session under the user's Claude config, so the run's state stays
 * in its temp dir. The model, effort and account are the live orchestrator's, read from a read-only handle on the live database;
 * the account's environment comes from the plain `accountEnv` (no refresh, so nothing is written). A one-line probe on that
 * account must answer before any run. Exact checks are graded in code; rubric lines by a fresh judge session that sees the
 * transcript and the lines, never the prompt. A case passes a run when the session completed its turn cleanly (`turnProblem`)
 * and every assertion passes; its pass rate is over K runs,
 * and the prompt's score is the mean pass rate. `report.json`, `report.md` and one transcript per run go to
 * `<live data dir>/evidence/prompt-evals/<run id>/`, outside the repository, or to `--out`, which `scripts/prompt-loop.ts` sets
 * to a folder inside its own run's folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { PROMPT_EVAL_TOOLS } from '../src/harness/claude';
import { Bus } from '../src/bus';
import { makeAdapters } from '../src/harness/index';
import { SessionManager } from '../src/sessions/manager';
import { assertNotLiveDb } from '../src/discussions/eval';
import { sessionPreamble } from '../src/orchestrator/orchestrator';
import { overseerToolDefs, startMockMcp } from '../src/evals/mockMcp';
import { evalSessionEnv } from '../src/evals/gitEnv';
import { LIVE, claudeCall, envUntil, readLive, removeClaudeLeftover, removeTemp } from './evalLive';
import {
  checkExact, judgePrompt, loadCases, messagesOf, parseJudge, passRate, promptScore, renderTranscript, runPassed, turnProblem,
  type AssertionResult, type EvalCase, type RecordedCall, type RubricGrade, type TranscriptEvent,
} from '../src/evals/promptEval';

const DAEMON_DIR = fileURLToPath(new URL('..', import.meta.url));
const RUN_TIMEOUT_MS = 15 * 60_000;
const JUDGE_CAP_USD = 1;
const JUDGE_ATTEMPTS = 2;
const PROBE_CAP_USD = 1;

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
const PROMPT = path.resolve(flag('--prompt', path.join(DAEMON_DIR, 'prompts', 'orchestrator.md')));
const CASES = path.resolve(flag('--cases', path.join(DAEMON_DIR, 'evals', 'orchestrator', 'cases', 'train')));
const K = Number(flag('--k', '3'));
const MAX_RUN_USD = Number(flag('--max-run-usd', '5'));
const JUDGE_MODEL = flag('--judge-model', 'sonnet');
const OUT = flag('--out', '');
if (!Number.isInteger(K) || K < 1) throw new Error(`--k must be a whole number of at least 1, got ${K}`);
if (!(MAX_RUN_USD > 0)) throw new Error(`--max-run-usd must be above 0, got ${MAX_RUN_USD}`);

const LIVE_PORTS = [...new Set([LIVE.port, 4400])];

interface RunResult {
  case: string; run: number; passed: boolean; stop: string | null; model: string | null;
  session_cost: number | null; judge_cost: number; cost: number; session_ms: number; judge_ms: number; duration_ms: number;
  assertions: AssertionResult[]; calls: RecordedCall[]; messages: string[]; transcript: string;
}

/** One run of one case: the orchestrator session against the mock, then the exact checks and, when the case has rubric lines, the judge. */
async function runCase(c: EvalCase, n: number, defs: ReturnType<typeof overseerToolDefs>, evidence: string): Promise<RunResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `prompt-eval-${c.id}-${n}-`));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  const config = loadConfig({ ...process.env, OVERSEER_DATA_DIR: path.join(root, 'data') });
  const dbPath = path.join(config.dataDir, 'overseer.db');
  assertNotLiveDb(dbPath, LIVE.dataDir);
  fs.mkdirSync(config.sessionsDir, { recursive: true });
  const db = openDb(dbPath);
  const bus = new Bus();
  const sessions = new SessionManager(db, makeAdapters(config), bus, config.sessionsDir);
  const mock = await startMockMcp(c.fixtures, { livePorts: LIVE_PORTS, defs });
  try {
    const live = readLive();
    const started = Date.now();
    const env = evalSessionEnv(envUntil(live, started + RUN_TIMEOUT_MS), root);
    const row = sessions.start({
      role: 'orchestrator', harness: 'claude', cwd,
      prompt: `${sessionPreamble(c.state.repos, c.state.batches)}\n\n${c.input}`,
      systemPromptFile: PROMPT,
      mcpServers: [{ name: 'overseer', url: mock.url }],
      keepAlive: false,
      model: live.settings.model ?? undefined, effort: live.settings.effort ?? undefined,
      account: live.account?.id ?? null, tokenExpiresAt: live.account?.token_expires_at ?? null, env,
      denyBackground: true, evalSandbox: true, tools: [...PROMPT_EVAL_TOOLS],
      strictMcpConfig: true, maxBudgetUsd: MAX_RUN_USD, noSessionPersistence: true,
    });
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { timedOut = true; void sessions.interrupt(row.id); }, RUN_TIMEOUT_MS);
      const off = bus.on('session:ended', ({ session }) => { if (session.id === row.id) { clearTimeout(timer); off(); resolve(); } });
    });
    const sessionMs = Date.now() - started;
    const ended = db.sessions.get(row.id)!;
    const events: TranscriptEvent[] = db.events.forSession(row.id);
    // Only a clean, completed turn counts; the CLI's stderr tail is added to the reason for diagnosis.
    const problem = turnProblem({ events, status: ended.status, endReason: ended.end_reason ?? null, timedOut });
    const errTail = problem && fs.existsSync(`${ended.log_path}.err`) ? fs.readFileSync(`${ended.log_path}.err`, 'utf8').trim().slice(-300) : '';
    const stop = problem ? [problem, errTail].filter(Boolean).join('; ') : null;
    const transcript = renderTranscript(c.input, events);
    const record = { calls: [...mock.calls], messages: messagesOf(events) };
    const results: AssertionResult[] = c.assertions.flatMap((a) => (a.kind === 'rubric' ? [] : [{ assertion: a, ...checkExact(a, record) }]));
    const rubric = c.assertions.filter((a) => a.kind === 'rubric');
    let judgeCost = 0;
    const judgeStarted = Date.now();
    // A turn that did not complete fails the run whatever the rubric says, so it is not worth a judge session.
    if (rubric.length && problem) {
      for (const a of rubric) results.push({ assertion: a, pass: false, detail: `not graded: ${problem}` });
    } else if (rubric.length) {
      // A judge reply with no readable grades says nothing about the prompt, so it gets a second, fresh session before the lines fail.
      let grades: RubricGrade[] | null = null;
      let why = '';
      for (let attempt = 1; attempt <= JUDGE_ATTEMPTS && !grades; attempt++) {
        const res = await claudeCall(judgePrompt(transcript, rubric.map((r) => r.line)), JUDGE_MODEL, envUntil(readLive(), Date.now() + RUN_TIMEOUT_MS), JUDGE_CAP_USD);
        judgeCost += res.cost;
        try {
          if (res.error) throw new Error(res.error);
          grades = parseJudge(res.text, rubric.length, transcript);
        } catch (err) {
          why = `${err instanceof Error ? err.message : String(err)}; reply ${JSON.stringify(res.text.slice(0, 200))}`;
        }
      }
      const final = grades ?? rubric.map((_, i) => ({ line: i + 1, pass: false, valid: false, quote: '', reason: `the judge gave no usable grade in ${JUDGE_ATTEMPTS} attempts: ${why}`.slice(0, 500) }));
      rubric.forEach((a, i) => results.push({ assertion: a, pass: final[i]!.pass, detail: `${final[i]!.reason}${final[i]!.quote ? ` — "${final[i]!.quote}"` : ''}` }));
    }
    const judgeMs = rubric.length && !problem ? Date.now() - judgeStarted : 0;
    const result: RunResult = {
      case: c.id, run: n, passed: runPassed(problem, results), stop, model: ended.resolved_model ?? ended.model,
      session_cost: ended.cost, judge_cost: judgeCost, cost: (ended.cost ?? 0) + judgeCost, session_ms: sessionMs, judge_ms: judgeMs, duration_ms: sessionMs + judgeMs,
      assertions: results, calls: record.calls, messages: record.messages, transcript,
    };
    const file = path.join(evidence, 'runs', `${c.id}-${n}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${c.id} run ${n}: ${result.passed ? 'PASS' : 'FAIL'}${stop ? ` (${stop})` : ''}\n\n${results.map((r) => `- ${r.pass ? 'pass' : 'FAIL'} ${r.assertion.kind === 'rubric' ? `rubric: ${r.assertion.line}` : JSON.stringify(r.assertion)}: ${r.detail}`).join('\n')}\n\n## Transcript\n\n${transcript}\n`);
    return result;
  } finally {
    await mock.close();
    db.sql.close();
    removeClaudeLeftover(cwd);
    removeTemp(root);
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;
const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

function writeReport(evidence: string, report: Record<string, unknown> & { cases: { id: string; entry: string; pass_rate: number | null; runs: RunResult[] }[]; score: number | null; total_cost: number; total_duration_ms: number }): void {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  const runs = report.cases.flatMap((c) => c.runs);
  const md = `# Prompt eval ${String(report.run_id)}

Prompt \`${String(report.prompt_file)}\`, ${String(report.prompt_chars)} characters. Model ${String(report.model)}, effort ${String(report.effort)}. Judge ${JUDGE_MODEL}. K=${K}.
Probe: ${String(report.probe)}

**Score: ${report.score === null ? 'n/a' : report.score.toFixed(2)}** (mean case pass rate, ${report.cases.length} cases)

| Case | Pass rate | Runs | Cost | Duration |
|---|---|---|---|---|
${report.cases.map((c) => `| ${c.id} | ${c.runs.filter((r) => r.passed).length}/${c.runs.length} (${c.pass_rate === null ? 'n/a' : c.pass_rate.toFixed(2)}) | ${c.runs.map((r) => (r.passed ? 'pass' : 'FAIL')).join(', ')} | ${money(c.runs.reduce((s, r) => s + r.cost, 0))} | ${minutes(c.runs.reduce((s, r) => s + r.duration_ms, 0))} |`).join('\n')}

Total: ${money(report.total_cost)} (the probe included) over ${runs.length} runs, ${minutes(report.total_duration_ms)} of runs.

## Runs

| Run | Result | Cost (session + judge) | Duration | Failed checks |
|---|---|---|---|---|
${runs.map((r) => `| ${r.case} #${r.run} | ${r.passed ? 'pass' : 'FAIL'}${r.stop ? ` (${r.stop.replace(/\|/g, '/').slice(0, 120)})` : ''} | ${r.session_cost === null ? 'unknown' : money(r.session_cost)} + ${money(r.judge_cost)} | ${minutes(r.duration_ms)} | ${r.assertions.filter((a) => !a.pass).map((a) => `${a.assertion.kind}: ${a.detail}`.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)).join('<br>') || '-'} |`).join('\n')}
`;
  fs.writeFileSync(path.join(evidence, 'report.md'), md);
}

async function main(): Promise<void> {
  const cases = loadCases(CASES);
  const promptText = fs.readFileSync(PROMPT, 'utf8');
  const defs = overseerToolDefs();
  const live = readLive();
  const model = live.settings.model ?? 'the CLI default';
  const who = live.account ? `account ${live.account.name} (${live.account.id})` : 'the CLI login';
  const probe = await claudeCall('Reply with the single word ok.', live.settings.model ?? undefined, envUntil(live, Date.now() + RUN_TIMEOUT_MS), PROBE_CAP_USD);
  const probeLine = `claude ${model} on ${who} answered ${JSON.stringify(probe.text.trim())} (${money(probe.cost)})`;
  console.log(`probe: ${probeLine}`);
  if (probe.error || !probe.text.trim()) throw new Error(`the probe did not answer, so no case runs: ${probe.error ?? 'blank answer'}`);

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${path.basename(PROMPT, path.extname(PROMPT))}`;
  const evidence = OUT ? path.resolve(OUT) : path.join(LIVE.dataDir, 'evidence', 'prompt-evals', runId);
  fs.mkdirSync(evidence, { recursive: true });
  console.log(`prompt ${PROMPT} (${promptText.length} chars), ${cases.length} cases at K=${K}, model ${model} (effort ${live.settings.effort ?? 'default'}) on ${who}, judge ${JUDGE_MODEL}; report in ${evidence}`);

  const started = Date.now();
  const results: { id: string; entry: string; pass_rate: number | null; runs: RunResult[] }[] = [];
  const save = () => {
    const rates = results.filter((c) => c.runs.length === K).map((c) => c.pass_rate ?? 0);
    const total = results.flatMap((c) => c.runs);
    writeReport(evidence, {
      run_id: runId, prompt_file: PROMPT, prompt_chars: promptText.length, model, effort: live.settings.effort ?? 'default', account: who,
      judge_model: JUDGE_MODEL, k: K, max_run_usd: MAX_RUN_USD, probe: probeLine, started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(),
      complete: rates.length === cases.length, score: promptScore(rates),
      total_cost: probe.cost + total.reduce((s, r) => s + r.cost, 0), total_duration_ms: total.reduce((s, r) => s + r.duration_ms, 0),
      cases: results,
    });
  };
  for (const c of cases) {
    const entry = { id: c.id, entry: c.source.entry, pass_rate: null as number | null, runs: [] as RunResult[] };
    results.push(entry);
    for (let n = 1; n <= K; n++) {
      const r = await runCase(c, n, defs, evidence);
      entry.runs.push(r);
      entry.pass_rate = passRate(entry.runs.map((x) => x.passed));
      console.log(`${c.id} #${n}: ${r.passed ? 'pass' : 'FAIL'}${r.stop ? ` (${r.stop})` : ''}, ${money(r.cost)}, ${minutes(r.duration_ms)}${r.passed ? '' : `; failed: ${r.assertions.filter((a) => !a.pass).map((a) => a.assertion.kind === 'rubric' ? 'rubric' : `${a.assertion.kind} (${a.detail})`).join(', ')}`}`);
      save();
    }
    console.log(`${c.id}: pass rate ${entry.pass_rate!.toFixed(2)}`);
  }
  const report = JSON.parse(fs.readFileSync(path.join(evidence, 'report.json'), 'utf8')) as { score: number | null; total_cost: number; total_duration_ms: number };
  console.log(`score ${report.score === null ? 'n/a' : report.score.toFixed(2)}; total ${money(report.total_cost)} (probe included), ${minutes(report.total_duration_ms)} of runs; report ${path.join(evidence, 'report.md')}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
