import fs from 'node:fs';
import path from 'node:path';
import type { Account, Effort, OrchestratorActivity, Repo, StatusResponse } from '@overseer/shared';
import type { Db, StoredAccount } from '../db/db';
import type { Bus } from '../bus';
import type { Config } from '../config';
import type { SessionManager } from '../sessions/manager';
import { envTokenExpiresAt, freshAccountEnv } from '../accounts/env';
import { CLAUDE_OAUTH_REFRESH_MARGIN_MS } from '../accounts/login';
import { accountLoggedIn } from '../accounts/status';
import { accountUsable } from '../accounts/usage';
import { accountDisplayName } from '../accounts/display';
import type { Push } from '../push/push';
import { batchStatusLabel, verifyLabel } from '../lifecycle/lifecycle';
import { storeAttachments, type AttachmentInput, type StoredAttachment } from './attachments';
import { log } from '../util/log';
import { isQuietNotice, sinceLastTurn } from './quietNotices';

/** Prepends the queued notices to a turn: the quiet ones since the last turn first, then those that waited for a session. */
function withQueued(queued: { text: string; hint?: string | null }[], text: string): string {
  const quiet = queued.filter((q) => isQuietNotice(q.text));
  const rest = queued.filter((q) => !isQuietNotice(q.text));
  const blocks = [
    ...(quiet.length ? [sinceLastTurn(quiet)] : []),
    ...(rest.length ? [`[Overseer] Notices while no orchestrator session was live:\n${rest.map((q) => `- ${q.text}${q.hint ? ` ${q.hint}` : ''}`).join('\n')}`] : []),
  ];
  return blocks.length ? `${blocks.join('\n\n')}\n\n${text}` : text;
}

/** Stable keys let a program wait retry its persisted notice after a crash without adding a second chat row. */
function programWaitNoticeKey(text: string): string | undefined {
  const released = /^Program [\s\S]*: batch (\S+) can start \((\S+) merged\)$/.exec(text);
  if (released) return `program-wait-release:${released[1]}:${released[2]}`;
  const abandoned = /^Program [\s\S]*: prerequisite batch (\S+) was abandoned; batch (\S+) remains held\. What should happen next\?$/.exec(text);
  if (abandoned) return `program-wait-abandoned:${abandoned[2]}:${abandoned[1]}`;
  return undefined;
}

/** A user message as delivered: its text, then one `[attached image: <path>]` line per stored file. */
function userDeliveryText(text: string, stored: { path: string }[]): string {
  const imageLines = stored.map((s) => `[attached image: ${s.path}]`).join('\n');
  return imageLines ? (text ? `${text}\n\n${imageLines}` : imageLines) : text;
}

/** A Retry the row cannot take: 404 when it reports no undelivered message, 409 when a Retry of it was already accepted. */
export class RetryError extends Error {
  constructor(readonly statusCode: 404 | 409, message: string) { super(message); }
}

export interface OrchestratorDeps { db: Db; sessions: SessionManager; bus: Bus; config: Config; push?: Push; usageGate?: typeof accountUsable;
  /** Writes a quiet notice to its bead's notes, since no turn will make the orchestrator record it. */
  noteBead?: (beadId: string, text: string) => Promise<void> }

/** The daemon's own clock, as an offset from UTC: the dashboard renders every timestamp in it and tool output is UTC. */
export function localZone(now = new Date()): string {
  const mins = -now.getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Longest command text shown in the activity line when a Bash/PowerShell call carries no description. */
const COMMAND_SUMMARY_MAX = 80;
const MCP_PREFIX = 'mcp__overseer__';
/** Longest push body for an orchestrator reply: the text collapsed to one line and cut with an ellipsis. */
const PUSH_BODY_MAX = 160;
export function pushBody(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PUSH_BODY_MAX ? line.slice(0, PUSH_BODY_MAX - 1).trimEnd() + '…' : line;
}

/** One line about a tool call for the Chat status line: never the full command, never any output. */
export function activitySummary(name: string, input: unknown): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  if (name === 'Bash' || name === 'PowerShell') {
    const description = str('description').trim();
    if (description) return description;
    const command = str('command').replace(/\s+/g, ' ').trim();
    return command.length > COMMAND_SUMMARY_MAX ? `${command.slice(0, COMMAND_SUMMARY_MAX)}…` : command || name;
  }
  if (!name.startsWith(MCP_PREFIX)) return name;
  const tool = name.slice(MCP_PREFIX.length);
  const bead = str('bead_id');
  switch (tool) {
    case 'list_repos': return 'listing repositories';
    case 'list_tasks': return 'listing tasks';
    case 'list_batches': return 'listing batches';
    case 'bd': { const first = Array.isArray(args.args) && typeof args.args[0] === 'string' ? args.args[0] : ''; return `running bd${first ? ` ${first}` : ''}`; }
    case 'spawn_worker': return `dispatching a worker for ${bead}`;
    case 'message_worker': return `messaging the worker of ${bead}`;
    case 'interrupt_worker': return `stopping the worker of ${bead}`;
    case 'worker_status': return `checking worker status for ${bead}`;
    case 'worker_diff': return `reading the diff of ${bead}`;
    case 'request_merge': return `requesting a merge of ${bead}`;
    case 'create_batch': return 'creating a batch';
    case 'request_batch_review': return 'handing a batch over for review';
    case 'batch_retrospective': return 'reading a batch retrospective';
    case 'ask_user': return 'asking you a question';
    default: return tool;
  }
}

/** Finished batches named in the new-session preamble; older ones are a count. */
const FINISHED_IN_PREAMBLE = 5;

