import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { OfficeSceneEffects } from '../office/pixi/effects';
import type { SceneFrame } from '../office/officeModel';
import type { RoomPropsInput } from '../office/pixi/roomProps';

/**
 * Pixi does not run under jsdom (its canvas has no 2D context), so a test that shows the Office replaces the scene with
 * this fake: `vi.mock('./office/pixi/scene', () => import('./test/fakeOfficeScene'))`. It records each draw and the
 * frame loop the stage hands it; the last draw is what the room shows.
 */
export interface FakeOfficeScene {
  draw: ReturnType<typeof vi.fn>;
  setLoop: ReturnType<typeof vi.fn>;
  setViewport: ReturnType<typeof vi.fn>;
  setPanning: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

export const fakeScenes: FakeOfficeScene[] = [];

export const createScene = vi.fn(async () => {
  const scene: FakeOfficeScene = { draw: vi.fn(), setLoop: vi.fn(), setViewport: vi.fn(), setPanning: vi.fn(), destroy: vi.fn() };
  fakeScenes.push(scene);
  return scene;
});

type DrawCall = [SceneFrame, number, boolean, number, OfficeSceneEffects, boolean, RoomPropsInput | null];
const lastDraw = () => fakeScenes.at(-1)?.draw.mock.calls.at(-1) as DrawCall | undefined;

/** The counts the room's objects were last drawn with. */
export const drawnRoomProps = () => lastDraw()?.[6];

/** The effects the room was last drawn with. */
export const drawnOfficeEffects = () => lastDraw()?.[4];

/** One character as the room last drew it. */
export const drawnOfficeAgent = (id: string) => lastDraw()?.[0].agents.find((agent) => agent.id === id);

/** True when the room last drew the character standing on its own desk. */
export const drawnOfficeAtDesk = (id: string) => {
  const agent = drawnOfficeAgent(id);
  return !!agent && agent.position.x === agent.deskPosition.x && agent.position.y === agent.deskPosition.y;
};

/** The frame loop the stage is running, or null when it has not started one (or has stopped it). */
export const officeLoop = () => (fakeScenes.at(-1)?.setLoop.mock.calls.at(-1)?.[0] ?? null) as ((now: number) => void) | null;

/**
 * A driver that runs the stage's current frame loop once per call, 50 ms after the previous call. Each call is one
 * `act`, even while no loop runs, so a pending update (a snapshot that restarts the loop) lands before the next call.
 */
export function officeFrames(): () => void {
  let now = performance.now();
  return () => { now += 50; act(() => { officeLoop()?.(now); }); };
}
