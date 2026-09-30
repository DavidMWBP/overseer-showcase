/**
 * Where each character's label is drawn.
 *
 * Two separate problems made labels unreadable in the office-tab evidence run. A label drawn inside its character's
 * button inherits that character's z-index, so a desk sprite in front of the character covered the text; and two
 * characters at neighbouring desks put their labels on the same few pixels, so one label sat across the other. The
 * first is solved by drawing every box in one overlay layer above the room (`.office-labels` in office.css). The
 * second is solved here: every label is laid out as a box, and a box that would collide is moved to the nearest free
 * candidate placement around its character.
 *
 * Moving a box away from its character makes the leader line back to that character the only thing that says which
 * character the label names, so a leader running through an unrelated label box is as ambiguous as an overlap. The
 * placement search therefore rejects a candidate whose leader would cross an already-placed box, or whose box an
 * already-placed leader would cross. `leaderX`/`leaderY` is where the line leaves its own box, so the drawn line
 * starts at the box border and touches nothing else on its way to the character's feet.
 */

/** Width of one character of the label font, as a fraction of the font size. `ui-monospace` is a 0.6em advance. */
export const LABEL_CHAR_RATIO = 0.6;
/** Horizontal padding plus both borders of a label box. */
export const LABEL_PAD_PX = 10;
/** Vertical padding plus both borders of a label box. */
export const LABEL_HEIGHT_PAD_PX = 6;
/** Smallest gap kept between two label boxes, and between a box and an unrelated leader line. */
export const LABEL_GAP_PX = 3;
/** How far above its character a label sits when nothing is in the way. */
export const LABEL_LIFT_PX = 4;

export interface LabelInput {
  id: string;
  text: string;
  /** The character's foot position, in percent of the stage. */
  x: number;
  y: number;
  /** Extra classes for the box (role colouring). */
  className?: string;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LabelBox extends LabelInput, Rect {
  /** The character's foot position in pixels: the leader line ends here. */
  anchorX: number;
  anchorY: number;
  /** Where the leader line leaves this box, on its border, pointing at the anchor. */
  leaderX: number;
  leaderY: number;
}

export interface StageSize {
  width: number;
  height: number;
}

/**
 * Font size for the labels at a given stage width. The phone layout draws badges instead of labels, but a label
 * layout for a 390px phone's stage (about 366px) still fits: there the longest label the office draws, "claude · claude-opus-5 · orchestrator" (38 characters), needs
 * 38 * 0.6 * 8 + 10 = 193px — well inside 366px, so 8px is enough and no label is ever truncated.
 */
export function labelFontPx(stageWidth: number): number {
  if (stageWidth < 480) return 8;
  if (stageWidth < 900) return 9;
  return 10;
}

export function labelWidthPx(text: string, fontPx: number): number {
  return Math.ceil(text.length * fontPx * LABEL_CHAR_RATIO) + LABEL_PAD_PX;
}

export function labelHeightPx(fontPx: number): number {
  return Math.ceil(fontPx * 1.5) + LABEL_HEIGHT_PAD_PX;
}

export function boxesOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** The rectangle a box claims: the box plus the gap kept clear around it. */
function padded(box: Rect): Rect {
  return {
    left: box.left - LABEL_GAP_PX,
    top: box.top - LABEL_GAP_PX,
    width: box.width + LABEL_GAP_PX * 2,
    height: box.height + LABEL_GAP_PX * 2,
  };
}

/**
 * Whether the segment (x1,y1)-(x2,y2) enters `box`. Liang-Barsky clipping: the segment misses the rectangle exactly
 * when the entry parameter overtakes the exit parameter on one of the axes.
 */
export function segmentHitsBox(x1: number, y1: number, x2: number, y2: number, box: Rect): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let enter = 0;
  let exit = 1;
  const edges: Array<[number, number]> = [
    [-dx, x1 - box.left], [dx, box.left + box.width - x1],
    [-dy, y1 - box.top], [dy, box.top + box.height - y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > exit) return false;
      if (r > enter) enter = r;
    } else {
      if (r < enter) return false;
      if (r < exit) exit = r;
    }
  }
  return enter <= exit;
}

/** Whether a placed label's leader line enters `box`. */
export function leaderHitsBox(label: LabelBox, box: Rect): boolean {
  return segmentHitsBox(label.leaderX, label.leaderY, label.anchorX, label.anchorY, box);
}

