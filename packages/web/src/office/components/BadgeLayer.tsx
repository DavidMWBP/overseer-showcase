import type { MouseEvent } from 'react';
import { layoutLabels, type LabelBox, type LabelInput, type StageSize } from '../labelLayout';
import type { Badge } from '../badges';
import { MIN_TOUCH_HIT_PX, useCoarsePointer } from '../RoomProps';
import { fitInside, nearestTarget, type Box, type TouchTarget } from '../touchTarget';

/** A badge box in CSS pixels: two bold 10 px letters with padding, the ring drawn outside it. */
export const BADGE_SIZE = { width: 24, height: 16 } as const;
/** `.office-badge`'s border: its target span is placed from the badge's padding box. */
const BADGE_BORDER = 1;

export interface BadgeInput extends LabelInput {
  badge: Badge;
}

/** A touch tap on the badge layer, in layer CSS px, and how far it is from the nearest badge centre whose target holds it. */
export interface BadgeTap { x: number; y: number; distance: number }

/**
 * A badge's touch target in layer CSS px: `MIN_TOUCH_HIT_PX` square about its centre, fitted inside the stage's
 * `visible` box, so a badge at the stage's edge keeps a whole 44 px target where the stage clips the rest.
 */
export function badgeTarget(box: LabelBox, visible?: Box): TouchTarget {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const side = Math.max(MIN_TOUCH_HIT_PX, box.width, box.height);
  return { id: box.id, cx, cy, ...fitInside({ left: cx - side / 2, top: cy - side / 2, width: side, height: side }, visible, MIN_TOUCH_HIT_PX) };
}

/** Two badges' targets can overlap: of those holding the point (layer CSS px), the badge whose centre is nearest, with its distance. */
export function nearestBadge(boxes: readonly LabelBox[], x: number, y: number, visible?: Box): { id: string; distance: number } | null {
  return nearestTarget(boxes.map((box) => badgeTarget(box, visible)), x, y);
}

/**
 * The phone Office's badges: one per character, above its head and its speech bubble, laid out by the same rules as
 * the desktop labels (`layoutLabels` with a fixed box), so no two badges overlap and a badge that had to move keeps a
 * leader line to its character. It goes below its anchor, onto the head and the bubble, only when nothing above is
 * free. A badge is a tap target for the character's card; the character buttons carry the name and the keyboard, so
 * the layer stays hidden from assistive technology. On a touch pointer `onOpen` also gets the tap, so the stage can
 * weigh it against the characters' own targets, which a badge's target covers where it reaches down over a head.
 * `visible` is the stage box in the layer's coordinates, which the touch targets stay inside.
 */
export default function BadgeLayer({ stage, inputs, onOpen, visible }: { stage: StageSize; inputs: BadgeInput[]; onOpen: (id: string, tap?: BadgeTap) => void; visible?: Box }) {
  const coarse = useCoarsePointer();
  const boxes = layoutLabels(inputs, stage, 'overhead', BADGE_SIZE);
  if (boxes.length === 0) return null;
  const badges = new Map(inputs.map((input) => [input.id, input.badge]));
  const open = (id: string, event: MouseEvent<HTMLElement>) => {
    const layer = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!coarse || !layer) { onOpen(id); return; }
    const x = event.clientX - layer.left;
    const y = event.clientY - layer.top;
    const hit = nearestBadge(boxes, x, y, visible);
    onOpen(hit?.id ?? id, { x, y, distance: hit?.distance ?? Infinity });
  };
  return (
    <div className="office-labels office-badges" aria-hidden="true">
      <svg className="office-label-leaders" viewBox={`0 0 ${stage.width} ${stage.height}`} width={stage.width} height={stage.height}>
        {boxes.map((box) => (
          <line key={box.id} data-badge-leader={box.id} x1={box.leaderX} y1={box.leaderY} x2={box.anchorX} y2={box.anchorY} />
        ))}
      </svg>
      {boxes.map((box) => {
        const badge = badges.get(box.id)!;
        const target = coarse ? badgeTarget(box, visible) : null;
        return (
          <span key={box.id} className={`office-badge office-badge-${badge.kind}`} data-badge-for={box.id} onClick={(event) => open(box.id, event)}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height, background: badge.fill, color: badge.ink }}>
            {badge.mark}
            {target && <span className="office-badge-target" style={{
              left: target.left - box.left - BADGE_BORDER, top: target.top - box.top - BADGE_BORDER, width: target.width, height: target.height,
            }} />}
          </span>
        );
      })}
    </div>
  );
}
