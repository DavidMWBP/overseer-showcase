import { FURN, p, H, W, WORLD_HEIGHT, WORLD_WIDTH } from './world';
import { ROOM_PROP_BOXES } from './roomProps';

export interface OfficeViewport {
  stageWidth: number;
  stageHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  devicePixelRatio: number;
  pixelScale: number;
  scale: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  worldWidth: number;
  worldHeight: number;
}

export interface ScreenOrigin {
  x: number;
  y: number;
}

const MAIN_FLOOR_CENTRE = p(6, H / 2);

/** CSS px kept between a room object and the edge of the visible box. */
const OBJECT_MARGIN = 8;
/** CSS px of rounding error allowed when the fit scale makes the objects span the box exactly. */
const FIT_EPSILON = 1e-6;
type Span = readonly [number, number];
const spanX = ([x, , w]: readonly number[]): Span => [x!, x! + w!];
const spanY = ([, y, , h]: readonly number[]): Span => [y!, y! + h!];
const union = (spans: Span[]): Span => [Math.min(...spans.map(([a]) => a)), Math.max(...spans.map(([, b]) => b))];
/** The meeting table's world box: its footprint from the floor to its top (z 0.792, furniture/SOURCE.md). */
const TABLE_BOX = (() => {
  const { i, j, w, d } = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
  const corners = [p(i, j, 0.792), p(i + w, j), p(i, j + d), p(i + w, j + d)];
  const left = Math.min(...corners.map(([x]) => x));
  const top = Math.min(...corners.map(([, y]) => y));
  return [left, top, Math.max(...corners.map(([x]) => x)) - left, Math.max(...corners.map(([, y]) => y)) - top] as const;
})();
/** The question note and the folders stay in view whenever they fit; the whiteboard and the whole table join them when all fit. */
const REQUIRED = [ROOM_PROP_BOXES.questions, ROOM_PROP_BOXES.review];
const WITH_BOARD = [...REQUIRED, ROOM_PROP_BOXES.board, TABLE_BOX];
/** World px spanned by the question note, folders, whiteboard and table; used for fit and initial framing. */
const FRAME_X = union(WITH_BOARD.map(spanX));
const FRAME_Y = union(WITH_BOARD.map(spanY));

/**
 * Moves a desired camera offset the least distance that puts the world span on screen, `OBJECT_MARGIN` inside the box;
 * a span wider than the box leaves it where it was.
 */
function showSpan(camera: number, [a, b]: Span, stageSize: number, origin: number, scale: number): number {
  const lower = OBJECT_MARGIN - origin - a * scale;
  const upper = stageSize - OBJECT_MARGIN - origin - b * scale;
  return lower <= upper + FIT_EPSILON ? Math.max(lower, Math.min(upper, camera)) : camera;
}

/**
 * The camera offset used by a resize, shifted the least distance to keep the question note and folders in view when they
 * fit, and to show all four bounds inside the margin when they fit together. Initial desktop framing applies its own
 * whiteboard visibility and room-area priority over the feasible camera range.
 */
function showObjects(camera: number, span: (box: readonly number[]) => Span, stageSize: number, origin: number, scale: number): number {
  const all = union(WITH_BOARD.map(span));
  const [a, b] = union(REQUIRED.map(span));
  const lower = OBJECT_MARGIN - origin - a * scale;
  const upper = stageSize - OBJECT_MARGIN - origin - b * scale;
  if (lower > upper + FIT_EPSILON) return camera;
  const target = (all[1] - all[0]) * scale <= stageSize - 2 * OBJECT_MARGIN + FIT_EPSILON
    ? showSpan(camera, all, stageSize, origin, scale)
    : showSpan(camera, span(ROOM_PROP_BOXES.board), stageSize, origin, scale);
  return Math.max(lower, Math.min(upper, target));
}

/** The room's silhouette, floor and both 4-unit back walls (room/SOURCE.md); outside it the stage is black. */
const ROOM = [p(0, H), p(0, H, 4), p(0, 0, 4), p(W, 0, 4), p(W, 0), p(W, H)] as const;

