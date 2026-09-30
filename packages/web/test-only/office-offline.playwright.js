import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(scriptDir);
const evidenceDir = process.env.OFFICE_OFFLINE_EVIDENCE_DIR
  ? path.resolve(process.env.OFFICE_OFFLINE_EVIDENCE_DIR)
  : await mkdtemp(path.join(os.tmpdir(), 'office-offline-'));
const capturePhase = process.env.OFFICE_OFFLINE_CAPTURE_PHASE ?? 'after';
await mkdir(evidenceDir, { recursive: true });

// No baseline size docks Chat beside the room's wide stage, so 2560x1080 runs too, where the dock rule holds.
const VIEWPORTS = [[2172, 1325], [1920, 1080], [1440, 900], [390, 844], [2560, 1080]];
/** The shell's online boxes, which the room does not set; the stage and dock are checked against their cap rule below. */
const ONLINE_BASELINE = {
  '2172x1325': {
    main: { x: 232, y: 0, width: 1940, height: 1325, bottom: 1325 },
    office: { x: 252, y: 89.5, width: 1900, height: 1219.5, bottom: 1309 },
  },
  '1920x1080': {
    main: { x: 232, y: 0, width: 1688, height: 1080, bottom: 1080 },
    office: { x: 252, y: 89.5, width: 1648, height: 974.5, bottom: 1064 },
  },
  '1440x900': {
    main: { x: 232, y: 0, width: 1208, height: 900, bottom: 900 },
    office: { x: 252, y: 89.5, width: 1168, height: 794.5, bottom: 884 },
  },
  '390x844': {
    main: { x: 0, y: 99, width: 390, height: 745, bottom: 844 },
    // Below 768 px the one-line count row under the stage adds its height to the Office box.
    office: { x: 12, y: 181, width: 366, height: 377.3, bottom: 558.3 },
  },
};
const repo = {
  id: 'r1', path: 'C:/office-offline-fixture', base_branch: 'main', verify_command: null, setup_command: null,
  merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2,
};
const responses = {
  '/api/repos': [repo],
  '/api/doctor': { tools: [], data_dir: { path: 'C:/office-offline-fixture-data', ok: true, problem: null } },
  '/api/settings/orchestrator': { model: null, effort: null, promptOverride: null },
  '/api/settings/tiers': { tiers: [], denyModels: [] },
  '/api/status': { bd_ok: true, orchestrator: { status: 'idle', native_session_id: null, last_activity_at: null, busy: false, model: null, context: null } },
  '/api/daemon': { pid: 1, started_at: '2026-09-24T00:00:00.000Z', commit: 'fixture', source_head: 'fixture', restart_needed: false },
  '/api/board': { bd_ok: true, repos: [{ repo, batches: [], cards: [] }] },
  '/api/chat': { rows: [], has_more: false, oldest_id: null },
  '/api/costs': { repos: [], batches: [] },
  '/api/plans': [],
  '/api/plans/all': [],
};
const sessions = [{
  session_id: 'office-offline-worker', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null,
  account_label: null, bead_id: 'ov-3', bead_title: 'Office layout fixture', batch_id: null, repo_id: 'r1',
  state: 'working', stalled_since: null,
}];

let server;
let baseUrl = process.env.OFFICE_OFFLINE_BASE_URL;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(webRoot, 'vite.config.ts'), root: webRoot,
    server: { host: '127.0.0.1', port: 5294, strictPort: true } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}
const port = new URL(baseUrl).port;
assert.ok(!['4400', '5173', '5174'].includes(port), `Refusing a reserved live port: ${port}`);

// The stage has the room's 1680x1056 world aspect, so its size and the dock that follows from it are checked against the
// cap rule: width = min(content, (Office height − 128) × aspect), and the dock shows only when the stage is at least
// 640 px wide and the content is at least 380 px wider than it.
const STAGE_ASPECT = 1680 / 1056;

let browser;
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const closeTo = (actual, expected, tolerance = 0.2) => Math.abs(actual - expected) <= tolerance;
const round = (value) => Math.round(value * 10) / 10;

