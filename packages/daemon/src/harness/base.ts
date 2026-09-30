import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HarnessName } from '@overseer/shared';
import { EventQueue } from '../util/queue';
import { log } from '../util/log';
import { adoptLines, processStartTime, killProcess, sweepProcessTree, type LineProcess } from '../util/procs';
import type { AdoptOpts, HarnessAdapter, HarnessEvent, SessionHandle, StartOpts } from './types';

type TurnEnd = Extract<HarnessEvent, { type: 'turn_end' }>;

/** One harness session's state: its event queue, the CLI process it follows and whether it is ending. */
export abstract class HarnessSession {
  readonly queue = new EventQueue<HarnessEvent>();
  protected proc: LineProcess | null = null;
  /** When the current CLI process started (ms), the `notBefore` bound for `killProcess`'s descendant walk. */
  protected startedAt?: number;
  protected ending = false;
  /**
   * The session id the CLI itself was given at spawn, when the adapter chose it (claude's `--session-id`); undefined for
   * the harnesses that report one only at turn end. Carried on the handle so a session whose first turn is rejected on its
   * login, ending without a `turn_end`, is still resumable by that id.
   */
  readonly nativeId?: string;

  /** `labelFallback` names the session in a warning when it has no log file. */
  constructor(protected readonly logFile: string | undefined, private readonly labelFallback: string, protected readonly pollMs?: number) {}

  get pid(): number | undefined { return this.proc?.pid; }

  /**
   * The identifier an operator can correlate: the log file is `<dataDir>/sessions/<session id>.log`, so its base name is
   * the daemon's session row id. The adapter's handle id never reaches the database or the log.
   */
  protected sessionLabel(): string {
    return this.logFile ? path.basename(this.logFile, '.log') : this.labelFallback;
  }

  abstract send(text: string): void;
  abstract interrupt(): Promise<void>;
  abstract end(): Promise<void>;
  protected abstract pump(p: LineProcess, adopted: boolean): Promise<void>;

  /** Follows a process an earlier daemon started, from the log offset it had reached. */
  adopt(o: AdoptOpts): void {
    this.follow(adoptLines({ pid: o.pid, logFile: o.logFile, offset: o.logOffset, pollMs: this.pollMs }), true);
  }

  protected follow(p: LineProcess, adopted: boolean): void {
    this.proc = p;
    void this.pump(p, adopted);
  }

  /** Waits for the CLI's pid and start time, dates `startedAt` from them and reports a spawned process as `process_start`. */
  protected async processStarted(p: LineProcess, adopted: boolean): Promise<{ pid: number | undefined; pidStartedAt: string | null; spawnedAt: number }> {
    const spawnedAt = Date.now(); // before the lookup: a CLI that exits during it must not date from after its children
    this.startedAt = spawnedAt;
    const pid = await (p.pidReady ?? p.pid);
    const pidStartedAt = pid ? await processStartTime(pid) : null;
    this.startedAt = pidStartedAt ? Date.parse(pidStartedAt) : spawnedAt;
    if (pid && !adopted) this.queue.push({ type: 'process_start', pid, pidStartedAt });
    return { pid, pidStartedAt, spawnedAt };
  }
}

/** A session that runs one CLI process per turn (codex, opencode): a message sent during a turn waits for the next one. */
export abstract class TurnSession extends HarnessSession {
  protected abstract readonly harness: HarnessName;
  private pending: string[] = [];

  protected abstract runTurn(text: string): void;

  send(text: string): void {
    if (this.proc) { this.pending.push(text); return; }
    this.runTurn(text);
  }

  /** Reports the turn's end, then closes the queue when the session is ending or starts the next waiting message. */
  protected finishTurn(turnEnd: TurnEnd): void {
    this.queue.push(turnEnd);
    if (this.ending) { this.queue.close(); return; }
    const next = this.pending.shift();
    if (next !== undefined) this.runTurn(next);
  }

  async end(): Promise<void> {
    this.ending = true;
    this.pending = [];
    if (!this.proc) this.queue.close();
    else await this.proc.exit;
  }

  async interrupt(): Promise<void> {
    const pid = this.proc?.pid;
    if (pid) await killProcess(pid, this.startedAt);
    // The same sweep as a turn end, now that the CLI is gone: an orphan behind exited intermediates holds both session
    // logs and a parent-pid walk from the CLI cannot reach it, so an interrupted worker otherwise leaves it running.
    // Detached like the turn-end sweep: a stop must not wait on the PowerShell queries, and `abandonBatch` stops every
    // running session one after another.
    if (this.startedAt !== undefined) {
      void sweepProcessTree({ pid, startedAt: this.startedAt, logFile: this.logFile, label: `${this.harness} session ${this.sessionLabel()} (pid ${pid}) was interrupted` })
        .catch((err) => log.error(`${this.harness}: orphan sweep at interrupt failed`, err));
    }
  }
}

/** The handle map every adapter shares; an adapter only builds its sessions. */
export abstract class BaseAdapter<S extends HarnessSession> implements HarnessAdapter {
  abstract readonly name: HarnessName;
  private sessions = new Map<string, S>();

  /** A session for a fresh start; `id` is the handle's id. */
  protected abstract create(id: string, opts: StartOpts): S;
  /** A session that follows a process an earlier daemon started. */
  protected abstract createAdopted(id: string, o: AdoptOpts): S;

  start(opts: StartOpts): SessionHandle {
    const id = randomUUID();
    const s = this.create(id, opts);
    this.sessions.set(id, s);
    s.send(opts.prompt);
    return { id, pid: s.pid, ...(s.nativeId ? { nativeId: s.nativeId } : {}) };
  }
  adopt(o: AdoptOpts): SessionHandle {
    const id = randomUUID();
    const s = this.createAdopted(id, o);
    this.sessions.set(id, s);
    s.adopt(o);
    return { id, pid: o.pid, ...(s.nativeId ? { nativeId: s.nativeId } : {}) };
  }
  async send(h: SessionHandle, text: string): Promise<void> { this.get(h).send(text); }
  async interrupt(h: SessionHandle): Promise<void> { await this.get(h).interrupt(); }
  // The handle is dropped only once the session's end succeeded, so a failed end can be retried on the same handle.
  async end(h: SessionHandle): Promise<void> { await this.get(h).end(); this.sessions.delete(h.id); }
  events(h: SessionHandle): AsyncIterable<HarnessEvent> { return this.get(h).queue; }
  private get(h: SessionHandle): S {
    const s = this.sessions.get(h.id);
    if (!s) throw new Error(`${this.name} session ${h.id} not found`);
    return s;
  }
}
