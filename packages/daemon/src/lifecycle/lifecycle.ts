import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { effectiveBatchApprover, type BatchRetrospective, type BatchRow, type BatchSignalKind, type Bead, type Effort, type Finding, type HarnessName, type Phase, type Repo, type ReviewCheck, type SessionRow, type TierCandidate, type TierName, type VerifyOnlyCheck, type WorktreeRow } from '@overseer/shared';
import type { Db, StoredAccount } from '../db/db';
import type { Push } from '../push/push';
import type { Bus, SessionEnded, SessionStop } from '../bus';
import type { Config } from '../config';
import type { BlockedBead, TaskStore } from '../beads/store';
import { BATCH_PREFIX, batchOf, blockersOf, dependentsOf, phaseOf } from '../beads/store';
import { batchMembers } from '../api/board';
import type { SessionManager } from '../sessions/manager';
import { envTokenExpiresAt, freshAccountEnv } from '../accounts/env';
import { refreshClaudeOAuth } from '../accounts/login';
import { AUTH_HOLD_UNTIL, accountLoggedIn } from '../accounts/status';
import { accountUsable, clearAccountUsageCacheForAccount } from '../accounts/usage';
import { harnessLimitReason, setHarnessLimit } from '../accounts/harnessLimits';
import { accountDisplayName } from '../accounts/display';
import type { VersionRunner } from '../doctor/doctor';
import { git, ensureWorktree, ensureBranchWorktree, branchFor, createBranch, fetchBase, resolveNewWorkBase, mergeInto, deleteBranch, diffAgainstBase, reviewDiff, diffStat, diffLines, headCommit, isAncestor, commitsSince, nothingToLand, uncommittedWork, removeWorktree, removeWorktreeRetry, changedFiles, pushBranch, GitPushError, pushBaseBranch } from '../git/git';
import { mergeMessage } from '../git/message';
import { MergeConflictError, type GitProvider } from '../git/provider';
import { isAlive, killProcess } from '../util/procs';
import { log } from '../util/log';
import type { PriceSource } from '../pricing/catalog';
import { candidateUsageKey, filterRepoTiers, resolveTier, NO_SERVER_HARNESSES } from '../routing/tiers';
import { buildRetrospective, isLessonsBatch, reopenText, retrospectiveSummary } from './retrospective';
import { parseCheckLines } from './checkLines';
import { classifyExit, isAuthFailure } from './crash';
import { boundedCriticPrompt, buildCriticPrompt, buildWorkerPrompt, inputLimit } from './prompt';
import { landsWithFindings } from './reviewSeverity';
import { reviewRoundLimit, reviewsAgain, reviewTierFor } from './reviewPlan';
import { evaluateEvidence, evidenceGateApplies } from './evidenceGate';
import { runSetup, runVerify, type VerifyResult } from './verify';
import { parseReviewCounts } from './reviewCheck';
import { storeAttachments, type AttachmentInput, type StoredAttachment } from '../orchestrator/attachments';
import { refusalText } from './probe';
import { reapEndedSession } from './reap';
import { SOURCE_ROOT } from '../util/watch';

export class LifecycleError extends Error {}

export const SLUG_MAX = 40;
export function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, SLUG_MAX).replace(/^-+|-+$/g, '');
  return s || 'batch';
}
/** `<worktreesDir>/<repo>/b1` for batch `<repo>-b1`: the worktree path counts against Windows' 260-char limit for every checked-out file. */
export const batchWorktreePath = (worktreesDir: string, repoId: string, batchId: string) => path.join(worktreesDir, repoId, batchId.startsWith(`${repoId}-`) ? batchId.slice(repoId.length + 1) : batchId);
/** The reason recovery gives a worker session the daemon lost; the session-end rule reads it back to tell a crash from a worker that ended on its own. */
export const RESTART_REASON = 'daemon restarted while the worker was running';
/** How a notice names what verification ran, so the orchestrator never has to guess the command (round 7: it inferred one from old bead notes). */
export const verifyLabel = (repo: Repo) => (repo.verify_command ? `verify command \`${repo.verify_command}\`` : 'no verify command configured');
/** A verification outcome in a notice: with no command nothing ran, and "pass (no verify command configured)" read as a contradiction (fix round 7 review). */
export const setupLabel = (repo: Repo) => (repo.setup_command ? `setup command \`${repo.setup_command}\`` : 'no setup command configured');
export const verifyOutcome = (repo: Repo, status: 'pass' | 'fail') => (repo.verify_command ? `${verifyLabel(repo)} ${status === 'pass' ? 'passed' : 'failed'}` : 'not verified: no verify command configured');
function checkPassesCommand(line: string, command: string): boolean {
  const normalized = line.trim().replace(/^[-*>]\s+/, '').replace(/^\*\*check:\*\*/i, 'Check:');
  const match = /^check:\s+(.+?)\s+-\s+pass\s+-\s+.+$/i.exec(normalized);
  return match?.[1]?.trim() === command.trim();
}
/** How a batch status reads to the orchestrator: a fresh session took "review" with every bead done for merged (round 9). */
export const batchStatusLabel = (status: string, waitingOn: string | null = null) => (status === 'review' ? (waitingOn ? `waiting on ${waitingOn} (in review behind a batch that changes the same files; Merge is disabled until that one is merged, rejected or abandoned; not merged)` : "in review (awaiting the user's review, not merged)") : status);
/** Ends a notice that quotes a user's own words: a note that already ends in a full stop must not get a second one (round 25 nit). */
export const endSentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
/**
 * The writer's own end punctuation, dropped where clauses follow their words: "Not needed." + "; batch …" read "Not needed.; batch …"
 * (round 26 nit; fix round 26 review: `!` and `?` ended up there too). `endSentence` puts one stop back on the whole line.
 */
export const trimEndStop = (text: string) => text.trim().replace(/[.!?\s]+$/, '');
/** Names the account a session ran on, or its harness when it ran on the CLI's own login, for a failure notice the user must act on. */
export const sessionWho = (db: Db, session: SessionRow) => {
  const account = session.account ? db.accounts.get(session.account) : undefined;
  const name = accountDisplayName(account);
  return name ? `${session.harness} account ${name}` : session.harness;
};

/**
 * Final-message phrasings that say the work itself is still happening elsewhere (a background agent, a later result) rather
 * than done. The set is deliberately narrow, because a match re-dispatches the bead at once: it names only an explicit
 * background/sub-agent hand-off, or a promise of a later result, and never bare "waiting", "working" or "running", which turn
 * up in ordinary no-commit endings too.
 */
