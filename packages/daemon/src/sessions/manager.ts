import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CostSource, Effort, HarnessName, SessionRole, SessionRow, TierName } from '@overseer/shared';
import type { Db } from '../db/db';
import type { Bus, SessionEnded, SessionStop } from '../bus';
import type { HarnessAdapter, McpServerConfig, SessionHandle, TokenUsage } from '../harness/types';
import { costSource, estimateCost, selectContextPrice, type PriceSource } from '../pricing/catalog';
import { log } from '../util/log';
import { accountEnv } from '../accounts/env';
import { clearAccountUsageCacheForAccount } from '../accounts/usage';

export type { SessionEnded };

/**
 * The model id Claude Code writes on its own error and warning messages. It is not a real model (it is absent from the
 * catalog, so pricing it would leave the session unknown), and it must never replace the id the assistant messages resolved.
 */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * The most bytes of one `tool_result`'s output text kept in the events table. A `tool_result` is over 90% of that table's
 * payload bytes and tools such as Bash and Read return far more than anyone reads back, while every reader clips far shorter:
 * the web summarizes a trace row to 120 characters (`Trace.tsx`), the orchestrator reads only the event's type, and no daemon
 * code parses a stored output. The original byte count beyond this cap is kept in a `truncated_bytes` field.
 */
export const TOOL_RESULT_MAX_BYTES = 16 * 1024;

/** The capped copy of one harness event: only a `tool_result` whose output text is over the cap changes, every other event passes through. */
export function capToolResult<T extends { type: string }>(ev: T): T {
  if (ev.type !== 'tool_result') return ev;
  const output = (ev as { output?: unknown }).output;
  // A harness may return a string or a structured value (Claude's content blocks, codex's result object); the reader's text is
  // the value for a string and its JSON otherwise, so that is what is measured and capped. A value at or under the cap is left
  // exactly as it was, type and all, so only an oversized output changes shape.
  const text = typeof output === 'string' ? output : String(JSON.stringify(output));
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= TOOL_RESULT_MAX_BYTES) return ev;
  // A byte position that is not a continuation byte starts a UTF-8 rune, so trimming back to one keeps every stored rune whole.
  let end = TOOL_RESULT_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const truncated = buf.subarray(0, end).toString('utf8');
  return { ...ev, output: truncated, truncated_bytes: buf.length - Buffer.byteLength(truncated, 'utf8') };
}

export interface StartSessionOpts {
  role: SessionRole;
  harness: HarnessName;
  repoId?: string | null;
  beadId?: string | null;
  cwd: string;
  prompt: string;
  systemPromptFile?: string;
  mcpServers?: McpServerConfig[];
  resumeId?: string;
  denyBackground?: boolean;
  evalSandbox?: boolean;
  tools?: string[];
  /** Passed to the adapter unchanged; see `StartOpts`. Only the prompt eval sets them. */
  strictMcpConfig?: boolean;
  maxBudgetUsd?: number;
  noSessionPersistence?: boolean;
  startCommit?: string | null;
  batchId?: string | null;
  beadTitle?: string | null;
  keepAlive?: boolean;
  tier?: TierName;
  model?: string;
  /** Recorded on the row as `model` without being passed to the CLI: a resumed thread keeps its model though the CLI is not told one. */
  recordedModel?: string;
  effort?: Effort;
  verifyOnly?: boolean;
  needsServer?: boolean;
  /** Marks a worker dispatched with both `harness` and `tier` (`harness_forced`), so every automatic retry keeps that harness within the tier. */
  harnessForced?: boolean;
  account?: string | null;
  /** The expiry of the Claude OAuth token `env` carries, read from the account after any refresh; omitted for an account without one and the CLI's own login. */
  tokenExpiresAt?: number | null;
  /** Marks the row as the one resume a session that ended on a rejected login gets (`auth_resumed`). */
  authResumed?: boolean;
  /** The discussion a `role: 'discussion'` session belongs to; read back for turns, Stop and recovery. */
  discussionId?: string;
  /** `'synthesis'` for the discussion's closing synthesis session, so a round never mistakes it for a participant. */
  discussionKind?: 'synthesis';
  env?: NodeJS.ProcessEnv;
}

