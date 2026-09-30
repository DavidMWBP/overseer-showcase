/**
 * Discussions eval: is a 3-model discussion worth it? Runs one question three ways on the discussion runner, outside the
 * live daemon, on a temp database, then has a fresh claude session score the three answers blind against a rubric.
 *
 *   tsx scripts/discussion-eval.ts setup        # inputs under %TEMP%/disc-eval, leak guard
 *   tsx scripts/discussion-eval.ts run A|B|C    # one run, written to <evidence>/run-<X>.json and .md
 *   tsx scripts/discussion-eval.ts score        # blind scoring, <evidence>/score.json
 *   tsx scripts/discussion-eval.ts report       # <evidence>/report.md
 *
 *   tsx scripts/discussion-eval.ts probe        # one-line opencode answer on the chosen opencode account, before run C
 *
 * `--tier <name>` (default `standard`) runs every participant on that tier's candidate for its harness, read from the live
 * tier settings, and writes every file with a `<tier>-` prefix (none for `standard`), so the standard results stay. A
 * candidate that names an account gets that account's environment through the plain `accountEnv`, read-only: nothing is
 * refreshed or written in the live DB. Run B's critique takes the `critic` tier's codex candidate (else `hard`'s). Scoring
 * runs SCORE_PASSES fresh blind sessions, each reshuffled, and the report takes the majority per fact and the mean total.
 * The opencode account run C and the probe get is chosen without an install-specific id in this file: `--opencode-account
 * <id>` names it, and without the flag the one opencode account the live DB holds is used, while none or several stop
 * before any harness starts. A flag rather than an `OVERSEER_` environment variable, which `ownLoginEnv` deletes first.
 *
 * A: claude alone, one round of the runner, no synthesis. B: a sequential driver on the sessions layer the runner uses,
 * three turns: claude answers, a separate codex session critiques that answer only, the same claude session revises; the
 * revision is the output. C: claude, codex and opencode through the runner with the defaults (3 rounds, $5 cap) and the
 * synthesis. claude and codex run on their own logins. opencode's own login has no provider, so run C and the probe take
 * the environment of a live opencode account through `accountEnv`, read from a read-only handle on the live database: the
 * `--opencode-account <id>` it names, else the one opencode account the live DB holds (none stops with what to pass or
 * create, two or more need the flag).
 *
 * `--case <name> --question-file <path> --repo-ref <sha>` swaps the token case for an open question: the repo is a standalone
 * copy of `<sha>` under %TEMP%/disc-eval-<name>, no logs are copied, every file takes the `<name>-` prefix, and `score` has no
 * answer key, so it extracts each output's proposals, validates each one alone against the code, pools duplicates across the
 * runs and has three judges rank the shuffled outputs. Without the flags the token case runs as before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { HarnessName, SessionRow, TierCandidate, TierSettings } from '@overseer/shared';
import { loadConfig } from '../src/config';
import { openDb, type StoredAccount } from '../src/db/db';
import { Bus } from '../src/bus';
import { makeAdapters } from '../src/harness/index';
import { SessionManager } from '../src/sessions/manager';
import { PriceCatalog } from '../src/pricing/catalog';
import { accountEnv } from '../src/accounts/env';
import { render } from '../src/lifecycle/prompt';
import { Discussions, sessionCost } from '../src/discussions/discussions';
import { applyEnv, assertNotLiveDb, beginScoring, blindKey, candidateEnv, critiqueCandidate, isSpendFile, leakHits, majorityQuote, majorityRank, majorityScores, openKeep, poolProposals, sessionCaps, takeCase, tierCandidates, verdictBlockers, type FactScore } from '../src/discussions/eval';
import { chooseOpencodeAccount } from '../src/discussions/opencodeAccount';

const argv = process.argv.slice(2);
/** The open-question case from `--case`, `--question-file` and `--repo-ref`; null for the token case. */
const CASE = takeCase(argv, (file) => fs.readFileSync(file, 'utf8'));
const BASE = path.join(os.tmpdir(), CASE ? `disc-eval-${CASE.name}` : 'disc-eval');
const REPO = path.join(BASE, 'repo');
const LOGS = path.join(BASE, 'logs');
const EVIDENCE = path.join(os.homedir(), '.overseer', 'evidence', 'discussions-eval');
const LIVE = path.join(os.homedir(), '.overseer');
const FIX_BASE = '250bf2c';
const LOG_CUTOFF = '2026-09-23T09:49:29Z';
const SESSION_LOG = '7ca5b85d-2db9-4ac2-bba6-a2a3b7b50524.log';
/** The commit the eval repo is checked out at. */
const REPO_REF = CASE?.repoRef ?? FIX_BASE;
const tierAt = argv.indexOf('--tier');
const TIER = tierAt >= 0 ? argv.splice(tierAt, 2)[1] ?? '' : 'standard';
if (!TIER) throw new Error('--tier needs a tier name');
/** File prefix for this tier's results: none for the standard tier, whose files predate the option; a case's name for a case. */
const PREFIX = CASE ? `${CASE.name}-` : TIER === 'standard' ? '' : `${TIER}-`;
const BUDGET = PREFIX ? 40 : 20;
const SCORE_PASSES = 3;
const RUN_DEADLINE_MS = 90 * 60_000;
const RUNS = ['A', 'B', 'C'] as const;
type Run = (typeof RUNS)[number];

/** The account `--opencode-account <id>` names (empty/absent means let the live DB's opencode accounts decide); spliced from argv. */
const OPENCODE_ACCOUNT_ID = (() => {
  const at = argv.indexOf('--opencode-account');
  return at < 0 ? undefined : argv.splice(at, 2)[1] ?? '';
})();
/** The live standard tier's opencode model, with its effort `medium` (which passes no `--variant` for this model). */
const OPENCODE_MODEL = 'deepseek/deepseek-flash';
/** The standard tier as the first eval ran it; any other `--tier` is read from the live settings. */
const STANDARD_TIERS: TierSettings = {
  tiers: [{ name: 'standard', candidates: [
    { harness: 'claude', model: 'sonnet', effort: null },
    { harness: 'codex', model: 'gpt-5.6-terra', effort: null },
    { harness: 'opencode', model: OPENCODE_MODEL, effort: 'medium' },
  ] }],
  denyModels: [],
};

const QUESTION = CASE ? `${CASE.question}

You have read access to a checkout of the Overseer repository at ${REPO}. Read only inside it; do not read anything else on this machine, including ~/.overseer.` : `Claude sessions in Overseer keep failing with "401 OAuth access token has been revoked/expired". Find the cause and design a fix.

You have read access to a checkout of the Overseer repository at ${REPO} and to the daemon's logs from before the problem was fixed at ${LOGS} (daemon.log, and ${SESSION_LOG}, the orchestrator session that hit the 401s). Read only inside ${BASE}; do not read anything else on this machine, including ~/.overseer.`;

