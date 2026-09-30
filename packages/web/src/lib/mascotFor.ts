import type { OrchestratorActivity, SessionStatus } from '@overseer/shared';
import type { MascotEnergy, MascotState } from '../components/Mascot';

export const MASCOT_CONTEXT_THRESHOLDS = { high: 40, low: 75 } as const;
export const MASCOT_SLEEP_MS = 10 * 60 * 1000;

export interface MascotActivity {
  activity: OrchestratorActivity | null;
  contextPercentage: number | null;
  lastActivityAt: string | null;
  pendingQuestion: boolean;
  sessionLive: boolean;
  sessionStatus?: SessionStatus | 'idle';
  offline: boolean;
}

export interface MascotStatus { state: MascotState; energy: MascotEnergy; label: string }

/** Maps the daemon's chat status to the approved mascot poses without UI state. */
export function mascotFor(activity: MascotActivity, now: number): MascotStatus {
  const context = activity.contextPercentage;
  const energy: MascotEnergy = context !== null && context < MASCOT_CONTEXT_THRESHOLDS.high
    ? 'high'
    : context !== null && context > MASCOT_CONTEXT_THRESHOLDS.low ? 'low' : 'normal';
  const stale = activity.lastActivityAt !== null && now - Date.parse(activity.lastActivityAt) > MASCOT_SLEEP_MS;
  const state: MascotState = activity.offline ? 'offline'
    : activity.sessionStatus === 'failed' ? 'error'
    : activity.pendingQuestion ? 'asking'
    : activity.activity?.state === 'thinking' ? 'thinking'
    : activity.activity?.state === 'tool' ? 'working'
    : !activity.sessionLive || stale ? 'sleeping'
    : 'idle';
  const detail = state === 'working'
    ? activity.activity?.summary || activity.activity?.tool || 'running a tool'
    : state;
  return { state, energy, label: `orchestrator: ${detail}, ${context === null ? 'context unknown' : `context ${context}%`}` };
}
