import { Application, ColorMatrixFilter, Container, Graphics, Rectangle, Sprite, Texture, type FederatedPointerEvent, type Ticker } from 'pixi.js';
import type { SceneFrame } from '../officeModel';
import type { Agent } from '../types';
import {
  depthZ, furnitureDisplay, furniturePieces, furnitureSpritePlacements, isSeated, positionFurnitureSprite,
  type FurniturePiece, type FurnitureSpritePlacement,
} from './furniture';
import { characterTarget, createCharacter, nearestCharacter, updateCharacter, type CharacterView } from './characters';
import { loadOfficeArt, ROOM_DAY, ROOM_NIGHT_WINDOWS, type OfficeArt } from './assets';
import { nightSkyShapes, roomShapes, shapesDataUrl } from './room';
import { sceneColorMatrix, buildFloorGrade, buildLights, updateFloorGrade, updateLights } from './lights';
import { createEffectLayer, qaScreenState, type OfficeSceneEffects } from './effects';
import { devicePixelOrigin, initialOfficeViewport, visibleWorld, type OfficeViewport } from './viewport';
import { fitInside } from '../touchTarget';
import { createRoomPropsView, FOLDER_Z, PROP_COLUMNS, propHitArea, ROOM_PROP_KEYS, RoomPropsAnimator, type RoomPropKey, type RoomPropsInput } from './roomProps';
import { readingFolderItems } from './readingFolders';

/** One Pixi Application holds the room textures, depth-sorted furniture and characters, lighting, and effects. */
export interface OfficeScene {
  /** Draw a frame: create, move and remove characters, dim the desks of stalled occupants, and draw the count objects. */
  draw(frame: SceneFrame, now: number, frozen: boolean, nightShare?: number, effects?: OfficeSceneEffects, asking?: boolean, roomProps?: RoomPropsInput | null): void;
  /** Run `step` on every tick, or stop the ticker when null; a stopped scene renders only when drawn. */
  setLoop(step: ((now: number) => void) | null): void;
  setViewport(viewport: OfficeViewport): void;
  /** While a drag pans the room the hover target holds still; when it ends the target is the one under the pointer. */
  setPanning(panning: boolean): void;
  destroy(): void;
}

/** What the pointer is over: a character or a count object. A character in front of an object takes it, as it takes the tap. */
export type HoverTarget = { kind: 'agent'; id: string } | { kind: 'prop'; prop: RoomPropKey };

/**
 * The hover highlight: the hovered character or object drawn brighter, its darks lifted too, under the scene colour
 * matrix, so it reads by day and at night. It changes no position or size and does not animate.
 */
export const HOVER_MATRIX = [
  1.25, 0, 0, 0, 0.12,
  0, 1.25, 0, 0, 0.12,
  0, 0, 1.25, 0, 0.12,
  0, 0, 0, 1, 0,
];

/** The count object a room-prop item belongs to, or null for one that is not a tap target (a reviewer's open folder). */
export function propOfItem(key: string): RoomPropKey | null {
  if (key === 'question-note') return 'questions';
  if (key.startsWith('folder-') || key.startsWith('stack-')) return 'review';
  if (key === 'board' || key.startsWith('note-') || key.startsWith('header-')) return 'board';
  return null;
}

const hoverName = (target: HoverTarget | null) => (target ? (target.kind === 'agent' ? `agent:${target.id}` : `prop:${target.prop}`) : '');

let images: { room: string; night: string } | null = null;

/** Generated fallback images used only if a PixelLab room texture cannot be loaded. */
export function roomImages(): { room: string; night: string } {
  images ??= { room: shapesDataUrl(roomShapes()), night: shapesDataUrl(nightSkyShapes()) };
  return images;
}

async function textureFromDataUrl(url: string): Promise<Texture> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const texture = Texture.from(image);
  texture.source.scaleMode = 'nearest';
  return texture;
}

export function applySceneColorMatrix(layers: readonly Container[], filter: ColorMatrixFilter, darkness: number): void {
  const amount = Math.max(0, Math.min(1, darkness));
  if (amount > 0) {
    filter.matrix = sceneColorMatrix(amount) as typeof filter.matrix;
    for (const layer of layers) layer.filters = [filter];
  } else {
    for (const layer of layers) layer.filters = [];
  }
}

/** A `-lit` overlay sorts just after its base piece and before anything keyed on the next depth step. */
export const LIT_DEPTH_EPSILON = 0.5;

