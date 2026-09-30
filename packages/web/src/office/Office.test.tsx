import fs from 'node:fs';
import path from 'node:path';
import { Profiler, StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OfficeSession, WsMessage } from '@overseer/shared';
import { officeStageMaxWidth, Office, OFFICE_EMPTY_NOTE, OFFICE_UNAVAILABLE_NOTE } from './Office';
import type { OfficeScene } from './pixi/scene';
import type { OfficeSceneEffects } from './pixi/effects';
import type { SceneFrame } from './officeModel';
import { pixiLabelInputs } from './pixi/OfficeStage';
import { mockApi } from '../test/setup';
import { BOARD_COLUMNS } from '../views/Board';
import type { OfficeRoomProps } from './RoomProps';
import type { RoomPropsInput } from './pixi/roomProps';
import { board, chat, repo, reviewDetail } from '../test/fixtures';
import { atBottom, Chat } from '../views/Chat';
import { PHONE_QUERY } from '../lib/phoneLayout';
import { stubViewport } from '../test/viewportMedia';

const session = (over: Partial<OfficeSession> = {}): OfficeSession => ({
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-3', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'walking_in', stalled_since: null, ...over,
});

type OfficeMilestone = Extract<WsMessage, { type: 'office_milestone' }>;
const milestone = (kind: OfficeMilestone['kind']): OfficeMilestone => ({ type: 'office_milestone', kind, repo_id: 'r2', batch_id: 'r2-b4', bead_id: 'ov-9', at: '2026-09-25T12:00:00.000Z' });
/** One key per batch in review, repository id and batch id. */
const batchKeys = (n: number) => Array.from({ length: n }, (_, k) => `r1/r1-b${k}`);
const officeColumns = () => BOARD_COLUMNS.map(({ key, label }) => ({ key, label: key === 'done' ? 'Done today' : label, ids: [] as string[] | null }));
const roomProps = (over: Partial<OfficeRoomProps> = {}): OfficeRoomProps => ({
  questions: 0, reviewBatches: [], columns: officeColumns(),
  onOpenChat: () => {}, onOpenReview: () => {}, onOpenBoard: () => {}, ...over,
});

/**
 * Pixi does not run under jsdom, so the scene is a fake that records each draw and the frame loop the stage hands it.
 * The last draw's arguments are what the room shows: the frame, whether it is frozen, the night share and the effects.
 */
type FakeScene = OfficeScene & { draw: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setLoop: ReturnType<typeof vi.fn>; setViewport: ReturnType<typeof vi.fn> };
const scenes = vi.hoisted(() => [] as { scene: FakeScene }[]);
vi.mock('./pixi/scene', () => ({
  createScene: vi.fn(async () => {
    const scene = { draw: vi.fn(), setLoop: vi.fn(), setViewport: vi.fn(), setPanning: vi.fn(), destroy: vi.fn() };
    scenes.push({ scene: scene as unknown as FakeScene });
    return scene;
  }),
}));
type DrawCall = [SceneFrame, number, boolean, number, OfficeSceneEffects, boolean, RoomPropsInput | null];
const lastDraw = () => scenes.at(-1)?.scene.draw.mock.calls.at(-1) as DrawCall | undefined;
const drawnEffects = () => lastDraw()?.[4];
const drawnNightShare = () => lastDraw()?.[3];
const drawnRoomProps = () => lastDraw()?.[6];
const drawnAgent = (id: string) => lastDraw()?.[0].agents.find((agent) => agent.id === id);
const drawnAtDesk = (id: string) => {
  const agent = drawnAgent(id);
  return !!agent && agent.position.x === agent.deskPosition.x && agent.position.y === agent.deskPosition.y;
};
/** The frame loop the stage is running, or null when it has not started one (or has stopped it). */
const runningLoop = () => (scenes.at(-1)?.scene.setLoop.mock.calls.at(-1)?.[0] ?? null) as ((now: number) => void) | null;
/** Let the async fake scene resolve, so the stage draws and starts its loop. */
const sceneReady = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/**
 * Drive the stage's frame loop by hand, so a walk is deterministic and finishes in a bounded number of frames. The
 * loop also times each frame from `performance.now()`, so this drives that clock too: with both on the same monotonic
 * step, a fixed number of frames covers the same distance however long the worker took to reach the frame.
 */
function stubLoop({ initialNow = 0, initialPerformanceNow = initialNow }: { initialNow?: number; initialPerformanceNow?: number } = {}) {
  let now = initialNow;
  let performanceNow = initialPerformanceNow;
  vi.stubGlobal('performance', { now: () => performanceNow });
  return {
    // One `act` per call even while no loop runs, so a pending update (one that restarts the loop) lands first.
    frame: () => { now += 50; act(() => { runningLoop()?.(now); }); },
    setPerformanceNow: (value: number) => { performanceNow = value; },
  };
}

function stubReducedMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

function stubPhoneOffice(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY || query.includes('prefers-reduced-motion'), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  officeMeasurements(390, 390);
}

async function renderPhoneOffice(sessions: OfficeSession[] = [session()]) {
  stubPhoneOffice();
  const view = render(<Office sessions={sessions} />);
  await sceneReady();
  return view;
}

function officeMeasurements(contentWidth: number, stageWidth: number): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('office')) return { width: contentWidth, height: 900 } as DOMRect;
    if (this.classList.contains('office-stage')) return { width: stageWidth, height: stageWidth * 1056 / 1680 } as DOMRect;
    return original.call(this);
  });
}

function officeChatDock(offline = false) {
  const attachments = { attachments: [], setAttachments: vi.fn(), hint: null, setHint: vi.fn() };
  return <Chat version={0} repos={[repo]} reposLoaded repo="r1" onRepo={vi.fn()} offline={offline} readThrough={{ current: null }} text="" draftRev={0} onText={vi.fn()} onClearText={vi.fn()} attachments={attachments} />;
}

function OfficeWithBatchPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const [panelOpen, setPanelOpen] = useState(true);
  const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null, bead_title: null });
  return <>
    {panelOpen && <aside className="detail" aria-label="Batch details for r1-b1">Batch details</aside>}
    <Office sessions={[orchestrator]} hostPanelOpen={panelOpen} onSelectTask={() => setPanelOpen(false)} onOpenChat={onOpenChat} chatDock={officeChatDock()} />
  </>;
}

function setThreadScrollGeometry(thread: HTMLElement): void {
  Object.defineProperties(thread, {
    scrollHeight: { configurable: true, value: 480 },
    clientHeight: { configurable: true, value: 200 },
  });
  thread.scrollTop = 0;
}

