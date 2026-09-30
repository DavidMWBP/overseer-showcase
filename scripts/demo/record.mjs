// Records the scripted demo as an MP4: Playwright drives every timeline step at 1920x1080 with a
// visible pointer, natural typing and a caption per step, then ffmpeg cuts frozen stretches and
// speeds up the captioned waits for workers.
//
//   node scripts/demo/record.mjs [--out <file.mp4>] [--from <work dir>]
//
// `--from` re-edits the raw recording of an earlier run (its work dir is printed) without recording again.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDemo } from './demo.mjs';

const WIDTH = 1920;
const HEIGHT = 1080;
const SPEED = 4;
// A stretch whose frames stay within this mean difference for FREEZE_MIN_S is cut down to HOLD_S,
// so no frame outside a captioned wait holds for 2 s.
// Looser than the 0.0001 used to check the output: VP8 noise in the raw recording hides some still frames.
const FREEZE_NOISE = 0.0003;
const FREEZE_MIN_S = 1.5;
const HOLD_S = 1.2;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outFile = path.resolve(argument('--out') ?? path.join(os.homedir(), '.overseer/evidence/demo/overseer-demo.mp4'));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
if (outFile.toLowerCase().startsWith(`${repoRoot.toLowerCase()}${path.sep}`)) throw new Error(`the video must be written outside the repository: ${outFile}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min, max) => min + Math.random() * (max - min);

// Draws a pointer that follows mouse events and a caption pill; headless video shows no system cursor.
function overlayScript() {
  if (document.getElementById('demo-overlay')) return;
  const root = document.createElement('div');
  root.id = 'demo-overlay';
  root.innerHTML = `
    <style>
      #demo-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: "Segoe UI", system-ui, sans-serif; }
      #demo-cursor { position: absolute; left: 0; top: 0; width: 28px; height: 28px; transform: translate(960px, 540px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
      #demo-ring { position: absolute; left: -18px; top: -18px; width: 36px; height: 36px; border-radius: 50%; border: 3px solid rgba(255, 196, 64, .9); opacity: 0; transform: scale(.4); transition: opacity .35s, transform .35s; }
      #demo-cursor.down #demo-ring { opacity: 1; transform: scale(1); transition: none; }
      #demo-caption { position: absolute; left: 50%; bottom: 160px; transform: translateX(-50%) translateY(12px); max-width: 1500px; padding: 16px 30px; border-radius: 16px;
        background: rgba(14, 17, 24, .88); color: #fff; font-size: 30px; font-weight: 600; line-height: 1.3; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.35);
        opacity: 0; transition: opacity .3s, transform .3s; }
      #demo-caption.shown { opacity: 1; transform: translateX(-50%) translateY(0); }
      #demo-caption .badge { display: inline-block; margin-left: 14px; padding: 2px 12px; border-radius: 10px; background: #ffc440; color: #14110a; font-size: 24px; vertical-align: 3px; }
    </style>
    <div id="demo-caption"></div>
    <div id="demo-cursor"><div id="demo-ring"></div>
      <svg width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 22 L8.5 17 L12.5 26 L16 24.5 L12 15.5 L19.5 15.5 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
    </div>`;
  document.body.appendChild(root);
  const cursor = root.querySelector('#demo-cursor');
  const caption = root.querySelector('#demo-caption');
  addEventListener('mousemove', (event) => { cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`; }, true);
  addEventListener('mousedown', () => cursor.classList.add('down'), true);
  addEventListener('mouseup', () => cursor.classList.remove('down'), true);
  window.__demoCaption = (text, badge) => {
    if (!text) { caption.classList.remove('shown'); return; }
    caption.textContent = text;
    if (badge) {
      const tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = badge;
      caption.appendChild(tag);
    }
    caption.classList.add('shown');
  };
}

