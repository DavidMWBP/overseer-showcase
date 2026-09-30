import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import type { Agent } from '../types';
import type { SceneFrame } from '../officeModel';
import { SceneSim } from '../sceneSim';
import LabelLayer from '../components/LabelLayer';
import BadgeLayer, { type BadgeInput, type BadgeTap } from '../components/BadgeLayer';
import { badgeFor } from '../badges';
import type { LabelInput, StageSize } from '../labelLayout';
import { p, WORLD_HEIGHT, WORLD_WIDTH } from './world';
import { characterName, characterTarget, isClickable } from './characters';
import { nearestTarget, type Box } from '../touchTarget';
import { routePassedAgentToBoard, type OfficeSceneEffects } from './effects';
import { createScene, type OfficeScene } from './scene';
import type { RoomPropKey, RoomPropsInput } from './roomProps';
import { MIN_HIT_PX, MIN_TOUCH_HIT_PX, RoomPropButtons, useCoarsePointer, type OfficeRoomProps, type VisibleBox } from '../RoomProps';
import { devicePixelOrigin, initialOfficeViewport, panOfficeViewport, resizeOfficeViewport, visibleWorld, type OfficeViewport } from './viewport';

/** How often the HTML overlays (labels, character buttons) follow a moving character, at most. */
const OVERLAY_REFRESH_MS = 33;
/** A movement this large is a pan, so it must not open the character under the pointer. */
const DRAG_THRESHOLD_PX = 6;
/** A label's anchor sits this many world pixels below the feet. */
const LABEL_DROP = 8;
/** A phone badge's anchor sits this many world pixels above the feet: over the head and over the speech bubble, whose top is 126 px up plus a 2 px bob. */
export const BADGE_LIFT = 132;

/** Label inputs in percent of the stage, from the world position of each character's feet. */
export function pixiLabelInputs(agents: readonly Agent[]): LabelInput[] {
  return agents.map((agent) => {
    const [x, y] = p(agent.position.x, agent.position.y);
    return {
      id: agent.id,
      text: agent.labelText,
      x: (x / WORLD_WIDTH) * 100,
      y: ((y + LABEL_DROP) / WORLD_HEIGHT) * 100,
      className: agent.role === 'critic' || agent.role === 'orchestrator' ? agent.role : undefined,
    };
  });
}

/** Phone badge inputs in percent of the stage, anchored above each character's head and bubble. */
export function pixiBadgeInputs(agents: readonly Agent[], repoOrder: readonly string[]): BadgeInput[] {
  return agents.map((agent) => {
    const [x, y] = p(agent.position.x, agent.position.y);
    return { id: agent.id, text: '', x: (x / WORLD_WIDTH) * 100, y: ((y - BADGE_LIFT) / WORLD_HEIGHT) * 100, badge: badgeFor(agent, repoOrder) };
  });
}

/**
 * The character a touch tap on the badge layer opens. A badge's target reaches down over the heads below it and covers
 * their own targets there, so the tap goes to whichever centre is nearest: the nearest badge's (`tap.distance`) or the
 * nearest character target's that holds the tap, both in overlay CSS px at `scale`. The character targets are fitted
 * inside `visible` (world px), as the scene fits them.
 */
export function badgeTapTarget(badgeId: string, tap: BadgeTap, agents: readonly Agent[], scale: number, minCss: number, visible?: Box): string {
  if (scale <= 0) return badgeId;
  const targets = agents.filter(isClickable).map((agent) => {
    const [x, y] = p(agent.position.x, agent.position.y);
    return characterTarget({ id: agent.id, x, y }, scale, minCss, visible);
  });
  const body = nearestTarget(targets, tap.x / scale, tap.y / scale);
  return body && body.distance * scale < tap.distance ? body.id : badgeId;
}

/** True while at least one character is working, verifying or reviewing: the dim overlay is off. */
export function anyoneWorking(agents: readonly Agent[]): boolean {
  return agents.some((agent) => agent.pose !== 'leaving' && (agent.state === 'working' || agent.state === 'verifying' || agent.state === 'reviewing'));
}

/** The stage box in the world overlays' coordinates, which the viewport translates by its origin and camera. */
export function visibleBox(viewport: OfficeViewport): VisibleBox {
  const left = -(viewport.originX + viewport.x);
  const top = -(viewport.originY + viewport.y);
  return { left, top, right: left + viewport.stageWidth, bottom: top + viewport.stageHeight };
}

