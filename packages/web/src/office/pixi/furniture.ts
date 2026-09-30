import { Graphics, Sprite, type Texture } from 'pixi.js';
import {
  DIVIDER_D, FURN, H, p, POD_D, POD_TOP, POD_W, QA_SIZE, QA_WING, SPOTS, W,
  type Facing, type Footprint, type Furniture, type WorldSpot,
} from './world';
import { box, paintGraphics, poly, shade, type Shape } from './draw';
import type { Agent } from '../types';

/**
 * Every depth-sorted prop of the layout 2 room as a shape list with its depth key: the desk pods with their dividers,
 * monitors and chairs, the orchestrator's desk, the QA desks, the meeting table, the kitchen
 * and lounge, plants, lamps, the QA wall screen, the glass partitions and their posts, each with the PixelLab
 * placement kept beside its fallback geometry.
 * The entity layer sorts by `zIndex = round(depth * 100)`, the same key a character gets from its feet, so furniture
 * uses its footprint centre (i + w/2 + j + d/2).
 */
export interface FurniturePiece {
  id: string;
  depth: number;
  shapes: Shape[];
  /** The seat this desk (or chair) belongs to, so a stalled occupant's desk dims with them. */
  spotId?: string;
}

export interface FurnitureSpritePlacement {
  id: string;
  asset: string;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  depth: number;
  spotId?: string;
  /** A `-lit` overlay; a screen overlay is lit while an agent seated at any of `spotIds` works, and one with `state` only while its piece shows that asset. */
  overlays?: { asset: string; mode: 'night' | 'screen'; spotIds?: string[]; state?: string }[];
  /** Every asset a piece can show, one at a time; `asset` is the first. A desk screen's states are on, then off. */
  states?: string[];
  /** Mirrored about its anchor: a chair for a seat that faces right, since chair art faces left. */
  flip?: boolean;
}

const POD_TOPS = ['#eee9e0', '#d3ccc0', '#b8b0a3'] as const;
const ORCH_WOOD = ['#a0584a', '#7a3f35', '#6a352c'] as const;
const OAK = ['#d9b07a', '#c09461', '#a57c4f'] as const;
const STEEL = ['#c9ced4', '#a4aab2', '#8d949d'] as const;
const SAGE = ['#a9bba1', '#8fa58a', '#7a8f76'] as const;
const TEAL = ['#4f8a86', '#3d6f6c', '#335e5b'] as const;
const CREAM = ['#efe6d2', '#d9cdb3', '#c4b89d'] as const;
const SCREEN = ['#3c424d', '#2d323b', '#262a32'] as const;
const GLASS_POST = ['#5d8fb4', '#4a7596', '#3f6480'] as const;
const CHAIR = ['#4a505c', '#383d47', '#2f333c'] as const;

export const footprintDepth = ({ i, j, w, d }: Footprint): number => i + w / 2 + j + d / 2;
const depthOf = (furniture: Furniture): number => furniture.depth ?? footprintDepth(furniture);

/** Anchors from furniture/SOURCE.md: the pixel of each file that sits on its world point. */
const anchors: Record<string, readonly [number, number]> = {
  'pod-desk-front': [70, 92], 'pod-desk-rear': [70, 92], 'divider': [70, 62],
  'monitor-back': [18, 50], 'monitor-front': [17, 48], 'chair-front': [21, 56], 'chair-rear': [19, 57], 'chair-meeting': [19, 58],
  'desk-orch': [97, 114], 'keyboard-mouse': [22, 14], 'monitors-orch': [37, 46], 'chair-orch': [20, 66],
  'qa-desk': [70, 117], 'meeting-table': [69, 146], 'kitchen-counter': [34, 147], 'fridge': [32, 132],
  'sofa': [103, 130], 'coffee-table': [57, 49], 'wall-screen-on': [2, 57],
  'plant-monstera': [28, 78], 'plant-snake': [15, 85],
  'lamp-floor': [12, 97], 'lamp-ceiling': [16, 77],
};

