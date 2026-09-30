import type { OfficeState } from '@overseer/shared';

export type Position = { x: number; y: number };

export type SpriteDirection = 'front-left' | 'front-right' | 'rear-left' | 'rear-right';
export type AgentPose = 'walking' | 'arrived' | 'leaving';

/**
 * One character in the office. `state` is the activity the daemon's office feed reported; `pose` tracks local movement
 * through the room, so arriving at a desk or walking out never rewrites the reported activity.
 */
export interface Agent {
  /** The session id: the desk assignment and the React key are stable on it. */
  id: string;
  role: string;
  harness: string;
  model: string | null;
  resolvedModel: string | null;
  beadId: string | null;
  beadTitle: string | null;
  /** The repository and batch the session works in, when the feed names them; the phone badge and card read them. */
  repoId: string | null;
  batchId: string | null;
  state: OfficeState;
  /** The label shared by the character's accessible name and the overlay label layer. */
  labelText: string;
  pose: AgentPose;
  /** The ISO time the stall sweep marked this session stalled, or null; the character shows the stalled look while set. */
  stalledSince: string | null;
  stalled: boolean;
  position: Position;
  targetPosition: Position;
  deskPosition: Position;
  assignedSpotId: string;
  spriteFacing: SpriteDirection;
  charBase: string;
  pathQueue: Position[];
}