const DEFERRED_WORK: RegExp[] = [
  /\bbackground (?:agent|task|worker|process|job|run)\b/i,
  /\bin the background\b/i,
  /\bsub-?agent\b/i,
  /\bhand(?:ed|ing|s)? (?:it |the work |this )?(?:off|over)\b/i,
  /\bdelegat(?:ed|ing|e)\b[^.]{0,40}\b(?:agent|background|sub-?agent)\b/i,
  /\b(?:will|'ll) report back\b/i,
  /\breport back (?:once|when|after)\b/i,
  /\b(?:will|'ll) (?:follow up|let you know)\b/i,
  /\b(?:follow up|let you know) (?:once|when|after)\b/i,
  /\bonce (?:it|that|the [\w-]{1,30}) (?:completes?|finishes?)\b/i,
  /\bwaiting (?:on|for) [^.]{0,40}\b(?:agent|background|result|notification|completion)\b/i,
];
/**
 * A finished-work claim plus a check word anywhere in the message: "committed the change, and a sub-agent is running the
 * tests" is an ordinary no-commit ending, whatever runs the check. "background" is not required, and the check may be a
 * gerund ("checking"). The exclusion only bites when a DEFERRED_WORK pattern also matches, and erring toward not
 * re-dispatching is the safe direction: a missed hand-off is an ordinary reopen, a false positive costs a whole round.
 */
const FINISHED_WORK = /\b(?:committed|implemented|completed|finished|done|landed|pushed)\b/i;
const RUNNING_CHECK = /\b(?:check|test|verif|review|build|lint|typecheck|audit)/i;

/**
 * The sentence in a worker's final message that hands the work to something still running, or null. It is read from the final
 * text alone, never from timing, and a message that reports finished work alongside a running check is not a match: that is
 * the ordinary no-commit ending, and a false positive here would send the bead round again for no reason.
 */
export function deferredWorkSentence(text: string | null | undefined): string | null {
  const full = text?.trim();
  if (!full) return null;
  if (FINISHED_WORK.test(full) && RUNNING_CHECK.test(full)) return null;
  for (const line of full.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) if (DEFERRED_WORK.some((p) => p.test(sentence))) return sentence.trim();
  }
  return null;
}

/** The instruction a deferred-work re-dispatch carries: the work must be done and committed in that session, not handed to anything else. */
export const DEFERRED_WORK_INSTRUCTION = 'The previous session ended without committing the work and said it was still happening elsewhere; nothing will come back for it. Do the work and commit it on this branch in this session — do not hand it to a background agent, and do not end this session waiting for a later result.';

/** The first `OVERLAP_QUOTED` files for a chat notice, "and N more" for the rest; the full list stays in the row and the tool result. */
export const OVERLAP_QUOTED = 10;
const REFRESH_FETCH_RETRIES = 3;
const REFRESH_FETCH_RETRY_MS = 10_000;
export const quoteFiles = (files: string[]) => (files.length > OVERLAP_QUOTED ? `${files.slice(0, OVERLAP_QUOTED).join(', ')} and ${files.length - OVERLAP_QUOTED} more` : files.join(', '));
/** The tiers a forced harness takes its model and account from, in order. */
const FORCED_TIERS: TierName[] = ['standard', 'chore', 'hard'];
/** How a retry re-dispatches a worker session: a harness forced with a tier (`harness_forced`) keeps both, a harness forced without one (tier null) keeps the harness, a tiered session keeps its tier. */
const retryRoute = (s: SessionRow): SpawnOpts => (s.tier ? { tier: s.tier, ...(s.harness_forced ? { harness: s.harness } : {}) } : { harness: s.harness });
/** Who stopped a worker on purpose: the user from the Board, or the orchestrator through `interrupt_worker` (on the user's instruction). */
/** Set on the interrupt event, and carried on the end event, when the session had been silent past the stall threshold; an automatic re-dispatch then avoids that harness. */
export type WorkerStop = SessionStop;
/** Who performed a batch merge: the user, the orchestrator for local merges, or the GitLab MR watcher recording an external merge. */
export type MergeActor = 'user' | 'orchestrator' | 'gitlab';
/** How a worker is dispatched: a `tier` (or neither, which means `standard`) resolves to a harness and model; `harness` alone pins that CLI and takes the first usable candidate allowed by the repository model filter from the standard, chore, then hard tier, so the session records a model and, when one is configured, an account; `harness` with `tier` pins that CLI among that tier's candidates only and is refused, never moved, when none of them is usable. */
/** `continuation`: the same attempt carried on (the first failed review round), so the worker keeps its model and its session. */
/** `automatic`: a re-dispatch the daemon starts on its own (review round, rate-limit pickup, crash retry); it avoids harnesses whose latest worker session for this task hung or failed to start. A user's Re-dispatch from the Board leaves it unset. */
export interface SpawnOpts { tier?: TierName; harness?: HarnessName; /** The task starts a server, a daemon or a browser, so a harness that cannot keep one alive (`NO_SERVER_HARNESSES`) is unusable for it; a forced harness, with or without a tier, is refused rather than started. Recorded on the session, so every later dispatch of the bead carries it. */ needsServer?: boolean; /** Pins the model of a `harness`-only (no `tier`) dispatch; the account still comes from a usable candidate of that harness unless one is passed here. */ model?: string; /** Preserves a forced session's account when applying review findings. */ account?: string | null; instructions?: string; batchId?: string; stepUp?: boolean; verifyOnly?: boolean; /** Re-runs this command in the bead worktree when a verify-only worker ends. */ verifyCommand?: string; continuation?: boolean; automatic?: boolean; /** A usage-limit stop is not a failed model attempt. */ rateLimit?: boolean; silentUsageRefusal?: boolean; /** A parent lifecycle action reports a refused dispatch with its own notice. */ suppressDispatchNotices?: boolean; /** An automatic re-dispatch that must not land on this harness: the one the previous session just failed on. */ avoidHarness?: HarnessName }
/** A critic's verdict: `pass` lands the work; `findings` sends it back to a worker (below the repo's round limit) or parks it for the user. */
export interface Review { verdict: 'pass' | 'findings'; findings: Finding[] }
/** What the critic is told about the worker whose change it reviews: the model (never the critic's own) and its final message. */
interface WorkerEnd { model: string | null; text: string | null }
/** The findings as a re-dispatched worker reads them, one line each. */
export const renderFindings = (findings: Finding[]) => findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.summary}`).join('\n');
/** How a landing notice names the critic that passed the change: "reviewed by claude fable". */
const reviewedBy = (s: SessionRow) => `reviewed by ${[s.harness, s.model].filter(Boolean).join(' ')}`;

export interface LifecycleDeps {
  db: Db;
  store: TaskStore;
  sessions: SessionManager;
  bus: Bus;
  config: Config;
  provider: (repo: Repo) => GitProvider;
  /** Whether a harness CLI is installed; tier resolution skips candidates on a missing one. Omitted (tests): every harness counts as installed. */
  harnessAvailable?: (harness: HarnessName) => boolean;
  /** Whether an opencode candidate with no account can reach its model's provider on the CLI's own login (`opencodeOwnLoginReaches`); tier resolution skips it otherwise. Omitted (tests): it always can. */
  opencodeLoginReaches?: (model: string) => boolean;
  /** The loaded models.dev catalog; a first chore or standard dispatch picks its cheapest usable candidate by it. Omitted: configured order. */
  prices?: PriceSource;
  doctorRunner?: VersionRunner;
  usageGate?: typeof accountUsable;
  /** Overrides the scoped process cleanup in tests. */
  reapEnded?: typeof reapEndedSession;
  /** Overrides the repo verification runner in tests. */
  verifyRunner?: typeof runVerify;
  /** Pause between the fetches that wait for origin to receive a merged batch head. Omitted: REFRESH_FETCH_RETRY_MS; tests pass 0. */
  refreshRetryMs?: number;
  /** The review command's bounded runner timeout; omitted: runVerify's default. Tests pass a short timeout. */
  reviewCommandTimeoutMs?: number;
  /** Push notifications to subscribed browsers for the moments that need the user: a batch in review, a bead awaiting a decision. */
  push?: Push;
  /** Runs after a local batch merge; tests can hold or observe the detached push. */
  pushBase?: typeof pushBaseBranch;
  /**
   * An Overseer notice for the orchestrator; `wake` starts a session for it when none is live (the notice needs a decision).
   * `text` is shown in the thread as Overseer's log line; `hint` is guidance for the model and reaches only the orchestrator.
   */
  notify: (text: string, opts?: { wake?: boolean; hint?: string; storedAttachments?: StoredAttachment[]; beadId?: string }) => Promise<void>;
}

export class Lifecycle {
  private workerTemplate: string;
  private criticTemplate: string;
  private readonly pendingBasePushes = new Set<NodeJS.Immediate>();
  private basePushesStopped = false;
  private usageRefusals = new Set<string>();
  /** Sessions whose rate-limit event is being settled; their inevitable interrupted end has no normal lifecycle effect. */
  private rateLimits = new Map<string, { resetsAt: string | null; bucket: string | null }>();
  /** A CLI usage-limit refusal seen in a running session, recorded when that session ends. */
  private usageLimits = new Map<string, { resetsAt: string | null; message: string }>();
  /** Session ids whose end is being settled right now: a second delivery while the first settle runs is ignored. Cleared when the settle finishes; the row's `settled_at` then guards it. */
  private settled = new Set<string>();

  constructor(private d: LifecycleDeps) {
    this.workerTemplate = fs.readFileSync(path.join(d.config.promptsDir, 'worker.md'), 'utf8');
    this.criticTemplate = fs.readFileSync(path.join(d.config.promptsDir, 'critic.md'), 'utf8');
    d.bus.on('session:ended', (e) => {
      const limit = this.usageLimits.get(e.session.id);
      const role = e.session.role;
      // A session end with nothing to settle (a discussion or the orchestrator) is left alone, so its row is not marked settled.
      if (!limit && role !== 'worker' && role !== 'critic') return;
      // One settlement per session end: a second delivery of the same end (the race the manager's finish and a re-adopted process can both report) is ignored.
      if (!this.claimSettlement(e.session)) return;
      const fail = limit ? 'lifecycle: usage-limit end handling failed' : role === 'worker' ? 'lifecycle: session end handling failed' : 'lifecycle: critic end handling failed';
      // A session that ended on a CLI usage limit takes the account rate-limit path instead of the normal settle: it is
      // re-dispatched on the next usable candidate of its tier, never reopened as a worker or critic that failed.
      if (limit) this.usageLimits.delete(e.session.id);
      const settle = limit ? this.onUsageLimitEnded(e, limit) : role === 'worker' ? this.onWorkerEnded(e) : this.onCriticEnded(e);
      void settle.catch((err) => log.error(fail, err)).finally(() => { this.settled.delete(e.session.id); });
    });
    d.bus.on('event', (event) => {
      const payload = event.payload as { type?: string; resetsAt?: string | null; bucket?: string | null };
      const session = d.db.sessions.get(event.session_id);
      if (payload.type === 'usage_limit' && !this.usageLimits.has(event.session_id)) {
        const p = event.payload as { resetsAt: string | null; message: string };
        this.usageLimits.set(event.session_id, { resetsAt: p.resetsAt, message: p.message });
      }
      if (payload.type === 'rate_limit' && session && (session.role === 'worker' || session.role === 'critic')) {
        void this.onRateLimit(session, payload).catch((err) => log.error('lifecycle: rate limit handling failed', err));
      }
    });
  }

  /** A shutdown cancels queued pushes; a later merge pushes the current base, including these commits. */
  stopPendingBasePushes(): void {
    this.basePushesStopped = true;
    for (const pending of this.pendingBasePushes) clearImmediate(pending);
    this.pendingBasePushes.clear();
  }

  private enqueueBasePush(repo: Repo): void {
    if (this.basePushesStopped) return;
    let pending!: NodeJS.Immediate;
    pending = setImmediate(() => {
      this.pendingBasePushes.delete(pending);
      if (this.basePushesStopped) return;
      void (this.d.pushBase ?? pushBaseBranch)(repo.path, repo.base_branch).then(() => undefined, async (error: unknown) => {
        if (!(error instanceof GitPushError)) {
          log.error(`lifecycle: could not push ${repo.base_branch} for ${repo.id}`, error);
          return;
        }
        const command = `git push ${error.remote} ${error.branch}`;
        await this.d.notify(`Base push for ${repo.id} to ${error.remote} failed: ${error.firstLine}. Run \`${command}\` in ${repo.path}.`)
          .catch((noticeError) => log.error('lifecycle: base-push notify failed', noticeError));
      });
    });
    this.pendingBasePushes.add(pending);
  }

  /**
   * Claims a session end for settling, once. The in-memory `settled` set ignores a second delivery while the first settle is
   * still running; the row's `settled_at` ignores one delivered after a restart or from a re-adopted process, where the set is
   * empty again. Persisted at claim time, so a re-adopted session that already has a settled outcome recorded is not settled
   * again. Recovery marks a lost session `ended` and then settles it; the guard reads `settled_at`, never `status`, so that
   * recovery still settles a session that never was.
   */
  private claimSettlement(session: SessionRow): boolean {
    if (this.settled.has(session.id) || this.d.db.sessions.get(session.id)?.settled_at != null) {
      log.debug(`lifecycle: ignoring a second session end for ${session.id}; it is already being settled or was settled before`);
      return false;
    }
    this.settled.add(session.id);
    this.d.db.sessions.update(session.id, { settled_at: new Date().toISOString() });
    return true;
  }

  async spawnWorker(repoId: string, beadId: string, opts: SpawnOpts = {}): Promise<string> {
    const { db, store, sessions, config, notify } = this.d;
    const { instructions } = opts;
    let { batchId } = opts;
    if (opts.verifyCommand !== undefined && !opts.verifyOnly) throw new LifecycleError('verify_command requires verify_only: true');
    if (opts.verifyCommand !== undefined && !opts.verifyCommand.trim()) throw new LifecycleError('verify_command must not be blank');
    if (!(await store.available())) throw new LifecycleError('bd is not available');
    const repo = db.repos.get(repoId);
    if (!repo) throw new LifecycleError(`repo ${repoId} not found`);
    if (repo.verify_suspect != null) {
      const run = db.preflight.get(repo.verify_suspect);
      if (run) throw new LifecycleError(refusalText(run, repo.base_branch));
    }
    const bead = await store.show(repo.path, beadId);
    if (!bead) throw new LifecycleError(`bead ${beadId} not found in ${repoId}`);
    if (bead.status === 'closed') throw new LifecycleError(`bead ${beadId} is closed`);
    if (db.sessions.forBead(beadId).some((s) => s.status === 'running')) throw new LifecycleError(`bead ${beadId} already has a running session`);
    if (db.sessions.runningWorkersForRepo(repoId).length >= repo.worker_limit) throw new LifecycleError(`worker limit ${repo.worker_limit} reached for ${repoId}`);
    // The guard is checked and taken with no await in between, and held until the session row exists: a Retry verification
    // that starts while the worktree is being prepared would otherwise run the verify command in a tree a worker is about to enter.
    if (this.verifying.has(beadId)) throw new LifecycleError(`bead ${beadId} is busy: its branch is being verified, integrated or removed`);
    return this.guarded(beadId, async () => {
      // A tier resolves to a concrete model, skipping the models earlier workers on this bead already ran with; a harness with a tier
      // resolves among that tier's candidates of the harness only; a harness with no tier takes the first usable candidate of that
      // harness allowed by the repository model filter, so a forced session still records a model and, when configured, an account.
      // A continuation is the same attempt carried on rather than a fresh one, so it may land on the model that just ran.
      const priorModels = opts.continuation || opts.rateLimit ? [] : db.sessions.forBead(beadId).filter((s) => s.role === 'worker' && s.model).map((s) => s.model!);
      let run: { harness: HarnessName; model?: string; effort?: Effort; tier?: TierName; account?: string | null; harnessForced?: boolean };
      const filter = repo.model_filter;
      if (opts.harness && !opts.tier) {
        if (filter?.harnesses.length && !filter.harnesses.includes(opts.harness)) {
          throw new LifecycleError(`repository ${repo.id} model filter excludes harness ${opts.harness}`);
        }
        if (opts.model && filter?.models.length && !filter.models.includes(opts.model)) {
          throw new LifecycleError(`repository ${repo.id} model filter excludes model ${opts.model}`);
        }
      }
      // A forced harness, with or without a tier, is no exception: it provably cannot hold the server, so the dispatch is refused instead of started.
      if (opts.needsServer && opts.harness && NO_SERVER_HARNESSES.has(opts.harness)) {
        throw new LifecycleError(`${beadId} needs to run a server or a browser, so the forced harness ${opts.harness}${opts.tier ? ` in tier ${opts.tier}` : ''} was refused: ${NO_SERVER_HARNESSES.get(opts.harness)}`);
      }
      if (opts.tier || !opts.harness) {
        const tier = opts.tier ?? 'standard';
        const settings = filterRepoTiers(db.settings.tiers(), repo.model_filter);
        const selectedTier = opts.stepUp && !opts.harness ? tier === 'chore' ? 'standard' : tier === 'standard' ? 'hard' : tier : tier;
        if (repo.model_filter && !settings.tiers.find((entry) => entry.name === selectedTier)?.candidates.some((c) => !opts.harness || c.harness === opts.harness)) {
          throw new LifecycleError(`repository ${repo.id} model filter excludes every ${opts.harness ? `${opts.harness} ` : ''}candidate in tier ${selectedTier}`);
        }
        const unusableCandidates = await this.unusableCandidates(settings.tiers.flatMap((entry) => entry.candidates));
        // An automatic re-dispatch skips a harness this bead's latest worker there hung on (stopped for inactivity) or crashed at startup.
        const unusableHarnesses = new Map<HarnessName, string>(opts.automatic ? this.unusableHarnessesFor(beadId) : []);
        // A re-dispatch carrying the harness the previous session just failed on skips it, so the retry lands somewhere new.
        if (opts.avoidHarness) unusableHarnesses.set(opts.avoidHarness, `${opts.avoidHarness} ended the previous attempt without committing`);
        // A task that runs a server or a browser cannot work on a harness whose shell tool loses it, whichever tier picks it.
        if (opts.needsServer) for (const [harness, reason] of NO_SERVER_HARNESSES) unusableHarnesses.set(harness, reason);
        // A catalog with no copy read or fetched yet prices nothing, so it is treated as absent rather than fetched here.
        const prices = this.d.prices?.loaded?.() === false ? undefined : this.d.prices;
        let c;
        try { c = resolveTier(settings, tier, { previousModels: priorModels, model: opts.model, stepUp: opts.stepUp, available: this.d.harnessAvailable, unusableCandidates, unusableHarnesses, prices, harness: opts.harness }); }
        catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // A refused re-dispatch because the only remaining harness is unusable, or a forced harness with no usable candidate in its
          // tier, is reported to the caller as-is; only a tier-wide usage refusal gets the account note and notice.
          if (reason.startsWith('no usable harness for tier ') || opts.harness) throw new LifecycleError(reason);
          if (!reason.startsWith('no usable account for tier ')) throw err;
          await store.update(repo.path, beadId, { status: 'open', phase: null, note: reason });
          if (!opts.silentUsageRefusal && !opts.suppressDispatchNotices && !this.usageRefusals.has(beadId)) {
            this.usageRefusals.add(beadId);
            await notify(reason, { wake: true, hint: 'Ask the user to wait for account usage to reset, then dispatch the bead again.' }).catch((notifyError) => log.error('lifecycle: usage-gate notify failed', notifyError));
          }
          throw new LifecycleError(reason);
        }
        this.usageRefusals.delete(beadId);
        // A forced harness is not price-sorted, so it logs no cheapest pick.
        if ((tier === 'chore' || tier === 'standard') && priorModels.length === 0 && !opts.stepUp && !opts.harness) {
          const input = prices?.priceFor(c.harness, c.model)?.input;
          log.info(prices
            ? `lifecycle: ${beadId} ${tier} picked ${c.harness}/${c.model} at ${input === undefined ? 'no catalog price' : `$${input}/M input`} (cheapest usable)`
            : `lifecycle: ${beadId} ${tier} picked ${c.harness}/${c.model} in configured order: no price catalog is loaded`);
        }
        run = { harness: c.harness, model: c.model, effort: c.effort ?? undefined, tier, account: c.account, harnessForced: !!opts.harness };
      } else {
        // A forced harness pins the CLI, not its model or account. Without an explicit model it scans the standard, chore,
        // then hard tier for the first usable candidate of that harness allowed by the repository model filter, the same way a tier dispatch resolves one — same
        // usage and exhaustion rules, same fallback to the next usable account — so the worker runs on a configured account
        // (claude needs one to reach its plugin MCP servers) and the session records the model it chose instead of reading
        // "no model". With a model pinned (a crash or review retry) the model is kept and only the account is filled in. A
        // held harness still refuses first, as any forced harness does, rather than falling back; when the harness has no
        // usable candidate the dispatch keeps what it has — the pinned model of a retry, else the CLI's default, and the
        // account a retry recorded when it is still usable, else the CLI's own login — a degraded session rather than a
        // failed one, unless a repository model filter requires an allowed, usable candidate.
        const limited = harnessLimitReason(db, opts.harness);
        if (limited) throw new LifecycleError(`${beadId} was not dispatched: ${limited}`);
        let c;
        try { c = await this.forcedCandidate(opts.harness, opts.model, repo); }
        catch (err) {
          if (!(err instanceof LifecycleError) || !filter) throw err;
          const reason = err.message;
          await store.update(repo.path, beadId, { status: 'open', phase: null, note: reason });
          // Automatic retries report their refusal in the parent action's notice.
          if (!opts.automatic && !opts.silentUsageRefusal && !opts.suppressDispatchNotices && !this.usageRefusals.has(beadId)) {
            this.usageRefusals.add(beadId);
            await notify(reason, { wake: true, hint: 'Wait for an allowed candidate to become usable, then dispatch the bead again.' }).catch((notifyError) => log.error('lifecycle: usage-gate notify failed', notifyError));
          }
          throw err;
        }
        if (filter) this.usageRefusals.delete(beadId);
        const account = await this.usableForcedAccount(opts.harness, opts.model ?? c?.model ?? '', opts.account, filter);
        if (c) run = { harness: opts.harness, model: opts.model ?? c.model, effort: opts.model ? undefined : c.effort ?? undefined, account: account ?? c.account ?? null };
        else {
          const model = opts.model ? `pinned ${opts.model} model` : 'default model';
          const auth = account ? 'the account recorded on its last session' : 'the CLI login';
          log.warn(`lifecycle: no usable ${opts.harness} candidate in the standard, chore or hard tier; ${beadId} runs on the ${opts.harness} harness's ${model} and ${auth}`);
          run = { harness: opts.harness, model: opts.model, account };
        }
      }
      const existing = db.worktrees.get(beadId);
      // A bead created for a batch (labelled at creation) is dispatched into it unless told otherwise, and never into another: the label
      // stays, so it would count in both batches (fix round 15 review).
      const labelled = this.knownBatchOf(bead);
      if (labelled && batchId && labelled !== batchId) {
        const own = db.batches.get(labelled)!;
        // A label for a batch that is no longer open leaves the bead dispatchable nowhere; Close bead on its card is the way out (fix round 16 review).
        throw new LifecycleError(own.status === 'open' ? `bead ${beadId} was created for batch ${labelled}; dispatch it there or create a new bead for ${batchId}`
          : `bead ${beadId} was created for batch ${labelled}, which is ${own.status}; create a new bead for ${batchId}, and close this one from the Board (Close bead) if it is no longer wanted`);
      }
      batchId = batchId ?? existing?.batch_id ?? labelled ?? undefined; // a re-dispatch keeps the bead in its batch
      const batch = batchId ? db.batches.get(batchId) : undefined;
      if (batchId && (!batch || batch.repo_id !== repoId)) throw new LifecycleError(`batch ${batchId} not found in ${repoId}`);
      if (batch && batch.status !== 'open') throw new LifecycleError(`batch ${batchId} is ${batch.status}`);
      const held = batchId ? db.batchWaits.unreleasedForBatch(batchId)[0] : undefined;
      if (held) throw new LifecycleError(`batch ${batchId} is waiting on prerequisite batch ${held.prerequisite_batch_id} (${held.prerequisite_status ?? 'unknown'})`);
      const account = run.account ? db.accounts.get(run.account) : null;
      let env: NodeJS.ProcessEnv = {};
      let refreshError: string | null = null;
      let tokenExpiresAt: number | null = null;
      if (account) {
        try { env = await freshAccountEnv(db, config, account); tokenExpiresAt = envTokenExpiresAt(db, account); }
        catch (err) { refreshError = err instanceof Error ? err.message : String(err); }
      }
      const currentAccount = run.account ? db.accounts.get(run.account) : null;
      if (run.account && (refreshError || !currentAccount || !accountLoggedIn(currentAccount))) {
        const name = accountDisplayName(account) ?? run.account;
        const detail = refreshError ? ` ${refreshError}.` : '';
        await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Account ${name} is not logged in, so no worker was started.${detail}` });
        if (!opts.suppressDispatchNotices) await notify(`${beadId} was not dispatched: account ${name} is not logged in.${detail}`, { wake: true, hint: 'Ask the user to log in that account from Setup, then dispatch the bead again.' }).catch((err) => log.error('lifecycle: account-login notify failed', err));
        throw new LifecycleError(`account ${name} is not logged in; the user has been told`);
      }
      const base = batch?.branch ?? repo.base_branch;
      if (batch) {
        const batchWt = await ensureBranchWorktree(repo, batch.branch, batchWorktreePath(config.worktreesDir, repo.id, batch.id));
        // A batch worktree recreated here (its folder was gone) has no dependencies again: integrate() runs the setup command before the first merge.
        if (batchWt.created) db.batches.update(batch.id, { setup_at: null });
      }
      // A bead branch that already exists was cut before the batch branch moved on. Its own commits stay; the batch branch
      // as it is now is merged in below, so a re-dispatch starts from the batch tip rather than the stale base it was cut from.
      // A recorded conflict means that merge already failed and the bead was reopened for it: this dispatch starts no worker,
      // and the next re-dispatch starts one to resolve it (the prompt carries the files), so the merge is not retried on top of it.
      const branchExisted = !!batch && !!(await git(repo.path, ['branch', '--list', branchFor(beadId)]));
      const resolvingConflict = !!existing?.conflict_files?.length;
      // The batch worktree above already pruned this repository and the branch check just ran: the bead worktree is ensured
      // without a second prune and without listing the bead branch again.
      const wt = await ensureWorktree(repo, beadId, config.worktreesDir, base, batch ? { prune: false, branchExists: branchExisted } : {});
      if (wt.created && repo.setup_command) {
        const failed = await this.setup(repo, wt.path);
        if (failed) {
          // The folder goes, so the next dispatch runs the command again in a fresh worktree; the bead reads why on the Board.
          try { await removeWorktreeRetry(repo.path, wt.path, wt.branch); } catch (err) { log.error(`lifecycle: could not remove ${wt.path} after a failed setup`, err); }
          await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Setup failed in the bead's worktree, so no worker was started:\n${failed.slice(-2000)}` });
          this.signal(batch?.id, beadId, 'reopen', reopenText('setup_failed', `the ${setupLabel(repo)} failed in the bead's worktree`));
          if (!opts.suppressDispatchNotices) await notify(`${beadId} was not dispatched: the ${setupLabel(repo)} failed in its worktree.\n${failed.slice(-600)}`, { wake: true, hint: 'The command is the repo\'s setup command from Setup, not the work; tell the user to fix it there and dispatch the bead again afterwards.' }).catch((err) => log.error('lifecycle: setup-fail notify failed', err));
          throw new LifecycleError(`the ${setupLabel(repo)} failed in the worktree of ${beadId}; the user has been told`);
        }
      }
      if (branchExisted && !resolvingConflict) {
        const merged = await mergeInto(wt.path, base, mergeMessage({ target: wt.branch, id: beadId, title: bead?.title ?? beadId, source: base }));
        if (!merged.ok) {
          const files = merged.conflicts.join(', ');
          if (existing) db.worktrees.update(beadId, { conflict_files: merged.conflicts });
          await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Merging ${base} into ${wt.branch} conflicted in: ${files}; no worker was started.` });
          this.signal(batch!.id, beadId, 'reopen', reopenText('merge_conflict', files));
          if (!opts.suppressDispatchNotices) await notify(`${beadId} was not dispatched: merging ${base} into ${wt.branch} conflicted in: ${files}. Re-dispatch with spawn_worker (same batch_id); the next worker is started to rebase the branch and resolve those files.`, { wake: true }).catch((err) => log.error('lifecycle: dispatch-conflict notify failed', err));
          throw new LifecycleError(`merging ${base} into ${wt.branch} conflicted in: ${files}`);
        }
      }
      const conflicts = existing?.conflict_files ?? [];
      // A failed verification survives the re-dispatch: it is the state of the branch this worker starts on, so a worker stopped
      // before it commits leaves the bead in Ready still saying "verify failed" instead of silently losing it (round 21 R21-1).
      // A pass does not survive: it belongs to commits the new worker is about to change, and `request_merge` reads it.
      const keptFail = existing?.verify_status === 'fail';
      // The worktree's uncommitted state at creation, after its setup command ran and before the worker starts, is stored on the
      // row so a later session-end can subtract the repo's own generated files (its setup output) from what the worker left
      // behind. A re-dispatch keeps the snapshot from creation, because the previous attempt's leftovers must still count, and
      // the row persists it across a daemon restart (overseer-gk52).
      const createdDirty = wt.created ? await uncommittedWork(wt.path) : existing?.created_dirty;
      const verifyCommand = opts.verifyOnly ? opts.verifyCommand ?? existing?.verify_command ?? null : null;
      db.worktrees.upsert({ bead_id: beadId, repo_id: repoId, path: wt.path, branch: wt.branch, base_branch: base, verify_status: keptFail ? 'fail' : null, verify_output: keptFail ? existing!.verify_output : null, verify_command: verifyCommand, verify_only_result: null, review_note: null, conflict_files: existing?.conflict_files ?? null, merged_at: null, mr_url: null, batch_id: batch?.id ?? null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, created_dirty: createdDirty, evidence_gate_failures: opts.automatic ? (existing?.evidence_gate_failures ?? 0) : 0 });
      const prompt = buildWorkerPrompt(this.workerTemplate, { bead, branch: wt.branch, base, conflicts, instructions });
      if (instructions) this.lastInstructions.set(beadId, instructions); else this.lastInstructions.delete(beadId);
      // A re-dispatch appends a note, so earlier stop / failure / rejection notes read as history rather than the current state.
      const redispatch = db.sessions.forBead(beadId).length > 0;
      await store.update(repo.path, beadId, { status: 'in_progress', phase: null, ...(redispatch ? { note: `Re-dispatched to ${run.harness}` } : {}) });
      if (redispatch) this.signal(batch?.id, beadId, 'redispatch', instructions ?? '');
      const startCommit = await headCommit(wt.path);
      // A continuation carries the previous worker's own session on, so it applies the findings instead of reading the branch again.
      // Only the very same CLI and model can be resumed. An empty or missing native id leaves nothing to resume — codex and opencode
      // report `''` when the CLI gave them no thread, and a session that died before its first turn ended has null — so the dispatch
      // starts afresh rather than passing an empty id to `--resume`.
      const last = db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1);
      const resumeId = opts.continuation && last?.harness === run.harness && last.model === run.model ? last.native_session_id || undefined : undefined;
      const session = sessions.start({ role: 'worker', harness: run.harness, tier: run.tier, model: run.model, effort: run.effort, repoId, beadId, beadTitle: bead.title, cwd: wt.path, prompt, startCommit, batchId: batch?.id, verifyOnly: !!opts.verifyOnly, needsServer: !!opts.needsServer, harnessForced: !!run.harnessForced, denyBackground: true, resumeId, account: run.account ?? null, tokenExpiresAt, mcpServers: [{ name: 'overseer', url: `http://127.0.0.1:${config.port}/mcp` }], env });
      this.d.bus.emit('board');
      return session.id;
    });
  }

  /**
   * The candidates whose account is at its usage limit or exhausted, whose account-less harness is held by a usage limit, or
   * that are account-less opencode candidates the CLI's own login holds no provider key for, keyed by `candidateUsageKey`, each
   * with the reason.
   */
  private async unusableCandidates(candidates: TierCandidate[], sessionIdToExclude?: string): Promise<Map<string, string>> {
    const { db, config } = this.d;
    const unusable = new Map<string, string>();
    await Promise.all(candidates.map(async (candidate) => {
      // Such a session exits 1 on its first request with a bare UnknownError, so it is skipped rather than started (2026-09-28).
      if (candidate.harness === 'opencode' && !candidate.account && this.d.opencodeLoginReaches && !this.d.opencodeLoginReaches(candidate.model)) {
        unusable.set(candidateUsageKey(candidate), `opencode ${candidate.model} has no account and the opencode login holds no key for its provider`);
        return;
      }
      const accountId = candidate.account ?? candidate.harness;
      if (!db.accounts.get(accountId)) { const reason = harnessLimitReason(db, candidate.harness); if (reason) unusable.set(candidateUsageKey(candidate), reason); return; }
      const check = this.d.usageGate ?? accountUsable;
      const gate = sessionIdToExclude
        ? await check(db, config, accountId, candidate.model, this.d.doctorRunner, undefined, sessionIdToExclude)
        : await check(db, config, accountId, candidate.model, this.d.doctorRunner);
      if (!gate.usable) unusable.set(candidateUsageKey(candidate), gate.reason);
    }));
    return unusable;
  }

  /**
   * The first usable candidate allowed by the repository model filter of a forced `harness`, scanning the standard, chore then hard tier in order, or null when that
   * harness has no candidate there or every one of them is denied, exhausted or points at an account that has no authorization
   * yet. A forced dispatch takes it for its model and account, so the worker runs on a configured account (claude needs one to
   * load its plugin MCP servers) and the session records the model it chose; null leaves the dispatch on the CLI's own default
   * model and login, a degraded session rather than a failed one, only without a repository model filter.
   */
  private async forcedCandidate(harness: HarnessName, pinnedModel: string | undefined, repo: Repo): Promise<TierCandidate | null> {
    const settings = filterRepoTiers(this.d.db.settings.tiers(), repo.model_filter);
    const deny = new Set(settings.denyModels);
    const candidates = FORCED_TIERS.flatMap((name) => settings.tiers.find((t) => t.name === name)?.candidates ?? [])
      .filter((c) => c.harness === harness && !deny.has(c.model));
    // A pinned model (a crash or review retry keeping the same model) is what the session actually runs on, so every
    // candidate's usage is gated on that model rather than its own tier-configured one; an account usable for its
    // configured model can still be at the threshold for the pinned model it would actually run.
    const effective = (c: TierCandidate): TierCandidate => (pinnedModel ? { ...c, model: pinnedModel } : c);
    const unusable = await this.unusableCandidates(candidates.map(effective));
    for (const candidate of candidates) {
      if (unusable.has(candidateUsageKey(effective(candidate)))) continue;
      // An account row exists from the moment it is created, before its authorization is stored; picking it would make the later
      // login check fail the dispatch, so it is skipped like an exhausted one and the next candidate (or the CLI login) is used.
      if (!candidate.account) return candidate;
      const account = this.d.db.accounts.get(candidate.account);
      if (!account || !accountLoggedIn(account)) continue;
      // A revoked authorization leaves the stored access token in place, so only the refresh a session start performs can tell
      // that the account is dead; skip it here rather than let `freshAccountEnv` refuse the dispatch after the worktree was made.
      if (!(await this.accountCredentialsUsable(account))) continue;
      return candidate;
    }
    if (repo.model_filter) {
      const reasons = [...new Set(unusable.values())];
      throw new LifecycleError(`repository ${repo.id} model filter leaves no usable ${harness} candidate${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
    }
    return null;
  }

  private async usableForcedAccount(harness: HarnessName, model: string, accountId: string | null | undefined, filter: Repo['model_filter']): Promise<string | null> {
    if (!accountId) return null;
    if (filter?.accounts.length && !filter.accounts.includes(accountId)) return null;
    const account = this.d.db.accounts.get(accountId);
    if (!account || !accountLoggedIn(account)) return null;
    const candidate: TierCandidate = { harness, model, effort: null, account: accountId };
    if ((await this.unusableCandidates([candidate])).has(candidateUsageKey(candidate))) return null;
    return (await this.accountCredentialsUsable(account)) ? accountId : null;
  }

  /**
   * Whether an account's stored authorization can actually be used right now. `accountLoggedIn` only sees that a secret is on
   * the row, and a usage probe deliberately tolerates a refresh error, so neither notices a revoked or expired Claude OAuth
   * grant whose access token is still stored. `freshAccountEnv` refreshes such a token before the session starts and throws
   * when the refresh fails, which would refuse the dispatch after the worktree was prepared; selection probes the same refresh
   * here and falls through to the next candidate instead. The credentials never leave this method.
   */
  private async accountCredentialsUsable(account: StoredAccount): Promise<boolean> {
    try { await refreshClaudeOAuth(this.d.db, this.d.config, account); return true; }
    catch { return false; }
  }

  /**
   * Parks an account whose grant is really gone: a session ended on the structured auth signal and the resume that would
   * normally recover it could not start (the refresh token was rejected, the account was already parked, or the resumed
   * session was rejected again). Unlike a usage limit the account does not recover on its own, so it is parked with
   * `exhausted_until` at `AUTH_HOLD_UNTIL` (far in the future) and routing skips it the way it skips an exhausted account
   * until the user logs it in again; a successful login or verify lifts the hold (`clearAuthHold`). One notice names the
   * account and asks for the re-login; a second failure on the already-parked account stays quiet. A session on the CLI's
   * own login has no account to park.
   */
  private async parkAuthAccount(session: SessionRow): Promise<void> {
    const { db, notify } = this.d;
    const account = session.account ? db.accounts.get(session.account) : undefined;
    if (!account || account.exhausted_until === AUTH_HOLD_UNTIL) return;
    db.accounts.update(account.id, { exhausted_until: AUTH_HOLD_UNTIL });
    const name = accountDisplayName(account) ?? account.id;
    await notify(`${sessionWho(db, session)} could not authenticate (${session.id}); log in to that account again from Setup, or dispatches skip it.`, {
      hint: `Log in to ${name} again from Setup → Accounts; until then dispatches skip it like an exhausted account.`,
      beadId: session.bead_id ?? undefined,
    }).catch((err) => log.error('lifecycle: auth-failure notify failed', err));
  }

  /**
   * The environment to resume a session on after its account rejected the token: the account's current one, or null when
   * there is nothing to resume with. A token rollover leaves a newer grant stored, and even a refresh that returns the
   * refresh that succeeds proves it is alive. When the stored expiry still equals the session's, the stored token is the one
   * just rejected, so the refresh is forced past the margin rather than handing that token back. Only a rejected refresh
   * (or an account already parked, or a session that is itself an auth resume) yields null, and the caller parks instead.
   */
  private async freshEnvForResume(session: SessionRow, account: StoredAccount): Promise<{ env: NodeJS.ProcessEnv; tokenExpiresAt: number | null } | null> {
    const { db, config } = this.d;
    const current = db.accounts.get(account.id) ?? account;
    if (current.exhausted_until === AUTH_HOLD_UNTIL || session.auth_resumed === 1) return null;
    const rejectedIsStored = (session.token_expires_at ?? null) === (current.token_expires_at ?? null);
    try { return { env: await freshAccountEnv(db, config, current, rejectedIsStored), tokenExpiresAt: envTokenExpiresAt(db, current) }; }
    catch { return null; }
  }

  /**
   * Resumes a worker that ended on the structured auth signal instead of parking its account: the same native session,
   * worktree, bead, batch and account are reused with the account's refreshed environment and a short continue prompt, so
   * the bead stays in progress and no re-dispatch is signalled. An unavailable refresh or native session parks as before;
   * a usage refusal skips the resume without parking the refreshed account.
   */
  private async resumeWorkerAfterAuth(session: SessionRow, account: StoredAccount | undefined): Promise<'resumed' | 'unavailable' | { usageBlocked: string }> {
    const { db, sessions, config, notify } = this.d;
    if (!account || !session.bead_id || !session.native_session_id) return 'unavailable';
    const wt = db.worktrees.get(session.bead_id);
    if (!wt) return 'unavailable';
    const grant = await this.freshEnvForResume(session, account);
    if (!grant) return 'unavailable';
    const gate = await (this.d.usageGate ?? accountUsable)(db, config, account.id, session.model ?? '', this.d.doctorRunner, undefined, session.id);
    if (!gate.usable) return { usageBlocked: gate.reason };
    const prompt = "Your previous turn ended because this account's login token had expired and was replaced mid-run; it has since been refreshed. Continue the task from where you stopped. Check the worktree's current state first, and do not redo work that is already committed.";
    sessions.start({
      role: 'worker', harness: session.harness, tier: session.tier ?? undefined, model: session.model ?? undefined,
      repoId: session.repo_id ?? undefined, beadId: session.bead_id, beadTitle: session.bead_title ?? null,
      cwd: wt.path, prompt, startCommit: session.start_commit, batchId: session.batch_id,
      verifyOnly: !!session.verify_only, needsServer: this.needsServerFor(session.bead_id), harnessForced: !!session.harness_forced, denyBackground: true,
      resumeId: session.native_session_id, account: session.account ?? null, tokenExpiresAt: grant.tokenExpiresAt,
      mcpServers: [{ name: 'overseer', url: `http://127.0.0.1:${config.port}/mcp` }], env: grant.env, authResumed: true,
    });
    await notify(`${session.bead_id} resumed after its login token rolled over on ${sessionWho(db, session)}.`, {
      hint: 'The session resumed on the refreshed login; no action is needed.', beadId: session.bead_id,
    }).catch((err) => log.error('lifecycle: auth-resume notify failed', err));
    return 'resumed';
  }

  private async onWorkerEnded(e: SessionEnded): Promise<void> {
    try { await this.settleWorker(e); } finally { this.d.bus.emit('board'); }
  }

  /** Stop a Claude worker/critic at the first limit signal, then route the same bead through the normal account picker. */
  private async onRateLimit(session: SessionRow, event: { resetsAt?: string | null; bucket?: string | null }): Promise<void> {
    if (!session.bead_id || !session.repo_id || this.rateLimits.has(session.id)) return;
    const { db, sessions } = this.d;
    const repo = db.repos.get(session.repo_id);
    const wt = db.worktrees.get(session.bead_id);
    const account = session.account ? db.accounts.get(session.account) : undefined;
    if (!repo || !wt || !account) return;
    const resetsAt = event.resetsAt ?? null;
    const exhaustedUntil = resetsAt ? Date.parse(resetsAt) : Date.now() + 5 * 60 * 60 * 1000;
    const resetText = new Date(exhaustedUntil).toLocaleString();
    const bucket = event.bucket ? ` (${event.bucket})` : '';
    const fallback = resetsAt ? '' : '; reset time was not supplied, using a five-hour hold';
    this.rateLimits.set(session.id, { resetsAt, bucket: event.bucket ?? null });
    db.accounts.update(account.id, { exhausted_until: exhaustedUntil });
    await sessions.interrupt(session.id, { by: 'orchestrator', reason: 'account usage limit' });
    await this.redispatchExhausted(session, {
      who: `account ${accountDisplayName(account)}`,
      resetText,
      note: `Account ${accountDisplayName(account)} hit its usage limit${bucket}, resets ${resetText}${fallback}; re-dispatching on another account`,
      reason: `account ${accountDisplayName(account)} hit its usage limit${bucket}`,
    });
  }

  /** Holds the session's account, or its harness when it ran on the CLI's own login, until the reported reset (one hour when unreadable). */
  private recordUsageLimit(session: SessionRow, limit: { resetsAt: string | null; message: string }): { who: string; until: number } {
    const { db, notify } = this.d;
    const parsed = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    const until = Number.isFinite(parsed) ? parsed : Date.now() + 60 * 60 * 1000;
    const account = session.account ? db.accounts.get(session.account) : undefined;
    if (account) db.accounts.update(account.id, { exhausted_until: until });
    else setHarnessLimit(db, session.harness, until);
    const name = accountDisplayName(account) ?? session.harness;
    const who = account ? `${session.harness} account ${name}` : session.harness;
    const fallback = Number.isFinite(parsed) ? '' : ` (the reset time could not be read from "${limit.message}", so it is held for one hour)`;
    // Only the one account is held in the account branch: the harness's other accounts and its own login stay usable, so the
    // hint must not steer the orchestrator away from the harness as a whole.
    const hint = account
      ? `Dispatches skip account ${name} until then; this harness's other accounts and the CLI's own login stay usable.`
      : 'Dispatches skip this harness until then; pick another harness or wait.';
    void notify(`${who} hit its usage limit in session ${session.id}; it is skipped until ${new Date(until).toISOString()}${fallback}.`, { hint })
      .catch((err) => log.error('lifecycle: usage-limit notify failed', err));
    return { who, until };
  }

  /**
   * A session that ended on a CLI usage limit: hold its account or harness, then re-dispatch on the next candidate of its tier.
   * A session stopped on purpose, and one whose batch was abandoned or merged meanwhile, keeps the normal settle instead — the
   * re-dispatch would otherwise override a stop's "do not re-dispatch it" rule or resurrect a bead the batch already closed.
   */
  private async onUsageLimitEnded(e: SessionEnded, limit: { resetsAt: string | null; message: string }): Promise<void> {
    const { db } = this.d;
    const { session } = e;
    const wt = session.bead_id ? db.worktrees.get(session.bead_id) : undefined;
    const batchStatus = wt?.batch_id ? db.batches.get(wt.batch_id)?.status : undefined;
    const settled = !!this.stopOf(e) || batchStatus === 'abandoned' || batchStatus === 'merged';
    const { who, until } = this.recordUsageLimit(session, limit);
    if (settled) {
      if (session.role === 'worker') return this.onWorkerEnded(e);
      if (session.role === 'critic') return this.onCriticEnded(e);
      return;
    }
    const resetText = new Date(until).toLocaleString();
    await this.redispatchExhausted(session, {
      who,
      resetText,
      note: `${who} hit its usage limit, resets ${resetText}; re-dispatching on another candidate`,
      reason: `${who} hit its usage limit`,
    });
  }

  /**
   * Re-dispatch a session that ended on an exhausted account or harness, through the same picker a fresh dispatch uses: a
   * tiered worker starts afresh on the next usable candidate of its tier, a forced one (tier null) on the next usable candidate
   * of its harness, a critic re-runs its current review round. When no candidate survives, the bead stays Ready and the notice
   * names what is held and its reset. `who` names the held account or harness; `note` is the state on the bead's row while it waits.
   */
  private async redispatchExhausted(session: SessionRow, opts: { who: string; resetText: string; note: string; reason: string }): Promise<void> {
    const { db, store, notify, bus } = this.d;
    const repo = session.repo_id ? db.repos.get(session.repo_id) : undefined;
    const wt = session.bead_id ? db.worktrees.get(session.bead_id) : undefined;
    if (!repo || !wt || !session.bead_id) return;
    const beadId = session.bead_id;
    const critic = session.role === 'critic';
    try {
      // A worker goes back through Ready before its fresh session starts. A critic only re-runs its current round, so its bead
      // keeps the `in_progress`/`verifying` row: writing Ready first would flash the card open between the two writes and record
      // a reopen signal the retrospective would then report as a real reopening.
      if (!critic) {
        await store.update(repo.path, beadId, { status: 'open', phase: null, note: opts.note });
        this.signal(wt.batch_id, beadId, 'reopen', reopenText('stopped', opts.reason));
      }
      try {
        let next: SessionRow | undefined;
        if (!critic) {
          // A forced session (tier null, harness set) goes back through the forced-harness route, where a fresh forced dispatch
          // picks the first usable candidate of that CLI (`FORCED_TIERS`): it stays on its CLI and takes the next usable
          // account of it instead of the standard tier, which could re-dispatch it on another harness and lose the account
          // the forced CLI needs. A harness forced with a tier stays on that harness among that tier's candidates. A tiered session
          // keeps its tier exactly as before.
          const how = retryRoute(session);
          const id = await this.spawnWorker(repo.id, beadId, { ...how, verifyOnly: !!session.verify_only, needsServer: this.needsServerFor(beadId), batchId: session.batch_id ?? undefined,
            instructions: this.lastInstructions.get(beadId), rateLimit: true, silentUsageRefusal: true, automatic: true });
          next = db.sessions.get(id);
        } else {
          // A critic limit re-runs that same review round. It does not create a worker attempt or advance the review round.
          await store.update(repo.path, beadId, { status: 'in_progress', phase: 'verifying', note: opts.note });
          const previous = db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1);
          await this.startReview(repo, wt, beadId, previous ? { model: previous.model, text: previous.last_text ?? null } : null, true, false, session.id);
          next = this.activeCritic(beadId);
        }
        const nextName = next?.account ? accountDisplayName(db.accounts.get(next.account)) ?? next.account : next?.harness ?? 'another account';
        await notify(`${beadId} re-dispatched: ${opts.who} exhausted until ${opts.resetText}, now on ${nextName}.`, { hint: 'This automatic re-dispatch needs no action.', beadId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // The automatic re-dispatch can also be refused because the only harness left is unusable for this bead; that is not an account or harness waiting on a reset.
        const harnessRefusal = reason.startsWith('no usable harness for tier ');
        const note = harnessRefusal ? `${opts.who} exhausted until ${opts.resetText}; ${reason}`
          : `${opts.who} exhausted until ${opts.resetText}; no usable account left: ${reason}`;
        await store.update(repo.path, beadId, { status: 'open', phase: null, note });
        // The worker path already signalled its reopen before trying the dispatch; a critic only reaches Ready here, so without
        // this signal the batch retrospective would miss its reopening.
        if (critic) this.signal(wt.batch_id, beadId, 'reopen', reopenText('stopped', opts.reason));
        if (harnessRefusal) {
          await notify(`${beadId} re-dispatched: ${opts.who} exhausted until ${opts.resetText}, and no harness left is usable: ${reason}.`, { wake: true, hint: 'The account is exhausted and the remaining harness is unusable for this bead; wait for the reset, then dispatch the bead again or pick another harness in Setup.' });
          return;
        }
        const filterReason = reason.startsWith(`repository ${repo.id} model filter `) ? ` ${reason}.` : '';
        await notify(`${beadId} re-dispatched: ${opts.who} exhausted until ${opts.resetText}, no usable account left; waiting.${filterReason}`, { wake: true, hint: 'Ask the user to wait for account usage to reset, then dispatch the bead again.' });
      }
    } finally {
      bus.emit('board');
    }
  }

  private async settleWorker(e: SessionEnded): Promise<void> {
    const { db, store, notify } = this.d;
    const { session } = e;
    if (this.rateLimits.delete(session.id)) return;
    const stopped = this.stopOf(e);
    this.stops.delete(session.id);
    const repo = session.repo_id ? db.repos.get(session.repo_id) : undefined;
    const wt = session.bead_id ? db.worktrees.get(session.bead_id) : undefined;
    if (!repo || !wt || !session.bead_id) return;
    // Worktree rows outlive their folders once a batch is finished; a session ending against one has nothing to settle.
    const batchStatus = wt.batch_id ? db.batches.get(wt.batch_id)?.status : undefined;
    if (batchStatus === 'abandoned' || batchStatus === 'merged') return;
    // A rejected token is usually a rollover, not a dead account: the account's stored grant may already be newer, and a
    // refresh that still succeeds proves it is alive. A session ending on the structured auth signal is resumed on the
    // account's current environment first, and only a rejected refresh (or a resume rejected again) parks it. The signal
    // is structured only: matching a 401 in the session's own text parked a healthy account that merely quoted a probe
    // (overseer-a8uq, 2026-09-23). The exit reason's text is still read for a session on the CLI's own login, which has no
    // account to park.
    const authAccount = session.account ? db.accounts.get(session.account) : undefined;
    const authFailed = e.authFailed === true || (!authAccount && isAuthFailure(e.lastError));
    // A stop the user or the orchestrator asked for wins: a stopped worker is settled as a stop below, never resumed, and its
    // account is not parked either, since the stop cut the recovery short before anything showed the login is gone.
    if (authFailed && !stopped) {
      const resumed = await this.resumeWorkerAfterAuth(session, authAccount);
      if (resumed === 'resumed') return;
      if (resumed === 'unavailable') await this.parkAuthAccount(session);
      else e = { ...e, lastError: `${e.lastError ?? 'authentication failed'}; auth resume skipped: ${resumed.usageBlocked}` };
    }
    const commits = session.start_commit ? await commitsSince(wt.path, session.start_commit) : 0;
    // A stop someone asked for is recorded as a stop, never as a failure with the worker's last sentence as its reason (round 9).
    const byUser = stopped?.by === 'user';
    // The model's reason usually ends in a full stop; the note and the notice add their own punctuation after it (round 10: ".;").
    const why = trimEndStop(stopped?.reason ?? '');
    const reason = why ? `: ${why}` : '';
    const stopBy = byUser ? 'the user from the Board' : `the orchestrator${reason}`;
    const stopHint = byUser ? 'Do not re-dispatch it unless the user asks.' : 'You interrupted this worker; do not re-dispatch it unless the user asks.';
    if (commits === 0 && stopped) {
      await store.update(repo.path, session.bead_id, { status: 'open', phase: null, note: `Stopped by ${stopBy} (worker session ${session.id}, no new commits)` });
      this.signal(wt.batch_id, session.bead_id, 'reopen', reopenText('stopped', `stopped by ${stopBy}`));
      await notify(`${session.bead_id} stopped by ${stopBy}; reopened without new commits.`, { hint: stopHint }).catch((err) => log.error('lifecycle: stop notify failed', err));
      return;
    }
    // The worker had committed before the stop reached it, so the rules below land its work instead of reopening the bead: the
    // bead's History and the thread say so, since the Board promised Ready and the only other record was the collapsed Trace
    // (round 20 R20-1). Informational: the notice for whatever the work does next wakes the orchestrator.
    if (stopped) {
      // Neither line names `bead/<id>`: it is deleted the moment the bead integrates, so the History entry would outlive the branch
      // it points at (fix round 20 review NB-C). The note is informational, and a bd hiccup on it must not abort the settle and
      // strand the bead in "settling..." with Close bead refusing it (fix round 20 review NB-A).
      await store.update(repo.path, session.bead_id, { note: `Stopped by ${stopBy} (worker session ${session.id}), after it had committed: its commits are kept and the bead goes on to verification` })
        .catch((err) => log.error('lifecycle: stop-after-commit note failed', err));
      await notify(`${session.bead_id} stopped by ${stopBy} after it had already committed; its commits are kept and the bead goes on to verification instead of back to Ready.`, { hint: stopHint }).catch((err) => log.error('lifecycle: stop-after-commit notify failed', err));
    }
    // What counts is the branch, not this session: a re-dispatched worker that finds the earlier commit correct and adds
    // nothing leaves a branch that still has to be verified, not a bead to reopen for "no commits". A worker the daemon
    // lost is the exception: it was interrupted, not finished, so the bead reopens with the restart note whatever the
    // branch holds (the earlier commits stay available to Retry verification and Re-dispatch).
    // Only real work lands: a branch whose commits are all merges, or whose net diff against its base is empty, reopens too.
    const crashed = e.lastError?.startsWith(RESTART_REASON) ?? false;
    const missing = await nothingToLand(wt.path, wt.base_branch);
    // A verification-only worker is meant to commit nothing. A configured command is run here; without one the worker's Check lines
    // remain the only result and a passing close is labelled worker-reported. Every reason `nothingToLand` gives counts: a
    // re-dispatched bead's branch carries the merge commits of earlier batch-branch refreshes (acme-portal-sample-046, 2026-09-26).
    const finalText = e.lastText?.trim();
    if (missing && session.verify_only && !crashed) {
      const checks = parseCheckLines(finalText ?? '');
      const result = wt.verify_command ? await this.runVerifyOnlyCommand(wt, wt.verify_command) : undefined;
      const incomplete: string[] = [];
      if (result?.status === 'fail') {
        const exitLabel = result.exit_code === null ? (result.output_tail.includes('(timed out)') ? 'unavailable (timed out)' : 'unavailable') : String(result.exit_code);
        const sameCommandPasses = checks.checkLines.filter((line) => checkPassesCommand(line, result.command));
        incomplete.push([
          `daemon verify command \`${result.command}\` failed with exit code ${exitLabel} at ${result.head_sha}.`,
          `Daemon output tail:\n${result.output_tail.split(/\r?\n/).map((line) => `> ${line}`).join('\n')}`,
          ...(checks.nonPassLines.length ? [`the following Check: lines did not PASS:\n${checks.nonPassLines.map((line) => `> ${line}`).join('\n')}`] : []),
          ...(sameCommandPasses.length ? [`Worker-reported PASS for the same command:\n${sameCommandPasses.map((line) => `> ${line}`).join('\n')}`] : []),
        ].join('\n'));
      } else if (checks.nonPassLines.length && (result !== undefined || !e.lastError)) {
        incomplete.push(`the following Check: lines did not PASS:\n${checks.nonPassLines.map((line) => `> ${line}`).join('\n')}`);
      } else if (!result && !checks.pass && !e.lastError) {
        incomplete.push(checks.checkLines.length === 0
          ? 'no Check: lines were reported.'
          : `the following Check: lines did not PASS:\n${checks.nonPassLines.map((line) => `> ${line}`).join('\n')}`);
      }

      // A stop wins, as do the existing crash paths that already have no close to gate. A command failure is still checked
      // so one reopen can report both independent failures.
      const shouldCheckEvidence = !stopped && (result !== undefined || checks.pass || !e.lastError);
      if (shouldCheckEvidence) {
        const bead = await store.show(repo.path, session.bead_id);
        if (!bead) throw new LifecycleError(`bead ${session.bead_id} not found`);
        const evidence = evaluateEvidence({ description: bead.description ?? '', finalText: finalText ?? '', headSha: await headCommit(wt.path), worktreePath: wt.path });
        if (!evidence.ok) {
          const numbered = evidence.problems.map((problem, index) => `${index + 1}. ${problem}`).join('\n');
          incomplete.push(`Evidence gate: ${evidence.problems.length} problem(s):\n${numbered}`);
        }
      }

      if (incomplete.length) {
        await this.reopenVerifyOnly(repo, wt, session, incomplete.join('\n'));
        return;
      }
      if (result || checks.pass) {
        await this.closeVerifyOnly(repo, wt, session, finalText ?? '', result);
        return;
      }
    }
    if (missing || (commits === 0 && crashed)) {
      db.sessions.update(session.id, { status: 'failed' });
      // A worker whose final message hands the work to something still running (a background agent, a later result) is not the
      // ordinary no-commit ending: nothing will come back for the work, so it is re-dispatched at once on another harness. Only
      // the final text decides, never timing; a worker the daemon lost (`crashed`) is excluded because its text is stale.
      const deferred = crashed || missing !== 'no commits' ? null : deferredWorkSentence(e.lastText);
      if (deferred) { await this.redispatchDeferred(repo, wt, session, deferred); return; }
      const why = missing && missing !== 'no commits' ? ` (${missing})` : '';
      // Both when both exist: the exit reason says what killed the session, the last text says how far the worker got.
      let reason = e.lastError ? (e.lastText ? `${e.lastError}; last message: ${e.lastText}` : e.lastError) : e.lastText ?? 'no output';
      // A worker that exits non-zero before its first event died at startup (a CLI that rejected an argument, 2026-09-15: four codex
      // workers in a row); the answer is on the first lines of its stderr, so the note carries them instead of the bare exit code.
      let stderr: string | null = null;
      if (e.lastError && /exited with code \d+$/.test(e.lastError) && !e.lastText && session.log_path) {
        const startupEvents = db.events.existsOfTypes(session.id, ['assistant_text', 'tool_call', 'tool_result', 'file_change']);
        stderr = startupEvents ? null : stderrHead(session.log_path + '.err');
        if (stderr) reason = `${e.lastError}: ${stderr}`;
      }
      // Classifying why the worker crashed (not simply "no commits") lets a transient stream failure retry itself once and
      // keeps the orchestrator from re-dispatching a harness bug that will only fail again the same way. An account
      // session's auth crash is the structured signal above; only the CLI's own login (no account) still classifies from
      // the exit reason's text, because there is no account to park and no other signal to trust.
      const crashClass = !crashed ? (authFailed ? 'auth' : e.lastError ? classifyExit(e.lastError, stderr, !authAccount) : null) : null;
      if (crashClass) {
        db.sessions.update(session.id, { crash_class: crashClass });
        this.signal(wt.batch_id, session.bead_id, 'crash', `${crashClass}: ${reason}`);
      }
      const previousWorker = db.sessions.forBead(session.bead_id).filter((s) => s.role === 'worker' && s.id !== session.id).at(-1);
      if (crashClass === 'transient' && previousWorker?.crash_class !== 'transient') {
        try {
          // A fresh dispatch, not a continuation: `session.model` pins the retry to the exact model the crashed session ran
          // on, whether or not it was the tier's top candidate; `continuation` would let tier resolution re-pick and land on
          // a different one.
          const how: SpawnOpts = { ...retryRoute(session), model: session.model ?? undefined };
          await this.spawnWorker(repo.id, session.bead_id, { ...how, verifyOnly: !!session.verify_only, needsServer: this.needsServerFor(session.bead_id), batchId: session.batch_id ?? undefined, instructions: this.lastInstructions.get(session.bead_id), rateLimit: true, silentUsageRefusal: true, automatic: true });
          await notify(`${session.bead_id} re-dispatched after a transient stream failure on ${sessionWho(db, session)} (${e.lastError}).`, { hint: 'This automatic re-dispatch needs no action.', beadId: session.bead_id }).catch((err) => log.error('lifecycle: transient notify failed', err));
          return;
        } catch (err) {
          log.error(`lifecycle: transient retry of ${session.bead_id} failed`, err);
          if (repo.model_filter) reason += `; retry refused: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const hint = crashClass === 'harness_bug'
        ? `The ${session.harness} CLI failed to start (a harness bug, not the task): do not re-dispatch this bead on ${session.harness}; pass harness ${session.harness === 'claude' ? 'codex' : 'claude'} or ask the user.`
        : undefined;
      await store.update(repo.path, session.bead_id, { status: 'open', phase: null, note: `Worker session ${session.id} on ${sessionWho(db, session)} ended without new commits${why}: ${reason}` });
      this.signal(wt.batch_id, session.bead_id, 'reopen', reopenText('no_commits', reason));
      await notify(`${session.bead_id} reopened: worker ended without commits${why} on ${sessionWho(db, session)}: ${reason}`, { wake: true, hint }).catch((err) => log.error('lifecycle: reopen notify failed', err));
      return;
    }
    // The branch has real work to land, but the worker left edits in the tree it never committed. Verification runs in that
    // worktree, so it would pass on the uncommitted edit while the merge takes only the branch ref and drops it, and the bead
    // would come back looking unfixed (overseer-gk52, 2026-09-17). A stop keeps its own outcome above: the stop note says the
    // bead goes on to verification, so a stopped worker is not reopened here. The worktree's state at creation, stored on the
    // row, is subtracted, so the repo's own generated files (its setup command's output) are not mistaken for the worker's;
    // unknown because the row predates the snapshot, the check is skipped rather than reopened on that output.
    const startedDirty = wt.created_dirty;
    if (!stopped && startedDirty !== undefined) {
      const dirty = await uncommittedWork(wt.path);
      const already = new Set([...(startedDirty?.modified ?? []), ...(startedDirty?.untracked ?? [])]);
      const modified = (dirty?.modified ?? []).filter((p) => !already.has(p));
      const untracked = (dirty?.untracked ?? []).filter((p) => !already.has(p));
      if (modified.length || untracked.length) {
        db.sessions.update(session.id, { status: 'failed' });
        const grouped = [
          modified.length ? `modified: ${modified.join(', ')}` : '',
          untracked.length ? `untracked: ${untracked.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        await store.update(repo.path, session.bead_id, { status: 'open', phase: null,
          note: `Worker session ${session.id} left uncommitted changes in its worktree (${grouped}); they are not on ${wt.branch} and would be lost at the merge` });
        this.signal(wt.batch_id, session.bead_id, 'reopen', reopenText('uncommitted_changes', grouped));
        await notify(`${session.bead_id} reopened: the worker left uncommitted changes in its worktree (${grouped}); they are not on ${wt.branch} and would be lost at the merge.`,
          { wake: true, hint: 'Re-dispatch this bead with instructions to commit the work that is already in its worktree before ending; do not commit it yourself.' })
          .catch((err) => log.error('lifecycle: uncommitted-work notify failed', err));
        return;
      }
    }
    const worker: WorkerEnd = { model: session.model, text: e.lastText };
    try {
      let bead: Bead | undefined;
      if (!stopped && !session.verify_only) {
        const shown = await store.show(repo.path, session.bead_id);
        if (!shown) throw new LifecycleError(`bead ${session.bead_id} not found`);
        bead = shown;
        if (await this.gateEvidence(repo, wt, bead, session, finalText ?? '')) return;
      }
      await this.guarded(session.bead_id, () => wt.batch_id ? this.integrate(repo, wt, session.bead_id!, worker, bead) : this.verifyStandalone(repo, wt, session.bead_id!, worker));
    } catch (err) {
      log.error(`lifecycle: integration of ${session.bead_id} failed`, err);
      if (wt.batch_id && db.batches.get(wt.batch_id)?.status === 'abandoned') return;
      const branch = (wt.batch_id && db.batches.get(wt.batch_id)?.branch) || wt.base_branch;
      const reason = err instanceof Error ? err.message : String(err);
      await store.update(repo.path, session.bead_id, { status: 'open', phase: null, note: `Integration failed: ${reason}` });
      this.signal(wt.batch_id, session.bead_id, 'reopen', reopenText('hook_rejected', reason));
      await notify(`${session.bead_id} reopened: integration into ${branch} failed: ${reason}`, { wake: true }).catch((err) => log.error('lifecycle: integrate-error notify failed', err));
    }
  }

  /**
   * A worker that ended with no commits and a final message that hands the work to something still running: a distinct outcome
   * from an ordinary no-commit ending. Nothing will come back for the work — the session is gone — so it is recorded on the bead
   * with the sentence that triggered it and re-dispatched at once on a harness this bead has not just run on, with instructions
   * to do and commit the work in the new session. The reopen signal carries the sentence, so a batch retrospective can count it.
   */
  private async redispatchDeferred(repo: Repo, wt: WorktreeRow, session: SessionRow, sentence: string): Promise<void> {
    const { db, store, notify } = this.d;
    const beadId = session.bead_id!;
    // A harness forced with a tier is kept, since the task needs that harness; any other session moves to one it has not just run on.
    const forced = !!(session.tier && session.harness_forced);
    await store.update(repo.path, beadId, { status: 'open', phase: null,
      note: `Worker session ${session.id} ended without new commits, reporting the work as still running elsewhere ("${sentence}"); re-dispatching ${forced ? `on the forced ${session.harness} harness` : 'to another harness'}` });
    this.signal(wt.batch_id, beadId, 'reopen', reopenText('no_commits', sentence));
    // The orchestrator's own instructions for this bead are preserved: without them a re-dispatch after, say, "use the auth
    // helper in src/auth" would restart from the bead description alone.
    const prior = this.lastInstructions.get(beadId);
    try {
      const id = await this.spawnWorker(repo.id, beadId, {
        ...(forced ? retryRoute(session) : { tier: session.tier ?? 'standard', avoidHarness: session.harness }),
        verifyOnly: !!session.verify_only,
        needsServer: this.needsServerFor(beadId),
        batchId: session.batch_id ?? undefined,
        instructions: [prior, DEFERRED_WORK_INSTRUCTION, `The previous session's closing message was: "${sentence}"`].filter(Boolean).join('\n\n'),
        automatic: true,
        silentUsageRefusal: true,
      });
      const next = db.sessions.get(id)!;
      await notify(`${beadId} re-dispatched to ${next.harness}${next.model ? ` ${next.model}` : ''}: the previous worker ended without commits and reported the work as still running elsewhere ("${sentence}").`, { hint: 'This automatic re-dispatch needs no action; the new worker was told to commit the work in its own session.' }).catch((err) => log.error('lifecycle: deferred-work notify failed', err));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await notify(`${beadId} reopened: the previous worker ended without commits and reported the work as still running elsewhere ("${sentence}"), and the automatic re-dispatch was refused: ${reason}`, { wake: true, hint: 'Dispatch the bead again on a harness the previous worker did not run on; the work was never committed.' }).catch((err2) => log.error('lifecycle: deferred-work refusal notify failed', err2));
    } finally {
      // spawnWorker stores the instructions it was given; the orchestrator's own must stay what a later critic reads as theirs,
      // and a repeated deferral must not pile the same daemon text up.
      if (prior) this.lastInstructions.set(beadId, prior); else this.lastInstructions.delete(beadId);
    }
  }

  /**
   * A bead without a batch: verified, then reviewed by a critic when the repo has review rounds, else handed to the user as
   * before. `retry` words the notice for Retry verification on the Board. Resolves to why the run ended as a failure, or null
   * when it passed and the review or the user's review took over.
   */
  private async verifyStandalone(repo: Repo, wt: WorktreeRow, beadId: string, worker: WorkerEnd | null, retry = false): Promise<string | null> {
    const { db, store, notify } = this.d;
    const reviewed = repo.review_rounds > 0;
    const status = await this.verify(repo, wt, beadId, reviewed ? 'verifying' : 'review');
    if (reviewed && status === 'pass') { await this.startReview(repo, wt, beadId, worker); return null; }
    if (reviewed) await store.update(repo.path, beadId, { phase: 'review' }); // failed: the user's review, as without rounds
    await notify(retry ? `${beadId}: the user pressed Retry verification on the Board; ${verifyOutcome(repo, status)}.` : `${beadId} is in review; ${verifyOutcome(repo, status)}`, { wake: true }).catch((err) => log.error('lifecycle: review notify failed', err));
    return status === 'pass' ? null : `verification failed: ${(db.worktrees.get(beadId)?.verify_output ?? '').trim().slice(-500)}`;
  }

  /** Instructions the orchestrator gave the last worker of a bead: the critic reads the change against them. In memory, like `stops`. */
  private lastInstructions = new Map<string, string>();
  /** Verdicts `submit_review` recorded, by critic session id; a critic that ends without one counts as findings. */
  private reviews = new Map<string, Review>();
  /** The critic session live on a bead, if any: the only caller `submit_review` accepts a verdict for. */
  private activeCritic(beadId: string): SessionRow | undefined {
    return this.d.db.sessions.forBead(beadId).find((s) => s.role === 'critic' && s.status === 'running');
  }

  /** A retry keeps the forced route and account, while a tiered worker continues first and steps up on later retries. */
  private workerRetryRoute(beadId: string, lastWorker: SessionRow | undefined, stepUp: boolean): SpawnOpts {
    const forcedHarness = lastWorker && lastWorker.tier === null && !this.unusableHarnessesFor(beadId).has(lastWorker.harness) ? lastWorker : null;
    return forcedHarness
      ? { harness: forcedHarness.harness, model: forcedHarness.model ?? undefined, account: forcedHarness.account }
      : lastWorker?.tier && lastWorker.harness_forced
        ? retryRoute(lastWorker)
        : { tier: lastWorker?.tier ?? 'standard', stepUp };
  }

  /** Checks applicable evidence before verification or critic planning; true means a failure already re-dispatched or parked it. */
  private async gateEvidence(repo: Repo, wt: WorktreeRow, bead: Bead, worker: SessionRow, finalText: string): Promise<boolean> {
    const { db, store, notify } = this.d;
    const description = bead.description ?? '';
    if (!evidenceGateApplies(description, finalText)) return false;
    const result = evaluateEvidence({ description, finalText, headSha: await headCommit(wt.path), worktreePath: wt.path });
    if (result.ok) {
      if ((db.worktrees.get(bead.id)?.evidence_gate_failures ?? 0) > 0) db.worktrees.update(bead.id, { evidence_gate_failures: 0 });
      return false;
    }

    const problems = result.problems;
    const numbered = problems.map((problem, index) => `${index + 1}. ${problem}`).join('\n');
    const note = `Evidence gate: ${problems.length} problem(s):\n${numbered}`;
    const failures = (db.worktrees.get(bead.id)?.evidence_gate_failures ?? 0) + 1;
    db.worktrees.update(bead.id, { evidence_gate_failures: failures });
    if (failures >= 2) {
      await store.update(repo.path, bead.id, { status: 'open', phase: null, note });
      void this.d.push?.notify({ title: `${repo.id}: ${bead.id} awaits a decision`, body: `Evidence gate failed ${failures} consecutive times.`, url: '#board' });
      await notify(`${bead.id} awaits a decision: the evidence gate failed ${failures} consecutive times.\n${numbered}\n${this.beadTotals(bead.id)}`, {
        wake: true,
        hint: 'Discuss the evidence problems with the user. Then either call spawn_worker with instructions that address them or leave the bead as it is.',
      }).catch((err) => log.error('lifecycle: evidence-gate limit notify failed', err));
      return true;
    }

    await store.update(repo.path, bead.id, { status: 'open', phase: null, note });
    const instructions = `Fix each evidence-gate problem in order:\n${numbered}\n\nReport the Parity and Evidence lines again for the final HEAD`;
    try {
      const id = await this.spawnWorker(repo.id, bead.id, {
        ...this.workerRetryRoute(bead.id, worker, false),
        needsServer: this.needsServerFor(bead.id),
        automatic: true,
        continuation: true,
        instructions,
        batchId: wt.batch_id ?? undefined,
        silentUsageRefusal: true,
        suppressDispatchNotices: true,
      });
      const next = db.sessions.get(id)!;
      await notify(`${bead.id} evidence gate found ${problems.length} problem(s); re-dispatched to ${next.harness}${next.model ? ` ${next.model}` : ''}:\n${numbered}`, {
        hint: 'The same worker was re-dispatched automatically. No action is needed.',
      }).catch((err) => log.error('lifecycle: evidence-gate re-dispatch notify failed', err));
    } catch (err) {
      if (!(err instanceof LifecycleError)) throw err;
      const reason = err.message;
      await store.update(repo.path, bead.id, { status: 'open', phase: null, note: `Automatic evidence-gate re-dispatch was refused: ${reason}` });
      void this.d.push?.notify({ title: `${repo.id}: ${bead.id} awaits a decision`, body: 'The evidence gate re-dispatch was refused.', url: '#board' });
      await notify(`${bead.id} awaits a decision: the evidence gate found ${problems.length} problem(s), but its automatic re-dispatch was refused: ${reason}.\n${numbered}\n${this.beadTotals(bead.id)}`, {
        wake: true,
        hint: `Once the dispatch problem is resolved, call spawn_worker with instructions that address these evidence problems:\n${numbered}`,
      }).catch((notifyError) => log.error('lifecycle: evidence-gate refusal notify failed', notifyError));
    }
    return true;
  }
  /** `submit_review`: the verdict of the bead's live critic, applied when that session ends. */
  recordReview(beadId: string, review: Review): void {
    const critic = this.activeCritic(beadId);
    if (!critic) throw new LifecycleError(`no critic session is reviewing ${beadId}; submit_review is called by Overseer's critic sessions only`);
    this.reviews.set(critic.id, review);
  }

  /**
   * The review round: a critic of another model than the worker's reads the diff in the bead's worktree and reports through
   * `submit_review`. The critic does not go through `spawnWorker`: the worker limit and the one-session-per-bead guard are the
   * worker's, and the bead is still `in_progress` with phase `verifying` while the critic reads.
   */
  private async startReview(repo: Repo, wt: WorktreeRow, beadId: string, worker: WorkerEnd | null, resume = false, authResumed = false, sessionIdToExclude?: string, existingBead?: Bead): Promise<void> {
    const { db, store, sessions, config, bus, notify } = this.d;
    // `resume` re-runs the round the lost critic was on (recovery); a new critic is the next round.
    const round = resume ? (db.worktrees.get(beadId)?.review_round ?? 1) : (db.worktrees.get(beadId)?.review_round ?? 0) + 1;
    const bead = existingBead ?? await store.show(repo.path, beadId);
    if (!bead) throw new LifecycleError(`bead ${beadId} not found`);
    const { range, diff } = await reviewDiff(wt.path, wt.base_branch); // a batch bead's base is the batch branch, unless the branch merged that base in
    const settings = db.settings.tiers();
    // The bead's own tier plans the review (`reviewPlan.ts`): which critic tier this round uses and how many rounds it gets.
    // `critic-chore` is chosen only when that tier is configured, so an absent one reviews on `critic` as before.
    const workerTier = db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1)?.tier ?? null;
    const reviewTier = reviewTierFor(workerTier, round, settings.tiers.some((t) => t.name === 'critic-chore'));
    // The diff size is measured once, when the first round starts, and kept on the row and in the notes.
    const stored = db.worktrees.get(beadId)?.review_diff_lines;
    const measured = stored == null ? await diffLines(wt.path, range) : null;
    const changed = stored ?? measured!;
    // A round past the first was reached through a must in round 1 or a large diff, which is what gives a standard bead its second round.
    const rounds = reviewRoundLimit({ tier: workerTier, mustInRound1: round > 1, diffLines: changed, cap: repo.review_rounds });
    // Round 2 and later prefer a model other than the previous round's critic; a resumed round skips the critic it replaces.
    const critics = db.sessions.forBead(beadId).filter((s) => s.role === 'critic');
    const previousCritic = round > 1 ? (resume ? critics.slice(0, -1) : critics).at(-1) : undefined;
    const previousModels = previousCritic?.model ? [previousCritic.model] : [];
    // Every tier's candidates, not just the review tier's: resolveTier falls through the critic chain when no candidate
    // there survives, so a held harness anywhere in that chain must be gated or the critic lands on it and fails at once.
    const unusableCandidates = await this.unusableCandidates(settings.tiers.flatMap((entry) => entry.candidates), sessionIdToExclude);
    const c = resolveTier(settings, reviewTier, { previousModels, excludeModel: worker?.model ?? undefined, available: this.d.harnessAvailable, unusableCandidates });
    const input = { bead, repoId: repo.id, branch: wt.branch, base: range, diff, instructions: this.lastInstructions.get(beadId), workerText: worker?.text, round, limit: rounds };
    // A prompt past the harness's input limit is refused by the CLI, and the round then reads as a crashed critic with no
    // reason (overseer-slfl, codex `input_too_large`). `boundedCriticPrompt` reduces it in fixed steps instead, keeping the
    // review criteria and the `submit_review` instructions whole: the critic has the worktree and can read the change itself.
    const limit = inputLimit(c.harness);
    const stat = buildCriticPrompt(this.criticTemplate, input).length > limit ? await diffStat(wt.path, range).catch(() => '') : '';
    const { prompt, omitted } = boundedCriticPrompt(this.criticTemplate, input, limit, stat);
    const dropped = omitted.length ? `the prompt did not fit the ${limit} characters ${c.harness} accepts, so it omits ${omitted.join('; ')}, and the critic reads the change itself in \`${wt.path}\`` : null;
    db.worktrees.update(beadId, { review_round: round, ...(measured != null ? { review_diff_lines: measured } : {}) });
    try {
      const account = c.account ? db.accounts.get(c.account) : null;
      if (c.account && (!account || !accountLoggedIn(account))) throw new LifecycleError(`account ${accountDisplayName(account) ?? c.account} is not logged in`);
      const env = await freshAccountEnv(db, config, account);
      sessions.start({ role: 'critic', harness: c.harness, model: c.model, effort: c.effort ?? undefined, tier: reviewTier, repoId: repo.id, beadId, beadTitle: bead.title, cwd: wt.path, prompt, mcpServers: [{ name: 'overseer', url: `http://127.0.0.1:${config.port}/mcp` }], account: c.account ?? null, tokenExpiresAt: envTokenExpiresAt(db, account), env, authResumed });
    } catch (err) {
      // Named in the reopen note so the orchestrator sees that the change verified and only the critic failed to spawn (overseer-gg1).
      throw new LifecycleError(`the review of ${beadId} could not start (${c.harness} ${c.model}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const notes = [measured != null ? `Review diff: ${measured} changed lines against \`${range}\`; ${rounds} review round${rounds === 1 ? '' : 's'} planned.` : null, dropped ? `Review round ${round}: ${dropped}.` : null].filter(Boolean);
    if (notes.length) await store.update(repo.path, beadId, { note: notes.join('\n') }).catch((err) => log.error('lifecycle: review-start note failed', err));
    if (dropped) {
      await notify(`${beadId}: its review round prompt did not fit the critic's harness: ${dropped}.`, { hint: 'The round is running; no action is needed unless it reports that it could not read the change.', beadId }).catch((err) => log.error('lifecycle: oversized-prompt notify failed', err));
    }
    bus.emit('board');
  }

  private async onCriticEnded(e: SessionEnded): Promise<void> {
    const { db, store, notify, bus } = this.d;
    const { session } = e;
    if (this.rateLimits.delete(session.id)) return;
    const stopped = this.stopOf(e);
    this.stops.delete(session.id);
    const recorded = this.reviews.get(session.id);
    this.reviews.delete(session.id);
    const repo = session.repo_id ? db.repos.get(session.repo_id) : undefined;
    const wt = session.bead_id ? db.worktrees.get(session.bead_id) : undefined;
    if (!repo || !wt || !session.bead_id) return;
    const batchStatus = wt.batch_id ? db.batches.get(wt.batch_id)?.status : undefined;
    if (batchStatus === 'abandoned' || batchStatus === 'merged') return;
    if (stopped) {
      // A critic stopped mid-review has no verdict to apply: the bead reopens without landing, unlike a worker stop after commits.
      const stopBy = stopped.by === 'user' ? 'the user' : 'the orchestrator';
      await store.update(repo.path, session.bead_id, { status: 'open', phase: null, note: `Stopped during review by ${stopBy}` });
      await notify(`${session.bead_id} stopped during review by ${stopBy}; reopened without landing.`, { wake: true, hint: 'Do not re-dispatch it unless the user asks.' }).catch((err) => log.error('lifecycle: review-stop notify failed', err));
      bus.emit('board');
      return;
    }
    let authResumeError: string | null = null;
    try {
      // The critic's account is treated like the worker's: a rejected token is usually a rollover, so the round is re-run
      // on the account's current environment and only a rejected refresh (or a resume rejected again) parks it. The signal
      // is structured only, never the critic's own text.
      const authAccount = session.account ? db.accounts.get(session.account) : undefined;
      if (e.authFailed === true || (!authAccount && isAuthFailure(e.lastError))) {
        const grant = authAccount ? await this.freshEnvForResume(session, authAccount) : null;
        if (grant) {
          try {
            await this.resumeCriticRound(repo, wt, session);
            return;
          } catch (err) {
            authResumeError = err instanceof Error ? err.message : String(err);
            // No review session started; fall through to normal failure handling without parking the account.
            log.error(`lifecycle: could not re-run the review round of ${session.bead_id} after its token rolled over`, err);
          }
        } else {
          db.sessions.update(session.id, { crash_class: 'auth' });
          this.signal(wt.batch_id, session.bead_id, 'crash', `auth: ${e.lastError ?? 'authentication failed'}`);
          await this.parkAuthAccount(session);
        }
      }
      if (authResumeError) throw new LifecycleError(`auth resume skipped: ${authResumeError}`);
      // A critic that failed (crashed, exited with an error) has no verdict to apply; only one that ended cleanly without submit_review counts as a must finding.
      if (!recorded && (session.status === 'failed' || e.lastError)) throw new LifecycleError(`the critic session failed: ${e.lastError ?? 'exited with an error'}${authResumeError ? `; auth resume skipped: ${authResumeError}` : ''}`);
      const review: Review = recorded ?? { verdict: 'findings', findings: [{ file: null, summary: e.lastText ?? 'critic ended without a verdict', severity: 'must' }] };
      await this.applyReview(repo, wt, session.bead_id, review, session);
    } catch (err) {
      // Like a failed integration: the bead must not sit in Verifying with nothing running on it.
      log.error(`lifecycle: review of ${session.bead_id} could not be applied`, err);
      const reason = err instanceof Error ? err.message : String(err);
      await store.update(repo.path, session.bead_id, { status: 'open', phase: null, note: `Review round on ${sessionWho(db, session)} failed: ${reason}` }).catch((e2) => log.error('lifecycle: review-error reopen failed', e2));
      await notify(`${session.bead_id} reopened: its review round on ${sessionWho(db, session)} could not be completed: ${reason}`, { wake: true }).catch((e2) => log.error('lifecycle: review-error notify failed', e2));
    } finally {
      bus.emit('board');
    }
  }

  /**
   * Re-runs a critic's review round on a refreshed token after it ended on the structured auth signal. The review code
   * cannot resume a critic's native session: `startReview` builds a fresh prompt for every round and passes no `resumeId`,
   * so the same round is restarted instead — `resume = true` keeps the round count, so no round is spent.
   */
  private async resumeCriticRound(repo: Repo, wt: WorktreeRow, session: SessionRow): Promise<void> {
    const { store, notify } = this.d;
    const beadId = session.bead_id!;
    const previous = this.d.db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1);
    await store.update(repo.path, beadId, { status: 'in_progress', phase: 'verifying' });
    // `startReview` resolves the critic tier again, so the re-run round may land on another usable account or harness than the
    // one whose token rolled over. That is intended: the round only has to run again, and the failed account is not parked
    // because its refresh worked. The marker is written as the row is created, before `startReview`'s own awaits, so a critic
    // rejected the moment it starts cannot be resumed a second time (nor lose the limit to a restart in that window).
    await this.startReview(repo, wt, beadId, previous ? { model: previous.model, text: previous.last_text ?? null } : null, true, true, session.id);
    await notify(`${beadId} resumed after its login token rolled over on ${sessionWho(this.d.db, session)}.`, {
      hint: 'The review round is running again on the refreshed login; no action is needed.', beadId,
    }).catch((err) => log.error('lifecycle: auth-resume notify failed', err));
  }

  /** The critic's verdict on a verified change: land it (a pass, or findings without a must), send it back with findings, or park it for the user's decision. */
  private async applyReview(repo: Repo, wt: WorktreeRow, beadId: string, review: Review, critic: SessionRow): Promise<void> {
    const { db, store, notify } = this.d;
    const batch = wt.batch_id ? db.batches.get(wt.batch_id) : undefined;
    // The guard covers the discard and the landing; the re-dispatch below runs outside it, since spawnWorker refuses a guarded bead.
    const lastWorker = db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1);
    const landed = await this.guarded(beadId, async (): Promise<boolean | 'again'> => {
      // The critic was told not to edit; whatever it did edit is not the worker's work and must not land or confuse the next worker.
      try { await git(wt.path, ['checkout', '--', '.']); await git(wt.path, ['clean', '-fd']); } catch (err) { log.error(`lifecycle: could not discard critic edits in ${wt.path}`, err); }
      // A large standard diff gets its second round after either kind of successful first round: the plan's own condition, not a finding.
      const current = db.worktrees.get(beadId);
      const successful = review.verdict === 'pass' || landsWithFindings(review.findings);
      if (successful && reviewsAgain({ tier: lastWorker?.tier ?? null, round: current?.review_round ?? 0, diffLines: current?.review_diff_lines ?? 0, cap: repo.review_rounds })) {
        // Kept apart from review_findings, which marks a bead as awaiting a decision: a round 2 that fails to run must not park it.
        db.worktrees.update(beadId, { review_carried: review.findings.length ? review.findings : null });
        return 'again';
      }
      const round = current?.review_round ?? 0;
      const landedFindings = [
        current?.review_carried?.length ? `review findings landed with (round ${Math.max(1, round - 1)}):\n${renderFindings(current.review_carried)}` : null,
        landsWithFindings(review.findings) && review.findings.length ? `review findings landed with (round ${round}):\n${renderFindings(review.findings)}` : null,
      ].filter((heading): heading is string => heading !== null);
      const heading = landedFindings.join('\n');
      if (review.verdict === 'pass') {
        db.worktrees.update(beadId, { review_findings: null, review_carried: null });
        await this.landVerified(repo, wt, beadId, batch, heading ? `${reviewedBy(critic)}; ${heading}` : reviewedBy(critic), heading ? heading.charAt(0).toUpperCase() + heading.slice(1) : undefined);
        return true;
      }
      if (!landsWithFindings(review.findings)) return false;
      // Findings without a must land like a clean round; the notes and the landing notice carry them for the batch review note.
      db.worktrees.update(beadId, { review_findings: null, review_carried: null });
      await this.landVerified(repo, wt, beadId, batch, `${reviewedBy(critic)}; ${heading}`, heading.charAt(0).toUpperCase() + heading.slice(1));
      return true;
    });
    if (landed === 'again') {
      await this.guarded(beadId, () => this.startReview(repo, wt, beadId, lastWorker ? { model: lastWorker.model, text: lastWorker.last_text ?? null } : null));
      return;
    }
    if (landed) return;
    const round = db.worktrees.get(beadId)?.review_round ?? 0;
    const text = renderFindings(review.findings);
    const by = reviewedBy(critic).replace(/^reviewed by /, '');
    // This round has a must (else it landed above); a later round was reached through one in round 1.
    const diffLinesMeasured = db.worktrees.get(beadId)?.review_diff_lines ?? null;
    const limit = reviewRoundLimit({ tier: lastWorker?.tier ?? null, mustInRound1: true, diffLines: diffLinesMeasured ?? 0, cap: repo.review_rounds });
    if (round < limit) {
      // The first failed round continues on the same route; later review retries step up unless the worker was forced.
      const how = this.workerRetryRoute(beadId, lastWorker, round > 1);
      const instructions = `The review of the previous attempt (already committed on this branch) found these issues. Fix them so the next review passes:\n${text}`;
      let sid: string;
      try {
        sid = await this.spawnWorker(repo.id, beadId, { ...how, verifyOnly: !!lastWorker?.verify_only, needsServer: this.needsServerFor(beadId), automatic: true, continuation: round === 1, instructions, batchId: wt.batch_id ?? undefined });
      } catch (err) {
        if (!(err instanceof LifecycleError)) throw err;
        // A refused re-dispatch (worker limit reached, bead busy) must not drop the findings: the bead parks with them, as at the limit, and the orchestrator retries.
        db.worktrees.update(beadId, { review_round: round, review_findings: review.findings });
        await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Review round ${round} of ${limit} (${by}) found issues; the re-dispatch was refused (${err.message}):\n${text}` });
        void this.d.push?.notify({ title: `${repo.id}: ${beadId} awaits a decision`, body: `Review round ${round} of ${limit} found issues; the re-dispatch was refused.`, url: '#board' });
        await notify(`${beadId} awaits a decision: review round ${round} of ${limit} (${by}) found issues, and the re-dispatch was refused: ${err.message}.\n${this.beadTotals(beadId)}`, { wake: true, hint: `Once a worker slot is free, call spawn_worker with these findings as instructions (a fresh set of review rounds follows), or accept_review(repo, bead_id, note) to land the work as it is:\n${text}` }).catch((e2) => log.error('lifecycle: review-refused notify failed', e2));
        return;
      }
      // spawnWorker starts a row afresh; the round count and the diff measured for this review belong to it, not the dispatch.
      db.worktrees.update(beadId, { review_round: round, review_diff_lines: diffLinesMeasured });
      const s = db.sessions.get(sid)!;
      await notify(`${beadId} review round ${round} of ${limit} (${by}) found issues; re-dispatched to ${s.harness}${s.model ? ` ${s.model}` : ''} with them:\n${text}`, { hint: 'Do not dispatch it again; the next review round follows on its own.' }).catch((err) => log.error('lifecycle: review-redispatch notify failed', err));
      return;
    }
    // At the limit: the bead stays open with the findings on its row, for the user to decide through the orchestrator.
    db.worktrees.update(beadId, { review_findings: review.findings });
    await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Review round ${round} of ${limit} (${by}) still has findings:\n${text}` });
    void this.d.push?.notify({ title: `${repo.id}: ${beadId} awaits a decision`, body: `Review round ${round} of ${limit} still has findings.`, url: '#board' });
    await notify(`${beadId} awaits a decision: review round ${round} of ${limit} (${by}) still has findings:\n${text}\n${this.beadTotals(beadId)}`, { wake: true, hint: 'Discuss the findings with the user. Then either call spawn_worker with instructions that address them (a fresh set of review rounds follows) or accept_review(repo, bead_id, note) to land the work as it is, with the user\'s reason as the note.' }).catch((err) => log.error('lifecycle: review-limit notify failed', err));
  }

  /**
   * The bead's spend so far, for the awaits-a-decision notice: its worker and critic sessions, the re-dispatches after the
   * first worker, and the cost — the reported figure where a session has one, else its catalog estimate, named as such. A bead
   * with neither says so rather than reading as $0.
   */
  private beadTotals(beadId: string): string {
    const sessions = this.d.db.sessions.forBead(beadId);
    const workers = sessions.filter((s) => s.role === 'worker').length;
    const critics = sessions.filter((s) => s.role === 'critic').length;
    const redispatches = Math.max(0, workers - 1);
    const count = (n: number, singular: string, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
    const reported = sessions.some((s) => s.cost !== null);
    const estimated = sessions.some((s) => s.cost === null && (s.estimated_cost ?? null) !== null);
    const spend = sessions.reduce((sum, s) => sum + (s.cost ?? s.estimated_cost ?? 0), 0);
    const cost = reported || estimated
      ? `cost $${spend.toFixed(2)} (${estimated ? 'estimated' : 'reported'})`
      : 'cost unknown (no reported or estimated cost)';
    return `Totals so far: ${count(workers, 'worker session')}, ${count(critics, 'critic session')}, ${count(redispatches, 're-dispatch', 're-dispatches')}, ${cost}.`;
  }

  /**
   * `accept_review`: the user, through the orchestrator, lands a bead parked with open findings. The findings and the round count
   * go; the note stays on the row as the record of the decision.
   */
  async acceptReview(repoId: string, beadId: string, note: string): Promise<void> {
    const { db, bus } = this.d;
    const wt = db.worktrees.get(beadId);
    if (!wt || wt.repo_id !== repoId) throw new LifecycleError(`no worktree for ${beadId} in ${repoId}`);
    if (!wt.review_findings) throw new LifecycleError(`${beadId} has no open review findings to accept`);
    if (!fs.existsSync(wt.path)) throw new LifecycleError(`the worktree of ${beadId} is gone; re-dispatch it instead`);
    if (db.sessions.forBead(beadId).some((s) => s.status === 'running')) throw new LifecycleError(`bead ${beadId} has a running session`);
    const repo = db.repos.get(repoId)!;
    const batch = wt.batch_id ? db.batches.get(wt.batch_id) : undefined;
    if (wt.batch_id && batch?.status !== 'open') throw new LifecycleError(`batch ${wt.batch_id} is ${batch?.status ?? 'missing'}`);
    if (this.verifying.has(beadId)) throw new LifecycleError(`bead ${beadId} is busy: its branch is being verified, integrated or removed`);
    // A round 1 that passed with advisory findings before the round now parked still lands with them on record.
    const carried = wt.review_carried?.length ? `review findings landed with (round 1):\n${renderFindings(wt.review_carried)}` : null;
    db.worktrees.update(beadId, { accepted_note: note, review_round: null, review_findings: null, review_carried: null });
    try { await this.guarded(beadId, () => this.landVerified(repo, wt, beadId, batch, carried ? `landed with open findings by the user through the orchestrator; ${carried}` : 'landed with open findings by the user through the orchestrator', carried ? carried.charAt(0).toUpperCase() + carried.slice(1) : undefined)); } finally { bus.emit('board'); }
  }

  private async runVerifyOnlyCommand(wt: WorktreeRow, command: string): Promise<VerifyOnlyCheck> {
    const headSha = await headCommit(wt.path);
    const started = Date.now();
    const result = await runVerify(command, wt.path);
    const exit = /(?:^|\r?\n)exit (-?\d+)\s*$/.exec(result.output);
    const check: VerifyOnlyCheck = {
      status: result.status,
      command,
      head_sha: headSha,
      exit_code: exit ? Number(exit[1]) : null,
      duration_ms: Date.now() - started,
      output_tail: result.output.slice(-600),
      counts: parseReviewCounts(result.output),
    };
    this.d.db.worktrees.update(wt.bead_id, { verify_only_result: check });
    return check;
  }

  private async reopenVerifyOnly(repo: Repo, wt: WorktreeRow, session: SessionRow, detail: string): Promise<void> {
    const { db, store, notify } = this.d;
    const beadId = session.bead_id!;
    db.sessions.update(session.id, { status: 'failed' });
    await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Verification incomplete: ${detail}` });
    this.signal(wt.batch_id, beadId, 'reopen', reopenText('verify_incomplete', detail));
    await notify(`${beadId} reopened: verification-only result is incomplete; ${detail}`, {
      wake: true,
      hint: 'Re-dispatch this verification-only bead with instructions to run every required check and report each result as `Check: <command> - PASS|FAIL - <summary>`.',
    }).catch((err) => log.error('lifecycle: incomplete verification notify failed', err));
  }

  /** Closes a commitless verification bead and labels whether the daemon or only the worker reported its passing result. */
  private async closeVerifyOnly(repo: Repo, wt: WorktreeRow, session: SessionRow, finalText: string, result?: VerifyOnlyCheck): Promise<void> {
    const { db, store, notify } = this.d;
    const beadId = session.bead_id!;
    const bead = await store.show(repo.path, beadId);
    // The read only picks `--force` (a verification bead usually waits on the beads it checks, which have landed by now): a bd hiccup on it forces rather than failing the close.
    const blocked = bead?.dependency_count ? await store.blocked(repo.path).catch((err: unknown) => { log.error('lifecycle: bd blocked failed before a verified close', err); return null; }) : [];
    const phase: Phase = result ? 'verified' : 'worker-reported';
    const reason = result ? 'verify command passed, no commits' : 'worker-reported result, no commits';
    const note = result
      ? `Daemon verification command \`${result.command}\` passed at ${result.head_sha} with exit code ${result.exit_code}; counts: ${JSON.stringify(result.counts)}.\nDaemon output tail:\n${result.output_tail}\nWorker-reported results:\n${finalText || '(no Check: lines reported)'}`
      : `Worker-reported result from session ${session.id} (no commits):\n${finalText}`;
    await store.update(repo.path, beadId, { note });
    await store.close(repo.path, beadId, reason, { force: bead ? this.forceNeeded(bead, blocked) : true });
    await store.update(repo.path, beadId, { phase });
    db.worktrees.update(beadId, { closed_at: new Date().toISOString() });
    await this.cleanupWorktree(repo, wt.path, wt.branch);
    const batch = wt.batch_id ? db.batches.get(wt.batch_id) : undefined;
    const count = batch ? `; batch ${batch.id} stays open (${await this.batchCount(repo.path, batch.id)})` : '';
    const label = result ? 'verified' : 'worker-reported';
    const source = result ? 'the daemon ran its verify command and it passed' : 'the worker reported its result';
    await notify(`${beadId} closed as ${label}: ${source} and committed nothing${count}.`, { wake: batch ? !this.batchBusy(batch.id) : true, hint: `Its result is in the bead's notes; quote it in the review note.${batch ? ' When every remaining bead of the batch has landed or been closed, call request_batch_review.' : ''}` }).catch((err) => log.error('lifecycle: verify-only close notify failed', err));
  }

  /** Beads whose worktree is being verified or integrated right now; no worker may start on them and no second verification. */
  private verifying = new Set<string>();
  /**
   * Batches with a terminal action in flight. Merge, Abandon and Reject exclude each other per batch: a second one is refused
   * with a reason naming the action that runs (round 11: a second Merge answered 500; the Abandon-versus-Merge race could leave
   * one batch both merged and abandoned at once).
   */
  private terminalBatchAction = new Map<string, 'merged' | 'abandoned' | 'rejected'>();
  /** Runs a terminal batch action under the per-batch guard, releasing it when the action ends, success or failure. */
  private underBatchAction<T>(batchId: string, action: 'merged' | 'abandoned' | 'rejected', fn: () => Promise<T>): Promise<T> {
    const running = this.terminalBatchAction.get(batchId);
    if (running) throw new LifecycleError(`batch ${batchId} is being ${running}`);
    this.terminalBatchAction.set(batchId, action);
    return fn().finally(() => this.terminalBatchAction.delete(batchId));
  }
  private async guarded<T>(beadId: string, fn: () => Promise<T>): Promise<T> {
    this.verifying.add(beadId);
    try { return await fn(); } finally { this.verifying.delete(beadId); }
  }

  private async verify(repo: Repo, wt: WorktreeRow, beadId: string, finalPhase: Phase): Promise<VerifyResult['status']> {
    const { db, store, bus } = this.d;
    await store.update(repo.path, beadId, { phase: 'verifying' });
    bus.emit('board');
    // The office feed's printer: a verification between sessions, so it is published as its own bead event, not a session's.
    bus.emit('bead:verify', { bead_id: beadId, status: 'running' });
    let status: VerifyResult['status'] = 'fail';
    try {
      const r = await (this.d.verifyRunner ?? runVerify)(repo.verify_command, wt.path);
      status = r.status;
      if (repo.verify_command) bus.emit('office_milestone', {
        kind: r.status === 'pass' ? 'verify_passed' : 'verify_failed',
        repo_id: repo.id,
        batch_id: wt.batch_id,
        bead_id: beadId,
        at: new Date().toISOString(),
      });
      db.worktrees.update(beadId, { verify_status: r.status, verify_output: r.output, conflict_files: null });
      // The board already shows `verifying` from the write above the run; writing the same phase again is a second bd call for
      // no visible change. A batch bead's final phase is `verifying` (the review or the landing follows), so only a different
      // phase is written here.
      if (finalPhase !== 'verifying') await store.update(repo.path, beadId, { phase: finalPhase });
      return r.status;
    } finally {
      // A bd failure or a runner throw must not strand the character at the printer: any non-running status leaves it.
      bus.emit('bead:verify', { bead_id: beadId, status });
    }
  }

  /**
   * Runs the repo's setup command in a worktree just created (dependencies, generated files: a commit hook such as commitlint
   * needs node_modules to run at all, and a merge in the batch worktree runs the hooks). Resolves to null when it passed and to
   * the output when it failed; the caller decides what the failure reopens and records the output there, the way a
   * verification's output lands in the bead's note (the daemon log stays quiet, like it is for a verification).
   */
  private async setup(repo: Repo, cwd: string): Promise<string | null> {
    const r = await runSetup(repo.setup_command!, cwd);
    return r.status === 'pass' ? null : r.output;
  }

  private integrating = new Map<string, Promise<unknown>>();
  /** Runs fn after every earlier call with the same key: two beads of one batch must not merge into the batch worktree at once. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.integrating.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.integrating.set(key, next);
    void next.catch(() => undefined).finally(() => { if (this.integrating.get(key) === next) this.integrating.delete(key); });
    return next;
  }

  /**
   * A batch bead after its worker: verify, then the review round (when the repo has one) or the landing. Only `landVerified`
   * merges. Resolves to why the run ended as a failure (a reopen), or null when it landed or a review took over.
   */
  private async integrate(repo: Repo, wt: WorktreeRow, beadId: string, worker: WorkerEnd | null, existingBead?: Bead): Promise<string | null> {
    const { db, store, notify } = this.d;
    const batch = db.batches.get(wt.batch_id!)!;
    const status = await this.verify(repo, wt, beadId, 'verifying');
    if (db.batches.get(batch.id)?.status === 'abandoned') { await store.update(repo.path, beadId, { phase: null }); return null; }
    if (status !== 'pass') {
      const tail = (db.worktrees.get(beadId)?.verify_output ?? '').slice(-2000);
      await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Verification failed:\n${tail}` });
      this.signal(batch.id, beadId, 'reopen', reopenText('verify_failed', tail.slice(-600)));
      await notify(`${beadId} reopened: the ${verifyLabel(repo)} failed on ${wt.branch}.\n${tail.slice(-600)}`, { wake: true, hint: 'If the work is wrong, re-dispatch with instructions; if the command is wrong, tell the user to fix it in Setup and press Retry verification on the card.' }).catch((err) => log.error('lifecycle: verify-fail notify failed', err));
      return `verification failed: ${tail.slice(-500)}`;
    }
    if (repo.review_rounds > 0) { await this.startReview(repo, wt, beadId, worker, false, false, undefined, existingBead); return null; }
    return this.landVerified(repo, wt, beadId, batch, null, undefined, existingBead);
  }

  /**
   * A verified change lands: merged into its batch branch and closed, or (a bead without a batch) handed to the user's review.
   * Reached from `integrate` with no review round, from a critic's pass, and from `accept_review`; `reviewed` names who passed it.
   * Resolves to why a batch bead was reopened without landing (setup, conflict), or null when the work landed.
   */
  private async landVerified(repo: Repo, wt: WorktreeRow, beadId: string, batch: BatchRow | undefined, reviewed: string | null, landedNote?: string, existingBead?: Bead): Promise<string | null> {
    const { db, store, notify, config } = this.d;
    if (!batch) {
      await store.update(repo.path, beadId, { status: 'in_progress', phase: 'review', ...(landedNote ? { note: landedNote } : {}) });
      await notify(`${beadId} is in review; ${verifyOutcome(repo, 'pass')}${reviewed ? `; ${reviewed}` : ''}`, { wake: true }).catch((err) => log.error('lifecycle: review notify failed', err));
      return null;
    }
    return this.serial(batch.id, async () => {
      if (db.batches.get(batch.id)?.status === 'abandoned') { await store.update(repo.path, beadId, { phase: null }); return null; }
      const batchWt = await ensureBranchWorktree(repo, batch.branch, batchWorktreePath(config.worktreesDir, repo.id, batch.id));
      const failed = await this.batchSetup(repo, batch, batchWt);
      if (failed) {
        await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Setup failed in the batch worktree of ${batch.id}, so ${wt.branch} was not merged into ${batch.branch}:\n${failed.slice(-2000)}` });
        this.signal(batch.id, beadId, 'reopen', reopenText('setup_failed', `the ${setupLabel(repo)} failed in the batch worktree`));
        await notify(`${beadId} reopened: the ${setupLabel(repo)} failed in the batch worktree of ${batch.id}, so its branch was not merged into ${batch.branch}.\n${failed.slice(-600)}`, { wake: true, hint: 'The work is committed and verified; the repo\'s setup command from Setup is what failed. Tell the user to fix it there and press Retry verification on the card, which runs the setup and the merge again.' }).catch((err) => log.error('lifecycle: batch-setup-fail notify failed', err));
        return `the ${setupLabel(repo)} failed in the batch worktree: ${failed.slice(-500)}`;
      }
      // A base merge this batch missed while this worker was running normally lands first, so the bead merges onto the refreshed
      // branch. A merge bead added after a refresh conflict must land first: it may itself contain the queued base, avoiding the
      // same conflict notice immediately before the recovery bead lands.
      const pending = db.batches.get(batch.id);
      const recoveringRefresh = !!(pending?.refresh_from && pending.conflict_files?.length);
      if (pending?.refresh_from && !recoveringRefresh) await this.refreshFromBase(repo, pending, pending.refresh_from, batchWt.path, pending.refresh_head ?? null);
      const bead = existingBead ?? await store.show(repo.path, beadId);
      const r = await mergeInto(batchWt.path, wt.branch, mergeMessage({ target: batch.branch, id: beadId, title: bead?.title ?? beadId, source: wt.branch }));
      if (!r.ok) {
        db.worktrees.update(beadId, { conflict_files: r.conflicts });
        await store.update(repo.path, beadId, { status: 'open', phase: null });
        this.signal(batch.id, beadId, 'reopen', reopenText('merge_conflict', r.conflicts.join(', ')));
        await notify(`${beadId} conflicted in: ${r.conflicts.join(', ')} when merging into ${batch.branch}. Re-dispatch with spawn_worker (same batch_id) to rebase; the worker prompt lists the files.`, { wake: true }).catch((err) => log.error('lifecycle: integrate-conflict notify failed', err));
        return `the merge into ${batch.branch} conflicted in: ${r.conflicts.join(', ')}`;
      }
      // Point of no return: the work is on the batch branch. Nothing past here may throw out of integrate(), because onWorkerEnded
      // answers a throw by reopening the bead as "integration failed" (fix round 15 review: a bd hiccup in the count did exactly that).
      // The row records the landing before bd is asked to: should bd fail, the daemon still knows the bead landed, the card reads
      // `landed_unclosed` with Retry close, and the restart sweep closes it (fix round 16 review: it sat in Verifying with no action).
      db.worktrees.update(beadId, { merged_at: new Date().toISOString(), conflict_files: null, ...(landedNote ? { landed_note: landedNote, landed_reviewed: reviewed } : {}) });
      try {
        await this.recordLanded(repo, wt, beadId, batch, false, reviewed, landedNote);
      } catch (err) {
        log.error(`lifecycle: ${beadId} landed on ${batch.branch} but could not be closed in bd`, err);
        const reason = err instanceof Error ? err.message : String(err);
        await notify(`${beadId} landed on ${batch.branch} but bd could not record it: ${reason}. Its work is merged; do not re-dispatch it.`, { wake: true, hint: 'Its card reads landed and offers Retry close, which closes it in bd; the daemon also retries when it restarts. Tell the user; do not treat the bead as open.' }).catch((e2) => log.error('lifecycle: landed-error notify failed', e2));
      }
      // A recovery bead can resolve a deferred refresh itself. This is deliberately after the point of no return: a hook or push
      // failure while refreshing must not reopen a bead whose work is already on the batch branch.
      const pendingRefresh = db.batches.get(batch.id);
      if (recoveringRefresh && pendingRefresh?.refresh_from && pendingRefresh.conflict_files?.length) {
        try {
          const localBase = this.isActiveBatchBase(repo, pendingRefresh.base_branch);
          const requiredBase = localBase ? pendingRefresh.base_branch : pendingRefresh.refresh_head ?? (repo.merge_mode === 'gitlab-mr' ? `origin/${pendingRefresh.base_branch}` : pendingRefresh.base_branch);
          if (await isAncestor(batchWt.path, requiredBase, 'HEAD')) {
            db.batches.update(batch.id, { refresh_from: null, refresh_head: null, conflict_files: null });
          } else {
            await this.refreshFromBase(repo, pendingRefresh, pendingRefresh.refresh_from, batchWt.path, pendingRefresh.refresh_head ?? null, undefined, false);
          }
        } catch (err) {
          log.error(`lifecycle: ${beadId} landed on ${batch.branch} but recovery refresh from ${pendingRefresh.base_branch} failed`, err);
          const reason = err instanceof Error ? err.message : String(err);
          await notify(`Batch ${batch.id} landed ${beadId} but the refresh from ${pendingRefresh.base_branch} failed: ${trimEndStop(reason.slice(0, 600))}. Add a merge bead.`, { wake: true }).catch((e2) => log.error('lifecycle: recovery-refresh-fail notify failed', e2));
        }
      }
      await this.refreshStackedReviewBatches(repo, batch, batchWt.path);
      return null;
    });
  }

  /** The bd side of a landing: close the bead as merged, drop its worktree, tell the orchestrator. `closed` skips a close bd already has. */
  private async recordLanded(repo: Repo, wt: WorktreeRow, beadId: string, batch: BatchRow, closed: boolean, reviewed: string | null = null, landedNote?: string): Promise<void> {
    const { store, notify } = this.d;
    if (!closed) await store.close(repo.path, beadId, `merged into ${batch.branch}`);
    await store.update(repo.path, beadId, { phase: 'merged', ...(landedNote ? { note: landedNote } : {}) }); // written only once the merge has landed
    await this.cleanupWorktree(repo, wt.path, wt.branch);
    // The orchestrator has to act (request review, dispatch what was waiting) unless another worker of the batch will report in.
    await notify(`${beadId} landed on ${batch.branch} (${await this.batchCount(repo.path, batch.id)}; ${verifyOutcome(repo, 'pass')}${reviewed ? `; ${reviewed}` : ''})`, { wake: !this.batchBusy(batch.id) }).catch((err) => log.error('lifecycle: landed notify failed', err));
  }

  /**
   * The repo's setup command in the batch worktree, once per worktree: a merge there runs the repo's commit hooks, which need what the
   * bead worktrees got (create_batch does it; a worktree from before the command was set, or one that failed then, gets it here), and
   * again whenever the folder was recreated. Resolves to null when it passed or was not needed, and to the output when it failed.
   */
  private async batchSetup(repo: Repo, batch: BatchRow, batchWt: { path: string; created: boolean }): Promise<string | null> {
    const { db } = this.d;
    if (!repo.setup_command || !(batchWt.created || !db.batches.get(batch.id)?.setup_at)) return null;
    const failed = await this.setup(repo, batchWt.path);
    if (failed) return failed;
    db.batches.update(batch.id, { setup_at: new Date().toISOString() });
    return null;
  }

  /**
   * After `merged` landed on its base branch: refresh the other batches in review that share that base, so a verified batch is
   * verified against what it will land on (2026-09-14: the second of two overlapping batches conflicted once the first was merged).
   * A batch with a running worker is left alone and marked `refresh_from`; integrate() runs the same merge before that worker's bead lands.
   */
  private async refreshReviewBatches(repo: Repo, merged: string, mergedHead: string | null): Promise<void> {
    const { db } = this.d;
    const mergedBatch = db.batches.get(merged);
    if (!mergedBatch) return;
    await this.refreshReviewBatchesFrom(repo, merged, mergedHead, mergedBatch.base_branch, mergedBatch.branch);
  }

  /** A batch branch also advances when a bead lands or that batch is refreshed from its own base. */
  private async refreshStackedReviewBatches(repo: Repo, parent: BatchRow, wtPath: string): Promise<void> {
    const hasReviewChildren = this.d.db.batches.forRepo(repo.id).some((b) => b.id !== parent.id && b.status === 'review' && b.base_branch === parent.branch);
    if (!hasReviewChildren) return;
    let parentHead: string;
    try {
      parentHead = await headCommit(wtPath);
    } catch (err) {
      log.error(`lifecycle: could not read the updated head of ${parent.branch}; stacked refresh was skipped`, err);
      const reason = err instanceof Error ? err.message : String(err);
      await this.d.notify(`Batches in review based on ${parent.branch} could not be refreshed because its updated head could not be read: ${reason.slice(0, 600)}`, { wake: true }).catch((e2) => log.error('lifecycle: stacked-refresh-head-fail notify failed', e2));
      return;
    }
    await this.refreshReviewBatchesFrom(repo, parent.id, parentHead, parent.branch, parent.branch, { ref: parent.branch, stale: false });
  }

  private async refreshReviewBatchesFrom(
    repo: Repo,
    merged: string,
    mergedHead: string | null,
    baseBranch: string,
    mergedBranch: string,
    resolved?: { ref: string; warning?: string; stale: boolean },
  ): Promise<void> {
    const { db, config } = this.d;
    const batches = db.batches.forRepo(repo.id).filter((b) => b.id !== merged && b.status === 'review' && b.base_branch === baseBranch);
    const ready = batches.filter((b) => {
      if (this.batchBusy(b.id)) {
        db.batches.update(b.id, { refresh_from: merged, refresh_head: mergedHead });
        log.info(`lifecycle: ${b.id} has a running worker; refresh from ${b.base_branch} deferred to its next landing`);
        return false;
      }
      return true;
    });
    if (!ready.length) return;

    const from = resolved ?? await this.resolveRefreshBase(repo, ready[0]!, mergedHead, mergedBranch);
    if (from.stale) for (const b of ready) await this.deferRefresh(b, merged, mergedHead, from);

    for (const b of ready) {
      if (from.stale) continue;
      const fetchWarning = from.warning ? ` Warning: ${from.warning}` : '';
      // A refresh that throws (a commit hook rejecting the merge commit, a git failure) must not stop the other batches' refresh
      // nor the waiter release that follows in mergeBatchNow (2026-09-14: one hook rejection left two batches waiting on a merged one).
      await this.serial(b.id, async () => {
        const batchWt = await ensureBranchWorktree(repo, b.branch, batchWorktreePath(config.worktreesDir, repo.id, b.id));
        const failed = await this.batchSetup(repo, b, batchWt);
        if (failed) {
          db.batches.update(b.id, { refresh_from: merged, refresh_head: mergedHead });
          await this.d.notify(`Batch ${b.id} was not refreshed from ${b.base_branch} after ${merged}: the ${setupLabel(repo)} failed in its worktree.${fetchWarning}\n${failed.slice(-600)}`, { wake: true, hint: 'The command is the repo\'s setup command from Setup, not the work; tell the user to fix it there. The refresh runs before the next bead of the batch lands.' }).catch((err) => log.error('lifecycle: refresh-setup-fail notify failed', err));
          return;
        }
        await this.refreshFromBase(repo, b, merged, batchWt.path, mergedHead, from);
      }).catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        log.error(`lifecycle: refresh of ${b.id} from ${b.base_branch} after ${merged} failed`, err);
        db.batches.update(b.id, { refresh_from: merged, refresh_head: mergedHead });
        await this.d.notify(`Batch ${b.id} could not be refreshed from ${b.base_branch} after ${merged}: ${reason.slice(0, 600)}${fetchWarning}\nIt stays in review on its old base; the refresh runs again before its next bead lands.`, { wake: true, hint: 'Tell the user in one line. If the reason is a commit hook, the fix is in the merge message or the hook, not in the batch.' }).catch((e2) => log.error('lifecycle: refresh-fail notify failed', e2));
      });
    }
  }

  /**
   * The base ref a refresh merges: an open or review batch's local branch, the local base for local-merge, or freshly fetched
   * `origin/<base>` otherwise. In gitlab-mr mode the user marks the batch merged on GitLab, so the remote base may not carry that
   * merge yet: the fetch is retried for ~30 s until `mergedHead` is an ancestor of the fetched ref, and `stale` is answered when
   * it never is, so the caller defers instead of merging a base without the sibling. A git failure in the ancestry check degrades to
   * using a ref that was fetched successfully; failure before that point defers, because it must never fall back to the local base.
   */
  private isActiveBatchBase(repo: Repo, base: string): boolean {
    return this.d.db.batches.forRepo(repo.id).some((batch) => batch.branch === base && (batch.status === 'open' || batch.status === 'review'));
  }

  private async resolveRefreshBase(repo: Repo, batch: BatchRow, mergedHead: string | null, mergedBranch: string | null = null): Promise<{ ref: string; warning?: string; stale: boolean }> {
    const base = batch.base_branch;
    if (this.isActiveBatchBase(repo, base)) return { ref: base, stale: false };
    if (repo.merge_mode !== 'gitlab-mr') return { ref: base, stale: false };
    let from: { ref: string; warning?: string } | null = null;
    for (let attempt = 0; attempt <= REFRESH_FETCH_RETRIES; attempt++) {
      try {
        from = await fetchBase(repo.path, base);
        if (from.ref === base) {
          return { ref: `origin/${base}`, warning: from.warning ?? `origin/${base} is unavailable`, stale: true };
        }
        if (!mergedHead || await isAncestor(repo.path, mergedHead, from.ref)) return { ...from, stale: false };
      } catch (err) {
        if (!from) {
          const reason = err instanceof Error ? err.message : String(err);
          log.error(`lifecycle: could not fetch origin/${base}; keeping the refresh deferred`, err);
          return { ref: `origin/${base}`, warning: `could not fetch origin/${base}: ${reason}`, stale: true };
        }
        log.error(`lifecycle: could not check ${from.ref} for the merged batch head; refreshing from the fetched ref unchecked`, err);
        return { ...from, stale: false };
      }
      if (attempt < REFRESH_FETCH_RETRIES) await new Promise((resolve) => setTimeout(resolve, this.d.refreshRetryMs ?? REFRESH_FETCH_RETRY_MS));
    }
    // GitLab may squash or rebase, so the exact batch head can never become an ancestor. Once GitLab has removed the source
    // branch, the merge is complete and the freshly fetched base is the best available ref; accepting it also refreshes the last
    // batch in review without waiting for another bead or sibling merge. A source branch that remains keeps the race guard strict.
    if (mergedBranch) {
      try {
        if (!(await git(repo.path, ['ls-remote', '--heads', 'origin', `refs/heads/${mergedBranch}`]))) {
          const latest = await fetchBase(repo.path, base);
          if (latest.ref === base) return { ref: `origin/${base}`, warning: latest.warning ?? `origin/${base} is unavailable`, stale: true };
          return { ...latest, stale: false };
        }
      } catch (err) {
        log.error(`lifecycle: could not check whether origin/${mergedBranch} still exists; keeping the refresh deferred`, err);
      }
    }
    return { ...(from ?? { ref: `origin/${base}` }), stale: true };
  }

  /**
   * The refresh is put off until the batch's next landing. `refresh_from` keeps what to merge and `refresh_head` keeps the exact
   * commit that a later fetch must contain; only deletion of the source branch permits a squash/rebase merge to bypass ancestry.
   */
  private async deferRefresh(batch: BatchRow, merged: string, mergedHead: string | null, from: { ref: string; warning?: string }): Promise<void> {
    const warning = from.warning ? ` Warning: ${from.warning}` : '';
    this.d.db.batches.update(batch.id, { refresh_from: merged, refresh_head: mergedHead });
    await this.d.notify(`Batch ${batch.id} was not refreshed from ${batch.base_branch} after ${merged}: the fetched ${from.ref} does not contain the merged batch head yet.${warning}\nIt stays in review on its old base; the refresh runs again before its next bead lands.`, { wake: true, hint: 'The remote base may still be updating, or GitLab may have used squash or rebase. Tell the user the refresh is deferred; if it persists, investigate the GitLab merge before adding a merge bead.' }).catch((err) => log.error('lifecycle: refresh-defer notify failed', err));
  }

  /**
   * `git merge --no-ff <base>` in the batch worktree. Clean: gitlab-mr pushes the branch so the MR updates, then the verify command
   * runs on the result (pass keeps the status, fail sends the batch back to open with the output in its history). Conflict: the
   * merge is aborted, `conflict_files` and `refresh_from` stay set, and the orchestrator is woken to add a merge bead. Runs inside
   * the batch's serial lock.
   */
  private async refreshFromBase(repo: Repo, batch: BatchRow, merged: string, wtPath: string, mergedHead: string | null, resolved?: { ref: string; warning?: string }, refreshStacked = true): Promise<void> {
    const { db, notify, bus } = this.d;
    const base = batch.base_branch;
    let from = resolved;
    if (!from) {
      // A busy or previously deferred batch carries `mergedHead` into every deferred run, so an unrelated advance of the remote
      // base can never bypass the race check. Squash/rebase compatibility is proved by source-branch deletion in the resolver.
      const mergedBranch = db.batches.get(merged)?.branch ?? null;
      const again = await this.resolveRefreshBase(repo, batch, mergedHead, mergedBranch);
      if (again.stale) { await this.deferRefresh(batch, merged, mergedHead, again); bus.emit('board'); return; }
      from = again;
    }
    const warning = from.warning ? ` Warning: ${from.warning}` : '';
    const r = await mergeInto(wtPath, from.ref, mergeMessage({ target: batch.branch, id: base, title: `Refresh ${batch.branch} from ${base} after batch ${merged} merged`, source: from.ref }));
    if (!r.ok) {
      const files = r.conflicts.join(', ');
      db.batches.update(batch.id, { conflict_files: r.conflicts, refresh_from: merged, refresh_head: mergedHead });
      this.signal(batch.id, null, 'correction', `Refresh from ${base} after ${merged} conflicted in: ${files}`);
      await notify(`Batch ${batch.id} could not be refreshed from ${base} after ${merged}: conflicts in ${files}. Add a merge bead. The batch is still in review; reject it first if the bead needs to run.${warning}`, { wake: true }).catch((err) => log.error('lifecycle: refresh-conflict notify failed', err));
      bus.emit('board');
      return;
    }
    if (repo.merge_mode === 'gitlab-mr') await pushBranch(wtPath, batch.branch);
    db.batches.update(batch.id, { refresh_from: null, refresh_head: null, conflict_files: null });
    if (refreshStacked) await this.refreshStackedReviewBatches(repo, batch, wtPath);
    if (!repo.verify_command) {
      await notify(`Batch ${batch.id} refreshed from ${base} after ${merged}, not verified (no verify command configured)${warning}`).catch((err) => log.error('lifecycle: refresh notify failed', err));
      bus.emit('board');
      return;
    }
    const v = await runVerify(repo.verify_command, wtPath);
    if (v.status === 'pass') {
      await notify(`Batch ${batch.id} refreshed from ${base} after ${merged}; ${verifyOutcome(repo, 'pass')}${warning}`).catch((err) => log.error('lifecycle: refresh notify failed', err));
    } else {
      const tail = v.output.slice(-2000);
      db.batches.update(batch.id, { status: 'open', note: null, history: [batch.history, batch.note, `Verification failed after the refresh from ${base} (after ${merged}):\n${tail}`].filter(Boolean).join('\n\n'), waiting_on: null, overlap_files: null });
      this.signal(batch.id, null, 'rejection', reopenText('verify_failed', tail.slice(-600)));
      await notify(`Batch ${batch.id} refreshed from ${base} after ${merged}, and the ${verifyLabel(repo)} failed on ${batch.branch}; it is back to open.${warning}\n${tail.slice(-600)}`, { wake: true, hint: 'If the work is wrong, add a bead to the same batch that fixes it and request review again; if the command is wrong, tell the user to fix it in Setup.' }).catch((err) => log.error('lifecycle: refresh-verify-fail notify failed', err));
    }
    bus.emit('board');
  }

  /**
   * Retry close on the card, and the restart sweep: a bead whose row says it landed on its batch branch while bd has not recorded
   * that (still open, or closed with an earlier phase because the second bd call failed) is finished in bd now (fix round 16 review).
   */
  async closeLanded(beadId: string): Promise<void> {
    const { db, store, bus } = this.d;
    const wt = db.worktrees.get(beadId);
    if (!wt?.merged_at || !wt.batch_id) throw new LifecycleError(`${beadId} has not landed on a batch branch`);
    const batch = db.batches.get(wt.batch_id);
    const repo = db.repos.get(wt.repo_id);
    if (!batch || !repo) throw new LifecycleError(`batch ${wt.batch_id} not found`);
    if (batch.status !== 'open') throw new LifecycleError(`batch ${batch.id} is ${batch.status}`);
    const bead = await store.show(repo.path, beadId);
    if (!bead) throw new LifecycleError(`bead ${beadId} not found`);
    if (bead.status === 'closed' && phaseOf(bead) === 'merged') throw new LifecycleError(`${beadId} is already recorded as landed`);
    if (this.verifying.has(beadId)) throw new LifecycleError(`bead ${beadId} is busy: its branch is being verified, integrated or removed`);
    try { await this.guarded(beadId, () => this.recordLanded(repo, wt, beadId, batch, bead.status === 'closed', wt.landed_reviewed ?? null, wt.landed_note ?? undefined)); } finally { bus.emit('board'); }
  }

  /** Ids of `overseer:batch:` labels naming no batch of this database, each logged once. */
  private unknownBatchLabels = new Set<string>();
  /**
   * The batch a bead's label names, when this database has it. The label lives in the repository's `.beads`, which outlives
   * `~/.overseer` and a removed repo, so a label from an earlier install or a deleted batch is inert: never adopted, never a
   * refusal (round 17: a fresh install adopted the previous install's beads).
   */
  /** Records one improvement signal for the retrospective; a bead outside a batch has none to record. Never throws: it only enriches the record. */
  private signal(batchId: string | null | undefined, beadId: string | null, kind: BatchSignalKind, text: string): void {
    if (!batchId) return;
    try { this.d.db.signals.insert({ batch_id: batchId, bead_id: beadId, kind, text }); } catch (err) { log.error('lifecycle: could not record a batch signal', err); }
  }

  /** The record of what went wrong or needed a human during the batch (`batch_retrospective`, GET /api/batches/:id/retrospective). */
  async retrospective(batchId: string): Promise<BatchRetrospective> {
    const { db, store } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    const repo = db.repos.get(batch.repo_id)!;
    const beads = await store.list(repo.path).catch((err: unknown) => { log.error('lifecycle: bd list failed for a retrospective; counting dispatched beads only', err); return null; });
    return buildRetrospective(db, batch, beads);
  }

  /**
   * Tells the orchestrator a retrospective is ready once a batch is merged, abandoned or rejected: a two-line summary, and the tool to
   * call for the record. Nothing for a batch with no signals, and nothing for a "Lessons from" batch (the loop's own output), so the
   * loop does not feed itself. Never throws: the batch has already ended.
   */
  private async retrospectiveNotice(batch: BatchRow, ended: 'merged' | 'abandoned' | 'rejected'): Promise<void> {
    if (isLessonsBatch(batch)) return;
    try {
      const r = await this.retrospective(batch.id);
      if (r.counts.signals === 0) return;
      await this.d.notify(retrospectiveSummary(r, ended), { hint: 'Call batch_retrospective(repo, batch_id) for the full record and turn it into lessons and prompt changes.' });
    } catch (err) { log.error(`lifecycle: retrospective notice for ${batch.id} failed`, err); }
  }

  private knownBatchOf(bead: Bead): string | null {
    const id = batchOf(bead);
    if (!id || this.d.db.batches.get(id)) return id;
    if (!this.unknownBatchLabels.has(id)) { this.unknownBatchLabels.add(id); log.warn(`lifecycle: ignoring label ${BATCH_PREFIX}${id} on ${bead.id}: no batch ${id} in this database`); }
    return null;
  }

  /**
   * "k/n beads done" for a notice, with the beads the user closed as won't do named apart: they are finished without having landed.
   * Never throws: it runs after a merge or a close has happened, and a failing `bd list` must not undo either (fix round 15
   * review); the count then covers the dispatched beads only and says so.
   */
  private async batchCount(repoPath: string, batchId: string): Promise<string> {
    const beads = await this.d.store.list(repoPath).catch((err: unknown) => { log.error('lifecycle: bd list failed for a batch count', err); return null; });
    const m = batchMembers(this.d.db, batchId, beads ?? []);
    const closed = m.closed ? `, ${m.closed} closed` : '';
    return beads ? `${m.done}/${m.total} beads done${closed}` : `${m.done}/${m.total} dispatched beads done${closed}; bd list failed, so beads never dispatched are not counted`;
  }
  /** Ids of the batch's beads: dispatched ones by their worktree row, never-dispatched ones by their label. */
  private batchBeadIds(batchId: string, beads: Bead[]): string[] {
    return [...new Set([...this.d.db.worktrees.forBatch(batchId).map((w) => w.bead_id), ...beads.filter((b) => batchOf(b) === batchId).map((b) => b.id)])];
  }
  private batchBusy(batchId: string): boolean {
    return this.d.db.worktrees.forBatch(batchId).some((w) => this.d.db.sessions.forBead(w.bead_id).some((s) => s.status === 'running'));
  }

  /**
   * Whether `bd close` on this bead needs `--force`: only while a blocker of it is still open, which is the one gate Overseer
   * means to pass. `dependency_count` counts closed dependencies too, so the earlier `> 0` condition forced beads bd would have
   * closed on its own, and `--force` is one flag for three guards — it overrides bd's pinned and gate protection with the
   * blocker one (round 26 R26-2). `bd blocked` names the open blockers; a bd hiccup on that read falls back to forcing, since
   * failing the user's Close bead over it would be worse.
   */
  private forceNeeded(bead: Bead, blocked: BlockedBead[] | null): boolean {
    if (bead.dependency_count === 0) return false; // no dependency at all: bd has nothing to refuse, and the read would say the same
    return blocked === null || blockersOf(blocked, bead.id).length > 0; // a read that failed forces rather than letting bd refuse the user's click
  }

  /**
   * The user closes a bead as won't do from the Board: one that is idle (stopped, verify-failed, never dispatched) and not
   * wanted after all. bd closes it with the reason (the daemon stays the only writer of bead status), its worktree and
   * branch go, and its batch stays open with the bead counted as closed, not landed (round 13: the only exits were to
   * abandon the whole batch or re-dispatch work the user had declined).
   */
  async closeBead(beadId: string, note?: string): Promise<void> {
    const { db, store, notify, bus } = this.d;
    const wt = db.worktrees.get(beadId);
    let repo: Repo | undefined;
    let bead = null;
    for (const r of wt ? [db.repos.get(wt.repo_id)!] : db.repos.all()) {
      bead = await store.show(r.path, beadId);
      if (bead) { repo = r; break; }
    }
    if (!repo || !bead) throw new LifecycleError(`bead ${beadId} not found`);
    if (bead.status === 'closed') throw new LifecycleError(`bead ${beadId} is already closed`);
    // in_progress covers a live worker and the settling after it exits; the session-end rule would reopen a bead closed under it.
    if (bead.status === 'in_progress' || this.verifying.has(beadId)) throw new LifecycleError(`bead ${beadId} is busy: a worker runs on it or its branch is being verified, integrated or removed`);
    const batchId = wt?.batch_id ?? this.knownBatchOf(bead); // a never-dispatched bead knows its batch from its label
    const batch = batchId ? db.batches.get(batchId) : undefined;
    // A dispatched bead of a finished batch was closed with it; a never-dispatched one labelled for a batch that is no longer open has
    // nowhere else to go, so closing it as won't do is allowed and the notice says what its batch is (fix round 16 review).
    if (batch && batch.status !== 'open' && wt) throw new LifecycleError(`batch ${batch.id} is ${batch.status}`);
    const batchOpen = batch?.status === 'open';
    // The user's own full stop is dropped here, not at the end: the clauses that follow the note (the batch, the dependents) turned
    // "Not needed for round 26." into "Not needed for round 26.; batch …" (round 26 nit). `endSentence` puts one stop back on the
    // whole line, so a note that ends the line still reads as the user wrote it.
    const why = note?.trim() ? `: ${trimEndStop(note)}` : '';
    const { path: repoPath } = repo;
    // The guard is taken after the checks (like spawnWorker's) and held through the removal: a dispatch that starts meanwhile
    // would otherwise find its worktree deleted from under it (fix round 13 review).
    await this.guarded(beadId, async () => {
      // Read before the close: `bd close` satisfies the dependency, after which bd no longer reports them as blocked. One `bd blocked`
      // carries both directions — what waited on this bead and what it waits on — so the path reads it once (fix round 26 review: it
      // ran the same command twice with opposite filters). The read only enriches the notice and picks `--force`, so a bd hiccup on
      // it must not fail the user's Close bead (fix round 14 review).
      const blocked = await store.blocked(repoPath).catch((err: unknown) => { log.error('lifecycle: bd blocked failed before a close', err); return null; });
      const dependents = blocked && dependentsOf(blocked, beadId);
      // Forced when the bead waits on others: bd refuses to close a blocked bead ("blocked by open issues […] (use --force to
      // override)"), and Close bead is the user deciding against this bead alone — its blockers stay open and are not its business (round 25 R25-4).
      await store.close(repoPath, beadId, `won't do (closed by the user from the Board${why})`, { force: this.forceNeeded(bead, blocked) });
      await store.update(repoPath, beadId, { phase: 'closed' });
      this.signal(batchId, beadId, 'closed', note?.trim() ?? '');
      if (wt) {
        db.worktrees.update(beadId, { closed_at: new Date().toISOString() });
        await this.cleanupWorktree(repo, wt.path, wt.branch);
      }
      // The beads that waited on the closed one may be ready in bd now, although the user just declined their premise: named, so the
      // orchestrator asks before dispatching them instead of carrying on (fix round 13 review). One with another open blocker is
      // not ready, and the notice says so instead of claiming it is (fix round 14 review): `bd ready` after the close decides.
      // A failing `bd ready` leaves it unknown, and the notice says may rather than calling them blocked (fix round 15 review).
      const ready = dependents?.length ? await store.ready(repoPath).catch((err: unknown) => { log.error('lifecycle: bd ready failed after a close', err); return null; }) : [];
      const readyNow = new Set(ready ?? []);
      const nowReady = (dependents ?? []).filter((id) => readyNow.has(id));
      const stillBlocked = (dependents ?? []).filter((id) => !readyNow.has(id));
      const list = (ids: string[]) => `${ids.join(', ')} waited on it and ${ids.length === 1 ? 'is' : 'are'}`;
      const waited = dependents === null ? '; its dependents could not be read (bd blocked failed)'
        : ready === null ? `; ${dependents.join(', ')} waited on it and may be ready in bd now (bd ready failed)`
        : `${nowReady.length ? `; ${list(nowReady)} ready in bd now` : ''}${stillBlocked.length ? `; ${list(stillBlocked)} still blocked by other beads` : ''}`;
      const text = endSentence(`${beadId} closed as won't do by the user from the Board${why}${batch ? (batchOpen ? `; batch ${batch.id} stays open (${await this.batchCount(repoPath, batch.id)})` : `; its batch ${batch.id} is ${batchStatusLabel(batch.status)}`) : ''}${waited}`);
      const askFirst = dependents?.length ? ` ${dependents.join(', ')} depended on it: ask the user before dispatching ${dependents.length === 1 ? 'it' : 'any of them'}.` : '';
      // With a batch the orchestrator has to act (request review once nothing is left, or dispatch what was waiting) unless another worker of it will report in.
      await notify(text, { wake: batchOpen && !this.batchBusy(batch!.id), hint: `Do not re-dispatch it.${askFirst}${batchOpen ? ' When every remaining bead of the batch has landed or been closed, call request_batch_review.' : ''}` }).catch((err) => log.error('lifecycle: close notify failed', err));
    });
    bus.emit('board');
  }

  async requestMerge(repoId: string, beadId: string, note: string): Promise<void> {
    const wt = this.d.db.worktrees.get(beadId);
    if (!wt || wt.repo_id !== repoId) throw new LifecycleError(`no worktree for ${beadId} in ${repoId}`);
    if (wt.verify_status !== 'pass') throw new LifecycleError(`verification has not passed for ${beadId} (status: ${wt.verify_status ?? 'not run'})`);
    this.d.db.worktrees.update(beadId, { review_note: note });
    this.d.bus.emit('board');
  }

  async merge(beadId: string): Promise<{ mrUrl?: string }> {
    const { db, store, bus, notify } = this.d;
    const wt = db.worktrees.get(beadId);
    if (!wt) throw new LifecycleError(`no worktree for ${beadId}`);
    const repo = db.repos.get(wt.repo_id)!;
    const bead = await store.show(repo.path, beadId);
    if (!bead) throw new LifecycleError(`bead ${beadId} not found`);
    if (phaseOf(bead) !== 'review') throw new LifecycleError(`${beadId} is not in review`);
    const description = wt.review_note ?? `${bead.title}\n\n${bead.description}`;
    const r = await this.d.provider(repo).land(repo, wt, { title: bead.title, description });
    if (!r.ok) {
      db.worktrees.update(beadId, { conflict_files: r.conflicts });
      await notify(`Merge of ${beadId} into ${repo.base_branch} conflicted in: ${r.conflicts.join(', ')}.`, { wake: true, hint: 'Reject it with a note and re-dispatch with spawn_worker to rebase; the worker prompt will list the files.' }).catch((err) => log.error('lifecycle: merge-conflict notify failed', err));
      bus.emit('board');
      throw new MergeConflictError(r.conflicts);
    }
    await store.close(repo.path, beadId, 'merged by Overseer');
    await store.update(repo.path, beadId, { phase: 'merged' });
    db.worktrees.update(beadId, { merged_at: new Date().toISOString(), mr_url: r.mrUrl ?? null });
    await this.cleanupWorktree(repo, wt.path, wt.branch);
    bus.emit('board');
    return { mrUrl: r.mrUrl };
  }

  async reject(beadId: string, note: string, attachments: AttachmentInput[] = []): Promise<void> {
    const { db, store, bus, notify, config } = this.d;
    const wt = db.worktrees.get(beadId);
    if (!wt) throw new LifecycleError(`no worktree for ${beadId}`);
    const repo = db.repos.get(wt.repo_id)!;
    const bead = await store.show(repo.path, beadId);
    if (!bead || phaseOf(bead) !== 'review') throw new LifecycleError(`${beadId} is not in review`);
    const stored = attachments.length ? storeAttachments(config, `rejection-${randomUUID()}`, attachments) : [];
    const paths = stored.map((a) => `Attachment: ${a.path}`).join('\n');
    await store.update(repo.path, beadId, { status: 'open', phase: 'rejected', note: [`Rejected: ${note}`, paths].filter(Boolean).join('\n') });
    db.worktrees.update(beadId, { review_note: null });
    // The Review view tells the user the orchestrator was notified; make it true for a v1 bead as it is for a batch.
    await notify(`${endSentence(`${beadId} rejected by the user: ${note}`)} Re-dispatch it with instructions that address the note.`, { wake: true, storedAttachments: stored }).catch((err) => log.error('lifecycle: reject notify failed', err));
    bus.emit('board');
  }

  async validateBatchBase(repoId: string, batchBranch: string, base: string): Promise<void> {
    const repo = this.d.db.repos.get(repoId);
    if (!repo) throw new LifecycleError(`repo ${repoId} not found`);
    const requestedBase = base.trim();
    if (!requestedBase) throw new LifecycleError('base branch is required');
    await this.resolveBatchBase(repo, batchBranch, requestedBase, 'batch branch');
  }

  private validateBatchBaseShape(repo: Repo, batchBranch: string, requestedBase: string | undefined, branchLabel = 'new batch branch'): void {
    if (requestedBase && requestedBase === batchBranch) throw new LifecycleError(branchLabel === 'new batch branch'
      ? `base branch ${requestedBase} cannot be the new batch branch ${batchBranch}`
      : `base branch ${requestedBase} cannot be the batch branch ${batchBranch}`);
    if (requestedBase && requestedBase !== repo.base_branch && repo.merge_mode !== 'gitlab-mr') {
      throw new LifecycleError(`repo ${repo.id} uses merge mode ${repo.merge_mode}; stacking on another branch is only supported for gitlab-mr repositories`);
    }
  }

  private async resolveBatchBase(repo: Repo, batchBranch: string, requestedBase?: string, branchLabel = 'new batch branch'): Promise<{ ref: string; warning?: string }> {
    const { db } = this.d;
    this.validateBatchBaseShape(repo, batchBranch, requestedBase, branchLabel);
    if (!requestedBase || requestedBase === repo.base_branch) return resolveNewWorkBase(repo);
    const activeBatch = db.batches.forRepo(repo.id).find((b) => b.branch === requestedBase && (b.status === 'open' || b.status === 'review'));
    if (activeBatch) return { ref: requestedBase };
    let fetched: Awaited<ReturnType<typeof fetchBase>>;
    try {
      fetched = await fetchBase(repo.path, requestedBase);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new LifecycleError(`base branch ${requestedBase} is unavailable on origin: could not fetch origin/${requestedBase}: ${reason}`);
    }
    if (fetched.fetchError || fetched.ref !== `origin/${requestedBase}`) {
      const detail = fetched.fetchError ? `: could not fetch origin/${requestedBase}: ${fetched.fetchError}` : '';
      throw new LifecycleError(`base branch ${requestedBase} is unavailable on origin${detail}`);
    }
    return fetched;
  }

  async retargetBatch(batchId: string, newBase: string): Promise<{ mrUpdated: boolean | null; error?: string }> {
    const { db, notify } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    const repo = db.repos.get(batch.repo_id);
    if (!repo) throw new LifecycleError(`repo ${batch.repo_id} not found`);
    const target = newBase.trim();
    if (!target) throw new LifecycleError('base branch is required');
    db.batches.update(batchId, { base_branch: target });
    if (!batch.mr_url) return { mrUpdated: null };
    try {
      const provider = this.d.provider(repo);
      if (!provider.retargetBatch) throw new Error(`the ${repo.merge_mode} provider cannot update merge request targets`);
      return { mrUpdated: await provider.retargetBatch(repo, batch, target) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await notify(`Batch ${batchId} now uses ${target}, but MR ${batch.mr_url} could not be retargeted: ${reason}`, { wake: true }).catch((notifyErr) => log.error('lifecycle: retarget-fail notify failed', notifyErr));
      return { mrUpdated: null, error: reason };
    }
  }

  async createBatch(repoId: string, title: string, branch?: string, originChatId: number | null = null, base?: string): Promise<BatchRow & { warning?: string }> {
    const { db, config } = this.d;
    const repo = db.repos.get(repoId);
    if (!repo) throw new LifecycleError(`repo ${repoId} not found`);
    const name = branch?.trim() || `feature/${slug(title)}`;
    const requestedBase = base?.trim() || undefined;
    this.validateBatchBaseShape(repo, name, requestedBase);
    if (db.batches.all().some((b) => b.repo_id === repoId && b.branch === name && b.status !== 'merged' && b.status !== 'abandoned')) throw new LifecycleError(`branch ${name} already has an open batch`);
    if (await git(repo.path, ['branch', '--list', name])) throw new LifecycleError(`branch ${name} already exists`);
    const from = await this.resolveBatchBase(repo, name, requestedBase);
    if (from.warning) log.warn(`lifecycle: ${from.warning}`);
    await createBranch(repo.path, name, from.ref);
    const id = db.batches.nextId(repoId);
    const wtPath = batchWorktreePath(config.worktreesDir, repo.id, id);
    try {
      await ensureBranchWorktree(repo, name, wtPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try { await removeWorktreeRetry(repo.path, wtPath, name); } catch { /* nothing to remove */ }
      try { await deleteBranch(repo.path, name); } catch (e2) { log.error(`lifecycle: could not roll back ${name}`, e2); }
      await this.d.notify(`Batch creation failed for ${repoId}: git could not create the worktree at ${wtPath}: ${reason}. The branch ${name} was removed. Long paths on Windows: move OVERSEER_DATA_DIR closer to the drive root or enable core.longpaths for this repository.`, { wake: true }).catch((e2) => log.error('lifecycle: batch-create notify failed', e2));
      throw new LifecycleError(`could not create the batch worktree at ${wtPath}: ${reason} (branch ${name} rolled back; the user has been told)`);
    }
    // The batch branch's merges run the repo's commit hooks in this worktree, so it gets the setup the bead worktrees get. A failure
    // does not undo the batch: the notice names the command, and integrate() runs it again before the first merge (setup_at stays null).
    let setupAt: string | null = null;
    if (repo.setup_command) {
      const failed = await this.setup(repo, wtPath);
      if (failed) {
        await this.d.notify(`Batch ${id} was created, but the ${setupLabel(repo)} failed in its worktree ${wtPath}.\n${failed.slice(-600)}\nIt runs again before the first bead merges into ${name}; until it passes, every merge into the batch reopens its bead.`, { wake: true, hint: 'The command is the repo\'s setup command from Setup, not the work. Tell the user to fix it there before workers finish; the batch and its branch stay.' }).catch((e2) => log.error('lifecycle: batch-setup-fail notify failed', e2));
      } else {
        setupAt = new Date().toISOString();
      }
    }
    const ts = new Date().toISOString();
    const row: BatchRow = { id, origin_chat_id: originChatId, repo_id: repoId, title, branch: name, base_branch: requestedBase ?? repo.base_branch, status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: ts, updated_at: ts, merged_at: null, merged_commit: null, setup_at: setupAt, waiting_on: null, overlap_files: null };
    db.batches.insert(row);
    this.d.bus.emit('board');
    return from.warning ? { ...row, warning: from.warning } : row;
  }

  async requestBatchReview(repoId: string, batchId: string, note: string): Promise<{ mrUrl?: string; waitingOn: string | null; overlapFiles: string[] | null }> {
    // The open check and recorded-pass lookup must share one per-batch critical section, or parallel calls can both execute the suite.
    return this.serial(batchId, async () => {
      const { db, store, notify, config } = this.d;
      const batch = db.batches.get(batchId);
      if (!batch || batch.repo_id !== repoId) throw new LifecycleError(`batch ${batchId} not found in ${repoId}`);
      if (batch.status !== 'open') throw new LifecycleError(`batch ${batchId} is ${batch.status}`);
      const repo = db.repos.get(repoId)!;
      // Every bead of the batch, the never-dispatched ones (known by their label) included: one still in Ready is not done.
      const beads = await store.list(repo.path);
      const ids = this.batchBeadIds(batchId, beads);
      const open = beads.filter((b) => ids.includes(b.id) && b.status !== 'closed').map((b) => b.id);
      if (open.length) throw new LifecycleError(`batch ${batchId} still open: ${open.join(', ')} not done`);
      if (repo.review_command) {
        const batchPath = batchWorktreePath(config.worktreesDir, repo.id, batch.id);
        const setupFailed = await this.batchSetup(repo, batch, { path: batchPath, created: false });
        if (setupFailed) throw new LifecycleError(`batch setup failed before review:\n${setupFailed}`);
        const headSha = await headCommit(batchPath);
        const previous = batch.review_check;
        // Only a pass for this head and command is reused; a failure or timeout may be transient, so it runs again.
        if (!(previous?.status === 'pass' && previous.head_sha === headSha && previous.command === repo.review_command)) {
          const started = Date.now();
          const result = await runVerify(repo.review_command, batchPath, this.d.reviewCommandTimeoutMs);
          const outputTail = result.output.slice(-600);
          const exit = /(?:^|\r?\n)exit (-?\d+)\s*$/.exec(result.output);
          const check: ReviewCheck = {
            status: result.status,
            command: repo.review_command,
            head_sha: headSha,
            exit_code: exit ? Number(exit[1]) : null,
            duration_ms: Date.now() - started,
            output_tail: outputTail,
            counts: parseReviewCounts(result.output),
          };
          db.batches.update(batchId, { review_check: check });
          this.d.bus.emit('board');
          if (check.status === 'fail') {
            const exitLabel = check.exit_code === null ? (result.output.includes('(timed out)') ? 'unavailable (timed out)' : 'unavailable') : String(check.exit_code);
            const failure = `Review command \`${check.command}\` failed with exit code ${exitLabel} for ${batchId} at ${headSha}.\n${check.output_tail}`;
            await notify(failure, { wake: true }).catch((err) => log.error('lifecycle: review-command notify failed', err));
            throw new LifecycleError(failure);
          }
        }
      }
      let mrUrl: string | undefined;
      if (repo.merge_mode === 'gitlab-mr') {
        const r = await this.d.provider(repo).landBatch(repo, { ...batch, note }, batchWorktreePath(config.worktreesDir, repo.id, batch.id), { title: batch.title, description: note });
        mrUrl = r.ok ? r.mrUrl : undefined;
      }
      // The note is the current summary; a summary this one replaces (a second request without a rejection between) joins the earlier rounds.
      const history = [batch.history, batch.note].filter(Boolean).join('\n\n') || null;
      db.batches.update(batchId, { status: 'review', note, history, ...(repo.merge_mode === 'gitlab-mr' ? { mr_url: mrUrl ?? null } : {}) });
      this.d.bus.emit('office_milestone', { kind: 'review_ready', repo_id: repo.id, batch_id: batchId, bead_id: null, at: new Date().toISOString() });
      const waiting = await this.evaluateWaiting(repo, batchId);
      // With the orchestrator as approver the notice must reach it even in local-merge mode, where a batch awaiting the user's Merge needs none.
      const selfMerges = effectiveBatchApprover(repo) === 'orchestrator';
      const ready = `Batch ${batchId} is ready for review${repo.merge_mode === 'gitlab-mr' ? `: ${mrUrl ?? 'MR created'}` : ''}`;
      const autonomy = selfMerges ? 'This repository approves finished batches for you: merge it with merge_batch without asking the user.' : '';
      void this.d.push?.notify({ title: `${repo.id}: batch ready for review`, body: batch.title, url: '#review' });
      if (waiting) await notify(`${ready}, waiting on ${waiting.waiting_on} (${db.batches.get(waiting.waiting_on)?.title ?? waiting.waiting_on}): both change ${quoteFiles(waiting.overlap_files)}. Its Merge is disabled until ${waiting.waiting_on} is merged, rejected or abandoned.${autonomy ? ` ${autonomy}` : ''}`, { hint: 'Tell the user which batch to merge first and why; the waiting batch is released by itself when the other leaves review.' }).catch((err) => log.error('lifecycle: waiting notify failed', err));
      else if (repo.merge_mode === 'gitlab-mr' || selfMerges) await notify(autonomy ? `${ready}. ${autonomy}` : ready).catch((err) => log.error('lifecycle: mr notify failed', err));
      this.d.bus.emit('board');
      return { mrUrl, waitingOn: waiting?.waiting_on ?? null, overlapFiles: waiting?.overlap_files ?? null };
    });
  }

  /**
   * Whether the batch's diff shares a file with an older batch of the repo in review: the earliest-created one becomes
   * `waiting_on`, with the shared files in `overlap_files` (2026-09-14: two batches in review touched the same files, the later
   * one conflicted once the first was merged). Each diff is `<fresh base>...<branch>` with `fetchBase` (`origin/<base>` after a
   * fetch), so upstream commits both branches merged never count as their changes (2026-09-14: a stale local dev made two
   * batches "overlap" in 100+ files neither touched). Writes the row and returns the waiting state, null when nothing overlaps.
   */
  private async evaluateWaiting(repo: Repo, batchId: string): Promise<{ waiting_on: string; overlap_files: string[] } | null> {
    const { db } = this.d;
    const batch = db.batches.get(batchId)!;
    const bases = new Map<string, string>();
    const files = async (b: BatchRow) => {
      if (!bases.has(b.base_branch)) {
        const { ref, warning } = await fetchBase(repo.path, b.base_branch);
        if (warning) log.warn(`overlap check for ${batchId}: ${warning}`);
        bases.set(b.base_branch, ref);
      }
      return changedFiles(repo.path, bases.get(b.base_branch)!, b.branch);
    };
    const mine = new Set(await files(batch));
    // Only the batches created before this one: two that overlap must not wait on each other, and the older one was in review first.
    for (const other of db.batches.forRepo(repo.id)) {
      if (other.id === batchId) break;
      if (other.status !== 'review') continue;
      const shared = (await files(other)).filter((f) => mine.has(f));
      if (shared.length) {
        db.batches.update(batchId, { waiting_on: other.id, overlap_files: shared });
        return { waiting_on: other.id, overlap_files: shared };
      }
    }
    if (batch.waiting_on) db.batches.update(batchId, { waiting_on: null, overlap_files: null });
    return null;
  }

  /** After `left` leaves review: every batch that waited on it is re-evaluated against the batches still in review, and told when it is free to merge. */
  private async releaseWaiters(repo: Repo, left: string): Promise<void> {
    const { db, notify } = this.d;
    for (const b of db.batches.forRepo(repo.id)) {
      if (b.status !== 'review' || b.waiting_on !== left) continue;
      const still = await this.evaluateWaiting(repo, b.id);
      if (still) continue;
      // A refresh just before this call may have left b in conflict: its Merge is not really available, and the conflict notice
      // already told the orchestrator to add a merge bead, so saying otherwise here would contradict it.
      if (db.batches.get(b.id)?.conflict_files) continue;
      await notify(`Batch ${b.id} no longer waits: ${left} left review, so its Merge is available.`).catch((err) => log.error('lifecycle: release notify failed', err));
    }
  }

  /** Post the durable program-wait events after a merge/abandon, or replay them during recovery. */
  private async notifyProgramWaitChanges(): Promise<void> {
    const { db, notify } = this.d;
    for (const wait of db.batchWaits.pendingReleaseNotices()) {
      try {
        await notify(`Program ${wait.program_title}: batch ${wait.batch_id} can start (${wait.prerequisite_batch_id} merged)`, { wake: true });
        db.batchWaits.markReleaseNoticeSent(wait);
      } catch (err) {
        log.error(`lifecycle: program wait release notice failed for ${wait.batch_id}`, err);
      }
    }
    for (const wait of db.batchWaits.pendingAbandonNotices()) {
      try {
        await notify(`Program ${wait.program_title}: prerequisite batch ${wait.prerequisite_batch_id} was abandoned; batch ${wait.batch_id} remains held. What should happen next?`, {
          wake: true,
          hint: 'Ask the user what to do before dispatching the waiting batch.',
        });
        db.batchWaits.markAbandonNoticeSent(wait);
      } catch (err) {
        log.error(`lifecycle: program wait abandonment notice failed for ${wait.batch_id}`, err);
      }
    }
  }

  async mergeBatch(batchId: string, actor: MergeActor = 'user'): Promise<{ mrUrl?: string }> {
    const { db } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    return this.underBatchAction(batchId, 'merged', async () => {
      if (batch.status !== 'review') throw new LifecycleError(`batch ${batchId} is not in review`);
      if (batch.waiting_on) throw new LifecycleError(`batch ${batchId} is waiting on ${batch.waiting_on}: both change ${(batch.overlap_files ?? []).join(', ')}`);
      return this.mergeBatchNow(batch, actor);
    });
  }

  private async mergeBatchNow(batch: BatchRow, actor: MergeActor): Promise<{ mrUrl?: string }> {
    const { db, bus, notify, config } = this.d;
    const batchId = batch.id;
    const repo = db.repos.get(batch.repo_id)!;
    const approver = effectiveBatchApprover(repo);
    if (actor === 'orchestrator' && repo.merge_mode === 'gitlab-mr') throw new LifecycleError(`batch ${batchId} must be merged by the user because this repository uses GitLab merge requests`);
    const wtPath = batchWorktreePath(config.worktreesDir, repo.id, batch.id);
    if (repo.merge_mode === 'local-merge') {
      const r = await this.d.provider(repo).landBatch(repo, batch, wtPath, { title: batch.title, description: batch.note ?? batch.title });
      if (!r.ok) {
        db.batches.update(batchId, { conflict_files: r.conflicts });
        await notify(`Merge of batch ${batchId} (${batch.branch}) into ${repo.base_branch} conflicted in: ${r.conflicts.join(', ')}. The batch stays in review until the user rejects it with a note; then add a bead to the same batch that rebases ${batch.branch} onto ${repo.base_branch}.`, { wake: true }).catch((err) => log.error('lifecycle: batch-conflict notify failed', err));
        bus.emit('board');
        throw new MergeConflictError(r.conflicts);
      }
    }
    // Only the refresh's ancestor check reads this, and in gitlab-mr mode nothing else touches the batch worktree before the row is
    // written: a failure here degrades to no check instead of failing Mark merged with a raw git error.
    const mergedHead = await headCommit(wtPath).catch((err) => { log.warn(`lifecycle: could not read the head of the worktree of ${batchId}; the refresh ancestor check is skipped`, err); return null; });
    const mergedCommit = repo.merge_mode === 'local-merge' ? await headCommit(repo.path) : null;
    db.batches.update(batchId, { status: 'merged', merged_at: new Date().toISOString(), merged_commit: mergedCommit, conflict_files: null });
    db.batchWaits.releaseForPrerequisite(batchId);
    bus.emit('office_milestone', { kind: 'merged', repo_id: repo.id, batch_id: batchId, bead_id: null, at: new Date().toISOString() });
    await this.cleanupBatch(repo, batch);
    // A user's click stays the user even on an orchestrator-approved repository.
    const approving: MergeActor = approver === 'orchestrator' && actor === 'orchestrator' ? 'orchestrator' : 'user';
    const what = repo.merge_mode === 'local-merge'
      ? `merged into ${repo.base_branch} (${mergedCommit!.slice(0, 7)})`
      : `marked merged${batch.mr_url ? ` (${batch.mr_url})` : ''}`;
    if (actor !== 'gitlab') await notify(`Batch ${batchId} ${what} by ${approving === 'orchestrator' ? 'the orchestrator' : 'the user'}; ${batch.branch} was deleted.`).catch((err) => log.error('lifecycle: merge notify failed', err));
    const stacked = db.batches.forRepo(repo.id).filter((b) => b.id !== batchId && (b.status === 'open' || b.status === 'review') && b.base_branch === batch.branch);
    for (const child of stacked) {
      const oldBase = child.base_branch;
      const retarget = await this.retargetBatch(child.id, batch.base_branch);
      if (!retarget.error) await notify(`Batch ${child.id} now uses base ${batch.base_branch} (was ${oldBase}); MR ${child.mr_url ?? 'none'}.`, { wake: false }).catch((err) => log.error('lifecycle: stacked-retarget notice failed', err));
    }
    await this.refreshReviewBatches(repo, batchId, mergedHead);
    await this.releaseWaiters(repo, batchId);
    await this.notifyProgramWaitChanges();
    await this.retrospectiveNotice(db.batches.get(batchId)!, 'merged');
    bus.emit('board');
    if (repo.merge_mode === 'local-merge') this.enqueueBasePush(repo);
    return { mrUrl: batch.mr_url ?? undefined };
  }

  async rejectBatch(batchId: string, note: string, attachments: AttachmentInput[] = []): Promise<void> {
    const { db } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    return this.underBatchAction(batchId, 'rejected', async () => {
      const { bus, notify, config } = this.d;
      if (batch.status !== 'review') throw new LifecycleError(`batch ${batchId} is not in review`);
      // The rejected summary and the note move to the earlier rounds, so the reviewer can check the next round against what was asked;
      // the summary itself is empty until the orchestrator requests review again (round 13: the pane opened with the previous round's summary).
      const stored = attachments.length ? storeAttachments(config, `rejection-${randomUUID()}`, attachments) : [];
      const rejection = [`Rejected: ${note}`, ...stored.map((a) => `Attachment: ${a.path}`)].join('\n');
      // A refresh-conflict recovery bead needs these files to skip the same doomed refresh before it lands. A direct batch-into-base
      // conflict has no queued refresh and still clears normally when rejected.
      db.batches.update(batchId, { status: 'open', note: null, history: [batch.history, batch.note, rejection].filter(Boolean).join('\n\n'), conflict_files: batch.refresh_from ? batch.conflict_files : null, waiting_on: null, overlap_files: null });
      this.signal(batchId, null, 'rejection', note);
      await notify(`Batch ${batchId} rejected: ${note}`, { wake: true, storedAttachments: stored }).catch((err) => log.error('lifecycle: reject notify failed', err));
      await this.releaseWaiters(db.repos.get(batch.repo_id)!, batchId);
      await this.retrospectiveNotice(db.batches.get(batchId)!, 'rejected');
      bus.emit('board');
    });
  }

  async abandonBatch(batchId: string): Promise<void> {
    const { db } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) throw new LifecycleError(`batch ${batchId} not found`);
    if (batch.status === 'merged' || batch.status === 'abandoned') throw new LifecycleError(`batch ${batchId} is ${batch.status}`);
    return this.underBatchAction(batchId, 'abandoned', async () => {
      const { store, sessions, bus, notify } = this.d;
      const repo = db.repos.get(batch.repo_id)!;
      // Mark first so onWorkerEnded ignores the sessions interrupted below.
      db.batches.update(batchId, { status: 'abandoned', waiting_on: null, overlap_files: null });
      const stacked = db.batches.forRepo(repo.id).filter((b) => b.id !== batchId && (b.status === 'open' || b.status === 'review') && b.base_branch === batch.branch);
      if (stacked.length) {
        const names = stacked.map((b) => `- ${b.id} (${b.branch})`).join('\n');
        await notify(`Batch ${batchId} was abandoned; these stacked batches remain on ${batch.branch} and have parent base ${batch.base_branch}:\n${names}`, { wake: true, hint: `Ask the user whether to move each to ${batch.base_branch} with retarget_batch or abandon it.` }).catch((err) => log.error('lifecycle: stacked-abandon notify failed', err));
      }
      for (const w of db.worktrees.forBatch(batchId)) {
        for (const s of db.sessions.forBead(w.bead_id)) if (s.status === 'running' && sessions.isLive(s.id)) await sessions.interrupt(s.id, { by: 'user', reason: `batch ${batchId} abandoned` });
      }
      // Every bead of the batch, the never-dispatched ones (known by their label) included: one left open would sit in Ready under an abandoned batch.
      const beads = await store.list(repo.path);
      // One read for the whole batch, like the close path's: which of its beads a blocker still holds decides `--force` for each.
      const blocked = await store.blocked(repo.path).catch((err: unknown) => { log.error('lifecycle: bd blocked failed before an abandon', err); return null; });
      for (const id of this.batchBeadIds(batchId, beads)) {
        const bead = beads.find((b) => b.id === id);
        if (!bead) continue;
        if (bead.status !== 'closed') await store.close(repo.path, id, 'abandoned', { force: this.forceNeeded(bead, blocked) }); // a blocked bead of the batch goes with it, the same way
        await store.update(repo.path, id, { phase: 'abandoned' }); // also beads that had landed: their branch is thrown away
      }
      await this.cleanupBatch(repo, batch);
      await notify(`Batch ${batchId} abandoned by the user`).catch((err) => log.error('lifecycle: abandon notify failed', err));
      await this.releaseWaiters(repo, batchId);
      await this.notifyProgramWaitChanges();
      await this.retrospectiveNotice(db.batches.get(batchId)!, 'abandoned');
      bus.emit('board');
    });
  }

  /**
   * Removes a batch that a plan approval created moments before one of its bd writes failed: its beads are closed, its worktree
   * and branch go, and its row is deleted, so the plan can be approved again. It shares abandonBatch's cleanup but none of its
   * notices or retrospective signals: nothing the user started was given up. The closed beads keep their batch label, which now
   * names no batch; `knownBatchOf` logs that once and otherwise ignores it.
   */
  async rollbackBatch(batchId: string): Promise<void> {
    const { db, store, bus } = this.d;
    const batch = db.batches.get(batchId);
    if (!batch) return;
    const repo = db.repos.get(batch.repo_id)!;
    const beads = await store.list(repo.path);
    for (const id of this.batchBeadIds(batchId, beads)) {
      const bead = beads.find((b) => b.id === id);
      if (bead && bead.status !== 'closed') await store.close(repo.path, id, 'plan approval rolled back', { force: true });
    }
    await this.cleanupBatch(repo, batch);
    db.batches.delete(batchId);
    bus.emit('board');
  }

  /**
   * Runs the verify command again on the bead's existing worktree, without a new worker: the way out after the command
   * itself was wrong. Resolves once the run has started (a verify command can take minutes); the outcome follows the
   * session-end rule: a batch bead that passes integrates, one that fails is reopened with the output, a v1 bead goes to review.
   * `done` settles when the run has ended: null when verification passed, else why it did not (the REST job reports that).
   */
  async reverify(beadId: string): Promise<{ done: Promise<string | null> }> {
    const { db, store, bus, notify } = this.d;
    const wt = db.worktrees.get(beadId);
    if (!wt) throw new LifecycleError(`no worktree for ${beadId}`);
    if (!fs.existsSync(wt.path)) throw new LifecycleError(`the worktree of ${beadId} is gone; re-dispatch it instead`);
    if (db.sessions.forBead(beadId).some((s) => s.status === 'running')) throw new LifecycleError(`bead ${beadId} has a running worker`);
    const repo = db.repos.get(wt.repo_id)!;
    const bead = await store.show(repo.path, beadId);
    if (!bead || bead.status === 'closed') throw new LifecycleError(`bead ${beadId} is closed`);
    if (wt.batch_id) {
      const batch = db.batches.get(wt.batch_id);
      if (!batch || batch.status !== 'open') throw new LifecycleError(`batch ${wt.batch_id} is ${batch?.status ?? 'missing'}`);
    }
    if ((await commitsSince(wt.path, wt.base_branch)) === 0) throw new LifecycleError(`the branch of ${beadId} has no commits to verify; re-dispatch it instead`);
    // The guard is taken synchronously here (no await between the check and `guarded`), so a second call cannot slip in.
    if (this.verifying.has(beadId)) throw new LifecycleError(`bead ${beadId} is busy: a worker is starting on it or its branch is being verified, integrated or removed`);
    db.worktrees.update(beadId, { review_round: null, review_findings: null, review_diff_lines: null, review_carried: null }); // a retry starts the review rounds afresh, as a fresh dispatch does
    const run = this.guarded(beadId, () => wt.batch_id ? this.integrate(repo, wt, beadId, null) : this.verifyStandalone(repo, wt, beadId, null, true));
    // A retry that throws (git, bd) must not park the bead in Verifying: reopen it with the reason, as the worker path does.
    const settled: Promise<string | null> = run.then((failure) => failure, async (err) => {
      log.error(`lifecycle: re-verification of ${beadId} failed`, err);
      const reason = err instanceof Error ? err.message : String(err);
      await store.update(repo.path, beadId, { status: 'open', phase: null, note: `Verification retry failed: ${reason}` })
        .then(() => notify(`${beadId} reopened: the verification retry failed: ${reason}`, { wake: true }))
        .catch((e) => log.error(`lifecycle: could not reopen ${beadId} after a failed retry`, e));
      return `the verification retry failed: ${reason}`;
    }).finally(() => bus.emit('board'));
    // The run reports its own outcome: a bead already open before the retry (rejected, or reopened by an earlier failed
    // retry) that now passes must not read as a failure from its status alone.
    return { done: settled };
  }

  /** A new worker on the same bead, started by the user from the Board; a failed verification travels in its instructions. */
  async redispatch(beadId: string): Promise<string> {
    const { db, notify } = this.d;
    const wt = db.worktrees.get(beadId);
    if (!wt) throw new LifecycleError(`no worktree for ${beadId}`);
    // The last worker, not the last session: an awaiting-decision bead's last session is the critic.
    const last = db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1);
    const failure = wt.verify_status === 'fail' ? (wt.verify_output ?? '').slice(-2000) : null;
    const findings = failure === null && wt.review_findings ? renderFindings(wt.review_findings) : null;
    const failed = failure !== null || findings !== null; // either counts as a failed attempt for stepUp
    const instructions = failure !== null
      ? `The previous attempt was committed on this branch but verification failed. Fix the cause so the verify command passes.\n${failure}`
      : findings !== null
        ? `The review of the previous attempt (already committed on this branch) found these issues. Fix them so the next review passes:\n${findings}`
        : undefined;
    // The same tier as the last attempt, one step up after a failed verification or review; a session dispatched by harness alone (no tier)
    // keeps that harness, and one dispatched with a harness and a tier keeps both, with no step-up.
    const how: SpawnOpts = last && (!last.tier || last.harness_forced) ? retryRoute(last) : { tier: last?.tier ?? 'standard', stepUp: failed };
    const id = await this.spawnWorker(wt.repo_id, beadId, { ...how, verifyOnly: !!last?.verify_only, needsServer: this.needsServerFor(beadId), instructions });
    const harness = db.sessions.get(id)!.harness;
    const withWhat = failure !== null ? ' with the failed verification output' : findings !== null ? ' with the review findings' : '';
    await notify(`${beadId} re-dispatched to ${harness} by the user from the Board${withWhat}.`, { hint: 'Do not dispatch it again.' }).catch((err) => log.error('lifecycle: redispatch notify failed', err));
    return id;
  }

  /** Sessions stopped on purpose (Board Stop, `interrupt_worker`); the session-end rule records them as a stop instead of a failure. */
  private stops = new Map<string, WorkerStop>();
  async interruptBead(beadId: string, stop: WorkerStop = { by: 'user' }): Promise<void> {
    const s = this.d.db.sessions.forBead(beadId).find((r) => r.status === 'running');
    if (!s || !this.d.sessions.isLive(s.id)) throw new LifecycleError(`no running worker for ${beadId}`);
    // An orchestrator stop of a session silent past the stall threshold is the stall notice acted on: record it, so the next
    // automatic re-dispatch does not pick that harness again (the session is still silent here, so this cannot over-claim).
    const stalled = stop.by === 'orchestrator' && this.silentPastStall(s);
    this.stops.set(s.id, stop);
    try { await this.d.sessions.interrupt(s.id, stalled ? { ...stop, stalled: true } : stop); } catch (err) { this.stops.delete(s.id); throw err; }
  }

  /**
   * Who stopped a session: first the stop the session manager carries on the end event itself, then the in-memory record, then
   * the `interrupt` event the manager writes once the signal went out. The settle must depend on neither record: the kill makes
   * the harness report the death, and that death can reach this listener before `interrupt` has returned (the event is appended
   * after the signal) and without a map entry (another Lifecycle over the same database, a stop the manager was asked for
   * directly). Either way a deliberate stop would otherwise be recorded as a failure, overwriting the `ended` row the manager wrote.
   */
  private stopOf(e: SessionEnded): WorkerStop | undefined {
    return e.stop ?? this.stops.get(e.session.id) ?? (this.d.db.events.lastOfType(e.session.id, 'interrupt')?.payload as WorkerStop | undefined);
  }

  /** Whether `s` has recorded no event for longer than the stall threshold, falling back to its start when it recorded none (the sweep's own measure). */
  private silentPastStall(s: SessionRow): boolean {
    const { stallMs } = this.d.config;
    if (stallMs <= 0) return false;
    const lastTs = this.d.db.events.lastTs(s.id) ?? s.started_at;
    return Date.now() - Date.parse(lastTs) >= stallMs;
  }

  /** Harnesses unusable for this bead's next automatic re-dispatch: the latest worker session on each that was stopped for inactivity or reopened as a harness bug, with the reason to report. */
  /** Whether this bead's work runs a server, a daemon or a browser: recorded on the dispatch that said so, and carried by every later
   * dispatch, because the daemon re-dispatches a review round, a rate-limit pickup and a crash retry with no orchestrator to set it again. */
  private needsServerFor(beadId: string): boolean {
    return this.d.db.sessions.forBead(beadId).some((s) => s.role === 'worker' && !!s.needs_server);
  }

  private unusableHarnessesFor(beadId: string): Map<HarnessName, string> {
    const { db } = this.d;
    const latestWorker = new Map<HarnessName, SessionRow>();
    for (const s of db.sessions.forBead(beadId)) if (s.role === 'worker') latestWorker.set(s.harness, s);
    const unusable = new Map<HarnessName, string>();
    for (const [harness, s] of latestWorker) {
      if (s.crash_class === 'harness_bug') unusable.set(harness, `${harness} failed to start`);
      // A session is interrupted at most once, so the last interrupt is the only one that can carry the stall mark.
      else if ((db.events.lastOfType(s.id, 'interrupt')?.payload as { stalled?: boolean } | undefined)?.stalled === true) unusable.set(harness, `${harness} was stopped for inactivity`);
    }
    return unusable;
  }

  /**
   * Stops processes left in a finished worktree, then removes it and, unless `branch` is null, its branch. Reports whether
   * that removal and branch deletion succeeded. Cleanup failures are reported and never undo a landing.
   */
  private async cleanupWorktree(repo: Repo, wtPath: string, branch: string | null, opts: { prune?: boolean } = {}): Promise<{ removed: boolean }> {
    const { db, config } = this.d;
    try {
      await (this.d.reapEnded ?? reapEndedSession)({ db, worktreesDir: config.worktreesDir, keepPaths: [SOURCE_ROOT] }, wtPath);
    } catch (err) {
      log.error(`lifecycle: could not end processes left in ${wtPath}`, err);
    }
    try {
      await removeWorktreeRetry(repo.path, wtPath, branch, opts);
      return { removed: true };
    } catch (err) {
      log.error(`lifecycle: could not remove ${wtPath}`, err);
      return { removed: false };
    }
  }

  /** Removes the git worktrees and the branch. The worktree rows stay: they carry the bead → batch link and the batch's bead count and cost. */
  private async cleanupBatch(repo: Repo, batch: BatchRow): Promise<void> {
    const { db, config } = this.d;
    // One prune for the repository across every worktree of the batch: the first removal prunes, the rest skip it. The batch
    // branch goes with the batch worktree's removal (removeWorktree deletes the branch it is given), so the normal path deletes
    // it once. A removal that failed on every retry (a Windows lock outlasting the retries) can leave the branch behind, so the
    // fallback deletes it here; the failure path is the only one that pays for the extra check.
    let pruned = false;
    for (const w of db.worktrees.forBatch(batch.id)) {
      await this.cleanupWorktree(repo, w.path, w.branch, { prune: !pruned });
      pruned = true;
    }
    const wtPath = batchWorktreePath(config.worktreesDir, repo.id, batch.id);
    const { removed } = await this.cleanupWorktree(repo, wtPath, batch.branch, { prune: !pruned });
    if (!removed) {
      try { await deleteBranch(repo.path, batch.branch); } catch (err) { log.error(`lifecycle: could not delete ${batch.branch}`, err); }
    }
  }

  /** A critic lost with the daemon has no side effects to undo: re-running it is safe, unlike routing it through onWorkerEnded. */
  private async recoverCritic(s: SessionRow): Promise<void> {
    const { db } = this.d;
    const repo = s.repo_id ? db.repos.get(s.repo_id) : undefined;
    const wt = s.bead_id ? db.worktrees.get(s.bead_id) : undefined;
    if (!repo || !wt || !s.bead_id) return;
    const batchStatus = wt.batch_id ? db.batches.get(wt.batch_id)?.status : undefined;
    if (batchStatus === 'abandoned' || batchStatus === 'merged') return;
    const lastWorker = db.sessions.forBead(s.bead_id).filter((r) => r.role === 'worker' && r.model).at(-1);
    const worker: WorkerEnd | null = lastWorker ? { model: lastWorker.model, text: null } : null;
    // A round that was itself an auth resume keeps the marker: the one-resume limit outlives the daemon, so a rejection of the
    // recovered round parks the account instead of re-running it again.
    await this.guarded(s.bead_id, () => this.startReview(repo, wt, s.bead_id!, worker, true, s.auth_resumed === 1, s.id)); // the interrupted round again, not the next one
  }

  async recover(): Promise<void> {
    const { db, sessions } = this.d;
    for (const s of db.sessions.running()) {
      try {
        // Liveness is the pid plus its start time (Get-Process StartTime on Windows, ps lstart elsewhere) against the one recorded
        // at spawn, so a recycled pid is not mistaken for the worker. Workers were spawned detached with their stdio in a file,
        // so one that is still there is followed from where the previous daemon left off instead of being reopened.
        const alive = !!s.pid && (await isAlive(s.pid, s.pid_started_at));
        if (alive && s.role === 'worker' && s.log_path) {
          sessions.adopt(s);
          log.info(`lifecycle: adopted worker ${s.id} for ${s.bead_id}`);
          continue;
        }
        if (alive) await killProcess(s.pid!);
        const tail = s.log_path ? exitReasonFrom(s.log_path) : null;
        const reason = tail ? `${RESTART_REASON}; the worker's log ends with: ${tail}` : RESTART_REASON;
        // This path bypasses the manager's `finish`, so the exit reason is persisted here too and `worker_status` can report it.
        db.sessions.update(s.id, { status: 'ended', ended_at: new Date().toISOString(), pid: null, end_reason: reason });
        if (s.account) clearAccountUsageCacheForAccount(s.account);
        // This path bypasses the manager's `finish`, so the `session:ended` the office feed listens on is never emitted: recovery
        // publishes its own leave instead, or a socket that connected while this loop was still working through its list would keep
        // the row's `walking_in` character for good.
        this.d.bus.emit('session:reaped', db.sessions.get(s.id)!);
        // Recovery is this session's first settlement, so the claim only records it (a row recovery re-processes is never already settled).
        if (s.role === 'worker' && this.claimSettlement(s)) {
          try { await this.onWorkerEnded({ session: db.sessions.get(s.id)!, lastText: null, lastError: reason, files: [] }); } finally { this.settled.delete(s.id); }
        }
        if (s.role === 'critic' && this.claimSettlement(s)) {
          try { await this.recoverCritic(s); } finally { this.settled.delete(s.id); }
        }
      } catch (err) {
        log.error(`lifecycle: recovery of session ${s.id} failed`, err);
      }
    }
    // Beads that landed on a batch branch while bd could not record it (the row has merged_at, bd still has the bead open) are closed now.
    for (const repo of db.repos.all()) {
      const beads = await this.d.store.list(repo.path).catch((err: unknown) => { log.error('lifecycle: bd list failed during recovery; landed beads bd has not closed stay for Retry close', err); return []; });
      for (const b of beads) {
        // Not "open in bd": the landing is two bd calls, and a failure of the second leaves the bead closed with phase `verifying`,
        // its worktree and branch on disk and the orchestrator never told (fix round 17 review N17-1). Only phase `merged` is done.
        const wt = b.status === 'closed' && phaseOf(b) === 'merged' ? undefined : db.worktrees.get(b.id);
        if (!wt?.merged_at || !wt.batch_id || db.batches.get(wt.batch_id)?.status !== 'open') continue;
        try { await this.closeLanded(b.id); } catch (err) { log.error(`lifecycle: could not record the landing of ${b.id}`, err); }
      }
      // A batch still waiting on one that has left review (the release was skipped by a crash or an error after the merge) is re-evaluated now.
      for (const b of db.batches.forRepo(repo.id)) {
        if (b.status !== 'review' || !b.waiting_on || db.batches.get(b.waiting_on)?.status === 'review') continue;
        try { await this.evaluateWaiting(repo, b.id); log.info(`lifecycle: re-evaluated the wait of ${b.id} on ${b.waiting_on}, which is no longer in review`); } catch (err) { log.error(`lifecycle: could not re-evaluate the wait of ${b.id}`, err); }
      }
    }
    db.batchWaits.releaseMergedPrerequisites();
    await this.notifyProgramWaitChanges();
    this.d.bus.emit('board');
  }
}