/** Area of a convex polygon clipped to the box [0, width] x [0, height] (Sutherland-Hodgman, then the shoelace formula). */
function areaInBox(polygon: readonly (readonly [number, number])[], width: number, height: number): number {
  const sides: [(q: readonly [number, number]) => number, number][] = [[(q) => q[0], 0], [(q) => -q[0], -width], [(q) => q[1], 0], [(q) => -q[1], -height]];
  let points = polygon;
  for (const [value, limit] of sides) {
    const input = points;
    const output: (readonly [number, number])[] = [];
    input.forEach((current, index) => {
      const previous = input[(index + input.length - 1) % input.length]!;
      const inside = value(current) >= limit;
      if (inside !== (value(previous) >= limit)) {
        const t = (limit - value(previous)) / (value(current) - value(previous));
        output.push([previous[0] + t * (current[0] - previous[0]), previous[1] + t * (current[1] - previous[1])]);
      }
      if (inside) output.push(current);
    });
    points = output;
  }
  return Math.abs(points.reduce((sum, [x, y], index) => {
    const [u, v] = points[(index + 1) % points.length]!;
    return sum + x * v - u * y;
  }, 0)) / 2;
}

function cameraRange(stageSize: number, origin: number, worldSize: number): Span {
  if (worldSize <= stageSize) {
    const centred = (stageSize - worldSize) / 2 - origin;
    return [centred, centred];
  }
  return [stageSize - origin - worldSize, -origin];
}

function fullyVisibleRange(range: Span, [a, b]: Span, stageSize: number, origin: number, scale: number): Span {
  const lower = Math.max(range[0], OBJECT_MARGIN - origin - a * scale);
  const upper = Math.min(range[1], stageSize - OBJECT_MARGIN - origin - b * scale);
  return lower <= upper + FIT_EPSILON ? [lower, Math.max(lower, upper)] : range;
}

/** Camera offsets that show the greatest part of a span inside the stage margin, within `range`. */
function mostVisibleRange(range: Span, [a, b]: Span, stageSize: number, origin: number, scale: number): Span {
  const left = origin + a * scale;
  const right = origin + b * scale;
  const viewLeft = Math.min(OBJECT_MARGIN, stageSize / 2);
  const viewRight = Math.max(viewLeft, stageSize - OBJECT_MARGIN);
  const candidates = [range[0], range[1], viewLeft - right, viewLeft - left, viewRight - right, viewRight - left]
    .filter((camera) => camera >= range[0] - FIT_EPSILON && camera <= range[1] + FIT_EPSILON)
    .map((camera) => Math.max(range[0], Math.min(range[1], camera)));
  const visible = (camera: number) => Math.max(0, Math.min(viewRight, right + camera) - Math.max(viewLeft, left + camera));
  const best = Math.max(...candidates.map(visible));
  const winners = candidates.filter((camera) => visible(camera) >= best - FIT_EPSILON);
  return [Math.min(...winners), Math.max(...winners)];
}

interface InitialCameraRanges {
  x: Span;
  y: Span;
  prioritizeObjects: boolean;
}

/** Camera ranges that enforce the first-view object priority at this scale. */
function initialCameraRanges(stageWidth: number, stageHeight: number, origin: ScreenOrigin, scale: number, fit: number): InitialCameraRanges {
  let x = cameraRange(stageWidth, origin.x, WORLD_WIDTH * scale);
  let y = cameraRange(stageHeight, origin.y, WORLD_HEIGHT * scale);
  if (fit + FIT_EPSILON >= scale) {
    return {
      x: fullyVisibleRange(x, FRAME_X, stageWidth, origin.x, scale),
      y: fullyVisibleRange(y, FRAME_Y, stageHeight, origin.y, scale),
      prioritizeObjects: false,
    };
  }

  const primaryX = union(REQUIRED.map(spanX));
  const primaryY = union(REQUIRED.map(spanY));
  const primaryFits = (primaryX[1] - primaryX[0]) * scale <= stageWidth - 2 * OBJECT_MARGIN + FIT_EPSILON
    && (primaryY[1] - primaryY[0]) * scale <= stageHeight - 2 * OBJECT_MARGIN + FIT_EPSILON;
  if (!primaryFits) return { x, y, prioritizeObjects: true };

  x = fullyVisibleRange(x, primaryX, stageWidth, origin.x, scale);
  y = fullyVisibleRange(y, primaryY, stageHeight, origin.y, scale);
  x = mostVisibleRange(x, spanX(ROOM_PROP_BOXES.board), stageWidth, origin.x, scale);
  y = mostVisibleRange(y, spanY(ROOM_PROP_BOXES.board), stageHeight, origin.y, scale);
  return { x, y, prioritizeObjects: false };
}

