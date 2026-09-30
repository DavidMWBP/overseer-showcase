import type { Db } from '../db/db';
import { log } from '../util/log';

export interface IdleEndDeps {
  db: Db;
  /** Milliseconds of silence after a turn end with a non-empty final message before the session is ended; 0 disables the sweep. */
  idleEndMs: number;
  end: (sessionId: string) => Promise<void>;
}

/**
 * One pass: a worker whose latest event is a `turn_end` carrying a non-empty final message, and which has stayed silent
 * since past the threshold, is ended the way a clean end is handled — the harness already finished its turn and is only
 * idling because the session was left open for a further message that never came. A session whose latest event is
 * anything else (mid-turn, or already past this rule once new activity arrived) is left alone; the stall sweep still
 * covers a session that never reached a turn end.
 */
export async function sweepIdleEnds(deps: IdleEndDeps): Promise<void> {
  const { db, idleEndMs, end } = deps;
  if (idleEndMs <= 0) return;
  const now = Date.now();
  const running = db.sessions.running().filter((s) => s.role === 'worker');
  for (const s of running) {
    const last = db.events.last(s.id);
    if (!last || last.type !== 'turn_end') continue;
    const previousTurn = db.events.lastOfTypeBefore(s.id, 'turn_end', last.seq);
    const text = (db.events.lastOfTypeAfter(s.id, 'assistant_text', previousTurn?.seq ?? 0)?.payload as { text?: string } | undefined)?.text?.trim();
    if (!text) continue;
    if (now - Date.parse(last.ts) < idleEndMs) continue;
    await end(s.id).catch((err) => log.error(`idle-end: ending ${s.id} failed`, err));
  }
}

/** Starts the sweep; returns the stop function, or null when the threshold is 0 and nothing runs. */
export function startIdleEndSweep(deps: IdleEndDeps, sweepMs: number): (() => void) | null {
  if (deps.idleEndMs <= 0) return null;
  const timer = setInterval(() => { void sweepIdleEnds(deps).catch((err) => log.error('idle-end: sweep failed', err)); }, sweepMs);
  timer.unref();
  return () => clearInterval(timer);
}