try {
  browser = await chromium.launch({ headless: true });

  for (const [width, height] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let unreachable = false;
    let failedApiRequests = 0;
    let websocketConnections = 0;
    let refusedReconnects = 0;
    const unhandledApiRequests = [];
    const sockets = [];

    await page.route('**/api/**', async (route) => {
      if (unreachable) {
        failedApiRequests++;
        await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'fixture daemon unreachable' }) });
        return;
      }
      const pathname = new URL(route.request().url()).pathname;
      if (!Object.hasOwn(responses, pathname)) {
        unhandledApiRequests.push(`${route.request().method()} ${pathname}`);
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unhandled fixture route' }) });
        return;
      }
      const body = responses[pathname];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.routeWebSocket('**/api/events', async (socket) => {
      websocketConnections++;
      if (unreachable) {
        refusedReconnects++;
        await socket.close({ code: 1011, reason: 'fixture daemon unreachable' });
      } else {
        sockets.push(socket);
        socket.send(JSON.stringify({ type: 'office_snapshot', sessions }));
      }
    });

    await page.goto(`${baseUrl}/#office`);
    await page.locator('.office-stage').waitFor();
    await page.locator('.office-stage-pixi canvas').waitFor();
    // A phone names the character with `task` and `repository` fields, since its badge shows no text.
    await page.getByRole('button', { name: /^claude · sonnet · (ov-3$|task ov-3 · repository r1 )/ }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.banner-warn'));
    const online = await page.evaluate(() => {
      const box = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10 };
      };
      const main = document.querySelector('main');
      const dock = document.querySelector('.office-chat-dock');
      return {
        main: box(main), mainScrollHeight: main?.scrollHeight ?? -1, mainClientHeight: main?.clientHeight ?? -1,
        office: box(document.querySelector('.office')), stage: box(document.querySelector('.office-stage')),
        dock: box(dock), composer: box(dock?.querySelector('.composer')),
      };
    });
    console.log(`ONLINE ${width}x${height} ${JSON.stringify(online)}`);
    check(unhandledApiRequests.length === 0,
      `ONLINE ${width}x${height}: unhandled mocked API requests ${JSON.stringify(unhandledApiRequests)}`);
    const baseline = ONLINE_BASELINE[`${width}x${height}`];
    if (baseline) {
      // Below 768 px the Office box holds the stage, so it is not compared.
      for (const key of width < 768 ? ['main'] : ['main', 'office']) for (const edge of ['x', 'y', 'width', 'height', 'bottom']) {
        check(closeTo(online[key][edge], baseline[key][edge]), `ONLINE ${width}x${height}: ${key}.${edge} changed ${online[key][edge]} -> ${baseline[key][edge]}`);
      }
    }
    {
      const content = online.office.width;
      const cap = width < 768 ? content : Math.min(content, (online.office.height - 128) * STAGE_ASPECT);
      check(closeTo(online.stage.width, cap, 0.5), `ONLINE ${width}x${height}: stage width ${online.stage.width} is not its cap ${round(cap)}`);
      check(closeTo(online.stage.height, online.stage.width / STAGE_ASPECT, 0.5), `ONLINE ${width}x${height}: stage ${online.stage.width}x${online.stage.height} is not 1680:1056`);
      const docked = width >= 768 && online.stage.width >= 640 && content >= online.stage.width + 380;
      check((online.dock !== null) === docked, `ONLINE ${width}x${height}: dock ${online.dock ? 'shown' : 'hidden'} against the rule (${docked ? 'dock' : 'no dock'})`);
      if (online.dock) check(closeTo(online.dock.width, 400) && closeTo(online.dock.bottom, online.office.bottom), `ONLINE ${width}x${height}: dock ${JSON.stringify(online.dock)} is not the 400 px column down to the Office bottom`);
    }
    check(online.mainScrollHeight === online.mainClientHeight,
      `ONLINE ${width}x${height}: main scroll height ${online.mainScrollHeight} != client height ${online.mainClientHeight}`);

    unreachable = true;
    const activeSocket = sockets.at(-1);
    if (!activeSocket) throw new Error(`No open /api/events route at ${width}x${height}`);
    await Promise.all(sockets.map((socket) => socket.close({ code: 1011, reason: 'fixture daemon stopped' })));
    await page.locator('.banner-warn').waitFor({ timeout: 7000 });
    await page.waitForFunction(() => document.querySelector('.banner-warn')?.textContent?.includes('Daemon unreachable, retrying'), null, { timeout: 7000 });
    await page.locator('.office-unavailable').waitFor();
    // The timeout is fixed before polling; the loop work consumes part of the same bound.
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && (failedApiRequests === 0 || refusedReconnects === 0)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(failedApiRequests > 0, `OFFLINE ${width}x${height}: no mocked 502 response was requested`);
    check(refusedReconnects > 0, `OFFLINE ${width}x${height}: the event socket did not attempt a refused reconnect`);

    const offline = await page.evaluate(() => {
      const box = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10 };
      };
      const main = document.querySelector('main');
      const office = document.querySelector('.office');
      const stage = document.querySelector('.office-stage');
      const dock = document.querySelector('.office-chat-dock');
      const note = document.querySelector('.office-unavailable');
      const banner = document.querySelector('.banner-warn');
      return {
        viewportBottom: window.innerHeight, main: box(main), mainScrollHeight: main?.scrollHeight ?? -1,
        mainClientHeight: main?.clientHeight ?? -1, banner: box(banner), bannerMarginBottom: banner ? parseFloat(getComputedStyle(banner).marginBottom) : 0,
        office: box(office), stage: box(stage), note: box(note), dock: box(dock), composer: box(dock?.querySelector('.composer')),
        contentWidth: office?.getBoundingClientRect().width ?? 0,
      };
    });
    console.log(`OFFLINE ${width}x${height} ${JSON.stringify({ ...offline, failedApiRequests, websocketConnections, refusedReconnects })}`);

    if (process.env.OFFICE_OFFLINE_EVIDENCE_DIR) {
      const file = path.join(evidenceDir, `${capturePhase}-${width}x${height}.png`);
      await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
      console.log(`SCREENSHOT ${file}`);
    }

    check(offline.mainScrollHeight === offline.mainClientHeight,
      `OFFLINE ${width}x${height}: main scroll height ${offline.mainScrollHeight} != client height ${offline.mainClientHeight}`);
    check(offline.office && offline.office.bottom <= height + 0.5,
      `OFFLINE ${width}x${height}: Office bottom ${offline.office?.bottom} exceeds viewport bottom ${height}`);
    check(offline.stage && offline.stage.bottom <= height + 0.5 && offline.stage.bottom <= (offline.office?.bottom ?? -Infinity) + 0.5,
      `OFFLINE ${width}x${height}: stage bottom ${offline.stage?.bottom} exceeds Office or viewport`);
    if (offline.dock) check(offline.dock.bottom <= height + 0.5,
      `OFFLINE ${width}x${height}: Chat dock bottom ${offline.dock.bottom} exceeds viewport bottom ${height}`);
    check(offline.note && offline.stage && closeTo(offline.note.x, offline.stage.x),
      `OFFLINE ${width}x${height}: unavailable note is not left-aligned with the stage (${JSON.stringify({ note: offline.note, stage: offline.stage })})`);
    check(offline.note && offline.stage && offline.note.y >= offline.stage.bottom,
      `OFFLINE ${width}x${height}: unavailable note is not below the stage`);
    if (offline.note && offline.stage) {
      // The one-line count row and its spacing put the note 86 px below the stage.
      const expectedGap = offline.dock ? 58.5 : width < 768 ? 86 : 24;
      check(closeTo(offline.note.y - offline.stage.bottom, expectedGap, 0.5),
        `OFFLINE ${width}x${height}: note moved relative to the stage (${round(offline.note.y - offline.stage.bottom)} px, expected ${expectedGap} px)`);
    }
    if (offline.composer) check(offline.composer.bottom <= height + 0.5,
      `OFFLINE ${width}x${height}: composer bottom ${offline.composer.bottom} exceeds viewport bottom ${height}`);
    if (width >= 768) {
      const bannerHeight = (offline.banner?.height ?? 0) + offline.bannerMarginBottom;
      check(closeTo(online.stage.height - (offline.stage?.height ?? 0), bannerHeight, 0.5),
        `OFFLINE ${width}x${height}: stage shrank ${round(online.stage.height - (offline.stage?.height ?? 0))} px for a ${round(bannerHeight)} px banner`);
    }
    await page.close();
  }

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS office offline layout at ${VIEWPORTS.map(([width, height]) => `${width}x${height}`).join(', ')}`);
  }
} finally {
  await browser?.close();
  await server?.close();
}