const FACTS = [
  'Claude OAuth access tokens last 8 hours.',
  'Each session gets a fixed copy of the token at spawn (CLAUDE_CODE_OAUTH_TOKEN) that is never updated.',
  'The daemon refreshes only within 5 minutes of expiry, so a session can start on a token with minutes left.',
  'A refresh revokes the access token that running sessions still hold.',
  'Matching "401" in a session\'s own final text parks healthy accounts (false positives).',
  'A user or orchestrator stop must win over an automatic resume.',
  'The one-resume limit must survive a daemon restart.',
  'A failure on the first turn has no native session id yet, so it can\'t resume without one recorded at spawn.',
  'Restarting a process for a fresh token kills pending turns unless it waits for the turn to end or replays it.',
];

interface SessionCost { harness: HarnessName; kind: string; model: string; cost: number; source: string }
interface RunResult {
  run: Run; discussion_id: string; status: string; stop_reason: string | null; output: string;
  started_at: string; ended_at: string; wall_ms: number; cost: number; cost_basis: string; rounds: number;
  sessions: SessionCost[]; turns: { round: number; harness: string; text: string }[];
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const runFile = (run: Run, prefix = PREFIX) => path.join(EVIDENCE, `${prefix}run-${run}.json`);

/** What this tier's finished runs and scoring have spent so far. */
function spent(): number {
  let total = 0;
  for (const name of fs.existsSync(EVIDENCE) ? fs.readdirSync(EVIDENCE) : []) {
    if (isSpendFile(name, PREFIX)) total += readJson<{ cost: number }>(path.join(EVIDENCE, name)).cost;
  }
  return total;
}

/** Keeps an earlier attempt's file as `attempt<n>-<name>` (the next free n), so its spend still counts and nothing is overwritten. */
function archiveAttempt(name: string): void {
  const file = path.join(EVIDENCE, name);
  if (!fs.existsSync(file)) return;
  let n = 1;
  while (fs.existsSync(path.join(EVIDENCE, `attempt${n}-${name}`))) n++;
  fs.renameSync(file, path.join(EVIDENCE, `attempt${n}-${name}`));
  console.log(`kept the earlier ${name} as attempt${n}-${name}`);
}

/** Reads the live tier settings and the given account rows from a read-only handle: nothing is written to the live DB. */
function readLive(accountIds: string[] = []): { tiers: TierSettings; accounts: Map<string, StoredAccount> } {
  const live = new DatabaseSync(path.join(LIVE, 'overseer.db'), { readOnly: true });
  try {
    const row = live.prepare("SELECT value FROM settings WHERE key='tiers'").get() as { value: string } | undefined;
    if (!row) throw new Error('the live DB has no tier settings');
    const accounts = new Map<string, StoredAccount>();
    for (const id of accountIds) {
      const a = live.prepare('SELECT * FROM accounts WHERE id=?').get(id) as unknown as StoredAccount | undefined;
      if (!a) throw new Error(`live account ${id} is missing`);
      accounts.set(id, a);
    }
    return { tiers: JSON.parse(row.value) as TierSettings, accounts };
  } finally {
    live.close();
  }
}

/**
 * This tier's candidates for `harnesses`, with the environment of each account a candidate names merged into this process,
 * so every session inherits it. A Claude OAuth token that would expire inside the run's deadline stops the run: refreshing
 * it here would write the live DB and revoke the token the live install holds.
 */
function tierSetup(harnesses: HarnessName[]): Map<HarnessName, TierCandidate> {
  const picked = tierCandidates(TIER === 'standard' ? STANDARD_TIERS : readLive().tiers, TIER, harnesses);
  const ids = [...new Set([...picked.values()].map((c) => c.account).filter((a): a is string => !!a))];
  const { accounts } = readLive(ids);
  for (const [h, c] of picked) useCandidateEnv(c, accounts, `tier ${TIER}: ${h}`);
  return picked;
}

/** Puts a candidate's account environment into this process, so the next session started inherits it, and logs the pick. */
function useCandidateEnv(c: TierCandidate, accounts: ReadonlyMap<string, StoredAccount>, label: string): void {
  applyEnv(process.env, candidateEnv(c, accounts, Date.now() + RUN_DEADLINE_MS));
  console.log(`${label} on ${c.model}${c.effort ? ` (${c.effort})` : ''}, ${c.account ? `account ${c.account}` : 'its own login'}`);
}

function setup(): void {
  const sourceRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (fs.existsSync(BASE)) throw new Error(`${BASE} already exists; remove it (and \`git worktree prune\`) before a fresh setup`);
  fs.mkdirSync(CASE ? BASE : LOGS, { recursive: true });
  // A standalone repository holding only the fix base's history: a worktree of the source repo would share its object store
  // and refs, so `git log --all` inside it shows the fix commits (the leak that contaminated an earlier run C).
  const sha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', REPO_REF], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', REPO]);
  execFileSync('git', ['-C', REPO, 'fetch', '-q', '--no-tags', sourceRoot, sha], { stdio: 'inherit' });
  execFileSync('git', ['-C', REPO, 'checkout', '-q', '--detach', sha], { stdio: 'inherit' });
  const count = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, 'rev-list', '--count', ...args], { encoding: 'utf8' }).trim();
  const reachable = count(REPO, '--all');
  if (reachable !== count(sourceRoot, sha)) throw new Error(`leak guard: the eval repo reaches ${reachable} commits, not only the ${count(sourceRoot, sha)} of ${REPO_REF}`);
  console.log(`leak guard: the eval repo reaches ${reachable} commits, all of them ${REPO_REF}'s history`);
  if (CASE) {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    console.log(`case ${CASE.name}: repo at ${REPO_REF}: ${REPO}`);
    return;
  }
  const cutoff = Date.parse(LOG_CUTOFF);
  const kept = fs.readFileSync(path.join(LIVE, 'daemon.log'), 'utf8').split(/\r?\n/).filter((line) => {
    try { return Date.parse((JSON.parse(line) as { ts: string }).ts) < cutoff; } catch { return false; }
  });
  fs.writeFileSync(path.join(LOGS, 'daemon.log'), kept.join('\n') + '\n');
  fs.copyFileSync(path.join(LIVE, 'sessions', SESSION_LOG), path.join(LOGS, SESSION_LOG));
  for (const name of fs.readdirSync(LOGS)) {
    const hits = leakHits(fs.readFileSync(path.join(LOGS, name), 'utf8'));
    if (hits.length) throw new Error(`leak guard: ${name} carries ${hits.join(', ')}`);
    console.log(`leak guard: ${name} clean (${fs.statSync(path.join(LOGS, name)).size} bytes)`);
  }
  console.log(`daemon.log kept ${kept.length} lines before ${LOG_CUTOFF}; repo at ${FIX_BASE}: ${REPO}`);
  fs.mkdirSync(EVIDENCE, { recursive: true });
}

/** Drops the calling session's own Claude variables, so each CLI starts on its own login rather than a nested session's. */
function ownLoginEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(CLAUDE|CLAUDECODE|ANTHROPIC_API_KEY|CODEX_HOME|OPENCODE_CONFIG|OVERSEER_)/.test(key)) delete process.env[key];
  }
}