interface Live {
  adapter: HarnessAdapter;
  handle: SessionHandle;
  keepAlive: boolean;
  queued: number;
  lastText: string | null;
  lastError: string | null;
  errorSinceTurn: boolean;
  /** The structured auth signal this session's stream carried (`auth_failed` event, or a `turn_end` with `authFailed`); sticky for the session's life. */
  authFailed: boolean;
  /**
   * Set the moment a stop is asked for, before the process is signalled: the kill makes the harness report the death as an
   * error event, and whether that arrives before or after the stop has finished is a matter of machine load. A session we
   * ended by our own hand is recorded as `ended`, never as `failed` (`finish`).
   */
  stopped: boolean;
  /** The stop that set `stopped`, carried on the session-end event so the lifecycle settle never has to wait for the `interrupt` event. */
  stop?: SessionStop;
  /** Set the moment the adapter's handle is ended, so a late event on the same session never ends it twice (the adapters throw on a handle they no longer hold). */
  ended: boolean;
  files: Set<string>;
  cost: number | null;
  usage: TokenUsage;
  /** The codex thread counters this session resumed above; empty for a fresh thread and for the other harnesses. */
  baseline: TokenUsage;
  /** The model id the harness resolved for its main thread (Claude emits it per assistant message); null until one is seen. */
  resolvedModel: string | null;
  /**
   * The estimate for a harness that reports its usage per response (opencode), accumulated response by response at the tier
   * each response's own input selects. Null for Claude and codex, which are priced once from the cumulative counters.
   */
  estimate: number | null;
}

/** What a session already knows when it is watched: the counters persisted so far, the resolved model, the cost and the codex thread baseline. */
interface LiveSeed {
  usage?: TokenUsage;
  baseline?: TokenUsage;
  resolvedModel?: string | null;
  cost?: number | null;
  estimate?: number | null;
  /** The structured auth signal already recorded for this session, so an adopted process keeps it even when the log replays none. */
  authFailed?: boolean;
}

/** The token counts a row already holds; an adopted session keeps adding to them instead of restarting at zero. */
function persistedUsage(row: SessionRow): TokenUsage {
  const usage: TokenUsage = {};
  if (typeof row.input_tokens === 'number') usage.input = row.input_tokens;
  if (typeof row.output_tokens === 'number') usage.output = row.output_tokens;
  if (typeof row.cache_read_tokens === 'number') usage.cacheRead = row.cache_read_tokens;
  if (typeof row.cache_write_tokens === 'number') usage.cacheWrite = row.cache_write_tokens;
  if (typeof row.cache_write_1h_tokens === 'number') usage.cacheWrite1h = row.cache_write_1h_tokens;
  if (typeof row.reasoning_tokens === 'number') usage.reasoning = row.reasoning_tokens;
  return usage;
}

/** The thread counters a codex session resumed from, stored as JSON on the row so an adopted session keeps pricing the delta. */
function persistedBaseline(row: SessionRow): TokenUsage {
  if (!row.usage_baseline) return {};
  try {
    const parsed: unknown = JSON.parse(row.usage_baseline);
    return parsed && typeof parsed === 'object' ? (parsed as TokenUsage) : {};
  } catch {
    return {};
  }
}

/** Component-wise `total - baseline`, clamped at zero: the counters a resumed codex session added above its thread's baseline. */
function ownUsage(total: TokenUsage, baseline: TokenUsage): TokenUsage {
  if (!Object.keys(baseline).length) return total;
  const own: TokenUsage = {};
  for (const [key, value] of Object.entries(total)) {
    if (typeof value !== 'number') continue;
    own[key as keyof TokenUsage] = Math.max(0, value - (baseline[key as keyof TokenUsage] ?? 0));
  }
  return own;
}

/** Component-wise `a + b`: a resumed row's `usage_baseline` (the thread total at its own resume) plus its own persisted turns give the thread total it left, which is what the next continuation resumes above. */
function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (typeof value !== 'number') continue;
    out[key as keyof TokenUsage] = (out[key as keyof TokenUsage] ?? 0) + value;
  }
  return out;
}

