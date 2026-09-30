import { useEffect, useRef, useState } from 'react';
import type { EventRow, SessionStatus } from '@overseer/shared';
import { api } from '../api';
import { PlainText } from './PlainText';
import { Loading } from './Loading';

const MAX = 120;
const clip = (s: string) => {
  const line = s.replace(/\s+/g, ' ').trim();
  if (line.length <= MAX) return line;
  // A cut inside an inline code span would leave its opening backtick to render literally (round 13); the opened span is dropped
  // rather than closed, which holds whatever character the cut lands on (fix round 13 review).
  const cut = line.slice(0, MAX - 1);
  return `${(cut.split('`').length - 1) % 2 === 1 ? cut.replace(/`[^`]*$/, '') : cut}…`;
};
/** Who asked for a stop, as recorded by the daemon's `interrupt` event. Without the place: a user stop comes from the Board's Stop or from Review's Abandon (its reason says which). */
const stoppedBy = (p: Record<string, unknown>) => (p.by === 'orchestrator' ? 'stopped by the orchestrator' : 'stopped by the user');
const short = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

/** One line per event: what a reader scanning a worker's run wants to see before opening the raw event. */
export function summarize(e: EventRow): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'assistant_text': return clip(short(p.text));
    case 'tool_call': return clip(`${short(p.name)} ${short(p.input)}`);
    case 'tool_result': return clip(short(p.output));
    case 'file_change': return clip(short(p.path));
    case 'turn_end': return typeof p.cost === 'number' ? `cost $${p.cost.toFixed(2)}` : '';
    case 'context': return typeof p.tokens === 'number' ? `${p.tokens.toLocaleString()} tokens` : '';
    case 'process_start': return typeof p.pid === 'number' ? `pid ${p.pid}` : '';
    case 'error': return clip(short(p.message));
    case 'interrupt': return clip(`${stoppedBy(p)}${typeof p.reason === 'string' && p.reason ? `: ${p.reason}` : ''}`);
    case 'raw': return clip(short(p.line));
    default: return clip(short(e.payload));
  }
}

/** A collapsed trace row is one line, so the count alone sets the reserved height; four is the median event count of a short worker turn. */
const PLACEHOLDER_ROWS = 4;
/** The collapsed rows the arrived list starts as: same markup, same one-line height, placeholder text. */
function TracePlaceholder() {
  return (
    <>
      {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
        <details key={i}>
          <summary><span className="mono muted">00:00:00</span> <span className="mono">tool_call</span> <span className="muted">One recorded event</span></summary>
        </details>
      ))}
    </>
  );
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString();

interface Props {
  sessionId: string;
  /** The session's status and end time: an ended session gets a closing row, since no event records the exit (round 12). */
  status?: SessionStatus;
  endedAt?: string | null;
  /** A change counter (the board version): while the session runs, each change refetches the list, so an open trace follows a live worker. */
  refresh?: number;
}

/**
 * A session's recorded events, one row each (time, kind, one-line summary) with the raw event behind a disclosure: the
 * JSON endpoint stays for tools, this is for a person (round 11: Trace opened a raw JSON array in a new tab).
 */
export function Trace(p: Props) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = p.status === 'running';
  const refresh = live ? p.refresh ?? 0 : -1; // the last change once the session has ended fetches the final list
  // The load's cursor, kept outside React so a burst of event ticks coalesces: the first fetch takes the whole session,
  // each later one only the events after `seq` (a whole-session refetch per tick grows with the trace's own payloads,
  // which reach megabytes). Each session switch makes a new load object, so a response is applied only to the load that
  // sent it: switching A -> B -> A must not paint A's first response into the second view of A.
  const load = useRef({ session: p.sessionId, seq: 0, full: true });
  // One fetch loop per session, across loads: at most one request per session is in flight, and a tick while one is
  // pending is folded into the loop's next request.
  const loops = useRef(new Map<string, { queued: boolean }>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const session = p.sessionId;
    if (load.current.session !== session) { // a new session starts over: full fetch, nothing carried across
      load.current = { session, seq: 0, full: true };
      setEvents(null);
      setError(null);
    }
    const running = loops.current.get(session);
    if (running) { running.queued = true; return; }
    const loop = { queued: false };
    loops.current.set(session, loop);
    void (async () => {
      for (;;) {
        loop.queued = false;
        const state = load.current;
        if (!alive.current || state.session !== session) break; // the session is no longer shown
        const after = state.full ? undefined : state.seq;
        const url = `/sessions/${session}/events${after === undefined ? '' : `?after=${after}`}`;
        try {
          const rows = await api.get<EventRow[]>(url, { fresh: true });
          if (alive.current && load.current === state) {
            setEvents((prev) => (after === undefined ? rows : [...(prev ?? []), ...rows]));
            state.seq = rows.length ? rows[rows.length - 1]!.seq : state.seq;
            state.full = false;
            setError(null);
          }
        } catch (e) {
          if (alive.current && load.current === state) {
            setError((e as Error).message);
            // A failed delta may have left a gap: take the whole session again at once, keeping the rows on screen, since
            // it may have been an ended session's last change and no later tick would come. A failed full fetch waits for one.
            state.full = true;
            state.seq = 0;
            if (after !== undefined) loop.queued = true;
          }
        }
        if (!loop.queued) break;
      }
      if (loops.current.get(session) === loop) loops.current.delete(session);
    })();
  }, [p.sessionId, refresh]);
  // The closing row: a stop recorded in the events names who asked for it (round 13: a stopped worker's trace read "the process exited").
  const stop = events?.find((e) => e.type === 'interrupt');
  const ended = events !== null && !live && p.status ? { text: stop ? stoppedBy((stop.payload ?? {}) as Record<string, unknown>) : p.status === 'failed' ? 'the session failed' : 'the process exited', at: p.endedAt } : null;
  return (
    <section className="trace" aria-label="Trace">
      <h4>Trace <a className="muted" href={`/api/sessions/${p.sessionId}/events`} target="_blank" rel="noreferrer">raw JSON</a></h4>
      {error && <p className="badge-warn">Could not load the trace: {error}</p>}
      {/* A refetch that failed keeps the rows it has under the warning: only the first fetch, which has nothing to show yet, shimmers (fix round 15 review). */}
      <Loading loading={!error && events === null} label="Loading the trace…" placeholder={<TracePlaceholder />}>
        <>
          {events?.length === 0 && !ended && <p className="muted">No events recorded for this session.</p>}
          {events?.map((e) => (
            <details key={e.id}>
              <summary><span className="mono muted">{fmtTime(e.ts)}</span> <span className="mono">{e.type}</span> <span className="muted"><PlainText text={summarize(e)} /></span></summary>
              <pre>{JSON.stringify(e.payload, null, 2)}</pre>
            </details>
          ))}
        </>
      </Loading>
      {ended && <div className="trace-end">{ended.at && <><span className="mono muted">{fmtTime(ended.at)}</span> </>}<span className="mono">session_end</span> <span className="muted">{ended.text}</span></div>}
    </section>
  );
}
