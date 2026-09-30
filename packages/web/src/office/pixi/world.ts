export interface WorldPosition {
  x: number;
  y: number;
}

export type Facing = 'front-left' | 'front-right' | 'rear-left' | 'rear-right';

export const WORLD_WIDTH = 1680;
export const WORLD_HEIGHT = 1056;
export const W = 20;
export const H = 14;

const OX = 696;
const OY = 216;
const TILE_X = 48;
const TILE_Y = 24;

export function p(i: number, j: number, z = 0): [number, number] {
  return [OX + (i - j) * TILE_X, OY + (i + j) * TILE_Y - z * TILE_X];
}

/**
 * Layout 2, the modern office the user approved on 2026-09-26: three desk pods of four on the work floor, the
 * orchestrator's own desk in the middle of the front floor, clear of the lounge's wood, the QA corner (zone and floor region `lab`) behind the i = 12 glass, the meeting
 * room (zone and floor region `review`) behind the j = 7 glass, and the kitchen and lounge along the left wall.
 */
export interface Footprint {
  i: number;
  j: number;
  w: number;
  d: number;
}

export interface Furniture extends Footprint {
  /** The piece's art file under `furniture/`; `pod-desk-front` is the back-row desk, whose sitter faces the camera. */
  kind:
    | 'pod-desk-front' | 'pod-desk-rear' | 'desk-orch' | 'qa-desk' | 'meeting-table' | 'kitchen-counter' | 'fridge'
    | 'sofa' | 'coffee-table' | 'plant-monstera' | 'plant-snake' | 'lamp-floor';
  /** A depth key other than the footprint centre, for a long piece against a wall that everything else stands in front of. */
  depth?: number;
}

/** Pod desk size and top height: 70 x 38 art pixels, so each edge lies on the tile grid. */
export const POD_W = 70 / 48;
export const POD_D = 38 / 48;
export const POD_TOP = 38 / 48;
/** The divider on a pod's row joint, between its back desk and its front desk. */
export const DIVIDER_D = 2 / 48;
/** Pod corners (i0, j0): each pod has two desk columns along i, at i0 and i0 + 1.5. */
const PODS = [[3.2, 3.0], [6.7, 3.0], [4.0, 7.4]] as const;
const POD_COLUMNS = PODS.flatMap(([i0, j0]) => [i0, i0 + 1.5].map((i) => [i, j0] as const));
/** QA desk outer corners; each L desk fills two 0.75-deep wings of a 1.46 square and leaves its seat the notch. */
const QA_DESKS = [[12.7, 2.0], [16.1, 2.0]] as const;
export const QA_SIZE = 1.46;
export const QA_WING = 0.75;
/** The orchestrator's desk corner: the front middle of the work floor, right of the front pod and clear of the lounge wood (i < 5.5). */
const ORCH_DESK = [7.4, 10.9] as const;
const MEETING = { i: 15.3, j: 8.1, w: 1.44, d: 3.04 } as const;

export const FURN: readonly Furniture[] = [
  ...POD_COLUMNS.flatMap(([i, j0]): Furniture[] => [
    { kind: 'pod-desk-front', i, j: j0, w: POD_W, d: POD_D },
    { kind: 'pod-desk-rear', i, j: j0 + POD_D + DIVIDER_D, w: POD_W, d: POD_D },
  ]),
  { kind: 'desk-orch', i: ORCH_DESK[0], j: ORCH_DESK[1], w: 2, d: 1 },
  ...QA_DESKS.map(([i, j]): Furniture => ({ kind: 'qa-desk', i, j, w: QA_SIZE, d: QA_SIZE })),
  { kind: 'meeting-table', ...MEETING },
  { kind: 'kitchen-counter', i: 0.05, j: 9.3, w: 0.71, d: 3.44, depth: 0.05 + 9.3 },
  { kind: 'fridge', i: 0.08, j: 12.9, w: 0.667, d: 0.812 },
  { kind: 'sofa', i: 2.3, j: 10.6, w: 2.15, d: 1.0 },
  { kind: 'coffee-table', i: 2.81, j: 12.1, w: 1.19, d: 0.46 },
  ...([
    ['plant-snake', 0.4, 0.4], ['plant-monstera', 2.4, 8.3], ['plant-snake', 11.4, 4.5], ['plant-monstera', 19.4, 13.4],
    ['plant-snake', 12.45, 0.45], ['plant-monstera', 5.3, 13.4], ['plant-monstera', 9.4, 13.6], ['plant-snake', 11.5, 13.4],
    ['plant-monstera', 19.5, 0.6],
  ] as const).map(([kind, ci, cj]): Furniture => ({ kind, i: ci - 0.35, j: cj - 0.35, w: 0.7, d: 0.7 })),
  // The kitchen lamp and the meeting room's lamp by the glass are the board's; the corner lamp at (19.2, 12.2) keeps the
  // meeting room's far corner lit, clear of its seats and walkway.
  { kind: 'lamp-floor', i: 1.5, j: 10.5, w: 0.6, d: 0.6 },
  { kind: 'lamp-floor', i: 19.1, j: 7.6, w: 0.6, d: 0.6 },
  { kind: 'lamp-floor', i: 19.2, j: 12.2, w: 0.6, d: 0.6 },
];

