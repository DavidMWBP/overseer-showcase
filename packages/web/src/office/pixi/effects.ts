import { Container, Graphics, Sprite } from 'pixi.js';
import type { WsMessage } from '@overseer/shared';
import type { Agent } from '../types';
import { GLYPH_RASTER_SCALE, type OfficeArt } from './assets';
import { BOARD_SPOT, p, pathBetween, dirFromDelta, WORLD_HEIGHT, WORLD_WIDTH, type Facing } from './world';
import type { CharacterMotion } from './characters';

export type OfficeMilestoneKind = Extract<WsMessage, { type: 'office_milestone' }>['kind'];

/** A milestone is stamped with the local animation clock when its one-shot event arrives. */
export interface TimedOfficeEffect {
  id: number;
  kind: OfficeMilestoneKind;
  startedAt: number;
  beadId: string | null;
  reduced: boolean;
}

export interface OfficeSceneEffects {
  printer: TimedOfficeEffect | null;
  merged: TimedOfficeEffect | null;
}

export interface BubbleVisual {
  text: string;
  fill: string;
  textColor: string;
  badge: boolean;
}

export interface BubbleSignals {
  asking?: boolean;
  failed?: boolean;
  passed?: boolean;
  frozen?: boolean;
}

/** A passed bead walks to the board before its hop; the next feed event can still send it out normally. */
export function routePassedAgentToBoard(agent: Agent): Agent {
  const board = { x: BOARD_SPOT.x, y: BOARD_SPOT.y };
  return {
    ...agent,
    pose: 'walking',
    targetPosition: board,
    pathQueue: pathBetween(agent.position, board),
    spriteFacing: BOARD_SPOT.f,
  };
}

const INK = '#1b1f27';
const PAPER = '#fbf7ee';
const FADE_IN_MS = 400;
const DOOR_FADE_TILES = 1.2;
export const HOP_MS = 600;
export const HOP_HEIGHT = 18;
export const MERGE_FACE_MS = 2_400;
export const MERGE_HOP_STAGGER_MS = 140;
export const CONFETTI_COUNT = 90;

/** Fade an arrival in over the handoff's 400 ms interval. */
export function fadeInAlpha(ageMs: number, reduced = false): number {
  return reduced ? 1 : Math.max(0, Math.min(1, ageMs / FADE_IN_MS));
}

/** Fade a leaving character across the final 1.2 tiles before the door. */
export function doorFadeAlpha(distanceToDoor: number, reduced = false): number {
  return reduced ? 1 : Math.max(0, Math.min(1, distanceToDoor / DOOR_FADE_TILES));
}

/** Eighteen pixel sine hop over 600 ms; zero outside the hop or under reduced motion. */
export function hopOffset(ageMs: number, reduced = false): number {
  if (reduced || ageMs < 0 || ageMs >= HOP_MS) return 0;
  return Math.sin((ageMs / HOP_MS) * Math.PI) * HOP_HEIGHT;
}

/** Choose a single bubble or badge, with asking before failed before passed. */
export function bubbleFor(agent: Pick<Agent, 'role' | 'state' | 'pose' | 'stalled'>, now: number, signals: BubbleSignals = {}): BubbleVisual | null {
  if (agent.role === 'orchestrator' && signals.asking) return { text: '?', fill: '#ffd166', textColor: INK, badge: true };
  if (signals.failed) return { text: '!', fill: '#e04848', textColor: '#ffffff', badge: true };
  if (signals.passed) return { text: '✓', fill: '#5ee07a', textColor: '#ffffff', badge: true };

  if (agent.pose === 'leaving') return null;
  const walking = agent.pose === 'walking';
  if (agent.stalled && !walking) return { text: 'z z', fill: PAPER, textColor: INK, badge: false };
  if (agent.state === 'walking_in' && walking) return { text: '★', fill: PAPER, textColor: INK, badge: false };
  if (agent.state === 'working') return null;
  if (agent.state === 'verifying') return { text: 'test', fill: PAPER, textColor: INK, badge: false };
  if (agent.state === 'reviewing') return { text: '✎', fill: PAPER, textColor: INK, badge: false };
  return null;
}

/** How long a verification pass or failure holds the QA wall screen, as the printer mark did. */
export const VERIFY_MARK_MS = 3_000;
/** Each `running-N` frame of the QA wall screen shows for 250 ms, so the four-frame loop takes a second. */
export const QA_SCREEN_FRAME_MS = 250;
export type QaScreenState = 'on' | 'running-0' | 'running-1' | 'running-2' | 'running-3' | 'pass' | 'fail';

/**
 * The QA wall screen: a pass or fail mark younger than 3 s wins, then the running loop while a session verifies
 * (`runningFor` ms since it started; frame 0 under reduced motion), otherwise the idle chart.
 */
