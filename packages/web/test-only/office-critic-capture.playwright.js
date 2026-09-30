// Captures the Office room for the office-critic skill (.claude/skills/office-critic/SKILL.md): desktop 1280x800 and
// phone 390x844, day (12:00) and night (23:00), device scale 1 and 2, plus 4x nearest-neighbour crops of a worker chair,
// a plant, the floor lamp, a glass post, the orchestrator desk and a character. It asserts only that every character
// draws from the PixelLab atlas (the canvas's `data-office-character-art`), never the `charCanvas` placeholder; the
// critic grades the PNGs. Usage: node test-only/office-critic-capture.playwright.js [out dir] [--scene=<name> ...]
// Scenes (default `default`): `default` one worker and the orchestrator working, `orch-idle` the orchestrator seated
// but not typing, `no-workers` the orchestrator alone, `workers-12` every pod desk taken; each other scene's files carry
// its name as a prefix.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(scriptDir);
const repoRoot = path.resolve(webRoot, '..', '..');

const args = process.argv.slice(2).filter((value) => value !== '--');
const arg = args.find((value) => !value.startsWith('--scene='));
const SCENES = {
  default: { query: '', characters: 2 },
  'orch-idle': { query: '&orch=idle', characters: 2 },
  'no-workers': { query: '&workers=0', characters: 1 },
  'workers-12': { query: '&workers=12', characters: 13 },
};
const scenes = args.filter((value) => value.startsWith('--scene=')).map((value) => value.slice('--scene='.length));
if (scenes.length === 0) scenes.push('default');
for (const scene of scenes) assert.ok(scene in SCENES, `Unknown scene ${scene}; known: ${Object.keys(SCENES).join(', ')}`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(arg ?? path.join(os.tmpdir(), 'office-critic', stamp));
const relative = path.relative(repoRoot, outDir);
assert.ok(relative.startsWith('..') || path.isAbsolute(relative), `Refusing an output directory inside the repository: ${outDir}`);
await mkdir(outDir, { recursive: true });

// 5298: no other test-only script uses it (5291, 5293, 5294 and 5297 are taken; the rest bind port 0).
const PORT = 5298;
assert.ok(![4400, 5173, 5174].includes(PORT), `Refusing a reserved live port: ${PORT}`);

const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }];
const TIMES = [{ name: 'day', hour: 12, share: '0' }, { name: 'night', hour: 23, share: '1' }];
const SCALES = [1, 2];
const ZOOM = 4;

const server = await createServer({ configFile: path.join(webRoot, 'vite.config.ts'), root: webRoot, logLevel: 'error',
  server: { host: '127.0.0.1', port: PORT, strictPort: true } });
await server.listen();
const baseUrl = `http://127.0.0.1:${PORT}`;