/** Where the line from a box's centre to the anchor crosses that box's border. */
function borderPoint(box: Rect, anchorX: number, anchorY: number): { x: number; y: number } {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = anchorX - cx;
  const dy = anchorY - cy;
  let t = 1;
  if (dx > 0) t = Math.min(t, (box.left + box.width - cx) / dx);
  if (dx < 0) t = Math.min(t, (box.left - cx) / dx);
  if (dy > 0) t = Math.min(t, (box.top + box.height - cy) / dy);
  if (dy < 0) t = Math.min(t, (box.top - cy) / dy);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Placements to try for one label, nearest first: directly above its character, then shifted sideways, then a row
 * further away, then the same fan below it. A label therefore stays within a few rows of the character it names.
 * `prefer: 'below'` (the Pixi room, whose anchor is under the feet and whose characters stand above it) swaps the sides:
 * below costs nothing and above costs 3.
 */
function candidates(anchorX: number, anchorY: number, width: number, height: number, stage: StageSize, prefer: LabelSide): Rect[] {
  const stepY = height + LABEL_GAP_PX;
  const stepX = width * 0.3 + LABEL_GAP_PX;
  const found: Array<{ rect: Rect; cost: number }> = [];
  for (let row = 0; row < 10; row++) {
    for (const lane of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
      for (const below of [false, true]) {
        const top = below
          ? anchorY + LABEL_LIFT_PX + row * stepY
          : anchorY - LABEL_LIFT_PX - height - row * stepY;
        if (top < 0 || top + height > stage.height) continue;
        const left = Math.max(0, Math.min(anchorX - width / 2 + lane * stepX, stage.width - width));
        // 'overhead' (the phone badges, anchored above a head and its bubble) goes below only when nothing above is free.
        const sideCost = prefer === 'below' ? (below ? 0 : 3) : prefer === 'overhead' ? (below ? 1000 : 0) : (below ? 2 : 0);
        found.push({ rect: { left, top, width, height }, cost: row * 10 + Math.abs(lane) * 4 + sideCost });
      }
    }
  }
  // A stage shorter than one label row leaves nothing above or below the character: pin the label to the top edge,
  // where it is at least whole and readable.
  if (found.length === 0) {
    return [{ left: Math.max(0, Math.min(anchorX - width / 2, stage.width - width)), top: 0, width, height }];
  }
  found.sort((a, b) => a.cost - b.cost);
  return found.map((c) => c.rect);
}

/**
 * Place one box per label, one label at a time, highest character first. Each label takes the nearest candidate
 * placement that neither overlaps a placed box nor crosses — with its leader line — a placed box, and whose own box
 * no placed leader crosses. If nothing is completely free (a stage too small for the set) the candidate with the
 * fewest such conflicts is used, so a label is never dropped. A fixed `size` lays out boxes that are not text-sized
 * (the phone badges) with the same rules.
 */
export type LabelSide = 'above' | 'below' | 'overhead';

export function layoutLabels(inputs: LabelInput[], stage: StageSize, prefer: LabelSide = 'above', size?: { width: number; height: number }): LabelBox[] {
  if (stage.width <= 0 || stage.height <= 0) return [];
  const fontPx = labelFontPx(stage.width);
  const height = size?.height ?? labelHeightPx(fontPx);

  const wanted = inputs.map((input) => ({
    ...input,
    width: Math.min(size?.width ?? labelWidthPx(input.text, fontPx), stage.width),
    anchorX: (input.x / 100) * stage.width,
    anchorY: (input.y / 100) * stage.height,
  }));

  const order = wanted.map((_, i) => i).sort((a, b) => wanted[a]!.anchorY - wanted[b]!.anchorY || a - b);
  const placed: LabelBox[] = [];
  const out: LabelBox[] = new Array(wanted.length);

  for (const index of order) {
    const want = wanted[index]!;
    let best: LabelBox | undefined;
    let bestConflicts = Infinity;
    for (const rect of candidates(want.anchorX, want.anchorY, want.width, height, stage, prefer)) {
      const border = borderPoint(rect, want.anchorX, want.anchorY);
      const box: LabelBox = { ...want, ...rect, leaderX: border.x, leaderY: border.y };
      let conflicts = 0;
      // A box covering another character's feet leaves that character no leader route at all, so every candidate is
      // weighed against every anchor, not only the labels placed so far.
      for (const other of wanted) {
        if (other === want) continue;
        const claim = padded(rect);
        if (other.anchorX >= claim.left && other.anchorX <= claim.left + claim.width
          && other.anchorY >= claim.top && other.anchorY <= claim.top + claim.height) conflicts++;
      }
      for (const other of placed) {
        if (boxesOverlap(padded(box), other)) conflicts++;
        if (leaderHitsBox(box, padded(other))) conflicts++;
        if (leaderHitsBox(other, padded(box))) conflicts++;
      }
      if (conflicts === 0) {
        best = box;
        break;
      }
      if (conflicts < bestConflicts) {
        bestConflicts = conflicts;
        best = box;
      }
    }
    const box = best!;
    placed.push(box);
    out[index] = box;
  }
  return out;
}
