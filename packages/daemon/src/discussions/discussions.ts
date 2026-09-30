import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DiscussionDetail, DiscussionParticipant, DiscussionRow, DiscussionSummary, Effort, HarnessName, Repo, SessionRow } from '@overseer/shared';
import type { Config } from '../config';
import type { Db } from '../db/db';
import type { Bus } from '../bus';
import type { SessionManager } from '../sessions/manager';
import { envTokenExpiresAt, freshAccountEnv } from '../accounts/env';
import { accountLoggedIn } from '../accounts/status';
import { accountDisplayName } from '../accounts/display';
import { accountUsable } from '../accounts/usage';
import { standardCandidate } from '../routing/tiers';
import { git, removeWorktreeRetry, resolveNewWorkBase } from '../git/git';
import { inputLimit, render } from '../lifecycle/prompt';
import { storeAttachments, type AttachmentInput, type StoredAttachment } from '../orchestrator/attachments';
import { randomIdSuffix } from '../db/db';
import { log } from '../util/log';

/** A refused discussion request (`api/rest.ts` answers 400), e.g. an empty question or a harness with no standard model. */
export class DiscussionError extends Error {}

/** The participants a request that names none gets, in this order. */
export const DEFAULT_PARTICIPANTS: HarnessName[] = ['claude', 'codex', 'opencode'];
export const MAX_PARTICIPANTS = 3;
/** Dollars a discussion may spend before the stop rule ends it. */
export const DEFAULT_COST_CAP = 5;
/** Rounds a discussion runs at most; after this one it closes with the synthesis. */
export const MAX_ROUNDS = 3;

export interface DiscussionDeps {
  db: Db;
  sessions: SessionManager;
  bus: Bus;
  config: Config;
  usageGate?: typeof accountUsable;
  /** Awaited at the start of every participant's preparation, before its worktree is made; a test uses it to prove the starts overlap. */
  prepare?: (discussionId: string, harness: HarnessName) => Promise<void>;
}

const now = () => new Date().toISOString();

/** What one participant's session cost so far: its reported figure when it has one, else the catalog estimate, else 0. */
export const sessionCost = (s: Pick<SessionRow, 'cost' | 'estimated_cost'>): number => s.cost ?? s.estimated_cost ?? 0;

/**
 * Refuses a cwd that is the repository's primary checkout, or inside it: a participant must run in its own worktree so
 * nothing it writes can reach the repository the user works in.
 */
export function assertNotPrimaryCheckout(repoPath: string, cwd: string): void {
  const repo = path.resolve(repoPath);
  const target = path.resolve(cwd);
  if (target === repo || target.startsWith(repo + path.sep)) {
    throw new DiscussionError(`refusing to run a discussion participant in the repository's primary checkout (${repoPath})`);
  }
}

/**
 * The verdict a round answer's closing line carries: `no` only for a well-formed `Changed: no`; a missing or malformed
 * line counts as `yes`, so a participant the prompt could not reach keeps the discussion going rather than ending it.
 * Only the final non-empty line is read, so an earlier `Changed: no` under a malformed ending does not count.
 */
export function changedLine(text: string): 'yes' | 'no' {
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return /^changed:\s*no$/i.test(last) ? 'no' : 'yes';
}

