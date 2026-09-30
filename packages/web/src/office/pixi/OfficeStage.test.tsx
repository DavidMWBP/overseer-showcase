import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OfficeSession } from '@overseer/shared';
import type { WsMessage } from '@overseer/shared';
import { LEGACY_OFFICE_RENDERER_KEY, Office, OFFICE_EMPTY_NOTE } from '../Office';
import { Chat } from '../../views/Chat';
import { mockApi } from '../../test/setup';
import { board, chat, repo, reviewDetail } from '../../test/fixtures';
import type { OfficeScene, SceneOptions } from './scene';
import type { SceneFrame } from '../officeModel';
import { HIT_AREA } from './characters';
import { badgeTapTarget, pixiLabelInputs, visibleBox } from './OfficeStage';
import { deriveScene } from '../officeModel';
import { chipPlacement, hitBox, MIN_HIT_PX, type OfficeRoomProps } from '../RoomProps';
import { ROOM_PROP_BOXES, ROOM_PROP_SHEAR } from './roomProps';
import type { OfficeViewport } from './viewport';
import { BOARD_SPOT, p, WORLD_HEIGHT } from './world';
import { PHONE_QUERY } from '../../lib/phoneLayout';

/**
 * Pixi does not run under jsdom, so the scene (the `Application`, its canvas and ticker) is replaced by a fake that
 * appends a canvas on creation and removes it on destroy, and records the tap handler the real scene wires to each
 * character's hit area.
 */
type FakeScene = OfficeScene & { draw: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setLoop: ReturnType<typeof vi.fn>; setViewport: ReturnType<typeof vi.fn>; setPanning: ReturnType<typeof vi.fn> };
const scenes: { host: HTMLElement; scene: FakeScene; onTap: (id: string) => void; options: SceneOptions }[] = [];
vi.mock('./scene', () => ({
  createScene: vi.fn(async (host: HTMLElement, options: SceneOptions) => {
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const scene = { draw: vi.fn(), setLoop: vi.fn(), setViewport: vi.fn(), setPanning: vi.fn(), destroy: vi.fn(() => canvas.remove()) };
    scenes.push({ host, scene, onTap: options.onTap, options });
    return scene;
  }),
}));

const session = (over: Partial<OfficeSession> = {}): OfficeSession => ({
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-5', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null, ...over,
});
const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null, bead_title: null });
type OfficeMilestone = Extract<WsMessage, { type: 'office_milestone' }>;
const milestone = (kind: OfficeMilestone['kind']): OfficeMilestone => ({ type: 'office_milestone', kind, repo_id: 'r1', batch_id: 'r1-b1', bead_id: 'ov-5', at: '2026-09-25T12:00:00.000Z' });

const pixiStage = () => document.querySelector('.office-stage-pixi');
/** Any stage other than the Pixi one, or a piece of the retired DOM room. */
const otherRoom = () => document.querySelector('.office-stage:not(.office-stage-pixi), .office-room-background, .office-char:not(.office-pixi-char)');
const created = () => waitFor(() => { if (scenes.length === 0) throw new Error('no scene yet'); });

function officeMeasurements(contentWidth: number, stageWidth: number, stageHeight = stageWidth * 1056 / 1680): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('office')) return { width: contentWidth, height: 900 } as DOMRect;
    if (this.classList.contains('office-stage')) return { width: stageWidth, height: stageHeight } as DOMRect;
    return original.call(this);
  });
}

