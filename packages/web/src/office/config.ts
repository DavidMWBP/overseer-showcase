/**
 * Character art per session role. The spike's Dunder Mifflin cast map is dropped: only the default theme is ported.
 * The orchestrator and a critic each get one recognisable sprite; workers pick from a pool by a stable hash of the session id.
 */
const ORCHESTRATOR_CHAR = 'Me-1';
const CRITIC_CHAR = 'security-audit-1';
const WORKER_CHARS = ['dev-1', 'dev-2', 'employee-1', 'employee-2', 'employee-3', 'Frontend-dev-1', 'Claude-1'];

/** Stable per session, so the same character is drawn on every render and across a socket burst. */
export function charFor(role: string, sessionId: string): string {
  if (role === 'orchestrator') return ORCHESTRATOR_CHAR;
  if (role === 'critic') return CRITIC_CHAR;
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  return WORKER_CHARS[Math.abs(hash) % WORKER_CHARS.length]!;
}

/**
 * The label under a character: harness, model and the bead id (or the role when the session has no bead, e.g. the orchestrator).
 * The model segment is the one the session is actually running - the id the harness resolved once it reported one, else the
 * configured model - and is left out entirely when neither is known, rather than naming a model that was never set.
 */
export function agentLabel(session: { harness: string; model: string | null; resolved_model?: string | null; bead_id: string | null; role: string }): string {
  const model = session.resolved_model ?? session.model;
  return [session.harness, ...(model ? [model] : []), session.bead_id ?? session.role].join(' · ');
}

/** `?capture=1` in the page URL: the room is drawn for stills, without the name labels or phone badges over the characters. */
export function captureMode(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('capture') === '1';
}

/** The local HH:MM a stall mark carries, appended to a stalled character's tooltip and accessible name. */
export function stalledAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
