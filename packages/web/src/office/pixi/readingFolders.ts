import type { Agent } from '../types';
import { isSeated } from './furniture';
import { FURN, p, POD_TOP, SPOTS, type WorldSpot } from './world';
import type { PropItem, Rect } from './roomProps';

/**
 * The folder a reviewer reads at the meeting table: an open manila folder lying on the table in front of each seated,
 * arrived sitter at a meeting seat (zone `review`), its near edge where the seat's typing hands land, so they rest on
 * its pages. It is drawn in code in the In review folder's colours (`props/folder.png`), and every few seconds a page
 * turns over from the reader's right to its left in three drawn frames. Reduced motion and frozen frames draw it open
 * and still.
 *
 * The In review folders lie on the table's centre line (`FOLDER_AT` in `roomProps.ts`), clear of these at both edges.
 */

const TABLE = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
/** The table top, as the seating harness measures the typing hands against it. */
const TOP = POD_TOP;
/** From the table's edge into the table, and along it from the seat's centre each way. */
export const READING_DEPTH = 0.4;
const HALF_WIDTH = 0.42;
/** The pages' inset from the cover, and how far a page reaches from the spine. */
const PAGE_INSET = 0.04;
const PAGE_W = 0.37;
const OVERHANG = PAGE_INSET + 0.015;

/** The flip's cycle: a reader turns a page once per slot, at a jittered moment in it, from a phase of its own. */
export const FLIP_SLOT_MS = 6_000;
export const FLIP_JITTER_MS = 2_500;
export const FLIP_FRAME_MS = 150;
/** Three drawn frames: the page raised 45 degrees, upright, and 135 degrees over. */
export const FLIP_FRAMES = 3;

// The In review folder's colours.
const OUTLINE = 0x735431;
const EDGE = 0x7e5b3a;
const MANILA = 0xfdd791;
const MANILA_SHADE = 0xb1894e;
const PAPER = 0xfbfdfc;
const PAPER_SHADE = 0xc6c5c7;
const PAPER_BACK = 0xd5d4d1;

const READING_SEATS: readonly WorldSpot[] = SPOTS.filter((spot) => spot.zone === 'review');

/** The folder's footprint on the table for a meeting seat, and which way its reader's right lies along j. */
export function readingFolderFootprint(spot: WorldSpot): { i0: number; i1: number; j0: number; j1: number; right: 1 | -1 } {
  // A camera-facing sitter (front-right) faces +i from the table's i edge; its right is +j. Back to the camera it faces -i.
  // The cover overhangs the reader's edge of the table by the pages' inset, so the pages start at the edge.
  const facingIn = spot.f === 'front-right';
  const i0 = facingIn ? TABLE.i - OVERHANG : TABLE.i + TABLE.w + OVERHANG - READING_DEPTH;
  return { i0, i1: i0 + READING_DEPTH, j0: spot.y - HALF_WIDTH, j1: spot.y + HALF_WIDTH, right: facingIn ? 1 : -1 };
}

type Point = readonly [number, number];
type Poly = { points: Point[]; color: number };

const quad = (ia: number, ib: number, ja: number, jb: number, z: number): Point[] => [p(ia, ja, z), p(ib, ja, z), p(ib, jb, z), p(ia, jb, z)];

/** The folder's shapes in world pixels, painted in order; `frame` 0 is at rest, 1..3 the turning page. */
function folderShapes(spot: WorldSpot, frame: number): Poly[] {
  const { i0, i1, j0, j1, right } = readingFolderFootprint(spot);
  const jc = spot.y;
  const [pa, pb] = [i0 + PAGE_INSET, i1 - PAGE_INSET];
  const shapes: Poly[] = [
    // A pixel of cover edge below the top, then the outline and the cover.
    { points: quad(i0, i1, j0, j1, TOP - 1 / 48), color: EDGE },
    { points: quad(i0, i1, j0, j1, TOP), color: OUTLINE },
    { points: quad(i0 + 0.03, i1 - 0.03, j0 + 0.03, j1 - 0.03, TOP), color: MANILA },
  ];
  for (const side of [-1, 1]) {
    const [near, far] = [jc + side * 0.03, jc + side * (0.03 + PAGE_W)];
    const [ja, jb] = side < 0 ? [far, near] : [near, far];
    // The sheets under the top one, then the top sheet and its lines of text.
    shapes.push({ points: quad(pa, pb, ja - 0.01, jb + 0.01, TOP), color: PAPER_SHADE });
    shapes.push({ points: quad(pa + 0.015, pb - 0.015, ja + 0.01, jb - 0.01, TOP), color: PAPER });
    for (const at of [0.3, 0.5, 0.7]) {
      const i = pa + (pb - pa) * at;
      shapes.push({ points: quad(i - 0.012, i + 0.012, ja + 0.06, jb - 0.06, TOP), color: PAPER_SHADE });
    }
  }
  shapes.push({ points: quad(i0 + 0.03, i1 - 0.03, jc - 0.012, jc + 0.012, TOP), color: MANILA_SHADE });
  if (frame > 0) {
    // The turning page, hinged at the spine, lifting off the reader's right-hand pages and falling onto its left.
    const angle = (frame * Math.PI) / (FLIP_FRAMES + 1);
    const j = jc + right * PAGE_W * Math.cos(angle);
    const z = TOP + PAGE_W * Math.sin(angle);
    const edge = (i: number): Point => p(i, j, z);
    shapes.push({ points: [p(pa, jc, TOP), p(pb, jc, TOP), edge(pb), edge(pa)], color: frame < 2 ? PAPER_SHADE : EDGE });
    shapes.push({
      points: [p(pa + 0.02, jc, TOP), p(pb - 0.02, jc, TOP), p(pb - 0.02, j, z), p(pa + 0.02, j, z)],
      color: frame * 2 <= FLIP_FRAMES + 1 ? PAPER : PAPER_BACK,
    });
  }
  return shapes;
}