/** The chosen opencode account's environment through the plain `accountEnv` (no refresh), from a read-only handle: nothing is written to the live DB. */
function liveOpencodeEnv(): NodeJS.ProcessEnv {
  const live = new DatabaseSync(path.join(LIVE, 'overseer.db'), { readOnly: true });
  try {
    const rows = live.prepare('SELECT * FROM accounts').all() as unknown as StoredAccount[];
    return accountEnv(chooseOpencodeAccount(rows, OPENCODE_ACCOUNT_ID));
  } finally {
    live.close();
  }
}

/** One-line opencode answer on the chosen opencode account; exits 1 when the answer is blank. */
function probe(): void {
  ownLoginEnv();
  Object.assign(process.env, liveOpencodeEnv());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-eval-probe-'));
  const res = spawnSync('opencode', ['run', '-m', OPENCODE_MODEL, '"Reply with the single word ok."'], { cwd, encoding: 'utf8', timeout: 5 * 60_000, shell: true });
  const answer = (res.stdout ?? '').trim();
  console.log(`opencode probe: exit ${res.status}, answer ${JSON.stringify(answer.slice(0, 200))}, stderr ${JSON.stringify((res.stderr ?? '').trim().slice(-300))}`);
  if (res.status !== 0 || !answer) process.exitCode = 1;
}

/** Opens the eval temp DB and the sessions layer for one run, failing closed on the live database path. */
function openRun(which: Run) {
  const dataDir = path.join(os.tmpdir(), 'disc-eval-data', which);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const config = loadConfig({ ...process.env, OVERSEER_DATA_DIR: dataDir });
  const dbPath = path.join(config.dataDir, 'overseer.db');
  assertNotLiveDb(dbPath, LIVE);
  const db = openDb(dbPath);
  const bus = new Bus();
  const prices = new PriceCatalog(path.join(dataDir, 'models.dev.json'));
  prices.start();
  const sessions = new SessionManager(db, makeAdapters(config), bus, config.sessionsDir, prices);
  return { dataDir, config, db, bus, prices, sessions };
}

const costsOf = (rows: SessionRow[]): SessionCost[] => rows.map((s) => ({
  harness: s.harness, kind: s.discussion_kind ?? 'participant', model: s.resolved_model ?? s.model ?? '', cost: sessionCost(s),
  source: s.cost != null ? 'reported' : s.estimated_cost != null ? 'estimated' : 'unknown',
}));
const basisOf = (costs: SessionCost[]): string => [...new Set(costs.map((s) => `${s.harness}:${s.source}`))].join(', ');

function writeRun(result: RunResult): void {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  // A rerun keeps the earlier attempt, whose spend still counts against the budget.
  for (const ext of ['json', 'md']) archiveAttempt(`${PREFIX}run-${result.run}.${ext}`);
  fs.writeFileSync(runFile(result.run), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}run-${result.run}.md`), `# Run ${result.run} (${result.status}${result.stop_reason ? `: ${result.stop_reason}` : ''})\n\n${result.output}\n\n---\n\n${result.turns.map((t) => `## turn ${t.round} · ${t.harness}\n\n${t.text}`).join('\n\n')}\n`);
  console.log(`run ${result.run}: ${result.status} (${result.stop_reason ?? '-'}), ${result.rounds} rounds, ${(result.wall_ms / 60_000).toFixed(1)} min, $${result.cost.toFixed(2)} [${result.cost_basis}], output ${result.output.length} chars`);
}

const CRITIQUE_PROMPT = `You are reviewing another model's answer to a question. The question is:

{{question}}

You run in your own throwaway git worktree, detached at the selected base commit. Every participant reads the same commit. You may read and search the repository and the web, and run read-only commands. Never edit or create files, never commit, never switch branches and never push: anything you write here is thrown away, and the repository itself must not be touched.

The answer to review follows, verbatim.

{{answer}}

Write a critique only: what in the answer is wrong, unsupported by the code or the logs, or missing, with the evidence for each point. Do not write your own full answer.`;

const REVISE_PROMPT = `A reviewer read your answer and wrote this critique, verbatim:

{{critique}}

Check each point against the repository and the logs, then write your revised answer in full. The same rules apply: read only, never edit, commit, switch branches or push.`;

/**
 * Run B, three turns in order on the sessions layer the runner uses: a claude session answers the round-1 discussion
 * prompt, a separate codex session critiques that answer, and the same claude session revises. Each session runs in its
 * own detached worktree at the selected `REPO_REF`, as a runner participant does.
 */
async function runB(): Promise<void> {
  const claudeCandidate = tierSetup(['claude']).get('claude')!;
  const { dataDir, config, db, bus, prices, sessions } = openRun('B');
  const started = Date.now();
  const deadline = started + RUN_DEADLINE_MS;
  const cwdFor = (harness: HarnessName): string => {
    const dir = path.join(dataDir, 'worktrees', harness);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, REPO_REF], { stdio: 'ignore' });
    return dir;
  };
  /** Resolves with this turn's text (after the session's latest prompt) once the session ends a turn or exits. */
  const turn = (sessionId: string) => new Promise<string>((resolve, reject) => {
    const read = (): string => {
      const since = db.events.lastOfType(sessionId, 'message')?.seq ?? 0;
      return (db.events.lastOfTypeAfter(sessionId, 'assistant_text', since)?.payload as { text?: string } | undefined)?.text?.trim() ?? '';
    };
    const unsubscribe: Array<() => void> = [];
    const off = () => { for (const u of unsubscribe.splice(0)) u(); };
    const timer = setTimeout(() => { off(); reject(new Error(`run B: no turn end from ${sessionId} before the deadline`)); }, Math.max(0, deadline - Date.now()));
    const done = () => { clearTimeout(timer); off(); setImmediate(() => resolve(read())); };
    unsubscribe.push(bus.on('event', (e) => { if (e.session_id === sessionId && e.type === 'turn_end') done(); }));
    unsubscribe.push(bus.on('session:ended', ({ session }) => { if (session.id === sessionId) done(); }));
  });
  const template = fs.readFileSync(path.join(config.promptsDir, 'discussion.md'), 'utf8');
  const start = (harness: HarnessName, c: TierCandidate, prompt: string): SessionRow =>
    sessions.start({ role: 'discussion', harness, model: c.model, effort: c.effort ?? undefined, cwd: cwdFor(harness), prompt, keepAlive: true });
  const turns: RunResult['turns'] = [];
  const log = (msg: string) => console.log(`run B: ${new Date().toISOString()} ${msg}`);

  const critic = TIER === 'standard'
    ? { candidate: tierCandidates(STANDARD_TIERS, 'standard', ['codex']).get('codex')!, note: 'standard tier codex candidate' }
    : critiqueCandidate(readLive().tiers);
  // Read (and checked) before any session starts, so a missing or expiring account stops the run before it spends anything.
  const criticAccounts = readLive(critic.candidate.account ? [critic.candidate.account] : []).accounts;
  candidateEnv(critic.candidate, criticAccounts, deadline);
  log(`critique on codex ${critic.candidate.model} (${critic.note})`);
  const claude = start('claude', claudeCandidate, render(template, { question: QUESTION, round1: '1' }));
  const answer = await turn(claude.id);
  turns.push({ round: 1, harness: 'claude', text: answer });
  log(`claude answered (${answer.length} chars)`);
  let critique = '';
  let revision = '';
  if (answer) {
    useCandidateEnv(critic.candidate, criticAccounts, 'run B: critique codex');
    const codex = start('codex', critic.candidate, render(CRITIQUE_PROMPT, { question: QUESTION, answer: `### claude\n${answer}` }));
    critique = await turn(codex.id);
    turns.push({ round: 2, harness: 'codex', text: critique });
    log(`codex critiqued (${critique.length} chars)`);
    if (sessions.isLive(codex.id)) await sessions.end(codex.id).catch(() => undefined);
    if (critique && sessions.isLive(claude.id)) {
      const revised = turn(claude.id);
      await sessions.send(claude.id, render(REVISE_PROMPT, { critique }));
      revision = await revised;
      turns.push({ round: 3, harness: 'claude', text: revision });
      log(`claude revised (${revision.length} chars)`);
    }
  }
  if (sessions.isLive(claude.id)) await sessions.end(claude.id).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // let the session ends write their cost
  const ended = Date.now();
  const sessionCosts = costsOf(db.sessions.all());
  writeRun({
    run: 'B', discussion_id: '', status: revision ? 'done' : 'failed',
    stop_reason: revision ? null : !answer ? 'claude gave no answer' : !critique ? 'codex gave no critique' : 'claude gave no revision',
    output: revision, started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString(), wall_ms: ended - started,
    cost: sessionCosts.reduce((sum, c) => sum + c.cost, 0), cost_basis: basisOf(sessionCosts), rounds: turns.length, sessions: sessionCosts, turns,
  });
  for (const h of ['claude', 'codex']) spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', path.join(dataDir, 'worktrees', h)]);
  prices.stop();
  db.sql.close();
  if (!revision) process.exitCode = 1;
}

