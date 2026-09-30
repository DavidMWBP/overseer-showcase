import { describe, expect, it } from 'vitest';
import { FURN, H, W, WORLD_HEIGHT, WORLD_WIDTH, p } from './world';
import { initialOfficeViewport, officePixelScale, panOfficeViewport, resizeOfficeViewport, type OfficeViewport } from './viewport';
import { ROOM_PROP_BOXES } from './roomProps';

describe('Pixi device-pixel viewport', () => {
  // Screen box of a world box, and whether it sits inside the stage with the 8 px margin.
  const shown = (viewport: OfficeViewport, [x, y, w, h]: readonly number[]) => {
    const left = viewport.originX + viewport.x + x! * viewport.scale;
    const top = viewport.originY + viewport.y + y! * viewport.scale;
    return left >= 8 - 0.5 && top >= 8 - 0.5 && left + w! * viewport.scale <= viewport.stageWidth - 8 + 0.5 && top + h! * viewport.scale <= viewport.stageHeight - 8 + 0.5;
  };
  const inView = (viewport: OfficeViewport) => (['questions', 'review', 'board'] as const).map((key) => shown(viewport, ROOM_PROP_BOXES[key]));

  // The meeting table's world box: its footprint from the floor to its top (z 0.792).
  const table = (() => {
    const { i, j, w, d } = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
    const [left] = p(i, j + d);
    const [right] = p(i + w, j);
    const [, top] = p(i, j, 0.792);
    const [, bottom] = p(i + w, j + d);
    return [left, top, right - left, bottom - top];
  })();

  it.each([
    { width: 1280, dpr: 1, k: 1 },
    { width: 1440, dpr: 2, k: 2 },
    { width: 390, dpr: 3, k: 1 },
    { width: 2172, dpr: 1, k: 1 },
    { width: 2560, dpr: 1, k: 2 },
    { width: 1280, dpr: 1.25, k: 1 },
    { width: 1920, dpr: 1.5, k: 2 },
    { width: 100, dpr: 1, k: 1 },
  ])('uses $k device pixels per art pixel at $width CSS px and dpr $dpr', ({ width, dpr, k }) => {
    const pixelScale = officePixelScale(width, dpr);
    expect({ pixelScale, cssScale: pixelScale / dpr }).toEqual({ pixelScale: k, cssScale: k / dpr });
  });

  // The room's silhouette (floor and both 4-unit back walls) and the QA corner (floor i 12..20, j 0..7, and its wall).
  const room = [p(0, H), p(0, H, 4), p(0, 0, 4), p(W, 0, 4), p(W, 0), p(W, H)];
  const qaCorner = [p(12, 7), p(12, 0, 4), p(20, 0, 4), p(20, 0), p(20, 7)];
  const shoelace = (points: number[][]) => Math.abs(points.reduce((sum, [a, b], index) => sum + a! * points[(index + 1) % points.length]![1]! - points[(index + 1) % points.length]![0]! * b!, 0)) / 2;
  // Area of a convex world polygon on screen inside the stage: each vertex mapped, clipped to the box, then the shoelace formula.
  const onStage = (viewport: OfficeViewport, polygon: [number, number][], x = viewport.x, y = viewport.y) => {
    let points = polygon.map(([wx, wy]) => [viewport.originX + x + wx * viewport.scale, viewport.originY + y + wy * viewport.scale]);
    const cut = (axis: 0 | 1, limit: number, keepAbove: boolean) => {
      const inside = (q: number[]) => (keepAbove ? q[axis]! >= limit : q[axis]! <= limit);
      points = points.flatMap((current, index) => {
        const previous = points[(index + points.length - 1) % points.length]!;
        const crossing = inside(current) !== inside(previous)
          ? [previous.map((value, i) => value + ((limit - previous[axis]!) / (current[axis]! - previous[axis]!)) * (current[i]! - value))]
          : [];
        return inside(current) ? [...crossing, current] : crossing;
      });
    };
    cut(0, 0, true); cut(0, viewport.stageWidth, false); cut(1, 0, true); cut(1, viewport.stageHeight, false);
    return shoelace(points);
  };
  const blackShare = (viewport: OfficeViewport) => 1 - onStage(viewport, room) / (viewport.stageWidth * viewport.stageHeight);
  const qaShown = (viewport: OfficeViewport) => onStage(viewport, qaCorner) / (shoelace(qaCorner) * viewport.scale ** 2);
  const objectShare = (viewport: OfficeViewport, [x, y, w, h]: readonly number[]) => {
    const left = viewport.originX + viewport.x + x! * viewport.scale;
    const top = viewport.originY + viewport.y + y! * viewport.scale;
    const right = left + w! * viewport.scale;
    const bottom = top + h! * viewport.scale;
    const width = Math.max(0, Math.min(right, viewport.stageWidth - 8) - Math.max(left, 8));
    const height = Math.max(0, Math.min(bottom, viewport.stageHeight - 8) - Math.max(top, 8));
    return (width * height) / (w! * h! * viewport.scale ** 2);
  };

  it.each([
    { width: 1250, dpr: 1 },
    { width: 1250, dpr: 2 },
    { width: 805, dpr: 1.5 },
  ])('starts a desktop $width CSS px stage at dpr $dpr on the objects-in-view offset that shows the most room', ({ width, dpr }) => {
    const height = width * WORLD_HEIGHT / WORLD_WIDTH;
    const start = initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, false);
    // Brute force: every offset 2 CSS px apart at which the world covers the stage and the objects and the table are in view.
    const offsets = (stageSize: number, worldSize: number) => worldSize <= stageSize
      ? [null]
      : Array.from({ length: Math.floor((worldSize - stageSize) / 2) + 1 }, (_, i) => -i * 2);
    let best = 0;
    for (const x of offsets(width, start.worldWidth)) {
      for (const y of offsets(height, start.worldHeight)) {
        const candidate = { ...start, x: x ?? start.x, y: y ?? start.y };
        if (inView(candidate).every(Boolean) && shown(candidate, table)) best = Math.max(best, onStage(candidate, room));
      }
    }
    const phoneFraming = initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, true);
    expect({ objects: inView(start), table: shown(start, table), mostRoom: onStage(start, room) >= best - 0.001 * width * height })
      .toEqual({ objects: [true, true, true], table: true, mostRoom: true });
    // Against the main-floor-centre framing the phone band keeps, at the same scale: less black, more of the QA corner.
    if (phoneFraming.scale === start.scale) {
      expect({ lessBlack: blackShare(start) <= blackShare(phoneFraming), moreQa: qaShown(start) >= qaShown(phoneFraming) }).toEqual({ lessBlack: true, moreQa: true });
    }
  });

  it.each([
    { width: 964, height: 605, dpr: 1 },
    { width: 964, height: 605, dpr: 2 },
    { width: 500, height: 500, dpr: 1 },
    { width: 500, height: 500, dpr: 2 },
  ])('keeps a $width x $height desktop stage at CSS scale 1 and shows the question note and folders where they fit at dpr $dpr', ({ width, height, dpr }) => {
    const start = initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, false);
    const required = [ROOM_PROP_BOXES.questions, ROOM_PROP_BOXES.review];
    const requiredWidth = Math.max(...required.map(([x, , w]) => x! + w!)) - Math.min(...required.map(([x]) => x!));
    const requiredHeight = Math.max(...required.map(([, y, , h]) => y! + h!)) - Math.min(...required.map(([, y]) => y!));
    const fits = requiredWidth <= width - 16 && requiredHeight <= height - 16;
    const primary = inView(start).slice(0, 2);
    expect({ scale: start.scale, pixelScale: start.pixelScale }).toEqual({ scale: 1, pixelScale: dpr });
    if (fits) expect(primary).toEqual([true, true]);
    else expect(required.map((box) => objectShare(start, box)).every((share) => share > 0)).toBe(true);
  });

  it.each([
    { width: 964, height: 605 },
    { width: 500, height: 500 },
  ])('uses the best whiteboard view and the least-black camera among it on an overflowing $width x $height desktop stage', ({ width, height }) => {
    const start = initialOfficeViewport(width, height, 1, { x: 0, y: 0 }, false);
    const offsets = (stageSize: number, worldSize: number) => {
      if (worldSize <= stageSize) return [start.x];
      const values: number[] = [];
      for (let value = stageSize - worldSize; value < 0; value += 4) values.push(value);
      values.push(0);
      return values;
    };
    const candidates: { primaryMin: number; primarySum: number; board: number; room: number }[] = [];
    for (const x of offsets(width, start.worldWidth)) {
      for (const y of offsets(height, start.worldHeight)) {
        const candidate = { ...start, x, y };
        const question = objectShare(candidate, ROOM_PROP_BOXES.questions);
        const review = objectShare(candidate, ROOM_PROP_BOXES.review);
        candidates.push({ primaryMin: Math.min(question, review), primarySum: question + review, board: objectShare(candidate, ROOM_PROP_BOXES.board), room: onStage(candidate, room) });
      }
    }
    const bestPrimaryMin = Math.max(...candidates.map(({ primaryMin }) => primaryMin));
    const bestPrimarySum = Math.max(...candidates.filter(({ primaryMin }) => primaryMin >= bestPrimaryMin - 0.01).map(({ primarySum }) => primarySum));
    const required = [ROOM_PROP_BOXES.questions, ROOM_PROP_BOXES.review];
    const requiredWidth = Math.max(...required.map(([x, , w]) => x! + w!)) - Math.min(...required.map(([x]) => x!));
    const requiredHeight = Math.max(...required.map(([, y, , h]) => y! + h!)) - Math.min(...required.map(([, y]) => y!));
    const requiredFits = requiredWidth <= width - 16 && requiredHeight <= height - 16;
    const priorityCandidates = requiredFits
      ? candidates.filter(({ primaryMin, primarySum }) => primaryMin >= 0.999 && primarySum >= 1.998)
      : candidates.filter(({ primaryMin, primarySum }) => primaryMin >= bestPrimaryMin - 0.01 && primarySum >= bestPrimarySum - 0.02);
    const bestBoard = Math.max(...priorityCandidates.map(({ board }) => board));
    const bestRoom = Math.max(...priorityCandidates.filter(({ board }) => board >= bestBoard - 0.01).map(({ room }) => room));
    const question = objectShare(start, ROOM_PROP_BOXES.questions);
    const review = objectShare(start, ROOM_PROP_BOXES.review);
    expect(Math.min(question, review)).toBeGreaterThanOrEqual(bestPrimaryMin - 0.02);
    expect(question + review).toBeGreaterThanOrEqual(bestPrimarySum - 0.03);
    expect(objectShare(start, ROOM_PROP_BOXES.board)).toBeGreaterThanOrEqual(bestBoard - 0.03);
    expect(onStage(start, room)).toBeGreaterThanOrEqual(bestRoom - 0.02 * width * height);
  });

  // The largest scale that fits the question note, the folders, the whiteboard and the table 8 px inside the stage.
  const fitScale = (width: number, height: number) => {
    const boxes = [ROOM_PROP_BOXES.questions, ROOM_PROP_BOXES.review, ROOM_PROP_BOXES.board, table];
    const extent = (start: number, size: number) => Math.max(...boxes.map((box) => box[start]! + box[size]!)) - Math.min(...boxes.map((box) => box[start]!));
    return Math.min((width - 16) / extent(0, 2), (height - 16) / extent(1, 3));
  };
  // Each width has dpr 1 scale 1; the whole-device-pixel rule floors t × dpr and never drops below k = 1.
  it.each([
    { width: 500, css: [1, 0.8, 2 / 3, 1, 1] },
    { width: 966, css: [1, 0.8, 2 / 3, 1, 1] },
    { width: 1200, css: [1, 0.8, 2 / 3, 1, 1] },
    { width: 1515, css: [1, 0.8, 2 / 3, 1, 1] },
  ])('gives a desktop $width CSS px stage the largest whole device-pixel scale at or below its dpr 1 scale', ({ width, css }) => {
    const height = width * WORLD_HEIGHT / WORLD_WIDTH;
    const scales = [1, 1.25, 1.5, 2, 3].map((dpr) => initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, false).scale);
    expect(scales.map((scale, i) => Math.abs(scale - css[i]!) < 1e-9)).toEqual([true, true, true, true, true]);
    const pixelScales = [1, 1.25, 1.5, 2, 3].map((dpr, i) => scales[i]! * dpr);
    expect(pixelScales.every((k) => k >= 1 && Math.abs(k - Math.round(k)) < 1e-9)).toBe(true);
    expect(scales[0]).toBe(scales[3]);
  });

  it.each([500, 966, 1200, 1515])('crops a %s CSS px desktop stage the same way at dpr 1 and 2', (width) => {
    const height = width * WORLD_HEIGHT / WORLD_WIDTH;
    const [one, two] = [1, 2].map((dpr) => initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, false));
    expect({ scale: two!.scale, pixelScale: two!.pixelScale, x: Math.abs(two!.x - one!.x) <= 0.5, y: Math.abs(two!.y - one!.y) <= 0.5 })
      .toEqual({ scale: one!.scale, pixelScale: 2 * one!.pixelScale, x: true, y: true });
  });

  it('keeps one device pixel per art pixel when the browser zooms below 1', () => {
    const viewport = initialOfficeViewport(964, 605, 0.8, { x: 0, y: 0 }, false);
    expect({ scale: viewport.scale, pixelScale: viewport.pixelScale }).toEqual({ scale: 1 / 0.8, pixelScale: 1 });
  });

  it.each([
    { width: 390, height: 245.14, phone: 1 / 3, desktop: 1 },
    { width: 767, height: 482.11, phone: 1 / 3, desktop: 1 },
  ])('keeps the width-and-density scale in the phone band at $width CSS px and dpr 3', ({ width, height, phone, desktop }) => {
    const today = Math.min(officePixelScale(width, 3) / 3, fitScale(width, height));
    expect({
      phone: initialOfficeViewport(width, height, 3, { x: 0, y: 0 }, true).scale,
      today,
      desktop: initialOfficeViewport(width, height, 3, { x: 0, y: 0 }, false).scale,
    }).toEqual({ phone, today: phone, desktop });
  });

  it('reads the band from the 767 px media query when the caller passes none', () => {
    const original = window.matchMedia;
    const query = (matches: boolean) => (media: string) => ({ matches: matches && media === '(max-width: 767px)' }) as MediaQueryList;
    try {
      window.matchMedia = query(true);
      const phone = initialOfficeViewport(767, 482.11, 3).scale;
      const resizedPhone = resizeOfficeViewport(initialOfficeViewport(767, 482.11, 3), 767, 482.11, 3).scale;
      window.matchMedia = query(false);
      expect({ phone, resizedPhone, desktop: initialOfficeViewport(767, 482.11, 3).scale }).toEqual({ phone: 1 / 3, resizedPhone: 1 / 3, desktop: 1 });
    } finally {
      window.matchMedia = original;
    }
  });

  it('starts the phone view centred on the main floor, moved to show the objects and the table, while clamping later pans at all four edges', () => {
    const width = 390;
    const height = width * WORLD_HEIGHT / WORLD_WIDTH;
    const start = initialOfficeViewport(width, height, 3, { x: 0, y: 0 }, true);
    const [x, y] = p(6, H / 2);
    const centre = {
      x: start.originX + start.x + x * start.scale,
      y: start.originY + start.y + y * start.scale,
    };
    const left = panOfficeViewport(start, 10_000, 0);
    const right = panOfficeViewport(start, -10_000, 0);
    const top = panOfficeViewport(start, 0, 10_000);
    const bottom = panOfficeViewport(start, 0, -10_000);
    expect({
      centreErrorDevicePixels: {
        x: Math.abs(centre.x - width / 2) * start.devicePixelRatio,
        y: Math.abs(centre.y - height / 2) * start.devicePixelRatio,
      },
      leftCover: [left.originX + left.x <= 0, left.originX + left.x >= -1 / left.devicePixelRatio],
      rightCover: [right.originX + right.x + right.worldWidth >= width, right.originX + right.x + right.worldWidth <= width + 1 / right.devicePixelRatio],
      topCover: [top.originY + top.y <= 0, top.originY + top.y >= -1 / top.devicePixelRatio],
      bottomCover: [bottom.originY + bottom.y + bottom.worldHeight >= height, bottom.originY + bottom.y + bottom.worldHeight <= height + 1 / bottom.devicePixelRatio],
    }).toEqual({
      centreErrorDevicePixels: { x: 0, y: expect.any(Number) },
      leftCover: [true, true],
      rightCover: [true, true],
      topCover: [true, true],
      bottomCover: [true, true],
    });
    // Vertically the centre moves the least distance that brings the whole meeting table into view.
    expect({ objects: inView(start), table: shown(start, table) }).toEqual({ objects: [true, true, true], table: true });
  });

  it('keeps the world point at the box centre when the viewport resizes', () => {
    // A pan that keeps the box centre where the resized stage's world edges still allow it, and small enough that the
    // resized stage needs no shift to bring the whiteboard back in (-60, -20 did once the board moved to p(6.95, 0, 2.05)).
    const panned = panOfficeViewport(initialOfficeViewport(1000, 628.57, 1), -40, 10);
    const before = {
      x: (panned.stageWidth / 2 - panned.originX - panned.x) / panned.scale,
      y: (panned.stageHeight / 2 - panned.originY - panned.y) / panned.scale,
    };
    const resized = resizeOfficeViewport(panned, 1200, 754.29, 1.25);
    const after = {
      x: (resized.stageWidth / 2 - resized.originX - resized.x) / resized.scale,
      y: (resized.stageHeight / 2 - resized.originY - resized.y) / resized.scale,
    };
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  });

  it('keeps desktop CSS scale 1 on the narrow stage five Needs rows leave at 1280x800', () => {
    // 710 x 446 CSS px is the stage measured at 1280x800 dpr 1 with five Needs rows; overflow stays reachable by panning.
    const viewport = initialOfficeViewport(710, 446, 1);
    expect({ scale: viewport.scale, pixelScale: viewport.pixelScale, noteAndFolders: inView(viewport).slice(0, 2) })
      .toEqual({ scale: 1, pixelScale: 1, noteAndFolders: [true, true] });
    const board = ROOM_PROP_BOXES.board;
    const targetX = 8 - board[0]! * viewport.scale - viewport.originX;
    const targetY = 8 - board[1]! * viewport.scale - viewport.originY;
    const panned = panOfficeViewport(viewport, targetX - viewport.x, targetY - viewport.y);
    expect(shown(panned, board)).toBe(true);
  });
  it('still pans the full-scale narrow stage to both edges of the world', () => {
    const start = initialOfficeViewport(710, 446, 1);
    const left = panOfficeViewport(start, 10_000, 0);
    const right = panOfficeViewport(start, -10_000, 0);
    const rightEdge = right.originX + right.x + right.worldWidth;
    expect([left.originX + left.x, rightEdge >= 710 && rightEdge <= 711]).toEqual([0, true]);
  });
  it('keeps the question note and folders in view on a 1000 x 628 desktop stage', () => {
    const viewport = initialOfficeViewport(1000, 628, 1, { x: 0, y: 0 }, false);
    expect({ scale: viewport.scale, noteAndFolders: inView(viewport).slice(0, 2) }).toEqual({ scale: 1, noteAndFolders: [true, true] });
  });
  it('keeps the folders in view when the stage shrinks under a panned camera', () => {
    const panned = panOfficeViewport(initialOfficeViewport(1000, 628, 1), 400, 400);
    expect(inView(resizeOfficeViewport(panned, 710, 446, 1)).slice(0, 2)).toEqual([true, true]);
  });
  it('shows every object on a 1280x800 stage, whose main-floor centre (checked above) needs no shift', () => {
    expect(inView(initialOfficeViewport(1280, 800, 1))).toEqual([true, true, true]);
  });
  it.each([
    { width: 1280, height: 800, dpr: 1, scale: 1 },
    { width: 2560, height: 1609, dpr: 1, scale: 2 },
  ])('keeps the whole-device-pixel scale and every object and the table in view on a wide $width x $height stage', ({ width, height, dpr, scale }) => {
    const viewport = initialOfficeViewport(width, height, dpr, { x: 0, y: 0 }, false);
    expect({ scale: viewport.scale, objects: inView(viewport), table: shown(viewport, table) })
      .toEqual({ scale, objects: [true, true, true], table: true });
  });

  // Chromium resamples a canvas whose CSS size is a fraction of a pixel, blending half its device pixels even when the
  // backing store matches: the 1280x800 page's stage at dpr 2 (899.25 wide, device origin 0.125) gave 1799 device pixels
  // at 899.5 CSS pixels.
  it('rounds the canvas CSS dimensions up to whole CSS pixels at a whole-number density', () => {
    const viewport = initialOfficeViewport(899.25, 564.5, 2, { x: 0.125, y: 0 }, false);
    expect([viewport.canvasWidth, viewport.canvasHeight]).toEqual([900, 565]);
  });

  it('rounds the canvas CSS dimensions up to whole device pixels at fractional density', () => {
    const viewport = initialOfficeViewport(390.4, 245.1, 1.5);
    expect({
      widthDevicePixels: Math.round(viewport.canvasWidth * viewport.devicePixelRatio),
      heightDevicePixels: Math.round(viewport.canvasHeight * viewport.devicePixelRatio),
    }).toEqual({
      widthDevicePixels: Math.ceil(390.4 * 1.5),
      heightDevicePixels: Math.ceil(245.1 * 1.5),
    });
  });
});