export class SessionManager {
  private live = new Map<string, Live>();

  /** `logDir` holds one `<session id>.log` (and `.log.err`) per session: the harness process's stdio, tailed by this daemon and by the next one. `prices` is the models.dev catalog the API-equivalent estimate is read from; without one, every session records `unknown`. */
  constructor(private db: Db, private adapters: Partial<Record<HarnessName, HarnessAdapter>>, private bus: Bus, private logDir: string, private prices?: PriceSource) {}

  /**
   * The reported cost stays on `cost`; the catalog estimate is written beside it, and `cost_source` says which figure the
   * session has. `usage` is the session's own cumulative counters, which for a resumed codex session already exclude the
   * thread's earlier turns (see `addUsage`). The estimate is recomputed from those counters, never accumulated per turn: the
   * per-million prices are linear, so pricing the totals once is the same as pricing every turn and summing, and it cannot
   * double count a harness that reports a running total (Codex). This is the whole-session path for Claude and codex;
   * opencode, which reports one usage per model response, is priced per response at the tier each response's own input
   * selects (`estimateRequests`), because a session mixes responses above and below a context tier.
   */
  private priced(harness: HarnessName, model: string | null, reported: number | null, usage: TokenUsage): { estimated_cost: number | null; cost_source: CostSource } {
    const price = model ? this.prices?.priceFor(harness, model) ?? null : null;
    // Codex's `input_tokens` already includes its cached and cache-write input, so pricing the whole input plus the cache
    // counters would charge the cached slice twice; opencode reports reasoning as its own counter, outside `output`.
    const estimated = price ? estimateCost(price, usage, { inputIncludesCacheTokens: harness === 'codex', billReasoning: harness === 'opencode' }) : null;
    return { estimated_cost: estimated, cost_source: costSource(reported, estimated) };
  }

  /**
   * Prices one turn's model responses (opencode's `step_finish`, one per response) and returns their sum. Each response is
   * billed at the context tier its own raw input selects (`selectContextPrice`), which is opencode's own rule; the
   * per-response counters are that response's own, so the sum is comparable to the CLI's per-step `cost`. Returns null when
   * the model is not in the catalog or no response carried counters.
   */
  private estimateRequests(harness: HarnessName, model: string | null, requests: TokenUsage[]): number | null {
    const price = model ? this.prices?.priceFor(harness, model) ?? null : null;
    if (!price) return null;
    let total = 0;
    let priced = false;
    for (const request of requests) {
      // opencode's tier is selected from the response's raw input, which includes the cached slices its `input` excludes.
      const rawInput = (request.input ?? 0) + (request.cacheRead ?? 0) + (request.cacheWrite ?? 0);
      const cost = estimateCost(selectContextPrice(price, rawInput), request, { billReasoning: harness === 'opencode' });
      if (cost !== null) { total += cost; priced = true; }
    }
    return priced ? total : null;
  }

  /**
   * Folds one `turn_end`'s token counters into the session's totals. Codex's `turn.completed.usage` is the thread's running
   * total, not that turn's own usage (a 3-turn session's counters are monotonic: 2.04M, 3.23M, 4.74M input, while only
   * 4.74M was ever sent), so it replaces the counters; a resumed session subtracts the thread counters it resumed above
   * (`baseline`), so the counters stored on its row are its own turns and sum with the earlier session's rather than
   * counting the thread twice. Claude and opencode report one turn's own usage, which is added.
   */
  private addUsage(target: TokenUsage, turnUsage: TokenUsage, harness: HarnessName, baseline: TokenUsage = {}): TokenUsage {
    if (!Object.keys(turnUsage).length) return target;
    if (harness === 'codex') return ownUsage({ ...turnUsage }, baseline);
    const next = { ...target };
    for (const [key, value] of Object.entries(turnUsage)) next[key as keyof TokenUsage] = (next[key as keyof TokenUsage] ?? 0) + value;
    return next;
  }

