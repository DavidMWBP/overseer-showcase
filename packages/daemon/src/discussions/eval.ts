import path from 'node:path';
import { accountEnv } from '../accounts/env';
import type { StoredAccount } from '../db/db';
import type { HarnessName, TierCandidate, TierSettings } from '@overseer/shared';

/** Text that exists only after the token-error fix: a copied log carrying any of it would leak the answer to a participant. */
export const LEAK_NEEDLES = ['auth_failed', 'refresh margin', 'resumeWorkerAfterAuth', 'overseer-b137'];

/** Every needle `text` contains, case-insensitively, in needle order; empty when the text is clean. */
export function leakHits(text: string, needles: readonly string[] = LEAK_NEEDLES): string[] {
  const lower = text.toLowerCase();
  return needles.filter((n) => lower.includes(n.toLowerCase()));
}

export const BLIND_LABELS = ['X', 'Y', 'Z'] as const;

/**
 * Assigns each run a blind label (X, Y, Z in order) after a Fisher-Yates shuffle driven by `random`, and returns the key
 * from label to run. Refuses anything but three distinct runs, so no run can be scored twice or left out.
 */
export function blindKey(runs: readonly string[], random: () => number = Math.random): Record<string, string> {
  if (runs.length !== BLIND_LABELS.length || new Set(runs).size !== runs.length) throw new Error(`blindKey needs ${BLIND_LABELS.length} distinct runs, got ${JSON.stringify(runs)}`);
  const order = [...runs];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return Object.fromEntries(BLIND_LABELS.map((label, i) => [label, order[i]!]));
}

/** Throws when `dbPath` resolves to the live database, so an eval can never write the user's own install. */
export function assertNotLiveDb(dbPath: string, liveDataDir: string): void {
  if (path.resolve(dbPath).toLowerCase() === path.resolve(liveDataDir, 'overseer.db').toLowerCase()) {
    throw new Error(`refusing to run against the live database ${dbPath}`);
  }
}

/** Each harness's candidate in `tier`, denied models excluded; throws naming every harness the tier has no candidate for. */
export function tierCandidates(settings: TierSettings, tier: string, harnesses: readonly HarnessName[]): Map<HarnessName, TierCandidate> {
  const deny = new Set(settings.denyModels);
  const candidates = settings.tiers.find((t) => t.name === tier)?.candidates ?? [];
  const picked = new Map<HarnessName, TierCandidate>();
  for (const h of harnesses) {
    const c = candidates.find((x) => x.harness === h && !deny.has(x.model));
    if (c) picked.set(h, c);
  }
  const missing = harnesses.filter((h) => !picked.has(h));
  if (missing.length) throw new Error(`tier ${tier} has no candidate for ${missing.join(', ')}; configure one or pick another tier`);
  return picked;
}

/** Run B's critique model: the `critic` tier's codex candidate, else the `hard` tier's, with a note saying which. */
export function critiqueCandidate(settings: TierSettings): { candidate: TierCandidate; tier: 'critic' | 'hard'; note: string } {
  try {
    return { candidate: tierCandidates(settings, 'critic', ['codex']).get('codex')!, tier: 'critic', note: 'critic tier codex candidate' };
  } catch {
    const candidate = tierCandidates(settings, 'hard', ['codex']).get('codex')!;
    return { candidate, tier: 'hard', note: 'the critic tier has no codex candidate, so the hard tier codex candidate is used' };
  }
}

export interface FactScore { fact: number; score: 0 | 1; quote: string }

/**
 * Folds several blind scoring passes of one run (each an array of per-fact scores) into the majority score per fact (ties
 * count as 0) and the mean total with its range.
 */
export function majorityScores(passes: readonly (readonly FactScore[])[], facts: number): { majority: (0 | 1)[]; totals: number[]; mean: number; min: number; max: number } {
  if (!passes.length) throw new Error('majorityScores needs at least one scoring pass');
  const at = (p: readonly FactScore[], i: number) => p.find((f) => f.fact === i + 1)?.score ?? 0;
  const majority = Array.from({ length: facts }, (_, i) => (passes.filter((p) => at(p, i) === 1).length * 2 > passes.length ? 1 : 0) as 0 | 1);
  const totals = passes.map((p) => Array.from({ length: facts }, (_, i) => at(p, i)).reduce<number>((a, b) => a + b, 0));
  return { majority, totals, mean: totals.reduce((a, b) => a + b, 0) / totals.length, min: Math.min(...totals), max: Math.max(...totals) };
}