export function overlayZIndex(placement: FurnitureSpritePlacement): number {
  return depthZ(placement.depth) + LIT_DEPTH_EPSILON;
}

export type DepthRun<T> = { lit: false; items: T[] } | { lit: true; item: T };

/**
 * Split the entity depth order at each shown `-lit` overlay. The runs between overlays take the scene colour matrix and
 * the overlays stay out of it, while every overlay still draws behind whatever stands in front of its piece. The first
 * run always exists, since the room and night backgrounds go under it.
 */
export function depthRuns<T extends { zIndex: number }>(scene: readonly T[], lit: readonly T[]): DepthRun<T>[] {
  const ordered = [...scene.map((item) => ({ item, lit: false })), ...lit.map((item) => ({ item, lit: true }))]
    .sort((a, b) => a.item.zIndex - b.item.zIndex);
  const runs: DepthRun<T>[] = [{ lit: false, items: [] }];
  for (const entry of ordered) {
    const last = runs.at(-1)!;
    if (entry.lit) runs.push({ lit: true, item: entry.item });
    else if (last.lit) runs.push({ lit: false, items: [entry.item] });
    else last.items.push(entry.item);
  }
  return runs;
}

function addSpotDisplay(displays: Map<string, Container[]>, spotId: string | undefined, display: Container): void {
  if (!spotId) return;
  displays.set(spotId, [...(displays.get(spotId) ?? []), display]);
}

function furniturePieceDisplays(
  piece: FurniturePiece,
  placement: FurnitureSpritePlacement | undefined,
  art: OfficeArt,
): { displays: Container[]; showState?: (asset: string) => void } {
  if (!placement) return { displays: [furnitureDisplay(piece)] };

  if (placement.states) {
    const sprites = placement.states.flatMap((asset) => {
      const texture = art.texture(asset);
      return texture ? [{ asset, sprite: furnitureDisplay(piece, texture, { ...placement, asset }) }] : [];
    });
    const fallback = furnitureDisplay(piece) as Graphics;
    // A state whose texture failed to load shows the piece's Graphics fallback instead.
    const showState = (asset: string) => {
      for (const entry of sprites) entry.sprite.visible = entry.asset === asset;
      fallback.visible = !sprites.some((entry) => entry.asset === asset);
    };
    showState(placement.asset);
    return { displays: [...sprites.map((entry) => entry.sprite), fallback], showState };
  }

  return { displays: [furnitureDisplay(piece, art.texture(placement.asset), placement)] };
}

/** A lit screen's peak overlay alpha: its rim light reads as a soft edge on the dark base rather than a hard line. */
export const SCREEN_OVERLAY_ALPHA = 0.6;

/** A screen overlay is lit while an agent seated at one of its seats is working or verifying. */
export function overlayAlpha(mode: 'night' | 'screen', spotIds: readonly string[] | undefined, agents: readonly Agent[], darkness: number): number {
  if (mode === 'night') return darkness;
  const working = agents.some((agent) => spotIds?.includes(agent.assignedSpotId) && isSeated(agent)
    && !agent.stalled && (agent.state === 'working' || agent.state === 'verifying'));
  return working ? SCREEN_OVERLAY_ALPHA * darkness : 0;
}

export interface SceneOptions {
  reduced: () => boolean;
  onTap: (agentId: string) => void;
  /** A tap on a count object; its hit area lies under every character, so a character in front of it takes the tap. */
  onPropTap?: (prop: RoomPropKey) => void;
  /** The count object the hover target is, or null when the pointer leaves it or a character in front of it takes it. */
  onPropHover?: (prop: RoomPropKey | null) => void;
  /** False turns hover off (the phone layout); a touch pointer never hovers. */
  hoverable?: () => boolean;
  /** The smallest hit area side in CSS px: 24, or 44 on a touch pointer. */
  minHitPx?: () => number;
  /**
   * The smallest side of a character's tap target in CSS px: 44 on a touch pointer, where a tap inside several
   * characters' targets opens the one whose centre is nearest; 0 on a fine pointer, which keeps `HIT_AREA` and the
   * topmost character.
   */
  characterMinHitPx?: () => number;
}