  start(o: StartSessionOpts): SessionRow {
    const adapter = this.adapters[o.harness];
    if (!adapter) throw new Error(`harness ${o.harness} is not available`);
    const id = randomUUID();
    // A continuation resumes the thread the previous worker session left off; record where that thread stood so this row is
    // priced from its own turns. Only codex reports a running thread total, and only it needs the baseline. The resumed row
    // stores its own turns (`persistedUsage`) above the thread total it started from (`usage_baseline`), so their sum is the
    // thread total this session resumes above.
    const resumed = o.harness === 'codex' && o.resumeId && o.beadId
      ? this.db.sessions.forBead(o.beadId).filter((s) => s.role === 'worker' && s.native_session_id === o.resumeId).at(-1)
      : undefined;
    const baseline = resumed ? sumUsage(persistedBaseline(resumed), persistedUsage(resumed)) : {};
    const row: SessionRow = {
      id, harness: o.harness, role: o.role, bead_id: o.beadId ?? null, repo_id: o.repoId ?? null,
      native_session_id: o.resumeId ?? null, pid: null, pid_started_at: null, start_commit: o.startCommit ?? null,
      cwd: o.cwd, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null,
      resolved_model: null, usage_baseline: Object.keys(baseline).length ? JSON.stringify(baseline) : null,
      batch_id: o.batchId ?? null, log_path: path.join(this.logDir, `${id}.log`), log_offset: 0, verify_only: o.verifyOnly ? 1 : 0, needs_server: o.needsServer ? 1 : 0, tier: o.tier ?? null, model: o.recordedModel ?? o.model ?? null, account: o.account ?? null,
      token_expires_at: o.tokenExpiresAt ?? null, auth_resumed: o.authResumed ? 1 : null, harness_forced: o.harnessForced ? 1 : null,
      bead_title: o.beadTitle ?? null, discussion_id: o.discussionId ?? null, discussion_kind: o.discussionKind ?? null,
    };
    this.db.sessions.insert(row);
    let handle: SessionHandle;
    try {
      // Every MCP server is handed to the harness on this session's own URL, so a tool call carries a caller identity:
      // `start_server` has to know whose session it is starting a process for, and no harness lets us set a header.
      const mcpServers = o.mcpServers?.map((m) => ({ ...m, url: `${m.url.replace(/\/$/, '')}/${row.id}` }));
      handle = adapter.start({ role: o.role, cwd: o.cwd, prompt: o.prompt, systemPromptFile: o.systemPromptFile, mcpServers, resumeId: o.resumeId, denyBackground: o.denyBackground, evalSandbox: o.evalSandbox, tools: o.tools, strictMcpConfig: o.strictMcpConfig, maxBudgetUsd: o.maxBudgetUsd, noSessionPersistence: o.noSessionPersistence, model: o.model, effort: o.effort, logFile: row.log_path!, onLogOffset: this.offsetWriter(row.id), env: o.env });
    } catch (err) {
      // A spawn that throws (spawn ENAMETOOLONG, overseer-gg1 2026-09-15) must not leave the row 'running': that blocked every
      // re-dispatch of the bead until a daemon restart. Ended like `finish` does, so `worker_status` reports the reason.
      const reason = err instanceof Error ? err.message : String(err);
      this.db.sessions.update(row.id, { status: 'failed', ended_at: new Date().toISOString(), pid: null, end_reason: `could not start: ${reason}` });
      if (row.account) clearAccountUsageCacheForAccount(row.account);
      this.bus.emit('board');
      throw err;
    }
    // The pid is on the row before anything else happens: a daemon that dies right after the spawn can still adopt the process.
    if (handle.pid) { row.pid = handle.pid; this.db.sessions.update(row.id, { pid: handle.pid }); }
    // A harness that picks the native id itself (claude's `--session-id`) has one before any turn ends: recorded now, so a worker's
    // first turn rejected on its login, which may end without a `turn_end`, can still be resumed by that id. Only a worker or critic
    // records it, the roles the auth resume resumes; the orchestrator's resume reads the id a completed `turn_end` recorded, and a
    // process that died before its first turn saved no transcript, so resuming its spawn id would fail with "no conversation found"
    // on every message until the user pressed New session.
    if (!o.resumeId && handle.nativeId && (o.role === 'worker' || o.role === 'critic')) { row.native_session_id = handle.nativeId; this.db.sessions.update(row.id, { native_session_id: handle.nativeId }); }
    this.watch(row.id, adapter, handle, !!o.keepAlive, { baseline });
    // After the process is up and watched: the office feed draws a character from this, and an `adopt` after a restart is seeded from the row instead.
    this.bus.emit('session:started', row);
    return row;
  }

