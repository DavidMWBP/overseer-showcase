/**
 * Touch targets that stay inside the stage. The stage clips its room and overlays, so a 44 px target centred on a
 * character, a badge or an object at the stage's edge would lose the part past the edge. `fitInside` cuts a target to
 * the visible box and grows it back inward to its minimum side; `nearestTarget` picks, among the targets holding a tap,
 * the one whose covered thing's centre is nearest.
 */

/** A box by its edges, in the same space as the targets it bounds. */
export interface Box { left: number; top: number; right: number; bottom: number }
export interface Rect { left: number; top: number; width: number; height: number }
/** A tap target: its box, and the centre of what it covers (which a fitted box no longer has at its middle). */
export interface TouchTarget extends Rect { id: string; cx: number; cy: number }

function fitAxis(start: number, size: number, lo: number, hi: number, min: number): [number, number] {
  let a = Math.max(start, lo);
  let b = Math.min(start + size, hi);
  const need = Math.min(min, hi - lo);
  if (b - a < need) {
    // Clipped at the low edge: grow towards the high one, and the other way round.
    if (a === lo) b = a + need;
    else a = b - need;
  }
  return [a, b - a];
}

/**
 * `rect` cut to `visible` and grown back inward until each side is at least `min` (or the whole of `visible` where it is
 * smaller). A rect with no part inside `visible` is returned as it is: nothing of it can be tapped anyway.
 */
export function fitInside(rect: Rect, visible: Box | undefined, min: number): Rect {
  if (!visible) return rect;
  const outside = rect.left >= visible.right || rect.left + rect.width <= visible.left || rect.top >= visible.bottom || rect.top + rect.height <= visible.top;
  if (outside) return rect;
  const [left, width] = fitAxis(rect.left, rect.width, visible.left, visible.right, min);
  const [top, height] = fitAxis(rect.top, rect.height, visible.top, visible.bottom, min);
  return { left, top, width, height };
}

/** Of the targets holding (x, y), the one whose centre is nearest, with that distance, or null when none holds it. */
export function nearestTarget(targets: readonly TouchTarget[], x: number, y: number): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null;
  for (const target of targets) {
    if (x < target.left || x > target.left + target.width || y < target.top || y > target.top + target.height) continue;
    const distance = Math.hypot(x - target.cx, y - target.cy);
    if (!best || distance < best.distance) best = { id: target.id, distance };
  }
  return best;
}