function humanActions(getPage) {
  const pointer = { x: WIDTH / 2, y: HEIGHT / 2 };
  async function moveTo(x, y) {
    const page = getPage();
    const distance = Math.hypot(x - pointer.x, y - pointer.y);
    const steps = Math.max(18, Math.min(72, Math.round(distance / 10)));
    // A quadratic curve with a sideways control point, eased in and out, reads as a hand movement.
    const bend = between(-0.18, 0.18) * distance;
    const cx = (pointer.x + x) / 2 + (distance ? -(y - pointer.y) / distance * bend : 0);
    const cy = (pointer.y + y) / 2 + (distance ? (x - pointer.x) / distance * bend : 0);
    const from = { ...pointer };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const px = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * x;
      const py = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e ** 2 * y;
      await page.mouse.move(px, py);
      await sleep(16);
    }
    pointer.x = x;
    pointer.y = y;
  }
  async function pointAt(locator) {
    await locator.waitFor({ state: 'visible', timeout: 90_000 });
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error('the pointer target has no box');
    const position = {
      x: box.width / 2 + between(-0.15, 0.15) * Math.min(box.width, 80),
      y: box.height / 2 + between(-0.15, 0.15) * Math.min(box.height, 30),
    };
    await moveTo(box.x + position.x, box.y + position.y);
    await sleep(between(140, 260));
    return position;
  }
  async function click(locator) {
    const position = await pointAt(locator);
    await locator.click({ position });
    await sleep(between(250, 400));
  }
  async function type(locator, text) {
    await click(locator);
    const page = getPage();
    for (const character of text) {
      await page.keyboard.type(character);
      await sleep(/[.,!?]/.test(character) ? between(220, 360) : character === ' ' ? between(70, 140) : between(35, 80));
    }
    await sleep(450);
  }
  // Drifts the pointer to a few spots so a held view still reads as someone looking at it.
  async function glance(points, holdMs = 1100) {
    for (const [x, y] of points) {
      await moveTo(x, y);
      await sleep(holdMs);
    }
  }
  return { moveTo, pointAt, click, type, glance };
}

