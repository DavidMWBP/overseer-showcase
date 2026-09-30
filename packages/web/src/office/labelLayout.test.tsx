import { describe, expect, it } from 'vitest';
import type { OfficeSession } from '@overseer/shared';
import { assignSpot, createAgent, snapAgents } from './agentManager';
import { pixiLabelInputs } from './pixi/OfficeStage';
import {
  boxesOverlap, labelFontPx, labelWidthPx, layoutLabels, leaderHitsBox, segmentHitsBox,
  type LabelBox, type LabelInput,
} from './labelLayout';

/** The widths the office-tab evidence run captured, which reported labels unreadable at every one of them. */
const WIDTHS = [390, 767, 768, 880, 1000, 1001, 1100, 1199, 1200, 1300, 1400, 1401, 1600];

/** The stage's pixel size at a viewport width, from office.css: the rail takes 232px above 767px, and the aspect is 1680/1056. */
function stageAt(viewport: number) {
  const width = viewport < 768 ? viewport - 24 : viewport - 232 - 48;
  return { width, height: (width * 1056) / 1680 };
}

/**
 * The five characters the evidence run seeded: the orchestrator plus four workers, each seated at the desk production
 * gives it. The desks come from `assignSpot` and the anchors from the stage's own `pixiLabelInputs`, not a copy of
 * either rule, so a change to the seating or the projection is caught here.
 */
function seededLabels(): LabelInput[] {
  const sessions: Pick<OfficeSession, 'role' | 'harness' | 'bead_id'>[] = [
    { role: 'orchestrator', harness: 'claude', bead_id: null },
    { role: 'worker', harness: 'claude', bead_id: 'proof-alpha' },
    { role: 'worker', harness: 'codex', bead_id: 'proof-charlie' },
    { role: 'critic', harness: 'codex', bead_id: 'proof-sierra' },
    { role: 'worker', harness: 'claude', bead_id: 'proof-delta' },
  ];
  const taken = new Set<string>();
  const agents = sessions.map((session, i) => {
    const spot = assignSpot(session.role, taken)!;
    taken.add(spot.id);
    return createAgent({
      ...session, session_id: `session-${i}`, model: null, resolved_model: null, account_label: null,
      bead_title: null, batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null,
    }, spot);
  });
  return pixiLabelInputs(snapAgents(agents));
}

/** Every pair of boxes, with their texts, so a failure names the two labels that clash. */
function pairs(boxes: LabelBox[]): Array<[LabelBox, LabelBox]> {
  const out: Array<[LabelBox, LabelBox]> = [];
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) out.push([boxes[a]!, boxes[b]!]);
  return out;
}

describe('layoutLabels', () => {
  it('seats the orchestrator at its own desk, as assignSpot does', () => {
    // Guards the fixture: if the reserved desk moved, these coordinates move with it.
    const taken = new Set<string>();
    expect(assignSpot('orchestrator', taken)!.id).toBe('orch');
  });

  it.each(WIDTHS)('places five labels with no two overlapping at %ipx', (viewport) => {
    const boxes = layoutLabels(seededLabels(), stageAt(viewport), 'below');
    expect(boxes).toHaveLength(5);
    for (const [a, b] of pairs(boxes)) {
      expect([a.text, b.text, boxesOverlap(a, b)]).toEqual([a.text, b.text, false]);
    }
  });

  it.each(WIDTHS)('keeps every leader line out of every other label box at %ipx', (viewport) => {
    const boxes = layoutLabels(seededLabels(), stageAt(viewport), 'below');
    for (const [a, b] of pairs(boxes)) {
      // A leader crossing an unrelated box makes it ambiguous which character that box names.
      expect([a.text, b.text, leaderHitsBox(a, b)]).toEqual([a.text, b.text, false]);
      expect([b.text, a.text, leaderHitsBox(b, a)]).toEqual([b.text, a.text, false]);
    }
  });

  it.each(WIDTHS)('starts each leader on its own box and ends it at its own character at %ipx', (viewport) => {
    const stage = stageAt(viewport);
    for (const box of layoutLabels(seededLabels(), stage, 'below')) {
      expect(box.anchorX).toBeCloseTo((box.x / 100) * stage.width);
      expect(box.anchorY).toBeCloseTo((box.y / 100) * stage.height);
      // The line starts on the border of the box it belongs to, so it reads as coming out of that label.
      expect(box.leaderX).toBeGreaterThanOrEqual(box.left - 0.5);
      expect(box.leaderX).toBeLessThanOrEqual(box.left + box.width + 0.5);
      expect(box.leaderY).toBeGreaterThanOrEqual(box.top - 0.5);
      expect(box.leaderY).toBeLessThanOrEqual(box.top + box.height + 0.5);
    }
  });

  it.each(WIDTHS)('keeps every label whole and inside the stage at %ipx', (viewport) => {
    const stage = stageAt(viewport);
    for (const box of layoutLabels(seededLabels(), stage, 'below')) {
      // The box is wide enough for the full text, so nothing is clipped or ellipsised.
      expect(box.width).toBe(labelWidthPx(box.text, labelFontPx(stage.width)));
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(stage.width + 0.5);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.top + box.height).toBeLessThanOrEqual(stage.height + 0.5);
    }
  });

  it('moves a colliding label aside rather than dropping it', () => {
    const stage = { width: 1000, height: 746 };
    const same = [
      { id: 'a', text: 'claude · claude-opus-5 · proof-a', x: 50, y: 50 },
      { id: 'b', text: 'codex · gpt-5.6-luna · proof-b', x: 50, y: 50 },
    ];
    const [a, b] = layoutLabels(same, stage);
    expect(boxesOverlap(a!, b!)).toBe(false);
    expect(leaderHitsBox(a!, b!)).toBe(false);
    expect(leaderHitsBox(b!, a!)).toBe(false);
    // Both still point at the character they name.
    expect(a!.anchorY).toBeCloseTo(b!.anchorY);
  });

  it('draws nothing before the stage has been measured', () => {
    expect(layoutLabels(seededLabels(), { width: 0, height: 0 })).toEqual([]);
  });
});

describe('segmentHitsBox', () => {
  const box = { left: 100, top: 100, width: 50, height: 20 };

  it('reports a segment that crosses the box', () => {
    expect(segmentHitsBox(125, 50, 125, 200, box)).toBe(true);
  });

  it('reports a segment that passes beside the box', () => {
    expect(segmentHitsBox(90, 50, 90, 200, box)).toBe(false);
  });

  it('reports a segment that stops short of the box', () => {
    expect(segmentHitsBox(125, 0, 125, 60, box)).toBe(false);
  });
});

describe('label side preference', () => {
  const input: LabelInput = { id: 'a', text: 'claude · sonnet · ov-3', x: 50, y: 50 };
  const stage = { width: 900, height: 566 };

  it('places a lone label above its anchor by default', () => {
    expect(layoutLabels([input], stage)[0]!.top).toBeLessThan(283);
  });

  it('places a lone label below its anchor when below is preferred', () => {
    expect(layoutLabels([input], stage, 'below')[0]!.top).toBeGreaterThan(283);
  });
});