/** Pieces whose art sits on their footprint centre; every other piece sits on its front corner `p(i + w, j + d)`. */
const CENTRED: readonly Furniture['kind'][] = ['plant-monstera', 'plant-snake', 'lamp-floor'];

export const CEILING_LIGHTS = [
  { i: 4.7, j: 3.8, color: 0xffd79a },
  { i: 8.2, j: 3.8, color: 0xffd79a },
  { i: 5.5, j: 8.2, color: 0xffd79a },
  { i: 3.4, j: 11.8, color: 0xffd79a },
  { i: 15.3, j: 2.8, color: 0xffd79a },
  { i: 16.0, j: 9.6, color: 0xffd9a0 },
] as const;

/**
 * Pixel centres of the lit screen pixels relative to each file's anchor; a QA desk's two screens share one centre. The
 * orchestrator's glow sits lower, as spill on its desk, so it does not wash out the question note on the screens' top edge.
 */
export const SCREEN_GLOW_OFFSETS = {
  'monitor-back': [11, -26],
  'monitor-front': [2, -23],
  'monitors-orch': [11, -2],
  'qa-desk': [4, -93],
} as const;

/** Desk screens the camera sees the face of: each shows its `-off` file while nobody sits at its seat. */
const SCREENS_WITH_OFF: readonly string[] = ['monitor-front', 'qa-desk'];
const screenStates = (asset: string) => SCREENS_WITH_OFF.includes(asset) ? { states: [`furniture/${asset}`, `furniture/${asset}-off`] } : {};

/** Sitting at its own desk: arrived there, not walking to or from it and not arrived somewhere else, such as the board. */
export const isSeated = (agent: Agent): boolean => agent.pose === 'arrived'
  && Math.hypot(agent.position.x - agent.deskPosition.x, agent.position.y - agent.deskPosition.y) < 0.01;

/**
 * The glass partitions (i = 12 and j = 7) and their door posts stand 2.3 units tall, not the 3.2 of the first handoff:
 * the glass crosses the middle of the first view, and at 3.2 its top half streaked over the QA corner and the pod desks
 * behind it. `compose-office-room.mjs` bakes the same height into `public/office/pixi/glass/`.
 */
export const GLASS_H = 2.3;
/** The QA wall screen hangs on the right wall (j = 0) at i 12.9..14.9, from z 1.3. */
export const QA_SCREEN = { i: 12.9, j: 0, z: 1.3, w: 2.0, h: 57 / 48 } as const;
/** Nothing stands behind the right wall, so the screen draws before everything on the floor. */
export const QA_SCREEN_DEPTH = 0;
/** The QA wall screen's states from furniture/SOURCE.md, less `off`, which nothing shows. */
export const QA_SCREEN_STATES = ['on', 'running-0', 'running-1', 'running-2', 'running-3', 'pass', 'fail'] as const;

function placed(id: string, asset: string, [x, y]: readonly [number, number], depth: number, extra: Partial<FurnitureSpritePlacement> = {}): FurnitureSpritePlacement {
  const [anchorX, anchorY] = anchors[asset.slice('furniture/'.length)]!;
  return { id, asset, x, y, anchorX, anchorY, depth, ...extra };
}

/** The seat whose desk footprint starts at (i, j). */
const deskSpot = (furniture: Footprint) => SPOTS.find((spot) => spot.desk?.[0] === furniture.i && spot.desk[1] === furniture.j);

/** Where one screen stands: the monitor a pod seat looks at, the orchestrator's pair, or the QA desk's own screens. */
interface SeatScreen {
  spot: WorldSpot;
  asset: keyof typeof SCREEN_GLOW_OFFSETS;
  at: readonly [number, number];
  depth: number;
}