async function run(which: Run): Promise<void> {
  if (!fs.existsSync(REPO)) throw new Error('run `setup` first');
  if (spent() >= BUDGET) throw new Error(`budget: $${spent().toFixed(2)} already spent of $${BUDGET}`);
  ownLoginEnv();
  if (which === 'B') return runB();
  const participants: HarnessName[] = which === 'A' ? ['claude'] : ['claude', 'codex', 'opencode'];
  const picked = tierSetup(participants);
  if (TIER === 'standard' && which === 'C') Object.assign(process.env, liveOpencodeEnv());
  const { config, db, bus, prices, sessions } = openRun(which);
  // The runner reads the temp DB's standard tier. Each account's environment is already in this process and the temp DB
  // holds no accounts, so the candidates go in without them.
  db.settings.set('tiers', { tiers: [{ name: 'standard', candidates: [...picked.values()].map(({ account: _account, ...c }) => c) }], denyModels: [] } satisfies TierSettings);
  // The eval checkout is the discussion's repo, so each participant gets its own detached worktree at `REPO_REF`: codex refuses a
  // cwd outside a git repository ("Not inside a trusted directory"), which the runner's no-repo temp directory is.
  db.repos.insert({ id: 'eval', path: REPO, base_branch: REPO_REF, verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0 });
  const discussions = new Discussions({ db, sessions, bus, config });

  let id = '';
  let stopRequested = false;
  // A ends on this script's rule, not the runner's: the bus is synchronous, so a Stop called from the turn's own
  // `discussion` ping lands before the runner decides the next round.
  bus.on('discussion', ({ id: pinged }) => {
    if (which !== 'A' || stopRequested || pinged !== id) return;
    if (!db.discussions.turns(id).some((t) => t.harness === 'claude')) return;
    stopRequested = true;
    void discussions.stop(id, 'eval run complete');
  });

  const started = Date.now();
  const detail = await discussions.create({ question: QUESTION, participants, repoId: 'eval' });
  id = detail.id;
  console.log(`run ${which}: discussion ${id} started with ${participants.join(', ')}`);
  let last = '';
  while (Date.now() - started < RUN_DEADLINE_MS) {
    const row = db.discussions.get(id)!;
    const turns = db.discussions.turns(id);
    const line = `${row.status} turns=${turns.map((t) => `${t.harness}@${t.round}`).join(',')} cost=$${discussions.detail(id)!.cost.toFixed(2)}`;
    if (line !== last) { console.log(`run ${which}: ${new Date().toISOString()} ${line}`); last = line; }
    if (row.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (db.discussions.get(id)!.status === 'running') await discussions.stop(id, 'eval deadline');
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // let the last session ends write their cost
  const ended = Date.now();
  const final = discussions.detail(id)!;
  const sessionCosts = costsOf(db.sessions.forDiscussion(id));
  const claudeTurns = final.turns.filter((t) => t.harness === 'claude').sort((a, b) => a.round - b.round);
  const output = which === 'C' ? final.synthesis ?? '' : claudeTurns.at(-1)?.text ?? '';
  // A three-model run needs a turn from every participant: a synthesis over fewer answers is not run C.
  const missing = participants.filter((h) => !final.turns.some((t) => t.harness === h));
  writeRun({
    run: which, discussion_id: id, status: missing.length ? 'incomplete' : final.status,
    stop_reason: missing.length ? `no answer from ${missing.join(', ')}${final.stop_reason ? `; ${final.stop_reason}` : ''}` : final.stop_reason, output,
    started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString(), wall_ms: ended - started,
    cost: final.cost, cost_basis: basisOf(sessionCosts),
    rounds: Math.max(0, ...final.turns.map((t) => t.round)), sessions: sessionCosts,
    turns: final.turns.map((t) => ({ round: t.round, harness: t.harness, text: t.text })),
  });
  prices.stop();
  db.sql.close();
  if (!output || missing.length) process.exitCode = 1;
}

interface ScorePass { cost: number; key: Record<string, string>; scores: Record<string, FactScore[]>; raw: string }
/** A score file: SCORE_PASSES blind passes; the first eval's file is a single pass at the top level. */
interface Scores { cost: number; passes: ScorePass[] }
const readScores = (prefix: string): Scores => {
  const s = readJson<Scores | ScorePass>(path.join(EVIDENCE, `${prefix}score.json`));
  return 'passes' in s ? s : { cost: s.cost, passes: [s] };
};

function scorePrompt(key: Record<string, string>, byRun: Map<Run, string>): string {
  return `You are scoring three answers to the same question against a rubric of 9 facts. Score each answer on its own.

For each answer and each fact, give 1 if the answer states the fact (in any wording, as part of its diagnosis or its fix), else 0. For every 1, quote the sentence from that answer that earns it, verbatim. For a 0, the quote is "".

Reply with JSON only, no prose and no code fence, in this shape:
{"X":[{"fact":1,"score":0,"quote":""}, ... 9 entries],"Y":[...],"Z":[...]}

## Facts
${FACTS.map((f, i) => `${i + 1}. ${f}`).join('\n')}

${Object.entries(key).map(([label, r]) => `## Answer ${label}\n\n${byRun.get(r as Run)}`).join('\n\n')}
`;
}

/**
 * SCORE_PASSES blind scoring sessions, each a fresh claude process on a freshly shuffled key. An earlier score file is kept
 * as an attempt, so its spend still counts. The file is saved after every pass (a failed pass's cost included), so a stop
 * at the budget or on a failure leaves the passes done so far for the report.
 */
function score(): void {
  const results = RUNS.map((r) => readJson<RunResult>(runFile(r)));
  ownLoginEnv();
  beginScoring(spent(), BUDGET, () => archiveAttempt(`${PREFIX}score.json`));
  // Read once, before this file exists: spent() would otherwise count the passes saved below a second time.
  const before = spent();
  const byRun = new Map(results.map((r) => [r.run, r.output]));
  const passes: ScorePass[] = [];
  let failedCost = 0;
  const cost = () => passes.reduce((sum, p) => sum + p.cost, 0) + failedCost;
  const save = () => fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}score.json`), JSON.stringify({ cost: cost(), passes } satisfies Scores, null, 2));
  for (let i = 0; i < SCORE_PASSES; i++) {
    if (before + cost() >= BUDGET) throw new Error(`budget: $${(before + cost()).toFixed(2)} spent of $${BUDGET} after ${passes.length} scoring passes`);
    const key = blindKey(RUNS);
    const prompt = scorePrompt(key, byRun);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-eval-score-'));
    const res = spawnSync(process.platform === 'win32' ? 'claude.exe' : 'claude', ['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', ''], { cwd, input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
    if (res.status !== 0) throw new Error(`scoring session ${i + 1} failed (${res.status}): ${res.stderr || res.stdout}`);
    const out = JSON.parse(res.stdout) as { result: string; total_cost_usd?: number };
    const text = out.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    let scores: ScorePass['scores'];
    try {
      scores = JSON.parse(text) as ScorePass['scores'];
    } catch (err) {
      failedCost += out.total_cost_usd ?? 0;
      save();
      throw new Error(`scoring pass ${i + 1} answered no JSON: ${String(err)}`);
    }
    passes.push({ cost: out.total_cost_usd ?? 0, key, scores, raw: out.result });
    save();
    fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}score-prompt-${i + 1}.md`), prompt);
    console.log(`scoring pass ${i + 1}: key ${JSON.stringify(key)}, cost $${passes.at(-1)!.cost.toFixed(2)}`);
  }
}

/**
 * One tier's results so far: each finished run's row and, once scored, the majority per fact and the mean total with its
 * range over every saved scoring pass. A run not yet written is absent, and `s` is null before any pass was saved.
 */
function tierResults(prefix: string) {
  const scoreFile = path.join(EVIDENCE, `${prefix}score.json`);
  const s = fs.existsSync(scoreFile) ? readScores(prefix) : null;
  const runs = new Map<Run, { x: RunResult; passes: FactScore[][]; score: ReturnType<typeof majorityScores> | null }>();
  for (const r of RUNS) {
    if (!fs.existsSync(runFile(r, prefix))) continue;
    const x = readJson<RunResult>(runFile(r, prefix));
    const passes = (s?.passes ?? []).map((p) => p.scores[Object.entries(p.key).find(([, run]) => run === r)![0]]!);
    runs.set(r, { x, passes, score: passes.length ? majorityScores(passes, FACTS.length) : null });
  }
  return { s, runs };
}

const modelsOf = (x: RunResult): string => [...new Set(x.sessions.map((c) => `${c.harness}${c.kind === 'synthesis' ? ' synthesis' : ''}: ${c.model}`))].join('; ');
const range = (r: { score: { mean: number; min: number; max: number } | null } | undefined): string =>
  !r ? 'not run' : r.score ? `${r.score.mean.toFixed(2)} (${r.score.min}–${r.score.max})` : 'not scored';

function report(): void {
  const { s, runs } = tierResults(PREFIX);
  const passCount = s?.passes.length ?? 0;
  const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const setupOf: Record<Run, string> = { A: 'claude alone, 1 round', B: 'claude answer, codex critique, claude revision (sequential)', C: 'claude + codex + opencode, defaults, synthesis' };
  const lines: string[] = [`# Discussions eval on the ${TIER} tier: is 3 models worth it?`, '', `Question: ${QUESTION.split('\n')[0]}`, ''];
  const missing = RUNS.filter((r) => !runs.has(r));
  if (missing.length || passCount < SCORE_PASSES) {
    lines.push(`Partial results: ${missing.length ? `run ${missing.join(', ')} not written` : 'every run written'}; ${passCount} of ${SCORE_PASSES} scoring passes saved. Total spent on this tier: $${spent().toFixed(2)} of the $${BUDGET} budget.`, '');
  }
  lines.push('## Runs', '', `| Run | Setup | Status | Rounds | Wall clock | Cost | Cost basis | Models | Facts (mean of ${passCount}, range) |`, '|---|---|---|---|---|---|---|---|---|');
  for (const r of RUNS) {
    const row = runs.get(r);
    if (!row) { lines.push(`| ${r} | ${setupOf[r]} | not run | | | | | | not run |`); continue; }
    const { x } = row;
    lines.push(`| ${r} | ${setupOf[r]} | ${x.status}${x.stop_reason ? ` (${esc(x.stop_reason)})` : ''} | ${x.rounds} | ${(x.wall_ms / 60_000).toFixed(1)} min | $${x.cost.toFixed(2)} | ${x.cost_basis} | ${modelsOf(x)} | ${range(row)} |`);
  }
  lines.push('', `Scoring: ${passCount} blind passes, $${(s?.cost ?? 0).toFixed(2)}. Total spent on this tier: $${spent().toFixed(2)} of the $${BUDGET} budget.`, '');
  const cell = (r: Run, f: (sc: NonNullable<ReturnType<typeof majorityScores>>) => string | number) => { const sc = runs.get(r)?.score; return sc ? f(sc) : '–'; };
  if (passCount) {
    lines.push('## Scores (majority of the passes per fact; per-pass totals below)', '', '| Fact | A | B | C |', '|---|---|---|---|');
    FACTS.forEach((f, i) => lines.push(`| ${i + 1}. ${esc(f)} | ${RUNS.map((r) => cell(r, (sc) => sc.majority[i]!)).join(' | ')} |`));
    lines.push(`| **Majority total** | ${RUNS.map((r) => cell(r, (sc) => sc.majority.reduce<number>((a, b) => a + b, 0))).join(' | ')} |`);
    lines.push(`| **Per-pass totals** | ${RUNS.map((r) => cell(r, (sc) => sc.totals.join(', '))).join(' | ')} |`, '');
  }
  if (PREFIX && fs.existsSync(runFile('A', ''))) {
    const std = tierResults('');
    const time = (x?: RunResult) => (x ? `${(x.wall_ms / 60_000).toFixed(1)} min` : 'not run');
    const money = (x?: RunResult) => (x ? `$${x.cost.toFixed(2)}` : 'not run');
    lines.push('## Standard tier against this tier', '', `| Run | Standard facts | ${TIER} facts | Standard cost | ${TIER} cost | Standard time | ${TIER} time | Standard models | ${TIER} models |`, '|---|---|---|---|---|---|---|---|---|');
    for (const r of RUNS) {
      const a = std.runs.get(r);
      const b = runs.get(r);
      lines.push(`| ${r} | ${range(a)} | ${range(b)} | ${money(a?.x)} | ${money(b?.x)} | ${time(a?.x)} | ${time(b?.x)} | ${a ? modelsOf(a.x) : 'not run'} | ${b ? modelsOf(b.x) : 'not run'} |`);
    }
    const stdPasses = std.s?.passes.length ?? 0;
    lines.push('', `The standard tier was scored with ${stdPasses} pass${stdPasses === 1 ? '' : 'es'}${stdPasses === 1 ? ', so its range is a single total' : ''}.`, '');
  }
  if (passCount) {
    lines.push('## Quotes (facts whose majority is 1, quoted from a pass that scored them)', '');
    for (const r of RUNS) {
      const row = runs.get(r);
      if (!row?.score) continue;
      lines.push(`### Run ${r}`, '');
      FACTS.forEach((_, i) => {
        const quote = majorityQuote(row.passes, i + 1, row.score!.majority[i]!);
        if (quote != null) lines.push(`- Fact ${i + 1}: "${esc(quote)}"`);
      });
      lines.push('');
    }
  }
  const B = runs.get('B');
  const C = runs.get('C');
  lines.push('## Verdict', '', `Rule: keep discussions when C finds at least 2 more facts than B (mean totals) at no more than 3x B's cost.`, '');
  // No verdict without both runs scored on every blind pass, from a run C that did not get three answers, or from a B that did not complete its three turns.
  const blocked = verdictBlockers(B && { ...B.x, scored: !!B.score }, C && { ...C.x, scored: !!C.score }, passCount, SCORE_PASSES);
  if (B?.score && C?.score) {
    const more = C.score.mean - B.score.mean;
    const ratio = B.x.cost > 0 ? C.x.cost / B.x.cost : Infinity;
    const keep = more >= 2 && ratio <= 3;
    const measured = `C found ${C.score.mean.toFixed(2)} facts on average and B ${B.score.mean.toFixed(2)} (${more >= 0 ? '+' : ''}${more.toFixed(2)}); C cost $${C.x.cost.toFixed(2)} against B's $${B.x.cost.toFixed(2)} (${ratio.toFixed(2)}x).`;
    lines.push(blocked.length ? `INCOMPLETE COMPARISON, no verdict: ${blocked.join('; ')}. For the record only: ${measured}` : `${measured} Verdict: ${keep ? 'KEEP' : 'NOT WORTH IT'}.`, '');
  } else {
    lines.push(`INCOMPLETE COMPARISON, no verdict: ${blocked.join('; ')}.`, '');
  }
  if (s) lines.push('## Blind keys', '', ...s.passes.map((p, i) => `- Pass ${i + 1}: ${Object.entries(p.key).map(([label, r]) => `${label} = run ${r}`).join(', ')}`), '');
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}report.md`), lines.join('\n'));
  console.log(lines.join('\n'));
}

const JUDGES = 3;
const VALIDATE_CONCURRENCY = 4;
interface Validation { proposal: string; valid: boolean; reason: string; cost: number }
interface RankPass { key: Record<string, string>; ranks: Record<string, number>; reasons: Record<string, string>; cost: number }
/** An open-question score file, saved after every session so a rerun resumes where the last one stopped. */
interface OpenScores {
  cost: number; model: string; failed_cost: number;
  /** Every model id the scoring sessions resolved `model` to, as the CLI reported it. */
  resolved_models?: string[];
  extract: Partial<Record<Run, { proposals: string[]; cost: number }>>;
  validate: Record<string, Validation>;
  pool: { ids: Record<string, string>; groups: { title: string; members: string[] }[]; cost: number } | null;
  ranks: RankPass[];
}
const openScoreFile = () => path.join(EVIDENCE, `${PREFIX}score.json`);

/**
 * A session's floor for its spending cap, and the margin kept per session for the call that crosses a cap: the CLI checks
 * `--max-budget-usd` only after a call, and a one-word opus reply measured $2.05 against a $1.00 cap (its first call writes
 * the session's whole context to the cache), so the margin is that worst single call, rounded up.
 */
const MIN_SESSION_CAP = 1;
const CAP_MARGIN = 2.5;

interface ClaudeResult { text: string; cost: number; models: string[]; error: string | null }
/**
 * One fresh `claude -p` session capped at `cap` dollars (`--max-budget-usd`). Never rejects: a failed session (a non-zero
 * exit, an error result, the cap reached) resolves with its `error`, and with whatever cost and resolved model ids its JSON
 * reported, so the caller can count them. `models` are the ids the CLI resolved the alias to (`modelUsage`'s keys).
 */
function claudeCall(prompt: string, model: string, cwd: string, tools: string[], cap: number): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--model', model, '--max-budget-usd', cap.toFixed(2), '--tools', tools.join(',')];
    if (tools.length) args.push('--allowedTools', ...tools);
    const child = spawn(process.platform === 'win32' ? 'claude.exe' : 'claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ text: '', cost: 0, models: [], error: `claude did not start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed: { result?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string; modelUsage?: Record<string, unknown> } = {};
      try { parsed = JSON.parse(out) as typeof parsed; } catch { /* no JSON: the cost is unknown and counted as 0 */ }
      const failed = code !== 0 || parsed.is_error || parsed.result === undefined;
      resolve({
        text: parsed.result ?? '', cost: parsed.total_cost_usd ?? 0, models: Object.keys(parsed.modelUsage ?? {}),
        error: failed ? `claude exited ${code}${parsed.subtype ? ` (${parsed.subtype})` : ''}: ${(err || out).slice(-500)}` : null,
      });
    });
    child.stdin.end(prompt);
  });
}