/** The floor rectangles a piece blocks: its footprint, or the two wings of an L-shaped QA desk. */
export function footprints(furniture: Furniture): Footprint[] {
  const { i, j, w, d } = furniture;
  if (furniture.kind !== 'qa-desk') return [{ i, j, w, d }];
  return [{ i, j, w: QA_WING, d }, { i, j, w, d: QA_WING }];
}

/** Zones `lab` and `review` are the QA corner and the meeting room; `row` is the standing overflow along the back walls. */
export type SpotZone = 'run' | 'orch' | 'lab' | 'review' | 'ready' | 'blocked' | 'errand' | 'board' | 'row';

export interface WorldSpot extends WorldPosition {
  id: string;
  f: Facing;
  zone: SpotZone;
  /** The footprint origin of the desk this seat works at. */
  desk?: readonly [number, number];
  atDesk?: boolean;
}

/** The standing spots' spacing along the back walls, and the distance between one row and the next. */
const ROW_STEP = 0.7;
/**
 * The overflow row in the back corner, every spot at i + j >= 4.6: the initial view of a 1440 x 900 screen (a 1060 x 666
 * stage at scale 1) starts at world y 226.7 and a head reaches 90 px above the feet, so the corner itself would cut heads
 * off. Filled in this order: 0.7 off the j = 0 wall under its window (i 5.3..3.9, short of the whiteboard at i 7..10 and
 * the door), 0.7 off the i = 0 wall (j 5.6..4.2, short of the blocked spots at j 6.4), then one step in front of that
 * (j 5.6..3.5), one step in front of the first (i 5.3..3.2) and two steps in front of the second (j 6.3..2.8), which
 * still leaves a walk between it and the pods: 20 spots, each row filled towards the corner. Everyone faces the room.
 */
const BACK_ROW: readonly (readonly [number, number, Facing])[] = [
  ...Array.from({ length: 3 }, (_, k) => [5.3 - k * ROW_STEP, 0.7, 'front-left'] as const),
  ...Array.from({ length: 3 }, (_, k) => [0.7, 5.6 - k * ROW_STEP, 'front-right'] as const),
  ...Array.from({ length: 4 }, (_, k) => [1.4, 5.6 - k * ROW_STEP, 'front-right'] as const),
  ...Array.from({ length: 4 }, (_, k) => [5.3 - k * ROW_STEP, 1.4, 'front-left'] as const),
  ...Array.from({ length: 6 }, (_, k) => [2.1, 6.3 - k * ROW_STEP, 'front-right'] as const),
];

