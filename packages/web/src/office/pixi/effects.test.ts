import { describe, expect, it, vi } from 'vitest';
import type { OfficeSession } from '@overseer/shared';
import { assignSpot, createAgent } from '../agentManager';
import type { Agent } from '../types';
import { GLYPH_RASTER_SCALE } from './assets';
import { bubbleFor, confettiAt, createEffectLayer, doorFadeAlpha, fadeInAlpha, hopOffset, routePassedAgentToBoard } from './effects';
import { BOARD_SPOT, SPOTS } from './world';

const spriteScaleWrites = vi.hoisted(() => [] as [number, number][]);
vi.mock('pixi.js', () => {
  class DisplayObject {
    children: DisplayObject[] = [];
    position = { x: 0, y: 0, set: (x: number, y: number) => { this.position.x = x; this.position.y = y; } };
    scale = { x: 1, y: 1, set: (x: number, y = x) => { this.scale.x = x; this.scale.y = y; spriteScaleWrites.push([x, y]); } };
    anchor = { set: () => {} };
    addChild(...children: DisplayObject[]) { this.children.push(...children); return children[0] ?? this; }
    destroy() {}
    clear() { return this; }
    roundRect() { return this; }
    poly() { return this; }
    circle() { return this; }
    rect() { return this; }
    fill() { return this; }
    stroke() { return this; }
  }
  return { Container: DisplayObject, Graphics: DisplayObject, Sprite: DisplayObject };
});

const agent = (over: Partial<Pick<Agent, 'role' | 'state' | 'pose' | 'stalled'>> = {}): Pick<Agent, 'role' | 'state' | 'pose' | 'stalled'> => ({
  role: 'worker', state: 'working', pose: 'arrived', stalled: false, ...over,
});
const passSession: OfficeSession = {
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-5', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'verifying', stalled_since: null,
};