  /** Picks up a session whose process outlived the previous daemon: its log is followed from the recorded offset and it ends like any other. */
  adopt(row: SessionRow): void {
    const adapter = this.adapters[row.harness];
    if (!adapter) throw new Error(`harness ${row.harness} is not available`);
    if (!row.pid || !row.log_path) throw new Error(`session ${row.id} has no pid or log to adopt`);
    const account = row.account ? this.db.accounts.get(row.account) : undefined;
    const handle = adapter.adopt({ pid: row.pid, cwd: row.cwd, logFile: row.log_path, logOffset: row.log_offset, nativeSessionId: row.native_session_id, onLogOffset: this.offsetWriter(row.id), env: accountEnv(account) });
    // The log is followed from the persisted offset, so an `auth_failed` consumed before the restart is never replayed: seed the
    // structured signal from the record so a session that then exits without a `turn_end` is still resumed, not read as a crash.
    this.watch(row.id, adapter, handle, false, { usage: persistedUsage(row), baseline: persistedBaseline(row), resolvedModel: row.resolved_model ?? null, cost: row.cost, estimate: row.harness === 'opencode' ? row.estimated_cost ?? null : null, authFailed: this.recordedAuthFailed(row.id) });
  }

  /**
   * Whether a session's stream already carried the structured auth signal (`auth_failed`, or a `turn_end` with `authFailed`).
   * Read from the recorded events, the only trace an `auth_failed` leaves on an adopted process whose later turns are gone.
   */
  private recordedAuthFailed(sessionId: string): boolean {
    return this.db.events.forSession(sessionId).some((ev) =>
      ev.type === 'auth_failed' || (ev.type === 'turn_end' && (ev.payload as { authFailed?: boolean }).authFailed === true));
  }

  private offsetWriter(id: string): (offset: number) => void {
    let last = -1;
    return (offset) => {
      if (offset === last) return;
      try {
        this.db.sessions.update(id, { log_offset: offset });
        last = offset;
      } catch (err) {
        log.error(`sessions: could not persist log offset for ${id}`, err);
      }
    };
  }