const spotData: WorldSpot[] = [
  // Each pod column's back-row sitter faces the camera; its front-row sitter has their back to it. A seat whose sitter has
  // their back to the camera sits as close to its desk as a walkable cell (or, at the meeting table, the table's centre
  // depth key) allows; a camera-facing seat keeps its distance, since the desk drawn after it would cover hands moved onto
  // the keyboard.
  ...POD_COLUMNS.flatMap(([i, j0], k): WorldSpot[] => [
    { id: `desk-${2 * k + 1}`, x: i + 0.72, y: j0 - 0.42, f: 'front-left', zone: 'run', desk: [i, j0] },
    { id: `desk-${2 * k + 2}`, x: i + 0.72, y: j0 + 1.86, f: 'rear-right', zone: 'run', desk: [i, j0 + POD_D + DIVIDER_D] },
  ]),
  { id: 'orch', x: ORCH_DESK[0] + 1.3, y: ORCH_DESK[1] - 0.45, f: 'front-left', zone: 'orch', desk: ORCH_DESK },
  ...QA_DESKS.map(([i, j], k): WorldSpot => ({ id: `qa-${k + 1}`, x: i + 0.91, y: j + 0.95, f: 'rear-left', zone: 'lab', desk: [i, j] })),
  { id: 'review-1', x: MEETING.i - 0.45, y: 8.85, f: 'front-right', zone: 'review' },
  { id: 'review-2', x: MEETING.i + MEETING.w + 0.08, y: 8.85, f: 'rear-left', zone: 'review' },
  { id: 'review-3', x: MEETING.i - 0.45, y: 10.4, f: 'front-right', zone: 'review' },
  { id: 'review-4', x: MEETING.i + MEETING.w + 0.08, y: 10.4, f: 'rear-left', zone: 'review' },
  { id: 'ready-1', x: 10.5, y: 1.4, f: 'front-left', zone: 'ready' },
  { id: 'ready-2', x: 10.5, y: 2.6, f: 'front-left', zone: 'ready' },
  { id: 'ready-3', x: 11.4, y: 3.6, f: 'front-left', zone: 'ready' },
  // By the left wall's windows (j 3..9), facing them.
  { id: 'blocked-1', x: 0.9, y: 6.4, f: 'rear-left', zone: 'blocked' },
  { id: 'blocked-2', x: 0.9, y: 7.6, f: 'rear-left', zone: 'blocked' },
  { id: 'coffee', x: 1.3, y: 12.0, f: 'rear-left', zone: 'errand' },
  { id: 'fridge', x: 1.45, y: 13.35, f: 'rear-left', zone: 'errand' },
  // A standing spot in front of the sofa, since there is no seated resting pose.
  { id: 'sofa', x: 3.4, y: 11.85, f: 'front-left', zone: 'errand' },
  ...BACK_ROW.map(([x, y, f], k): WorldSpot => ({ id: `row-${k + 1}`, x, y, f, zone: 'row' })),
];

export const SPOTS: readonly WorldSpot[] = spotData.map((spot) => ({
  ...spot,
  atDesk: Boolean(spot.desk || spot.zone === 'review'),
}));

/** In the door on the right wall (i 9.92..11.92, room/SOURCE.md). */
export const ENTRY: WorldPosition = { x: 10.9, y: 0.2 };
export const BOARD_SPOT: WorldSpot = { id: 'board', x: 17.4, y: 0.65, f: 'rear-right', zone: 'board' };

/** The walk grid: square cells a quarter tile wide, fine enough to pass between the pods and along the kitchen. */
export const CELL = 0.25;
export const CELLS_I = W / CELL;
export const CELLS_J = H / CELL;
/** The glass door on the i = 12 partition spans j 6..8; the j = 7 partition runs from i = 14 to the right wall. */
const GLASS_I = 12 / CELL;
const DOOR_J: readonly [number, number] = [6 / CELL, 8 / CELL];
const GLASS_J = 7 / CELL;
const GLASS_J_FROM = 14 / CELL;
/** The two posts that frame the glass door. */
export const GLASS_POSTS: readonly Footprint[] = [{ i: 11.92, j: 5.92, w: 0.16, d: 0.16 }, { i: 11.92, j: 7.92, w: 0.16, d: 0.16 }];
/**
 * Walkers keep half a tile off each glass partition, as tile-centre walks did, so their feet sort on the right side of
 * the segment depth keys (i = 12: 12 + j + 0.5; j = 7: i + 7.5).
 */
export const GLASS_CLEARANCE: readonly Footprint[] = [
  { i: 11.5, j: 0, w: 1, d: 6 }, { i: 11.5, j: 8, w: 1, d: H - 8 }, { i: 14, j: 6.5, w: W - 14, d: 1 },
];

export function cellOf(position: WorldPosition): [number, number] {
  return [Math.floor(position.x / CELL), Math.floor(position.y / CELL)];
}