interface OfficeStageProps {
  /** The live frame the sim advances; Office owns it so a feed update and the ticker write the same frame. */
  frameRef: RefObject<SceneFrame>;
  /** The last frame Office rendered: a new one redraws the scene while the loop is stopped. */
  frame: SceneFrame;
  stageRef: RefObject<HTMLDivElement | null>;
  /** The sim advances only while this is true (not reduced, hidden, offline or behind another view). */
  running: boolean;
  unavailable: boolean;
  reduced: boolean;
  nightShare: number;
  effects: OfficeSceneEffects;
  asking: boolean;
  /** An arrival or a departure: Office re-renders from this frame (the empty note reads it). */
  onFrame: (frame: SceneFrame) => void;
  /** What a click on this character does, or undefined when it does nothing. */
  openerFor: (agent: Agent) => { onOpen?: () => void; opens?: string };
  /** Phone only: the repository order the badges colour by. Set, the stage draws badges instead of the text labels, and each character's name carries its task and repository (`none` when it has neither). */
  badgeRepoOrder?: readonly string[];
  /** The counts the room's objects draw (`roomProps.ts`), or null to draw none. */
  roomPropsInput?: RoomPropsInput | null;
  /** Where a tap on each object goes; the objects are tappable wherever they are drawn. */
  roomProps?: OfficeRoomProps;
  /** Desktop: a transparent button over each object carries its name and the keyboard route; the phone row replaces them. */
  roomPropButtons?: boolean;
  /** False (the `?capture=1` option) draws neither the labels nor the phone badges; the character buttons keep their names. */
  nameTags?: boolean;
  children?: ReactNode;
}