/** Among camera offsets inside the initial framing ranges, keep the primary objects visible first, then the whiteboard,
 * then maximize room area and minimize black. The grid is refined around its best cell; equal views prefer `fallback`.
 */
function mostRoom(stageWidth: number, stageHeight: number, origin: ScreenOrigin, scale: number, fallback: { x: number; y: number }, ranges: InitialCameraRanges): { x: number; y: number } {
  let xs = ranges.x;
  let ys = ranges.y;
  const visible = (x: number, y: number) => areaInBox(ROOM.map(([wx, wy]) => [origin.x + x + wx * scale, origin.y + y + wy * scale] as const), stageWidth, stageHeight);
  const visibleShare = (box: readonly number[], x: number, y: number) => {
    const left = origin.x + x + box[0]! * scale;
    const top = origin.y + y + box[1]! * scale;
    const right = left + box[2]! * scale;
    const bottom = top + box[3]! * scale;
    const viewLeft = Math.min(OBJECT_MARGIN, stageWidth / 2);
    const viewTop = Math.min(OBJECT_MARGIN, stageHeight / 2);
    const viewRight = Math.max(viewLeft, stageWidth - OBJECT_MARGIN);
    const viewBottom = Math.max(viewTop, stageHeight - OBJECT_MARGIN);
    const area = Math.max(0, Math.min(right, viewRight) - Math.max(left, viewLeft))
      * Math.max(0, Math.min(bottom, viewBottom) - Math.max(top, viewTop));
    return area / Math.max(1, box[2]! * box[3]! * scale * scale);
  };
  const evaluate = (x: number, y: number) => {
    const question = visibleShare(ROOM_PROP_BOXES.questions, x, y);
    const review = visibleShare(ROOM_PROP_BOXES.review, x, y);
    return {
      x,
      y,
      primaryMin: Math.min(question, review),
      primarySum: question + review,
      board: visibleShare(ROOM_PROP_BOXES.board, x, y),
      area: visible(x, y),
      distance: Math.hypot(x - fallback.x, y - fallback.y),
    };
  };
  const better = (candidate: ReturnType<typeof evaluate>, current: ReturnType<typeof evaluate>) => {
    if (ranges.prioritizeObjects) {
      if (candidate.primaryMin > current.primaryMin + 1e-6) return true;
      if (candidate.primaryMin < current.primaryMin - 1e-6) return false;
      if (candidate.primarySum > current.primarySum + 1e-6) return true;
      if (candidate.primarySum < current.primarySum - 1e-6) return false;
      if (candidate.board > current.board + 1e-6) return true;
      if (candidate.board < current.board - 1e-6) return false;
    }
    if (candidate.area > current.area + 0.5) return true;
    return candidate.area >= current.area - 0.5 && candidate.distance < current.distance;
  };
  let best = evaluate(Math.max(xs[0], Math.min(xs[1], fallback.x)), Math.max(ys[0], Math.min(ys[1], fallback.y)));
  const steps = 32;
  for (let pass = 0; pass < 4; pass++) {
    const stepX = (xs[1] - xs[0]) / steps;
    const stepY = (ys[1] - ys[0]) / steps;
    for (let ix = 0; ix <= steps; ix++) {
      for (let iy = 0; iy <= steps; iy++) {
        const x = xs[0] + ix * stepX;
        const y = ys[0] + iy * stepY;
        const candidate = evaluate(x, y);
        if (better(candidate, best)) best = candidate;
      }
    }
    xs = [Math.max(xs[0], best.x - stepX), Math.min(xs[1], best.x + stepX)];
    ys = [Math.max(ys[0], best.y - stepY), Math.min(ys[1], best.y + stepY)];
  }
  return { x: best.x, y: best.y };
}