async function record(workDir) {
  const rawDir = path.join(workDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  let page = null;
  const human = humanActions(() => page);
  const demo = await startDemo({
    contextOptions: { viewport: { width: WIDTH, height: HEIGHT }, recordVideo: { dir: rawDir, size: { width: WIDTH, height: HEIGHT } } },
    actions: { click: human.click, type: human.type },
  });
  page = demo.page;
  const at = () => (Date.now() - demo.pageOpenedAt) / 1000;
  const marks = { start: 0, end: 0, sped: [] };
  const caption = async (text, badge) => { await page.evaluate(([value, tag]) => window.__demoCaption(value, tag), [text, badge]); };
  // Shows a captioned wait for workers: the stretch is sped up SPEED times in the edit.
  async function spedUp(text, run) {
    await caption(text, `${SPEED}x`);
    const start = at();
    const result = await run();
    marks.sped.push({ start, end: at(), text });
    return result;
  }
  const view = (name) => page.locator(`nav[aria-label="Views"] button[data-view="${name}"]`);
  const card = (title) => page.locator('.card').filter({ hasText: title }).first();
  const [grid, recipes, shopping] = demo.timeline.tasks.map((task) => task.title);
  // Opens a task card on the Board, lets the viewer read the pane, and closes it again.
  async function showCard(title, points) {
    await human.click(card(title));
    await page.locator('aside.detail[aria-busy="false"]').waitFor({ timeout: 30_000 });
    await human.glance(points, 1300);
    await human.click(page.getByRole('button', { name: 'Close details' }));
  }
  try {
    await page.evaluate(overlayScript);
    await human.click(view('office'));
    marks.start = at();
    await caption('Overseer: one chat that drives a team of coding agents');
    await human.glance([[693, 400], [1240, 480], [1013, 627], [800, 560]]);
    await caption('The Office shows every agent session as a character in the room');
    await human.glance([[1307, 400], [1093, 693], [853, 480]]);

    await human.click(view('chat'));
    await caption('1 · Ask for a feature in Chat');
    await demo.step('feature-request');
    await caption('The orchestrator reads the request and plans the work');

    await demo.step('batch-created');
    await caption('2 · It creates a batch of three tasks and starts two workers');
    await human.glance([[853, 227], [1200, 267], [1013, 320]], 1300);
    await human.click(view('board'));
    await caption('Board: two tasks run at once, the shopping list waits for the recipes');
    await human.glance([[560, 307], [853, 333], [1013, 387], [693, 440]], 1200);
    await caption('Open a card to see its description, branch and agent');
    await showCard(grid, [[1533, 267], [1600, 427], [1467, 587]]);

    await human.click(view('office'));
    await caption('3 · In the Office, each worker walks to a desk and starts typing');
    await demo.step('workers-running');
    await spedUp('Workers running', () => human.glance([[933, 507], [1173, 560], [1013, 613], [853, 533], [1100, 480], [960, 580]], 3400));

    await human.click(view('chat'));
    await caption('4 · A critic reviews each finished task');
    await spedUp('Worker finishing, critic reviewing', () => demo.step('review-finding'));
    await caption('The critic found a missing accessible name, so the grid goes back to a worker');
    await human.glance([[827, 347], [1200, 373], [1013, 427], [1307, 400]], 1300);
    await caption('Every step is logged in Chat, so you can scroll back through the run');
    await human.moveTo(1200, 560);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -60); await sleep(180); }
    await human.glance([[1000, 300], [1250, 340]], 1200);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 60); await sleep(140); }

    await caption('5 · The repaired weekly grid lands on the batch branch');
    await spedUp('Repair worker and critic running', () => demo.step('fix-lands'));
    await human.click(view('board'));
    await caption('Board: the weekly grid is done, the recipe cards are still running');
    await human.glance([[1667, 333], [1720, 387], [933, 347], [1013, 400]], 1200);
    await showCard(grid, [[1533, 267], [1573, 480], [1493, 667]]);

    await caption('6 · When every task has landed, the batch waits for your review');
    await spedUp('Remaining workers running', () => demo.step('batch-review'));
    await caption('Review: the batch note, the cost and every change in one place');
    await human.glance([[933, 147], [1307, 187], [1600, 147], [1120, 267]], 1200);
    await caption('Scroll the combined diff of all three tasks');
    await human.moveTo(1200, 640);
    for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 60); await sleep(170); }
    await human.glance([[1013, 693], [1333, 587]], 1200);
    for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, -60); await sleep(120); }

    await caption('7 · Merge the batch into main');
    await demo.step('merge');
    await human.glance([[853, 187], [1093, 213]], 1300);
    await human.click(view('board'));
    await caption('Merged: three tasks, one review finding fixed, one click to ship');
    await human.glance([[693, 307], [1013, 373], [1307, 333]], 1300);
    await showCard(grid, [[1533, 267], [1573, 480], [1493, 667]]);
    await human.click(view('office'));
    await caption('Overseer: local, scripted here with fictional data');
    await human.glance([[853, 507], [1147, 560], [960, 613]], 1300);
    await caption('');
    await sleep(600);
    marks.end = at();
    const video = page.video();
    await page.context().close();
    fs.copyFileSync(await video.path(), path.join(workDir, 'raw.webm'));
  } finally {
    const cleanup = await demo.close();
    if (cleanup.demoProcessesRemaining.length) console.error(`demo processes still running: ${cleanup.demoProcessesRemaining.join(', ')}`);
  }
  fs.writeFileSync(path.join(workDir, 'marks.json'), `${JSON.stringify(marks, null, 2)}\n`, 'utf8');
  return marks;
}

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed (${run.status}):\n${run.stderr.slice(-4000)}`);
  return run.stderr;
}

function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true }).trim());
}

// Frozen stretches of the raw recording, as [start, end] seconds.
function freezeIntervals(file) {
  const log = ffmpeg(['-i', file, '-vf', `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_S}`, '-map', '0:v', '-f', 'null', '-']);
  const starts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((match) => Number(match[1]));
  return starts.map((start, index) => [start, ends[index] ?? duration(file)]);
}

// Splits [marks.start, marks.end] into pieces with a speed each: captioned waits run SPEED times
// faster, and every frozen stretch keeps only HOLD_S of output time.
export function editList(marks, frozen) {
  const cuts = new Set([marks.start, marks.end]);
  for (const window of marks.sped) { cuts.add(window.start); cuts.add(window.end); }
  for (const [start, end] of frozen) { cuts.add(start); cuts.add(end); }
  const points = [...cuts].filter((value) => value >= marks.start && value <= marks.end).sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [start, end] = [points[i], points[i + 1]];
    if (end - start < 0.01) continue;
    const middle = (start + end) / 2;
    const sped = marks.sped.find((window) => middle >= window.start && middle < window.end);
    const speed = sped ? SPEED : 1;
    const frozenHere = frozen.some(([a, b]) => middle >= a && middle < b);
    const keep = frozenHere ? Math.min(end - start, HOLD_S * speed) : end - start;
    pieces.push({ start, end: start + keep, speed, caption: sped?.text ?? null });
  }
  return pieces;
}

function render(workDir, pieces) {
  const raw = path.join(workDir, 'raw.webm');
  const graph = [`[0:v]split=${pieces.length}${pieces.map((_, i) => `[s${i}]`).join('')}`];
  pieces.forEach((piece, i) => graph.push(`[s${i}]trim=start=${piece.start.toFixed(3)}:end=${piece.end.toFixed(3)},setpts=(PTS-STARTPTS)/${piece.speed}[p${i}]`));
  graph.push(`${pieces.map((_, i) => `[p${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0,fps=30,format=yuv420p[out]`);
  const script = path.join(workDir, 'edit.filter');
  fs.writeFileSync(script, graph.join(';\n'), 'utf8');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  ffmpeg(['-i', raw, '-/filter_complex', script, '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-movflags', '+faststart', '-an', outFile]);
  // Output-time windows of the captioned waits, for checking the freeze report against them.
  let clock = 0;
  const waits = [];
  for (const piece of pieces) {
    const length = (piece.end - piece.start) / piece.speed;
    if (piece.caption) {
      const last = waits.at(-1);
      if (last && last.caption === piece.caption && Math.abs(last.end - clock) < 0.001) last.end = clock + length;
      else waits.push({ caption: piece.caption, start: clock, end: clock + length });
    }
    clock += length;
  }
  fs.writeFileSync(path.join(path.dirname(outFile), 'captioned-waits.json'), `${JSON.stringify(waits, null, 2)}\n`, 'utf8');
  return waits;
}

