import { snapAgents, stepAgents } from './agentManager';
import { lightingAt, type SceneFrame } from './officeModel';

export type SceneClock = () => Date;
const localClock: SceneClock = () => new Date();

export interface SimFrame extends SceneFrame {
  now: number;
}

function step(frame: SceneFrame, dt: number, now: number): SimFrame {
  const boundedDt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 3)) : 0;
  return {
    ...frame,
    agents: frame.reducedMotion ? snapAgents(frame.agents) : stepAgents(frame.agents, boundedDt),
    now,
  };
}

/** Read the room's night share from an injected local wall clock, defaulting to the browser clock. */
function nightShare(clock: SceneClock = localClock): number {
  return lightingAt(clock());
}

/** Pure scene simulation. Motion uses the supplied animation clock; lighting uses its own injectable wall clock. */
export const SceneSim = { step, nightShare };