afterEach(() => { scenes.length = 0; Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Office', () => {
  // Every milestone is drawn by the Pixi scene: the QA wall screen, the confetti, and the folders' glow on the meeting
  // table. The scene holds the glow still under reduced motion itself (`roomProps.test.ts`), so its input carries no flag.
  const effectOf = (kind: OfficeMilestone['kind']): { kind: string; reduced: boolean | null } | null => {
    if (kind === 'verify_passed' || kind === 'verify_failed') return drawnEffects()?.printer ?? null;
    if (kind === 'merged') return drawnEffects()?.merged ?? null;
    return drawnRoomProps()?.reviewReady ? { kind: 'review_ready', reduced: null } : null;
  };

  it.each([
    { kind: 'verify_passed' as const, duration: 3_000 },
    { kind: 'verify_failed' as const, duration: 3_000 },
    { kind: 'review_ready' as const, duration: 3_000 },
    { kind: 'merged' as const, duration: 2_000 },
  ])('shows and expires the $kind effect', async ({ kind, duration }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const view = render(<Office sessions={[]} milestone={milestone(kind)} roomProps={roomProps()} />);
    await sceneReady();
    const effect = () => effectOf(kind);

    expect({ kind: effect()?.kind, reduced: effect()?.reduced }).toEqual({ kind, reduced: kind === 'review_ready' ? null : false });
    act(() => { vi.advanceTimersByTime(duration - 1); });
    expect(effect()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(effect()).toBeNull();
    view.unmount();
  });

  it.each(['verify_passed', 'verify_failed', 'review_ready', 'merged'] as const)('keeps a reduced-motion %s highlight for three seconds', async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    stubReducedMotion();
    render(<Office sessions={[]} milestone={milestone(kind)} roomProps={roomProps()} />);
    await sceneReady();
    const effect = () => effectOf(kind);

    expect({ kind: effect()?.kind, reduced: effect()?.reduced }).toEqual({ kind, reduced: kind === 'review_ready' ? null : true });
    act(() => { vi.advanceTimersByTime(2_999); });
    expect(effect()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(effect()).toBeNull();
  });

  it('keeps a one-shot effect through StrictMode effect replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    stubReducedMotion();
    render(<StrictMode><Office sessions={[]} milestone={milestone('verify_passed')} roomProps={roomProps()} /></StrictMode>);
    await sceneReady();

    expect(drawnEffects()?.printer?.kind).toBe('verify_passed');
    act(() => { vi.advanceTimersByTime(2_999); });
    expect(drawnEffects()?.printer?.kind).toBe('verify_passed');
    act(() => { vi.advanceTimersByTime(1); });
    expect(drawnEffects()?.printer).toBeNull();
  });

  it.each([0, 2])('keeps the review count and accessible name unchanged at %i batches while the folders glow', async (reviewBatches) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    stubReducedMotion();
    const { container } = render(<Office sessions={[]} milestone={milestone('review_ready')} roomProps={roomProps({ reviewBatches: batchKeys(reviewBatches) })} />);
    await sceneReady();
    const review = container.querySelector<HTMLButtonElement>('.office-stage [data-office-prop="review"]')!;

    expect({ label: review.getAttribute('aria-label'), drawn: drawnRoomProps()?.reviewBatches?.length, glow: drawnRoomProps()?.reviewReady != null })
      .toEqual({ label: `Open Review, ${reviewBatches} ${reviewBatches === 1 ? 'batch' : 'batches'} in review`, drawn: reviewBatches, glow: true });
  });

  it('restarts the verification mark for a second verify result and lets review and merge effects overlap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const props = roomProps();
    const view = render(<Office sessions={[]} milestone={milestone('verify_passed')} roomProps={props} />);
    await sceneReady();
    const printer = () => drawnEffects()?.printer ?? null;

    act(() => { vi.advanceTimersByTime(2_000); });
    view.rerender(<Office sessions={[]} milestone={milestone('verify_failed')} roomProps={props} />);
    expect(printer()?.kind).toBe('verify_failed');
    act(() => { vi.advanceTimersByTime(2_999); });
    expect(printer()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(printer()).toBeNull();

    view.rerender(<Office sessions={[]} milestone={milestone('review_ready')} roomProps={props} />);
    view.rerender(<Office sessions={[]} milestone={milestone('merged')} roomProps={props} />);
    expect(drawnEffects()?.merged?.kind).toBe('merged');
    expect(drawnRoomProps()?.reviewReady).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(drawnEffects()?.merged).toBeNull();
    expect(drawnRoomProps()?.reviewReady).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(drawnRoomProps()?.reviewReady).toBeNull();
    view.unmount();
  });

  it('glows the folders on phones too and keeps the count row name unchanged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY || query.includes('prefers-reduced-motion'), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const { container } = render(<Office sessions={[]} milestone={milestone('review_ready')} roomProps={roomProps()} />);
    await sceneReady();
    const review = container.querySelector<HTMLButtonElement>('.office-count-row [data-office-count="in-review"]')!;

    expect({ text: review.textContent, name: review.getAttribute('aria-label'), glow: drawnRoomProps()?.reviewReady != null })
      .toEqual({ text: '0', name: 'Open Review, 0 batches in review', glow: true });
  });

  it('shows the phone count row on a touch phone in landscape and gives it up on a taller touch screen', async () => {
    const viewport = stubViewport({ width: 844, height: 390, pointer: 'coarse', reducedMotion: true });
    const { container } = render(<Office sessions={[]} roomProps={roomProps()} />);
    await sceneReady();
    const countRow = () => container.querySelector('.office-count-row');
    expect(countRow()).not.toBeNull();
    act(() => viewport.set({ width: 1024, height: 768, pointer: 'coarse', reducedMotion: true }));
    expect(countRow()).toBeNull();
    // A mouse on a short window keeps the desktop room.
    act(() => viewport.set({ width: 900, height: 480, pointer: 'fine', reducedMotion: true }));
    expect(countRow()).toBeNull();
    act(() => viewport.set({ width: 844, height: 390, pointer: 'coarse', reducedMotion: true }));
    expect(countRow()).not.toBeNull();
  });

  it('clears every effect timer when Office unmounts during an effect', () => {
    vi.useFakeTimers();
    stubReducedMotion();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const view = render(<Office sessions={[]} milestone={milestone('merged')} roomProps={roomProps()} />);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('puts the object buttons inside the room stage on desktop, with no pills and no count row', () => {
    const { container } = render(<Office sessions={[]} roomProps={roomProps()} />);
    expect([...container.querySelectorAll('.office-stage [data-office-prop]')].map((button) => button.getAttribute('data-office-prop'))).toEqual(['questions', 'review', 'board']);
    expect(container.querySelectorAll('.office-props-layer, .office-prop, .office-props-row, .office-count-row')).toHaveLength(0);
  });

  it('hands the scene the counts and the task ids per Board column', async () => {
    stubReducedMotion();
    const columns = officeColumns().map((column) => ({ ...column, ids: column.key === 'ready' ? ['ov-1', 'ov-2'] : [] }));
    render(<Office sessions={[]} roomProps={roomProps({ questions: 3, reviewBatches: batchKeys(2), columns })} />);
    await sceneReady();
    expect(drawnRoomProps()).toEqual({
      questions: 3, reviewBatches: batchKeys(2), reviewReady: null,
      columns: { ready: ['ov-1', 'ov-2'], blocked: [], running: [], verifying: [], review: [], done: [] },
    });
  });

  it('hands the scene no column ids before the board loads', async () => {
    stubReducedMotion();
    render(<Office sessions={[]} roomProps={roomProps({ questions: null, reviewBatches: null, columns: officeColumns().map((column) => ({ ...column, ids: null })) })} />);
    await sceneReady();
    expect(drawnRoomProps()).toEqual({ questions: null, reviewBatches: null, columns: null, reviewReady: null });
  });

  describe('room lighting', () => {
    const localDate = (hour: number, minute = 0) => new Date(2026, 8, 24, hour, minute);

    it.each([{ hour: 12, share: 0 }, { hour: 22, share: 1 }])('draws the room at night share $share at $hour:00', async ({ hour, share }) => {
      stubReducedMotion();
      render(<Office sessions={[]} sceneClock={() => localDate(hour)} />);
      await sceneReady();

      expect(drawnNightShare()).toBe(share);
    });

    it('refreshes from the injected scene clock without rebuilding the scene', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      stubReducedMotion();
      let now = localDate(19);
      const sceneClock = vi.fn(() => now);
      render(<Office sessions={[]} sceneClock={sceneClock} />);
      await sceneReady();

      expect(drawnNightShare()).toBe(0);
      now = localDate(21);
      act(() => { vi.advanceTimersByTime(60_000); });

      expect({ scenes: scenes.length, share: drawnNightShare() }).toEqual({ scenes: 1, share: 1 });
    });

    it('pauses lighting refreshes while the tab is hidden and catches up when visible', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      stubReducedMotion();
      let now = localDate(12);
      const sceneClock = vi.fn(() => now);
      render(<Office sessions={[]} sceneClock={sceneClock} />);
      await sceneReady();
      const reads = sceneClock.mock.calls.length;

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      now = localDate(22);
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(sceneClock).toHaveBeenCalledTimes(reads);

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(drawnNightShare()).toBe(1);
    });

    it('pauses lighting while another view is active and refreshes on return', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      stubReducedMotion();
      let now = localDate(12);
      const sceneClock = vi.fn(() => now);
      const { rerender } = render(<Office sessions={[]} active={false} sceneClock={sceneClock} />);
      await sceneReady();

      expect(sceneClock).not.toHaveBeenCalled();
      now = localDate(22);
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(sceneClock).not.toHaveBeenCalled();

      rerender(<Office sessions={[]} active sceneClock={sceneClock} />);
      expect(drawnNightShare()).toBe(1);
    });
  });

  describe('at the phone breakpoint', () => {
    const phoneMedia = (query: string) => ({ matches: query === PHONE_QUERY, media: query, addEventListener: () => {}, removeEventListener: () => {} });

    it('renders the count row under the stage and no object buttons inside the room', () => {
      vi.stubGlobal('matchMedia', phoneMedia);
      const { container } = render(<Office sessions={[]} roomProps={roomProps()} />);
      expect(container.querySelector('.office-stage [data-office-prop]')).toBeNull();
      const row = container.querySelector('.office > .office-count-row')!;
      expect(row.previousElementSibling?.classList.contains('office-stage')).toBe(true);
      expect(row.querySelectorAll('[data-office-count]')).toHaveLength(8);
    });

    it('opens each destination from the row', () => {
      vi.stubGlobal('matchMedia', phoneMedia);
      const open = { chat: vi.fn(), review: vi.fn(), board: vi.fn() };
      const { container } = render(<Office sessions={[]} roomProps={roomProps({ questions: 2, reviewBatches: batchKeys(1), onOpenChat: open.chat, onOpenReview: open.review, onOpenBoard: open.board })} />);
      const row = within(container.querySelector('.office-count-row') as HTMLElement);
      fireEvent.click(row.getByRole('button', { name: 'Open Chat, 2 questions' }));
      fireEvent.click(row.getByRole('button', { name: 'Open Review, 1 batch in review' }));
      for (const { label } of officeColumns()) fireEvent.click(row.getByRole('button', { name: `Open Board, ${label}: 0` }));
      expect([open.chat.mock.calls.length, open.review.mock.calls.length, open.board.mock.calls.length]).toEqual([1, 1, 6]);
    });

    it('lays the count row out as one line of 44 px tall buttons', () => {
      const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
      expect(css).toMatch(/\.office-count-row \{[^}]*display: flex;/);
      expect(css).toMatch(/\.office-count \{[^}]*height: 44px;/);
    });
  });

  it('does not re-render while 100 frames pass without movement or a feed event', async () => {
    const { frame } = stubLoop();
    let renders = 0;
    render(<Profiler id="Office" onRender={() => renders++}><Office sessions={[]} /></Profiler>);
    await sceneReady();
    const afterInitialRender = renders;
    const drawsBefore = scenes[0]!.scene.draw.mock.calls.length;

    for (let i = 0; i < 100; i++) frame();

    expect({ renders: renders - afterInitialRender, draws: scenes[0]!.scene.draw.mock.calls.length - drawsBefore }).toEqual({ renders: 0, draws: 100 });
  });

  it('moves a character through scene draws without updating Office’s frame on each loop tick', async () => {
    const { frame } = stubLoop();
    render(<Office sessions={[session({ state: 'working' })]} />);
    await sceneReady();
    const initialPosition = drawnAgent('s1')!.position;
    const draws = scenes[0]!.scene.draw.mock.calls as DrawCall[];
    const before = draws.length;

    for (let i = 0; i < 100; i++) frame();

    // A loop draw carries the loop's own time (50, 100, …); a draw carrying performance.now() (held at 0 here) comes
    // from the stage's effect on a new Office frame, which the loop publishes only on an arrival or a departure.
    const frameUpdates = draws.slice(before).filter((call) => call[1] === 0).length;
    const moved = drawnAgent('s1')!.position;
    expect({ moved: moved.x !== initialPosition.x || moved.y !== initialPosition.y, loopDraws: draws.slice(before).length - frameUpdates, frameUpdatesAtMostArrival: frameUpdates <= 1 })
      .toEqual({ moved: true, loopDraws: 100, frameUpdatesAtMostArrival: true });
  });

  it('keeps character positions finite when the first frame has a negative dt', async () => {
    const { frame } = stubLoop({ initialPerformanceNow: 1000 });
    render(<Office sessions={[session()]} />);
    await sceneReady();

    frame();

    const agent = drawnAgent('s1')!;
    expect({ x: Number.isFinite(agent.position.x), y: Number.isFinite(agent.position.y) }).toEqual({ x: true, y: true });
  });

  it('keeps the online stage cap and subtracts the offline banner from measured Office height', () => {
    const onlineOfficeHeight = 1080 - 32;
    const offlineBannerHeight = 39 + 8;
    const offlineOfficeHeight = onlineOfficeHeight - offlineBannerHeight;
    const onlineStageWidth = officeStageMaxWidth(onlineOfficeHeight);
    const offlineStageWidth = officeStageMaxWidth(offlineOfficeHeight);

    expect(onlineStageWidth).toBeCloseTo((1080 - 160) * 1680 / 1056, 5);
    expect(offlineStageWidth).toBeCloseTo((1080 - 160 - offlineBannerHeight) * 1680 / 1056, 5);
    expect(onlineStageWidth - offlineStageWidth).toBeCloseTo(offlineBannerHeight * 1680 / 1056, 5);
    expect(officeStageMaxWidth(128)).toBe(0);

    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect(css).toMatch(/width: min\(100%, var\(--office-stage-width\)\);/);
    expect(css).toMatch(/\.office-chat-dock \{[^}]*height: var\(--office-height\);/);
    expect(css).toContain('main:has(> .banner-warn):has(> .office-hold:not([hidden])) > .office-hold');
    expect(css).toContain('.office-reconnecting:not(.office-with-chat) > .office-unavailable');
  });

  it('draws the empty office with one note when no session is running', () => {
    render(<Office sessions={[]} />);
    expect(screen.getByText(OFFICE_EMPTY_NOTE)).toBeTruthy();
    expect(document.querySelectorAll('.office-char')).toHaveLength(0);
  });

  it('shows no note before the first snapshot arrives, so an unloaded office is not called empty', () => {
    render(<Office sessions={null} />);
    expect(screen.queryByText(OFFICE_EMPTY_NOTE)).toBeNull();
    expect(screen.queryByText(OFFICE_UNAVAILABLE_NOTE)).toBeNull();
    expect(document.querySelectorAll('.office-char')).toHaveLength(0);
  });

  it('keeps the last-known room dimmed and frozen, with the unavailable note, while offline', async () => {
    render(<Office sessions={[session()]} offline />);
    await sceneReady();
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-3' })).toBeTruthy();
    expect(screen.getByText(OFFICE_UNAVAILABLE_NOTE)).toBeTruthy();
    expect(screen.queryByText(OFFICE_EMPTY_NOTE)).toBeNull();
    // Frozen: the stage starts no frame loop and draws the room frozen, so no character walks.
    expect({ loop: runningLoop(), frozen: lastDraw()?.[2] }).toEqual({ loop: null, frozen: true });
    // Dimmed: the stage carries the offline class, and the stylesheet rule is what dims it.
    const stage = document.querySelector('.office-stage') as HTMLElement;
    const office = document.querySelector('.office') as HTMLElement;
    expect(stage.className).toContain('office-offline');
    expect(office.className).toContain('office-reconnecting');
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect(css).toMatch(/\.office-stage\.office-offline \{ opacity: 0\.5; \}/);
  });

  it('shows the unavailable note, not the empty one, when offline with an empty last set', () => {
    render(<Office sessions={[]} offline />);
    expect(screen.getByText(OFFICE_UNAVAILABLE_NOTE)).toBeTruthy();
    expect(screen.queryByText(OFFICE_EMPTY_NOTE)).toBeNull();
  });

  it('keeps a stalled character’s look while offline', async () => {
    // Reduced motion places it at its desk, so the walking pose is not the one on screen when the socket drops.
    stubReducedMotion();
    render(<Office sessions={[session({ state: 'working', stalled_since: '2026-09-23T14:03:00.000Z' })]} offline />);
    await sceneReady();
    expect(screen.getByRole('button', { name: /stalled since/ })).toBeTruthy();
    expect(drawnAgent('s1')?.stalled).toBe(true);
    expect(screen.getByText(OFFICE_UNAVAILABLE_NOTE)).toBeTruthy();
  });

  it('adds a labelled character per office message and walks it out when the session leaves', async () => {
    const { frame } = stubLoop();
    const { rerender } = render(<Office sessions={[session()]} />);
    await sceneReady();
    // harness, model and bead id, plus the orchestrator's role in place of a bead id.
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-3' })).toBeTruthy();
    expect(document.querySelectorAll('.office-char')).toHaveLength(1);

    // The App drops a `leaving` session from the feed; the character walks to the door and is then removed.
    rerender(<Office sessions={[]} />);
    const gone = () => screen.queryByRole('button', { name: 'claude · sonnet · ov-3' }) === null;
    for (let i = 0; i < 4000 && !gone(); i++) frame();
    expect(gone()).toBe(true);
  });

  it('replaces the set on the reconnect snapshot: a missing session walks out and a new one walks in', async () => {
    const { frame } = stubLoop();
    const { rerender } = render(<Office sessions={[session({ state: 'working', bead_id: 'ov-3' })]} />);
    await sceneReady();
    // The socket drops: the last-known set is kept, so the character stays drawn through the outage.
    rerender(<Office sessions={[session({ state: 'working', bead_id: 'ov-3' })]} offline />);
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-3' })).toBeTruthy();

    // Reconnect: the fresh snapshot omits ov-3 and names ov-4, so one walks out and the other walks in.
    rerender(<Office sessions={[session({ session_id: 's2', bead_id: 'ov-4' })]} />);
    const gone = () => screen.queryByRole('button', { name: 'claude · sonnet · ov-3' }) === null;
    for (let i = 0; i < 4000 && !gone(); i++) frame();
    expect(gone()).toBe(true);
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-4' })).toBeTruthy();
  });

  it('walks a character named again after a lost socket back to its desk instead of leaving it at the door', async () => {
    const { frame } = stubLoop();
    const { rerender } = render(<Office sessions={[session({ state: 'working' })]} />);
    await sceneReady();
    const label = 'claude · sonnet · ov-3';
    // It reaches its desk first, so the walk back is a real return rather than the arrival.
    const atDesk = () => drawnAtDesk('s1');
    for (let i = 0; i < 2000 && !atDesk(); i++) frame();
    expect(atDesk()).toBe(true);

    // A `leaving` message drops the session, so the character starts walking out; the same session returning (a
    // verification) is named again and walks back to its desk.
    rerender(<Office sessions={[]} />);
    for (let i = 0; i < 10; i++) frame();
    expect({ pose: drawnAgent('s1')?.pose, atDesk: atDesk() }).toEqual({ pose: 'leaving', atDesk: false });
    rerender(<Office sessions={[session({ state: 'working' })]} />);
    for (let i = 0; i < 2000 && !atDesk(); i++) frame();
    expect({ button: !!screen.getByRole('button', { name: label }), spot: drawnAgent('s1')?.assignedSpotId, atDesk: atDesk() })
      .toEqual({ button: true, spot: 'desk-1', atDesk: true });
  });

  it('replaces the label with the resolved model when the harness reports it while the character is on screen', () => {
    stubReducedMotion();
    const { rerender } = render(<Office sessions={[session({ model: null, resolved_model: null })]} />);
    // No model known yet: the label carries no empty model segment and no "no model".
    expect(screen.getByRole('button', { name: 'claude · ov-3' })).toBeTruthy();
    rerender(<Office sessions={[session({ model: null, resolved_model: 'claude-opus-5' })]} />);
    expect(screen.getByRole('button', { name: 'claude · claude-opus-5 · ov-3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'claude · ov-3' })).toBeNull();
  });

  it('draws a stalled session with the stalled look and label, and returns it to typing once the mark clears', async () => {
    stubReducedMotion();
    const { rerender } = render(<Office sessions={[session({ state: 'working', stalled_since: '2026-09-23T14:03:00.000Z' })]} />);
    await sceneReady();
    const stalled = screen.getByRole('button', { name: /stalled since/ });
    // The scene draws the stalled look (clock bubble, dimmed sprite and desk) from the agent's stall flag.
    expect(drawnAgent('s1')?.stalled).toBe(true);
    // Its tooltip and accessible name end with the local time the mark was set.
    expect(stalled.getAttribute('aria-label')).toMatch(/stalled since \d{2}:\d{2}$/);
    expect(stalled.getAttribute('title')).toBe(stalled.getAttribute('aria-label'));
    // Clearing the mark returns the working pose underneath and drops the stall time from the name.
    rerender(<Office sessions={[session({ state: 'working', stalled_since: null })]} />);
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-3' })).toBeTruthy();
    expect({ stalled: drawnAgent('s1')?.stalled, state: drawnAgent('s1')?.state }).toEqual({ stalled: false, state: 'working' });
  });

  it('gives the orchestrator its own desk and a critic a character and label distinct from a worker', async () => {
    stubReducedMotion();
    const orchestrator = session({ session_id: 'orch', role: 'orchestrator', harness: 'claude', model: 'opus', bead_id: null });
    const critic = session({ session_id: 'crit', role: 'critic', harness: 'claude', model: 'fable', bead_id: 'ov-9' });
    render(<Office sessions={[orchestrator, critic]} />);
    await sceneReady();
    const orchButton = screen.getByRole('button', { name: 'claude · opus · orchestrator' });
    const criticButton = screen.getByRole('button', { name: 'claude · fable · ov-9' });
    // `orch` is the orchestrator's own desk, review-1 the first free meeting-table seat for the critic.
    expect([drawnAgent('orch')?.assignedSpotId, drawnAgent('crit')?.assignedSpotId]).toEqual(['orch', 'review-1']);
    expect([drawnAtDesk('orch'), drawnAtDesk('crit')]).toEqual([true, true]);
    expect(criticButton.className).toContain('critic');
    expect(orchButton.className).not.toContain('critic');
  });

  it('focuses the docked Chat composer and scrolls its thread when the orchestrator is clicked', async () => {
    officeMeasurements(1580, 1200);
    mockApi((_method, url) => url.startsWith('/api/chat') ? { rows: chat, has_more: false, oldest_id: chat[0]!.id } : {});
    const onOpenChat = vi.fn();
    const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null, bead_title: null });
    render(<Office sessions={[orchestrator]} onOpenChat={onOpenChat} chatDock={officeChatDock()} />);

    const orchButton = screen.getByRole('button', { name: 'claude · sonnet · orchestrator (focus Chat)' });
    const dock = document.querySelector('.office-chat-dock') as HTMLElement;
    const composer = within(dock).getByRole('textbox', { name: 'Message the orchestrator' });
    const thread = within(dock).getByRole('log', { name: 'Conversation' });
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    setThreadScrollGeometry(thread);

    fireEvent.click(orchButton);

    expect(onOpenChat).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
    expect(atBottom(thread)).toBe(true);
    expect(orchButton.getAttribute('title')).toBe('claude · sonnet · orchestrator (focus Chat)');
  });

  it('closes its Office task pane and focuses docked Chat when the orchestrator is clicked', async () => {
    stubLoop();
    officeMeasurements(1580, 1200);
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (url.startsWith('/api/chat')) return { rows: chat, has_more: false, oldest_id: chat[0]!.id };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onOpenChat = vi.fn();
    const worker = session({ bead_id: 'ov-5' });
    const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null });
    const onSelectTask = vi.fn();
    render(<Office sessions={[worker, orchestrator]} board={board} onOpenChat={onOpenChat} onSelectTask={onSelectTask} chatDock={officeChatDock()} />);
    expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'claude · sonnet · ov-5' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    expect(await within(pane).findByText('Description of Review task')).toBeTruthy();
    const dock = document.querySelector('.office-chat-dock') as HTMLElement;
    expect(dock).toBeTruthy();
    const composer = within(dock).getByRole('textbox', { name: 'Message the orchestrator' });
    const thread = within(dock).getByRole('log', { name: 'Conversation' });
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    setThreadScrollGeometry(thread);
    expect(onSelectTask).toHaveBeenCalledOnce();
    onSelectTask.mockClear();
    const orchButton = screen.getByRole('button', { name: 'claude · sonnet · orchestrator (focus Chat)' });
    expect(orchButton.getAttribute('title')).toBe('claude · sonnet · orchestrator (focus Chat)');
    fireEvent.click(orchButton);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull());
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(onSelectTask).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(composer);
    expect(atBottom(thread)).toBe(true);
    expect(document.querySelector('.office-stage')).toBeTruthy();
    expect(document.querySelectorAll('.office-char')).toHaveLength(2);
  });

  it('closes the App-level batch panel before focusing docked Chat', async () => {
    officeMeasurements(1580, 1200);
    mockApi((_method, url) => url.startsWith('/api/chat') ? { rows: chat, has_more: false, oldest_id: chat[0]!.id } : {});
    const onOpenChat = vi.fn();
    render(<OfficeWithBatchPanel onOpenChat={onOpenChat} />);
    const pane = screen.getByRole('complementary', { name: 'Batch details for r1-b1' });
    const dock = document.querySelector('.office-chat-dock') as HTMLElement;
    const composer = within(dock).getByRole('textbox', { name: 'Message the orchestrator' });
    const thread = within(dock).getByRole('log', { name: 'Conversation' });
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    setThreadScrollGeometry(thread);

    fireEvent.click(screen.getByRole('button', { name: 'claude · sonnet · orchestrator (focus Chat)' }));

    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Batch details for r1-b1' })).toBeNull());
    expect(pane.isConnected).toBe(false);
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
    expect(atBottom(thread)).toBe(true);
  });

  it('opens Chat when the dock gate fails', () => {
    officeMeasurements(1500, 1200);
    const onOpenChat = vi.fn();
    const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null, bead_title: null });
    render(<Office sessions={[orchestrator]} onOpenChat={onOpenChat} chatDock={<div>Dock</div>} />);
    const orchButton = screen.getByRole('button', { name: 'claude · sonnet · orchestrator (opens Chat)' });

    fireEvent.click(orchButton);

    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(orchButton.getAttribute('title')).toBe('claude · sonnet · orchestrator (opens Chat)');
  });

  it('opens Chat when no dock was passed', () => {
    const onOpenChat = vi.fn();
    const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null, bead_title: null });
    render(<Office sessions={[orchestrator]} onOpenChat={onOpenChat} />);
    const orchButton = screen.getByRole('button', { name: 'claude · sonnet · orchestrator (opens Chat)' });

    fireEvent.click(orchButton);

    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(orchButton.getAttribute('title')).toBe('claude · sonnet · orchestrator (opens Chat)');
  });

  it('still scrolls docked Chat to the latest message when offline', async () => {
    officeMeasurements(1580, 1200);
    mockApi((_method, url) => url.startsWith('/api/chat') ? { rows: chat, has_more: false, oldest_id: chat[0]!.id } : {});
    const orchestrator = session({ session_id: 'orch', role: 'orchestrator', bead_id: null, bead_title: null });
    render(<Office sessions={[orchestrator]} offline onOpenChat={vi.fn()} chatDock={officeChatDock(true)} />);
    const dock = document.querySelector('.office-chat-dock') as HTMLElement;
    const thread = within(dock).getByRole('log', { name: 'Conversation' });
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    setThreadScrollGeometry(thread);
    const orchButton = screen.getByRole('button', { name: 'claude · sonnet · orchestrator (focus Chat)' });

    expect((within(dock).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(() => fireEvent.click(orchButton)).not.toThrow();
    expect(atBottom(thread)).toBe(true);
  });

  it('leaves the office as it was when the pane is closed', async () => {
    stubReducedMotion();
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Office sessions={[session({ bead_id: 'ov-5' })]} board={board} />);
    const character = screen.getByRole('button', { name: 'claude · sonnet · ov-5' });
    fireEvent.click(character);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-5' })).toBeTruthy();
    expect(document.activeElement).toBe(character);
    expect(screen.queryByText(OFFICE_EMPTY_NOTE)).toBeNull();
  });

  it('returns focus to the Office character when its task pane closes with Escape', async () => {
    stubReducedMotion();
    mockApi((_m, url) => url.endsWith('/api/tasks/ov-5') ? reviewDetail : {});
    render(<Office sessions={[session({ bead_id: 'ov-5' })]} board={board} />);
    const character = screen.getByRole('button', { name: 'claude · sonnet · ov-5' });
    fireEvent.click(character);
    await screen.findByRole('complementary', { name: 'Details of ov-5' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull());
    expect(document.activeElement).toBe(character);
  });

  it('focuses the Office stage when a task session ends before its pane closes', async () => {
    stubReducedMotion();
    mockApi((_m, url) => url.endsWith('/api/tasks/ov-5') ? reviewDetail : {});
    const view = render(<Office sessions={[session({ bead_id: 'ov-5' })]} board={board} />);
    const character = screen.getByRole('button', { name: 'claude · sonnet · ov-5' });
    fireEvent.click(character);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    const stage = document.querySelector<HTMLElement>('.office-stage')!;
    view.rerender(<Office sessions={[]} board={board} />);
    await waitFor(() => expect(drawnAgent('s1')).toBeUndefined());

    fireEvent.click(within(pane).getByRole('button', { name: 'Close details' }));

    expect(document.activeElement).toBe(stage);
    expect(stage.tabIndex).toBe(-1);
  });

  it('returns focus to the matching character button when a card opened from its badge closes', async () => {
    const { container } = await renderPhoneOffice();
    const character = container.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
    await waitFor(() => expect(container.querySelector('.office-badge[data-badge-for="s1"]')).toBeTruthy());
    fireEvent.click(container.querySelector('.office-badge[data-badge-for="s1"]')!);
    const card = await screen.findByRole('dialog');

    fireEvent.click(within(card).getByRole('button', { name: 'Close details' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(character);
  });

  it('returns focus to the Office character when its phone card closes with Escape', async () => {
    const { container } = await renderPhoneOffice();
    const character = container.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
    fireEvent.click(character);
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(character);
  });

  it('returns focus to the Office character after a tap outside its phone card', async () => {
    const { container } = await renderPhoneOffice();
    const character = container.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
    fireEvent.click(character);
    await screen.findByRole('dialog');

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(character));
  });

  it('uses the new character as the focus target when a tap opens another phone card', async () => {
    const { container } = await renderPhoneOffice([session(), session({ session_id: 's2', bead_id: 'ov-4', bead_title: 'Another task' })]);
    const first = container.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
    const second = container.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s2"]')!;
    fireEvent.click(first);
    await screen.findByRole('dialog', { name: /ov-3/ });
    second.focus();

    fireEvent.pointerDown(second);
    fireEvent.click(second);
    const card = await screen.findByRole('dialog', { name: /ov-4/ });
    expect(document.activeElement).toBe(second);

    fireEvent.click(within(card).getByRole('button', { name: 'Close details' }));
    expect(document.activeElement).toBe(second);
  });

  it('focuses the Office stage when a phone card closes because its session ends', async () => {
    const view = await renderPhoneOffice();
    const character = view.container.querySelector<HTMLButtonElement>('.office-pixi-char[data-agent-id="s1"]')!;
    const stage = view.container.querySelector<HTMLElement>('.office-stage')!;
    fireEvent.click(character);
    await screen.findByRole('dialog');
    view.rerender(<Office sessions={[]} />);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(stage);
    expect(stage.tabIndex).toBe(-1);
  });

  it('closes the Office task pane when a shell panel opens', async () => {
    stubReducedMotion();
    mockApi((_m, url) => url.endsWith('/api/tasks/ov-5') ? reviewDetail : {});
    const sessions = [session({ bead_id: 'ov-5' })];
    const view = render(<Office sessions={sessions} board={board} hostPanelOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude · sonnet · ov-5' }));
    await screen.findByRole('complementary', { name: 'Details of ov-5' });
    view.rerender(<Office sessions={sessions} board={board} hostPanelOpen />);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull());
  });

  it('closes its task pane before handing Open batch to the shell', async () => {
    stubReducedMotion();
    mockApi((_m, url) => url.endsWith('/api/tasks/ov-5') ? reviewDetail : {});
    const onOpenBatch = vi.fn();
    const taskBoard = { ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((card) => card.bead.id === 'ov-5' ? { ...card, batch_id: 'r1-b1' } : card) })) };
    render(<Office sessions={[session({ bead_id: 'ov-5' })]} board={taskBoard} onOpenBatch={onOpenBatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude · sonnet · ov-5' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Open batch r1-b1' }));
    expect(onOpenBatch).toHaveBeenCalledWith('r1-b1');
    expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull();
  });

  it('paints the open pane above the room by isolating the stage stacking context', async () => {
    stubReducedMotion();
    // jsdom lays nothing out, so the stage reports a real size and the label layer draws its z-index:200 boxes.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1020, height: 641 } as DOMRect);
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { container } = render(<Office sessions={[session({ bead_id: 'ov-5' })]} board={board} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude · sonnet · ov-5' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    const office = container.querySelector('.office') as HTMLElement;
    const stage = office.querySelector('.office-stage') as HTMLElement;
    // The pane is a later sibling of the room, and the room's own z-index:10 characters and z-index:200 labels
    // (the pane is z-index 2 on desktop and 3 on phones) live inside the stage.
    expect(pane.parentElement).toBe(office);
    expect(stage.parentElement).toBe(office);
    expect(Array.from(office.children).indexOf(pane)).toBeGreaterThan(Array.from(office.children).indexOf(stage));
    expect(stage.querySelector('.office-char')).toBeTruthy();
    expect(stage.querySelector('.office-labels')).toBeTruthy();
    // So the stage must form its own stacking context, or those layers escape above the pane; deleting this rule
    // puts the characters and labels back over the slide-out/full-screen pane.
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect(css).toMatch(/\.office-stage \{[^}]*isolation: isolate;/);
  });

  it('stops the animation with reduced motion: no frame loop, characters at their desk, an immediate leave', async () => {
    stubReducedMotion();
    const { rerender } = render(<Office sessions={[session()]} />);
    await sceneReady();
    const atDesk = drawnAtDesk('s1');
    const loops = scenes[0]!.scene.setLoop.mock.calls.filter(([loop]) => loop !== null).length;
    rerender(<Office sessions={[]} />);
    const leavesImmediately = screen.queryByRole('button', { name: 'claude · sonnet · ov-3' }) === null && drawnAgent('s1') === undefined;
    expect({ loops, atDesk, leavesImmediately }).toEqual({ loops: 0, atDesk: true, leavesImmediately: true });
    // jsdom performs no CSS layout (getBoundingClientRect/scrollWidth/clientWidth are always 0 here), so the stage
    // never exceeding its container at each responsive width is proven live against a running browser instead: see
    // test:office-pixi-layout, which measures the Pixi stage box at each width.
  });

  it('draws every label in the overlay layer above the room, never inside the character button', () => {
    stubReducedMotion();
    // jsdom lays nothing out, so the stage reports the size a 1300px viewport gives it (1020 x 641).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1020, height: 641 } as DOMRect);
    render(<Office sessions={[session(), session({ session_id: 's2', role: 'orchestrator', bead_id: null, bead_title: null })]} />);
    expect(document.querySelectorAll('.office-char .office-char-label')).toHaveLength(0);
    const labels = document.querySelectorAll<HTMLElement>('.office-labels .office-char-label');
    expect(Array.from(labels).map((l) => l.textContent)).toEqual(['claude · sonnet · ov-3', 'claude · sonnet · orchestrator']);
    // Each label keeps a leader line back to the character it names.
    expect(document.querySelectorAll('.office-label-leaders line')).toHaveLength(2);
    // The layer sits above every character and every furniture sprite; without this rule a desk covers the text.
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect(css).toMatch(/\.office-labels \{[^}]*z-index: 200;/);
    expect(css).not.toMatch(/text-overflow: ellipsis/);
  });

  it('keeps remounted characters moving and every label on its own character when the first frame predates performance.now', async () => {
    const { frame, setPerformanceNow } = stubLoop();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1020, height: 1020 * 1056 / 1680 } as DOMRect);
    const sessions = [session(), session({ session_id: 's2', harness: 'codex', model: null, bead_id: 'ov-4' })];
    const first = render(<Office sessions={sessions} />);
    await sceneReady();
    frame();
    first.unmount();

    // The remounted loop can receive a frame timestamp behind performance.now(). A negative delta must not divide a
    // zero step distance by zero: that NaN would put every character and label at an invalid spot.
    setPerformanceNow(1000);
    render(<Office sessions={sessions} />);
    await sceneReady();
    frame();

    const agents = () => lastDraw()![0].agents;
    const positions = () => agents().map((agent) => `${agent.position.x}|${agent.position.y}`);
    expect(agents().every((agent) => Number.isFinite(agent.position.x) && Number.isFinite(agent.position.y))).toBe(true);
    // Every label is drawn at a distinct spot, and its leader line ends at the feet of the character it names, not at the origin.
    const expectLabelsOnTheirCharacters = () => {
      const labels = Array.from(document.querySelectorAll<HTMLElement>('.office-char-label'));
      const svg = document.querySelector<SVGSVGElement>('.office-label-leaders')!;
      const world = { width: Number(svg.getAttribute('width')), height: Number(svg.getAttribute('height')) };
      const anchors = new Map(pixiLabelInputs(agents()).map((input) => [input.text, input]));
      expect({ labels: labels.length, world: world.width > 0 }).toEqual({ labels: agents().length, world: true });
      expect(new Set(labels.map((label) => `${label.style.left}|${label.style.top}`)).size).toBe(labels.length);
      for (const label of labels) {
        const anchor = anchors.get(label.textContent ?? '');
        expect(anchor, `no character named ${label.textContent}`).toBeTruthy();
        const leader = document.querySelector<SVGLineElement>(`.office-label-leaders line[data-label-leader="${label.dataset.labelFor}"]`);
        expect(leader, `no leader for ${label.dataset.labelFor}`).toBeTruthy();
        expect(parseFloat(leader!.getAttribute('x2')!)).toBeCloseTo((anchor!.x / 100) * world.width, 3);
        expect(parseFloat(leader!.getAttribute('y2')!)).toBeCloseTo((anchor!.y / 100) * world.height, 3);
      }
    };
    expectLabelsOnTheirCharacters();

    // The next frame carries a normal positive delta: the characters move again, and their labels follow them.
    const before = positions();
    frame();
    expect(positions()).not.toEqual(before);
    expectLabelsOnTheirCharacters();
  });

  it('does not start the animation loop while the tab is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    render(<Office sessions={[session()]} />);
    await sceneReady();
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-3' })).toBeTruthy();
    expect({ scene: scenes.length, loop: runningLoop() }).toEqual({ scene: 1, loop: null });
  });

  it('does not start the animation loop while it is not the active view, and starts it once the view returns', async () => {
    const { rerender } = render(<Office sessions={[session()]} active={false} />);
    await sceneReady();
    expect({ scene: scenes.length, loop: runningLoop() }).toEqual({ scene: 1, loop: null });
    rerender(<Office sessions={[session()]} active />);
    expect(runningLoop()).toBeTypeOf('function');
  });

  it('keeps the room while inactive: an ended session walks out and a new one walks in on return, and a seated one does not replay its walk-in', async () => {
    const { frame } = stubLoop();
    const first = session({ session_id: 's1', bead_id: 'ov-5' });
    const second = session({ session_id: 's2', bead_id: 'ov-6' });
    const third = session({ session_id: 's3', bead_id: 'ov-7' });
    const { rerender } = render(<Office sessions={[first, second]} active />);
    await sceneReady();
    const char = (name: string) => screen.getByRole('button', { name });
    const atDesk = () => drawnAtDesk('s1') && drawnAtDesk('s2');
    for (let i = 0; i < 4000 && !atDesk(); i++) frame();
    expect(atDesk()).toBe(true);
    const seated = char('claude · sonnet · ov-6').getAttribute('style');
    // The view is left and, while it is hidden, s1 ends (the feed simply drops it) and s3 starts.
    rerender(<Office sessions={[second, third]} active={false} />);
    // Nothing moved while inactive: the seated character holds its desk, the ended one is still on screen and the new one at the door.
    expect(char('claude · sonnet · ov-6').getAttribute('style')).toBe(seated);
    expect(char('claude · sonnet · ov-5')).toBeTruthy();
    expect(char('claude · sonnet · ov-7')).toBeTruthy();
    // On return the seated character is at its desk before any frame: it does not walk in from the door again.
    rerender(<Office sessions={[second, third]} active />);
    expect(char('claude · sonnet · ov-6').getAttribute('style')).toBe(seated);
    const gone = () => screen.queryByRole('button', { name: 'claude · sonnet · ov-5' }) === null;
    for (let i = 0; i < 4000 && !gone(); i++) frame();
    expect(gone()).toBe(true);
    expect(char('claude · sonnet · ov-7')).toBeTruthy();
  });

  it('does not mount the passed dock when Office content is below the gate', () => {
    officeMeasurements(1500, 1200);
    const { container } = render(<Office sessions={[]} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).toBeNull();
  });

  it('does not mount the dock at exactly 379 px beyond the measured stage', () => {
    officeMeasurements(1579, 1200);
    const { container } = render(<Office sessions={[]} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).toBeNull();
  });

  it('mounts the dock at exactly 380 px beyond the measured stage', () => {
    officeMeasurements(1580, 1200);
    const { container } = render(<Office sessions={[]} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).not.toBeNull();
  });

  it('does not mount the dock beside a 639 px stage, though the content is 380 px wider', () => {
    officeMeasurements(639 + 380, 639);
    const { container } = render(<Office sessions={[]} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).toBeNull();
  });

  it('mounts the dock beside a 640 px stage when the content is 380 px wider', () => {
    officeMeasurements(640 + 380, 640);
    const { container } = render(<Office sessions={[]} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).not.toBeNull();
  });

  it('does not mount the dock beside a 640 px stage when the content is only 379 px wider', () => {
    officeMeasurements(640 + 379, 640);
    const { container } = render(<Office sessions={[]} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).toBeNull();
  });

  it('does not mount the dock when Office is inactive at a wide width', () => {
    officeMeasurements(1580, 1200);
    const { container } = render(<Office sessions={[]} active={false} chatDock={<div>Dock</div>} />);
    expect(container.querySelector('.office-chat-dock')).toBeNull();
  });

  it('keeps the 20 px room gap and 340–400 px dock track in the stylesheet', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'office.css'), 'utf8');
    expect(css).toMatch(/\.office\.office-with-chat\s*\{[^}]*grid-template-columns:\s*var\(--office-stage-width\) 20px minmax\(340px, 400px\);/s);
  });

  it('keeps the dock mounted while an Office task pane overlays it', async () => {
    stubReducedMotion();
    officeMeasurements(1580, 1200);
    mockApi((_method, url) => url.endsWith('/api/tasks/ov-3') ? reviewDetail : { rows: [] });
    const { container } = render(<Office sessions={[session()]} board={board} chatDock={<div>Dock</div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude · sonnet · ov-3' }));
    await screen.findByRole('complementary', { name: 'Details of ov-3' });
    expect(container.querySelector('.office-chat-dock')).not.toBeNull();
  });

  it('does not advance Chat read-through while the measured gate leaves Chat unmounted', async () => {
    officeMeasurements(1500, 1200);
    let reads = 0;
    const readThrough = { current: null as number | null };
    mockApi((_method, url) => {
      if (url.startsWith('/api/chat')) { reads++; return { rows: chat, has_more: false, oldest_id: chat[0]!.id }; }
      return {};
    });
    const attachments = { attachments: [], setAttachments: vi.fn(), hint: null, setHint: vi.fn() };
    const chatDock = <Chat version={0} repos={[repo]} repo="r1" onRepo={vi.fn()} readThrough={readThrough} text="" draftRev={0} onText={vi.fn()} onClearText={vi.fn()} attachments={attachments} />;
    render(<Office sessions={[]} chatDock={chatDock} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ readThrough: readThrough.current, chatLoads: reads }).toEqual({ readThrough: null, chatLoads: 0 });
  });
});