/** The JSON value in a reply, fences and any prose around the outermost brackets dropped. */
function replyJson<T>(text: string, open: '{' | '['): T {
  const close = open === '{' ? '}' : ']';
  return JSON.parse(text.slice(text.indexOf(open), text.lastIndexOf(close) + 1)) as T;
}

const extractPrompt = (output: string) => `Below is one answer to this question:

${CASE?.question}

List every distinct improvement the answer proposes, in its own order, without judging or ranking them. One line each, carrying the change, the problem it solves and the file and line the answer cites for it (verbatim, "no citation" when it cites none). List a proposal the answer repeats only once. Reply with a JSON array of strings only, no prose and no code fence.

## Answer

${output}
`;

const validatePrompt = (proposal: string) => `Your working directory is a checkout of a repository. Someone proposed this improvement to it:

${proposal}

Check it against the code, reading only inside the working directory and changing nothing. It is valid when both hold: the problem it claims is real (the cited file exists and the cited line, or the lines right around it, show what is claimed; with no citation, the claimed code must exist as described) and the change is feasible in this code. Otherwise it is invalid. Reply with JSON only, no code fence: {"valid": true or false, "reason": "one line"}`;

const poolPrompt = (items: [string, string][]) => `Below are improvement proposals for one web page, each with an id. Some say the same thing: the same problem solved by the same fix. Group the duplicates. Every id goes in exactly one group; a proposal with no duplicate is a group of one. Give each group a short title (one line: the problem and the fix). Reply with JSON only, no code fence: {"groups":[{"title":"...","members":["P1","P7"]}]}

${items.map(([id, text]) => `${id}: ${text}`).join('\n')}
`;

