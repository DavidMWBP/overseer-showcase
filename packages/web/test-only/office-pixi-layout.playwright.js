import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.OFFICE_PIXI_LAYOUT_BASE_URL;
if (!baseUrl) throw new Error('Set OFFICE_PIXI_LAYOUT_BASE_URL to this worktree\'s running Vite server');
const port = new URL(baseUrl).port;
assert.ok(!['4400', '5173', '5174'].includes(port), `Refusing a reserved live port: ${port}`);
const evidenceDir = process.env.OFFICE_PIXI_LAYOUT_EVIDENCE_DIR
  ? path.resolve(process.env.OFFICE_PIXI_LAYOUT_EVIDENCE_DIR)
  : await mkdtemp(path.join(os.tmpdir(), 'office-pixi-layout-'));
await mkdir(evidenceDir, { recursive: true });

const viewports = [
  { width: 1280, height: 800, dpr: 1 },
  { width: 1440, height: 900, dpr: 2 },
  // The 1280x800 page at dpr 2 gives a stage 899.25 CSS pixels wide, which a device-pixel canvas left at 899.5.
  { width: 1280, height: 800, dpr: 2 },
  { width: 390, height: 844, dpr: 3 },
  // A desktop stage wide and tall enough for CSS 1: dpr 2 draws it at CSS 1 (k 2), as dpr 1 does, not at half size.
  { width: 1920, height: 1080, dpr: 2 },
];
const failures = [];
let checks = 0;
const check = (condition, message) => {
  checks++;
  if (!condition) failures.push(message);
};
const closeTo = (actual, expected, tolerance = 0.05) => Math.abs(actual - expected) <= tolerance;
// The room objects' world boxes (ROOM_PROP_BOXES in src/office/pixi/roomProps.ts) and the meeting table's (TABLE_BOX in
// src/office/pixi/viewport.ts). When they do not fit, the question note and folders take priority, then the whiteboard.
const OBJECT_BOXES = { questions: [529.4, 613.52, 74.6, 40], review: [923, 754, 158, 86], board: [1030, 284, 140, 156], table: [895.68, 739.584, 215.04, 145.536] };
// The phone band keeps its width-and-density scale and zooms out to fit all four bounds when needed. Desktop uses
// t = min(max(1, round(width / 1680)), max(1, fit)), k = max(1, floor(t * dpr)), and CSS scale k / dpr.
function fitScale(width, height) {
  const boxes = Object.values(OBJECT_BOXES);
  const extent = (axis) => {
    const spans = boxes.map(([x, y, w, h]) => (axis === 'x' ? [x, x + w] : [y, y + h]));
    return Math.max(...spans.map(([, b]) => b)) - Math.min(...spans.map(([a]) => a));
  };
  return Math.min((width - 16) / extent('x'), (height - 16) / extent('y'));
}
function expectedScale(width, height, dpr, phone) {
  const fit = fitScale(width, height);
  if (phone) {
    const whole = Math.max(1, Math.round((width / 1680) * dpr)) / dpr;
    return fit > 0 ? Math.min(whole, fit) : whole;
  }
  const sameCssSize = Math.max(1, Math.round(width / 1680));
  const target = Math.min(sameCssSize, Math.max(1, fit));
  const k = Math.max(1, Math.floor(target * dpr + 1e-9));
  return k / dpr;
}
// The room's silhouette (floor and both 4-unit back walls, p(i, j, z) from src/office/pixi/world.ts); outside it the stage is black.
const worldPoint = (i, j, z = 0) => [696 + (i - j) * 48, 216 + (i + j) * 24 - z * 48];
const ROOM = [worldPoint(0, 14), worldPoint(0, 14, 4), worldPoint(0, 0, 4), worldPoint(20, 0, 4), worldPoint(20, 0), worldPoint(20, 14)];
// CSS px² of the room inside the stage for a world offset (origin + camera): the polygon clipped to the box, then its area.
function roomOnStage(left, top, scale, width, height) {
  let points = ROOM.map(([x, y]) => [left + x * scale, top + y * scale]);
  for (const [axis, limit, above] of [[0, 0, true], [0, width, false], [1, 0, true], [1, height, false]]) {
    const inside = (q) => (above ? q[axis] >= limit : q[axis] <= limit);
    points = points.flatMap((current, index) => {
      const previous = points[(index + points.length - 1) % points.length];
      const crossing = inside(current) !== inside(previous)
        ? [previous.map((value, i) => value + ((limit - previous[axis]) / (current[axis] - previous[axis])) * (current[i] - value))]
        : [];
      return inside(current) ? [...crossing, current] : crossing;
    });
  }
  return Math.abs(points.reduce((sum, [x, y], index) => sum + x * points[(index + 1) % points.length][1] - points[(index + 1) % points.length][0] * y, 0)) / 2;
}
// Whether every object and the table sit 8 CSS px inside the stage (half a pixel of snapping allowed) at a world offset.
function objectsInside(left, top, scale, width, height) {
  return Object.values(OBJECT_BOXES).every(([x, y, w, h]) => left + x * scale >= 7.5 && top + y * scale >= 7.5
    && left + (x + w) * scale <= width - 7.5 && top + (y + h) * scale <= height - 7.5);
}
function visibleShare(left, top, scale, width, height, [x, y, w, h]) {
  const boxLeft = left + x * scale;
  const boxTop = top + y * scale;
  const visibleWidth = Math.max(0, Math.min(boxLeft + w * scale, width - 8) - Math.max(boxLeft, 8));
  const visibleHeight = Math.max(0, Math.min(boxTop + h * scale, height - 8) - Math.max(boxTop, 8));
  return (visibleWidth * visibleHeight) / (w * h * scale * scale);
}
function cameraOffsets(stageSize, worldSize, current, step = 4) {
  if (worldSize <= stageSize) return [current];
  const offsets = [];
  for (let value = stageSize - worldSize; value < 0; value += step) offsets.push(value);
  offsets.push(0);
  return offsets;
}
function primaryFits(width, height, scale) {
  const required = [OBJECT_BOXES.questions, OBJECT_BOXES.review];
  const extent = (axis) => {
    const spans = required.map(([x, y, w, h]) => (axis === 'x' ? [x, x + w] : [y, y + h]));
    return Math.max(...spans.map(([, b]) => b)) - Math.min(...spans.map(([a]) => a));
  };
  return extent('x') * scale <= width - 16 && extent('y') * scale <= height - 16;
}
function expectedCamera(camera, axis, stageSize, origin, scale) {
  const span = ([x, y, w, h]) => (axis === 'x' ? [x, x + w] : [y, y + h]);
  const union = (spans) => [Math.min(...spans.map(([a]) => a)), Math.max(...spans.map(([, b]) => b))];
  const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
  const show = (value, [a, b]) => {
    const lower = 8 - origin - a * scale;
    const upper = stageSize - 8 - origin - b * scale;
    return lower <= upper ? clamp(value, lower, upper) : value;
  };
  const required = union([span(OBJECT_BOXES.questions), span(OBJECT_BOXES.review)]);
  const all = union([required, span(OBJECT_BOXES.board), span(OBJECT_BOXES.table)]);
  const lower = 8 - origin - required[0] * scale;
  const upper = stageSize - 8 - origin - required[1] * scale;
  if (lower > upper) return camera;
  return clamp((all[1] - all[0]) * scale <= stageSize - 16 ? show(camera, all) : show(camera, span(OBJECT_BOXES.board)), lower, upper);
}
let browser;
const pages = [];