function inside(points: readonly Point[], x: number, y: number): boolean {
  let hit = false;
  for (let k = 0, last = points.length - 1; k < points.length; last = k++) {
    const [xa, ya] = points[k]!;
    const [xb, yb] = points[last]!;
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) hit = !hit;
  }
  return hit;
}

export interface ReadingFolderArt {
  /** Top-left corner in world pixels; the same for every frame of a seat, so a flip does not move the folder. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** One rect run per row and colour, relative to the corner. */
  rects: Rect[];
}

const cache = new Map<string, ReadingFolderArt>();

/** A seat's folder at `frame`, rasterised at pixel centres (the last shape that covers a pixel paints it). */
export function readingFolderArt(spotId: string, frame: number): ReadingFolderArt {
  const key = `${spotId}/${frame}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const spot = READING_SEATS.find((seat) => seat.id === spotId)!;
  const all = Array.from({ length: FLIP_FRAMES + 1 }, (_, f) => folderShapes(spot, f)).flat().flatMap((shape) => shape.points);
  const x = Math.floor(Math.min(...all.map(([px]) => px)));
  const y = Math.floor(Math.min(...all.map(([, py]) => py)));
  const w = Math.ceil(Math.max(...all.map(([px]) => px))) - x;
  const h = Math.ceil(Math.max(...all.map(([, py]) => py))) - y;
  const shapes = folderShapes(spot, frame);
  const rects: Rect[] = [];
  for (let row = 0; row < h; row++) {
    let run: { from: number; color: number } | null = null;
    for (let col = 0; col <= w; col++) {
      let color: number | null = null;
      if (col < w) for (const shape of shapes) if (inside(shape.points, x + col + 0.5, y + row + 0.5)) color = shape.color;
      if (run && run.color !== color) { rects.push([run.from, row, col - run.from, 1, run.color]); run = null; }
      if (!run && color !== null) run = { from: col, color };
    }
  }
  const art = { x, y, w, h, rects };
  cache.set(key, art);
  return art;
}

/** A small stable hash of a string and a number. */
function hash(text: string, n: number): number {
  let value = 2166136261 ^ n;
  for (let k = 0; k < text.length; k++) value = Math.imul(value ^ text.charCodeAt(k), 16777619);
  value = Math.imul(value ^ (value >>> 15), 2246822507);
  return (value ^ (value >>> 13)) >>> 0;
}

/**
 * The page a reader shows at `now`: 0 at rest, 1..3 while a page turns. Each reader starts from its own phase, and in
 * each `FLIP_SLOT_MS` slot turns one page at a moment jittered by up to `FLIP_JITTER_MS`, so flips come 3.5 to 8.5 s
 * apart and two readers do not turn together. `still` (reduced motion or a frozen frame) keeps the folder at rest.
 */
export function flipFrame(readerId: string, now: number, still: boolean): number {
  if (still) return 0;
  const t = now + (hash(readerId, 0) % FLIP_SLOT_MS);
  const slot = Math.floor(t / FLIP_SLOT_MS);
  const into = t - slot * FLIP_SLOT_MS - (hash(readerId, slot + 1) % FLIP_JITTER_MS);
  if (into < 0 || into >= FLIP_FRAMES * FLIP_FRAME_MS) return 0;
  return 1 + Math.floor(into / FLIP_FRAME_MS);
}

/** Every reader's folder at `now`: one per agent seated and arrived at a meeting seat, at `zIndex`. */
export function readingFolderItems(agents: readonly Agent[], now: number, still: boolean, zIndex: number): PropItem[] {
  const out: PropItem[] = [];
  for (const agent of agents) {
    if (!isSeated(agent) || !READING_SEATS.some((seat) => seat.id === agent.assignedSpotId)) continue;
    const frame = flipFrame(agent.id, now, still);
    const art = readingFolderArt(agent.assignedSpotId, frame);
    out.push({
      key: `reading-${agent.id}`, zIndex, x: art.x, y: art.y, w: art.w, h: art.h, pivot: [0, 0],
      alpha: 1, scale: 1, rotation: 0, glow: 0, paint: { reading: `${agent.assignedSpotId}/${frame}` },
    });
  }
  return out;
}