/** The screen of every desk seat, in SPOTS order: a back-row pod seat looks at a monitor back, a front-row one at a monitor front. */
export function seatScreens(): SeatScreen[] {
  return SPOTS.flatMap((spot): SeatScreen[] => {
    const desk = FURN.find((furniture) => furniture.i === spot.desk?.[0] && furniture.j === spot.desk[1]);
    if (!desk) return [];
    const depth = depthOf(desk) + 0.02;
    switch (desk.kind) {
      case 'pod-desk-front': return [{ spot, asset: 'monitor-back', at: p(spot.x, desk.j + 0.5, POD_TOP), depth }];
      case 'pod-desk-rear': return [{ spot, asset: 'monitor-front', at: p(spot.x, desk.j + 0.3, POD_TOP), depth }];
      case 'desk-orch': return [{ spot, asset: 'monitors-orch', at: p(spot.x, desk.j + 0.5, 0.81), depth }];
      case 'qa-desk': return [{ spot, asset: 'qa-desk', at: p(desk.i + desk.w, desk.j + desk.d), depth: depthOf(desk) }];
      default: return [];
    }
  });
}

/** One step behind a seat, against its facing. */
const BEHIND: Record<Facing, readonly [number, number]> = {
  'front-left': [0, -1], 'front-right': [-1, 0], 'rear-left': [1, 0], 'rear-right': [0, 1],
};
/** How far a chair's point sits behind its seat spot, so the chair sorts behind a sitter facing the camera and in front of one facing away. */
export const CHAIR_BACK_OFFSET = 0.15;

export function chairPoint(spot: Pick<WorldSpot, 'x' | 'y' | 'f'>): { x: number; y: number } {
  const [di, dj] = BEHIND[spot.f];
  return { x: spot.x + di * CHAIR_BACK_OFFSET, y: spot.y + dj * CHAIR_BACK_OFFSET };
}

/** A camera-facing meeting seat faces +i across the table, which the pod chair, turned mostly to the camera, did not read as. */
const chairArt = (spot: WorldSpot) => spot.zone === 'orch' ? 'chair-orch'
  : spot.zone === 'review' && spot.f === 'front-right' ? 'chair-meeting' : spot.f.startsWith('front') ? 'chair-front' : 'chair-rear';
const seats = () => SPOTS.filter((spot) => spot.atDesk);

/** PixelLab placements from furniture/SOURCE.md; points and pixel anchors move together with the FURN layout. */
export function furnitureSpritePlacements(): FurnitureSpritePlacement[] {
  const out: FurnitureSpritePlacement[] = [];
  FURN.forEach((furniture, index) => {
    const { kind, i, j, w, d } = furniture;
    const point = CENTRED.includes(kind) ? p(i + w / 2, j + d / 2) : p(i + w, j + d);
    const spot = deskSpot(furniture);
    const overlays: FurnitureSpritePlacement['overlays'] = kind === 'qa-desk'
      ? [{ asset: 'furniture/qa-desk-lit', mode: 'screen', spotIds: [spot!.id] }]
      : kind === 'lamp-floor' ? [{ asset: 'furniture/lamp-floor-lit', mode: 'night' }] : undefined;
    out.push(placed(`${kind}-${index}`, `furniture/${kind}`, point, depthOf(furniture), {
      ...(spot ? { spotId: spot.id } : {}), ...(overlays ? { overlays } : {}), ...screenStates(kind),
    }));
    if (kind === 'pod-desk-front') out.push(placed(`divider-${index}`, 'furniture/divider', p(i + POD_W, j + POD_D + DIVIDER_D, POD_TOP), dividerDepth(furniture)));
    if (kind === 'desk-orch') out.push(placed('keyboard-orch', 'furniture/keyboard-mouse', p(spot!.x, j + 0.2, 0.81), depthOf(furniture) + 0.01, { spotId: spot!.id }));
  });
  for (const screen of seatScreens()) {
    if (screen.asset === 'qa-desk') continue;
    out.push(placed(`monitor-${screen.spot.id}`, `furniture/${screen.asset}`, screen.at, screen.depth, {
      spotId: screen.spot.id, overlays: [{ asset: `furniture/${screen.asset}-lit`, mode: 'screen', spotIds: [screen.spot.id] }],
      ...screenStates(screen.asset),
    }));
  }
  for (const spot of seats()) {
    const chair = chairPoint(spot);
    out.push(placed(`chair-${spot.id}`, `furniture/${chairArt(spot)}`, p(chair.x, chair.y), chair.x + chair.y, {
      spotId: spot.id, ...(spot.f.endsWith('right') ? { flip: true } : {}),
    }));
  }
  const qaStates = QA_SCREEN_STATES.map((state) => `furniture/wall-screen-${state}`);
  out.push(placed('qa-screen', 'furniture/wall-screen-on',p(QA_SCREEN.i, QA_SCREEN.j, QA_SCREEN.z), QA_SCREEN_DEPTH, {
    states: qaStates, overlays: qaStates.map((state) => ({ asset: `${state}-lit`, mode: 'night', state })),
  }));
  for (const piece of furniturePieces()) {
    const glass = glassPlacement(piece);
    if (glass) out.push(glass);
  }
  CEILING_LIGHTS.forEach((light, index) => {
    out.push(placed(`ceiling-lamp-${index}`, 'furniture/lamp-ceiling', p(light.i, light.j, 2.9), 999.99, {
      overlays: [{ asset: 'furniture/lamp-ceiling-lit', mode: 'night' }],
    }));
  });
  return out;
}