const rankPrompt = (key: Record<string, string>, byRun: Map<Run, string>) => `Three answers to the same question follow, labelled X, Y and Z. The question:

${CASE?.question}

Rank the answers 1 (best) to 3 for "which would I act on": the one whose proposals you would actually implement, judged on how real, concrete and valuable they are. Every rank once. Reply with JSON only, no code fence: {"ranks":{"X":1,"Y":2,"Z":3},"reasons":{"X":"one line","Y":"...","Z":"..."}}

${Object.entries(key).map(([label, r]) => `## Answer ${label}\n\n${byRun.get(r as Run)}`).join('\n\n')}
`;

/** A Fisher-Yates shuffle of any number of ids. */
function shuffled(ids: readonly string[]): string[] {
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * Scores the open-question runs in four stages, each saved as it lands, so a rerun resumes: extract each run's proposals,
 * validate each proposal in its own session (read tools on the eval repo, shown neither the run nor the other proposals),
 * pool the valid ones across runs under shuffled neutral ids, and have JUDGES judges rank the shuffled outputs. Every
 * session's cost, a failed one's included, counts against the budget: each session runs under a `--max-budget-usd` cap
 * from what is left (`sessionCaps`), so sessions started together cannot spend past it, and the stages stop at the limit.
 */
async function openScore(): Promise<void> {
  const results = RUNS.map((r) => readJson<RunResult>(runFile(r)));
  ownLoginEnv();
  const model = tierSetup(['claude']).get('claude')!.model;
  const s: OpenScores = fs.existsSync(openScoreFile()) ? readJson<OpenScores>(openScoreFile()) : { cost: 0, model, failed_cost: 0, extract: {}, validate: {}, pool: null, ranks: [] };
  const before = spent() - s.cost;
  const save = () => {
    s.cost = s.failed_cost + Object.values(s.extract).reduce((a, e) => a + e!.cost, 0) + Object.values(s.validate).reduce((a, v) => a + v.cost, 0) + (s.pool?.cost ?? 0) + s.ranks.reduce((a, r) => a + r.cost, 0);
    fs.writeFileSync(openScoreFile(), JSON.stringify(s, null, 2));
  };
  /** Caps for up to `want` sessions started now, from what the budget has left; throws when it cannot fund one more. */
  const admit = (want: number): number[] => {
    const caps = sessionCaps(BUDGET - before - s.cost, want, MIN_SESSION_CAP, CAP_MARGIN);
    if (!caps.length) throw new Error(`budget: $${(before + s.cost).toFixed(2)} spent of $${BUDGET}, too little left for another scoring session`);
    return caps;
  };
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'disc-eval-score-'));
  /** One capped session whose reply must parse; a session that fails or does not parse still has its cost and model saved. */
  const ask = async <T>(label: string, prompt: string, cwd: string, tools: string[], cap: number, parse: (text: string) => T): Promise<{ value: T; cost: number }> => {
    const { text, cost, models, error } = await claudeCall(prompt, model, cwd, tools, cap);
    s.resolved_models = [...new Set([...(s.resolved_models ?? []), ...models])];
    let failure = error;
    if (!failure) {
      try {
        return { value: parse(text), cost };
      } catch (err) {
        failure = `answered no usable JSON: ${String(err)}\n${text.slice(0, 500)}`;
      }
    }
    s.failed_cost += cost;
    save();
    throw new Error(`${label} (cap $${cap.toFixed(2)}, cost $${cost.toFixed(2)}): ${failure}`);
  };

  for (const r of results) {
    if (s.extract[r.run]) continue;
    const { value, cost } = await ask(`extract ${r.run}`, extractPrompt(r.output), scratch(), [], admit(1)[0]!, (t) => {
      const list = replyJson<unknown[]>(t, '[');
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x.trim())) throw new Error('not an array of lines');
      return list as string[];
    });
    s.extract[r.run] = { proposals: value, cost };
    save();
    console.log(`extract ${r.run}: ${value.length} proposals, $${cost.toFixed(2)}`);
  }

  const todo = RUNS.flatMap((r) => s.extract[r]!.proposals.map((p, i) => [`${r}#${i + 1}`, p] as const)).filter(([id]) => !s.validate[id]);
  // Each group starts only as many sessions as the remaining budget can cap, and every session in it settles (its cost and
  // result saved) before a failure stops the stage, so an exit never leaves a paid session unrecorded.
  while (todo.length) {
    const caps = admit(Math.min(VALIDATE_CONCURRENCY, todo.length));
    const group = todo.splice(0, caps.length);
    const settled = await Promise.allSettled(group.map(async ([id, proposal], j) => {
      const { value, cost } = await ask(`validate ${id}`, validatePrompt(proposal), REPO, ['Read', 'Grep', 'Glob'], caps[j]!, (t) => {
        const v = replyJson<{ valid: unknown; reason: unknown }>(t, '{');
        if (typeof v.valid !== 'boolean' || typeof v.reason !== 'string') throw new Error('no boolean valid and string reason');
        return v as { valid: boolean; reason: string };
      });
      s.validate[id] = { proposal, valid: value.valid, reason: value.reason, cost };
      save();
      console.log(`validate ${id}: ${value.valid ? 'valid' : 'invalid'}, $${cost.toFixed(2)} (${value.reason})`);
    }));
    const failures = settled.flatMap((x) => (x.status === 'rejected' ? [String(x.reason)] : []));
    if (failures.length) throw new Error(`${failures.length} validation session(s) failed, every cost saved:\n${failures.join('\n')}`);
  }

  const valid = Object.keys(s.validate).filter((id) => s.validate[id]!.valid);
  if (!s.pool) {
    const ids = Object.fromEntries(shuffled(valid).map((id, i) => [`P${i + 1}`, id]));
    const { value, cost } = await ask('pool', poolPrompt(Object.entries(ids).map(([p, id]) => [p, s.validate[id]!.proposal])), scratch(), [], admit(1)[0]!, (t) => {
      const g = replyJson<{ groups: { title: string; members: string[] }[] }>(t, '{').groups.map((x) => ({ title: x.title, members: x.members.map((m) => ids[m] ?? m) }));
      poolProposals(valid, g, RUNS);
      return g;
    });
    s.pool = { ids, groups: value, cost };
    save();
    console.log(`pool: ${valid.length} valid proposals in ${value.length} groups, $${cost.toFixed(2)}`);
  }

  const byRun = new Map(results.map((r) => [r.run, r.output]));
  while (s.ranks.length < JUDGES) {
    const key = blindKey(RUNS);
    const { value, cost } = await ask(`judge ${s.ranks.length + 1}`, rankPrompt(key, byRun), scratch(), [], admit(1)[0]!, (t) => {
      const v = replyJson<{ ranks: Record<string, number>; reasons: Record<string, string> }>(t, '{');
      if (Object.keys(key).map((l) => v.ranks[l]).sort().join() !== '1,2,3') throw new Error(`ranks ${JSON.stringify(v.ranks)} are not 1, 2, 3 once each`);
      return v;
    });
    s.ranks.push({ key, ranks: value.ranks, reasons: value.reasons, cost });
    save();
    console.log(`judge ${s.ranks.length}: ${JSON.stringify(key)} ranks ${JSON.stringify(value.ranks)}, $${cost.toFixed(2)}`);
  }
}

