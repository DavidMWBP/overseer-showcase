import type { OfficeSession, OfficeState, SessionRow } from '@overseer/shared';
import type { Db } from '../db/db';
import type { Bus } from '../bus';

/**
 * The office view's live feed. It keeps one character per session and publishes an `office` message on every state change,
 * derived from the session and lifecycle events the daemon already emits; no hook and no second process is involved. It
 * also re-sends a character when its harness resolves the model for its main thread, so a label that started without one
 * shows the model the session actually runs. A socket that connects mid-run is handed the current set (see `snapshot`),
 * the way `orchestrator_activity` is resent.
 *
 * What it can and cannot show: a session walks in when it starts, types while it records a tool call, and leaves when it ends;
 * a bead's verification is a character at the printer for as long as the command runs; a critic session reviews. A stalled
 * session keeps its pose and carries a `stalled_since` mark the sweep sets through `setStalled` and the session's next event
 * clears, so the web can draw the stalled look from it; a usage-limit pause publishes nothing, since the limit is held on the
 * account and not the session.
 */
export class Office {
  private characters = new Map<string, OfficeSession>();

  constructor(private db: Db, private bus: Bus) {
    // Sessions already running (a daemon that just restarted and adopted workers) are drawn without a `session:started`.
    // A discussion participant is not an office character: the discussion page shows it, not the floor.
    for (const session of db.sessions.running()) if (session.role !== 'discussion') this.characters.set(session.id, { ...this.base(session), state: this.initialState(session) });
    bus.on('session:started', (session) => { if (session.role !== 'discussion') this.emit({ ...this.base(session), state: this.initialState(session) }); });
    bus.on('event', (event) => {
      let character = this.characters.get(event.session_id);
      if (!character) return;
      // Any recorded event is a sign of life: clear a stall mark (and publish the clear) before applying the event itself.
      if (character.stalled_since !== null) {
        character = { ...character, stalled_since: null };
        this.emit(character);
      }
      // The harness reports the model it resolved for its main thread on a `context` event; re-send the character so a
      // label drawn without one (a forced harness or the orchestrator before it reported) picks it up.
      if (event.type === 'context') {
        const model = (event.payload as { model?: string } | null)?.model;
        if (model && model !== character.resolved_model) this.emit({ ...character, resolved_model: model });
        return;
      }
      // A critic reads the diff with tools: moving it to `working` here would erase `reviewing` at its first call.
      if (event.type !== 'tool_call') return;
      if (character.role === 'critic') return;
      this.set(event.session_id, 'working');
    });
    bus.on('session:ended', (e) => this.leave(e.session.id));
    bus.on('session:reaped', (session) => this.leave(session.id));
    bus.on('bead:verify', ({ bead_id, status }) => {
      if (status === 'running') this.verifying(bead_id);
      else this.leaveForBead(bead_id);
    });
  }

  /**
   * Every character the office is showing right now, for a socket that just connected. Reconciled against the sessions
   * actually running first: recovery marks a lost session's row `ended` without the `session:ended` bus event (only
   * `SessionManager.finish` emits it), so a character seeded at startup can outlive its session, and a session that
   * appeared without its own `session:started` is drawn too.
   */
  snapshot(): OfficeSession[] {
    for (const [id, character] of this.characters) {
      if (character.state === 'verifying') continue; // a verification runs between sessions: its row is already ended
      if (this.db.sessions.get(id)?.status !== 'running') this.characters.delete(id);
    }
    for (const session of this.db.sessions.running()) {
      if (session.role === 'discussion') continue;
      if (!this.characters.has(session.id)) this.characters.set(session.id, { ...this.base(session), state: this.initialState(session) });
    }
    return [...this.characters.values()];
  }

  /** A critic is reviewing; every other role walks in and sits at its desk. */
  private initialState(session: SessionRow): OfficeState { return session.role === 'critic' ? 'reviewing' : 'walking_in'; }

  /**
   * The stall sweep reports the sessions it currently finds stalled, on every pass. A named session that is not yet marked
   * gets the current time as its `stalled_since` and is published; a marked session the sweep no longer names has its mark
   * cleared and is published again. A session already in the named state is left alone, so repeated sweeps publish nothing.
   */
  setStalled(ids: string[]): void {
    const now = new Date().toISOString();
    const stalled = new Set(ids);
    for (const [id, character] of [...this.characters]) {
      if (stalled.has(id)) {
        if (character.stalled_since === null) this.emit({ ...character, stalled_since: now });
      } else if (character.stalled_since !== null) {
        this.emit({ ...character, stalled_since: null });
      }
    }
  }

  /** The verification of a bead runs after its worker session ended: its character comes back for the printer. */
  private verifying(beadId: string): void {
    const session = this.lastWorker(beadId);
    if (!session) return;
    this.emit({ ...this.base(session), state: 'verifying' });
  }

  private leaveForBead(beadId: string): void {
    const session = this.lastWorker(beadId);
    if (session) this.leave(session.id);
  }

  /** The worker that produced the change, never the critic that reviewed it: a retry's verification belongs to the worker. */
  private lastWorker(beadId: string): SessionRow | undefined {
    return this.db.sessions.forBead(beadId).filter((s) => s.role === 'worker').at(-1);
  }

  private leave(sessionId: string): void {
    const current = this.characters.get(sessionId);
    if (!current) return;
    this.emit({ ...current, state: 'leaving' });
    this.characters.delete(sessionId);
  }

  private set(sessionId: string, state: OfficeState): void {
    const current = this.characters.get(sessionId);
    if (!current || current.state === state) return;
    this.emit({ ...current, state });
  }

  private emit(session: OfficeSession): void {
    this.characters.set(session.session_id, session);
    this.bus.emit('office', session);
  }

  private base(session: SessionRow): Omit<OfficeSession, 'state'> {
    const account = session.account ? this.db.accounts.get(session.account) : undefined;
    return {
      session_id: session.id,
      role: session.role,
      harness: session.harness,
      model: session.model,
      resolved_model: session.resolved_model ?? null,
      account_label: account?.label ?? null,
      bead_id: session.bead_id,
      bead_title: session.bead_title ?? null,
      batch_id: session.batch_id,
      repo_id: session.repo_id,
      stalled_since: null,
    };
  }
}