afterEach(() => { scenes.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Office room', () => {
  it.each([null, 'classic', 'pixi', 'webgl'])('draws the Pixi room and no other with a stored renderer value of %s, and removes that value', (stored) => {
    if (stored) localStorage.setItem(LEGACY_OFFICE_RENDERER_KEY, stored);
    render(<Office sessions={[session()]} />);
    expect({ pixi: !!pixiStage(), character: document.querySelectorAll('.office-pixi-char').length, other: otherRoom(), stored: localStorage.getItem(LEGACY_OFFICE_RENDERER_KEY) })
      .toEqual({ pixi: true, character: 1, other: null, stored: null });
  });

  it('destroys the Pixi application and its canvas on unmount', async () => {
    const view = render(<Office sessions={[session()]} />);
    await created();
    view.unmount();
    expect({
      destroyed: scenes.map(({ scene }) => scene.destroy.mock.calls.length),
      loopsLeft: scenes.map(({ scene }) => scene.setLoop.mock.calls.at(-1)?.[0] ?? null),
      canvases: document.querySelectorAll('canvas').length,
    }).toEqual({ destroyed: [1], loopsLeft: [null], canvases: 0 });
  });
});

describe('Pixi office stage', () => {
  it('does not call an unloaded feed empty', async () => {
    render(<Office sessions={null} />);
    await created();
    expect(screen.queryByText(OFFICE_EMPTY_NOTE)).toBeNull();
  });

  it('shows the empty note for an empty feed', async () => {
    render(<Office sessions={[]} />);
    await created();
    expect(screen.getByText(OFFICE_EMPTY_NOTE)).toBeTruthy();
  });

  it('passes the explicit open-question count to Pixi', async () => {
    render(<Office sessions={[orchestrator]} openQuestionCount={1} />);
    await created();
    await waitFor(() => {
      const asking = scenes[0]!.scene.draw.mock.calls.at(-1)?.[5];
      if (asking !== true) throw new Error('the explicit question count did not reach Pixi');
    });
    expect(scenes[0]!.scene.draw.mock.calls.at(-1)?.[5]).toBe(true);
  });

  it('replaces a verification mark with a second one inside 3 s and keeps the second for its own 3 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = render(<Office sessions={[]} milestone={milestone('verify_passed')} />);
      await vi.waitFor(() => { if (scenes.length === 0) throw new Error('no scene yet'); });
      await act(async () => { vi.advanceTimersByTime(1_000); });
      view.rerender(<Office sessions={[]} milestone={{ ...milestone('verify_failed'), at: '2026-09-25T12:00:01.000Z' }} />);
      const mark = () => (scenes[0]!.scene.draw.mock.calls.at(-1)?.[4] as { printer: { kind: string } | null }).printer?.kind ?? null;
      const afterSecond = mark();
      await act(async () => { vi.advanceTimersByTime(2_500); });
      const whenFirstWouldEnd = mark();
      await act(async () => { vi.advanceTimersByTime(600); });
      expect([afterSecond, whenFirstWouldEnd, mark()]).toEqual(['verify_failed', 'verify_failed', null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish a viewport for a scroll event with unchanged measurements', async () => {
    officeMeasurements(1200, 800);
    render(<Office sessions={[session()]} />);
    await created();
    const scene = scenes[0]!.scene;
    await waitFor(() => { if (scene.setViewport.mock.calls.length === 0) throw new Error('viewport was not published initially'); });
    const published = scene.setViewport.mock.calls.length;

    act(() => window.dispatchEvent(new Event('scroll')));

    expect(scene.setViewport).toHaveBeenCalledTimes(published);
  });

  it('consumes a native wheel gesture while the world can pan', async () => {
    officeMeasurements(1200, 800);
    render(<Office sessions={[session()]} />);
    await created();
    const stage = pixiStage() as HTMLDivElement;
    const before = stage.dataset.officeCameraX;
    const wheel = new WheelEvent('wheel', { deltaX: -35, bubbles: true, cancelable: true });

    act(() => stage.dispatchEvent(wheel));

    expect({ prevented: wheel.defaultPrevented, panned: stage.dataset.officeCameraX !== before }).toEqual({ prevented: true, panned: true });
  });

  it.each([
    { name: 'a desktop 1200 CSS px stage at dpr 1 and 2', stage: 1200, dprs: [1, 2], phone: false, css: [1, 1], k: [1, 2] },
    { name: 'a desktop 964 x 605 CSS px stage at dpr 1 and 2', stage: 964, stageHeight: 605, dprs: [1, 2], phone: false, css: [1, 1], k: [1, 2] },
    { name: 'a 500 x 500 CSS px desktop stage at dpr 1 and 2', stage: 500, stageHeight: 500, dprs: [1, 2], phone: false, css: [1, 1], k: [1, 2] },
    { name: 'a phone 767 CSS px stage at dpr 3 (the width-and-density scale)', stage: 767, dprs: [3], phone: true, css: [1 / 3], k: [1] },
  ])('publishes the scale the band gives $name', async ({ stage: stageWidth, stageHeight, dprs, phone, css, k }) => {
    const media = vi.fn((query: string) => ({ matches: phone && query === '(max-width: 767px)', addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    vi.stubGlobal('matchMedia', media);
    officeMeasurements(1280, stageWidth, stageHeight);
    const published: { css: number; k: number }[] = [];
    try {
      for (const dpr of dprs) {
        vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(dpr);
        const view = render(<Office sessions={[session()]} />);
        await created();
        const stage = pixiStage() as HTMLDivElement;
        published.push({ css: Number(stage.dataset.officeCssScale), k: Number(stage.dataset.officePixelScale) });
        view.unmount();
        scenes.length = 0;
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(published).toEqual(css.map((scale, i) => ({ css: scale, k: k[i] })));
  });

  it('keeps the hit button and label anchor within one CSS pixel of the snapped sprite', async () => {
    officeMeasurements(1280, 800);
    render(<Office sessions={[session()]} />);
    await created();
    await waitFor(() => { if (!scenes[0]!.scene.draw.mock.calls.length) throw new Error('scene has not drawn its initial frame'); });
    const stage = pixiStage() as HTMLDivElement;
    const button = stage.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
    const leader = stage.querySelector<SVGLineElement>('[data-label-leader="s1"]')!;
    const frame = scenes[0]!.scene.draw.mock.calls.at(-1)?.[0] as SceneFrame;
    const [worldX, worldY] = p(frame.agents[0]!.position.x, frame.agents[0]!.position.y);
    const labelInput = pixiLabelInputs(frame.agents)[0]!;
    const dpr = window.devicePixelRatio || 1;
    const pixelScale = Number(stage.dataset.officePixelScale);
    const cssScale = Number(stage.dataset.officeCssScale);
    const originX = Number(stage.dataset.officeOriginX);
    const originY = Number(stage.dataset.officeOriginY);
    const cameraX = Number(stage.dataset.officeCameraX);
    const cameraY = Number(stage.dataset.officeCameraY);
    const snappedX = Math.round((originX + cameraX) * dpr + worldX * pixelScale) / dpr;
    const snappedY = Math.round((originY + cameraY) * dpr + worldY * pixelScale) / dpr;
    const buttonLeft = originX + cameraX + Number.parseFloat(button.style.left);
    const buttonTop = originY + cameraY + Number.parseFloat(button.style.top);
    const labelX = originX + cameraX + Number(leader.getAttribute('x2'));
    const labelY = originY + cameraY + Number(leader.getAttribute('y2'));
    const labelOffsetY = (labelInput.y / 100) * (WORLD_HEIGHT * cssScale) - worldY * cssScale;

    expect(Math.max(
      Math.abs(buttonLeft - (snappedX + HIT_AREA.x * cssScale)),
      Math.abs(buttonTop - (snappedY + HIT_AREA.y * cssScale)),
      Math.abs(labelX - snappedX),
      Math.abs(labelY - (snappedY + labelOffsetY)),
    )).toBeLessThanOrEqual(1);
  });

  describe('character touch targets', () => {
    const pointer = (coarse: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
      // Reduced motion seats each character at its desk at once, instead of at the door. A 366 px phone matches both the
      // phone layout and the camera's width band (`phoneBand` in `viewport.ts`), which keeps the phone scale.
      matches: query === PHONE_QUERY || query === '(max-width: 767px)' || query.includes('prefers-reduced-motion') || (coarse && query === '(pointer: coarse)'), media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    async function phoneButton() {
      officeMeasurements(366, 366);
      render(<Office sessions={[session()]} board={board} />);
      await created();
      const stage = pixiStage() as HTMLDivElement;
      await waitFor(() => { if (!stage.dataset.officeCssScale) throw new Error('no viewport yet'); });
      const button = stage.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
      const frame = scenes[0]!.scene.draw.mock.calls.at(-1)?.[0] as SceneFrame;
      const [x, y] = p(frame.agents[0]!.position.x, frame.agents[0]!.position.y);
      const k = Number(stage.dataset.officeCssScale);
      const box = ['left', 'top', 'width', 'height'].map((side) => Number.parseFloat(button.style[side as 'left']));
      return { k, box, centre: [(box[0]! + box[2]! / 2) / k, (box[1]! + box[3]! / 2) / k], feet: [x, y], options: scenes[0]!.options };
    }

    it('makes the character button at least 44 x 44 CSS px about the same centre on a coarse pointer at the phone scale', async () => {
      pointer(true);
      const { k, box, centre, feet, options } = await phoneButton();
      expect({
        phoneScale: k < 0.5, width: box[2]! >= 44 - 1e-9, height: box[3]! >= 44 - 1e-9,
        centre: centre.map((value) => Math.round(value * 1000) / 1000),
        sceneMin: [options.characterMinHitPx?.(), options.minHitPx?.()],
      }).toEqual({
        phoneScale: true, width: true, height: true,
        centre: [feet[0]! + HIT_AREA.x + HIT_AREA.width / 2, feet[1]! + HIT_AREA.y + HIT_AREA.height / 2].map((value) => Math.round(value * 1000) / 1000),
        sceneMin: [44, 44],
      });
    });

    it('weighs a badge tap against the character targets it covers: the nearest centre opens', () => {
      const derived = deriveScene([session(), session({ session_id: 's2', bead_id: 'ov-6' })], null);
      // Neighbours one tile apart, as seated characters are.
      const frame = { ...derived, agents: derived.agents.map((agent, index) => ({ ...agent, position: { x: 4 + index, y: 6 } })) };
      const scale = 0.327;
      const [x2, y2] = p(frame.agents[1]!.position.x, frame.agents[1]!.position.y);
      // s2's target centre in overlay CSS px, and a tap 5 px below it.
      const body = { x: x2 * scale, y: (y2 - 42) * scale };
      expect({
        nearerBody: badgeTapTarget('s1', { x: body.x, y: body.y + 5, distance: 12 }, frame.agents, scale, 44),
        nearerBadge: badgeTapTarget('s1', { x: body.x, y: body.y + 5, distance: 3 }, frame.agents, scale, 44),
        noBody: badgeTapTarget('s1', { x: -500, y: -500, distance: 12 }, frame.agents, scale, 44),
        outsideBadges: badgeTapTarget('s1', { x: body.x, y: body.y + 5, distance: Infinity }, frame.agents, scale, 44),
      }).toEqual({ nearerBody: 's2', nearerBadge: 's1', noBody: 's1', outsideBadges: 's2' });
    });

    it('opens the character whose target centre is nearest a tap on another character\'s badge, on a phone with a coarse pointer', async () => {
      pointer(true);
      mockApi((_m, url) => {
        if (url.endsWith('/api/tasks/ov-5') || url.endsWith('/api/tasks/ov-6')) return reviewDetail;
        throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      });
      officeMeasurements(366, 366);
      render(<Office sessions={[session(), session({ session_id: 's2', bead_id: 'ov-6', harness: 'codex' })]} board={board} />);
      await created();
      const stage = pixiStage() as HTMLDivElement;
      await waitFor(() => { if (stage.querySelectorAll('.office-badge').length !== 2) throw new Error('no badges yet'); });
      const button = stage.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s2"]')!;
      const centre = { x: Number.parseFloat(button.style.left) + Number.parseFloat(button.style.width) / 2, y: Number.parseFloat(button.style.top) + Number.parseFloat(button.style.height) / 2 };
      fireEvent.click(stage.querySelector('.office-badge[data-badge-for="s1"]')!, { clientX: centre.x, clientY: centre.y + 5 });
      expect(screen.getByRole('dialog').getAttribute('aria-label')).toMatch(/^Details of codex · sonnet · ov-6/);
    });

    it('keeps the character button at HIT_AREA on a fine pointer at the phone scale', async () => {
      pointer(false);
      const { k, box, feet, options } = await phoneButton();
      expect({ box: box.map((value) => Math.round(value * 1000) / 1000), sceneMin: [options.characterMinHitPx?.(), options.minHitPx?.()] }).toEqual({
        box: [(feet[0]! + HIT_AREA.x) * k, (feet[1]! + HIT_AREA.y) * k, HIT_AREA.width * k, HIT_AREA.height * k].map((value) => Math.round(value * 1000) / 1000),
        sceneMin: [0, 24],
      });
    });
  });

  it('consumes a milestone received while Office is hidden without replaying it on return', async () => {
    const consume = vi.fn();
    const view = render(<Office sessions={[]} milestone={milestone('merged')} onMilestoneConsumed={consume} active={false} />);
    await created();
    view.rerender(<Office sessions={[]} milestone={null} onMilestoneConsumed={consume} active />);
    await waitFor(() => { if (!scenes[0]!.scene.draw.mock.calls.length) throw new Error('scene was not drawn'); });
    const effects = scenes[0]!.scene.draw.mock.calls.at(-1)?.[4];
    expect({ consumed: consume.mock.calls.length, effects }).toEqual({ consumed: 1, effects: { printer: null, merged: null } });
  });

  it('routes a passed bead to the board before it hops', async () => {
    render(<Office sessions={[session({ state: 'verifying' })]} milestone={milestone('verify_passed')} />);
    await created();
    await waitFor(() => {
      const frame = scenes[0]!.scene.draw.mock.calls.at(-1)?.[0] as SceneFrame | undefined;
      if (frame?.agents[0]?.targetPosition.x !== BOARD_SPOT.x || frame.agents[0]?.targetPosition.y !== BOARD_SPOT.y) throw new Error('passing bead has not been routed');
    });
    const frame = scenes[0]!.scene.draw.mock.calls.at(-1)?.[0] as SceneFrame;
    const agent = frame.agents[0]!;
    expect({ pose: agent.pose, target: agent.targetPosition, routeEnd: agent.pathQueue.at(-1), facing: agent.spriteFacing }).toEqual({
      pose: 'walking',
      target: { x: BOARD_SPOT.x, y: BOARD_SPOT.y },
      routeEnd: { x: BOARD_SPOT.x, y: BOARD_SPOT.y },
      facing: BOARD_SPOT.f,
    });
  });

  it('opens the task pane when a character is tapped', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Office sessions={[session()]} board={board} />);
    await created();
    act(() => scenes[0]!.onTap('s1'));
    expect(await screen.findByRole('complementary', { name: 'Details of ov-5' })).toBeTruthy();
  });

  it('suppresses a character tap after a drag and still opens on a tap', async () => {
    officeMeasurements(1200, 800);
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Office sessions={[session()]} board={board} />);
    await created();
    const stage = pixiStage() as HTMLDivElement;
    const sendPointer = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'mouse' } });
      fireEvent(stage, event);
    };
    act(() => {
      sendPointer('pointerdown', 100, 100);
      sendPointer('pointermove', 108, 103);
      scenes[0]!.onTap('s1');
      sendPointer('pointerup', 108, 103);
    });
    expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull();

    act(() => scenes[0]!.onTap('s1'));
    expect(await screen.findByRole('complementary', { name: 'Details of ov-5' })).toBeTruthy();
  });

  it('focuses the docked Chat composer when the orchestrator is tapped', async () => {
    officeMeasurements(1580, 1200);
    mockApi((_method, url) => url.startsWith('/api/chat') ? { rows: chat, has_more: false, oldest_id: chat[0]!.id } : {});
    const attachments = { attachments: [], setAttachments: vi.fn(), hint: null, setHint: vi.fn() };
    const dockChat = <Chat version={0} repos={[repo]} reposLoaded repo="r1" onRepo={vi.fn()} readThrough={{ current: null }} text="" draftRev={0} onText={vi.fn()} onClearText={vi.fn()} attachments={attachments} />;
    render(<Office sessions={[orchestrator]} onOpenChat={vi.fn()} chatDock={dockChat} />);
    await created();
    const composer = within(document.querySelector('.office-chat-dock') as HTMLElement).getByRole('textbox', { name: 'Message the orchestrator' });
    act(() => scenes[0]!.onTap('orch'));
    expect(document.activeElement).toBe(composer);
  });

  describe('hover', () => {
    const roomProps = (): OfficeRoomProps => ({
      questions: 1, reviewBatches: ['r1/r1-b1'],
      columns: [{ key: 'ready', label: 'Ready', ids: ['ov-1'] }, { key: 'blocked', label: 'Blocked', ids: [] }, { key: 'running', label: 'Running', ids: ['ov-5'] },
        { key: 'verifying', label: 'Verifying', ids: [] }, { key: 'review', label: 'Review', ids: [] }, { key: 'done', label: 'Done', ids: [] }],
      onOpenChat: vi.fn(), onOpenReview: vi.fn(), onOpenBoard: vi.fn(),
    });
    const sendPointer = (stage: HTMLElement, type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'mouse' } });
      fireEvent(stage, event);
    };
    const hovered = () => [...document.querySelectorAll<HTMLElement>('.office-room-prop-hover')].map((button) => button.dataset.officeProp);

    it('holds the scene\'s hover target through a drag pan, and not for a tap', async () => {
      officeMeasurements(1200, 800);
      render(<Office sessions={[session()]} roomProps={roomProps()} />);
      await created();
      const stage = pixiStage() as HTMLDivElement;
      act(() => {
        sendPointer(stage, 'pointerdown', 100, 100);
        sendPointer(stage, 'pointermove', 103, 101);
        sendPointer(stage, 'pointerup', 103, 101);
      });
      const afterTap = [...scenes[0]!.scene.setPanning.mock.calls];
      act(() => sendPointer(stage, 'pointerdown', 100, 100));
      act(() => sendPointer(stage, 'pointermove', 120, 110));
      const duringDrag = [...scenes[0]!.scene.setPanning.mock.calls];
      act(() => sendPointer(stage, 'pointermove', 140, 120));
      act(() => sendPointer(stage, 'pointerup', 140, 120));
      expect({ afterTap, duringDrag, afterDrag: scenes[0]!.scene.setPanning.mock.calls }).toEqual({ afterTap: [], duringDrag: [[true]], afterDrag: [[true], [false]] });
    });

    it('shows an object\'s chip while the scene reports the pointer over it, and hides it when the pointer leaves the canvas', async () => {
      render(<Office sessions={[session()]} roomProps={roomProps()} />);
      await created();
      const before = hovered();
      act(() => scenes[0]!.options.onPropHover!('board'));
      const over = hovered();
      act(() => scenes[0]!.options.onPropHover!(null));
      expect({ before, over, left: hovered() }).toEqual({ before: [], over: ['board'], left: [] });
    });

    it('turns hover on at desktop widths and off at the phone breakpoint', async () => {
      const desktop = render(<Office sessions={[session()]} roomProps={roomProps()} />);
      await created();
      const onDesktop = scenes[0]!.options.hoverable!();
      desktop.unmount();
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
      render(<Office sessions={[session()]} roomProps={roomProps()} />);
      await waitFor(() => { if (scenes.length < 2) throw new Error('no phone scene yet'); });
      expect({ onDesktop, onPhone: scenes[1]!.options.hoverable!() }).toEqual({ onDesktop: true, onPhone: false });
    });

    it('places the whiteboard chip next to the visible whiteboard from the current viewport, before and after a drag pan', async () => {
      officeMeasurements(1200, 800);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('office-room-prop-chip') ? 320 : 0; });
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('office-room-prop-chip') ? 18 : 0; });
      render(<Office sessions={[session()]} roomProps={roomProps()} />);
      await created();
      const stage = pixiStage() as HTMLDivElement;
      await waitFor(() => { if (scenes[0]!.scene.setViewport.mock.calls.length === 0) throw new Error('viewport was not published'); });
      const viewport = scenes[0]!.scene.setViewport.mock.calls.at(-1)![0] as OfficeViewport;
      const chip = () => {
        const style = (stage.querySelector('[data-office-prop="board"] .office-room-prop-chip') as HTMLElement).style;
        return { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top) };
      };
      const expected = (current: OfficeViewport) => chipPlacement(hitBox(ROOM_PROP_BOXES.board, current.scale, MIN_HIT_PX), { width: 320, height: 18 }, visibleBox(current), ROOM_PROP_SHEAR.board);
      const before = chip();
      act(() => sendPointer(stage, 'pointerdown', 400, 250));
      act(() => sendPointer(stage, 'pointermove', 700, 450));
      act(() => sendPointer(stage, 'pointerup', 700, 450));
      const panned = scenes[0]!.scene.setViewport.mock.calls.at(-1)![0] as OfficeViewport;
      // The pan takes the whiteboard partly past the stage's right edge, so the chip is held inside the stage.
      expect({ moved: panned.x !== viewport.x || panned.y !== viewport.y, before, after: chip(), clamped: chip().left !== before.left })
        .toEqual({ moved: true, before: expected(viewport), after: expected(panned), clamped: true });
    });
  });

  describe('capture option', () => {
    afterEach(() => { window.history.replaceState(null, '', '/'); });
    const phone = () => vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === PHONE_QUERY || query === '(max-width: 767px)', media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    const sessions = [session(), session({ session_id: 's2', bead_id: 'ov-6', harness: 'codex' }), session({ session_id: 'c1', role: 'critic', bead_id: 'ov-7' })];
    async function tags(width: number) {
      officeMeasurements(width, width === 390 ? 390 : 800);
      render(<Office sessions={sessions} board={board} />);
      await created();
      const stage = pixiStage() as HTMLDivElement;
      await waitFor(() => { if (stage.querySelectorAll('.office-pixi-char').length !== 3) throw new Error('no character buttons yet'); });
      return {
        labels: stage.querySelectorAll('.office-char-label').length,
        badges: stage.querySelectorAll('.office-badge').length,
        names: [...stage.querySelectorAll<HTMLButtonElement>('.office-pixi-char')].map((button) => Boolean(button.getAttribute('aria-label')) && button.title === button.getAttribute('aria-label')),
      };
    }

    it('draws a label per character on desktop without the option', async () => {
      expect(await tags(1280)).toEqual({ labels: 3, badges: 0, names: [true, true, true] });
    });

    it('draws a badge per character on a phone without the option', async () => {
      phone();
      expect(await tags(390)).toEqual({ labels: 0, badges: 3, names: [true, true, true] });
    });

    it('draws no label on desktop with ?capture=1 and keeps the character names', async () => {
      window.history.replaceState(null, '', '/?capture=1#office');
      expect(await tags(1280)).toEqual({ labels: 0, badges: 0, names: [true, true, true] });
    });

    it('draws no badge on a phone with ?capture=1 and keeps the character names', async () => {
      phone();
      window.history.replaceState(null, '', '/?capture=1#office');
      expect(await tags(390)).toEqual({ labels: 0, badges: 0, names: [true, true, true] });
    });

    it('keeps the tags for any other capture value', async () => {
      window.history.replaceState(null, '', '/?capture=0#office');
      expect(await tags(1280)).toEqual({ labels: 3, badges: 0, names: [true, true, true] });
    });
  });
});
