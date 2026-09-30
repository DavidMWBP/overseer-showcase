import type { Bead, BeadsMode, BoardColumn, Phase } from '@overseer/shared';

export interface TaskStore {
  available(): Promise<boolean>;
  /** Runs `bd init` in repoPath. Rejects with an Error whose message carries bd's output. */
  init(repoPath: string, prefix: string, mode: BeadsMode): Promise<void>;
  list(repoPath: string): Promise<Bead[]>;
  ready(repoPath: string): Promise<string[]>;
  /** Every open blocked bead with the open beads it waits on. Both directions of the relation come from this one read (`dependentsOf`, `blockersOf`). */
  blocked(repoPath: string): Promise<BlockedBead[]>;
  show(repoPath: string, id: string): Promise<Bead | null>;
  /**
   * Status, phase label and note in one write. A transition is one `bd update` (about half a second) instead of three to
   * five calls; writes to a repo run alone and the board's `list` for that repo waits behind pending writes (reads run
   * alongside each other), so this is what keeps it under a second while workers move. `phase: null` clears the phase
   * label, `phase` omitted leaves it alone.
   */
  update(repoPath: string, id: string, patch: BeadPatch): Promise<void>;
  /** `force` closes past bd's own gates; bd 1.2.2 refuses to close a bead whose blockers are still open. */
  close(repoPath: string, id: string, reason: string, opts?: { force?: boolean }): Promise<void>;
  /** Creates one bead and answers its id. `labels` are written at creation (a batch label must be, so the batch counts the bead at once); `blockedBy` are ids the new bead depends on. */
  create(repoPath: string, bead: { title: string; description: string; labels: string[]; blockedBy: string[] }): Promise<string>;
  raw(repoPath: string, args: string[]): Promise<unknown>;
}

export interface BeadPatch { status?: 'open' | 'in_progress'; phase?: Phase | null; note?: string }

/** One row of `bd blocked`: an open bead and the open beads it waits on. */
export interface BlockedBead { id: string; blocked_by: string[] }

/** Ids of the open beads that are blocked by the given one (the ones a close on it would make ready). */
export const dependentsOf = (blocked: BlockedBead[], id: string): string[] => blocked.filter((b) => b.blocked_by.includes(id)).map((b) => b.id);

/** The other direction: ids of the open beads the given one waits on (empty when it waits on none). */
export const blockersOf = (blocked: BlockedBead[], id: string): string[] => blocked.find((b) => b.id === id)?.blocked_by ?? [];

export const PHASE_PREFIX = 'overseer:';
export const PHASES: Phase[] = ['verifying', 'review', 'merged', 'rejected', 'abandoned', 'closed', 'verified', 'worker-reported'];
export const HARNESS_PREFIX = 'harness:';
/** A bead created for a batch carries `overseer:batch:<batch id>` from creation (the daemon writes it when the `bd` tool creates it with a batch_id), so the batch counts it before any dispatch (round 15). */
export const BATCH_PREFIX = 'overseer:batch:';

export function batchOf(bead: Bead): string | null {
  const l = bead.labels.find((x) => x.startsWith(BATCH_PREFIX));
  return l ? l.slice(BATCH_PREFIX.length) : null;
}

export function phaseOf(bead: Bead): Phase | null {
  // Only the phase labels: `overseer:batch:<id>` shares the prefix and is not a phase.
  const l = bead.labels.find((x) => x.startsWith(PHASE_PREFIX) && (PHASES as string[]).includes(x.slice(PHASE_PREFIX.length)));
  return l ? (l.slice(PHASE_PREFIX.length) as Phase) : null;
}

export function columnFor(bead: Bead, readyIds: Set<string>): BoardColumn {
  if (bead.status === 'closed') return 'done';
  const phase = phaseOf(bead);
  if (phase === 'verifying') return 'verifying';
  if (phase === 'review') return 'review';
  if (bead.status === 'in_progress') return 'running';
  return readyIds.has(bead.id) ? 'ready' : 'blocked';
}