const dividerDepth = ({ i, j }: Footprint) => i + POD_W / 2 + j + POD_D + DIVIDER_D / 2;

function glassPlacement(piece: FurniturePiece): FurnitureSpritePlacement | null {
  const matchI = piece.id.match(/^glass-i12-j(\d+)$/);
  const matchJ = piece.id.match(/^glass-j7-i(\d+)$/);
  const matchPost = piece.id.match(/^glass-post-(6|8)$/);
  if (!matchI && !matchJ && !matchPost) return null;
  let asset: string;
  let corners: [number, number][];
  if (matchI) {
    const j = Number(matchI[1]);
    asset = `glass/i12-j${j}`;
    corners = [p(12, j), p(12, j + 1), p(12, j, GLASS_H), p(12, j + 1, GLASS_H)];
  } else if (matchJ) {
    const i = Number(matchJ[1]);
    asset = `glass/j7-i${i}`;
    corners = [p(i, 7), p(i + 1, 7), p(i, 7, GLASS_H), p(i + 1, 7, GLASS_H)];
  } else {
    const j = Number(matchPost![1]);
    asset = `glass/post-i12-j${j}`;
    corners = [p(11.92, j - 0.08), p(12.08, j - 0.08), p(12.08, j + 0.08), p(11.92, j + 0.08),
      p(11.92, j - 0.08, GLASS_H), p(12.08, j - 0.08, GLASS_H), p(12.08, j + 0.08, GLASS_H), p(11.92, j + 0.08, GLASS_H)];
  }
  return { id: piece.id, asset, x: Math.floor(Math.min(...corners.map(([x]) => x))), y: Math.floor(Math.min(...corners.map(([, y]) => y))), anchorX: 0, anchorY: 0, depth: piece.depth };
}

export function positionFurnitureSprite(sprite: Sprite, placement: FurnitureSpritePlacement): void {
  sprite.anchor.set(placement.anchorX / sprite.texture.width, placement.anchorY / sprite.texture.height);
  sprite.position.set(placement.x, placement.y);
  if (placement.flip) sprite.scale.x = -1;
  sprite.zIndex = depthZ(placement.depth);
  sprite.label = placement.id;
}

/** Keep the old geometry visible for exactly the furniture piece whose texture is unavailable. */
export function furnitureDisplay(piece: FurniturePiece, texture?: Texture, placement?: FurnitureSpritePlacement): Sprite | Graphics {
  if (texture && placement) {
    const sprite = new Sprite(texture);
    positionFurnitureSprite(sprite, placement);
    return sprite;
  }
  const graphic = paintGraphics(new Graphics(), piece.shapes);
  graphic.zIndex = depthZ(piece.depth);
  graphic.label = piece.id;
  return graphic;
}