/** Float noise in a footprint edge (3.2 + 1.458) must not claim the next cell. */
const EDGE_EPSILON = 1e-9;
const blocked = new Set<string>();
for (const footprint of [...FURN.flatMap(footprints), ...GLASS_POSTS, ...GLASS_CLEARANCE]) {
  for (let a = Math.floor(footprint.i / CELL + EDGE_EPSILON); a < Math.ceil((footprint.i + footprint.w) / CELL - EDGE_EPSILON); a++) {
    for (let b = Math.floor(footprint.j / CELL + EDGE_EPSILON); b < Math.ceil((footprint.j + footprint.d) / CELL - EDGE_EPSILON); b++) blocked.add(`${a},${b}`);
  }
}
/** Walk cells ("a,b") that any piece's footprint, a glass post or a glass clearance overlaps. */
export const BLOCK: ReadonlySet<string> = blocked;

/** False when the step between two neighbouring cells crosses a glass partition outside its door. */
export function edgeOpen(a: number, b: number, c: number, d: number): boolean {
  const inDoor = (cell: number) => cell >= DOOR_J[0] && cell < DOOR_J[1];
  if (Math.min(a, c) === GLASS_I - 1 && Math.max(a, c) === GLASS_I && !(inDoor(b) && inDoor(d))) return false;
  if (Math.min(b, d) === GLASS_J - 1 && Math.max(b, d) === GLASS_J && Math.min(a, c) >= GLASS_J_FROM) return false;
  return true;
}

export function stepOK(a: number, b: number, c: number, d: number): boolean {
  if (c < 0 || d < 0 || c >= CELLS_I || d >= CELLS_J || BLOCK.has(`${c},${d}`)) return false;
  if (a !== c && b !== d) {
    return stepOK(a, b, c, b) && stepOK(a, b, a, d) && stepOK(c, b, c, d) && stepOK(a, d, c, d);
  }
  return edgeOpen(a, b, c, d);
}

/**
 * A shortest walk over the cell grid from `from` to `to`: the centres of the cells where it turns, then the exact target.
 * With no route it is the target alone.
 */
export function pathBetween(from: WorldPosition, to: WorldPosition): WorldPosition[] {
  const start = cellOf(from);
  const target = cellOf(to);
  const key = ([a, b]: [number, number]) => `${a},${b}`;
  const previous = new Map<string, [number, number] | null>([[key(start), null]]);
  const queue: [number, number][] = [start];
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

  for (let head = 0; head < queue.length; head++) {
    const [a, b] = queue[head]!;
    if (a === target[0] && b === target[1]) break;
    for (const [da, db] of neighbors) {
      const next: [number, number] = [a + da, b + db];
      const nextKey = key(next);
      if (previous.has(nextKey) || !stepOK(a, b, next[0], next[1])) continue;
      previous.set(nextKey, [a, b]);
      queue.push(next);
    }
  }

  const cells: [number, number][] = [];
  let cell: [number, number] | null = previous.has(key(target)) ? target : null;
  while (cell) {
    cells.unshift(cell);
    cell = previous.get(key(cell)) ?? null;
  }
  // Drop the start and target cells and every cell in the middle of a straight run.
  const turns = cells.filter((here, k) => k > 0 && k < cells.length - 1
    && (here[0] - cells[k - 1]![0] !== cells[k + 1]![0] - here[0] || here[1] - cells[k - 1]![1] !== cells[k + 1]![1] - here[1]));
  return [...turns.map(([a, b]) => ({ x: (a + 0.5) * CELL, y: (b + 0.5) * CELL })), { x: to.x, y: to.y }];
}

export function stepToward(position: WorldPosition, target: WorldPosition, speed: number): { position: WorldPosition; arrived: boolean } {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= speed) return { position: { ...target }, arrived: true };
  return { position: { x: position.x + (dx / distance) * speed, y: position.y + (dy / distance) * speed }, arrived: false };
}

/** A screen component this close to zero keeps the current facing half: far above float noise (4e-16), far below a 0.05-tile step. */
export const FACING_EPSILON = 1e-6;

/**
 * Face along a step. A straight cross-screen segment has `di + dj` at 0 or float noise, and a straight vertical one
 * `di - dj`, so a near-zero half keeps `current`'s value instead of flipping at random; without `current` it is today's rule.
 */
export function dirFromDelta(di: number, dj: number, current?: Facing): Facing {
  const screenX = di - dj;
  const screenY = di + dj;
  const view = current && Math.abs(screenY) < FACING_EPSILON ? current.split('-')[0] : screenY > 0 ? 'front' : 'rear';
  const side = current && Math.abs(screenX) < FACING_EPSILON ? current.split('-')[1] : screenX > 0 ? 'right' : 'left';
  return `${view}-${side}` as Facing;
}