/** The first non-empty stderr lines of a worker that died at startup: at most 3 lines, joined with "; ", cut at 300 characters. */
export function stderrHead(errPath: string): string | null {
  // Only the head of the file is read: a CLI that loops on an error can leave a large one behind.
  const buf = Buffer.alloc(4096);
  let n: number;
  try {
    const fd = fs.openSync(errPath, 'r');
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  } catch { return null; }
  const text = buf.toString('utf8', 0, n);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
  return lines.length ? lines.join('; ').slice(0, 300) : null;
}

/** What the end of a dead worker's log says about why it stopped: its harness's final error line, else its last stderr line. */
export function exitReasonFrom(logPath: string): string | null {
  const lastLine = (file: string): string | null => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    return text.slice(-8000).trim().split('\n').filter(Boolean).at(-1) ?? null;
  };
  const out = lastLine(logPath);
  if (out) {
    try {
      const msg = JSON.parse(out) as { is_error?: boolean; result?: unknown; subtype?: string; type?: string; error?: unknown; message?: unknown };
      if (msg.is_error) return String(msg.result ?? msg.subtype ?? 'error').slice(0, 300);
      if (msg.type === 'error') return String(msg.message ?? msg.error ?? 'error').slice(0, 300);
    } catch { /* not a JSON line: the harness's stdout is not what stopped it */ }
  }
  const err = lastLine(logPath + '.err');
  return err ? err.slice(0, 300) : null;
}
