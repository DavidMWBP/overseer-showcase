import type { Graphics } from 'pixi.js';
import { p } from './world';

/**
 * The room and the furniture are built as plain shape lists in world pixels, so their geometry, colours and depth keys are
 * testable without a renderer. The static room is painted onto a 2D canvas (it becomes the stage's background image);
 * furniture is painted into Pixi Graphics that join the depth-sorted entity layer.
 */
export type Point = [number, number];

export type Shape =
  | { kind: 'poly'; pts: Point[]; fill: string; alpha?: number; stroke?: string | null; width?: number; strokeAlpha?: number }
  | { kind: 'line'; pts: Point[]; stroke: string; width: number }
  | { kind: 'circle'; x: number; y: number; r: number; fill: string; stroke: string; width: number };

export const OUTLINE = '#1b1f27';

/** Darken a #rrggbb colour by `k`. */
export function shade(hex: string, k = 0.75): string {
  return '#' + [1, 3, 5].map((o) => Math.round(parseInt(hex.slice(o, o + 2), 16) * k).toString(16).padStart(2, '0')).join('');
}

export function poly(pts: Point[], fill: string, alpha = 1, stroke: string | null = OUTLINE, width = 2, strokeAlpha = 0.9): Shape {
  return { kind: 'poly', pts, fill, alpha, stroke, width, strokeAlpha };
}

/** An isometric box on the floor grid: its front-left, front-right and top faces, back to front. */
export function box(i: number, j: number, w: number, d: number, z0: number, h: number, [top, left, right]: readonly [string, string, string]): Shape[] {
  return [
    poly([p(i, j + d, z0), p(i + w, j + d, z0), p(i + w, j + d, z0 + h), p(i, j + d, z0 + h)], left),
    poly([p(i + w, j, z0), p(i + w, j + d, z0), p(i + w, j + d, z0 + h), p(i + w, j, z0 + h)], right),
    poly([p(i, j, z0 + h), p(i + w, j, z0 + h), p(i + w, j + d, z0 + h), p(i, j + d, z0 + h)], top),
  ];
}

/** A quad on the right (`r`, along i at j=0) or left (`l`, along j at i=0) back wall, from `a` to `b`, `z1` to `z2`. */
export function wallQuad(side: 'l' | 'r', a: number, b: number, z1: number, z2: number): Point[] {
  const q = side === 'r' ? (x: number, z: number) => p(x, 0, z) : (x: number, z: number) => p(0, x, z);
  return [q(a, z1), q(b, z1), q(b, z2), q(a, z2)];
}

export function paintCanvas(ctx: CanvasRenderingContext2D, shapes: readonly Shape[]): void {
  ctx.lineJoin = 'round';
  const path = (pts: Point[], close: boolean) => {
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
  };
  for (const shape of shapes) {
    if (shape.kind === 'poly') {
      path(shape.pts, true);
      ctx.globalAlpha = shape.alpha ?? 1;
      ctx.fillStyle = shape.fill;
      ctx.fill();
      if (shape.stroke) { ctx.globalAlpha = shape.strokeAlpha ?? 0.9; ctx.lineWidth = shape.width ?? 2; ctx.strokeStyle = shape.stroke; ctx.stroke(); }
    } else if (shape.kind === 'line') {
      path(shape.pts, false);
      ctx.globalAlpha = 1;
      ctx.lineWidth = shape.width;
      ctx.strokeStyle = shape.stroke;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = shape.fill;
      ctx.fill();
      ctx.lineWidth = shape.width;
      ctx.strokeStyle = shape.stroke;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

export function paintGraphics(g: Graphics, shapes: readonly Shape[]): Graphics {
  for (const shape of shapes) {
    if (shape.kind === 'poly') {
      g.poly(shape.pts.flat()).fill({ color: shape.fill, alpha: shape.alpha ?? 1 });
      if (shape.stroke) g.stroke({ width: shape.width ?? 2, color: shape.stroke, alpha: shape.strokeAlpha ?? 0.9 });
    } else if (shape.kind === 'line') {
      const [first, ...rest] = shape.pts;
      g.moveTo(...first!);
      for (const point of rest) g.lineTo(...point);
      g.stroke({ width: shape.width, color: shape.stroke });
    } else {
      g.circle(shape.x, shape.y, shape.r).fill(shape.fill).stroke({ width: shape.width, color: shape.stroke });
    }
  }
  return g;
}