/** A desk slab on its legs: `top` is the slab's top height. */
function desk(i: number, j: number, w: number, d: number, top: number, colors: readonly [string, string, string]): Shape[] {
  return [
    ...box(i + 0.1, j + 0.1, w - 0.2, d - 0.2, 0, top - 0.07, [colors[1], shade(colors[1], 0.8), shade(colors[2], 0.8)]),
    ...box(i, j, w, d, top - 0.07, 0.07, colors),
  ];
}

function furnitureShapes(fu: Furniture): Shape[] {
  const { i, j, w, d } = fu;
  switch (fu.kind) {
    case 'pod-desk-front':
    case 'pod-desk-rear':
      return desk(i, j, w, d, POD_TOP, POD_TOPS);
    case 'desk-orch':
      return desk(i, j, w, d, 0.76, ORCH_WOOD);
    case 'qa-desk':
      return [...desk(i, j, QA_WING, d, 0.7, POD_TOPS), ...desk(i + QA_WING, j, QA_SIZE - QA_WING, QA_WING, 0.7, POD_TOPS)];
    case 'meeting-table':
      return desk(i, j, w, d, POD_TOP, OAK);
    case 'kitchen-counter':
      return [...box(i, j, w, d, 0, 0.95, CREAM), ...box(i + 0.15, j + 0.4, 0.4, 0.4, 0.95, 0.45, ['#8a3a33', '#6e2c27', '#5e2521'])];
    case 'fridge':
      return box(i, j, w, d, 0, 2, STEEL);
    case 'sofa':
      return [...box(i, j, w, d, 0, 0.4, TEAL), ...box(i, j, w, 0.25, 0.4, 0.45, TEAL)];
    case 'coffee-table':
      return desk(i, j, w, d, 0.35, OAK);
    case 'lamp-floor':
      return [...box(i + 0.2, j + 0.2, 0.2, 0.2, 0, 1.6, ['#3a3530', '#2e2a26', '#26221f']), ...box(i, j, w, d, 1.6, 0.4, ['#f3e2b8', '#e0cc98', '#cfba86'])];
    case 'plant-monstera':
    case 'plant-snake': {
      const [cx, cy] = p(i + 0.35, j + 0.35, 0.35);
      const leaves = ([[0, -46, 20], [-16, -28, 16], [16, -30, 16], [-8, -62, 13], [10, -58, 12]] as const)
        .map(([dx, dy, r], k): Shape => ({ kind: 'circle', x: cx + dx, y: cy + dy, r, fill: k % 2 ? '#4f8a3c' : '#5f9e47', stroke: '#2e5a26', width: 2 }));
      return [...box(i + 0.1, j + 0.1, 0.5, 0.5, 0, 0.35, ['#a8603a', '#8a4b2c', '#7a4126']), ...leaves];
    }
  }
}

function glass(a: number, b: number, c: number, d: number): Shape[] {
  return [
    poly([p(a, b), p(c, d), p(c, d, GLASS_H), p(a, b, GLASS_H)], '#a8d4f0', 0.1, '#5d8fb4', 3),
    { kind: 'line', pts: [p(a, b, GLASS_H), p(c, d, GLASS_H)], stroke: '#5d8fb4', width: 5 },
  ];
}

/** Chair footprint half-size. */
export const CHAIR_HALF = 0.28;

/** A placeholder desk chair centred on its chair point: stem, seat pad and a backrest on the side away from the sitter's facing. */
export function chairAt(spot: Pick<WorldSpot, 'x' | 'y' | 'f'>): { depth: number; shapes: Shape[] } {
  const { x, y } = chairPoint(spot);
  const [bi, bj] = BEHIND[spot.f];
  const i = x - CHAIR_HALF;
  const j = y - CHAIR_HALF;
  const w = CHAIR_HALF * 2;
  const back = bi !== 0
    ? box(bi < 0 ? i : i + w - 0.08, j, 0.08, w, 0.48, 0.62, CHAIR)
    : box(i, bj < 0 ? j : j + w - 0.08, w, 0.08, 0.48, 0.62, CHAIR);
  return {
    depth: x + y,
    shapes: [...box(x - 0.05, y - 0.05, 0.1, 0.1, 0, 0.4, CHAIR), ...box(i, j, w, w, 0.4, 0.08, CHAIR), ...back],
  };
}

