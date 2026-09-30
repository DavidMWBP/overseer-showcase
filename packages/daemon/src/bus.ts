import { EventEmitter } from 'node:events';
import type { ActionResult, EventRow, OfficeSession, OrchestratorActivity, SessionRow, WsMessage } from '@overseer/shared';

type OfficeMilestone = Omit<Extract<WsMessage, { type: 'office_milestone' }>, 'type'>;

/** Who asked for a deliberate stop; `stalled` marks a stop that followed the stall notice, so an automatic re-dispatch can avoid that harness. */
export interface SessionStop { by: 'user' | 'orchestrator'; reason?: string; stalled?: boolean }

/**
 * `stop` is set when the session manager was asked to stop this session: the settle reads it there rather than racing the `interrupt` event it writes after the signal.
 * `authFailed` is set when the session's stream carried the structured auth signal (claude's `auth_failed` event, or a `turn_end` with `authFailed`): the
 * only thing that may park an account or resume it. A 401 quoted in the session's own text is deliberately not one.
 */
export interface SessionEnded { session: SessionRow; lastText: string | null; lastError: string | null; files: string[]; stop?: SessionStop; authFailed?: boolean }

export interface BusEvents {
  event: [EventRow];
  board: [];
  chat: [];
  status: [];
  repos: [];
  'session:started': [SessionRow];
  'session:ended': [SessionEnded];
  /** A lost session recovery marked `ended` without the manager's `finish`; the office feed leaves it, so a socket that connected during recovery still gets the leave. */
  'session:reaped': [SessionRow];
  'orchestrator:activity': [OrchestratorActivity];
  /** A bead's verification started (`running`) or finished (`pass`/`fail`): the office feed's printer, with no session of its own. */
  'bead:verify': [{ bead_id: string; status: 'running' | 'pass' | 'fail' }];
  /** A character's office state changed; the live per-session update (the whole set travels as one `office_snapshot` on connect). */
  office: [OfficeSession];
  /** A one-shot Office event; unlike the office state, it is not replayed to later sockets. */
  office_milestone: [OfficeMilestone];
  /** A background action ended; a `board` refresh follows, and the web shows the success or failure from this. */
  action_result: [ActionResult];
  plans: [];
  /** A discussion was created, recorded a turn or ended: the web refetches the discussions and an open one. */
  discussion: [{ id: string }];
}

export class Bus {
  private em = new EventEmitter();
  on<K extends keyof BusEvents>(name: K, fn: (...a: BusEvents[K]) => void): () => void {
    this.em.on(name, fn as (...a: unknown[]) => void);
    return () => this.em.off(name, fn as (...a: unknown[]) => void);
  }
  once<K extends keyof BusEvents>(name: K, fn: (...a: BusEvents[K]) => void): void { this.em.once(name, fn as (...a: unknown[]) => void); }
  emit<K extends keyof BusEvents>(name: K, ...a: BusEvents[K]): void { this.em.emit(name, ...a); }
}