describe('Pixi office effects', () => {
  it('fades an arrival in over 400 ms', () => {
    expect([fadeInAlpha(0), fadeInAlpha(200), fadeInAlpha(400)]).toEqual([0, 0.5, 1]);
  });

  it('keeps a departing character opaque at 1.2 tiles from the door', () => {
    expect(doorFadeAlpha(1.2)).toBe(1);
  });

  it('fades a departing character out at the door', () => {
    expect(doorFadeAlpha(0)).toBe(0);
  });

  it('maps activity states to glyph-atlas bubble text and hides bubbles without an effect', () => {
    expect([
      bubbleFor(agent(), 0),
      bubbleFor(agent({ state: 'verifying' }), 0)?.text,
      bubbleFor(agent({ state: 'reviewing' }), 0)?.text,
      bubbleFor(agent({ stalled: true }), 0)?.text,
      bubbleFor(agent({ state: 'walking_in', pose: 'walking' }), 0)?.text,
      bubbleFor(agent({ state: 'walking_in' }), 0),
      bubbleFor(agent({ pose: 'leaving' }), 0),
    ]).toEqual([null, 'test', '✎', 'z z', '★', null, null]);
  });

  it('shows no bubble for a working agent that is walking', () => {
    expect(bubbleFor(agent({ state: 'working', pose: 'walking' }), 0)).toBeNull();
  });

  it('shows badges for a working agent with a signal', () => {
    expect([
      bubbleFor(agent(), 0, { passed: true })?.text,
      bubbleFor(agent(), 0, { failed: true })?.text,
      bubbleFor(agent({ role: 'orchestrator' }), 0, { asking: true })?.text,
    ]).toEqual(['✓', '!', '?']);
  });

  it('gives asking, failed and passed badges their defined precedence', () => {
    expect([
      bubbleFor(agent({ role: 'orchestrator' }), 0, { asking: true, failed: true, passed: true })?.text,
      bubbleFor(agent(), 0, { asking: true, failed: true, passed: true })?.text,
      bubbleFor(agent(), 0, { passed: true })?.text,
      bubbleFor(agent(), 0, { asking: true }),
    ]).toEqual(['?', '!', '✓', null]);
  });

  it('draws bubble glyphs at whole device-pixel scales for k = 1, 2 and 3', () => {
    spriteScaleWrites.length = 0;
    const spot = assignSpot('worker', new Set())!;
    const worker = createAgent(passSession, spot);
    const art = { glyph: () => ({ texture: {}, width: 17 }) };
    const layer = createEffectLayer(art as never, document.createElement('canvas'));
    layer.drawAgents([worker], 1_000, false, false, false, { printer: null, merged: null }, () => 1);

    expect({
      rasterScale: GLYPH_RASTER_SCALE,
      spriteScaleWrites,
      devicePixelsPerTexturePixel: [1, 2, 3].map((k) => k / GLYPH_RASTER_SCALE),
    }).toEqual({ rasterScale: 1, spriteScaleWrites: [[1, 1]], devicePixelsPerTexturePixel: [1, 2, 3] });
    layer.destroy();
  });

  it('draws no printer glyph or graphic for a verification milestone, which the QA wall screen shows instead', () => {
    const glyphs: string[] = [];
    const art = { glyph: (text: string) => { glyphs.push(text); return { texture: {}, width: 17 }; } };
    const canvas = document.createElement('canvas');
    const layer = createEffectLayer(art as never, canvas);
    layer.drawMilestones(1_000, false, false, {
      printer: { id: 1, kind: 'verify_failed', startedAt: 1_000, beadId: 'ov-5', reduced: false }, merged: null,
    });
    expect({ glyphs, children: layer.root.children.length, printerAt: canvas.dataset.officePrinterAt, printerEffect: canvas.dataset.officePrinterEffect })
      .toEqual({ glyphs: [], children: 2, printerAt: undefined, printerEffect: undefined });
    layer.destroy();
  });

  it('starts a hop at zero height', () => {
    expect(hopOffset(0)).toBe(0);
  });

  it('reaches the 18 px hop peak at 300 ms', () => {
    expect(hopOffset(300)).toBe(18);
  });

  it('ends a hop at zero height after 600 ms', () => {
    expect(hopOffset(600)).toBe(0);
  });

  it('routes a verified bead to the board before its hop', () => {
    const spot = SPOTS.find((candidate) => candidate.id === 'desk-1')!;
    const routed = routePassedAgentToBoard(createAgent(passSession, { id: spot.id, type: 'desk', x: spot.x, y: spot.y, spriteFacing: spot.f }));
    expect([routed.pose, routed.targetPosition, routed.pathQueue.at(-1), routed.spriteFacing]).toEqual([
      'walking', { x: BOARD_SPOT.x, y: BOARD_SPOT.y }, { x: BOARD_SPOT.x, y: BOARD_SPOT.y }, BOARD_SPOT.f,
    ]);
  });

  it('faces a merge hop toward the board, keeping its own front or rear when the board is straight across the screen', () => {
    const spot = assignSpot('worker', new Set())!;
    // One tile +i and one tile −j from the board: the front/rear component is zero or float noise.
    const across = { x: BOARD_SPOT.x - 1, y: BOARD_SPOT.y + 1 };
    const agents = (['front-left', 'rear-left'] as const).map((spriteFacing, index) => ({
      ...createAgent({ ...passSession, session_id: `s${index}` }, spot), pose: 'arrived' as const, position: { ...across }, spriteFacing,
    }));
    const clear = { ...createAgent({ ...passSession, session_id: 's2' }, spot), pose: 'arrived' as const, position: { x: BOARD_SPOT.x - 3, y: BOARD_SPOT.y + 5 }, spriteFacing: 'front-left' as const };
    const layer = createEffectLayer({ glyph: () => ({ texture: {}, width: 17 }) } as never, document.createElement('canvas'));
    layer.drawAgents([...agents, clear], 1_000, false, false, false, {
      printer: null, merged: { id: 1, kind: 'merged', startedAt: 1_000, beadId: null, reduced: false },
    }, () => 1);
    expect([...agents, clear].map((agent) => layer.motionFor(agent, 1_000, false, false).facing)).toEqual(['front-right', 'rear-right', 'rear-right']);
    layer.destroy();
  });

  it('draws no confetti when a merge arrives under reduced motion', () => {
    expect(confettiAt(1_000, 0, true)).toEqual([]);
  });

  it('creates the handoff count of confetti pieces for a merge', () => {
    expect(confettiAt(0, 0)).toHaveLength(90);
  });
});
