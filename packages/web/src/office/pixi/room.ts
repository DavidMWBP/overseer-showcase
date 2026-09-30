import { H, p, W, WORLD_HEIGHT, WORLD_WIDTH } from './world';
import { paintCanvas, poly, wallQuad, type Point, type Shape } from './draw';

/**
 * Graphics fallback for the static layout 2 room when its PixelLab background textures cannot load. The night fallback
 * holds only the window panes; both generated images are loaded as Pixi textures and use nearest-neighbour sampling.
 */

/** `lab` is the QA corner's floor and `review` the meeting room's. */
export type OfficeFloorRegion = 'main' | 'lab' | 'review';

/** Room for the floor tile whose centre is at (ci, cj); the kitchen and lounge remain part of main. */
export function floorRegion(ci: number, cj: number): OfficeFloorRegion {
  if (ci > 12 && cj < 7) return 'lab';
  if (ci > 12) return 'review';
  return 'main';
}

/** Floor colour pair (even, odd tile) for the tile whose centre is at (ci, cj). */
export function floorColors(ci: number, cj: number): readonly [string, string] {
  const region = floorRegion(ci, cj);
  if (region === 'lab') return ['#c7ced6', '#bcc4cd'];
  if (region === 'review') return ['#857696', '#7d6f8f'];
  if (ci < 5.5 && cj > 9) return ['#a67c52', '#9b724a']; // kitchen and lounge wood
  return ['#646d80', '#5f687b']; // main carpet
}

export const WINDOWS: readonly Point[][] = [wallQuad('l', 3, 5.8, 1.3, 3.3), wallQuad('l', 6.2, 9, 1.3, 3.3), wallQuad('r', 2, 6, 1.3, 3.3)];
export const SCONCES: readonly (readonly ['l' | 'r', number])[] = [['l', 1.8], ['l', 11], ['r', 7.5], ['r', 14.5]];
export const DAY_SKY = '#a9d4ef';
export const NIGHT_SKY = '#1c2745';
const FRAME = '#5b4a39';

export function roomShapes(): Shape[] {
  const shapes: Shape[] = [];
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; j++) {
      shapes.push(poly([p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)], floorColors(i + 0.5, j + 0.5)[(i + j) % 2]!, 1, '#000000', 1, 0.12));
    }
  }
  shapes.push(poly([p(0, 0), p(0, H), p(0, H, 4), p(0, 0, 4)], '#cdbb9c', 1, '#1b1f27', 3));
  shapes.push(poly([p(0, 0), p(W, 0), p(W, 0, 4), p(0, 0, 4)], '#dccba9', 1, '#1b1f27', 3));
  shapes.push(poly([p(12, 0), p(W, 0), p(W, 0, 4), p(12, 0, 4)], '#d3d8dc', 1, '#1b1f27', 3));
  shapes.push(poly([p(0, 0), p(0, H), p(0, H, 0.22), p(0, 0, 0.22)], '#8e7a60', 1, null));
  shapes.push(poly([p(0, 0), p(W, 0), p(W, 0, 0.22), p(0, 0, 0.22)], '#8e7a60', 1, null));
  shapes.push({ kind: 'line', pts: [p(0, H, 4), p(0, 0, 4), p(W, 0, 4)], stroke: FRAME, width: 8 });
  // The door at i 9.92..11.92, as in the layout 2 room art (compose-office-room.mjs), clear of the whiteboard to its left.
  const door = 9 + 44 / 48;
  shapes.push(poly(wallQuad('r', door, door + 2, 0, 3), '#2e251d', 1, FRAME, 6));
  shapes.push(poly(wallQuad('r', door + 0.15, door + 1.85, 0, 2.85), '#3c3026', 1, null));
  for (const [side, at] of SCONCES) shapes.push(poly(wallQuad(side, at - 0.2, at + 0.2, 2.8, 3.2), '#e9d9a8', 1, FRAME, 3));
  for (const pane of WINDOWS) shapes.push(poly(pane, DAY_SKY, 1, FRAME, 6));
  return shapes;
}

export function nightSkyShapes(): Shape[] {
  return WINDOWS.map((pane) => poly(pane, NIGHT_SKY, 1, FRAME, 6));
}

/** Paint shapes onto a world-sized canvas at twice the world resolution and return it as a PNG data URL. */
export function shapesDataUrl(shapes: readonly Shape[], scale = 2): string {
  const canvas = document.createElement('canvas');
  canvas.width = WORLD_WIDTH * scale;
  canvas.height = WORLD_HEIGHT * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(scale, scale);
  paintCanvas(ctx, shapes);
  return canvas.toDataURL();
}
