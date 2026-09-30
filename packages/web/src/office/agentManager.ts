import type { OfficeSession } from '@overseer/shared';
import type { Agent, Position, SpriteDirection } from './types';
import { agentLabel, charFor } from './config';
import { ENTRY, pathBetween, SPOTS, stepToward } from './pixi/world';

/** A spot a character can be assigned to: a desk, a meeting seat or a standing overflow spot. */
export interface AgentSpot {
  id: string;
  type: 'desk';
  x: number;
  y: number;
  spriteFacing?: SpriteDirection;
}

/** The orchestrator's own desk; every other character takes the next free desk in the pool. */
const ORCHESTRATOR_SPOT = 'orch';
/** Walking speed in tiles per frame at 60fps. */
const WALK_SPEED = 0.05;
const DESKS: AgentSpot[] = SPOTS
  .filter((spot) => spot.zone === 'run' || spot.zone === 'orch')
  .map((spot) => ({ id: spot.id, type: 'desk' as const, x: spot.x, y: spot.y, spriteFacing: spot.f }));

/** The meeting table's four seats, where a review session reads. */
const MEETING_SEATS: AgentSpot[] = SPOTS
  .filter((spot) => spot.zone === 'review')
  .map((spot) => ({ id: spot.id, type: 'desk' as const, x: spot.x, y: spot.y, spriteFacing: spot.f }));

/**
 * Where a character goes once the 12 pod desks are taken: the two QA desks, then the coffee machine, the fridge and the
 * sofa (standing spots), then the standing row along the back walls.
 */
const OVERFLOW: AgentSpot[] = [
  ...SPOTS.filter((spot) => spot.zone === 'lab'),
  ...['coffee', 'fridge', 'sofa'].map((id) => SPOTS.find((spot) => spot.id === id)!),
  ...SPOTS.filter((spot) => spot.zone === 'row'),
].map((spot) => ({ id: spot.id, type: 'desk' as const, x: spot.x, y: spot.y, spriteFacing: spot.f }));

/**
 * The orchestrator takes its own desk. A critic takes the first free meeting-table seat; everyone else, and a critic once
 * all four seats are taken, the first free pod desk, then the first free overflow spot, and past the last row spot shares
 * that last one.
 */
export function assignSpot(role: string, taken: Set<string>): AgentSpot | null {
  if (role === 'orchestrator') {
    const own = DESKS.find((s) => s.id === ORCHESTRATOR_SPOT);
    if (own && !taken.has(own.id)) return own;
  }
  if (role === 'critic') {
    const seat = MEETING_SEATS.find((s) => !taken.has(s.id));
    if (seat) return seat;
  }
  const pool = [...DESKS.filter((s) => s.id !== ORCHESTRATOR_SPOT), ...OVERFLOW];
  return pool.find((s) => !taken.has(s.id)) ?? pool.at(-1) ?? null;
}

export function createAgent(session: OfficeSession, spot: AgentSpot): Agent {
  const target: Position = { x: spot.x, y: spot.y };
  return {
    id: session.session_id,
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
    pose: 'walking',
    stalledSince: session.stalled_since,
    stalled: session.stalled_since !== null,
    position: { ...ENTRY },
    targetPosition: target,
    deskPosition: { ...target },
    assignedSpotId: spot.id,
    spriteFacing: spot.spriteFacing ?? 'front-right',
    charBase: charFor(session.role, session.session_id),
    pathQueue: pathBetween(ENTRY, target),
  };
}

/** Send a character to the door; the animation loop drops it once it arrives. */
export function leaveAgent(agent: Agent): Agent {
  return { ...agent, pose: 'leaving', targetPosition: { ...ENTRY }, pathQueue: pathBetween(agent.position, ENTRY) };
}

/**
 * Send a character that was walking out back to its desk. A session that returns while its character is leaving — the feed
 * dropped it with a `leaving` message and named it again (a verification) — walks back instead of stopping at the door in
 * its working pose.
 */
export function returnAgent(agent: Agent): Agent {
  return { ...agent, pose: 'walking', targetPosition: { ...agent.deskPosition }, pathQueue: pathBetween(agent.position, agent.deskPosition) };
}

/**
 * One animation frame: move every character toward the first waypoint (or its target), pop waypoints on arrival, mark
 * the local pose when a character reaches its target, and drop one that has reached the door on its way out.
 */
export function stepAgents(agents: Agent[], dt: number): Agent[] {
  const speed = WALK_SPEED * dt;
  const next: Agent[] = [];
  for (const agent of agents) {
    const queue = agent.pathQueue;
    const target = queue[0] ?? agent.targetPosition;
    const { position, arrived } = stepToward(agent.position, target, speed);
    let updated: Agent = { ...agent, position };
    if (arrived) {
      if (queue.length > 0) updated = { ...updated, pathQueue: queue.slice(1) };
      else if (agent.pose === 'leaving') continue; // at the door: the character leaves the office
      else updated = { ...updated, pose: 'arrived' };
    }
    next.push(updated);
  }
  return next;
}

/** Reduced motion: place every character at its desk or drop it, no walk and no animation loop. */
export function snapAgents(agents: Agent[]): Agent[] {
  const next: Agent[] = [];
  for (const agent of agents) {
    if (agent.pose === 'leaving') continue;
    next.push({ ...agent, pose: 'arrived', position: { ...agent.deskPosition }, targetPosition: { ...agent.deskPosition }, pathQueue: [] });
  }
  return next;
}