  private watch(id: string, adapter: HarnessAdapter, handle: SessionHandle, keepAlive: boolean, seed: LiveSeed = {}): void {
    const live: Live = { adapter, handle, keepAlive, queued: 0, lastText: null, lastError: null, errorSinceTurn: false, authFailed: seed.authFailed ?? false, stopped: false, ended: false, files: new Set(), cost: seed.cost ?? null, usage: seed.usage ?? {}, baseline: seed.baseline ?? {}, resolvedModel: seed.resolvedModel ?? null, estimate: seed.estimate ?? null };
    this.live.set(id, live);
    this.consume(id, live).catch((err) => {
      log.error(`sessions: event consumer for ${id} failed`, err);
      live.lastError = `event stream failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.live.has(id)) {
        try { this.finish(id, live, 'failed'); }
        catch (finishErr) { log.error(`sessions: could not mark ${id} failed`, finishErr); }
      }
    });
    this.bus.emit('board');
  }

  handleOf(id: string): SessionHandle | undefined { return this.live.get(id)?.handle; }
  isLive(id: string): boolean { return this.live.has(id); }

  async send(id: string, text: string): Promise<void> {
    const l = this.must(id);
    l.queued++;
    // Recorded before the send so a sweep landing right after sees a live session, not a stale turn end (round 2 review).
    this.bus.emit('event', this.db.events.append(id, 'message', { type: 'message', text }));
    await l.adapter.send(l.handle, text);
  }

  /** `stop` names who asked; it is recorded as an `interrupt` event, so a trace says the session was stopped, not that it exited (round 13). `stalled` marks a stop that followed the stall notice, so an automatic re-dispatch can avoid that harness. */
  async interrupt(id: string, stop?: SessionStop): Promise<void> {
    const l = this.must(id);
    l.stopped = true; // before the signal: the death it causes must not be read as a failure, whichever is observed first
    if (stop) l.stop = stop; // and with it who asked, so the session-end event carries the stop even when the death wins the race
    try { await l.adapter.interrupt(l.handle); }
    catch (err) { l.stopped = false; l.stop = undefined; throw err; } // the signal never went out, so the session is still its own
    // Recorded once the signal went out: a stop that failed to reach the process must not make its trace end with "stopped by" (fix round 13 review).
    if (stop) this.bus.emit('event', this.db.events.append(id, 'interrupt', { type: 'interrupt', by: stop.by, ...(stop.reason ? { reason: stop.reason } : {}), ...(stop.stalled ? { stalled: true } : {}) }));
    await this.endHandle(l);
  }

  async end(id: string): Promise<void> { const l = this.live.get(id); if (l) await this.endHandle(l); }

  /**
   * Ends the adapter's handle at most once. A stop or an idle end can be followed by a late `turn_end` still buffered on the
   * stream, and every adapter throws on a handle it no longer holds; ending an already-ended session is a no-op, so that late
   * event settles the session as it was ended rather than marking it failed. A genuinely unknown session id elsewhere still errors.
   */
  private async endHandle(l: Live): Promise<void> {
    if (l.ended) return;
    l.ended = true;
    // An end that throws leaves the session live, so reset the latch: otherwise every later end on it is a no-op and the
    // failed teardown can never be retried (the same reason `interrupt` resets `stopped`).
    try { await l.adapter.end(l.handle); } catch (err) { l.ended = false; throw err; }
  }

  /** `endReason`: why an ended session stopped (harness exit code, SDK error, restart), persisted on the row by `finish`; null while running or after a clean end. */
  status(id: string): { state: SessionRow['status']; lastText: string | null; files: string[]; cost: number | null; endReason: string | null } {
    const row = this.db.sessions.get(id);
    if (!row) throw new Error(`session ${id} not found`);
    const l = this.live.get(id);
    const lastText = l?.lastText ?? row.last_text ?? (this.db.events.lastOfType(id, 'assistant_text')?.payload as { text?: string } | undefined)?.text ?? null;
    const files = l ? [...l.files] : [...new Set(this.db.events.forSession(id).filter((e) => e.type === 'file_change').map((e) => (e.payload as { path: string }).path))];
    return { state: row.status, lastText, files, cost: row.cost, endReason: row.end_reason ?? null };
  }

  private async consume(id: string, l: Live): Promise<void> {
    for await (const ev of l.adapter.events(l.handle)) {
      const stored = capToolResult(ev);
      this.bus.emit('event', this.db.events.append(id, stored.type, stored));
      switch (ev.type) {
        case 'process_start': this.db.sessions.update(id, { pid: ev.pid, pid_started_at: ev.pidStartedAt }); break;
        case 'assistant_text': if (!ev.parentId) l.lastText = ev.text; break; // a sub-agent's text is not the session's final message
        case 'file_change': l.files.add(ev.path); break;
        case 'context':
          // Persisted as it resolves: an adopted session that emits no further context event still prices from the real id.
          // `<synthetic>` is not a model, so it leaves whatever the real id was rather than overwriting it.
          if (ev.model !== SYNTHETIC_MODEL && l.resolvedModel !== ev.model) {
            l.resolvedModel = ev.model;
            this.db.sessions.update(id, { resolved_model: ev.model });
          }
          break;
        case 'error': l.lastError = ev.message; l.errorSinceTurn = true; break;
        case 'auth_failed': l.authFailed = true; break;
        case 'turn_end': {
          l.errorSinceTurn = false;
          if (ev.authFailed) l.authFailed = true;
          if (ev.cost !== undefined) l.cost = ev.cost;
          const turnUsage: TokenUsage = {};
          for (const [key, value] of Object.entries(ev.usage ?? {})) {
            if (typeof value !== 'number') continue;
            turnUsage[key as keyof TokenUsage] = value;
          }
          const row = this.db.sessions.get(id);
          if (row) {
            l.usage = this.addUsage(l.usage, turnUsage, row.harness, l.baseline);
            const model = l.resolvedModel ?? row.resolved_model ?? row.model;
            if (ev.requests?.length) {
              const turnEstimate = this.estimateRequests(row.harness, model, ev.requests);
              if (turnEstimate !== null) l.estimate = (l.estimate ?? 0) + turnEstimate;
            } else if (row.harness === 'opencode' && Object.keys(turnUsage).length) {
              // A turn that reported usage without per-response counters cannot be tiered; fall back to the whole-session base price.
              l.estimate = null;
            }
            const estimate = l.estimate !== null
              ? { estimated_cost: l.estimate, cost_source: costSource(l.cost, l.estimate) }
              : this.priced(row.harness, model, l.cost, l.usage);
            this.db.sessions.update(id, { native_session_id: ev.nativeSessionId, cost: l.cost,
              ...(l.usage.input !== undefined ? { input_tokens: l.usage.input } : {}), ...(l.usage.output !== undefined ? { output_tokens: l.usage.output } : {}),
              ...(l.usage.cacheRead !== undefined ? { cache_read_tokens: l.usage.cacheRead } : {}), ...(l.usage.cacheWrite !== undefined ? { cache_write_tokens: l.usage.cacheWrite } : {}),
              ...(l.usage.cacheWrite1h !== undefined ? { cache_write_1h_tokens: l.usage.cacheWrite1h } : {}),
              ...(l.usage.reasoning !== undefined ? { reasoning_tokens: l.usage.reasoning } : {}),
              ...estimate });
          }
          if (!l.keepAlive) { if (l.queued > 0) l.queued--; else await this.endHandle(l); }
          break;
        }
        default: break;
      }
    }
    this.finish(id, l, l.errorSinceTurn && !l.stopped ? 'failed' : 'ended');
  }

  private finish(id: string, l: Live, status: 'ended' | 'failed'): void {
    if (l.stopped) status = 'ended'; // a stop is recorded as a stop on every end path, not only the one that wins the race
    // The last text and the exit reason go on the row here, on every exit path: a process that died mid-turn never reaches
    // `turn_end`, so `worker_status` otherwise had nothing to say about why (overseer-xen, 2026-09-14). An opencode session
    // keeps the per-response estimate accumulated from its turns; Claude and codex are re-derived from the row's cumulative
    // tokens, so an adopted session whose catalog loaded after the daemon restart, or an exit that never reached `turn_end`,
    // still gets one, and a turn-priced session re-derives to the same figure.
    const row = this.db.sessions.get(id);
    const patch: Partial<SessionRow> = { status, ended_at: new Date().toISOString(), pid: null, last_text: l.lastText, end_reason: l.lastError };
    if (row) {
      if (l.estimate !== null) {
        Object.assign(patch, { estimated_cost: l.estimate, cost_source: costSource(row.cost, l.estimate) });
      } else {
        const priced = this.priced(row.harness, l.resolvedModel ?? row.resolved_model ?? row.model, row.cost, persistedUsage(row));
        // An adopted session whose resolved id was never persisted must not downgrade an estimate a previous daemon already wrote.
        if (priced.estimated_cost !== null || row.estimated_cost === null || row.estimated_cost === undefined) Object.assign(patch, priced);
      }
    }
    this.db.sessions.update(id, patch);
    this.live.delete(id);
    const session = this.db.sessions.get(id)!;
    if (session.account) clearAccountUsageCacheForAccount(session.account);
    this.bus.emit('session:ended', { session, lastText: l.lastText, lastError: l.lastError, files: [...l.files], ...(l.authFailed ? { authFailed: true } : {}), ...(l.stop ? { stop: l.stop } : {}) });
    this.bus.emit('board');
  }

  private must(id: string): Live {
    const l = this.live.get(id);
    if (!l) throw new Error(`session ${id} is not running`);
    return l;
  }
}