/** Number of physical device pixels used for each art pixel in the phone band (below 768 px). */
export function officePixelScale(stageWidth: number, devicePixelRatio: number): number {
  return Math.max(1, Math.round((stageWidth / WORLD_WIDTH) * devicePixelRatio));
}

/** The desktop band's dpr 1 CSS scale, capped at the greater of one and the object fit, then snapped down to whole device
 * pixels per art pixel. At least one device pixel per art pixel is always used, so a denser screen keeps the same CSS framing.
 */
function desktopScale(stageWidth: number, devicePixelRatio: number, fit: number): number {
  const sameCssSize = Math.max(1, Math.round(stageWidth / WORLD_WIDTH));
  const target = Math.min(sameCssSize, Math.max(1, fit));
  // The epsilon keeps a target of exactly k / dpr, computed with rounding error, at k.
  const k = Math.floor(target * devicePixelRatio + 1e-9);
  return Math.max(1, k) / devicePixelRatio;
}

/** True in the phone band (max-width 767px, the one `styles.css` uses), which keeps `officePixelScale` and the main-floor framing. */
function phoneBand(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;
}

/** Align a canvas origin to the nearest physical device pixel. */
export function devicePixelOrigin(screenCoordinate: number, devicePixelRatio: number): number {
  return (Math.round(screenCoordinate * devicePixelRatio) / devicePixelRatio) - screenCoordinate;
}

function devicePixel(value: number, devicePixelRatio: number): number {
  return Math.round(value * devicePixelRatio) / devicePixelRatio;
}

function boundedPosition(desired: number, stageSize: number, worldSize: number, origin: number, devicePixelRatio: number): number {
  const snapped = devicePixel(desired, devicePixelRatio);
  if (worldSize <= stageSize) return devicePixel((stageSize - worldSize) / 2 - origin, devicePixelRatio);

  const minimum = Math.ceil((stageSize - origin - worldSize) * devicePixelRatio) / devicePixelRatio;
  const maximum = Math.floor(-origin * devicePixelRatio) / devicePixelRatio;
  if (minimum <= maximum) return Math.max(minimum, Math.min(maximum, snapped));

  // A world that is only a fraction of one device pixel wider than the box has no aligned offset at both edges.
  return devicePixel(Math.max(stageSize - origin - worldSize, Math.min(-origin, desired)), devicePixelRatio);
}

/**
 * Whole device pixels, and at a whole-number density whole CSS pixels too: Chromium resamples a canvas whose CSS size is a
 * fraction of a pixel (899.5 CSS at dpr 2) even when its backing store matches, blending every art pixel's edge. The
 * stage clips the extra fraction.
 */
function canvasSize(stageSize: number, origin: number, devicePixelRatio: number): number {
  if (Number.isInteger(devicePixelRatio)) return Math.ceil(stageSize - origin);
  return Math.ceil((stageSize - origin) * devicePixelRatio) / devicePixelRatio;
}