function openReport(): void {
  const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const runs = new Map(RUNS.filter((r) => fs.existsSync(runFile(r))).map((r) => [r, readJson<RunResult>(runFile(r))]));
  const s = fs.existsSync(openScoreFile()) ? readJson<OpenScores>(openScoreFile()) : null;
  const setupOf: Record<Run, string> = { A: 'claude alone, 1 round', B: 'claude answer, codex critique, claude revision (sequential)', C: 'claude + codex + opencode, defaults, synthesis' };
  const lines: string[] = [`# Discussions eval, open question (${CASE!.name}) on the ${TIER} tier`, '', `Question: ${CASE!.question.replace(/\r?\n/g, ' ')}`, '', `Repo: standalone copy of ${REPO_REF}, read-only.`, ''];
  const pool = s?.pool ? poolProposals(Object.keys(s.validate).filter((id) => s.validate[id]!.valid), s.pool.groups, RUNS) : null;
  const judged = (s?.ranks ?? []).map((p) => Object.fromEntries(Object.entries(p.key).map(([label, r]) => [r, p.ranks[label]!])));
  const complete = runs.size === RUNS.length && !!pool && judged.length === JUDGES;
  if (!complete) lines.push(`Partial results: ${runs.size} of 3 runs written, ${pool ? 'pooled' : 'not pooled'}, ${judged.length} of ${JUDGES} judges. Spent $${spent().toFixed(2)} of the $${BUDGET} budget.`, '');
  const rank = (r: Run) => (judged.length === JUDGES ? majorityRank(judged, r) : null);
  lines.push('## Runs', '', '| Run | Setup | Status | Rounds | Wall clock | Cost | Cost basis | Models | Proposals | Valid | Distinct valid | Unique | Judge ranks | Majority rank |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of RUNS) {
    const x = runs.get(r);
    if (!x) { lines.push(`| ${r} | ${setupOf[r]} | not run | | | | | | | | | | | |`); continue; }
    const props = s?.extract[r]?.proposals ?? [];
    const validN = props.filter((_, i) => s?.validate[`${r}#${i + 1}`]?.valid).length;
    lines.push(`| ${r} | ${setupOf[r]} | ${x.status}${x.stop_reason ? ` (${esc(x.stop_reason)})` : ''} | ${x.rounds} | ${(x.wall_ms / 60_000).toFixed(1)} min | $${x.cost.toFixed(2)} | ${x.cost_basis} | ${modelsOf(x)} | ${props.length} | ${validN} | ${pool?.counts[r] ?? '–'} | ${pool?.unique[r] ?? '–'} | ${judged.map((j) => j[r]).join(', ') || '–'} | ${rank(r) ?? (judged.length === JUDGES ? 'no majority' : '–')} |`);
  }
  lines.push('', `Scoring on claude ${s?.model ?? '–'}, resolved to ${s?.resolved_models?.join(', ') || 'no recorded model id'}: $${(s?.cost ?? 0).toFixed(2)} (of which $${(s?.failed_cost ?? 0).toFixed(2)} on sessions that failed or did not parse). Total spent on this case: $${spent().toFixed(2)} of the $${BUDGET} budget.`, '');
  if (pool) {
    lines.push('## Pooled valid proposals', '', '| # | Proposal | Valid | Runs | Members |', '|---|---|---|---|---|');
    pool.pooled.forEach((p, i) => lines.push(`| ${i + 1} | ${esc(p.title)} | valid | ${p.runs.join(', ')} | ${p.members.join(', ')} |`));
    lines.push('');
  }
  if (s && Object.keys(s.validate).length) {
    lines.push('## Every extracted proposal', '', '| Id | Proposal | Valid | Reason |', '|---|---|---|---|');
    for (const [id, v] of Object.entries(s.validate).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) lines.push(`| ${id} | ${esc(v.proposal)} | ${v.valid ? 'valid' : 'invalid'} | ${esc(v.reason)} |`);
    lines.push('');
  }
  if (s?.ranks.length) {
    lines.push('## Judges', '');
    s.ranks.forEach((p, i) => lines.push(`- Judge ${i + 1} (${Object.entries(p.key).map(([l, r]) => `${l} = run ${r}`).join(', ')}): ${Object.entries(p.key).map(([l, r]) => `run ${r} rank ${p.ranks[l]}: ${esc(p.reasons[l] ?? '')}`).join('; ')}`));
    lines.push('');
  }
  const B = runs.get('B');
  const C = runs.get('C');
  lines.push('## Verdict', '', "Rule: keep discussions when C has at least 2 more distinct valid proposals than B, or its majority rank beats B's, at no more than 3x B's cost.", '');
  const blocked = verdictBlockers(B && { ...B, scored: !!pool }, C && { ...C, scored: !!pool }, judged.length, JUDGES);
  if (!complete && !blocked.length) blocked.push('scoring did not finish');
  if (B && C && pool && judged.length === JUDGES) {
    const k = openKeep({ valid: pool.counts.B!, rank: rank('B'), cost: B.cost }, { valid: pool.counts.C!, rank: rank('C'), cost: C.cost });
    const measured = `Distinct valid proposals: C ${pool.counts.C}, B ${pool.counts.B} (at least 2 more: ${k.moreValid ? 'yes' : 'no'}). Majority rank: C ${rank('C') ?? 'no majority'}, B ${rank('B') ?? 'no majority'} (C beats B: ${k.rankBeats ? 'yes' : 'no'}). Cost: C $${C.cost.toFixed(2)}, B $${B.cost.toFixed(2)} (${k.ratio.toFixed(2)}x, ${k.ratio <= 3 ? 'within 3x' : 'over 3x'}).`;
    lines.push(blocked.length ? `INCOMPLETE COMPARISON, no verdict: ${blocked.join('; ')}. For the record only: ${measured}` : `${measured} Verdict: ${k.keep ? 'KEEP' : 'NOT WORTH IT'}.`, '');
  } else {
    lines.push(`INCOMPLETE COMPARISON, no verdict: ${blocked.join('; ')}.`, '');
  }
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}report.md`), lines.join('\n'));
  console.log(lines.join('\n'));
}

const [cmd, arg] = argv;
const main = async (): Promise<void> => {
  if (cmd === 'setup') return setup();
  if (cmd === 'run' && RUNS.includes(arg as Run)) return run(arg as Run);
  if (cmd === 'probe') return probe();
  if (cmd === 'score') return CASE ? openScore() : score();
  if (cmd === 'report') return CASE ? openReport() : report();
  throw new Error('usage: discussion-eval.ts setup | probe | run A|B|C | score | report [--tier <name>] [--opencode-account <id>] [--case <name> --question-file <path> --repo-ref <sha>]');
};
main().then(() => process.exit(process.exitCode ?? 0), (err: unknown) => { console.error(err); process.exit(1); });