export function qaScreenState(verifying: boolean, runningFor: number, mark: TimedOfficeEffect | null, now: number, reduced: boolean): QaScreenState {
  const age = mark ? now - mark.startedAt : -1;
  if (mark && age >= 0 && age < VERIFY_MARK_MS) return mark.kind === 'verify_passed' ? 'pass' : 'fail';
  if (!verifying) return 'on';
  const frame = reduced ? 0 : Math.floor(Math.max(0, runningFor) / QA_SCREEN_FRAME_MS) % 4;
  return `running-${frame}` as QaScreenState;
}

export interface ConfettiPiece {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string;
}

/** Deterministic 90-piece version of the prototype confetti, positioned by elapsed animation time. */
export function confettiAt(now: number, startedAt: number, reduced = false): ConfettiPiece[] {
  if (reduced) return [];
  const frames = Math.max(0, (now - startedAt) / (1000 / 60));
  const pieces: ConfettiPiece[] = [];
  for (let index = 0; index < CONFETTI_COUNT; index++) {
    const speedY = 3 + ((index * 17) % 4);
    const y = -20 - ((index * 53) % 200) + frames * speedY;
    if (y >= WORLD_HEIGHT + 20) continue;
    const rotation = ((index * 71) % 628) / 100 + frames * (((index % 7) - 3) * 0.025);
    pieces.push({
      x: ((index * 197 + 23) % WORLD_WIDTH) + frames * (((index % 5) - 2) * 0.35),
      y,
      width: Math.max(2, 12 * Math.abs(Math.cos(rotation))),
      height: 18,
      rotation,
      color: `hsl(${(index * 47) % 360},88%,58%)`,
    });
  }
  return pieces;
}

interface BubbleView {
  root: Container;
  background: Graphics;
  glyph: Sprite;
  key: string;
}

interface HopTrigger {
  sourceId: number;
  startedAt: number;
  facing: Facing;
  faceUntil: number;
}

export interface OfficeEffectLayer {
  root: Container;
  drawAgents(agents: readonly Agent[], now: number, frozen: boolean, reduced: boolean, asking: boolean, effects: OfficeSceneEffects, alphaFor: (agent: Agent) => number): void;
  drawMilestones(now: number, frozen: boolean, reduced: boolean, effects: OfficeSceneEffects): void;
  motionFor(agent: Agent, now: number, frozen: boolean, reduced: boolean): CharacterMotion;
  destroy(): void;
}