const written = [];
const skipped = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const scratch = await browser.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });

  /** Nearest-neighbour upscale in a scratch page, so each art pixel becomes a ZOOM x ZOOM block with no smoothing. */
  const upscale = (png) => scratch.evaluate(async ({ base64, zoom }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width * zoom;
    canvas.height = image.height * zoom;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { base64: png.toString('base64'), zoom: ZOOM });

  const save = async (name, buffer) => {
    const file = path.join(outDir, name);
    await writeFile(file, buffer);
    written.push(name);
  };

  for (const sceneName of scenes) {
    const scene = SCENES[sceneName];
    for (const viewport of VIEWPORTS) {
      for (const scale of SCALES) {
        const mobile = viewport.name === 'phone';
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: scale, hasTouch: mobile, isMobile: mobile });
        // Reduced motion gives settled poses: no walk-in, fades or hops mid-frame.
        page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
        page.on('console', (message) => { if (message.type() === 'error') console.error(`console: ${message.text()}`); });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        // items=3: three questions, three folders in review and three notes per whiteboard column, and no Needs rows.
        await page.goto(`${baseUrl}/test-only/office-chat-dock.html?items=3${scene.query}`);
        await page.locator('.office-stage-pixi canvas').waitFor();
        for (const time of TIMES) {
          await page.evaluate((hour) => window.__officeChatDockSetHour(hour), time.hour);
          // Settled: the scene drew this hour's night share, every character has its button (reduced motion snaps them to
          // their desks), the room props are drawn and the stage has its scale; then two frames so the canvas holds that draw.
          await page.waitForFunction(({ share, characters }) => {
            const canvas = document.querySelector('.office-stage-pixi canvas');
            const stage = document.querySelector('.office-stage-pixi');
            return canvas?.dataset.officeNightShare === share && stage.querySelectorAll('button[data-agent-id]').length === characters
              && canvas.dataset.officeRoomProps?.startsWith('questions=3') && !!stage?.dataset.officePixelScale;
          }, { share: time.share, characters: scene.characters }).catch(async (error) => {
            const state = await page.evaluate(() => ({ canvas: { ...document.querySelector('.office-stage-pixi canvas')?.dataset }, stage: { ...document.querySelector('.office-stage-pixi')?.dataset } }));
            throw new Error(`${sceneName} ${viewport.name} dpr${scale} ${time.name}: the stage never settled: ${JSON.stringify(state)}`, { cause: error });
          });
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          // Never grade the `charCanvas` placeholder: every character must draw from the PixelLab atlas, as in the app.
          const art = (await page.evaluate(() => document.querySelector('.office-stage-pixi canvas').dataset.officeCharacterArt ?? '')).split(' ').filter(Boolean);
          assert.equal(art.length, scene.characters, `${sceneName} ${viewport.name} dpr${scale} ${time.name}: character art ${JSON.stringify(art)}`);
          const placeholders = art.filter((entry) => !entry.endsWith(':atlas'));
          assert.deepEqual(placeholders, [], `${sceneName} ${viewport.name} dpr${scale} ${time.name}: characters drawn from the charCanvas placeholder, not the atlas`);
          const label = `${sceneName === 'default' ? '' : `${sceneName}-`}${viewport.name}-${viewport.width}x${viewport.height}-${time.name}-dpr${scale}`;
          await save(`${label}.png`, await page.screenshot());

          // Crop boxes: world anchors from the real layout modules (served by Vite), projected with the stage's own
          // origin, camera and scale; the character's box is its button's.
          const crops = await page.evaluate(async () => {
            const world = await import('/src/office/pixi/world.ts');
            const furniture = await import('/src/office/pixi/furniture.ts');
            const stage = document.querySelector('.office-stage-pixi');
            const host = stage.querySelector('.office-pixi-canvas');
            const hostRect = host.getBoundingClientRect();
            const stageRect = stage.getBoundingClientRect();
            const k = Number(stage.dataset.officeCssScale);
            const ox = hostRect.left + Number(stage.dataset.officeOriginX) + Number(stage.dataset.officeCameraX);
            const oy = hostRect.top + Number(stage.dataset.officeOriginY) + Number(stage.dataset.officeCameraY);
            const view = { left: Math.max(0, stageRect.left), top: Math.max(0, stageRect.top), right: Math.min(innerWidth, stageRect.right), bottom: Math.min(innerHeight, stageRect.bottom) };
            /** A world-pixel box [dx, dy, w, h] about a floor point, in CSS px. */
            const boxAt = ([i, j], [dx, dy, w, h]) => {
              const [x, y] = world.p(i, j);
              return { left: ox + (x + dx) * k, top: oy + (y + dy) * k, width: w * k, height: h * k };
            };
            const centre = (f) => [f.i + f.w / 2, f.j + f.d / 2];
            // The fixture's one worker takes the first free desk, desk-1; the empty chairs are tried from the last desk back.
            const chairs = world.SPOTS.filter((spot) => spot.zone === 'run' && spot.id !== 'desk-1').reverse().map((spot) => furniture.chairPoint(spot)).map((c) => [c.x, c.y]);
            const byKind = (kind) => world.FURN.filter((f) => f.kind === kind).map(centre);
            const candidates = {
              'worker-chair': chairs.map((at) => boxAt(at, [-32, -72, 64, 84])),
              plant: byKind('plant-monstera').map((at) => boxAt(at, [-40, -112, 80, 124])),
              'floor-lamp': byKind('lamp-floor').map((at) => boxAt(at, [-26, -112, 52, 124])),
              'glass-post': world.GLASS_POSTS.map(centre).map((at) => boxAt(at, [-24, -150, 48, 164])),
              'orchestrator-desk': byKind('desk-orch').map((at) => boxAt(at, [-112, -120, 224, 160])),
              character: [...stage.querySelectorAll('button[data-agent-id]')].filter((b) => b.dataset.agentId === 'office-chat-dock-fixture').map((button) => {
                const r = button.getBoundingClientRect();
                return { left: r.left - 8, top: r.top - 8, width: r.width + 16, height: r.height + 16 };
              }),
            };
            /** The first candidate at least half inside the visible stage, clipped to it. */
            return Object.fromEntries(Object.entries(candidates).map(([name, boxes]) => {
              for (const box of boxes) {
                const left = Math.max(box.left, view.left);
                const top = Math.max(box.top, view.top);
                const right = Math.min(box.left + box.width, view.right);
                const bottom = Math.min(box.top + box.height, view.bottom);
                if (right <= left || bottom <= top) continue;
                if ((right - left) * (bottom - top) < 0.5 * box.width * box.height) continue;
                return [name, { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right) - Math.floor(left), height: Math.ceil(bottom) - Math.floor(top) }];
              }
              return [name, null];
            }));
          });
          for (const [name, clip] of Object.entries(crops)) {
            if (!clip) {
              skipped.push(`${label}-crop-${name}: not in the first view`);
              continue;
            }
            const png = await page.screenshot({ clip });
            await save(`${label}-crop-${name}-x${ZOOM}.png`, Buffer.from(await upscale(png), 'base64'));
          }
        }
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ written, skipped }, null, 2));
console.log(`Office critic captures in ${outDir}`);
for (const name of written) console.log(`  ${name}`);
for (const line of skipped) console.log(`  skipped ${line}`);
console.log(`${written.length} PNG files written, ${skipped.length} crops skipped`);
