import { AnimatedSprite, Container, Graphics, Rectangle, type FederatedPointerEvent } from 'pixi.js';
import type { Agent } from '../types';
import { stalledAt } from '../config';
import { dirFromDelta, ENTRY, p, SPOTS, type Facing } from './world';
import type { CharAnim, CharView, OfficeArt } from './assets';
import { doorFadeAlpha, fadeInAlpha } from './effects';
import { fitInside, nearestTarget, type Box, type TouchTarget } from '../touchTarget';

/**
 * One Pixi character per agent: a shadow and an animated sprite in a container that joins the depth-sorted entity
 * layer by its feet. `characterPose` is the pure part: which animation and view it shows, whether it is flipped, where
 * it stands and how transparent it is. Frames face left, so a right-facing character is drawn with `scale.x = -1`.
 */

/** The click target around the feet, in world pixels. */
export const HIT_AREA = { x: -26, y: -90, width: 52, height: 96 } as const;
/** The centre of `HIT_AREA`, in world pixels from the feet. */
const HIT_CENTRE = { x: HIT_AREA.x + HIT_AREA.width / 2, y: HIT_AREA.y + HIT_AREA.height / 2 } as const;
export type HitBox = { x: number; y: number; width: number; height: number };

/**
 * The tap target around the feet in world pixels: `HIT_AREA`, grown about its centre until each side is at least
 * `minCss` CSS px at `scale` CSS px per world px. A fine pointer passes 0 and keeps `HIT_AREA`; a coarse one passes 44.
 */
export function characterHitArea(scale: number, minCss = 0): HitBox {
  const min = scale > 0 ? minCss / scale : 0;
  const width = Math.max(HIT_AREA.width, min);
  const height = Math.max(HIT_AREA.height, min);
  return { x: HIT_CENTRE.x - width / 2, y: HIT_CENTRE.y - height / 2, width, height };
}

/**
 * A character's tap target in world pixels, from its feet: `characterHitArea`, and on a coarse pointer (`minCss` > 0)
 * cut to the stage's `visible` world box and grown back inward to `minCss`, so a character at the stage's edge keeps a
 * whole target the stage does not clip. Its centre stays the centre of the unfitted area.
 */
export function characterTarget(character: { id: string; x: number; y: number }, scale: number, minCss = 0, visible?: Box): TouchTarget {
  const area = characterHitArea(scale, minCss);
  const rect = { left: character.x + area.x, top: character.y + area.y, width: area.width, height: area.height };
  const fitted = minCss > 0 && scale > 0 ? fitInside(rect, visible, minCss / scale) : rect;
  return { id: character.id, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, ...fitted };
}

/**
 * Of the characters (feet in world pixels) whose target holds `point`, the one whose target centre is nearest the
 * point, or null when the point is in none of them: a tap on empty floor opens nothing.
 */
export function nearestCharacter(point: { x: number; y: number }, characters: readonly { id: string; x: number; y: number }[], scale: number, minCss = 0, visible?: Box): string | null {
  return nearestTarget(characters.map((character) => characterTarget(character, scale, minCss, visible)), point.x, point.y)?.id ?? null;
}
/** Animation speed in frames per 60fps tick, as the prototype's `animationSpeed`. */
export const ANIMATION_SPEED: Record<CharAnim, number> = { walk: 0.16, type: 0.1, idle: 0 };
export interface CharacterPose {
  x: number;
  y: number;
  zIndex: number;
  anim: CharAnim;
  view: CharView;
  flip: boolean;
  alpha: number;
  walking: boolean;
}

/** Visual-only choreography supplied by the Office effect layer. */
export interface CharacterMotion {
  hopOffset?: number;
  facing?: Facing;
  failed?: boolean;
}

/**
 * A seated typist leans in along the direction its seat faces, `TYPING_LEAN` steps of `LEAN_STEP` (2 x 1 px on screen)
 * by seat, and the typing frames' forearms reach the rest of the way, so the hands rest on the keyboard. Three steps is
 * the most the body takes before it leaves the chair; the QA desk's keyboard sits nearer its seat. The seat, its depth
 * key and the chair stay where they are; the meeting table has no keyboard, so its seats do not lean.
 */
const LEAN_STEP: Record<Facing, { x: number; y: number }> = {
  'front-left': { x: -2, y: 1 }, 'front-right': { x: 2, y: 1 }, 'rear-left': { x: -2, y: -1 }, 'rear-right': { x: 2, y: -1 },
};
/** Steps by seat: 3 at a pod desk and the orchestrator desk, 1 at a QA desk. */
export const TYPING_LEAN: Readonly<Record<string, number>> = Object.fromEntries(SPOTS.filter((spot) => spot.desk).map((spot) => [
  spot.id, spot.zone === 'lab' ? 1 : 3,
]));
/** The typing frames are seated, so only a character at a desk or a meeting seat types; one at a standing spot stands. */
const SEATS = new Set(SPOTS.filter((spot) => spot.atDesk).map((spot) => spot.id));

export function isMoving(agent: Agent): boolean {
  return agent.pathQueue.length > 0 || Math.hypot(agent.position.x - agent.targetPosition.x, agent.position.y - agent.targetPosition.y) > 0.01;
}

/**
 * The pose for this frame. `walkFacing` is the direction of the last step (the caller tracks it from the position
 * delta); a character that is not moving faces its spot. A character seated at a desk or meeting seat types while its
 * session is working or verifying and not stalled, and stands idle otherwise, as does one at a standing spot. Reduced
 * motion drops the fades.
 */
