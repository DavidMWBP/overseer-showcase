import { describe, expect, it, vi } from 'vitest';
import { createScene, HOVER_MATRIX } from './scene';
import type { OfficeSceneEffects } from './effects';
import { sceneColorMatrix } from './lights';
import type { OfficeSession } from '@overseer/shared';
import type { SceneFrame } from '../officeModel';
import type { Agent } from '../types';
import { deriveScene } from '../officeModel';
import { SceneSim } from '../sceneSim';
import { furnitureSpritePlacements } from './furniture';
import { FURN, p, SPOTS } from './world';
import { initialOfficeViewport, visibleWorld } from './viewport';
import { furniturePieces } from './furniture';

type Layer = { label?: string; alpha?: number; children: Layer[]; filters?: { matrix: number[] }[] };
const walkingSession: OfficeSession = {
  session_id: 'walking', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-1', bead_title: 'Walking task', batch_id: null, repo_id: 'r1', state: 'walking_in', stalled_since: null,
};
const agent = (over: Partial<Agent>): Agent => ({
  id: 'a', role: 'worker', harness: 'claude', model: null, resolvedModel: null, beadId: 'ov-1', beadTitle: 'Task', state: 'working',
  labelText: 'claude', pose: 'arrived', stalledSince: null, stalled: false, position: { x: 0, y: 0 }, targetPosition: { x: 0, y: 0 },
  deskPosition: { x: 0, y: 0 }, assignedSpotId: 'desk-1', spriteFacing: 'front-left',
  charBase: 'c1', pathQueue: [], ...over,
} as Agent);
const displayObjects: Record<string, unknown>[] = [];

/** A chainable stand-in for every Pixi display object: any method returns the object, any field can be set. */
function displayObject(): Record<string, unknown> {
  const target: Record<string, unknown> = { children: [], position: { set: vi.fn() }, scale: { set: vi.fn(), x: 1 }, anchor: { set: vi.fn() }, pivot: { set: vi.fn() } };
  displayObjects.push(target);
  const proxy: Record<string, unknown> = new Proxy(target, {
    get: (object, key: string) => key in object ? object[key] : (key === 'then' ? undefined : () => proxy),
    set: (object, key: string, value) => { object[key] = value; return true; },
  });
  target.addChild = (...children: unknown[]) => { (target.children as unknown[]).push(...children); return children[0]; };
  // Pixi event handlers, so a test can tap a display.
  const handlers: Record<string, () => void> = {};
  target.handlers = handlers;
  target.on = (event: string, handler: () => void) => { handlers[event] = handler; return proxy; };
  return proxy;
}

const apps: { stage: Record<string, unknown>; renderer: { resize: ReturnType<typeof vi.fn>; resolution: number }; initOptions?: Record<string, unknown>; destroy: ReturnType<typeof vi.fn>; ticker: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; start: () => void; started: boolean }; canvas: HTMLCanvasElement }[] = [];
vi.mock('pixi.js', () => {
  class Application {
    canvas = document.createElement('canvas');
    stage = displayObject();
    renderer = { resize: vi.fn(), resolution: 1 };
    initOptions?: Record<string, unknown>;
    ticker = { add: vi.fn(), remove: vi.fn(), stop: vi.fn(function (this: { started: boolean }) { this.started = false; }), start: function (this: { started: boolean }) { this.started = true; }, started: false };
    destroy = vi.fn(() => this.canvas.remove());
    render = () => {};
    async init(options: Record<string, unknown>) { this.initOptions = options; this.renderer.resolution = Number(options.resolution); apps.push(this as unknown as typeof apps[number]); }
  }
  const DisplayObject = function () { return displayObject(); } as unknown as new () => unknown;
  class BufferImageSource {
    constructor(options: Record<string, unknown>) { Object.assign(this, options); }
  }
  class Texture {
    source: Record<string, unknown>;
    constructor(options: { source: Record<string, unknown> }) { this.source = options.source; }
  }
  // A sprite keeps the texture it was made with, so a test can tell which file a piece shows.
  const Sprite = function (texture?: unknown) { const sprite = displayObject(); if (texture) sprite.texture = texture; return sprite; } as unknown as new () => unknown;
  // A colour matrix filter keeps the options it was made with, so a test can read its resolution.
  const ColorMatrixFilter = function (options?: unknown) { const filter = displayObject(); filter.colorMatrixOptions = options ?? {}; return filter; } as unknown as new () => unknown;
  return { Application, Container: DisplayObject, Graphics: DisplayObject, AnimatedSprite: DisplayObject, Sprite, Texture, BufferImageSource, ColorMatrixFilter, Rectangle: class { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} } };
});
const missingTextures = vi.hoisted(() => new Set<string>());
const placeholderChars = vi.hoisted(() => new Set<string>());
vi.mock('./assets', () => ({ ROOM_DAY: 'room/layout2-day', ROOM_NIGHT_WINDOWS: 'room/layout2-night-windows', loadOfficeArt: async () => ({ frames: () => [{}], fromAtlas: (char: string) => !placeholderChars.has(char), glyph: () => undefined, texture: (key: string) => missingTextures.has(key) ? undefined : ({ key, width: 1, height: 1, source: { scaleMode: 'nearest' } }), destroy: vi.fn() }) }));