/** The fixed Pixi viewport moves its canvas, character buttons, labels and the count objects' buttons together; dimming stays on the box. */
export function OfficeStage({ frameRef, frame, stageRef, running, unavailable, reduced, nightShare, effects, asking, onFrame, openerFor, badgeRepoOrder, roomPropsInput = null, roomProps, roomPropButtons = false, nameTags = true, children }: OfficeStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState<OfficeViewport | null>(null);
  const viewportRef = useRef<OfficeViewport | null>(null);
  const pointerPan = useRef<{ id: number; startX: number; startY: number; origin: OfficeViewport; dragged: boolean } | null>(null);
  const suppressTap = useRef(false);
  const [, setOverlayTick] = useState(0);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const openerRef = useRef(openerFor);
  openerRef.current = openerFor;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const askingRef = useRef(asking);
  askingRef.current = asking;
  const nightShareRef = useRef(nightShare);
  nightShareRef.current = nightShare;
  const roomPropsRef = useRef(roomPropsInput);
  roomPropsRef.current = roomPropsInput;
  const roomOpenersRef = useRef(roomProps);
  roomOpenersRef.current = roomProps;
  const phoneRef = useRef(badgeRepoOrder !== undefined);
  phoneRef.current = badgeRepoOrder !== undefined;
  /** The object under the pointer: its button shows its chip, as keyboard focus does. */
  const [hoverProp, setHoverProp] = useState<RoomPropKey | null>(null);
  const routedPassId = useRef<number | null>(null);
  const coarse = useCoarsePointer();
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    const measure = () => {
      let rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        const stage = stageRef.current;
        if (!stage) return;
        const stageRect = stage.getBoundingClientRect();
        const style = getComputedStyle(stage);
        const left = Number.parseFloat(style.borderLeftWidth) || 0;
        const right = Number.parseFloat(style.borderRightWidth) || 0;
        const top = Number.parseFloat(style.borderTopWidth) || 0;
        const bottom = Number.parseFloat(style.borderBottomWidth) || 0;
        const stageLeft = Number.isFinite(stageRect.left) ? stageRect.left : 0;
        const stageTop = Number.isFinite(stageRect.top) ? stageRect.top : 0;
        rect = { ...stageRect, x: stageLeft + left, y: stageTop + top, left: stageLeft + left, top: stageTop + top, width: stageRect.width - left - right, height: stageRect.height - top - bottom } as DOMRect;
      }
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const origin = { x: devicePixelOrigin(rect.left, dpr), y: devicePixelOrigin(rect.top, dpr) };
      const previous = viewportRef.current;
      if (previous && previous.stageWidth === rect.width && previous.stageHeight === rect.height
        && previous.devicePixelRatio === dpr && previous.originX === origin.x && previous.originY === origin.y) return;
      const next = previous
        ? resizeOfficeViewport(previous, rect.width, rect.height, dpr, origin)
        : initialOfficeViewport(rect.width, rect.height, dpr, origin);
      viewportRef.current = next;
      sceneRef.current?.setViewport(next);
      setViewport(next);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();
    createScene(host, {
      reduced: () => reducedRef.current,
      onTap: (id) => {
        if (suppressTap.current) { suppressTap.current = false; return; }
        const agent = frameRef.current.agents.find((candidate) => candidate.id === id);
        if (agent) openerRef.current(agent).onOpen?.();
      },
      onPropTap: (prop) => {
        if (suppressTap.current) { suppressTap.current = false; return; }
        const openers = roomOpenersRef.current;
        if (!openers) return;
        ({ questions: openers.onOpenChat, review: openers.onOpenReview, board: openers.onOpenBoard })[prop]();
      },
      onPropHover: setHoverProp,
      // The phone layout has no hover: no highlight and no chip.
      hoverable: () => !phoneRef.current,
      minHitPx: () => (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? MIN_TOUCH_HIT_PX : MIN_HIT_PX),
      characterMinHitPx: () => (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? MIN_TOUCH_HIT_PX : 0),
    }).then((scene) => {
      if (dead) { scene.destroy(); return; }
      sceneRef.current = scene;
      if (viewportRef.current) scene.setViewport(viewportRef.current);
      setReady(true);
    }, (error: unknown) => console.error('office pixi', error));
    return () => {
      dead = true;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, [frameRef]);

  const publishViewport = (next: OfficeViewport) => {
    viewportRef.current = next;
    sceneRef.current?.setViewport(next);
    setViewport(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    suppressTap.current = false;
    pointerPan.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origin: viewportRef.current, dragged: false };
  };

  const publishViewportRef = useRef(publishViewport);
  publishViewportRef.current = publishViewport;
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = pointerPan.current;
      if (!drag || drag.id !== event.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.dragged && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
      if (!drag.dragged) {
        drag.dragged = true;
        // The room moves under a still pointer: the hover target holds until the drag ends.
        sceneRef.current?.setPanning(true);
        try { stageRef.current?.setPointerCapture(event.pointerId); } catch { /* jsdom and detached stages do not capture pointers */ }
      }
      suppressTap.current = true;
      publishViewportRef.current(panOfficeViewport(drag.origin, deltaX, deltaY));
    };
    const up = (event: PointerEvent) => {
      if (pointerPan.current?.id !== event.pointerId) return;
      if (pointerPan.current.dragged) sceneRef.current?.setPanning(false);
      pointerPan.current = null;
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [stageRef]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      const current = viewportRef.current;
      if (!current) return;
      const next = panOfficeViewport(current, -event.deltaX, -event.deltaY);
      if (next.x === current.x && next.y === current.y) return;
      event.preventDefault();
      publishViewportRef.current(next);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [stageRef]);

  useEffect(() => {
    const pass = effects.printer;
    if (!pass || pass.kind !== 'verify_passed' || pass.id === routedPassId.current) return;
    routedPassId.current = pass.id;
    if (pass.reduced || reduced || unavailable || !running || !pass.beadId) return;
    const previous = frameRef.current;
    let changed = false;
    const agents = previous.agents.map((agent) => {
      if (agent.beadId !== pass.beadId || agent.pose === 'leaving') return agent;
      changed = true;
      return routePassedAgentToBoard(agent);
    });
    if (!changed) return;
    const next = { ...previous, agents };
    frameRef.current = next;
    onFrameRef.current(next);
  }, [effects.printer, reduced, unavailable, running, frameRef]);

  useEffect(() => {
    sceneRef.current?.draw(frameRef.current, performance.now(), !running, nightShare, effects, asking, roomPropsInput);
  }, [ready, frame, running, frameRef, nightShare, effects, asking, roomPropsInput]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !running) return;
    let last = performance.now();
    let lastOverlay = 0;
    scene.setLoop((now) => {
      const dt = (now - last) / 16.67;
      last = now;
      const previous = frameRef.current;
      const next = SceneSim.step(previous, dt, now);
      frameRef.current = next;
      scene.draw(next, now, false, nightShareRef.current, effectsRef.current, askingRef.current, roomPropsRef.current);
      const before = new Map(previous.agents.map((agent) => [agent.id, agent]));
      const arrived = next.agents.some((agent) => before.get(agent.id)?.pose !== agent.pose && agent.pose === 'arrived');
      const departed = next.agents.length < previous.agents.length;
      if (arrived || departed) onFrameRef.current(next);
      const moved = next.agents.some((agent) => {
        const old = before.get(agent.id);
        return !old || old.position.x !== agent.position.x || old.position.y !== agent.position.y;
      });
      if (moved && now - lastOverlay > OVERLAY_REFRESH_MS) { lastOverlay = now; setOverlayTick(now); }
    });
    return () => scene.setLoop(null);
  }, [ready, running, frameRef]);

  const agents = frameRef.current.agents;
  const k = viewport?.scale ?? 0;
  // The button covers the character's tap target: 44 CSS px a side at least on a touch pointer, inside the stage.
  const shown = viewport ? visibleWorld(viewport) : undefined;
  const worldSize: StageSize = { width: viewport?.worldWidth ?? 0, height: viewport?.worldHeight ?? 0 };
  const overlayTransform = viewport
    ? `translate3d(${viewport.originX + viewport.x}px, ${viewport.originY + viewport.y}px, 0)`
    : 'translate3d(0, 0, 0)';
  return (
    <div className={`office-stage office-stage-pixi${unavailable ? ' office-offline' : ''}`} ref={stageRef} tabIndex={-1}
      data-office-pixel-scale={viewport?.pixelScale} data-office-css-scale={viewport?.scale}
      data-office-camera-x={viewport?.x} data-office-camera-y={viewport?.y} data-office-origin-x={viewport?.originX} data-office-origin-y={viewport?.originY}
      onPointerDown={onPointerDown}>
      <div className="office-pixi-canvas" ref={hostRef} />
      <div className="office-pixi-dim" aria-hidden="true" style={{ opacity: anyoneWorking(agents) ? 0 : 1 }} />
      <div className="office-pixi-world-overlays" style={{ transform: overlayTransform }}>
        <div className="office-pixi-hits">
          {agents.map((agent) => {
            const [x, y] = p(agent.position.x, agent.position.y);
            const hit = characterTarget({ id: agent.id, x, y }, k, coarse ? MIN_TOUCH_HIT_PX : 0, shown);
            const { onOpen, opens } = isClickable(agent) ? openerRef.current(agent) : {};
            const name = characterName(agent, opens, badgeRepoOrder !== undefined);
            return <button key={agent.id} type="button" className={`office-char office-pixi-char${agent.role === 'critic' ? ' critic' : ''}${agent.role === 'orchestrator' ? ' orchestrator' : ''}`}
              data-agent-id={agent.id} aria-label={name} title={name} disabled={!onOpen} onClick={onOpen}
              style={{ left: hit.left * k, top: hit.top * k, width: hit.width * k, height: hit.height * k }} />;
          })}
        </div>
        {!nameTags ? null : badgeRepoOrder
          ? <BadgeLayer stage={worldSize} inputs={pixiBadgeInputs(agents, badgeRepoOrder)} visible={viewport ? visibleBox(viewport) : undefined} onOpen={(badgeId, tap) => {
            const current = frameRef.current.agents;
            const now = viewportRef.current;
            const id = tap && now ? badgeTapTarget(badgeId, tap, current, now.scale, MIN_TOUCH_HIT_PX, visibleWorld(now)) : badgeId;
            const agent = current.find((candidate) => candidate.id === id);
            if (agent && isClickable(agent)) openerRef.current(agent).onOpen?.();
          }} />
          : <LabelLayer stage={worldSize} inputs={pixiLabelInputs(agents)} prefer="below" />}
      </div>
      {roomPropButtons && roomProps && (
        <div className="office-room-props-layer" style={{ transform: overlayTransform }}>
          <RoomPropButtons props={roomProps} scale={k} hovered={hoverProp}
            visible={viewport ? visibleBox(viewport) : undefined} />
        </div>
      )}
      {children}
    </div>
  );
}