export class Orchestrator {
  private sessionId: string | null = null;
  /** Resolves after an idle keep-alive session is ended, before its replacement starts synchronously. */
  private restarting: Promise<void> | null = null;
  private lastActivityAt: number = 0;
  private fresh = false;
  /** The account whose logged-out state was already explained in Chat, so a run of refused starts writes that row once. */
  private refusedAccount: string | null = null;
  /** Outstanding user-message cutoffs, keyed by message id so a turn end settles only the delivery it belongs to. */
  private cutoff = new Map<number, number[]>();
  /** User messages are stored immediately, then their deliveries run in the same order on this promise chain. */
  private userDeliveryQueue: Promise<void> = Promise.resolve();
  private pendingRetryRecovery: Promise<void> | null = null;
  /** Deliveries without a `turn_end` yet: a notice sent mid-turn pipelines a second turn, so a boolean read "waiting" while the second ran. The rail reads "thinking" while > 0, "waiting" otherwise. */
  private pending = 0;
  /** Per delivery without a `turn_end` yet, in order: the id of the user message it carried, or null for a notice or an answer, and the
   * exact text sent, so a turn rejected on its token can be re-sent. The head is the turn the orchestrator's text belongs to, whatever
   * arrived in the thread since (round 16: a late reply read as answering the newer message). `requeue` holds the chat rows to put back
   * in the queue when the auth recovery ends without resuming — the notice's own row and the queued notices this turn carried. */
  private turns: { user: number | null; text: string; explainRefusal: boolean; requeue: number[] }[] = []; // one object per delivery, so a failed send removes its own entry and not another's (fix round 16 review)
  /** Rows handed to the live session that no reply has answered yet: an assistant text or an ask_user answers them all. Cleared when the session ends,
   * so a message a session never answered stays "Seen" rather than being marked by the next session's reply. */
  private awaitingReply: number[] = [];
  /** Set when the current turn's `auth_failed` event arrived, so the `turn_end` that follows (claude emits both) is the one that recovers. */
  private authFailedThisTurn = false;
  /** Set once a session was resumed to recover from a rejected token: a further rejection then reports the account as logged out instead of
   * resuming again. Cleared by any ordinary turn, so a later rejection on a working session may still resume once. */
  private authResumeUsed = false;
  /** Held while a rejected token is being recovered: a concurrent delivery waits for it, and `status()` reports the ended old session as idle. */
  private authRecovery: Promise<void> | null = null;
  private authResumeUsageRefusal: string | null = null;
  /** The failed session's account and already-refreshed environment, handed to the resume `deliver()` starts: a fallback-started session
   * resumes on its own account rather than the configured one, and its token is refreshed once for the recovery, not again per delivery. */
  private authResumeStart: { account: StoredAccount | null; env: NodeJS.ProcessEnv; tokenExpiresAt: number | null; model: string; sessionId: string | null } | null = null;
  /** Set while a token rollover ends the live session to resume it, so `status()` reports the ended old row as idle, not ended. */
  private rollingOver = false;
  /** What the session is doing right now, for the Chat status line; `idle` outside a turn. */
  private activity: OrchestratorActivity = { state: 'idle', tool: null, summary: null, started_at: new Date(0).toISOString() };
  /** The session's last main-thread request (tokens, model) and the windows the harness reported at turn end; together the rail's context percentage. */
  private context: { tokens: number; model: string } | null = null;
  private windows: Record<string, number> = {};
  /** An `ask_user` call in the current turn already pushed the question (mcp/tools.ts); the reply that wraps it up is not pushed again. */
  private askedThisTurn = false;
  /** Chat ids at or below this were handed over before the current turn: a tool call acts only on a user row delivered since. */
  private linkBoundary = 0;

  constructor(private d: OrchestratorDeps) {
    this.linkBoundary = d.db.chat.latestSeenUserId() ?? 0;
    d.bus.on('event', (e) => {
      if (e.session_id !== this.sessionId) return;
      this.lastActivityAt = Date.now();
      if (e.type === 'context') this.context = e.payload as { tokens: number; model: string };
      if (e.type === 'turn_end') { const w = (e.payload as { contextWindows?: Record<string, number> }).contextWindows; if (w) Object.assign(this.windows, w); }
      // A rejected token is one `auth_failed` event and no `assistant_text` (harness/claude.ts), so no chat row carries the CLI's 401 text.
      // The `turn_end` that follows resumes the same native session on the account's refreshed token and re-sends every failed delivery.
      if (e.type === 'auth_failed') { this.authFailedThisTurn = true; return; }
      if (e.type === 'turn_end') {
        const authFailed = this.authFailedThisTurn || (e.payload as { authFailed?: boolean }).authFailed === true;
        this.authFailedThisTurn = false;
        if (authFailed) {
          const failed = this.turns;
          this.pending = 0; this.turns = []; this.awaitingReply = []; this.askedThisTurn = false;
          this.applyCutoff(failed.flatMap((turn) => turn.user === null ? [] : [turn.user])); d.bus.emit('status'); this.setActivity('idle');
          void this.recoverAuthFailure(failed);
          return;
        }
        // An ordinary turn proves the resumed token works, so a later rejection may resume once more.
        this.authResumeUsed = false;
        this.pending = Math.max(0, this.pending - 1);
        const ended = this.turns.shift();
        if (ended?.user !== null && ended?.user !== undefined) this.applyCutoff([ended.user]);
        d.bus.emit('status'); this.setActivity(this.pending > 0 ? 'thinking' : 'idle'); this.askedThisTurn = false;
        // A turn that ended with no user message still pending closes the window a tool call can attach one to.
        if (!this.turns.some((t) => t.user !== null)) this.linkBoundary = d.db.chat.latestSeenUserId() ?? 0;
      }
      if (e.type === 'tool_call') { const p = e.payload as { name?: string; input?: unknown }; const name = String(p.name ?? ''); if (name === `${MCP_PREFIX}ask_user`) { this.askedThisTurn = true; this.markReplied(); } this.setActivity('tool', name, activitySummary(name, p.input)); }
      if (e.type === 'tool_result') this.setActivity('thinking');
      if (e.type === 'error') this.setActivity('idle');
      if (e.type !== 'assistant_text') return;
      const text = (e.payload as { text?: string }).text;
      if (!text) return;
      d.db.chat.insert({ role: 'assistant', kind: 'message', text, reply_to: this.turns[0]?.user ?? null });
      this.markReplied();
      d.bus.emit('chat');
      if (!this.askedThisTurn && d.db.settings.pushOnReply()) void d.push?.notify({ title: 'Overseer', body: pushBody(text), url: '#chat' });
    });
    d.bus.on('session:ended', (e) => {
      if (e.session.id !== this.sessionId) return;
      // A session that died on a rejected token before its own `turn_end` still resumes: keep the failed deliveries before clearing.
      // The recovery claims `authRecovery` synchronously, before the status below is emitted, so the rail never reads `ended`.
      const ended = this.turns;
      const failed = this.authFailedThisTurn ? ended : [];
      this.authFailedThisTurn = false;
      if (failed.length) void this.recoverAuthFailure(failed);
      this.pending = 0; this.turns = []; this.awaitingReply = []; this.askedThisTurn = false;
      this.applyCutoff(ended.flatMap((turn) => turn.user === null ? [] : [turn.user])); d.bus.emit('status'); this.setActivity('idle');
    });
  }