function screenFallback(screen: SeatScreen): FurniturePiece {
  const { spot } = screen;
  const desk = FURN.find((furniture) => furniture.i === spot.desk?.[0] && furniture.j === spot.desk[1])!;
  const shapes = screen.asset === 'monitors-orch'
    ? [...box(spot.x - 0.65, desk.j + 0.5, 0.55, 0.08, 0.81, 0.38, SCREEN), ...box(spot.x + 0.1, desk.j + 0.5, 0.55, 0.08, 0.81, 0.38, SCREEN)]
    : [...box(spot.x - 0.38, desk.j + (screen.asset === 'monitor-back' ? 0.5 : 0.3), 0.76, 0.06, POD_TOP, 0.64, SCREEN)];
  return { id: `monitor-${spot.id}`, depth: screen.depth, shapes, spotId: spot.id };
}

export function furniturePieces(): FurniturePiece[] {
  const pieces: FurniturePiece[] = [];
  FURN.forEach((fu, k) => {
    pieces.push({ id: `${fu.kind}-${k}`, depth: depthOf(fu), shapes: furnitureShapes(fu), spotId: deskSpot(fu)?.id });
    if (fu.kind === 'pod-desk-front') pieces.push({ id: `divider-${k}`, depth: dividerDepth(fu), shapes: box(fu.i, fu.j + POD_D, fu.w, DIVIDER_D, POD_TOP, 0.542, SAGE) });
    if (fu.kind === 'desk-orch') {
      const spot = deskSpot(fu)!;
      pieces.push({ id: 'keyboard-orch', depth: depthOf(fu) + 0.01, shapes: box(spot.x - 0.3, fu.j + 0.12, 0.6, 0.2, 0.81, 0.05, SCREEN), spotId: spot.id });
    }
  });
  for (const screen of seatScreens()) if (screen.asset !== 'qa-desk') pieces.push(screenFallback(screen));
  for (const spot of seats()) pieces.push({ id: `chair-${spot.id}`, spotId: spot.id, ...chairAt(spot) });
  const { i: qi, j: qj, z: qz, w: qw, h: qh } = QA_SCREEN;
  pieces.push({ id: 'qa-screen', depth: QA_SCREEN_DEPTH, shapes: [poly([p(qi, qj, qz), p(qi + qw, qj, qz), p(qi + qw, qj, qz + qh), p(qi, qj, qz + qh)], '#3a4252')] });
  for (let j = 0; j < H; j++) if (j !== 6 && j !== 7) pieces.push({ id: `glass-i12-j${j}`, depth: 12 + j + 0.5, shapes: glass(12, j, 12, j + 1) });
  for (let i = 14; i < W; i++) pieces.push({ id: `glass-j7-i${i}`, depth: i + 7.5, shapes: glass(i, 7, i + 1, 7) });
  pieces.push({ id: 'glass-post-6', depth: 12 + 6, shapes: box(11.92, 5.92, 0.16, 0.16, 0, GLASS_H, GLASS_POST) });
  pieces.push({ id: 'glass-post-8', depth: 12 + 8, shapes: box(11.92, 7.92, 0.16, 0.16, 0, GLASS_H, GLASS_POST) });
  CEILING_LIGHTS.forEach((light, index) => {
    const [x, y] = p(light.i, light.j, 2.9);
    pieces.push({
      id: `ceiling-lamp-${index}`,
      depth: 999.99,
      shapes: [
        { kind: 'line', pts: [[x, y - 77], [x, y - 44]], stroke: '#383d4b', width: 2 },
        { kind: 'circle', x, y: y - 18, r: 7, fill: '#f5dfaa', stroke: '#24262d', width: 2 },
      ],
    });
  });
  return pieces;
}

export const depthZ = (depth: number): number => Math.round(depth * 100);