/**
 * The environment a tier candidate's account gives its session, through the plain `accountEnv` (no refresh, so nothing is
 * written anywhere); `{}` for a candidate on its CLI's own login. Throws when the named account is missing, belongs to
 * another harness, or holds a Claude OAuth token that expires before `until`: refreshing it would revoke the live install's.
 */
export function candidateEnv(candidate: TierCandidate, accounts: ReadonlyMap<string, StoredAccount>, until: number): NodeJS.ProcessEnv {
  if (!candidate.account) return {};
  const account = accounts.get(candidate.account);
  if (!account) throw new Error(`the ${candidate.harness} candidate names account ${candidate.account}, which was not read`);
  if (account.harness !== candidate.harness) throw new Error(`the ${candidate.harness} candidate names ${account.id}, a ${account.harness} account`);
  if (account.kind === 'oauth_token' && account.token_expires_at != null && account.token_expires_at < until) {
    throw new Error(`the ${candidate.harness} account ${account.id} token expires at ${new Date(account.token_expires_at).toISOString()}, inside the run; let the live daemon refresh it first`);
  }
  return accountEnv(account);
}

/**
 * Writes `env` into `target`, deleting every key whose value is undefined: assigning undefined to process.env stores the
 * string "undefined" (an ANTHROPIC_API_KEY of "undefined" makes claude refuse an OAuth account's token as an invalid key).
 */
export function applyEnv(target: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete target[k];
    else target[k] = v;
  }
}

/**
 * Whether an evidence file is a run or score file of the tier whose file prefix is `prefix` (`''` for standard, else
 * `<tier>-`), including an earlier attempt kept as `attempt<n>-<file>`: every one of them counts against that tier's budget.
 */