/** Cuts one quoted answer from the middle, keeping `keep` characters split between its head and its tail, with a marker in between. */
export function cutMiddle(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const omitted = text.length - keep;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}[...${omitted} characters omitted...]${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

export interface QuotedAnswer { harness: HarnessName; text: string; final: boolean }

function copiedAttachmentName(name: string): string {
  const basename = name.split(/[\\/]/).pop() ?? '';
  return basename.replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_') || 'image';
}

function attachmentPromptLines(paths: string[]): string {
  return paths.map((file) => '[attached image: ' + file + ']').join('\n');
}

/**
 * The round-N+1 prompt for one participant: the others' latest answers, verbatim and labelled by harness, then the
 * agreements / disputes / revised answer the template asks for. When the rendered prompt would exceed the receiving
 * harness's `inputLimit`, every quoted answer is cut from the middle until it fits; a cut answer carries the marker
 * `cutMiddle` writes, so the participant reads that it is incomplete.
 */
export function buildRoundPrompt(template: string, input: { question: string; round: number; answers: QuotedAnswer[]; limit: number }): string {
  const render_ = (keep?: number): string => render(template, {
    question: input.question,
    later: '1',
    round: String(input.round),
    attachments: '',
    others: input.answers.map((a) => `### ${a.harness}${a.final ? ' (final answer)' : ''}\n${keep === undefined ? a.text : cutMiddle(a.text, keep)}`).join('\n\n'),
  });
  const full = render_();
  if (full.length <= input.limit) return full;
  const max = Math.max(0, ...input.answers.map((a) => a.text.length));
  let lo = 0;
  let hi = max;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (render_(mid).length <= input.limit) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // The marker's own digit count makes the length not perfectly monotone, so step down to the first length that fits.
  while (best > 0 && render_(best).length > input.limit) best--;
  return render_(best);
}

/** A participant resolved to run: its standard-tier model, the account it uses and the environment that account carries. */
interface ParticipantSpec {
  harness: HarnessName;
  model: string;
  effort?: Effort;
  accountId: string | null;
  env: NodeJS.ProcessEnv;
  tokenExpiresAt: number | null;
}

/** One discussion's in-flight state: the round being run, every participant, the ones that failed and the ones answered this round. */
interface RoundState {
  round: number;
  /** The one base commit every participant and the synthesis read. */
  baseCommit: string | null;
  participants: HarnessName[];
  /** Participants that failed: left out of later rounds, their last answer kept as their final answer. */
  excluded: Set<HarnessName>;
  /** Participants that recorded a turn in the current round. */
  done: Set<HarnessName>;
}

/**
 * Multi-model discussions. A request starts one session per participant on the standard tier's model for its own harness,
 * each `keepAlive` and in its own throwaway worktree, and runs up to three rounds: every later round hands each live
 * participant the others' latest answers verbatim, and the discussion closes with a synthesis written by a fresh claude
 * session, or earlier when all participants say their answer did not change, or when the cost cap is reached. The sessions
 * are read-only by prompt and by isolation: every worktree is detached at the one base commit resolved for the discussion
 * and removed when the discussion ends. The web refetches on the `discussion` bus event.
 */
export class Discussions {
  private readonly template: string;
  private readonly synthesisTemplate: string;
  /** Each discussion's participant starts while `create` runs them; `stop` waits for them, so no late start outlives a teardown. */
  private readonly starting = new Map<string, Promise<unknown>>();
  /** Participant sessions whose current turn reported an `error`: their next `turn_end` is a failure, not an answer. */
  private readonly errored = new Map<string, string>();
  /** Participant sessions this runner ended as failed, with the reason written on the row once the manager settles them. */
  private readonly failing = new Map<string, string>();
  /** Each running discussion's round state; absent once it is done, stopped or failed. */
  private readonly states = new Map<string, RoundState>();
  /** Serialises the round decisions of one discussion, so two turn ends in the same round cannot both advance it. */
  private readonly settling = new Map<string, Promise<void>>();
  /** Set from the round decision that closes a discussion (synthesis or cap) until it is terminal, so a late decision cannot close it twice. */
  private readonly closing = new Set<string>();
  /** Set by a user Stop, so a synthesis that is mid-flight bails instead of writing `done` over the stop. */
  private readonly stopping = new Set<string>();
  /** Set while a synthesis turn is being read, so it is handled once. */
  private readonly synthesizing = new Set<string>();

  constructor(private readonly d: DiscussionDeps) {
    this.template = fs.readFileSync(path.join(d.config.promptsDir, 'discussion.md'), 'utf8');
    this.synthesisTemplate = fs.readFileSync(path.join(d.config.promptsDir, 'discussion-synthesis.md'), 'utf8');
    // Every turn end is recorded from the session's own row, so a fast start cannot beat the runner's registration.
    d.bus.on('event', (event) => {
      if (event.type === 'error') {
        const s = d.db.sessions.get(event.session_id);
        if (s?.role === 'discussion') this.errored.set(s.id, (event.payload as { message?: string }).message ?? 'error');
        return;
      }
      if (event.type !== 'turn_end') return;
      void this.onTurnEnd(event.session_id).catch((err) => log.error('discussions: recording a turn failed', err));
    });
    // A codex or opencode crash ends its turn after the error, which the manager settles as `ended`; the row says `failed`.
    // Every discussion session end pings the web, not only the ones this runner settled itself: a participant that exits on its
    // own error without a `turn_end` is already `failed` on its row, and the open page must refetch that too.
    d.bus.on('session:ended', ({ session }) => {
      if (session.role !== 'discussion' || !session.discussion_id) return;
      this.errored.delete(session.id);
      const reason = this.failing.get(session.id);
      if (reason !== undefined) {
        this.failing.delete(session.id);
        d.db.sessions.update(session.id, { status: 'failed', end_reason: reason });
      }
      d.bus.emit('discussion', { id: session.discussion_id });
      // A synthesis that exits on its own (a crash) ends the discussion here, since no `turn_end` will settle it.
      if (session.discussion_kind === 'synthesis') {
        void this.onSynthesisCrashed(session).catch((err) => log.error('discussions: could not settle a synthesis exit', err));
        return;
      }
      // A participant session can end without a `turn_end` (a killed CLI, or claude's `error` then exit). Deferred one
      // macrotask so a `turn_end` already buffered on the stream is recorded first and a genuine answer is never dropped.
      setImmediate(() => {
        void this.onParticipantEnded(session).catch((err) => log.error('discussions: could not settle a participant exit', err));
      });
    });
  }

  async create(input: { question: string; repoId?: string | null; participants?: HarnessName[]; costCap?: number; attachments?: AttachmentInput[] }): Promise<DiscussionDetail> {
    const { db } = this.d;
    const question = input.question.trim();
    if (!question) throw new DiscussionError('question must not be empty');
    const costCap = input.costCap ?? DEFAULT_COST_CAP;
    if (!(costCap > 0)) throw new DiscussionError('cost cap must be greater than 0');
    const participants = input.participants ?? DEFAULT_PARTICIPANTS;
    if (participants.length < 1) throw new DiscussionError('a discussion needs at least one participant');
    if (participants.length > MAX_PARTICIPANTS) throw new DiscussionError(`a discussion takes at most ${MAX_PARTICIPANTS} participants`);
    const seen = new Set<string>();
    for (const harness of participants) {
      if (seen.has(harness)) throw new DiscussionError(`participant ${harness} is listed twice`);
      seen.add(harness);
    }
    const repo = input.repoId ? db.repos.get(input.repoId) : undefined;
    if (input.repoId && !repo) throw new DiscussionError(`repo ${input.repoId} not found`);
    // Resolve every participant before the row exists: an unknown/denied standard candidate or a logged-out account is a
    // refusal, not a half-started discussion.
    const chosen = await Promise.all(participants.map((harness) => this.resolveParticipant(harness)));
    const row: DiscussionRow = {
      id: `d-${randomIdSuffix()}${randomIdSuffix()}`, question, repo_id: repo?.id ?? null, status: 'running',
      stop_reason: null, cost_cap: costCap, created_at: now(), ended_at: null, synthesis: null,
    };
    const baseCommit = repo ? await this.resolveBaseCommit(repo) : null;
    const storedAttachments = input.attachments?.length
      ? storeAttachments(this.d.config, `discussion-${row.id}`, input.attachments)
      : [];
    db.discussions.insert(row, storedAttachments);
    // Recorded before the starts, so a participant whose turn end arrives fast cannot beat the round state it belongs to.
    this.states.set(row.id, { round: 1, baseCommit, participants: chosen.map((c) => c.harness), excluded: new Set(), done: new Set() });
    // Every start settles before any teardown: on the first failure the others may still be making a checkout or a session.
    const started = Promise.allSettled(chosen.map((c) => this.startParticipant(row, repo ?? null, c, baseCommit)));
    this.starting.set(row.id, started);
    const results = await started.finally(() => this.starting.delete(row.id));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      const err: unknown = failed.reason;
      if (db.discussions.get(row.id)?.status === 'running') await this.endAndMark(row, 'failed', err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw err;
    }
    this.d.bus.emit('discussion', { id: row.id });
    return this.detail(row.id)!;
  }

  list(): DiscussionSummary[] {
    return this.d.db.discussions.all().map((d) => {
      const turns = this.d.db.discussions.turns(d.id);
      const rounds = turns.reduce((max, t) => Math.max(max, t.round), 0);
      const state = this.states.get(d.id);
      const waiting = !!state && state.participants.some((h) => !state.excluded.has(h) && !state.done.has(h));
      const round_in_progress = d.status === 'running' && rounds > 0 && state?.round === rounds && waiting;
      return { ...d, turns: turns.length, cost: this.discussionCost(d.id), rounds, round_in_progress };
    });
  }

  detail(id: string): DiscussionDetail | undefined {
    const d = this.d.db.discussions.get(id);
    if (!d) return undefined;
    return { ...d, turns: this.d.db.discussions.turns(id), participants: this.participants(id), cost: this.discussionCost(id) };
  }

  /**
   * The discussion's total spend: every participant's cost (`cost ?? estimated_cost ?? 0`, summed) plus the synthesis's.
   * The synthesis session is not a participant, so it is counted separately; its live cost is read while it runs and its
   * settled figure (`synthesis_cost`) is read once the session row is gone with a removed repository, so it is never
   * counted twice. The synthesis's own turn end is checked against the cap too: a synthesis that crosses it is not stored
   * and the discussion is stopped.
   */
  private discussionCost(id: string): number {
    const synthesisRows = this.d.db.sessions.forDiscussion(id).filter((s) => s.discussion_kind === 'synthesis');
    const synthesis = synthesisRows.length
      ? synthesisRows.reduce((sum, s) => sum + sessionCost(s), 0)
      : this.d.db.discussions.get(id)?.synthesis_cost ?? 0;
    return this.participants(id).reduce((sum, p) => sum + p.cost, 0) + synthesis;
  }

  /**
   * One entry per participant, keyed by harness (a discussion lists each harness once), excluding the synthesis session.
   * The live session row is authoritative while it exists; once a repository removal deleted it, the snapshot written
   * before that deletion, then the latest recorded turn, stand in, so a participant that never answered keeps its harness,
   * status and cost.
   */
  private participants(id: string): DiscussionParticipant[] {
    const byHarness = new Map<string, DiscussionParticipant>();
    for (const p of this.d.db.discussions.participants(id)) byHarness.set(p.harness, { ...p });
    for (const t of this.d.db.discussions.turns(id)) {
      if (!byHarness.has(t.harness)) byHarness.set(t.harness, { harness: t.harness, session_id: t.session_id, status: 'ended', cost: t.cost ?? 0 });
    }
    for (const s of this.d.db.sessions.forDiscussion(id)) {
      if (s.discussion_kind === 'synthesis') continue;
      byHarness.set(s.harness, { harness: s.harness, session_id: s.id, status: s.status, cost: sessionCost(s) });
    }
    return [...byHarness.values()];
  }

  /** Stops every running discussion of a repository that is being removed, before its session rows are deleted. */
  async stopForRepo(repoId: string, reason: string): Promise<void> {
    for (const discussion of this.d.db.discussions.running()) {
      if (discussion.repo_id === repoId) await this.stop(discussion.id, reason);
    }
  }

  /**
   * Snapshots every discussion of a repository before its session rows are deleted, so an ended discussion keeps its
   * participants and their final cost in the detail; without it, a participant that never answered vanished with its session.
   */
  snapshotForRepo(repoId: string): void {
    for (const discussion of this.d.db.discussions.forRepo(repoId)) {
      const participants = this.participants(discussion.id);
      if (participants.length) this.d.db.discussions.saveParticipants(discussion.id, participants);
    }
  }

  /** Ends every participant and marks the discussion stopped, removing the participants' worktrees. */
  async stop(id: string, reason = 'stopped by the user'): Promise<DiscussionDetail> {
    const discussion = this.d.db.discussions.get(id);
    if (!discussion) throw new DiscussionError(`discussion ${id} not found`);
    if (discussion.status === 'running') {
      // Marked before the first await, so a round decision already in flight bails instead of prompting or starting a synthesis.
      this.stopping.add(id);
      await this.starting.get(id); // a participant still starting would otherwise start after the teardown below
      await this.endSessions(discussion, reason);
      await this.cleanup(discussion);
      this.update(discussion.id, { status: 'stopped', stop_reason: reason, ended_at: now() });
      this.clearState(discussion.id);
    }
    return this.detail(id)!;
  }

  /**
   * A daemon that starts with a discussion still `running` cannot resume its participant processes: recovery has already
   * killed and ended them (`lifecycle.recover`), and a discussion cannot be reconstructed from a killed turn. It is marked
   * `failed` with `daemon restarted` and its worktrees are removed, rather than left running with no sessions.
   */
  async recover(): Promise<void> {
    for (const discussion of this.d.db.discussions.running()) {
      await this.cleanup(discussion).catch((err) => log.warn(`discussions: could not clean up ${discussion.id} after restart`, err));
      this.update(discussion.id, { status: 'failed', stop_reason: 'daemon restarted', ended_at: now() });
      this.clearState(discussion.id);
    }
  }

  /** Resolves one harness's standard-tier candidate and account, or refuses by name before any state is written. */
  private async resolveParticipant(harness: HarnessName): Promise<ParticipantSpec> {
    const candidate = standardCandidate(this.d.db.settings.tiers(), harness);
    if (!candidate) throw new DiscussionError(`no standard-tier model is configured for ${harness}; configure one in Setup → Models or leave that participant out`);
    const account = candidate.account ? this.d.db.accounts.get(candidate.account) : null;
    if (candidate.account && (!account || !accountLoggedIn(account))) throw new DiscussionError(`the standard-tier account for ${harness} is not logged in: ${accountDisplayName(account) ?? candidate.account}`);
    const env = await freshAccountEnv(this.d.db, this.d.config, account);
    return { harness, model: candidate.model, effort: candidate.effort ?? undefined, accountId: candidate.account ?? null, env, tokenExpiresAt: envTokenExpiresAt(this.d.db, account) };
  }

  private async assertAccountUsable(c: ParticipantSpec): Promise<void> {
    if (!c.accountId) return;
    const result = await (this.d.usageGate ?? accountUsable)(this.d.db, this.d.config, c.accountId, c.model);
    if (!result.usable) throw new DiscussionError(result.reason);
  }

  private async startParticipant(discussion: DiscussionRow, repo: Repo | null, c: ParticipantSpec, baseCommit: string | null): Promise<void> {
    await this.assertAccountUsable(c);
    await this.d.prepare?.(discussion.id, c.harness);
    const cwd = await this.makeCwd(discussion, repo, c.harness, baseCommit);
    const attachmentPaths = await this.copyAttachments(cwd, this.d.db.discussions.storedAttachments(discussion.id));
    const prompt = render(this.template, { question: discussion.question, round1: '1', attachments: attachmentPromptLines(attachmentPaths) });
    this.d.sessions.start({
      role: 'discussion', harness: c.harness, model: c.model, effort: c.effort, repoId: repo?.id ?? null,
      cwd, prompt, keepAlive: true, account: c.accountId, tokenExpiresAt: c.tokenExpiresAt, env: c.env, discussionId: discussion.id,
    });
  }

  /** Fetch the selected base once and pin it to a commit before any participant worktree is made. */
  private async resolveBaseCommit(repo: Repo): Promise<string> {
    const { ref, warning } = await resolveNewWorkBase(repo);
    if (warning) log.warn(`discussions: ${warning}`);
    return git(repo.path, ['rev-parse', `${ref}^{commit}`]);
  }

  /** The participant's private cwd: a detached worktree at the pinned commit, or an empty temp directory when no repo was chosen. */
  private async makeCwd(discussion: DiscussionRow, repo: Repo | null, dirName: string, baseCommit: string | null): Promise<string> {
    if (!repo) {
      const dir = path.join(this.d.config.dataDir, 'discussions', discussion.id, dirName);
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    }
    const dir = path.join(this.d.config.worktreesDir, repo.id, `disc-${discussion.id}`, dirName);
    if (!baseCommit) throw new DiscussionError('discussion base commit was not resolved');
    assertNotPrimaryCheckout(repo.path, dir);
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await git(repo.path, ['worktree', 'prune']);
    await git(repo.path, ['worktree', 'add', '--detach', dir, baseCommit]);
    return dir;
  }

  /** Copies stored question images into the session cwd so a harness never has to read outside its own directory. */
  private async copyAttachments(cwd: string, attachments: StoredAttachment[]): Promise<string[]> {
    if (!attachments.length) return [];
    const directory = path.join(cwd, '.discussion-attachments');
    await fsp.mkdir(directory, { recursive: true });
    const paths = attachments.map((attachment, index) => path.join(directory, index + '-' + copiedAttachmentName(attachment.name)));
    await Promise.all(attachments.map((attachment, index) => fsp.copyFile(attachment.path, paths[index]!)));
    return paths;
  }

  /**
   * Records the turn a participant's `turn_end` reports, or excludes the participant as failed. Once every participant
   * of the round has answered or failed, the round is settled: another round, the synthesis, or a stop.
   */
  private async onTurnEnd(sessionId: string): Promise<void> {
    const { db } = this.d;
    const session = db.sessions.get(sessionId);
    if (!session || session.role !== 'discussion' || !session.discussion_id) return;
    const discussion = db.discussions.get(session.discussion_id);
    if (!discussion || discussion.status !== 'running') return;
    const error = this.errored.get(sessionId);
    this.errored.delete(sessionId);
    if (session.discussion_kind === 'synthesis') {
      await this.onSynthesisEnd(discussion, session, error);
      return;
    }
    const state = this.states.get(discussion.id);
    if (!state) return;
    if (state.excluded.has(session.harness) || state.done.has(session.harness)) return; // already out, or a duplicate turn end
    await Promise.resolve(); // let the manager persist the turn's cost on the row before it is read
    const current = db.sessions.get(sessionId) ?? session;
    // Only this round's text counts: a later round's prompt is recorded as a `message` event by `sessions.send`, so a turn
    // that emitted nothing after it is a blank answer, not the previous round's answer again.
    const since = db.events.lastOfType(sessionId, 'message')?.seq ?? 0;
    const text = (db.events.lastOfTypeAfter(sessionId, 'assistant_text', since)?.payload as { text?: string } | undefined)?.text?.trim() ?? '';
    // A turn that ended after an error, or with no answer, is a failed participant: no turn, its session ended, the others go on.
    if (error !== undefined || !text) {
      state.excluded.add(session.harness);
      this.failing.set(sessionId, error !== undefined ? `turn failed: ${error}` : 'turn ended with no answer');
      await this.d.sessions.end(sessionId);
      this.d.bus.emit('discussion', { id: discussion.id });
      if (this.costReached(discussion)) { await this.stopForCap(discussion, state); return; }
      await this.settle(discussion.id);
      return;
    }
    if (db.discussions.hasTurn(discussion.id, state.round, session.harness)) return;
    db.discussions.insertTurn({ discussion_id: discussion.id, round: state.round, harness: session.harness, session_id: sessionId, text, cost: sessionCost(current), created_at: now() });
    state.done.add(session.harness);
    this.d.bus.emit('discussion', { id: discussion.id });
    // The cap is read after every turn end, so a round that crosses it stops after the turn that crossed it. A cap stop runs
    // no synthesis on purpose: the request was the answers so far, and the synthesis is the one step the cap exists to skip.
    if (this.costReached(discussion)) { await this.stopForCap(discussion, state); return; }
    await this.settle(discussion.id);
  }

  /** Serialises the round decision of one discussion, so concurrent turn ends cannot both advance the same round. */
  private settle(id: string): Promise<void> {
    const prev = this.settling.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.settleNow(id)).catch((err) => log.error(`discussions: settling ${id} failed`, err));
    this.settling.set(id, next);
    void next.finally(() => { if (this.settling.get(id) === next) this.settling.delete(id); });
    return next;
  }

  /** Decides one discussion's next step once a round's turns are in: another round, the synthesis, or a stop. */
  private async settleNow(id: string): Promise<void> {
    const discussion = this.d.db.discussions.get(id);
    if (!discussion || discussion.status !== 'running' || this.closing.has(id) || this.stopping.has(id)) return;
    const state = this.states.get(id);
    if (!state || state.participants.length === 0) return;
    if (state.participants.every((h) => state.excluded.has(h))) {
      // Every participant failed: there is nothing to synthesise and no answer to hand back.
      await this.endAndMark(discussion, 'failed', `all participants failed after round ${state.round}`);
      return;
    }
    const active = state.participants.filter((h) => !state.excluded.has(h));
    if (active.some((h) => !state.done.has(h))) return; // a participant is still answering this round
    if (state.round >= MAX_ROUNDS || (state.round >= 2 && this.allUnchanged(id, state.round, active))) {
      await this.finish(discussion);
      return;
    }
    await this.advance(discussion, state, active);
  }

  /** Whether every participant that answered round `round` ended its answer with `Changed: no`. */
  private allUnchanged(id: string, round: number, active: HarnessName[]): boolean {
    const byHarness = new Map(this.d.db.discussions.turns(id).filter((t) => t.round === round).map((t) => [t.harness, t.text]));
    return active.every((h) => changedLine(byHarness.get(h) ?? '') === 'no');
  }

  /** Sends the next round's prompt to every still-live participant, quoting the others' latest answers. */
  private async advance(discussion: DiscussionRow, state: RoundState, active: HarnessName[]): Promise<void> {
    const nextRound = state.round + 1;
    state.round = nextRound;
    state.done.clear();
    const latest = this.finalAnswers(discussion.id);
    const sessions = this.d.db.sessions.forDiscussion(discussion.id);
    for (const harness of active) {
      if (this.closing.has(discussion.id) || this.stopping.has(discussion.id) || this.d.db.discussions.get(discussion.id)?.status !== 'running') return; // a Stop landed
      const session = sessions.find((s) => s.harness === harness && s.discussion_kind !== 'synthesis');
      if (!session || !this.d.sessions.isLive(session.id)) {
        state.excluded.add(harness); // its session is gone without a turn end: it cannot answer another round
        continue;
      }
      const answers = state.participants.filter((h) => h !== harness).map((h) => latest.get(h)).filter((a): a is QuotedAnswer => !!a);
      const prompt = buildRoundPrompt(this.template, { question: discussion.question, round: nextRound, answers, limit: inputLimit(harness) });
      try {
        await this.d.sessions.send(session.id, prompt);
      } catch (err) {
        state.excluded.add(harness);
        log.warn(`discussions: could not prompt ${harness} for round ${nextRound}`, err);
      }
    }
    this.d.bus.emit('discussion', { id: discussion.id });
    if (state.participants.every((h) => state.excluded.has(h))) {
      await this.endAndMark(discussion, 'failed', `all participants failed after round ${nextRound}`);
    }
  }

  /** Each participant's latest recorded answer, marked final when that participant has failed. */
  private finalAnswers(id: string): Map<HarnessName, QuotedAnswer> {
    const latest = new Map<HarnessName, { text: string; round: number }>();
    for (const t of this.d.db.discussions.turns(id)) {
      const cur = latest.get(t.harness);
      if (!cur || t.round >= cur.round) latest.set(t.harness, { text: t.text, round: t.round });
    }
    const excluded = this.states.get(id)?.excluded ?? new Set<HarnessName>();
    const out = new Map<HarnessName, QuotedAnswer>();
    for (const [harness, v] of latest) out.set(harness, { harness, text: v.text, final: excluded.has(harness) });
    return out;
  }

  /** Ends the participants and starts the fresh claude synthesis session; `onSynthesisEnd` closes the discussion when it answers. */
  private async finish(discussion: DiscussionRow): Promise<void> {
    if (this.closing.has(discussion.id)) return;
    this.closing.add(discussion.id);
    const stillRunning = () => this.d.db.discussions.get(discussion.id)?.status === 'running';
    await this.endSessions(discussion, 'discussion finished');
    if (!stillRunning()) return; // a Stop landed while the participants were being ended
    let c: ParticipantSpec;
    try {
      c = await this.resolveParticipant('claude');
      await this.assertAccountUsable(c);
    } catch (err) {
      await this.endAndMark(discussion, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }
    const repo = discussion.repo_id ? this.d.db.repos.get(discussion.repo_id) ?? null : null;
    let cwd: string;
    let attachmentPaths: string[];
    try {
      cwd = await this.makeCwd(discussion, repo, 'synthesis', this.states.get(discussion.id)?.baseCommit ?? null);
      attachmentPaths = await this.copyAttachments(cwd, this.d.db.discussions.storedAttachments(discussion.id));
    } catch (err) {
      await this.endAndMark(discussion, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }
    if (!stillRunning()) return; // a Stop landed while the synthesis cwd was made
    const answers = [...this.finalAnswers(discussion.id).values()];
    const prompt = render(this.synthesisTemplate, {
      question: discussion.question,
      attachments: attachmentPromptLines(attachmentPaths),
      answers: answers.map((a) => `### ${a.harness}\n${a.text}`).join('\n\n'),
    });
    try {
      this.d.sessions.start({
        role: 'discussion', harness: 'claude', model: c.model, effort: c.effort, repoId: repo?.id ?? null,
        cwd, prompt, keepAlive: true, account: c.accountId, tokenExpiresAt: c.tokenExpiresAt, env: c.env,
        discussionId: discussion.id, discussionKind: 'synthesis',
      });
    } catch (err) {
      await this.endAndMark(discussion, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }
    this.d.bus.emit('discussion', { id: discussion.id });
  }

  /** Stores the synthesis and closes the discussion, or fails it when the synthesis could not answer. */
  private async onSynthesisEnd(discussion: DiscussionRow, session: SessionRow, error: string | undefined): Promise<void> {
    if (this.synthesizing.has(discussion.id) || this.stopping.has(discussion.id)) return;
    this.synthesizing.add(discussion.id);
    await Promise.resolve(); // let the manager persist the turn's cost on the row before it is read
    // Rechecked after every await below: a Stop that lands while the synthesis is being read or settled must stay the final
    // word, so the continuation must not write `done` over the `stopped` it wrote.
    // `stop()` sets `stopping` at once but writes `stopped` only after its teardown, so both are read.
    const stillRunning = () => !this.stopping.has(discussion.id) && this.d.db.discussions.get(discussion.id)?.status === 'running';
    if (!stillRunning()) return;
    const current = this.d.db.sessions.get(session.id) ?? session;
    const text = (this.d.db.events.lastOfType(session.id, 'assistant_text')?.payload as { text?: string } | undefined)?.text?.trim() ?? '';
    // The cap is checked after every turn end, the synthesis's included: a synthesis turn that crosses it stops the
    // discussion with no synthesis stored, the same intended stop as a round that crossed it.
    if (this.costReached(discussion)) {
      await this.endAndMark(discussion, 'stopped', `cost cap $${discussion.cost_cap} reached after round ${this.states.get(discussion.id)?.round ?? MAX_ROUNDS}`);
      return;
    }
    if (error !== undefined || !text) {
      const reason = error !== undefined ? `synthesis failed: ${error}` : 'synthesis ended with no answer';
      await this.d.sessions.end(session.id).catch(() => undefined);
      if (!stillRunning()) return;
      await this.endAndMark(discussion, 'failed', reason);
      return;
    }
    await this.d.sessions.end(session.id).catch(() => undefined);
    if (!stillRunning()) return;
    await this.cleanup(discussion);
    if (!stillRunning()) return;
    this.update(discussion.id, { synthesis: text, synthesis_cost: sessionCost(current), status: 'done', stop_reason: null, ended_at: now() });
    this.clearState(discussion.id);
  }

  /**
   * A participant session that ended on its own is left out of the round, so the others can complete it. Runs one
   * macrotask after `session:ended` so a `turn_end` already buffered on the stream is recorded first: only a session that
   * produced no answer for the current round is excluded.
   */
  private async onParticipantEnded(session: SessionRow): Promise<void> {
    const discussion = session.discussion_id ? this.d.db.discussions.get(session.discussion_id) : undefined;
    if (!discussion || discussion.status !== 'running' || this.closing.has(discussion.id) || this.stopping.has(discussion.id)) return;
    const state = this.states.get(discussion.id);
    if (!state || state.excluded.has(session.harness) || state.done.has(session.harness)) return;
    state.excluded.add(session.harness);
    this.d.bus.emit('discussion', { id: discussion.id });
    if (this.costReached(discussion)) { await this.stopForCap(discussion, state); return; }
    await this.settle(discussion.id);
  }

  /** A synthesis session that ended on its own (a crash) is settled as if its turn had ended: stored, or failed with no synthesis. */
  private async onSynthesisCrashed(session: SessionRow): Promise<void> {
    const discussion = session.discussion_id ? this.d.db.discussions.get(session.discussion_id) : undefined;
    if (!discussion || discussion.status !== 'running' || this.synthesizing.has(discussion.id)) return;
    const error = session.status === 'failed' ? session.end_reason ?? 'synthesis session ended' : undefined;
    await this.onSynthesisEnd(discussion, session, error);
  }

  /** Whether the discussion's cost has reached its cap. */
  private costReached(discussion: DiscussionRow): boolean {
    return this.discussionCost(discussion.id) >= discussion.cost_cap;
  }

  /** Ends a discussion that crossed its cost cap, keeping every turn so far and running no synthesis. */
  private async stopForCap(discussion: DiscussionRow, state: RoundState): Promise<void> {
    if (this.closing.has(discussion.id)) return;
    this.closing.add(discussion.id);
    await this.endAndMark(discussion, 'stopped', `cost cap $${discussion.cost_cap} reached after round ${state.round}`);
  }

  /** Ends every still-running participant session without touching the row's status. */
  private async endSessions(discussion: DiscussionRow, reason: string): Promise<void> {
    for (const s of this.d.db.sessions.forDiscussion(discussion.id)) {
      if (s.status !== 'running') continue;
      try {
        if (this.d.sessions.isLive(s.id)) await this.d.sessions.interrupt(s.id, { by: 'user', reason });
        else await this.d.sessions.end(s.id);
      } catch (err) {
        log.warn(`discussions: could not end participant ${s.id}`, err);
      }
    }
  }

  private async endAndMark(discussion: DiscussionRow, status: DiscussionRow['status'], reason: string): Promise<void> {
    await this.endSessions(discussion, reason);
    await this.cleanup(discussion);
    // A Stop that landed during the teardown already wrote the terminal status and stays the final word.
    if (this.d.db.discussions.get(discussion.id)?.status !== 'running') return;
    this.update(discussion.id, { status, stop_reason: reason, ended_at: now() });
    this.clearState(discussion.id);
  }

  private update(id: string, patch: Partial<DiscussionRow>): void {
    this.d.db.discussions.update(id, patch);
    this.d.bus.emit('discussion', { id });
  }

  private clearState(id: string): void {
    this.states.delete(id);
    this.closing.delete(id);
    this.stopping.delete(id);
    this.synthesizing.delete(id);
  }

  /** Removes every participant's worktree (or temp directory); a failure is logged and the rest still go. */
  private async cleanup(discussion: DiscussionRow): Promise<void> {
    const repo = discussion.repo_id ? this.d.db.repos.get(discussion.repo_id) : null;
    if (repo) {
      // Every checkout under the discussion's directory, not only those a session row names: a start that failed after its
      // `git worktree add`, or a row a repository removal is about to delete, still leaves a checkout there.
      const root = path.join(this.d.config.worktreesDir, repo.id, `disc-${discussion.id}`);
      for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
        try { await removeWorktreeRetry(repo.path, path.join(root, name), null); }
        catch (err) { log.warn(`discussions: could not remove the worktree ${path.join(root, name)}`, err); }
      }
      await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!repo) await fsp.rm(path.join(this.d.config.dataDir, 'discussions', discussion.id), { recursive: true, force: true }).catch(() => undefined);
  }
}