export function characterPose(agent: Agent, walkFacing: Facing, age: number, reduced: boolean, facingOverride?: Facing): CharacterPose {
  const walking = isMoving(agent);
  const seated = !walking && agent.pose !== 'leaving';
  const busy = agent.state === 'working' || agent.state === 'verifying';
  const anim: CharAnim = walking ? 'walk' : seated && busy && !agent.stalled && SEATS.has(agent.assignedSpotId) ? 'type' : 'idle';
  const facing = facingOverride ?? (walking ? walkFacing : agent.spriteFacing);
  const [px, py] = p(agent.position.x, agent.position.y);
  // The lean follows the seat, not a milestone's facing override.
  const steps = anim === 'type' ? TYPING_LEAN[agent.assignedSpotId] ?? 0 : 0;
  const [x, y] = [px + steps * LEAN_STEP[agent.spriteFacing].x, py + steps * LEAN_STEP[agent.spriteFacing].y];
  const fadeIn = fadeInAlpha(age, reduced);
  const nearDoor = agent.pose === 'leaving'
    ? doorFadeAlpha(Math.hypot(agent.position.x - ENTRY.x, agent.position.y - ENTRY.y), reduced)
    : 1;
  return {
    x,
    y,
    zIndex: Math.round((agent.position.x + agent.position.y) * 100),
    anim,
    view: facing.startsWith('front') ? 'front' : 'rear',
    flip: facing.endsWith('right'),
    alpha: (agent.stalled ? 0.5 : 1) * fadeIn * nearDoor,
    walking,
  };
}

/** The frame index at `now` for an animation of `count` frames, or 0 when the scene is frozen. */
export function frameIndex(anim: CharAnim, count: number, now: number, frozen: boolean): number {
  if (frozen || count <= 1) return 0;
  return Math.floor((now / (1000 / 60)) * ANIMATION_SPEED[anim]) % count;
}

/** True when a click on this character does something: a task pane for a bead, the Chat for the orchestrator. */
export function isClickable(agent: Agent): boolean {
  return agent.beadId !== null || agent.role === 'orchestrator';
}

/**
 * The phone name, whose badges show no text: harness, model (the label's rule), task and repository, each named even
 * when the session has none, and the role for anyone but a worker.
 */
function phoneLabel(agent: Agent): string {
  const model = agent.resolvedModel ?? agent.model;
  return [agent.harness, ...(model ? [model] : []), `task ${agent.beadId ?? 'none'}`, `repository ${agent.repoId ?? 'none'}`,
    ...(agent.role === 'worker' ? [] : [agent.role])].join(' · ');
}

/** The character button's accessible name: the label (the phone one on a phone), the stall time, and where a click goes. */
export function characterName(agent: Agent, opens?: string, phone = false): string {
  const label = phone ? phoneLabel(agent) : agent.labelText;
  const described = agent.stalled && agent.stalledSince ? `${label} — stalled since ${stalledAt(agent.stalledSince)}` : label;
  return opens ? `${described} (${opens})` : described;
}

export interface CharacterView {
  root: Container;
  sprite: AnimatedSprite;
  key: string;
  facing: Facing;
  last: { x: number; y: number };
  /** Where the feet are drawn, in world pixels: the origin of the hit area. */
  at: { x: number; y: number };
  born: number;
}

export function createCharacter(
  agent: Agent, art: OfficeArt, now: number, onTap: (id: string, event?: FederatedPointerEvent) => void,
  onHover?: (id: string, over: boolean, event?: FederatedPointerEvent) => void,
): CharacterView {
  const root = new Container();
  const shadow = new Graphics().ellipse(0, 0, 22, 8).fill({ color: '#000000', alpha: 0.35 });
  const sprite = new AnimatedSprite({ textures: art.frames(agent.charBase, 'idle', 'front'), autoUpdate: false });
  sprite.anchor.set(0.5, 1);
  sprite.y = 4;
  root.addChild(shadow, sprite);
  root.label = agent.id;
  if (isClickable(agent)) {
    root.eventMode = 'static';
    root.cursor = 'pointer';
    root.hitArea = new Rectangle(HIT_AREA.x, HIT_AREA.y, HIT_AREA.width, HIT_AREA.height);
    root.on('pointertap', (event?: FederatedPointerEvent) => onTap(agent.id, event));
    root.on('pointerover', (event?: FederatedPointerEvent) => onHover?.(agent.id, true, event));
    root.on('pointerout', (event?: FederatedPointerEvent) => onHover?.(agent.id, false, event));
  }
  return { root, sprite, key: '', facing: agent.spriteFacing, last: { ...agent.position }, at: { x: 0, y: 0 }, born: now };
}

export function updateCharacter(view: CharacterView, agent: Agent, art: OfficeArt, now: number, reduced: boolean, frozen: boolean, motion: CharacterMotion = {}): void {
  const dx = agent.position.x - view.last.x;
  const dy = agent.position.y - view.last.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.001) view.facing = dirFromDelta(dx, dy, view.facing);
  view.last = { ...agent.position };
  const pose = characterPose(agent, view.facing, now - view.born, reduced, motion.facing);
  view.root.position.set(pose.x, pose.y);
  view.at = { x: pose.x, y: pose.y };
  view.root.zIndex = pose.zIndex;
  view.root.alpha = pose.alpha;
  const key = `${agent.charBase}/${pose.anim}/${pose.view}`;
  if (view.key !== key) {
    view.sprite.textures = art.frames(agent.charBase, pose.anim, pose.view);
    view.key = key;
  }
  view.sprite.gotoAndStop(frameIndex(pose.anim, view.sprite.totalFrames, now, frozen || reduced));
  view.sprite.scale.x = pose.flip ? -1 : 1;
  view.sprite.tint = motion.failed ? 0x9a9a9a : 0xffffff;
  view.sprite.rotation = motion.failed ? -0.12 : 0;
  view.sprite.y = 4 - (reduced || frozen ? 0 : motion.hopOffset ?? 0);
}