export function isSpendFile(name: string, prefix: string): boolean {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(attempt\\d+-)?${escaped}(run-[ABC]|score)\\.json$`).test(name);
}

/** The quote that earns fact `fact` (1-based), taken from a pass that scored it 1, or null when its majority is 0. */
export function majorityQuote(passes: readonly (readonly FactScore[])[], fact: number, majority: 0 | 1): string | null {
  if (!majority) return null;
  return passes.map((p) => p.find((f) => f.fact === fact)).find((f) => f?.score === 1)?.quote ?? null;
}

interface VerdictRun { status: string; stop_reason?: string | null; scored: boolean }

/**
 * Why no verdict may be given, empty when one may: both runs finished, both scored, and every one of the `required` blind
 * passes saved. A stop at the budget after one or two passes is an incomplete comparison, never KEEP or NOT WORTH IT.
 */
export function verdictBlockers(B: VerdictRun | undefined, C: VerdictRun | undefined, passes: number, required: number): string[] {
  return [
    !C ? 'run C was not run' : C.status !== 'done' && `run C is ${C.status} (${C.stop_reason ?? 'no reason recorded'})`,
    !B ? 'run B was not run' : B.status !== 'done' && `run B is ${B.status} (${B.stop_reason ?? 'no reason recorded'})`,
    B && C && (!B.scored || !C.scored) && 'runs B and C are not scored',
    passes > 0 && passes < required && `only ${passes} of ${required} scoring passes saved`,
  ].filter((x): x is string => typeof x === 'string');
}

/** Starts a scoring attempt: refuses at the budget before `archive` runs, so a retry at the cap keeps the saved score file in place. */
export function beginScoring(spent: number, budget: number, archive: () => void): void {
  if (spent >= budget) throw new Error(`budget: $${spent.toFixed(2)} already spent of $${budget}`);
  archive();
}

/** An open-question case: the question text, the ref the standalone repo is checked out at, and the file prefix name. */
export interface EvalCase { name: string; question: string; repoRef: string }

/**
 * Takes `--case <name> --question-file <path> --repo-ref <ref>` out of `argv` (in place, like `--tier`). All three or none:
 * with none the eval stays on the token case (null), and a partial set throws naming what is missing.
 */
export function takeCase(argv: string[], readFile: (file: string) => string): EvalCase | null {
  const take = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const value = argv.splice(at, 2)[1];
    if (!value) throw new Error(`${flag} needs a value`);
    return value;
  };
  const name = take('--case');
  const file = take('--question-file');
  const repoRef = take('--repo-ref');
  if (name === undefined && file === undefined && repoRef === undefined) return null;
  const missing = [!name && '--case', !file && '--question-file', !repoRef && '--repo-ref'].filter(Boolean);
  if (missing.length) throw new Error(`an open-question case needs ${missing.join(', ')} as well`);
  if (!/^[a-z0-9-]+$/.test(name!)) throw new Error(`--case must be lowercase letters, digits and dashes, got ${name}`);
  const question = readFile(file!).trim();
  if (!question) throw new Error(`${file} holds no question`);
  return { name: name!, question, repoRef: repoRef! };
}

export interface PooledProposal { title: string; members: string[]; runs: string[] }

/**
 * Pools the valid proposals of every run: `groups` (from a pooling session) lists the ids of duplicates together, where an
 * id is `<run>#<n>`. Every valid id must sit in exactly one group and no invalid or unknown id in any, so nothing is dropped
 * or counted twice. Each run's count is the number of groups it has a member in; its unique groups are those no other run shares.
 */
export function poolProposals(valid: readonly string[], groups: readonly { title: string; members: readonly string[] }[], runs: readonly string[]) {
  const seen = new Map<string, number>();
  groups.forEach((g, i) => g.members.forEach((m) => {
    if (!valid.includes(m)) throw new Error(`pool group ${i + 1} names ${m}, which is not a valid proposal`);
    if (seen.has(m)) throw new Error(`${m} is in pool groups ${seen.get(m)! + 1} and ${i + 1}`);
    seen.set(m, i);
  }));
  const left = valid.filter((v) => !seen.has(v));
  if (left.length) throw new Error(`the pool leaves out ${left.join(', ')}`);
  const runOf = (id: string) => id.slice(0, id.indexOf('#'));
  const pooled: PooledProposal[] = groups.filter((g) => g.members.length).map((g) => ({ title: g.title, members: [...g.members], runs: runs.filter((r) => g.members.some((m) => runOf(m) === r)) }));
  const counts = Object.fromEntries(runs.map((r) => [r, pooled.filter((p) => p.runs.includes(r)).length]));
  const unique = Object.fromEntries(runs.map((r) => [r, pooled.filter((p) => p.runs.length === 1 && p.runs[0] === r).length]));
  return { pooled, counts, unique };
}

/** The rank more than half the judges gave `run`, or null when no rank has a majority. */
export function majorityRank(judgements: readonly Readonly<Record<string, number>>[], run: string): number | null {
  const tally = new Map<number, number>();
  for (const j of judgements) if (j[run] != null) tally.set(j[run]!, (tally.get(j[run]!) ?? 0) + 1);
  for (const [rank, n] of tally) if (n * 2 > judgements.length) return rank;
  return null;
}

/** The open-question keep rule, both parts: C keeps when it has 2+ more valid proposals than B, or a better majority rank, at no more than 3x B's cost. */
export function openKeep(b: { valid: number; rank: number | null; cost: number }, c: { valid: number; rank: number | null; cost: number }) {
  const moreValid = c.valid - b.valid >= 2;
  const rankBeats = b.rank != null && c.rank != null && c.rank < b.rank;
  const ratio = b.cost > 0 ? c.cost / b.cost : Infinity;
  return { moreValid, rankBeats, ratio, keep: (moreValid || rankBeats) && ratio <= 3 };
}

/**
 * Spending caps for up to `want` sessions started together with `remaining` dollars left: each gets an equal share less
 * `margin` (a CLI stops only after the call that crosses its cap, so the margin covers that last call), and fewer sessions
 * start when a share would fall below `minCap`. Empty means the budget cannot fund one more session.
 */
export function sessionCaps(remaining: number, want: number, minCap: number, margin: number): number[] {
  for (let k = Math.max(0, Math.floor(want)); k > 0; k--) {
    const cap = remaining / k - margin;
    if (cap >= minCap) return Array.from({ length: k }, () => cap);
  }
  return [];
}