try {
  browser = await chromium.launch({ headless: true });

  async function open({ width, height, dpr }, query = '') {
    const mobile = width < 768;
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      hasTouch: mobile,
      isMobile: mobile,
    });
    pages.push(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // The retired renderer setting's Classic value, still stored in a browser that chose it, changes nothing.
    await page.addInitScript(() => localStorage.setItem('overseer.officeRenderer', 'classic'));
    await page.goto(`${baseUrl}/test-only/office-chat-dock.html${query}#office`);
    await page.locator('.office-stage-pixi canvas').waitFor();
    await page.getByRole('button', { name: /sonnet · (task )?ov-3/ }).waitFor();
    await page.waitForFunction(() => {
      const stage = document.querySelector('.office-stage-pixi');
      const canvas = stage?.querySelector('canvas');
      return !!stage?.dataset.officePixelScale && !!canvas && canvas.width > 0 && canvas.height > 0;
    });
    return page;
  }

  const measure = (page) => page.evaluate(() => {
    const stage = document.querySelector('.office-stage-pixi');
    const host = stage?.querySelector('.office-pixi-canvas');
    const canvas = host?.querySelector('canvas');
    const overlays = stage?.querySelector('.office-pixi-world-overlays');
    if (!stage || !host || !canvas || !overlays) throw new Error('Pixi stage layers are missing');
    const stageRect = stage.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const overlayRect = overlays.getBoundingClientRect();
    const dimRect = stage.querySelector('.office-pixi-dim').getBoundingClientRect();
    return {
      dpr: window.devicePixelRatio,
      stage: { left: stageRect.left, top: stageRect.top, width: stageRect.width, height: stageRect.height },
      host: { left: hostRect.left, top: hostRect.top, width: hostRect.width, height: hostRect.height },
      canvas: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height, backingWidth: canvas.width, backingHeight: canvas.height },
      dim: { left: dimRect.left, top: dimRect.top, width: dimRect.width, height: dimRect.height },
      touchAction: getComputedStyle(stage).touchAction,
      cssScale: Number(stage.dataset.officeCssScale),
      pixelScale: Number(stage.dataset.officePixelScale),
      cameraX: Number(stage.dataset.officeCameraX),
      cameraY: Number(stage.dataset.officeCameraY),
      originX: Number(stage.dataset.officeOriginX),
      originY: Number(stage.dataset.officeOriginY),
      worldWidth: 1680 * Number(stage.dataset.officeCssScale),
      worldHeight: 1056 * Number(stage.dataset.officeCssScale),
      overlay: { left: overlayRect.left, top: overlayRect.top, transform: overlays.style.transform },
      // The room objects' buttons are world-anchored: each follows its object as the room pans.
      props: [...stage.querySelectorAll('.office-room-props [data-office-prop]')].map((prop) => {
        const rect = prop.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        return {
          key: prop.dataset.officeProp, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          expectedLeft: hostRect.left + Number(stage.dataset.officeOriginX) + Number(stage.dataset.officeCameraX) + Number.parseFloat(prop.style.left),
          expectedTop: hostRect.top + Number(stage.dataset.officeOriginY) + Number(stage.dataset.officeCameraY) + Number.parseFloat(prop.style.top),
        };
      }),
      hit: (() => {
        const stageRect = stage.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const button = [...stage.querySelectorAll('.office-pixi-char')].find((item) => {
          const rect = item.getBoundingClientRect();
          return rect.right > stageRect.left && rect.left < stageRect.right && rect.bottom > stageRect.top && rect.top < stageRect.bottom;
        });
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return {
          id: button.dataset.agentId,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          expectedLeft: hostRect.left + Number(stage.dataset.officeOriginX) + Number(stage.dataset.officeCameraX) + Number.parseFloat(button.style.left),
          expectedTop: hostRect.top + Number(stage.dataset.officeOriginY) + Number(stage.dataset.officeCameraY) + Number.parseFloat(button.style.top),
          label: (() => {
            // Below 768 px the character's badge takes its label's place; both move with the world the same way.
            const label = stage.querySelector(`[data-label-for="${button.dataset.agentId}"], [data-badge-for="${button.dataset.agentId}"]`);
            if (!label) return null;
            const labelRect = label.getBoundingClientRect();
            return {
              left: labelRect.left,
              top: labelRect.top,
              expectedLeft: hostRect.left + Number(stage.dataset.officeOriginX) + Number(stage.dataset.officeCameraX) + Number.parseFloat(label.style.left),
              expectedTop: hostRect.top + Number(stage.dataset.officeOriginY) + Number(stage.dataset.officeCameraY) + Number.parseFloat(label.style.top),
            };
          })(),
        };
      })(),
    };
  });

  async function assertViewport(page, expectedDpr, label, phone) {
    const size = await measure(page);
    const expectedCss = expectedScale(size.host.width, size.host.height, expectedDpr, phone);
    const expectedK = expectedCss * expectedDpr;
    check(size.dpr === expectedDpr, `${label}: DPR ${size.dpr}, expected ${expectedDpr}`);
    check(closeTo(size.pixelScale, expectedK, 1e-6), `${label}: k ${size.pixelScale}, expected ${expectedK} from stage ${size.host.width}x${size.host.height}`);
    check(closeTo(size.cssScale, expectedCss, 1e-6), `${label}: CSS scale ${size.cssScale}, expected ${expectedCss}`);
    check(closeTo(size.stage.width / size.stage.height, 1680 / 1056, 0.01), `${label}: stage box ratio changed to ${size.stage.width}x${size.stage.height}`);
    check(closeTo(size.canvas.width * expectedDpr, Math.round(size.canvas.width * expectedDpr)), `${label}: canvas CSS width is not a whole device-pixel count`);
    check(closeTo(size.canvas.height * expectedDpr, Math.round(size.canvas.height * expectedDpr)), `${label}: canvas CSS height is not a whole device-pixel count`);
    // Chromium resamples a canvas whose CSS size is a fraction of a pixel, blending half its device pixels.
    if (Number.isInteger(expectedDpr)) {
      check(Number.isInteger(size.canvas.width) && Number.isInteger(size.canvas.height), `${label}: canvas CSS size ${size.canvas.width}x${size.canvas.height} is not whole CSS pixels`);
    }
    check(size.canvas.backingWidth === Math.round(size.canvas.width * expectedDpr), `${label}: backing width ${size.canvas.backingWidth} does not match its CSS width and DPR`);
    check(size.canvas.backingHeight === Math.round(size.canvas.height * expectedDpr), `${label}: backing height ${size.canvas.backingHeight} does not match its CSS height and DPR`);
    check(closeTo(size.canvas.left * expectedDpr, Math.round(size.canvas.left * expectedDpr)), `${label}: canvas origin is not aligned to a device pixel`);
    check(size.touchAction === 'none', `${label}: touch drag can scroll the page instead of the stage`);
    check(['left', 'top', 'width', 'height'].every((key) => closeTo(size.dim[key], size.host[key])), `${label}: dim layer does not cover the visible Pixi box`);
    if (!phone) {
      // Desktop: keep all four bounds inside when they fit. Otherwise, keep the question note and folders first, maximize
      // the whiteboard view next, then maximize room area (the least black) within that priority.
      const left = size.originX + size.cameraX;
      const top = size.originY + size.cameraY;
      const allFit = fitScale(size.host.width, size.host.height) + 1e-6 >= size.cssScale;
      const keepsPrimary = primaryFits(size.host.width, size.host.height, size.cssScale);
      const candidates = [];
      for (const x of cameraOffsets(size.host.width, size.worldWidth, left)) {
        for (const y of cameraOffsets(size.host.height, size.worldHeight, top)) {
          const question = visibleShare(x, y, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.questions);
          const review = visibleShare(x, y, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.review);
          candidates.push({ x, y, question, review, board: visibleShare(x, y, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.board), room: roomOnStage(x, y, size.cssScale, size.host.width, size.host.height) });
        }
      }
      let bestRoom;
      if (allFit) {
        bestRoom = Math.max(...candidates.filter(({ x, y }) => objectsInside(x, y, size.cssScale, size.host.width, size.host.height)).map(({ room }) => room));
        check(objectsInside(left, top, size.cssScale, size.host.width, size.host.height), `${label}: an object or the table is not 8 px inside the stage at the start`);
      } else if (keepsPrimary) {
        const primary = candidates.filter(({ question, review }) => question >= 0.999 && review >= 0.999);
        const bestBoard = Math.max(...primary.map(({ board }) => board));
        bestRoom = Math.max(...primary.filter(({ board }) => board >= bestBoard - 0.01).map(({ room }) => room));
        check(visibleShare(left, top, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.questions) >= 0.999
          && visibleShare(left, top, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.review) >= 0.999,
        `${label}: the question note or folders are not kept inside when they fit`);
        const boardNow = visibleShare(left, top, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.board);
        check(boardNow >= bestBoard - 0.02,
          `${label}: initial whiteboard share ${boardNow.toFixed(3)} is below the ${bestBoard.toFixed(3)} allowed by the primary bounds at camera (${left.toFixed(1)},${top.toFixed(1)})`);
      } else {
        const bestPrimaryMin = Math.max(...candidates.map(({ question, review }) => Math.min(question, review)));
        const bestPrimarySum = Math.max(...candidates.filter(({ question, review }) => Math.min(question, review) >= bestPrimaryMin - 0.01).map(({ question, review }) => question + review));
        const primary = candidates.filter(({ question, review }) => Math.min(question, review) >= bestPrimaryMin - 0.01 && question + review >= bestPrimarySum - 0.02);
        const bestBoard = Math.max(...primary.map(({ board }) => board));
        bestRoom = Math.max(...primary.filter(({ board }) => board >= bestBoard - 0.01).map(({ room }) => room));
        const question = visibleShare(left, top, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.questions);
        const review = visibleShare(left, top, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.review);
        check(Math.min(question, review) >= bestPrimaryMin - 0.02 && question + review >= bestPrimarySum - 0.03,
          `${label}: the initial view does not preserve as much of the question note and folders as the stage allows`);
        check(visibleShare(left, top, size.cssScale, size.host.width, size.host.height, OBJECT_BOXES.board) >= bestBoard - 0.02,
          `${label}: the initial view does not show as much whiteboard as the primary bounds allow`);
      }
      const shown = roomOnStage(left, top, size.cssScale, size.host.width, size.host.height);
      const stageArea = size.host.width * size.host.height;
      check(shown >= bestRoom - 0.02 * stageArea, `${label}: the start shows ${shown.toFixed(0)} CSS px² of room, less than the ${bestRoom.toFixed(0)} allowed by its object priority`);
      console.log(`MEASURE ${label} start: CSS scale ${size.cssScale}, ${((1 - shown / stageArea) * 100).toFixed(1)}% of the stage black outside the room`);
      return size;
    }
    // Phone: the main-floor centre p(6, H/2) = (648, 528) starts at the box centre, moved only as far as the room objects need.
    const expected = {
      x: expectedCamera(size.host.width / 2 - size.originX - 648 * size.cssScale, 'x', size.host.width, size.originX, size.cssScale),
      y: expectedCamera(size.host.height / 2 - size.originY - 528 * size.cssScale, 'y', size.host.height, size.originY, size.cssScale),
    };
    const target = { x: size.cameraX, y: size.cameraY, expected };
    if (size.worldWidth > size.host.width) {
      check(Math.abs(size.cameraX - expected.x) * expectedDpr <= 0.51, `${label}: main-floor centre x is not at the box centre moved for the room objects (${JSON.stringify({ target, size: size.stage })})`);
    } else {
      const centredLeft = (size.host.width - size.worldWidth) / 2;
      check(Math.abs(size.originX + size.cameraX - centredLeft) * expectedDpr <= 0.51, `${label}: a world that fits is not centred horizontally`);
    }
    if (size.worldHeight > size.host.height) {
      check(Math.abs(size.cameraY - expected.y) * expectedDpr <= 0.51, `${label}: main-floor centre y is not at the box centre moved for the room objects (${JSON.stringify({ target, size: size.stage })})`);
    } else {
      const centredTop = (size.host.height - size.worldHeight) / 2;
      check(Math.abs(size.originY + size.cameraY - centredTop) * expectedDpr <= 0.51, `${label}: a world that fits is not centred vertically`);
    }
    return size;
  }

  async function panToEdge(page, direction, label) {
    const stage = page.locator('.office-stage-pixi');
    const rect = await stage.boundingBox();
    assert.ok(rect, `${label}: stage has no box`);
    const before = await measure(page);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (before.worldWidth <= before.host.width) {
      await page.mouse.wheel(direction === 'left' ? -5000 : 5000, 0);
      const size = await measure(page);
      check(size.cameraX === before.cameraX, `${label}: a world that fits the box moved on ${direction} scroll`);
      if (size.hit) {
        check(closeTo(size.hit.left, size.hit.expectedLeft) && closeTo(size.hit.top, size.hit.expectedTop), `${label}: hit button moved away from its world position (${JSON.stringify(size.hit)})`);
        if (size.hit.label) check(closeTo(size.hit.label.left, size.hit.label.expectedLeft) && closeTo(size.hit.label.top, size.hit.label.expectedTop), `${label}: label moved away from its world position (${JSON.stringify(size.hit.label)})`);
      }
      check(size.props.every((prop) => closeTo(prop.left, prop.expectedLeft) && closeTo(prop.top, prop.expectedTop)), `${label}: a room object button left its object (${JSON.stringify(size.props)})`);
      await stage.screenshot({ path: path.join(evidenceDir, `${label}-${direction}-world-fits.png`) });
      console.log(`PASS ${label} ${direction} edge visible without pan: world width ${size.worldWidth.toFixed(2)} fits stage width ${size.host.width.toFixed(2)}`);
      return size;
    }
    await page.mouse.wheel(direction === 'left' ? -5000 : 5000, 0);
    await page.waitForFunction(({ direction, beforeX }) => {
      const stageNode = document.querySelector('.office-stage-pixi');
      const x = Number(stageNode?.dataset.officeCameraX);
      return direction === 'left' ? x > beforeX : x < beforeX;
    }, { direction, beforeX: before.cameraX });
    const size = await measure(page);
    const left = size.originX + size.cameraX;
    const right = left + size.worldWidth;
    if (direction === 'left') {
      check(left <= 0 && left >= -1 / size.dpr, `${label}: left edge is not clamped (${left})`);
    } else {
      check(right >= size.host.width && right <= size.host.width + 1 / size.dpr, `${label}: right edge is not clamped (${right} vs ${size.host.width})`);
    }
    if (size.hit) {
      check(closeTo(size.hit.left, size.hit.expectedLeft) && closeTo(size.hit.top, size.hit.expectedTop), `${label}: hit button moved away from its world position (${JSON.stringify(size.hit)})`);
      if (size.hit.label) check(closeTo(size.hit.label.left, size.hit.label.expectedLeft) && closeTo(size.hit.label.top, size.hit.label.expectedTop), `${label}: label moved away from its world position (${JSON.stringify(size.hit.label)})`);
    }
    check(size.props.every((prop) => closeTo(prop.left, prop.expectedLeft) && closeTo(prop.top, prop.expectedTop)), `${label}: a room object button left its object (${JSON.stringify(size.props)})`);
    await stage.screenshot({ path: path.join(evidenceDir, `${label}-${direction}.png`) });
    console.log(`PASS ${label} ${direction} edge: camera=(${size.cameraX},${size.cameraY}) hit=${size.hit?.id ?? 'none'}`);
    return size;
  }

  for (const viewport of viewports) {
    const label = `${viewport.width}x${viewport.height}-dpr${viewport.dpr}`;
    const page = await open(viewport);
    const phone = viewport.width < 768;
    const initial = await assertViewport(page, viewport.dpr, label, phone);
    // Desktop always uses at least one device pixel per art pixel; the phone band may zoom out to keep its objects visible.
    check(phone ? initial.pixelScale >= 1 || closeTo(initial.cssScale, fitScale(initial.host.width, initial.host.height), 1e-6) : initial.pixelScale >= 1,
      `${label}: desktop pixel scale fell below one device pixel per art pixel`);
    const marks = await page.evaluate(() => ({ labels: document.querySelectorAll('.office-char-label').length, badges: document.querySelectorAll('.office-badge[data-badge-for]').length }));
    check(phone ? marks.badges > 0 && marks.labels === 0 : marks.labels > 0 && marks.badges === 0, `${label}: expected ${phone ? 'badges and no labels' : 'labels and no badges'}, got ${JSON.stringify(marks)}`);
    console.log(`SPRITE ROW ${label}: ${JSON.stringify({ id: initial.hit?.id, dpr: initial.dpr, k: initial.pixelScale, left: initial.hit ? initial.hit.left - initial.stage.left : null, top: initial.hit ? initial.hit.top - initial.stage.top : null, width: initial.hit?.width, height: initial.hit?.height })}`);
    await page.locator('.office-stage-pixi').screenshot({ path: path.join(evidenceDir, `${label}-open.png`) });
    await panToEdge(page, 'left', label);
    await panToEdge(page, 'right', label);
    console.log(`PASS ${label} opened with k=${initial.pixelScale}, cssScale=${initial.cssScale}, stage=${initial.host.width.toFixed(2)}x${initial.host.height.toFixed(2)}`);
  }

  // The room objects: keyboard order, focus ring and chip, and a pointer tap reaching the object through its button.
  for (const viewport of [viewports[0], viewports[2]]) {
    const label = `${viewport.width}x${viewport.height}-dpr${viewport.dpr} room objects`;
    const page = await open(viewport);
    const phone = viewport.width < 768;
    const opened = () => page.evaluate(() => [...(window.__officeRoomOpened ?? [])]);
    const inStage = await page.evaluate(() => {
      const stageRect = document.querySelector('.office-stage-pixi').getBoundingClientRect();
      return [...document.querySelectorAll('.office-room-props [data-office-prop]')].map((button) => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return { key: button.dataset.officeProp, x, y, visible: x > stageRect.left && x < stageRect.right && y > stageRect.top && y < stageRect.bottom };
      });
    });
    const canvasProps = await page.evaluate(() => document.querySelector('.office-stage-pixi canvas')?.dataset.officeRoomProps ?? null);
    check(canvasProps === 'questions=0 review=0 board=0,0,0,0,0,0', `${label}: the scene did not draw the fixture's counts (${canvasProps})`);
    if (phone) {
      const row = await page.evaluate(() => [...document.querySelectorAll('.office-count-row [data-office-count]')].map((button) => button.getAttribute('aria-label')));
      check(inStage.length === 0 && row.length === 8, `${label}: expected the count row and no object buttons (${JSON.stringify({ inStage, row })})`);
      console.log(`PASS ${label}: count row with ${row.length} buttons, no object buttons in the room`);
      continue;
    }
    check(JSON.stringify(inStage.map(({ key }) => key)) === JSON.stringify(['questions', 'review', 'board']), `${label}: object buttons are not Questions, In review, Board (${JSON.stringify(inStage)})`);
    // Keyboard: Tab from the last character reaches Questions, In review and Board in that order, each with a ring and its chip.
    await page.locator('.office-pixi-char').last().focus();
    const order = [];
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => {
        const active = document.activeElement;
        const chip = active?.querySelector('.office-room-prop-chip');
        const style = active ? getComputedStyle(active) : null;
        return { key: active?.dataset.officeProp ?? null, ring: style ? `${style.outlineStyle} ${style.outlineWidth}` : null, chip: chip ? getComputedStyle(chip).visibility : null, chipText: chip?.textContent ?? null };
      }));
    }
    check(JSON.stringify(order.map(({ key }) => key)) === JSON.stringify(['questions', 'review', 'board']), `${label}: tab order is ${JSON.stringify(order)}`);
    check(order.every(({ ring, chip }) => ring === 'solid 2px' && chip === 'visible'), `${label}: a focused object has no ring or chip (${JSON.stringify(order)})`);
    // The whiteboard's long chip (focused now) stays inside the stage box that clips it.
    const chipBox = await page.evaluate(() => {
      const chip = document.querySelector('[data-office-prop="board"] .office-room-prop-chip').getBoundingClientRect();
      const stageBox = document.querySelector('.office-stage-pixi').getBoundingClientRect();
      return { chipLeft: chip.left, chipRight: chip.right, stageLeft: stageBox.left, stageRight: stageBox.right };
    });
    check(chipBox.chipLeft >= chipBox.stageLeft && chipBox.chipRight <= chipBox.stageRight, `${label}: the whiteboard chip leaves the stage (${JSON.stringify(chipBox)})`);
    console.log(`MEASURE ${label} whiteboard chip ${chipBox.chipLeft.toFixed(1)}..${chipBox.chipRight.toFixed(1)} inside stage ${chipBox.stageLeft.toFixed(1)}..${chipBox.stageRight.toFixed(1)}`);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');
    check(JSON.stringify(await opened()) === JSON.stringify(['board', 'review']), `${label}: Enter on Board and Space on In review did not open them (${JSON.stringify(await opened())})`);
    await page.locator('.office-stage-pixi').screenshot({ path: path.join(evidenceDir, `${label}-focus-review.png`) });
    // Pointer: the buttons let input through, so the scene's hit area under the whiteboard takes the click, and its hover shows the chip.
    const board = inStage.find(({ key }) => key === 'board');
    check(board.visible, `${label}: the whiteboard is not in view (${JSON.stringify(board)})`);
    await page.mouse.move(board.x, board.y);
    await page.waitForFunction(() => document.querySelector('[data-office-prop="board"]')?.classList.contains('office-room-prop-hover'));
    const hoverChip = await page.evaluate(() => getComputedStyle(document.querySelector('[data-office-prop="board"] .office-room-prop-chip')).visibility);
    check(hoverChip === 'visible', `${label}: hovering the whiteboard shows no chip (${hoverChip})`);
    await page.locator('.office-stage-pixi').screenshot({ path: path.join(evidenceDir, `${label}-hover-board.png`) });
    await page.mouse.click(board.x, board.y);
    await page.waitForFunction(() => (window.__officeRoomOpened ?? []).length === 3);
    check((await opened())[2] === 'board', `${label}: a click on the whiteboard did not open the Board (${JSON.stringify(await opened())})`);
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector('[data-office-prop="board"]')?.classList.contains('office-room-prop-hover'));
    // Hover: the canvas cursor and the scene's hover target over the whiteboard and over empty floor, and the whiteboard's
    // chip next to the visible part of the (sheared, ROOM_PROP_SHEAR) whiteboard and inside the stage, after a drag pan,
    // a wheel pan and a resize too.
    const boardView = () => page.evaluate(() => {
      const stageRect = document.querySelector('.office-stage-pixi').getBoundingClientRect();
      const button = document.querySelector('[data-office-prop="board"]');
      const chip = button.querySelector('.office-room-prop-chip');
      const b = button.getBoundingClientRect();
      const c = chip.getBoundingClientRect();
      const shear = 0.5;
      const left = Math.max(b.left, stageRect.left);
      const right = Math.min(b.right, stageRect.right);
      const top = Math.max(stageRect.top, b.top + shear * (left - b.left));
      const bottom = Math.min(stageRect.bottom, b.bottom - shear * (b.right - right));
      const gx = Math.max(0, left - c.right, c.left - right);
      const gy = Math.max(0, top - c.bottom, c.top - bottom);
      const x = (left + right) / 2;
      return {
        point: { x, y: b.top + shear * (x - b.left) + (b.height - shear * b.width) / 2 },
        gap: Math.hypot(gx, gy),
        inside: c.left >= stageRect.left - 0.5 && c.right <= stageRect.right + 0.5 && c.top >= stageRect.top - 0.5 && c.bottom <= stageRect.bottom + 0.5,
        chipShown: getComputedStyle(chip).visibility,
        board: { left, right, top, bottom }, chip: { left: c.left, right: c.right, top: c.top, bottom: c.bottom },
        stage: { left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom },
      };
    });
    const pointerRead = () => page.evaluate(() => {
      const canvas = document.querySelector('.office-stage-pixi canvas');
      return { cursor: getComputedStyle(canvas).cursor, target: canvas.dataset.officeHover ?? null };
    });
    const hoverBoardChip = async (when) => {
      const view = await boardView();
      await page.mouse.move(view.point.x, view.point.y, { steps: 3 });
      await page.waitForFunction(() => document.querySelector('[data-office-prop="board"]')?.classList.contains('office-room-prop-hover'));
      const read = await pointerRead();
      const shown = await boardView();
      check(read.cursor === 'pointer' && read.target === 'prop:board', `${label} ${when}: the whiteboard under the pointer has no pointer cursor or is not the hover target (${JSON.stringify(read)})`);
      check(shown.chipShown === 'visible' && shown.gap <= 12 && shown.inside, `${label} ${when}: the whiteboard chip is not next to the whiteboard inside the stage (${JSON.stringify(shown)})`);
      console.log(`MEASURE ${label} ${when}: cursor ${read.cursor}, target ${read.target}, chip ${shown.chip.left.toFixed(1)}..${shown.chip.right.toFixed(1)} x ${shown.chip.top.toFixed(1)}..${shown.chip.bottom.toFixed(1)}, visible whiteboard ${shown.board.left.toFixed(1)}..${shown.board.right.toFixed(1)} x ${shown.board.top.toFixed(1)}..${shown.board.bottom.toFixed(1)}, gap ${shown.gap.toFixed(1)} px, inside stage ${shown.inside}`);
    };
    await hoverBoardChip('before a pan');
    const floorAt = await page.evaluate(() => { const r = document.querySelector('.office-stage-pixi').getBoundingClientRect(); return { x: r.left + 12, y: r.bottom - 12 }; });
    await page.mouse.move(floorAt.x, floorAt.y, { steps: 3 });
    await page.waitForFunction(() => document.querySelector('.office-stage-pixi canvas')?.dataset.officeHover === '');
    const floor = await pointerRead();
    check(floor.cursor !== 'pointer' && floor.target === '', `${label}: empty floor shows a pointer cursor or a hover target (${JSON.stringify(floor)})`);
    console.log(`MEASURE ${label} empty floor: cursor ${floor.cursor}, target '${floor.target}'`);
    const stageBox = await page.locator('.office-stage-pixi').boundingBox();
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width / 2 + 160, stageBox.y + stageBox.height / 2 + 120, { steps: 12 });
    await page.mouse.up();
    await hoverBoardChip('after a drag pan');
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.wheel(120, -60);
    await page.waitForTimeout(100);
    await hoverBoardChip('after a wheel pan');
    await page.setViewportSize({ width: viewport.width + 160, height: viewport.height + 100 });
    await page.waitForTimeout(300);
    await hoverBoardChip('after a resize');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector('[data-office-prop="board"]')?.classList.contains('office-room-prop-hover'));
    const left = await pointerRead();
    check(left.target === '', `${label}: the hover target stays after the pointer leaves the canvas (${JSON.stringify(left)})`);
    // Keyboard again: Enter on Questions opens Chat, which leaves the Office view.
    await page.locator('[data-office-prop="questions"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.office-hold')?.hidden === true);
    check((await opened())[3] === 'chat', `${label}: Enter on Questions did not open Chat (${JSON.stringify(await opened())})`);
    console.log(`PASS ${label}: tab order ${order.map(({ key }) => key).join(' > ')} with ring and chip; Enter/Space open Board and Review; a click on the whiteboard opens the Board through the scene's hit area and its hover shows the chip; Enter on Questions opens Chat`);
  }

  // Five Needs rows narrow the stage to about 710 x 446 CSS px. Desktop stays at CSS scale 1, keeps the question note and
  // folders in view, and reaches anything cropped by dragging. Focusing an object's button must not scroll the stage.
  {
    const label = '1280x800-dpr1 five needs rows';
    const page = await open(viewports[0], '?items=5');
    const boxes = await page.evaluate((table) => {
      const stageNode = document.querySelector('.office-stage-pixi');
      const stage = stageNode.getBoundingClientRect();
      const box = (key) => {
        const r = document.querySelector(`[data-office-prop="${key}"]`).getBoundingClientRect();
        return { left: r.left - stage.left, top: r.top - stage.top, right: r.right - stage.left, bottom: r.bottom - stage.top };
      };
      // The table has no button, so its box is its world box through the stage's camera.
      const scale = Number(stageNode.dataset.officeCssScale);
      const x0 = Number(stageNode.dataset.officeOriginX) + Number(stageNode.dataset.officeCameraX);
      const y0 = Number(stageNode.dataset.officeOriginY) + Number(stageNode.dataset.officeCameraY);
      const [tx, ty, tw, th] = table;
      return {
        stage: { width: stage.width, height: stage.height }, scale, questions: box('questions'), review: box('review'), board: box('board'),
        table: { left: x0 + tx * scale, top: y0 + ty * scale, right: x0 + (tx + tw) * scale, bottom: y0 + (ty + th) * scale },
      };
    }, OBJECT_BOXES.table);
    const within = (b, margin = 0) => b.left >= margin && b.top >= margin && b.right <= boxes.stage.width - margin && b.bottom <= boxes.stage.height - margin;
    const shownShare = (b) => {
      const w = Math.max(0, Math.min(b.right, boxes.stage.width) - Math.max(b.left, 0));
      const h = Math.max(0, Math.min(b.bottom, boxes.stage.height) - Math.max(b.top, 0));
      return (w * h) / ((b.right - b.left) * (b.bottom - b.top));
    };
    check(closeTo(boxes.scale, 1), `${label}: desktop CSS scale is ${boxes.scale}, expected 1`);
    check(within(boxes.questions, 7.5) && within(boxes.review, 7.5), `${label}: the question note or folders are not 8 px inside the stage (${JSON.stringify(boxes)})`);
    check(!within(boxes.board) || !within(boxes.table), `${label}: the board and table unexpectedly fit at CSS scale 1 (${JSON.stringify(boxes)})`);
    console.log(`MEASURE ${label} stage ${boxes.stage.width.toFixed(1)}x${boxes.stage.height.toFixed(1)} at CSS scale ${boxes.scale.toFixed(4)}; whiteboard ${(shownShare(boxes.board) * 100).toFixed(0)}% and table ${(shownShare(boxes.table) * 100).toFixed(0)}% of their area in view`);
    // A drag brings the cropped whiteboard fully into the 1:1 desktop stage.
    const stageBox = await page.locator('.office-stage-pixi').boundingBox();
    assert.ok(stageBox, `${label}: stage has no box`);
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    const beforePan = await measure(page);
    const targetCameraX = boxes.stage.width / 2 - beforePan.originX - (OBJECT_BOXES.board[0] + OBJECT_BOXES.board[2] / 2) * boxes.scale;
    const targetCameraY = 8 - beforePan.originY - OBJECT_BOXES.board[1] * boxes.scale;
    const endX = stageBox.x + stageBox.width / 2 + targetCameraX - beforePan.cameraX;
    const endY = stageBox.y + stageBox.height / 2 + targetCameraY - beforePan.cameraY;
    check(endX >= stageBox.x && endX <= stageBox.x + stageBox.width && endY >= stageBox.y && endY <= stageBox.y + stageBox.height,
      `${label}: target drag point is outside the stage (${endX}, ${endY})`);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(({ x, y }) => {
      const stage = document.querySelector('.office-stage-pixi');
      return Number(stage?.dataset.officeCameraX) !== x || Number(stage?.dataset.officeCameraY) !== y;
    }, { x: beforePan.cameraX, y: beforePan.cameraY });
    const afterPan = await measure(page);
    const boardAfterDrag = await page.locator('[data-office-prop="board"]').boundingBox();
    check(afterPan.cameraX < beforePan.cameraX && boardAfterDrag
      && boardAfterDrag.x >= stageBox.x + 7.5 && boardAfterDrag.y >= stageBox.y + 7.5
      && boardAfterDrag.x + boardAfterDrag.width <= stageBox.x + stageBox.width - 7.5
      && boardAfterDrag.y + boardAfterDrag.height <= stageBox.y + stageBox.height - 7.5,
    `${label}: dragging did not bring the whiteboard fully into view (${JSON.stringify({ before: { x: beforePan.cameraX, y: beforePan.cameraY }, after: { x: afterPan.cameraX, y: afterPan.cameraY }, boardAfterDrag, stageBox })})`);
    console.log(`MEASURE ${label} drag moved the camera (${beforePan.cameraX},${beforePan.cameraY}) -> (${afterPan.cameraX},${afterPan.cameraY}) and brought the whiteboard fully in view`);
    const scrolled = [];
    for (const key of ['questions', 'review', 'board']) {
      await page.locator(`[data-office-prop="${key}"]`).focus();
      scrolled.push(await page.evaluate((prop) => {
        const stage = document.querySelector('.office-stage-pixi');
        return { key: prop, top: stage.scrollTop, left: stage.scrollLeft };
      }, key));
    }
    check(scrolled.every(({ top, left }) => top === 0 && left === 0), `${label}: focusing a room object scrolled the stage (${JSON.stringify(scrolled)})`);
    console.log(`MEASURE ${label} stage scroll after focusing each object ${JSON.stringify(scrolled)}`);
  }

  {
    const page = await open(viewports[0]);
    const stage = page.locator('.office-stage-pixi');
    const rect = await stage.boundingBox();
    assert.ok(rect, 'Resize fixture stage has no box');
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const beforeWheel = await measure(page);
    await page.mouse.wheel(-35, -14);
    await page.waitForFunction(({ cameraX, cameraY }) => {
      const stageNode = document.querySelector('.office-stage-pixi');
      return Number(stageNode?.dataset.officeCameraX) !== cameraX || Number(stageNode?.dataset.officeCameraY) !== cameraY;
    }, { cameraX: beforeWheel.cameraX, cameraY: beforeWheel.cameraY });
    const before = await measure(page);
    const centre = {
      x: (before.host.width / 2 - before.originX - before.cameraX) / before.cssScale,
      y: (before.host.height / 2 - before.originY - before.cameraY) / before.cssScale,
    };
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(({ height, cameraX, cameraY }) => {
      const host = document.querySelector('.office-pixi-canvas');
      const stage = document.querySelector('.office-stage-pixi');
      return !!host && !!stage && Math.abs(host.getBoundingClientRect().height - height) > 50
        && (Number(stage.dataset.officeCameraX) !== cameraX || Number(stage.dataset.officeCameraY) !== cameraY);
    }, { height: before.host.height, cameraX: before.cameraX, cameraY: before.cameraY });
    const after = await measure(page);
    const resizedCentre = {
      x: (after.host.width / 2 - after.originX - after.cameraX) / after.cssScale,
      y: (after.host.height / 2 - after.originY - after.cameraY) / after.cssScale,
    };
    check(Math.abs(after.host.height - before.host.height) > 50, 'Viewport resize did not change the measured stage height');
    // The world point at the box centre is kept, then moved by the same room-object shift a start gets (which, on a stage
    // zoomed out until the objects fill one axis, decides that axis outright).
    const expectedAfter = {
      x: expectedCamera(after.host.width / 2 - after.originX - centre.x * after.cssScale, 'x', after.host.width, after.originX, after.cssScale),
      y: expectedCamera(after.host.height / 2 - after.originY - centre.y * after.cssScale, 'y', after.host.height, after.originY, after.cssScale),
    };
    check(Math.abs(after.cameraX - expectedAfter.x) * after.dpr <= 0.51 && Math.abs(after.cameraY - expectedAfter.y) * after.dpr <= 0.51, `Resize did not preserve the world point at the box centre (${JSON.stringify({ before: { host: before.host, cameraX: before.cameraX, cameraY: before.cameraY, originX: before.originX, originY: before.originY, cssScale: before.cssScale }, after: { host: after.host, cameraX: after.cameraX, cameraY: after.cameraY, originX: after.originX, originY: after.originY, cssScale: after.cssScale }, centre, resizedCentre, expectedAfter })})`);
    console.log(`PASS resize keeps the centre world point, moved by the room-object shift: ${JSON.stringify(centre)} -> ${JSON.stringify(resizedCentre)}`);
  }

  {
    const page = await open(viewports[0]);
    const worker = page.locator('.office-pixi-char[data-agent-id="office-chat-dock-fixture"]');
    const box = await worker.boundingBox();
    assert.ok(box, 'Mouse drag fixture character has no hit box');
    const before = await measure(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 3, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction((x) => Number(document.querySelector('.office-stage-pixi')?.dataset.officeCameraX) !== x, before.cameraX);
    check(await page.locator('.detail').count() === 0, 'Mouse drag opened the character task pane');
    const afterDrag = await measure(page);
    check(afterDrag.cameraX > before.cameraX, `Mouse drag did not pan the world (${before.cameraX} -> ${afterDrag.cameraX})`);
    const tapBox = await worker.boundingBox();
    assert.ok(tapBox, 'Mouse tap fixture character has no hit box after the drag');
    await page.mouse.click(tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2);
    await page.getByRole('complementary', { name: 'Details of ov-3' }).waitFor();
    check(true, 'Mouse tap opened the character task pane');
    console.log(`PASS mouse drag pans without opening; tap opens the character pane at ${viewports[0].width}x${viewports[0].height}`);
  }

  {
    const page = await open(viewports[2]);
    const orchestrator = page.locator('.office-pixi-char[data-agent-id="office-chat-dock-orchestrator"]');
    const box = await orchestrator.boundingBox();
    assert.ok(box, 'Touch drag fixture character has no hit box');
    const before = await measure(page);
    const touch = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 14, y: y + 5 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction((cameraX) => Number(document.querySelector('.office-stage-pixi')?.dataset.officeCameraX) !== cameraX, before.cameraX);
    const after = await measure(page);
    check(after.cameraX > before.cameraX, `Touch drag did not pan the world (${before.cameraX} -> ${after.cameraX})`);
    check(await page.locator('.detail').count() === 0, 'Touch drag opened a character pane');
    console.log(`PASS touch drag pans without opening at ${viewports[2].width}x${viewports[2].height} dpr${viewports[2].dpr}`);
    await touch.detach();
  }

  if (failures.length) throw new Error(`${failures.length} layout checks failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  console.log(`Office Pixi browser checks: ${checks} passed`);
  console.log(`Evidence: ${evidenceDir}`);
} finally {
  for (const page of pages) await page.close();
  if (browser) await browser.close();
}