describe('Pixi office scene', () => {
  // A filter defaults to resolution 1: at dpr 2 the night grade and the hover highlight would render their runs at half
  // the device resolution and be scaled back up with linear sampling, blurring every filtered sprite.
  it('renders the night colour matrix and the hover highlight at the render target resolution', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const before = displayObjects.length;
    const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
    const filters = displayObjects.slice(before).filter((display) => 'colorMatrixOptions' in display);
    expect(filters.map((filter) => filter.colorMatrixOptions)).toEqual([{ resolution: 'inherit' }, { resolution: 'inherit' }]);
    scene.destroy();
  });

  it('uses the real device density and applies a resized pixel-aligned viewport', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
      const app = apps.at(-1)!;
      expect(app.initOptions).toMatchObject({ resolution: 3, autoDensity: true, antialias: false, roundPixels: true });
      const viewport = initialOfficeViewport(810, 510, 3);
      scene.setViewport(viewport);
      const world = (app.stage.children as Array<{ scale: { set: ReturnType<typeof vi.fn> }; position: { set: ReturnType<typeof vi.fn> } }>)[0]!;
      expect({
        rendererResolution: app.renderer.resolution,
        resize: app.renderer.resize.mock.calls.at(-1),
        scale: world.scale.set.mock.calls.at(-1),
        position: world.position.set.mock.calls.at(-1),
        cssSize: [app.canvas.style.width, app.canvas.style.height],
      }).toEqual({
        rendererResolution: 3,
        resize: [viewport.canvasWidth, viewport.canvasHeight],
        scale: [viewport.scale],
        position: [viewport.x, viewport.y],
        cssSize: [`${viewport.canvasWidth}px`, `${viewport.canvasHeight}px`],
      });
      scene.destroy();
    } finally {
      if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
      else Reflect.deleteProperty(window, 'devicePixelRatio');
    }
  });

  it.each([
    { k: 1, dpr: 1, width: 1680, height: 1056, deviceX: 412 },
    { k: 2, dpr: 2, width: 1120, height: 704, deviceX: 825 },
  ])('rounds a sprite at world x = 412.37 onto the device grid at k = $k', async ({ k, dpr, width, height, deviceX }) => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
      const viewport = initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, false);
      scene.setViewport(viewport);
      const y = 2.5;
      const x = (412.37 - 696) / 48 + y;
      const walker = agent({ id: `pixel-${k}`, pose: 'walking', position: { x, y }, targetPosition: { x: x + 1, y } });
      const frame = { agents: [walker], props: { room: { furniture: [] } } } as unknown as SceneFrame;
      scene.draw(frame, 0, true);
      const root = displayObjects.find((display) => display.label === walker.id)!;
      const drawnX = ((root.position as { set: ReturnType<typeof vi.fn> }).set.mock.calls.at(-1) as number[])[0]!;

      expect({
        roundPixels: apps.at(-1)!.initOptions?.roundPixels,
        pixelScale: viewport.pixelScale,
        drawnWorldX: drawnX,
        devicePixelX: Math.round(drawnX * viewport.pixelScale),
      }).toEqual({ roundPixels: true, pixelScale: k, drawnWorldX: 412.37, devicePixelX: deviceX });
      scene.destroy();
      host.remove();
    } finally {
      if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
      else Reflect.deleteProperty(window, 'devicePixelRatio');
    }
  });

  it('keeps a walking agent’s fractional simulation position when the scene draws it', async () => {
    const simulated = SceneSim.step(deriveScene([walkingSession], null), 1, 16.67);
    const position = { ...simulated.agents[0]!.position };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const scene = await createScene(host, { reduced: () => false, onTap: () => {} });

    scene.draw(simulated, 16.67, false);

    expect({
      pose: simulated.agents[0]!.pose,
      position: simulated.agents[0]!.position,
      fractional: !Number.isInteger(position.x) && !Number.isInteger(position.y),
    }).toEqual({ pose: 'walking', position, fractional: true });
    scene.destroy();
    host.remove();
  });

  it('names each character’s frames and whether they come from the atlas or the placeholder on the canvas', async () => {
    const frame = deriveScene([walkingSession, { ...walkingSession, session_id: 'orch', role: 'orchestrator', bead_id: null }], null);
    const [worker, orchestrator] = frame.agents;
    placeholderChars.add(orchestrator!.charBase);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
    const canvas = apps.at(-1)!.canvas;
    try {
      scene.draw(frame, 0, false);
      expect(canvas.dataset.officeCharacterArt?.split(' ')).toEqual([
        expect.stringMatching(new RegExp(`^${worker!.id}=${worker!.charBase}/(walk|type|idle)/(front|rear):atlas$`)),
        expect.stringMatching(new RegExp(`^${orchestrator!.id}=${orchestrator!.charBase}/(walk|type|idle)/(front|rear):placeholder$`)),
      ]);
      scene.draw(deriveScene([], null), 16, false);
      expect(canvas.dataset.officeCharacterArt).toBe('');
    } finally {
      placeholderChars.clear();
      scene.destroy();
      host.remove();
    }
  });

  it('applies the night colour matrix to the room, night windows, furniture and characters, and not to a lit overlay', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
    const frame = { agents: [], props: { room: { furniture: [] } } } as unknown as SceneFrame;
    scene.draw(frame, 0, true, 1);
    const world = (apps.at(-1)!.stage.children as Layer[])[0]!;
    const entities = world.children[0]!;
    const runs = entities.children.filter((child) => child.children.length > 0);
    const lit = entities.children.filter((child) => child.children.length === 0);
    expect({
      backgrounds: runs[0]!.children.slice(0, 2).map((child) => child.label),
      floorGrade: runs[0]!.children.slice(2, 4).map((child) => [child.label, child.alpha]),
      runs: runs.map((run) => run.filters?.[0]?.matrix),
      lit: lit.map((overlay) => 'filters' in overlay),
      shownLit: lit.length > 0,
    }).toEqual({
      backgrounds: ['room-day', 'room-night-windows'],
      floorGrade: [['office-floor-grade-lab', 1], ['office-floor-grade-review', 1]],
      runs: runs.map(() => sceneColorMatrix(1)),
      lit: lit.map(() => false),
      shownLit: true,
    });
    scene.destroy();
  });

  it('sorts a lit monitor between its desk monitor and a character walking in front of that desk', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
    const seatedSpot = SPOTS.find((spot) => spot.id === 'desk-1')!;
    const seated = agent({ id: 'seated', assignedSpotId: 'desk-1', pose: 'arrived', state: 'working', position: { x: seatedSpot.x, y: seatedSpot.y }, deskPosition: { x: seatedSpot.x, y: seatedSpot.y } });
    // In the cross aisle in front of desk-1's pod (j 6); its depth 4 + 6 is in front of the monitor's 7.345.
    const walker = agent({ id: 'walker', assignedSpotId: 'desk-4', pose: 'walking', state: 'walking_in', position: { x: 4, y: 6 }, targetPosition: { x: 3.5, y: 6 } });
    const frame = { agents: [seated, walker], props: { room: { furniture: [] } } } as unknown as SceneFrame;
    scene.draw(frame, 0, true, 1);
    const entities = (apps.at(-1)!.stage.children as Layer[])[0]!.children[0]!;
    const position = (match: (child: Layer, inRun: boolean) => boolean) => entities.children.findIndex((child) =>
      child.children.length === 0 ? match(child, false) : child.children.some((item) => match(item, true)));
    const order = {
      monitor: position((child, inRun) => inRun && child.label === 'monitor-desk-1'),
      lit: position((child, inRun) => !inRun && child.label === 'monitor-desk-1'),
      walker: position((child, inRun) => inRun && child.label === 'walker'),
    };
    expect(order.monitor < order.lit && order.lit < order.walker).toBe(true);
    scene.destroy();
  });

  describe('count objects', () => {
    const empty = { ready: [], blocked: [], running: [], verifying: [], review: [], done: [] };
    const roomProps = { questions: 1, reviewBatches: ['r1/r1-b1'], columns: { ...empty, ready: ['ov-1'] }, reviewReady: null };
    /** Every entity label in draw order, each with the colour matrix of the run it is drawn in. */
    const drawOrder = () => ((apps.at(-1)!.stage.children as Layer[])[0]!.children[0]!).children.flatMap((child) => child.children.length === 0
      ? [{ label: child.label, matrix: undefined as number[] | undefined }]
      : child.children.map((item) => ({ label: item.label, matrix: child.filters?.[0]?.matrix })));

    it('draws a character walking in front of the whiteboard and the meeting table after them', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
      // Just in front of the right wall under the whiteboard (depth 8.1 > 0), and on the room side of the meeting table (27.6 > its 25.64).
      const byBoard = agent({ id: 'by-board', assignedSpotId: 'desk-4', pose: 'walking', state: 'walking_in', position: { x: 7.5, y: 0.6 }, targetPosition: { x: 8, y: 0.6 } });
      const byTable = agent({ id: 'by-table', assignedSpotId: 'desk-5', pose: 'walking', state: 'walking_in', position: { x: 16, y: 11.6 }, targetPosition: { x: 16.5, y: 11.6 } });
      scene.draw({ agents: [byBoard, byTable], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, false, 0, undefined, false, roomProps);
      const labels = drawOrder().map((entry) => entry.label);
      expect({
        board: labels.indexOf('prop-board') < labels.indexOf('by-board'),
        note: labels.indexOf('prop-note-ov-1') < labels.indexOf('by-board'),
        folder: labels.indexOf('prop-folder-r1/r1-b1') < labels.indexOf('by-table'),
        table: labels.findIndex((label) => label?.startsWith('meeting-table')) < labels.indexOf('prop-folder-r1/r1-b1'),
      }).toEqual({ board: true, note: true, folder: true, table: true });
      scene.destroy();
    });

    it("draws the question note after the orchestrator's monitors and before a character walking in front of the desk", async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
      const desk = FURN.find((furniture) => furniture.kind === 'desk-orch')!;
      const front = desk.j + desk.d + 0.3;
      const walker = agent({ id: 'front-of-desk', assignedSpotId: 'desk-4', pose: 'walking', state: 'walking_in', position: { x: desk.i + 1.2, y: front }, targetPosition: { x: desk.i + 1.7, y: front } });
      scene.draw({ agents: [walker], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, false, 0, undefined, false, roomProps);
      const labels = drawOrder().map((entry) => entry.label);
      const monitors = labels.findIndex((label) => label?.startsWith('monitor-') && label.includes('orch'));
      expect(monitors < labels.indexOf('prop-question-note') && labels.indexOf('prop-question-note') < labels.indexOf('front-of-desk')).toBe(true);
      scene.destroy();
    });

    it('takes the night colour matrix like the other furniture', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
      scene.draw({ agents: [], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, true, 1, undefined, false, roomProps);
      const props = drawOrder().filter((entry) => entry.label?.startsWith('prop-'));
      expect({ labels: props.map((entry) => entry.label), night: props.every((entry) => JSON.stringify(entry.matrix) === JSON.stringify(sceneColorMatrix(1))) })
        .toEqual({ labels: expect.arrayContaining(['prop-board', 'prop-note-ov-1', 'prop-question-note', 'prop-folder-r1/r1-b1', 'prop-header-ready']), night: true });
      scene.destroy();
    });

    it('puts the objects\' hit areas under every character, at least 24 CSS px, and routes a tap and a hover', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const taps: string[] = [];
      const hovers: (string | null)[] = [];
      const scene = await createScene(host, { reduced: () => true, onTap: () => {}, onPropTap: (prop) => taps.push(prop), onPropHover: (prop) => hovers.push(prop), minHitPx: () => 24 });
      const viewport = initialOfficeViewport(420, 264, 3, { x: 0, y: 0 }); // 1/3 CSS px per world px: the question box is under 24 CSS px
      scene.setViewport(viewport);
      const byBoard = agent({ id: 'by-board', assignedSpotId: 'desk-4', pose: 'walking', state: 'walking_in', position: { x: 7.5, y: 0.6 }, targetPosition: { x: 8, y: 0.6 } });
      scene.draw({ agents: [byBoard], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, true, 0, undefined, false, roomProps);
      const labels = drawOrder().map((entry) => entry.label);
      const hit = displayObjects.filter((display) => display.label === 'prop-hit-questions').at(-1) as { hitArea: { width: number; height: number }; handlers: Record<string, () => void>; eventMode: string };
      hit.handlers.pointertap!();
      hit.handlers.pointerover!();
      hit.handlers.pointerout!();
      expect({
        underEverything: ['prop-hit-questions', 'prop-hit-review', 'prop-hit-board'].every((label) => labels.indexOf(label) < labels.indexOf('by-board') && labels.indexOf(label) < labels.indexOf('prop-board')),
        interactive: hit.eventMode,
        minCss: Math.min(hit.hitArea.width, hit.hitArea.height) * viewport.scale >= 24 - 1e-9,
        taps, hovers,
      }).toEqual({ underEverything: true, interactive: 'static', minCss: true, taps: ['questions'], hovers: ['questions', null] });
      scene.destroy();
    });

    it('reports the drawn counts on the canvas', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
      scene.draw({ agents: [], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, true, 0, undefined, false, roomProps);
      expect(apps.at(-1)!.canvas.dataset.officeRoomProps).toBe('questions=1 review=1 board=1,0,0,0,0,0');
      scene.destroy();
    });

    it('draws the Done id and count received from the Office props', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
      const withDoneToday = { ...roomProps, columns: { ...roomProps.columns, done: ['r1/ov-done-today'] } };
      scene.draw({ agents: [], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, true, 0, undefined, false, withDoneToday);
      const note = displayObjects.filter((display) => display.label === 'prop-note-r1/ov-done-today').at(-1) as { texture: { key: string } };
      expect({ note: note.texture.key, counts: apps.at(-1)!.canvas.dataset.officeRoomProps }).toEqual({
        note: 'props/note-done', counts: 'questions=1 review=1 board=1,0,0,0,0,1',
      });
      scene.destroy();
    });

    describe('hover', () => {
      type Hoverable = {
        label?: string; cursor?: string; filters?: { matrix?: number[] }[];
        position: { set: ReturnType<typeof vi.fn> }; scale: { set: ReturnType<typeof vi.fn> };
        handlers: Record<string, (event?: { pointerType: string }) => void>;
      };
      const mouse = { pointerType: 'mouse' };
      const latest = (label: string) => displayObjects.filter((display) => display.label === label).at(-1) as unknown as Hoverable;
      const lit = (label: string) => (latest(label).filters ?? []).some((filter) => JSON.stringify(filter.matrix) === JSON.stringify(HOVER_MATRIX));
      const TARGETS = ['worker', 'prop-question-note', 'prop-folder-r1/r1-b1', 'prop-board', 'prop-note-ov-1', 'prop-header-ready'];
      // Standing just in front of the whiteboard, as in the depth-order case above.
      const worker = agent({ id: 'worker', assignedSpotId: 'desk-4', pose: 'walking', state: 'walking_in', position: { x: 7.5, y: 0.6 }, targetPosition: { x: 8, y: 0.6 } });
      const frame = (agents: Agent[]) => ({ agents, props: { room: { furniture: [] } } } as unknown as SceneFrame);

      async function hoverScene(hoverable?: () => boolean) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const hovers: (string | null)[] = [];
        const scene = await createScene(host, { reduced: () => true, onTap: () => {}, onPropTap: () => {}, onPropHover: (prop) => hovers.push(prop), ...(hoverable ? { hoverable } : {}) });
        scene.draw(frame([worker]), 0, true, 0, undefined, false, roomProps);
        const app = apps.at(-1)!;
        return {
          scene, hovers, app,
          target: () => app.canvas.dataset.officeHover,
          highlighted: () => TARGETS.filter(lit),
          over: (label: string, event = mouse) => latest(label).handlers.pointerover!(event),
          out: (label: string) => latest(label).handlers.pointerout!(mouse),
        };
      }

      it('highlights a worker under the pointer, and nothing else, with a pointer cursor', async () => {
        const { scene, hovers, target, highlighted, over } = await hoverScene();
        over('worker');
        expect({ target: target(), highlighted: highlighted(), hovers, cursor: latest('worker').cursor }).toEqual({ target: 'agent:worker', highlighted: ['worker'], hovers: [], cursor: 'pointer' });
        scene.destroy();
      });

      it.each([
        { prop: 'questions', drawn: ['prop-question-note'] },
        { prop: 'review', drawn: ['prop-folder-r1/r1-b1'] },
        { prop: 'board', drawn: ['prop-board', 'prop-note-ov-1', 'prop-header-ready'] },
      ])('highlights every piece of the $prop object under the pointer, with a pointer cursor, and reports it for the chip', async ({ prop, drawn }) => {
        const { scene, hovers, target, highlighted, over } = await hoverScene();
        over(`prop-hit-${prop}`);
        expect({ target: target(), highlighted: highlighted(), hovers, cursor: latest(`prop-hit-${prop}`).cursor })
          .toEqual({ target: `prop:${prop}`, highlighted: drawn, hovers: [prop], cursor: 'pointer' });
        scene.destroy();
      });

      it('gives the hover to a character standing in front of an object, whichever arrives first', async () => {
        const { scene, hovers, target, highlighted, over } = await hoverScene();
        over('prop-hit-board');
        over('worker');
        const characterSecond = { target: target(), highlighted: highlighted(), hovers: [...hovers] };
        latest('worker').handlers.pointerout!(mouse);
        over('worker');
        over('prop-hit-board');
        expect({ characterSecond, objectSecond: { target: target(), highlighted: highlighted() } }).toEqual({
          characterSecond: { target: 'agent:worker', highlighted: ['worker'], hovers: ['board', null] },
          objectSecond: { target: 'agent:worker', highlighted: ['worker'] },
        });
        scene.destroy();
      });

      it('highlights nothing and leaves the canvas cursor alone over empty floor', async () => {
        const { scene, hovers, target, highlighted, app } = await hoverScene();
        expect({ target: target(), highlighted: highlighted(), hovers, cursor: app.canvas.style.cursor }).toEqual({ target: '', highlighted: [], hovers: [], cursor: '' });
        scene.destroy();
      });

      it('clears the highlight when the pointer leaves the canvas', async () => {
        const { scene, hovers, target, highlighted, over, out } = await hoverScene();
        over('worker');
        out('worker');
        const afterCharacter = { target: target(), highlighted: highlighted() };
        over('prop-hit-board');
        out('prop-hit-board');
        expect({ afterCharacter, afterObject: { target: target(), highlighted: highlighted() }, hovers })
          .toEqual({ afterCharacter: { target: '', highlighted: [] }, afterObject: { target: '', highlighted: [] }, hovers: ['board', null] });
        scene.destroy();
      });

      it('holds the highlight while a drag pans the room and takes the target under the pointer when it ends', async () => {
        const { scene, hovers, target, highlighted, over, out } = await hoverScene();
        over('worker');
        scene.setPanning(true);
        out('worker');
        over('prop-hit-board');
        const during = { target: target(), highlighted: highlighted(), hovers: [...hovers] };
        scene.setPanning(false);
        expect({ during, after: { target: target(), highlighted: highlighted(), hovers } }).toEqual({
          during: { target: 'agent:worker', highlighted: ['worker'], hovers: [] },
          after: { target: 'prop:board', highlighted: ['prop-board', 'prop-note-ov-1', 'prop-header-ready'], hovers: ['board'] },
        });
        scene.destroy();
      });

      it('clears the highlight of a hovered character that leaves the room, during a pan too', async () => {
        const { scene, target, over } = await hoverScene();
        over('worker');
        scene.draw(frame([]), 1, true, 0, undefined, false, roomProps);
        const gone = target();
        scene.draw(frame([worker]), 2, true, 0, undefined, false, roomProps);
        over('worker');
        scene.setPanning(true);
        scene.draw(frame([]), 3, true, 0, undefined, false, roomProps);
        expect({ gone, goneDuringPan: target() }).toEqual({ gone: '', goneDuringPan: '' });
        scene.destroy();
      });

      it('changes only the filters of the hovered character: no move, no resize, no animation', async () => {
        const { scene, app, over, out } = await hoverScene();
        const root = latest('worker');
        const before = { position: root.position.set.mock.calls.length, scale: root.scale.set.mock.calls.length, loop: app.ticker.add.mock.calls.length };
        over('worker');
        out('worker');
        expect({ position: root.position.set.mock.calls.length, scale: root.scale.set.mock.calls.length, loop: app.ticker.add.mock.calls.length, started: app.ticker.started })
          .toEqual({ ...before, started: false });
        scene.destroy();
      });

      it('does not hover for a touch pointer or while hover is off (the phone layout)', async () => {
        const touch = await hoverScene();
        touch.over('worker', { pointerType: 'touch' });
        touch.over('prop-hit-board', { pointerType: 'touch' });
        const touched = { target: touch.target(), highlighted: touch.highlighted(), hovers: touch.hovers };
        touch.scene.destroy();
        const phone = await hoverScene(() => false);
        phone.over('worker');
        phone.over('prop-hit-board');
        expect({ touched, phone: { target: phone.target(), highlighted: phone.highlighted(), hovers: phone.hovers } }).toEqual({
          touched: { target: '', highlighted: [], hovers: [] },
          phone: { target: '', highlighted: [], hovers: [] },
        });
        phone.scene.destroy();
      });
    });
  });

  describe('touch targets', () => {
    const empty = { ready: [], blocked: [], running: [], verifying: [], review: [], done: [] };
    const roomProps = { questions: 1, reviewBatches: ['r1/r1-b1'], columns: { ...empty, ready: ['ov-1'] }, reviewReady: null };
    type Tappable = { label?: string; eventMode?: string; hitArea?: { x: number; y: number; width: number; height: number }; handlers: Record<string, (event?: unknown) => void> };
    const latest = (label: string) => displayObjects.filter((display) => display.label === label).at(-1) as unknown as Tappable;
    // Two neighbours one tile apart along i, and a worker in front of the whiteboard, as in the depth-order case above.
    const first = agent({ id: 'first', assignedSpotId: 'desk-4', pose: 'walking', state: 'walking_in', position: { x: 4, y: 6 }, targetPosition: { x: 4, y: 6 } });
    const second = agent({ id: 'second', beadId: 'ov-2', assignedSpotId: 'desk-5', pose: 'walking', state: 'walking_in', position: { x: 5, y: 6 }, targetPosition: { x: 5, y: 6 } });
    const byBoard = agent({ id: 'by-board', beadId: 'ov-3', assignedSpotId: 'desk-6', pose: 'walking', state: 'walking_in', position: { x: 7.5, y: 0.6 }, targetPosition: { x: 7.5, y: 0.6 } });
    const touchEvent = (x: number, y: number) => ({ pointerType: 'touch', getLocalPosition: () => ({ x, y }) });

    async function touchScene(coarse: boolean) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const taps: string[] = [];
      const propTaps: string[] = [];
      const scene = await createScene(host, {
        reduced: () => true, onTap: (id) => taps.push(id), onPropTap: (prop) => propTaps.push(prop),
        minHitPx: () => (coarse ? 44 : 24), characterMinHitPx: () => (coarse ? 44 : 0),
      });
      // A 366 px phone stage at dpr 3: about 0.22 CSS px per world px, where HIT_AREA is 11 x 21 CSS px.
      const viewport = initialOfficeViewport(366, 230, 3, { x: 0, y: 0 }, true);
      scene.setViewport(viewport);
      scene.draw({ agents: [first, second, byBoard], props: { room: { furniture: [] } } } as unknown as SceneFrame, 0, true, 0, undefined, false, roomProps);
      return { scene, taps, propTaps, scale: viewport.scale };
    }

    it('gives every character and object a target of at least 44 x 44 CSS px on a coarse pointer at the phone scale', async () => {
      const { scene, scale } = await touchScene(true);
      const sides = ['first', 'second', 'by-board', 'prop-hit-questions', 'prop-hit-review', 'prop-hit-board'].map((label) => {
        const area = latest(label).hitArea!;
        return [label, Math.min(area.width, area.height) * scale >= 44 - 1e-9];
      });
      expect({ scaleBelowOne: scale < 0.5, sides }).toEqual({ scaleBelowOne: true, sides: sides.map(([label]) => [label, true]) });
      scene.destroy();
    });

    it('opens the second character when a tap in both targets is nearer its centre, whichever target Pixi reports', async () => {
      const { scene, taps } = await touchScene(true);
      const [x1, y1] = p(first.position.x, first.position.y);
      const [x2, y2] = p(second.position.x, second.position.y);
      // 5 world px off the second's target centre, towards the first: inside both 44 px targets.
      const point = { x: x2 + (x1 - x2) * (5 / Math.hypot(x1 - x2, y1 - y2)), y: y2 - 42 + (y1 - y2) * (5 / Math.hypot(x1 - x2, y1 - y2)) };
      latest('first').handlers.pointertap!(touchEvent(point.x, point.y));
      latest('second').handlers.pointertap!(touchEvent(point.x, point.y));
      // And 5 px off the first's centre, reported on the second.
      latest('second').handlers.pointertap!(touchEvent(x1 + (x2 - x1) * (5 / Math.hypot(x1 - x2, y1 - y2)), y1 - 42 + (y2 - y1) * (5 / Math.hypot(x1 - x2, y1 - y2))));
      expect(taps).toEqual(['second', 'second', 'first']);
      scene.destroy();
    });

    it('opens a character standing in front of an object: its target is drawn over the object\'s hit area', async () => {
      const { scene, taps, propTaps } = await touchScene(true);
      const entities = ((apps.at(-1)!.stage.children as Layer[])[0]!.children[0]!).children.flatMap((child) => child.children.length === 0 ? [child] : child.children);
      const labels = entities.map((entry) => entry.label);
      const [bx, by] = p(byBoard.position.x, byBoard.position.y);
      latest('by-board').handlers.pointertap!(touchEvent(bx, by - 42));
      expect({ characterOnTop: labels.indexOf('prop-hit-board') < labels.indexOf('by-board'), taps, propTaps }).toEqual({ characterOnTop: true, taps: ['by-board'], propTaps: [] });
      scene.destroy();
    });

    it('opens nothing from empty floor: only characters and the objects\' hit areas take a tap', async () => {
      const before = displayObjects.length;
      const { scene, taps, propTaps } = await touchScene(true);
      const tappable = displayObjects.slice(before).filter((display) => 'pointertap' in (display.handlers as Record<string, unknown>)).map((display) => display.label);
      expect({ tappable: [...new Set(tappable)].sort(), taps, propTaps })
        .toEqual({ tappable: ['by-board', 'first', 'prop-hit-board', 'prop-hit-questions', 'prop-hit-review', 'second'], taps: [], propTaps: [] });
      scene.destroy();
    });

    it('fits a coarse target at the stage edge inside the stage after a pan, and keeps HIT_AREA on a fine pointer', async () => {
      const areas: Record<string, unknown> = {};
      for (const coarse of [true, false]) {
        const { scene } = await touchScene(coarse);
        // Panned so the stage's left edge is 10 world px left of the first character's feet.
        const [fx] = p(first.position.x, first.position.y);
        const base = initialOfficeViewport(800, 500, 1, { x: 0, y: 0 });
        const panned = { ...base, x: -(fx - 10) * base.scale - base.originX };
        scene.setViewport(panned);
        const shown = visibleWorld(panned);
        const area = latest('first').hitArea!;
        const left = fx + area.x;
        areas[coarse ? 'coarse' : 'fine'] = {
          leftEdge: left === shown.left, inside: left >= shown.left && left + area.width <= shown.right,
          side: Math.min(area.width, area.height) * panned.scale >= 44 - 1e-9, widthCss: Math.round(area.width * panned.scale * 1000) / 1000,
          scale: panned.scale,
        };
        scene.destroy();
      }
      const scale = (areas.coarse as { scale: number }).scale;
      expect(areas).toEqual({
        coarse: { leftEdge: true, inside: true, side: true, widthCss: 44, scale },
        fine: { leftEdge: false, inside: false, side: 52 * scale >= 44, widthCss: Math.round(52 * scale * 1000) / 1000, scale },
      });
    });

    it('keeps HIT_AREA and the tapped character on a fine pointer', async () => {
      const { scene, taps } = await touchScene(false);
      const [x2, y2] = p(second.position.x, second.position.y);
      latest('first').handlers.pointertap!({ pointerType: 'mouse', getLocalPosition: () => ({ x: x2, y: y2 - 42 }) });
      expect({ area: latest('first').hitArea, taps }).toEqual({ area: expect.objectContaining({ x: -26, y: -90, width: 52, height: 96 }), taps: ['first'] });
      scene.destroy();
    });
  });

  describe('QA wall screen', () => {
    const session = (id: string, state: OfficeSession['state']): OfficeSession => ({ ...walkingSession, session_id: id, bead_id: `ov-${id}`, state });
    const room = (...sessions: OfficeSession[]) => deriveScene(sessions, null);
    const verifying = room(session('a', 'verifying'));
    const idle = room();
    const mark = (kind: 'verify_passed' | 'verify_failed', startedAt: number, id = 1): OfficeSceneEffects => ({
      printer: { id, kind, startedAt, beadId: 'ov-a', reduced: false }, merged: null,
    });
    type Display = { label?: string; visible?: boolean; alpha?: number; zIndex?: number; texture?: { key: string } };

    async function qaScene(reduced = false) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const before = displayObjects.length;
      const scene = await createScene(host, { reduced: () => reduced, onTap: () => {} });
      const canvas = apps.at(-1)!.canvas;
      const displays = displayObjects.slice(before) as Display[];
      const qa = displays.filter((display) => display.label === 'qa-screen');
      const isLit = (display: Display) => display.texture?.key.endsWith('-lit') === true;
      return {
        scene,
        state: () => canvas.dataset.officeQaScreen,
        /** The piece's shown sprite, by texture key, or `graphics` for its fallback. */
        shown: () => qa.filter((display) => !isLit(display) && display.visible !== false).map((display) => display.texture?.key ?? 'graphics'),
        lit: () => qa.filter((display) => isLit(display) && (display.alpha ?? 0) > 0).map((display) => [display.texture!.key, display.alpha, display.zIndex]),
        done: () => { scene.destroy(); host.remove(); },
      };
    }
    const states = (draw: (at: number) => string | undefined, times: number[]) => times.map(draw);

    it('shows the idle chart when nobody verifies', async () => {
      const qa = await qaScene();
      qa.scene.draw(idle, 0, false);
      expect({ state: qa.state(), shown: qa.shown() }).toEqual({ state: 'on', shown: ['furniture/wall-screen-on'] });
      qa.done();
    });

    it('advances running-0, 1, 2, 3 and back to 0 every 250 ms while one agent verifies', async () => {
      const qa = await qaScene();
      const seen = states((at) => { qa.scene.draw(verifying, at, false); return qa.shown()[0]; }, [0, 250, 500, 750, 1_000]);
      expect(seen).toEqual(['running-0', 'running-1', 'running-2', 'running-3', 'running-0'].map((state) => `furniture/wall-screen-${state}`));
      qa.done();
    });

    it('keeps running while one of two verifying agents ends without a mark, and goes idle when both have ended', async () => {
      const qa = await qaScene();
      qa.scene.draw(room(session('a', 'verifying'), session('b', 'verifying')), 0, false);
      qa.scene.draw(room(session('a', 'verifying'), session('b', 'working')), 100, false);
      const oneLeft = qa.state();
      qa.scene.draw(room(session('a', 'working'), session('b', 'working')), 200, false);
      expect([oneLeft, qa.state()]).toEqual(['running-0', 'on']);
      qa.done();
    });

    it.each([
      { kind: 'verify_passed' as const, state: 'pass' },
      { kind: 'verify_failed' as const, state: 'fail' },
    ])('shows $state for 3 s after a $kind milestone, then the idle chart when nobody verifies', async ({ kind, state }) => {
      const qa = await qaScene();
      const effects = mark(kind, 1_000);
      const seen = states((at) => { qa.scene.draw(idle, at, false, 0, effects); return qa.state(); }, [1_000, 3_999, 4_000]);
      expect(seen).toEqual([state, state, 'on']);
      qa.done();
    });

    it.each([
      { kind: 'verify_passed' as const, state: 'pass' },
      { kind: 'verify_failed' as const, state: 'fail' },
    ])('shows $state over the running loop for 3 s, then running again while another agent still verifies', async ({ kind, state }) => {
      const qa = await qaScene();
      qa.scene.draw(verifying, 0, false);
      const effects = mark(kind, 1_000);
      const seen = states((at) => { qa.scene.draw(verifying, at, false, 0, effects); return qa.state(); }, [1_000, 3_999, 4_000]);
      expect(seen).toEqual([state, state, 'running-0']);
      qa.done();
    });

    it('shows a second mark inside 3 s at once and holds it for its own 3 s, as the printer mark did', async () => {
      const qa = await qaScene();
      qa.scene.draw(idle, 0, false, 0, mark('verify_passed', 0, 1));
      const first = qa.state();
      const second = mark('verify_failed', 1_000, 2);
      const seen = states((at) => { qa.scene.draw(idle, at, false, 0, second); return qa.state(); }, [1_000, 3_500, 4_000]);
      expect([first, ...seen]).toEqual(['pass', 'fail', 'fail', 'on']);
      qa.done();
    });

    it('shows only the current state’s -lit overlay at night, just after the screen in depth, and none by day', async () => {
      const qa = await qaScene();
      qa.scene.draw(verifying, 250, false, 0);
      const day = qa.lit();
      qa.scene.draw(verifying, 250, false, 0.8);
      expect({ day, night: qa.lit() }).toEqual({ day: [], night: [['furniture/wall-screen-running-0-lit', 0.8, 0.5]] });
      qa.done();
    });

    it('holds running-0 under reduced motion', async () => {
      const qa = await qaScene(true);
      const seen = states((at) => { qa.scene.draw(verifying, at, false); return qa.state(); }, [0, 250, 500, 750]);
      expect(seen).toEqual(['running-0', 'running-0', 'running-0', 'running-0']);
      qa.done();
    });

    it('does not advance the running frame on frozen frames while reconnecting', async () => {
      const qa = await qaScene();
      qa.scene.draw(verifying, 0, false);
      qa.scene.draw(verifying, 250, false);
      const seen = states((at) => { qa.scene.draw(verifying, at, true); return qa.state(); }, [500, 750, 5_000]);
      expect(seen).toEqual(['running-1', 'running-1', 'running-1']);
      qa.done();
    });

    it('resumes from the held running frame after a long reconnect, not from the outage length', async () => {
      const qa = await qaScene();
      qa.scene.draw(verifying, 0, false);
      qa.scene.draw(verifying, 250, false);
      qa.scene.draw(verifying, 5_000, true);
      // 60 010 ms after the loop started would be running-0 without the pause, and 60 260 running-1.
      const seen = states((at) => { qa.scene.draw(verifying, at, false); return qa.state(); }, [60_010, 60_260, 60_510]);
      expect(seen).toEqual(['running-1', 'running-2', 'running-3']);
      qa.done();
    });

    it('shows the Graphics fallback for a state whose texture is missing, and the art again for the next state', async () => {
      missingTextures.add('furniture/wall-screen-pass');
      try {
        const qa = await qaScene();
        qa.scene.draw(idle, 0, false, 0, mark('verify_passed', 0));
        const pass = qa.shown();
        qa.scene.draw(idle, 3_000, false, 0, mark('verify_passed', 0));
        expect({ pass, after: qa.shown() }).toEqual({ pass: ['graphics'], after: ['furniture/wall-screen-on'] });
        qa.done();
      } finally {
        missingTextures.clear();
      }
    });

    it('builds no printer piece', async () => {
      const qa = await qaScene();
      qa.scene.draw(verifying, 0, false);
      expect(displayObjects.filter((display) => typeof display.label === 'string' && display.label.includes('printer'))).toEqual([]);
      qa.done();
    });
  });

  describe('desk screens', () => {
    type Display = { label?: string; visible?: boolean; alpha?: number; texture?: { key: string } };
    const spot = (id: string) => SPOTS.find((candidate) => candidate.id === id)!;
    const at = (id: string) => ({ x: spot(id).x, y: spot(id).y });
    /** An agent at its own seat, or on its way to or from it, as `agentManager` leaves one. */
    const sitter = (id: string, spotId: string, over: Partial<Agent> = {}) => agent({
      id, assignedSpotId: spotId, state: 'working', position: at(spotId), targetPosition: at(spotId), deskPosition: at(spotId), ...over,
    });
    const frameOf = (...agents: Agent[]) => ({ agents, props: { room: { furniture: [] } } }) as unknown as SceneFrame;
    const qaDesk = (spotId: string) => furnitureSpritePlacements().find((placement) => placement.asset === 'furniture/qa-desk' && placement.spotId === spotId)!.id;

    async function screenScene() {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const before = displayObjects.length;
      const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
      const displays = displayObjects.slice(before) as Display[];
      const isLit = (display: Display) => display.texture?.key.endsWith('-lit') === true;
      const of = (label: string) => displays.filter((display) => display.label === label);
      return {
        scene,
        /** The piece's shown sprite, by texture key, or `graphics` for its fallback. */
        shown: (label: string) => of(label).filter((display) => !isLit(display) && display.visible !== false).map((display) => display.texture?.key ?? 'graphics'),
        lit: (label: string) => of(label).filter((display) => isLit(display) && (display.alpha ?? 0) > 0).map((display) => display.texture!.key),
        done: () => { scene.destroy(); host.remove(); },
      };
    }

    it('shows the off monitor at an empty front-row seat by day and at night, with no lit overlay', async () => {
      const room = await screenScene();
      room.scene.draw(frameOf(), 0, false, 0);
      const day = room.shown('monitor-desk-2');
      room.scene.draw(frameOf(), 0, false, 1);
      expect({ day, night: room.shown('monitor-desk-2'), lit: room.lit('monitor-desk-2') })
        .toEqual({ day: ['furniture/monitor-front-off'], night: ['furniture/monitor-front-off'], lit: [] });
      room.done();
    });

    it('shows the on monitor while a front-row sitter has arrived at the seat, idle, working or stalled', async () => {
      const room = await screenScene();
      const shown = (over: Partial<Agent>) => { room.scene.draw(frameOf(sitter('a', 'desk-2', over)), 0, false, 0); return room.shown('monitor-desk-2')[0]; };
      expect([shown({ state: 'walking_in' }), shown({ state: 'working' }), shown({ state: 'working', stalled: true })])
        .toEqual(['furniture/monitor-front', 'furniture/monitor-front', 'furniture/monitor-front']);
      room.done();
    });

    it('keeps the monitor off while its agent walks to the seat, and turns it on at arrival', async () => {
      const room = await screenScene();
      room.scene.draw(frameOf(sitter('a', 'desk-2', { pose: 'walking', position: { x: 4, y: 6 } })), 0, false, 0);
      const walking = room.shown('monitor-desk-2');
      room.scene.draw(frameOf(sitter('a', 'desk-2')), 0, false, 0);
      expect({ walking, arrived: room.shown('monitor-desk-2') }).toEqual({ walking: ['furniture/monitor-front-off'], arrived: ['furniture/monitor-front'] });
      room.done();
    });

    it('turns the monitor off when its sitter leaves the seat or stands at the board', async () => {
      const room = await screenScene();
      room.scene.draw(frameOf(sitter('a', 'desk-2')), 0, false, 0);
      room.scene.draw(frameOf(sitter('a', 'desk-2', { pose: 'leaving' })), 0, false, 0);
      const leaving = room.shown('monitor-desk-2');
      room.scene.draw(frameOf(sitter('a', 'desk-2', { position: { x: 9, y: 9 } })), 0, false, 0);
      expect({ leaving, elsewhere: room.shown('monitor-desk-2') }).toEqual({ leaving: ['furniture/monitor-front-off'], elsewhere: ['furniture/monitor-front-off'] });
      room.done();
    });

    it.each(['qa-1', 'qa-2'])('shows the %s desk screens off with no verifier and on with one', async (spotId) => {
      const room = await screenScene();
      room.scene.draw(frameOf(), 0, false, 0);
      const empty = room.shown(qaDesk(spotId));
      room.scene.draw(frameOf(sitter('v', spotId, { state: 'verifying' })), 0, false, 0);
      expect({ empty, verifying: room.shown(qaDesk(spotId)) }).toEqual({ empty: ['furniture/qa-desk-off'], verifying: ['furniture/qa-desk'] });
      room.done();
    });

    it('lights the orchestrator’s monitors at night only while it sits there working or verifying', async () => {
      const room = await screenScene();
      const lit = (over: Partial<Agent>) => {
        room.scene.draw(frameOf(sitter('o', 'orch', { role: 'orchestrator', ...over })), 0, false, 1);
        return room.lit('monitor-orch');
      };
      expect([
        lit({ state: 'walking_in' }), lit({ state: 'working', stalled: true }), lit({ state: 'working', pose: 'walking', position: { x: 5, y: 10 } }),
        lit({ state: 'working' }), lit({ state: 'verifying' }),
      ]).toEqual([[], [], [], ['furniture/monitors-orch-lit'], ['furniture/monitors-orch-lit']]);
      room.done();
    });

    // Pixi v8 sorts a container's children by zIndex once any child has a non-zero one, which every `-lit` overlay has, so
    // the depth runs must already stand in zIndex order or every overlay draws over the runs after it (the lit monitor rim
    // over the question note).
    it('keeps the entity layer in zIndex order at night, so the zIndex sort leaves each overlay under the run after it', async () => {
      const room = await screenScene();
      room.scene.draw(frameOf(sitter('o', 'orch', { role: 'orchestrator' })), 0, false, 1);
      type Layer = { zIndex?: number; label?: string; texture?: { key: string }; children: Layer[] };
      const entities = ((apps.at(-1)!.stage.children as Layer[])[0]!.children[0]!).children;
      const z = entities.map((child) => child.zIndex ?? 0);
      const lit = entities.findIndex((child) => child.texture?.key === 'furniture/monitors-orch-lit');
      expect({ lit: lit > 0, sorted: z.every((value, k) => k === 0 || value >= z[k - 1]!), next: (z[lit + 1] ?? 0) > z[lit]! }).toEqual({ lit: true, sorted: true, next: true });
      room.done();
    });

    it('shows the Graphics fallback for a missing off texture without throwing', async () => {
      missingTextures.add('furniture/monitor-front-off');
      try {
        const room = await screenScene();
        room.scene.draw(frameOf(), 0, false, 0);
        const empty = room.shown('monitor-desk-2');
        room.scene.draw(frameOf(sitter('a', 'desk-2')), 0, false, 0);
        expect({ empty, seated: room.shown('monitor-desk-2') }).toEqual({ empty: ['graphics'], seated: ['furniture/monitor-front'] });
        room.done();
      } finally {
        missingTextures.clear();
      }
    });
  });

  it('removes its ticker callback, stops the ticker and destroys the application and its canvas', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const scene = await createScene(host, { reduced: () => false, onTap: () => {} });
    scene.setLoop(() => {});
    scene.destroy();
    const app = apps.at(-1)!;
    const added = app.ticker.add.mock.calls[0]![0];
    expect({
      removed: app.ticker.remove.mock.calls.some(([callback]) => callback === added),
      started: app.ticker.started,
      destroyed: app.destroy.mock.calls,
      canvases: host.querySelectorAll('canvas').length,
    }).toEqual({ removed: true, started: false, destroyed: [[true, { children: true }]], canvases: 0 });
  });

  it('dims only the stalled occupant’s desk, and undims it when the stall mark clears', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const before = displayObjects.length;
    const scene = await createScene(host, { reduced: () => true, onTap: () => {} });
    const displays = displayObjects.slice(before) as { label?: string; alpha?: number; texture?: { key: string } }[];
    // A desk's pieces, without its `-lit` screen overlay, whose alpha is the lighting's rather than the stall dim's.
    const alphaAt = (spotId: string) => {
      const ids = new Set(furniturePieces().filter((piece) => piece.spotId === spotId).map((piece) => piece.id));
      return [...new Set(displays.filter((display) => ids.has(display.label ?? '') && display.texture?.key.endsWith('-lit') !== true).map((display) => display.alpha))];
    };
    const stalled: OfficeSession = { ...walkingSession, session_id: 'a', bead_id: 'ov-a', state: 'working', stalled_since: '2026-09-23T14:03:00.000Z' };
    const active: OfficeSession = { ...walkingSession, session_id: 'b', bead_id: 'ov-b', state: 'working' };
    const frame = deriveScene([stalled, active], null);
    scene.draw(frame, 0, false);
    const seats = frame.agents.map((agent) => agent.assignedSpotId);
    const dimmed = { stalled: alphaAt(seats[0]!), active: alphaAt(seats[1]!) };
    scene.draw(deriveScene([{ ...stalled, stalled_since: null }, active], null, { previous: frame }), 16, false);

    expect({ seats, dimmed, cleared: alphaAt(seats[0]!) })
      .toEqual({ seats: ['desk-1', 'desk-2'], dimmed: { stalled: [0.5], active: [1] }, cleared: [1] });
    scene.destroy();
    host.remove();
  });
});