function contactSheet() {
  const sheet = path.join(path.dirname(outFile), 'contact-sheet.png');
  const frames = Math.ceil(duration(outFile) / 5);
  ffmpeg(['-i', outFile, '-vf', `fps=1/5,scale=384:-1,tile=6x${Math.ceil(frames / 6)}:padding=4:color=white`, '-frames:v', '1', sheet]);
  return sheet;
}

const from = argument('--from');
const workDir = from ? path.resolve(from) : fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-demo-video-'));
console.log(`work dir: ${workDir}`);
const marks = from ? JSON.parse(fs.readFileSync(path.join(workDir, 'marks.json'), 'utf8')) : await record(workDir);
const frozen = freezeIntervals(path.join(workDir, 'raw.webm'));
const pieces = editList(marks, frozen);
const waits = render(workDir, pieces);
console.log(`raw: ${(marks.end - marks.start).toFixed(1)} s, ${frozen.length} frozen stretches, ${pieces.length} pieces`);
console.log(`captioned waits: ${waits.map((wait) => `${wait.caption} ${wait.start.toFixed(1)}-${wait.end.toFixed(1)} s`).join('; ')}`);
console.log(`video: ${outFile} (${duration(outFile).toFixed(1)} s)`);
console.log(`contact sheet: ${contactSheet()}`);