function makeViewport(
  stageWidth: number,
  stageHeight: number,
  devicePixelRatio: number,
  origin: ScreenOrigin,
  centreWorld: { x: number; y: number },
  phone: boolean,
  initial: boolean,
): OfficeViewport {
  const dpr = devicePixelRatio || 1;
  // `fit` is the largest CSS scale that keeps all four room bounds inside the stage margin. The phone band still zooms out
  // to fit them; desktop caps s1 = max(1, round(stageWidth / WORLD_WIDTH)) at max(1, fit), snaps down, and never uses fewer
  // than one device pixel per art pixel. Anything else is reached by panning.
  const fit = Math.min(
    (stageWidth - 2 * OBJECT_MARGIN) / (FRAME_X[1] - FRAME_X[0]),
    (stageHeight - 2 * OBJECT_MARGIN) / (FRAME_Y[1] - FRAME_Y[0]),
  );
  const whole = officePixelScale(stageWidth, dpr) / dpr;
  // A box not yet laid out (no room inside its margins) keeps the whole-pixel scale.
  const scale = phone ? (fit > 0 ? Math.min(whole, fit) : whole) : desktopScale(stageWidth, dpr, fit);
  const pixelScale = scale * dpr;
  const worldWidth = WORLD_WIDTH * scale;
  const worldHeight = WORLD_HEIGHT * scale;
  const originX = origin.x;
  const originY = origin.y;
  const shifted = {
    x: showObjects(stageWidth / 2 - originX - centreWorld.x * scale, spanX, stageWidth, originX, scale),
    y: showObjects(stageHeight / 2 - originY - centreWorld.y * scale, spanY, stageHeight, originY, scale),
  };
  const ranges = initial && !phone ? initialCameraRanges(stageWidth, stageHeight, origin, scale, fit) : undefined;
  const { x: cameraX, y: cameraY } = ranges ? mostRoom(stageWidth, stageHeight, origin, scale, shifted, ranges) : shifted;

  return {
    stageWidth,
    stageHeight,
    canvasWidth: canvasSize(stageWidth, originX, dpr),
    canvasHeight: canvasSize(stageHeight, originY, dpr),
    devicePixelRatio: dpr,
    pixelScale,
    scale,
    originX,
    originY,
    x: boundedPosition(cameraX, stageWidth, worldWidth, originX, dpr),
    y: boundedPosition(cameraY, stageHeight, worldHeight, originY, dpr),
    worldWidth,
    worldHeight,
  };
}

/**
 * In the phone band, keep the centre of the main floor at the visible box centre, moved just far enough to show the
 * question note and folders first, then the whiteboard and table when they fit. In the desktop band, keep all four bounds
 * inside the margin when they fit; otherwise keep the note and folders first and the whiteboard as far in view as they
 * allow. Among the views that meet that priority, show the most room (`mostRoom`).
 */
export function initialOfficeViewport(
  stageWidth: number,
  stageHeight: number,
  devicePixelRatio: number,
  origin: ScreenOrigin = { x: 0, y: 0 },
  phone: boolean = phoneBand(),
): OfficeViewport {
  return makeViewport(stageWidth, stageHeight, devicePixelRatio, origin, { x: MAIN_FLOOR_CENTRE[0], y: MAIN_FLOOR_CENTRE[1] }, phone, true);
}

/** Keep the world point at the visible box centre when the stage size or device density changes, with the same room-object shift. */
export function resizeOfficeViewport(
  previous: OfficeViewport,
  stageWidth: number,
  stageHeight: number,
  devicePixelRatio: number,
  origin: ScreenOrigin = { x: previous.originX, y: previous.originY },
  phone: boolean = phoneBand(),
): OfficeViewport {
  const centreWorld = {
    x: (previous.stageWidth / 2 - previous.originX - previous.x) / previous.scale,
    y: (previous.stageHeight / 2 - previous.originY - previous.y) / previous.scale,
  };
  return makeViewport(stageWidth, stageHeight, devicePixelRatio, origin, centreWorld, phone, false);
}

/** Pan in CSS pixels while keeping the scaled world inside its fixed stage box. */
export function panOfficeViewport(viewport: OfficeViewport, deltaX: number, deltaY: number): OfficeViewport {
  return {
    ...viewport,
    x: boundedPosition(viewport.x + deltaX, viewport.stageWidth, viewport.worldWidth, viewport.originX, viewport.devicePixelRatio),
    y: boundedPosition(viewport.y + deltaY, viewport.stageHeight, viewport.worldHeight, viewport.originY, viewport.devicePixelRatio),
  };
}

/** The part of the world the stage box shows, in world pixels: where the stage clips the room and its overlays. */
export function visibleWorld(viewport: OfficeViewport): { left: number; top: number; right: number; bottom: number } {
  const s = viewport.scale;
  const left = -(viewport.originX + viewport.x) / s;
  const top = -(viewport.originY + viewport.y) / s;
  return { left, top, right: left + viewport.stageWidth / s, bottom: top + viewport.stageHeight / s };
}