  /** Records rows handed to the session: sets `seen_at` on each and remembers them so an upcoming reply answers them. */
  private markDelivered(ids: (number | null)[]): void {
    const rows = ids.filter((id): id is number => id !== null);
    if (!rows.length) return;
    this.d.db.chat.markSeen(rows);
    this.awaitingReply.push(...rows);
  }

  /** An assistant text or an ask_user answers every user row seen in this session since the last reply. */
  private markReplied(): void {
    if (!this.awaitingReply.length) return;
    this.d.db.chat.markReplied(this.awaitingReply);
    this.awaitingReply = [];
  }

  /** The current activity; the socket resends it to a client that connects mid-turn. */
  currentActivity(): OrchestratorActivity { return this.activity; }

  private setActivity(state: OrchestratorActivity['state'], tool: string | null = null, summary: string | null = null): void {
    // Repeated `thinking` (a turn_end while another turn is pending, then its first tool_result) keeps its start time; a new tool call is a new line.
    if (state !== 'tool' && this.activity.state === state) return;
    this.activity = { state, tool, summary, started_at: new Date().toISOString() };
    this.d.bus.emit('orchestrator:activity', this.activity);
  }

  private isLive(): boolean { return this.sessionId !== null && this.d.sessions.isLive(this.sessionId); }

  /**
   * The chat message an MCP tool call acts on: the latest user row handed to this session (`seen_at` set by `markDelivered`),
   * or null when no user row was handed over since the last turn that ended with no user message still pending. A notice-only
   * turn and any call from another session therefore get null.
   */
  originChatId(sessionId: string | undefined): number | null {
    if (!sessionId || sessionId !== this.sessionId) return null;
    const latest = this.d.db.chat.latestSeenUserId();
    return latest !== null && latest > this.linkBoundary ? latest : null;
  }

  /** Closes only the questions recorded when the user's composer draft began. */
  private trackCutoff(messageId: number, ids: number[]): void {
    if (ids.length) this.cutoff.set(messageId, [...new Set(ids)]);
  }

  private clearCutoff(messageIds: number[]): void {
    for (const id of new Set(messageIds)) this.cutoff.delete(id);
  }

  private applyCutoff(messageIds: number[]): void {
    const messages = [...new Set(messageIds)];
    const closing = [...new Set(messages.flatMap((id) => this.cutoff.get(id) ?? []))];
    if (closing.length === 0) { this.clearCutoff(messages); return; }
    const n = this.d.db.chat.supersedeIds(closing);
    this.clearCutoff(messages);
    if (n > 0) this.d.bus.emit('chat');
  }

  status(): StatusResponse['orchestrator'] {
    const row = this.sessionId ? this.d.db.sessions.get(this.sessionId) : this.d.db.sessions.latest('orchestrator');
    const last = this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : row?.ended_at ?? row?.started_at ?? null;
    if (!row) return { status: 'idle', native_session_id: null, last_activity_at: null, busy: false, model: null, context: null };
    // After New session, and in a daemon that has not started a session yet (a restart ends the old one), the next message
    // starts or resumes a session; the rail would otherwise read the old row's "ended" as if something broke. A rejected
    // token's recovery reports idle the same way: the ended session is about to be resumed, not left ended.
    if (this.fresh || !this.sessionId || ((this.authRecovery !== null || this.rollingOver) && row.status !== 'running')) return { status: 'idle', native_session_id: null, last_activity_at: last, busy: false, model: row.model ?? null, context: null };
    const window = this.context ? this.windows[this.context.model] : undefined;
    return { status: row.status, native_session_id: row.native_session_id, last_activity_at: last, busy: this.pending > 0 && row.status === 'running', model: row.model ?? null, context: this.context && window ? { tokens: this.context.tokens, window } : null };
  }