export async function createScene(host: HTMLElement, options: SceneOptions): Promise<OfficeScene> {
  const app = new Application();
  const hostRect = host.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const viewport = initialOfficeViewport(
    hostRect.width || host.clientWidth || 800,
    hostRect.height || host.clientHeight || 500,
    dpr,
    { x: devicePixelOrigin(hostRect.left, dpr), y: devicePixelOrigin(hostRect.top, dpr) },
  );
  await app.init({
    width: viewport.canvasWidth,
    height: viewport.canvasHeight,
    backgroundAlpha: 0,
    antialias: false,
    autoStart: false,
    resolution: dpr,
    autoDensity: true,
    roundPixels: true,
  });
  let art: OfficeArt;
  let roomTexture: Texture;
  let nightTexture: Texture;
  try {
    art = await loadOfficeArt();
    const fallback = roomImages();
    roomTexture = art.texture(ROOM_DAY) ?? await textureFromDataUrl(fallback.room);
    nightTexture = art.texture(ROOM_NIGHT_WINDOWS) ?? await textureFromDataUrl(fallback.night);
  } catch (error) {
    app.destroy(true, { children: true });
    throw error;
  }

  host.appendChild(app.canvas);
  Object.assign(app.canvas.style, { display: 'block', position: 'absolute' });

  const world = new Container();
  const room = new Sprite(roomTexture);
  room.label = 'room-day';
  const night = new Sprite(nightTexture);
  night.label = 'room-night-windows';
  night.alpha = 0;
  // `draw` orders the entities itself: filtered runs of furniture and characters, with the `-lit` overlays between them.
  const entities = new Container();
  const runs: Container[] = [];
  const sceneDisplays: Container[] = [];
  const lightsContainer = new Container();
  const effectLayer = createEffectLayer(art, app.canvas);
  world.addChild(entities, lightsContainer, effectLayer.root);
  app.stage.addChild(world);

  const pieces = furniturePieces();
  const placements = new Map(furnitureSpritePlacements().map((placement) => [placement.id, placement]));
  const bySpot = new Map<string, Container[]>();
  let showQaScreen: ((asset: string) => void) | undefined;
  // A desk screen shows its first state (on) while someone sits at its seat, its second (off) otherwise.
  const deskScreens: { spotId: string; states: string[]; show: (asset: string) => void }[] = [];
  for (const piece of pieces) {
    const placement = placements.get(piece.id);
    const { displays, showState } = furniturePieceDisplays(piece, placement, art);
    for (const display of displays) {
      sceneDisplays.push(display);
      addSpotDisplay(bySpot, piece.spotId, display);
    }
    if (piece.id === 'qa-screen') showQaScreen = showState;
    else if (showState && placement?.states && piece.spotId) deskScreens.push({ spotId: piece.spotId, states: placement.states, show: showState });
  }

  const overlaySprites: { sprite: Sprite; mode: 'night' | 'screen'; spotIds?: string[]; state?: string }[] = [];
  for (const placement of placements.values()) {
    for (const overlay of placement.overlays ?? []) {
      const texture = art.texture(overlay.asset);
      if (!texture) continue;
      const sprite = new Sprite(texture);
      positionFurnitureSprite(sprite, { ...placement, asset: overlay.asset });
      sprite.zIndex = overlayZIndex(placement);
      sprite.alpha = 0;
      overlaySprites.push({ sprite, mode: overlay.mode, ...(overlay.spotIds ? { spotIds: overlay.spotIds } : {}), ...(overlay.state ? { state: overlay.state } : {}) });
    }
    if (!pieces.some((piece) => piece.id === placement.id)) {
      const texture = art.texture(placement.asset);
      if (!texture) continue;
      const sprite = new Sprite(texture);
      positionFurnitureSprite(sprite, placement);
      sceneDisplays.push(sprite);
    }
  }

  const lights = buildLights(lightsContainer);
  const floorGrade = buildFloorGrade();
  // Both colour matrices render at the canvas's own resolution: a filter defaults to 1, which at dpr 2 renders its runs at
  // half the device resolution and scales them back up with linear sampling, blurring every filtered sprite.
  const colorFilter = new ColorMatrixFilter({ resolution: 'inherit' });
  const propsAnimator = new RoomPropsAnimator();
  const propsView = createRoomPropsView((key) => art.texture(key));
  const characters = new Map<string, CharacterView>();
  let loop: ((ticker: Ticker) => void) | null = null;
  let destroyed = false;

  // Hover: Pixi reports the topmost target under the pointer (and sets the canvas cursor from its `cursor`); the scene
  // keeps the character and the object it is over apart, so a character in front of an object wins however the events
  // arrive, and holds the target still while a drag pans the room.
  const hoverFilter = new ColorMatrixFilter({ resolution: 'inherit' });
  hoverFilter.matrix = HOVER_MATRIX as typeof hoverFilter.matrix;
  let overAgent: string | null = null;
  let overProp: RoomPropKey | null = null;
  let hovered: HoverTarget | null = null;
  let panning = false;
  let propTargets: { display: Container; prop: RoomPropKey }[] = [];
  const canHover = (event?: FederatedPointerEvent) => event?.pointerType !== 'touch' && (options.hoverable?.() ?? true);
  const highlight = (display: Container, on: boolean) => {
    if (((display.filters as readonly unknown[] | null | undefined)?.length ?? 0) > 0 !== on) display.filters = on ? [hoverFilter] : [];
  };
  const applyHover = () => {
    for (const [id, view] of characters) highlight(view.root, hovered?.kind === 'agent' && hovered.id === id);
    for (const { display, prop } of propTargets) highlight(display, hovered?.kind === 'prop' && hovered.prop === prop);
    app.canvas.dataset.officeHover = hoverName(hovered);
  };
  /** Adopt the target under the pointer, unless a drag holds it; a character that left the room is dropped even then. */
  const updateHover = (): boolean => {
    if (panning && !(hovered?.kind === 'agent' && !characters.has(hovered.id))) return false;
    const next: HoverTarget | null = panning ? null
      : overAgent !== null ? { kind: 'agent', id: overAgent } : overProp !== null ? { kind: 'prop', prop: overProp } : null;
    if (hoverName(next) === hoverName(hovered)) return false;
    const before = hovered?.kind === 'prop' ? hovered.prop : null;
    hovered = next;
    const after = next?.kind === 'prop' ? next.prop : null;
    if (before !== after) options.onPropHover?.(after);
    return true;
  };
  const refreshHover = () => {
    if (destroyed || !updateHover()) return;
    applyHover();
    if (!app.ticker.started) app.render();
  };
  const onAgentHover = (id: string, over: boolean, event?: FederatedPointerEvent) => {
    if (over && !canHover(event)) return;
    if (over) overAgent = id;
    else if (overAgent === id) overAgent = null;
    refreshHover();
  };
  // Pixi delivers the tap to the topmost character whose target holds it; on a touch pointer the nearest centre among
  // every character whose target holds it wins instead. The objects' hit areas lie under every character either way.
  const onCharacterTap = (id: string, event?: FederatedPointerEvent) => {
    const min = options.characterMinHitPx?.() ?? 0;
    if (min <= 0 || !event) { options.onTap(id); return; }
    const tappable = [...characters].filter(([, view]) => view.root.eventMode === 'static').map(([key, view]) => ({ id: key, ...view.at }));
    options.onTap(nearestCharacter(event.getLocalPosition(world), tappable, currentViewport.scale, min, visibleWorld(currentViewport)) ?? id);
  };
  /**
   * Each character's and object's hit area at the current scale. On a touch pointer a target is at least 44 CSS px a
   * side and fitted inside the part of the world the stage shows, so a target at the stage's edge is not clipped;
   * a pan or a resize refits them. A fine pointer keeps `HIT_AREA` and the objects' own minimum.
   */
  const fitHitAreas = () => {
    const min = options.characterMinHitPx?.() ?? 0;
    const scale = currentViewport.scale;
    const visible = min > 0 ? visibleWorld(currentViewport) : undefined;
    for (const [id, view] of characters) {
      if (view.root.eventMode !== 'static') continue;
      const target = characterTarget({ id, ...view.at }, scale, min, visible);
      const [x, y] = [target.left - view.at.x, target.top - view.at.y];
      const area = view.root.hitArea as Rectangle | null | undefined;
      if (area?.x !== x || area.y !== y || area.width !== target.width || area.height !== target.height) {
        view.root.hitArea = new Rectangle(x, y, target.width, target.height);
      }
    }
    for (const { prop, hit } of propHits) {
      const minPx = options.minHitPx?.() ?? 24;
      const [x, y, w, h] = propHitArea(prop, scale, minPx);
      const fitted = fitInside({ left: x, top: y, width: w, height: h }, visible, minPx / scale);
      hit.hitArea = new Rectangle(fitted.left, fitted.top, fitted.width, fitted.height);
    }
  };
  const propHits = ROOM_PROP_KEYS.map((prop) => {
    const hit = new Container();
    hit.label = `prop-hit-${prop}`;
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.zIndex = -1;
    hit.on('pointertap', () => options.onPropTap?.(prop));
    hit.on('pointerover', (event?: FederatedPointerEvent) => {
      if (!canHover(event)) return;
      overProp = prop;
      refreshHover();
    });
    hit.on('pointerout', () => {
      if (overProp === prop) overProp = null;
      refreshHover();
    });
    return { prop, hit };
  });
  // The QA wall screen's clock holds still on frozen frames, as the effect layer's does.
  let screenClock: number | null = null;
  let runningSince: number | null = null;
  let screenFrozen = false;

  let currentViewport = viewport;
  const setViewport = (next: OfficeViewport) => {
    if (destroyed || next.stageWidth <= 0 || next.stageHeight <= 0) return;
    if (next.devicePixelRatio !== currentViewport.devicePixelRatio) app.renderer.resolution = next.devicePixelRatio;
    if (next.canvasWidth !== currentViewport.canvasWidth || next.canvasHeight !== currentViewport.canvasHeight
      || next.devicePixelRatio !== currentViewport.devicePixelRatio) {
      app.renderer.resize(next.canvasWidth, next.canvasHeight);
    }
    Object.assign(app.canvas.style, {
      left: `${next.originX}px`,
      top: `${next.originY}px`,
      width: `${next.canvasWidth}px`,
      height: `${next.canvasHeight}px`,
    });
    world.scale.set(next.scale);
    world.position.set(next.x, next.y);
    currentViewport = next;
    fitHitAreas();
    if (!app.ticker.started) app.render();
  };
  setViewport(viewport);

  return {
    draw(frame, now, frozen, nightShare = 0, effects: OfficeSceneEffects = { printer: null, merged: null }, asking = false, roomProps = null) {
      if (destroyed) return;
      const alive = new Set(frame.agents.map((agent) => agent.id));
      for (const [id, view] of characters) {
        if (!alive.has(id)) {
          view.root.destroy({ children: true });
          characters.delete(id);
          if (overAgent === id) overAgent = null;
        }
      }
      const stalledSpots = new Set<string>();
      for (const agent of frame.agents) {
        let view = characters.get(agent.id);
        if (!view) {
          view = createCharacter(agent, art, now, onCharacterTap, onAgentHover);
          characters.set(agent.id, view);
        }
        const failed = effects.printer?.kind === 'verify_failed'
          && effects.printer.beadId !== null
          && effects.printer.beadId === agent.beadId
          && now >= effects.printer.startedAt
          && now - effects.printer.startedAt < 3_000;
        const motion = effectLayer.motionFor(agent, now, frozen, options.reduced());
        updateCharacter(view, agent, art, now, options.reduced(), frozen, { ...motion, failed });
        if (agent.stalled) stalledSpots.add(agent.assignedSpotId);
      }
      app.canvas.dataset.officeCharacterArt = frame.agents.map((agent) => `${agent.id}=${characters.get(agent.id)!.key}:${art.fromAtlas(agent.charBase) ? 'atlas' : 'placeholder'}`).join(' ');
      for (const [spotId, displays] of bySpot) for (const display of displays) display.alpha = stalledSpots.has(spotId) ? 0.5 : 1;
      const seatedSpots = new Set(frame.agents.filter(isSeated).map((agent) => agent.assignedSpotId));
      for (const screen of deskScreens) screen.show(screen.states[seatedSpots.has(screen.spotId) ? 0 : 1]!);
      app.canvas.dataset.officeScreensOn = deskScreens.filter((screen) => seatedSpots.has(screen.spotId)).map((screen) => screen.spotId).join(' ');

      // While any session verifies, the QA wall screen loops its tests-running frames.
      const verifying = frame.props.verifying;
      if (!frozen) {
        // Leaving frozen frames: move the loop's start on by the frozen gap, so it resumes from the frame it held.
        if (screenFrozen && screenClock !== null && runningSince !== null) runningSince += now - screenClock;
        screenClock = now;
      }
      screenFrozen = frozen;
      const screenNow = frozen ? screenClock ?? now : now;
      if (!verifying) runningSince = null;
      else runningSince ??= screenNow;
      const screenState = qaScreenState(verifying, screenNow - (runningSince ?? screenNow), effects.printer, screenNow, options.reduced());
      const screenAsset = `furniture/wall-screen-${screenState}`;
      showQaScreen?.(screenAsset);
      app.canvas.dataset.officeQaScreen = screenState;
      const darkness = Math.max(0, Math.min(1, nightShare));
      night.alpha = darkness;
      app.canvas.dataset.officeNightShare = String(darkness);
      for (const overlay of overlaySprites) {
        overlay.sprite.alpha = overlay.state !== undefined && overlay.state !== screenAsset ? 0 : overlayAlpha(overlay.mode, overlay.spotIds, frame.agents, darkness);
      }
      const shown = overlaySprites.filter((overlay) => overlay.sprite.alpha > 0).map((overlay) => overlay.sprite);
      if (roomProps) propsAnimator.update(roomProps, now);
      // The count objects are furniture: depth-sorted with the characters and under the scene colour matrix. So are the
      // folders the reviewers read at the meeting table.
      const still = frozen || options.reduced();
      const reading = readingFolderItems(frame.agents, now, still, FOLDER_Z);
      app.canvas.dataset.officeReadingFolders = reading.map((entry) => ('reading' in entry.paint ? entry.paint.reading : '')).join(' ');
      const propItems = [...(roomProps ? propsAnimator.items(now, still) : []), ...reading];
      const propDisplays = propsView.displays(propItems);
      propTargets = propItems.flatMap((entry, index) => {
        const prop = propOfItem(entry.key);
        return prop ? [{ display: propDisplays[index]!, prop }] : [];
      });
      // Without objects, or without their taps, there is no object to be over.
      if (!roomProps || !options.onPropTap) overProp = null;
      updateHover();
      applyHover();
      fitHitAreas();
      if (roomProps && options.onPropTap) {
        // Before every other entity, so a character standing over an object is hit first.
        for (const { hit } of propHits) propDisplays.unshift(hit);
      }
      if (roomProps) {
        const columns = roomProps.columns;
        app.canvas.dataset.officeRoomProps = `questions=${roomProps.questions ?? '-'} review=${roomProps.reviewBatches?.length ?? '-'} board=${columns ? PROP_COLUMNS.map((key) => columns[key].length).join(',') : '-'}`;
      }
      const order = depthRuns([...sceneDisplays, ...propDisplays, ...[...characters.values()].map((view) => view.root)], shown);
      entities.removeChildren();
      let used = 0;
      for (const run of order) {
        if (run.lit) { entities.addChild(run.item); continue; }
        const container = runs[used] ??= new Container();
        container.removeChildren();
        if (used === 0) container.addChild(room, night, ...floorGrade.map((grade) => grade.graphic));
        if (run.items.length > 0) container.addChild(...run.items);
        // Any non-zero zIndex, which every overlay has, turns on Pixi's zIndex sort of `entities`: each run keys on its first
        // item, so the sort keeps the runs and overlays in this order. The first run, under the room, stays first.
        container.zIndex = used === 0 ? Number.MIN_SAFE_INTEGER : run.items[0]!.zIndex;
        entities.addChild(container);
        used++;
      }
      applySceneColorMatrix(runs.slice(0, used), colorFilter, darkness);
      updateFloorGrade(floorGrade, darkness);
      updateLights(lights, frame.agents, darkness, now, frozen || options.reduced());
      effectLayer.drawAgents(frame.agents, now, frozen, options.reduced(), asking, effects, (agent) => characters.get(agent.id)?.root.alpha ?? 0);
      effectLayer.drawMilestones(now, frozen, options.reduced(), effects);
      if (!app.ticker.started) app.render();
    },
    setLoop(step) {
      if (destroyed) return;
      if (loop) app.ticker.remove(loop);
      loop = null;
      if (!step) { app.ticker.stop(); return; }
      loop = () => step(performance.now());
      app.ticker.add(loop);
      app.ticker.start();
    },
    setViewport,
    setPanning(next) {
      if (destroyed || panning === next) return;
      panning = next;
      if (!next) refreshHover();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (loop) app.ticker.remove(loop);
      loop = null;
      app.ticker.stop();
      characters.clear();
      propsView.destroy();
      effectLayer.destroy();
      app.destroy(true, { children: true });
      art.destroy();
    },
  };
}
