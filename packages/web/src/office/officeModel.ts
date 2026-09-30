import type { BoardResponse, OfficeSession } from '@overseer/shared';
import { agentLabel } from './config';
import { assignSpot, createAgent, leaveAgent, returnAgent } from './agentManager';
import type { Agent } from './types';

export interface SceneFrame {
  agents: Agent[];
  props: {
    board: BoardResponse | null;
    /** A session is verifying: the QA wall screen loops its tests-running frames. */
    verifying: boolean;
    hasSnapshot: boolean;
  };
  reducedMotion: boolean;
}

export interface SceneConfig {
  /** The previous frame keeps desk assignments and local movement poses stable across feed updates. */
  previous?: SceneFrame | null;
  /** Keep the last frame intact between socket reconnect and the replacement snapshot. */
  stale?: boolean;
  reducedMotion?: boolean;
}

/** Night share at the browser's local wall-clock time, with a one-hour fade at dusk and dawn. */
export function lightingAt(date: Date): number {
  const minute = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60_000;
  if (minute >= 19 * 60 + 30 && minute < 20 * 60 + 30) return (minute - (19 * 60 + 30)) / 60;
  if (minute >= 6 * 60 + 30 && minute <= 7 * 60 + 30) return ((7 * 60 + 30) - minute) / 60;
  return minute >= 20 * 60 + 30 || minute < 6 * 60 + 30 ? 1 : 0;
}

function reconcile(previousAgents: readonly Agent[], sessions: readonly OfficeSession[]): Agent[] {
  const previous = new Map(previousAgents.map((agent) => [agent.id, agent]));
  const next: Agent[] = [];
  const seen = new Set<string>();

  for (const session of sessions) {
    if (seen.has(session.session_id)) continue;
    seen.add(session.session_id);
    const existing = previous.get(session.session_id);
    if (existing) {
      previous.delete(session.session_id);
      const refreshed: Agent = {
        ...existing,
        role: session.role,
        harness: session.harness,
        model: session.model,
        resolvedModel: session.resolved_model,
        beadId: session.bead_id,
        beadTitle: session.bead_title,
        repoId: session.repo_id,
        batchId: session.batch_id,
        state: session.state,
        labelText: agentLabel(session),
        stalledSince: session.stalled_since,
        stalled: session.stalled_since !== null,
      };
      const base = existing.pose === 'leaving' && session.state !== 'leaving' ? returnAgent(refreshed) : refreshed;
      next.push(session.state === 'leaving' && existing.pose !== 'leaving' ? leaveAgent(base) : base);
      continue;
    }

    if (session.state === 'leaving') continue;
    const taken = new Set(next.map((agent) => agent.assignedSpotId));
    const spot = assignSpot(session.role, taken);
    if (spot) next.push(createAgent(session, spot));
  }

  for (const agent of previous.values()) next.push(agent.pose === 'leaving' ? agent : leaveAgent(agent));
  return next;
}

/** Build the complete, DOM-free scene frame from a feed snapshot and the prior local frame. */
export function deriveScene(feed: readonly OfficeSession[] | null, board: BoardResponse | null, config: SceneConfig = {}): SceneFrame {
  const previous = config.previous ?? null;
  const agents = config.stale === true || feed === null
    ? [...(previous?.agents ?? [])]
    : reconcile(previous?.agents ?? [], feed);
  const verifying = config.stale === true && previous ? previous.props.verifying : feed?.some((session) => session.state === 'verifying') ?? false;
  return {
    agents,
    props: {
      board,
      verifying,
      hasSnapshot: config.stale ? previous?.props.hasSnapshot ?? false : feed !== null,
    },
    reducedMotion: config.reducedMotion ?? previous?.reducedMotion ?? false,
  };
}