  sendUser(text: string, attachments: AttachmentInput[] = [], openQuestionIds?: number[]): Promise<void> {
    // Close only the draft snapshot once the message is accepted. Key it to this message so a turn_end that wins the race
    // with this continuation cannot close a later queued send's questions; the notice travels only in the delivery.
    const open = this.d.db.chat.pendingQuestions();
    const selected = openQuestionIds === undefined ? open : (() => {
      const ids = new Set(openQuestionIds);
      return open.filter((question) => ids.has(question.id));
    })();
    const row = this.d.db.chat.insert({ role: 'user', kind: 'message', text });
    const cutoff = selected.map((question) => question.id);
    this.trackCutoff(row.id, cutoff);
    const stored = attachments.length ? storeAttachments(this.d.config, row.id, attachments) : [];
    if (stored.length) this.d.db.chat.setAttachments(row.id, stored);
    this.d.bus.emit('chat');
    const one = selected.length === 1;
    const moved = selected.length === 0 ? '' : `[Overseer] The user replied in the composer rather than in the answer box of ${selected.map((q) => `question #${q.id} ("${q.text}")`).join(' and ')}. If this message answers ${one ? 'it' : 'them'}, take it as the answer; either way ${one ? 'the question is' : 'the questions are'} closed and no separate answer will come, so do not report ${one ? 'it' : 'them'} as waiting.

`;
    return this.queueUserDelivery(row.id, userDeliveryText(moved + text, stored));
  }

  /**
   * Retry on a row reporting that a user message was not delivered: marks every failure row of that message retried, then
   * re-delivers the stored message — its text (with any repo prefix) and attachment lines — through the same ordered queue as
   * Send, inserting no new user row. Returns once the delivery is queued; throws `RetryError` when the row offers no Retry.
   */
  retryUser(failureId: number): Promise<void> {
    const failure = this.d.db.chat.get(failureId);
    if (!failure || failure.role !== 'system' || failure.failed_for === null || failure.failed_for === undefined) throw new RetryError(404, `chat row ${failureId} is not an undelivered message`);
    if (failure.retried_at) throw new RetryError(409, `chat row ${failureId} was already retried`);
    const user = this.d.db.chat.get(failure.failed_for);
    if (!user || user.role !== 'user') throw new RetryError(404, `message ${failure.failed_for} not found`);
    this.d.db.chat.markRetried(user.id);
    this.d.bus.emit('chat');
    return this.queueUserDelivery(user.id, userDeliveryText(user.text, this.d.db.chat.storedAttachments(user.id)), true);
  }

  /** Requeues accepted retries that were still pending when the previous daemon stopped. Call once after lifecycle recovery. */
  recoverPendingUserRetries(): Promise<void> {
    if (this.pendingRetryRecovery) return this.pendingRetryRecovery;
    const deliveries = this.d.db.chat.pendingRetries().map(({ user_id: userId }) => {
      const user = this.d.db.chat.get(userId);
      if (!user || user.role !== 'user') {
        log.error(`orchestrator: pending Retry references missing user message ${userId}`);
        return Promise.resolve();
      }
      // A failure row may have been written just before the daemon stopped. It belongs to this accepted retry and must
      // stay hidden while recovery makes the delivery attempt again.
      if (this.d.db.chat.markRetried(userId) > 0) this.d.bus.emit('chat');
      return this.queueUserDelivery(userId, userDeliveryText(user.text, this.d.db.chat.storedAttachments(userId)), true);
    });
    this.pendingRetryRecovery = Promise.all(deliveries).then(() => undefined);
    return this.pendingRetryRecovery;
  }

  /** Appends one user message's delivery to the ordered queue; a refusal or a throw leaves a failure row linked to `userId`. */
  private queueUserDelivery(userId: number, delivered: string, retry = false): Promise<void> {
    const delivery = this.userDeliveryQueue.then(async () => {
      let accepted: boolean;
      try {
        accepted = await this.deliver(delivered, userId, true);
        if (accepted) this.applyCutoff([userId]);
        else this.clearCutoff([userId]);
      } catch (err) {
        this.clearCutoff([userId]);
        log.error('orchestrator: user message delivery failed', err);
        const detail = err instanceof Error ? err.message : String(err);
        try {
          const text = `Message saved but not delivered: ${detail}`;
          if (retry) this.d.db.chat.completeRetry(userId, text);
          else this.d.db.chat.insert({ role: 'system', kind: 'message', text, queued: false, hint: null, failed_for: userId });
          this.d.bus.emit('chat');
        } catch (recordError) {
          log.error('orchestrator: could not record user delivery failure', recordError);
        }
        return;
      }
      if (retry) {
        this.d.db.chat.completeRetry(userId);
        this.d.bus.emit('chat');
      }
    });
    this.userDeliveryQueue = delivery.catch((err) => { log.error('orchestrator: user delivery queue failed', err); });
    return this.userDeliveryQueue;
  }

  async answer(questionId: number, text: string): Promise<void> {
    const q = this.d.db.chat.get(questionId);
    if (!q || q.kind !== 'question') throw new Error(`question ${questionId} not found`);
    if (await this.deliver(`Answer to question #${questionId} ("${q.text}"): ${text}`, null, true)) {
      this.d.db.chat.answer(questionId, text);
      this.d.bus.emit('chat');
    }
  }

  /**
   * An Overseer notice. A live session gets it at once. Without one, a notice that needs a decision (`wake`) starts or
   * resumes the orchestrator like a user message does; any other notice is queued and travels at the start of the next turn.
   * A quiet notice (`isQuietNotice`) is queued even while a session is live and travels under `Since your last turn`.
   */
  async systemMessage(text: string, opts: { wake?: boolean; hint?: string; storedAttachments?: StoredAttachment[]; beadId?: string } = {}): Promise<void> {
    // A notice the prompt says needs no action never starts a turn, live session or not: it waits for the next one.
    const quiet = !opts.wake && isQuietNotice(text);
    const live = this.isLive() && !quiet;
    const noticeKey = programWaitNoticeKey(text);
    const record = noticeKey
      ? this.d.db.chat.insertOnce(noticeKey, { role: 'system', kind: 'message', text, queued: !live && !opts.wake, hint: opts.hint ?? null })
      : { row: this.d.db.chat.insert({ role: 'system', kind: 'message', text, queued: !live && !opts.wake, hint: opts.hint ?? null }), inserted: true };
    if (!record.inserted && (record.row.seen_at !== null || (quiet && record.row.queued_at !== null))) return;
    if (record.inserted && quiet && opts.beadId && this.d.noteBead) await this.d.noteBead(opts.beadId, text).catch((err) => log.error(`orchestrator: could not note ${opts.beadId}`, err));
    // `hint` is guidance for the model and goes only into the delivery; the thread row stays the plain log line (round 8).
    const row = record.row;
    const stored = opts.storedAttachments ?? [];
    if (stored.length) this.d.db.chat.setAttachments(row.id, stored);
    this.d.bus.emit('chat');
    if (!live && !opts.wake) return;
    // A refused turn never reached the orchestrator, so a notice sent straight out is queued after the fact rather than lost.
    const images = stored.map((a) => `[attached image: ${a.path}]`).join('\n');
    if (!await this.deliver(`[Overseer] ${text}${opts.hint ? ` ${opts.hint}` : ''}${images ? `\n${images}` : ''}`, null, false, false, [row.id]) && !row.queued_at) {
      this.d.db.chat.requeue(row.id);
      this.d.bus.emit('chat');
    }
  }

  /** Ends the live session (if any); the next message starts a fresh one. */
  async reset(): Promise<void> {
    if (this.sessionId && this.d.sessions.isLive(this.sessionId)) await this.d.sessions.end(this.sessionId);
    this.fresh = true;
    this.awaitingReply = [];
    // A new session starts over: a user row from the old one is no longer the message a tool call acts on.
    this.linkBoundary = this.d.db.chat.latestSeenUserId() ?? 0;
    // The next session is a new one, so a rejection on it may resume once like any other.
    this.authFailedThisTurn = false;
    this.authResumeUsed = false;
    // The orchestrator that asked them is gone, so its open questions no longer wait for an answer: they are superseded the way a
    // composer message supersedes them (round 22 R22-2: a question of the ended session stayed pinned with its answer box and its
    // rail count, and the state it described had moved on). They are superseded before the notice row exists, so each of them keeps
    // its place above the notice that closed it: the thread sorts a resolved question by the moment it was resolved, and a question
    // stamped after the notice read as one the fresh session had just asked and immediately disowned (round 23 R23-2).
    for (const q of this.d.db.chat.pendingQuestions()) this.d.db.chat.supersede(q.id);
    this.d.db.chat.insert({ role: 'system', kind: 'message', text: 'New orchestrator session: the next message starts a fresh orchestrator with no memory of this thread. Batches and tasks are unaffected.' });
    this.d.bus.emit('chat');
    this.d.bus.emit('status');
  }

  /** Returns false when the turn was refused because the orchestrator account is not logged in; nothing was sent or started. */
  private async deliver(text: string, userId: number | null = null, explainRefusal = false, internal = false, requeueExtra: number[] = []): Promise<boolean> {
    // A recovery holds the delivery path: an external message waits for it and rejoins, so it cannot reach the process being replaced.
    if (this.authRecovery && !internal) { await this.authRecovery; return this.deliver(text, userId, explainRefusal, internal, requeueExtra); }
    const { config, db, sessions } = this.d;
    let queued: ReturnType<typeof db.chat.queued> = [];
    // The queue is cleared only once a turn carries it; a send or start that throws leaves the notices for the next one.
    const carried = () => { if (queued.length > 0) { db.chat.flushQueued(); this.d.bus.emit('chat'); } };
    // Refuse before expiring an idle live session: a rejected user message must not end the session that owns open questions.
    const orch = db.settings.orchestrator();
    // A rejected token's recovery already refreshed the account that failed and hands it in here, so the resume stays on that account
    // (a fallback-started session keeps the fallback) and its token is refreshed once, not again per delivery.
    const recovery = this.authResumeStart;
    let account = recovery ? recovery.account : (orch.account ? db.accounts.get(orch.account) : null);
    let idle = Date.now() - this.lastActivityAt > config.orchestratorIdleMs;
    const continuingLiveSession = !!this.sessionId && sessions.isLive(this.sessionId) && !idle;
    // A continuing session whose account was refreshed or logged in again since it started carries a token the account no longer holds;
    // one within the refresh margin is about to lapse. Both end the process and resume the same native session on the account's current
    // token instead of sending into a turn the CLI will reject, so the context and any open question stay.
    const liveRow = continuingLiveSession && this.sessionId ? db.sessions.get(this.sessionId) : undefined;
    const liveAccountId = liveRow?.account ?? null;
    const liveAccount = liveAccountId ? db.accounts.get(liveAccountId) ?? null : null;
    const recordedExpiry = liveRow?.token_expires_at ?? null;
    // Resume needs the native session id the running process recorded, so a session that has not finished a turn yet is left alone.
    // A turn still running is left alone too: ending the process would kill it. The delivery joins it, and if that turn is then
    // rejected on its token, the auth-failure recovery below resumes and re-sends both.
    const tokenRollover = this.pending === 0 && !!liveRow?.native_session_id && recordedExpiry !== null
      && (recordedExpiry !== (liveAccount?.token_expires_at ?? null) || recordedExpiry <= Date.now() + CLAUDE_OAUTH_REFRESH_MARGIN_MS);
    let env: NodeJS.ProcessEnv = {};
    let refreshError: string | null = null;
    let tokenExpiresAt: number | null = null;
    if (account && !continuingLiveSession) {
      if (recovery) { env = recovery.env; tokenExpiresAt = recovery.tokenExpiresAt; }
      else {
        try { env = await freshAccountEnv(db, config, account); tokenExpiresAt = envTokenExpiresAt(db, account); }
        catch (err) { refreshError = err instanceof Error ? err.message : String(err); }
      }
    }
    // A concurrent delivery can start and mark a session active while this one waits for its account refresh.
    idle = Date.now() - this.lastActivityAt > config.orchestratorIdleMs;
    const currentAccount = orch.account ? db.accounts.get(orch.account) : null;
    // A recovery refreshed the failed session's own account, so the configured account's login state is not its concern.
    if (!recovery && orch.account && (refreshError || !currentAccount || !accountLoggedIn(currentAccount))) {
      // The caller re-queues the notice that asked for this start, so the event it carried is delivered once the account is
      // logged in. Repeated wake notices share one explanation, while every user message or answer gets its own response.
      return this.refuseNotLoggedIn(orch.account ?? null, account, refreshError, explainRefusal, explainRefusal ? userId : null);
    }
    if (this.restarting) {
      await this.restarting;
      return this.deliver(text, userId, explainRefusal, internal, requeueExtra);
    }
    // The usage gate runs before a fresh start or auth-failure resume, never against a continuing live session. It is applied
    // after claiming a restart (below) so concurrent deliveries still serialize, and before an idle session is ended so a
    // refusal leaves it available (round: "keeps an idle live session and its open question when every account is unusable").
    let fallbackReason: string | null = null;
    const applyUsageGate = async (): Promise<boolean> => {
      // A recovery resumes the account the failed session already ran on, so a gate refusal cannot move it to another account.
      if (continuingLiveSession || !(account?.harness === 'claude' && account.kind === 'oauth_token')) { this.refusedAccount = null; return true; }
      const gate = this.d.usageGate ?? accountUsable;
      const gateModel = recovery?.model ?? orch.model ?? '';
      const configured = recovery?.sessionId
        ? await gate(db, config, account.id, gateModel, undefined, undefined, recovery.sessionId)
        : await gate(db, config, account.id, gateModel);
      if (configured.usable) { this.refusedAccount = null; return true; }
      if (recovery) { this.authResumeUsageRefusal = configured.reason; return false; }
      fallbackReason = configured.reason.replace(`account ${account.name}: `, '');
      const alternatives = db.accounts.list().filter((candidate) => candidate.id !== account!.id && candidate.harness === 'claude' && candidate.kind === 'oauth_token' && candidate.logged_in);
      const reasons = [configured.reason];
      let selected: typeof account | null = null;
      for (const candidate of alternatives) {
        const usable = await gate(db, config, candidate.id, orch.model ?? '');
        if (!usable.usable) { reasons.push(usable.reason); continue; }
        const stored = db.accounts.get(candidate.id)!;
        try { env = await freshAccountEnv(db, config, stored); tokenExpiresAt = envTokenExpiresAt(db, stored); selected = stored; break; } catch (err) { reasons.push(`account ${candidate.name}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      if (!selected) {
        const refusal = `usage:${orch.account}:${configured.reason}`;
        if (explainRefusal || this.refusedAccount !== refusal) {
          this.refusedAccount = refusal;
          db.chat.insert({ role: 'system', kind: 'message', text: `Account ${accountDisplayName(account)} is not usable, so the orchestrator was not started. ${reasons.join('; ')}. Log in an account from Setup and try again.`, queued: false, hint: null, failed_for: explainRefusal ? userId : null });
          this.d.bus.emit('chat');
        }
        return false;
      }
      account = selected;
      this.refusedAccount = null;
      return true;
    };
    // Refreshing can yield while another delivery starts the keep-alive session. Re-read it here so this delivery joins it.
    const liveSessionId = this.sessionId;
    if (liveSessionId && sessions.isLive(liveSessionId)) {
      if (!idle && !tokenRollover) {
        queued = db.chat.queued();
        text = withQueued(queued, text);
        const turn = { user: userId, text, explainRefusal, requeue: [...requeueExtra, ...queued.map((row) => row.id)] };
        this.lastActivityAt = Date.now(); this.pending++; this.turns.push(turn); this.d.bus.emit('status');
        this.setActivity('thinking');
        // The row is handed over at `send`, so it counts as seen now; a throw below puts it back to no status.
        const delivered: (number | null)[] = [userId, ...queued.map((row) => row.id)];
        this.markDelivered(delivered);
        // Start the send then flush without yielding: another delivery cannot carry these rows too.
        const sent = sessions.send(liveSessionId, text); carried();
        try { await sent; } catch (err) { for (const row of queued) db.chat.requeue(row.id); db.chat.clearSeen(delivered.filter((id): id is number => id !== null)); this.awaitingReply = this.awaitingReply.filter((id) => !delivered.includes(id)); this.pending = Math.max(0, this.pending - 1); this.turns = this.turns.filter((t) => t !== turn); this.d.bus.emit('chat'); this.d.bus.emit('status'); if (this.pending === 0) this.setActivity('idle'); throw err; } // a failed send never leaves "thinking" stuck
        return true;
      }
      // Claim the restart synchronously (no await before this point since the idle check above) so a concurrent delivery's
      // "if (this.restarting)" join sees it, then gate before actually ending the session the claim protects.
      let finishRestart!: () => void;
      this.restarting = new Promise<void>((resolve) => { finishRestart = resolve; });
      try {
        if (tokenRollover) {
          // Same conversation on the same account: refresh its token and carry the new env into the resume. A refused refresh
          // leaves the session and its open questions untouched, so the run continues once the account is logged in again.
          try { env = await freshAccountEnv(db, config, liveAccount); tokenExpiresAt = envTokenExpiresAt(db, liveAccount); }
          catch (err) { return this.refuseNotLoggedIn(liveAccountId ?? orch.account ?? null, liveAccount ?? account, err instanceof Error ? err.message : String(err), explainRefusal, explainRefusal ? userId : null); }
          account = liveAccount;
        } else if (!(await applyUsageGate())) {
          return false;
        }
        if (tokenRollover) this.rollingOver = true;
        await sessions.end(liveSessionId);
      } finally { finishRestart(); this.restarting = null; this.rollingOver = false; }
      // An idle session is replaced fresh; a token rollover resumes the same native session below, with no "New orchestrator session" row.
      if (idle) this.fresh = true;
    } else if (!(await applyUsageGate())) {
      return false;
    }
    // Usage checks yield while another delivery can start the replacement session. Join it instead of starting a second one.
    if (this.sessionId && sessions.isLive(this.sessionId)) { this.rollingOver = false; return this.deliver(text, userId, explainRefusal, internal, requeueExtra); }
    queued = db.chat.queued();
    text = withQueued(queued, text);
    fs.mkdirSync(config.orchestratorDir, { recursive: true });
    const previous = db.sessions.latest('orchestrator');
    const previousAt = previous ? Date.parse(previous.ended_at ?? previous.started_at) : 0;
    const resume = !this.fresh && previous?.native_session_id && Date.now() - previousAt <= config.orchestratorIdleMs ? previous.native_session_id : undefined;
    const prompt = resume ? text : `${this.preamble()}\n\n${text}`;
    // Model and prompt settings apply only to a fresh session; account environment applies to every spawned process, including resume.
    let systemPromptFile = path.join(config.promptsDir, 'orchestrator.md');
    let model: string | undefined;
    let recordedModel: string | undefined;
    let effort: Effort | undefined;
    if (!resume) {
      if (orch.promptOverride) {
        systemPromptFile = path.join(config.orchestratorDir, 'prompt.md');
        fs.writeFileSync(systemPromptFile, orch.promptOverride);
      }
      model = orch.model ?? undefined;
      effort = orch.effort ?? undefined;
    } else {
      // The model setting cannot change the resumed CLI thread, so the CLI is told none; the row still records the model
      // that session is running: the one it resolved when it last ran, else the one it recorded, else the setting.
      recordedModel = previous?.resolved_model ?? previous?.model ?? orch.model ?? undefined;
    }
    const row = sessions.start({
      role: 'orchestrator',
      harness: 'claude',
      cwd: config.orchestratorDir,
      prompt,
      systemPromptFile,
      mcpServers: [{ name: 'overseer', url: `http://127.0.0.1:${config.port}/mcp` }],
      resumeId: resume,
      keepAlive: true,
      model,
      recordedModel,
      effort,
      account: account?.id ?? null,
      tokenExpiresAt,
      env,
    });
    this.sessionId = row.id;
    this.refusedAccount = null;
    if (!recovery) this.authResumeUsed = false;
    if (fallbackReason) {
      db.chat.insert({ role: 'system', kind: 'message', text: `[Overseer] orchestrator session started on account ${accountDisplayName(account)}: ${accountDisplayName(currentAccount)} is ${fallbackReason}`, queued: false, hint: null });
      this.d.bus.emit('chat');
    }
    this.fresh = false;
    this.context = null; this.windows = {};
    this.pending = 1;
    this.turns = [{ user: userId, text, explainRefusal, requeue: [...requeueExtra, ...queued.map((row) => row.id)] }];
    this.lastActivityAt = Date.now();
    this.markDelivered([userId, ...queued.map((row) => row.id)]);
    carried();
    this.d.bus.emit('status');
    this.setActivity('thinking');
    return true;
  }

  /** Explains a refused start the account cannot authenticate for; one row per account, or every time when `always`. */
  private refuseNotLoggedIn(accountId: string | null, account: StoredAccount | null | undefined, detail: string | null = null, always = false, failedFor: number | null = null): false {
    if (!accountId || always || this.refusedAccount !== accountId) {
      this.refusedAccount = accountId;
      const text = accountId
        ? `Account ${accountDisplayName(account) ?? accountId} is not logged in, so the orchestrator was not started.${detail ? ` ${detail}.` : ''} Log in the account from Setup and try again.`
        : "The orchestrator's Claude login was rejected. Log in to the Claude CLI again and try again.";
      this.d.db.chat.insert({ role: 'system', kind: 'message', text, queued: false, hint: null, failed_for: failedFor });
      this.d.bus.emit('chat');
    }
    return false;
  }

  /** The account the current orchestrator session runs on, read before a recovery ends that session. */
  private sessionAccount(): { id: string; account: StoredAccount | null } | null {
    const row = this.sessionId ? this.d.db.sessions.get(this.sessionId) : undefined;
    const id = row?.account ?? null;
    return id ? { id, account: this.d.db.accounts.get(id) ?? null } : null;
  }

  /**
   * A turn was rejected on its account's token. Ends the failed process, resumes the same native session on a freshly refreshed
   * token, and re-sends every delivery that failed this way — a user message, an answer or a notice — once each and in order. A
   * refresh that throws, or a resumed session that is rejected again, reports the account as logged out and stops: one resume,
   * never a loop, and no chat row ever carries the CLI's raw 401 text.
   */
  private async recoverAuthFailure(failed: { user: number | null; text: string; explainRefusal: boolean; requeue: number[] }[]): Promise<void> {
    if (this.authRecovery) return;
    let done!: () => void;
    this.authRecovery = new Promise<void>((resolve) => { done = resolve; });
    const { db, config, sessions } = this.d;
    const who = this.sessionAccount();
    const accountId = who?.id ?? db.settings.orchestrator().account ?? null;
    const account = who?.account ?? (accountId ? db.accounts.get(accountId) ?? null : null);
    const failedSession = this.sessionId ? db.sessions.get(this.sessionId) : undefined;
    const model = failedSession?.resolved_model ?? failedSession?.model ?? db.settings.orchestrator().model ?? '';
    const requeueFailedNotices = (): void => {
      // Each failed delivery's own `deliver()` already returned true, so a recovery that cannot start would otherwise lose its
      // notice's chat row and any queued notice the turn carried. Put them back for the next turn; `requeue` ignores queued rows.
      let requeued = false;
      for (const delivery of failed) for (const id of delivery.requeue) {
        const row = db.chat.get(id);
        if (row && !row.queued_at) { db.chat.requeue(id); requeued = true; }
      }
      if (requeued) this.d.bus.emit('chat');
    };
    const explainFailure = (detail: string | null = null): void => {
      requeueFailedNotices();
      const replies = failed.filter((delivery) => delivery.explainRefusal);
      if (replies.length) for (const delivery of replies) this.refuseNotLoggedIn(accountId, account, detail, true, delivery.user);
      else this.refuseNotLoggedIn(accountId, account, detail);
    };
    const explainUsageRefusal = (detail: string): void => {
      requeueFailedNotices();
      const replies = failed.filter((delivery) => delivery.explainRefusal);
      const rows = replies.length ? replies : [{ user: null }];
      for (const delivery of rows) {
        db.chat.insert({ role: 'system', kind: 'message', text: `The orchestrator was not resumed because ${detail}. Try again after usage resets or select another account.`, queued: false, hint: null, failed_for: delivery.user });
      }
      this.d.bus.emit('chat');
    };
    try {
      if (this.sessionId && sessions.isLive(this.sessionId)) await sessions.end(this.sessionId);
      this.sessionId = null;
      this.pending = 0; this.turns = []; this.authFailedThisTurn = false;
      this.applyCutoff(failed.flatMap((turn) => turn.user === null ? [] : [turn.user])); this.d.bus.emit('status'); this.setActivity('idle');
      // Already resumed once for a rejected token and the fresh token was rejected too: the account is really logged out, no third try.
      if (this.authResumeUsed) { explainFailure(); return; }
      // Refresh the failed session's account once and carry the environment into the resume: `deliver()` otherwise re-resolves the
      // configured account and refreshes again, which moves a fallback-started session and can reject a token that was just renewed.
      let env: NodeJS.ProcessEnv;
      let tokenExpiresAt: number | null;
      try { env = await freshAccountEnv(db, config, account); tokenExpiresAt = envTokenExpiresAt(db, account); }
      catch (err) { explainFailure(err instanceof Error ? err.message : String(err)); return; }
      this.authResumeUsed = true;
      this.authResumeStart = { account, env, tokenExpiresAt, model, sessionId: failedSession?.id ?? null };
      this.authResumeUsageRefusal = null;
      for (const delivery of failed) {
        // Carry the failed delivery's requeue rows into the resumed turn, so a resumed session rejected again restores them too.
        if (!(await this.deliver(delivery.text, delivery.user, delivery.explainRefusal, true, delivery.requeue))) {
          if (this.authResumeUsageRefusal) explainUsageRefusal(this.authResumeUsageRefusal);
          break;
        }
      }
    } catch (err) {
      log.error('orchestrator: auth-failure recovery failed', err);
    } finally {
      this.authResumeStart = null;
      this.authResumeUsageRefusal = null;
      done();
      this.authRecovery = null;
    }
  }

  private preamble(): string {
    const batches = this.d.db.batches.all().map((b) => {
      const wts = this.d.db.worktrees.forBatch(b.id);
      return { ...b, total: wts.length, done: wts.filter((w) => w.merged_at).length, closed: wts.filter((w) => w.closed_at).length };
    });
    return sessionPreamble(this.d.db.repos.all(), batches, undefined, this.d.db.accounts.list());
  }
}

/** A batch as the new-session preamble names it: its bead counts are the worktree rows of the batch. */
export interface PreambleBatch { id: string; title: string; branch: string; status: string; waiting_on: string | null; total: number; done: number; closed: number }

/** The first lines of a fresh orchestrator session, from the repos and batches the daemon knows; the prompt eval sends the same text. */
export function sessionPreamble(repoRows: Repo[], all: PreambleBatch[], zone = localZone(), accounts: Pick<Account, 'id' | 'name'>[] = []): string {
  const line = (b: PreambleBatch) => `${b.id} "${b.title}" on ${b.branch}: ${batchStatusLabel(b.status, b.waiting_on)}, ${b.done}/${b.total} beads done${b.closed ? `, ${b.closed} closed by the user` : ''}`;
  // Every batch carries its status: a fresh session read "1/1 beads done" on a batch in review as merged (round 9). Finished batches are capped to the newest few; list_batches has the rest.
  const live = all.filter((b) => b.status === 'open' || b.status === 'review').map(line);
  const finished = all.filter((b) => b.status === 'merged' || b.status === 'abandoned');
  const shown = finished.slice(-FINISHED_IN_PREAMBLE).map(line);
  const more = finished.length - shown.length;
  const batches = `${live.length ? live.join('; ') : 'none open or in review'}${shown.length ? `; finished: ${shown.join('; ')}${more > 0 ? `; and ${more} more (list_batches has them)` : ''}` : ''}`;
  // The repo configuration travels with the session: the orchestrator otherwise infers a verify command from old bead notes (round 7).
  const repos = repoRows.map((r) => {
    const filter = r.model_filter;
    const details = filter ? [
      ...(filter.harnesses.length ? [`harnesses ${filter.harnesses.join(', ')}`] : []),
      ...(filter.models.length ? [`models ${filter.models.join(', ')}`] : []),
      ...(filter.accounts.length ? [`accounts ${filter.accounts.map((id) => accounts.find((account) => account.id === id)?.name ?? 'removed account').join(', ')}`] : []),
    ] : [];
    return `${r.id} (base ${r.base_branch}, merge mode ${r.merge_mode}, ${verifyLabel(r)}${details.length ? `, model filter: ${details.join('; ')}` : ''})`;
  });
  // The dashboard's clock is the daemon's, and tool output is UTC: a time quoted straight from a tool was two hours off what the
  // user was reading (round 19). The offset travels with the session, like the repo configuration above it.
  return `[Overseer] New orchestrator session (the previous one expired after inactivity or was reset). State lives in beads and the board, not in this chat. Repositories: ${repos.length ? repos.join('; ') : 'none'}. Batches (a batch in review is awaiting the user's review and is not merged, whatever its beads-done count): ${batches}. Call list_tasks before acting. The dashboard shows local time, which is ${zone}.`;
}