function colorNumber(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

function drawBubble(view: BubbleView, visual: BubbleVisual, art: OfficeArt): void {
  const key = `${visual.text}|${visual.fill}|${visual.textColor}`;
  if (view.key === key) return;
  const glyph = art.glyph(visual.text, visual.textColor, 17);
  if (!glyph) { view.root.visible = false; return; }
  const width = Math.max(30, glyph.width + 14);
  view.background.clear()
    .roundRect(-width / 2, -14, width, 28, 6)
    .fill(colorNumber(visual.fill))
    .stroke({ width: 2, color: colorNumber(INK) });
  view.background.poly([-5, 13, 5, 13, 0, 20]).fill(colorNumber(visual.fill)).stroke({ width: 2, color: colorNumber(INK) });
  view.glyph.texture = glyph.texture;
  view.glyph.scale.set(1 / GLYPH_RASTER_SCALE);
  view.key = key;
}

/** Create the Pixi-only bubbles, confetti and character hop choreography; the QA wall screen carries the verification mark. */
export function createEffectLayer(art: OfficeArt, canvas: HTMLCanvasElement): OfficeEffectLayer {
  const root = new Container();
  const confettiGraphic = new Graphics();
  const bubbles = new Container();
  root.addChild(confettiGraphic, bubbles);

  const bubbleViews = new Map<string, BubbleView>();
  const hops = new Map<string, HopTrigger>();
  let previousMergeId: number | null = null;
  let previousPrinterId: number | null = null;
  let pendingPass: { id: number; beadId: string } | null = null;
  let frozenAt: number | null = null;
  let lastConfetti: ConfettiPiece[] = [];
  let lastConfettiId: number | null = null;

  const addHop = (agent: Agent, sourceId: number, startedAt: number, faceUntil: number, facing = dirFromDelta(BOARD_SPOT.x - agent.position.x, BOARD_SPOT.y - agent.position.y, agent.spriteFacing)) => {
    hops.set(agent.id, {
      sourceId,
      startedAt,
      faceUntil,
      facing,
    });
  };

  const syncHops = (agents: readonly Agent[], effects: OfficeSceneEffects, now: number) => {
    const mergeId = effects.merged?.id ?? null;
    if (mergeId !== previousMergeId) {
      previousMergeId = mergeId;
      if (effects.merged) agents.forEach((agent, index) => addHop(agent, effects.merged!.id, effects.merged!.startedAt + index * MERGE_HOP_STAGGER_MS, effects.merged!.startedAt + MERGE_FACE_MS));
    }
    const printerId = effects.printer?.id ?? null;
    if (printerId !== previousPrinterId) {
      previousPrinterId = printerId;
      const pass = effects.printer?.kind === 'verify_passed' ? effects.printer : null;
      if (pass) pendingPass = !pass.reduced && pass.beadId ? { id: pass.id, beadId: pass.beadId } : null;
      else if (effects.printer) pendingPass = null;
    }
    if (pendingPass) {
      const agent = agents.find((candidate) => candidate.beadId === pendingPass!.beadId);
      if (!agent || agent.pose === 'leaving') pendingPass = null;
      else if (agent.pose === 'arrived' && Math.hypot(agent.position.x - BOARD_SPOT.x, agent.position.y - BOARD_SPOT.y) < 0.01) {
        if (hops.get(agent.id)?.sourceId !== pendingPass.id) addHop(agent, pendingPass.id, now, now + MERGE_FACE_MS, BOARD_SPOT.f);
        pendingPass = null;
      }
    }
  };

  return {
    root,
    drawAgents(agents, now, frozen, reduced, asking, effects, alphaFor) {
      syncHops(agents, effects, now);
      const alive = new Set(agents.map((agent) => agent.id));
      for (const [id, view] of bubbleViews) if (!alive.has(id)) { view.root.destroy({ children: true }); bubbleViews.delete(id); }
      for (const agent of agents) {
        let view = bubbleViews.get(agent.id);
        if (!view) {
          const bubbleRoot = new Container();
          const background = new Graphics();
          const glyph = new Sprite();
          glyph.anchor.set(0.5);
          bubbleRoot.addChild(background, glyph);
          bubbles.addChild(bubbleRoot);
          view = { root: bubbleRoot, background, glyph, key: '' };
          bubbleViews.set(agent.id, view);
        }
        const verification = effects.printer?.beadId !== null
          && effects.printer?.beadId !== undefined
          && effects.printer.beadId === agent.beadId;
        const visual = bubbleFor(agent, frozen ? frozenAt ?? now : now, {
          asking: asking && agent.role === 'orchestrator',
          failed: verification && effects.printer?.kind === 'verify_failed',
          passed: verification && effects.printer?.kind === 'verify_passed',
          frozen: frozen || reduced,
        });
        view.root.visible = visual !== null;
        if (!visual) continue;
        drawBubble(view, visual, art);
        const [x, y] = p(agent.position.x, agent.position.y);
        const bob = frozen || reduced ? 0 : Math.sin(now / 450) * 2;
        view.root.position.set(x, y - 112 + bob);
        view.root.alpha = alphaFor(agent);
      }
      if (!frozen) frozenAt = now;
    },
    drawMilestones(now, frozen, reduced, effects) {
      const visualNow = frozen ? frozenAt ?? now : now;
      const printer = effects.printer;
      const merged = effects.merged;
      if (merged && lastConfettiId !== merged.id) { lastConfettiId = merged.id; lastConfetti = []; }
      if (!merged) { lastConfettiId = null; lastConfetti = []; }
      if (merged && !reduced && !merged.reduced) {
        if (!frozen) lastConfetti = confettiAt(visualNow, merged.startedAt);
        confettiGraphic.clear();
        for (const piece of lastConfetti) {
          confettiGraphic.rect(piece.x - piece.width / 2, piece.y, piece.width, piece.height).fill(piece.color);
        }
      } else {
        lastConfetti = [];
        confettiGraphic.clear();
      }

      canvas.dataset.officeConfettiPieces = String(lastConfetti.length);
      canvas.dataset.officeReduced = String(reduced || printer?.reduced === true || merged?.reduced === true);
      if (!frozen) frozenAt = now;
    },
    motionFor(agent, now, frozen, reduced) {
      const trigger = hops.get(agent.id);
      if (!trigger || frozen || reduced) return { hopOffset: 0 };
      if (now >= trigger.faceUntil && now >= trigger.startedAt + HOP_MS) { hops.delete(agent.id); return { hopOffset: 0 }; }
      return {
        hopOffset: hopOffset(now - trigger.startedAt, false),
        ...(now < trigger.faceUntil ? { facing: trigger.facing } : {}),
      };
    },
    destroy() {
      for (const view of bubbleViews.values()) view.root.destroy({ children: true });
      bubbleViews.clear();
      hops.clear();
      root.destroy({ children: true });
    },
  };
}
