import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(demoDir, '../..');
const daemonPackage = path.join(projectRoot, 'packages/daemon/package.json');
const webPackage = path.join(projectRoot, 'packages/web/package.json');
const daemonRequire = createRequire(daemonPackage);
const webRequire = createRequire(webPackage);
const tsxPackagePath = daemonRequire.resolve('tsx/package.json');
const vitePackagePath = webRequire.resolve('vite/package.json');
const tsxCli = path.resolve(path.dirname(tsxPackagePath), JSON.parse(fs.readFileSync(tsxPackagePath, 'utf8')).bin);
const viteBin = path.resolve(path.dirname(vitePackagePath), JSON.parse(fs.readFileSync(vitePackagePath, 'utf8')).bin.vite);
const { chromium } = webRequire('playwright');
const timeline = JSON.parse(fs.readFileSync(path.join(demoDir, 'timeline.json'), 'utf8'));
const DEMO_WAIT_MS = 90_000;

function remember(line, logPath, lines) {
  lines.push(line);
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function childProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { child, tail: [], waiters: [], ended: null };
  const lineStream = (stream, source) => {
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', (value) => {
      const line = `${source}: ${value}`;
      state.tail.push(line);
      if (state.tail.length > 120) state.tail.shift();
      for (const waiter of [...state.waiters]) {
        if (!waiter.match(value)) continue;
        state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
    });
  };
  lineStream(child.stdout, 'stdout');
  lineStream(child.stderr, 'stderr');
  state.ended = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.once('error', (error) => {
    state.spawnError = error;
    for (const waiter of [...state.waiters]) {
      state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return state;
}

function waitForLine(state, match, description, timeoutMs = 60_000) {
  const found = state.tail.find((line) => match(line.slice(line.indexOf(': ') + 2)));
  if (found) return Promise.resolve(found.slice(found.indexOf(': ') + 2));
  if (state.spawnError) return Promise.reject(state.spawnError);
  if (state.child.exitCode !== null) return Promise.reject(new Error(`${description}: process exited early (${state.child.exitCode})\n${state.tail.join('\n')}`));
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
      reject(new Error(`${description}: timed out waiting for process output\n${state.tail.join('\n')}`));
    }, timeoutMs);
    state.waiters.push(waiter);
    state.ended.then(({ code, signal }) => {
      if (!state.waiters.includes(waiter)) return;
      state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
      clearTimeout(waiter.timer);
      reject(new Error(`${description}: process exited (${code ?? signal}) before becoming ready\n${state.tail.join('\n')}`));
    });
  });
}

function jsonRequest(url, method = 'GET', body) {
  return fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }).then(async (response) => {
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(`${method} ${url} failed with HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    return data;
  });
}

function createRepository(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.cpSync(path.join(demoDir, 'fixtures/repo'), repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['add', '--', '.'], { cwd: repoPath, stdio: 'pipe', windowsHide: true });
  execFileSync('git', [
    '-c', 'user.name=Rowan Finch',
    '-c', 'user.email=rowan.finch@example.invalid',
    'commit', '-m', 'chore: initialize fictional pantry app', '--no-gpg-sign',
  ], { cwd: repoPath, stdio: 'pipe', windowsHide: true });
}

function copyFakeHarness(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  fs.copyFileSync(path.join(demoDir, 'fake-harness.js'), path.join(binDir, 'fake-harness.js'));
  fs.copyFileSync(path.join(demoDir, 'timeline.json'), path.join(binDir, 'timeline.json'));
  fs.cpSync(path.join(demoDir, 'fixtures'), path.join(binDir, 'fixtures'), { recursive: true });
  if (process.platform === 'win32') {
    const shim = path.join(binDir, 'claude.cmd');
    fs.writeFileSync(shim, '@node "%dp0%\\fake-harness.js" %*\r\n', 'utf8');
    return shim;
  }
  const shim = path.join(binDir, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'fake-harness.js')}" "$@"\n`, { mode: 0o755 });
  return shim;
}

async function waitForLocator(locator, description, timeoutMs = DEMO_WAIT_MS) {
  try { await locator.waitFor({ state: 'visible', timeout: timeoutMs }); }
  catch (error) { throw new Error(`${description}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function clickView(page, name, click) {
  const tab = page.locator(`nav[aria-label="Views"] button[data-view="${name}"]`);
  await waitForLocator(tab, `${name} view tab`);
  await click(tab);
}

async function isAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function stopPid(pid) {
  if (!await isAlive(pid)) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 }); }
    catch { /* The process may have exited between the liveness check and taskkill. */ }
  } else {
    try { process.kill(-pid, 'SIGTERM'); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      try { process.kill(pid, 'SIGTERM'); } catch { /* The process may already be gone. */ }
    }
  }
}

async function waitChildExit(state, timeoutMs = 15_000) {
  if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
  await Promise.race([
    state.ended,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function readPids(pidDir, pids) {
  if (!fs.existsSync(pidDir)) return;
  for (const filename of fs.readdirSync(pidDir)) {
    if (!filename.endsWith('.json')) continue;
    try {
      const item = JSON.parse(fs.readFileSync(path.join(pidDir, filename), 'utf8'));
      if (Number.isInteger(item.pid)) pids.set(item.pid, `${item.role}${item.beadId ? `:${item.beadId}` : ''}`);
    } catch { /* A harness can exit while its pid file is being read. */ }
  }
}

function observedOfficeScript() {
  window.__demoOfficePoses = {};
  const observe = (canvas) => {
    const art = canvas.dataset.officeCharacterArt ?? '';
    for (const entry of art.split(/\s+/).filter(Boolean)) {
      const match = /^([^=]+)=([^:]+):/.exec(entry);
      if (!match) continue;
      const animation = match[2].split('/')[1];
      const previous = window.__demoOfficePoses[match[1]] ?? { walk: false, type: false };
      window.__demoOfficePoses[match[1]] = {
        walk: previous.walk || animation === 'walk',
        type: previous.type || animation === 'type',
      };
    }
  };
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'attributes' && change.target instanceof HTMLCanvasElement) observe(change.target);
      for (const node of change.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLCanvasElement) observe(node);
        for (const canvas of node.querySelectorAll?.('canvas[data-office-character-art]') ?? []) observe(canvas);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-office-character-art'] });
}

// `contextOptions` extends the browser context (a recorder passes its viewport and recordVideo);
// `actions` replaces how a step clicks and types, so a recorder can move the pointer and type like a person.
export async function startDemo({ headless = true, contextOptions = {}, actions = {} } = {}) {
  const act = {
    click: (locator) => locator.click(),
    type: (locator, text) => locator.pressSequentially(text, { delay: 8 }),
    ...actions,
  };
  const runId = randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-demo-1997-'));
  const runLog = path.join(os.tmpdir(), `overseer-demo-1997-${runId}.log`);
  const dataDir = path.join(root, 'data');
  const repoPath = path.join(root, 'repo');
  const controlDir = path.join(root, 'control');
  const gateDir = path.join(controlDir, 'gates');
  const pidDir = path.join(controlDir, 'pids');
  const liveDataDir = path.resolve(os.homedir(), '.overseer');
  const logLines = [];
  const pids = new Map();
  let daemonState;
  let webState;
  let browser;
  let page;
  let currentStep = 0;
  let cleanupResult;
  let closed = false;
  let batchId = null;
  let daemonPort;
  let webPort;
  let daemonUrl;
  let webUrl;
  let workerIds = [];

  fs.writeFileSync(runLog, '', 'utf8');
  const log = (line) => remember(line, runLog, logLines);
  const demo = {
    timeline,
    port: null,
    webPort: null,
    dataDir,
    liveDataDir,
    repoPath,
    runLog,
    page: null,
    async step(name) {
      if (closed) throw new Error('the demo has already been closed');
      const expected = timeline.steps[currentStep];
      if (name !== expected) throw new Error(`timeline step ${currentStep + 1} must be ${expected}, received ${name}`);
      currentStep++;
      log(`timeline step started: ${name}`);

      if (name === 'feature-request') {
        const composer = page.getByRole('textbox', { name: 'Message the orchestrator' });
        const repoSelect = page.getByLabel('Repo');
        if (await repoSelect.count()) await repoSelect.selectOption(timeline.repo.id);
        await act.type(composer, timeline.request.text);
        await act.click(page.getByRole('button', { name: 'Send', exact: true }));
        await waitForLocator(page.getByRole('log', { name: 'Conversation' }).getByText(timeline.request.text, { exact: false }), 'user request in Chat');
        return readState();
      }

      if (name === 'batch-created') {
        await waitForLocator(page.getByRole('log', { name: 'Conversation' }).getByText(timeline.reply, { exact: true }), 'scripted orchestrator reply');
        const state = await readState();
        batchId = state.batch.id;
        return state;
      }

      if (name === 'workers-running') {
        await clickView(page, 'office', act.click);
        const stateBefore = await readState();
        workerIds = stateBefore.sessions.filter((session) => session.role === 'worker' && session.status === 'running').map((session) => session.id);
        if (workerIds.length !== 2) throw new Error(`expected two running worker sessions, found ${workerIds.length}`);
        await page.waitForFunction((ids) => ids.every((id) => window.__demoOfficePoses?.[id]?.walk), workerIds, { polling: 100, timeout: DEMO_WAIT_MS });
        const initialTasks = stateBefore.batch.tasks.filter((task) => task.column === 'running');
        await Promise.all(initialTasks.map((task) => createGate(`type-${task.id}-1`)));
        await page.waitForFunction((ids) => ids.every((id) => window.__demoOfficePoses?.[id]?.type), workerIds, { polling: 100, timeout: DEMO_WAIT_MS });
        const office = await page.evaluate((ids) => ({
          visibleCharacterCount: ids.filter((id) => !!window.__demoOfficePoses?.[id]).length,
          walkingCharacterCount: ids.filter((id) => window.__demoOfficePoses?.[id]?.walk).length,
          typingCharacterCount: ids.filter((id) => window.__demoOfficePoses?.[id]?.type).length,
        }), workerIds);
        return { ...await readState(), office };
      }

      if (name === 'review-finding') {
        await clickView(page, 'chat', act.click);
        const initial = await readState();
        const firstTask = initial.batch.tasks.find((task) => task.title === timeline.tasks[0].title);
        if (!firstTask) throw new Error('weekly grid task card is missing before its review');
        await createGate(`worker-${firstTask.id}-1`);
        const notice = page.getByRole('log', { name: 'Conversation' }).getByText(/review round 1 of \d+ .* found issues; re-dispatched/i);
        await waitForLocator(notice, 'critic finding and automatic re-dispatch notice');
        const state = await readState();
        const repaired = state.batch.tasks.find((task) => task.title === timeline.tasks[0].title);
        state.chat.reviewNotice = state.chat.rows.find((row) => /review round 1 of \d+ .* found issues; re-dispatched/i.test(row.text))?.text ?? '';
        if (!repaired || repaired.workerAttempts !== 2 || repaired.status !== 'in_progress') throw new Error(`review re-dispatch did not start: ${JSON.stringify(repaired)}`);
        await clickView(page, 'office', act.click);
        const retrySession = state.sessions.filter((session) => session.role === 'worker' && session.bead_id === repaired.id && session.status === 'running').at(-1);
        if (!retrySession) throw new Error('repair worker session is missing from Office');
        await page.waitForFunction((id) => window.__demoOfficePoses?.[id]?.walk, retrySession.id, { polling: 100, timeout: DEMO_WAIT_MS });
        await createGate(`type-${repaired.id}-2`);
        await page.waitForFunction((id) => window.__demoOfficePoses?.[id]?.type, retrySession.id, { polling: 100, timeout: DEMO_WAIT_MS });
        await clickView(page, 'chat', act.click);
        return state;
      }

      if (name === 'fix-lands') {
        const state = await readState();
        const firstTask = state.batch.tasks.find((task) => task.title === timeline.tasks[0].title);
        if (!firstTask) throw new Error('weekly grid task card is missing before its repair');
        await createGate(`worker-${firstTask.id}-2`);
        const landedNotice = page.getByRole('log', { name: 'Conversation' }).getByText(`landed on ${state.batch.branch}`, { exact: false });
        await waitForLocator(landedNotice, 'repaired weekly grid landing notice');
        return readState();
      }

      if (name === 'batch-review') {
        await clickView(page, 'chat', act.click);
        const state = await readState();
        const recipeTask = state.batch.tasks.find((task) => task.title === timeline.tasks[1].title);
        const shoppingTask = state.batch.tasks.find((task) => task.title === timeline.tasks[2].title);
        if (!recipeTask || !shoppingTask) throw new Error('one of the remaining task cards is missing');
        await Promise.all([
          createGate(`worker-${recipeTask.id}-1`),
          createGate(`worker-${shoppingTask.id}-1`),
        ]);
        const started = page.getByRole('log', { name: 'Conversation' }).getByText('The weekly grid and recipe cards are on the batch branch. I’m starting the grouped shopping list now.', { exact: true });
        await waitForLocator(started, 'dispatch of the dependency task');
        await createGate(`type-${shoppingTask.id}-1`);
        const ready = page.getByRole('log', { name: 'Conversation' }).getByText('All three tasks have landed. The batch is ready for your review and merge.', { exact: true });
        await waitForLocator(ready, 'scripted orchestrator review hand-off');
        await clickView(page, 'review', act.click);
        const row = page.getByRole('button', { name: new RegExp(timeline.batchTitle, 'i') });
        await waitForLocator(row, 'batch review row');
        await act.click(row);
        const note = page.locator('.review-detail .review-note').filter({ hasText: timeline.reviewNote });
        await waitForLocator(note, 'batch review note');
        const costText = await page.locator('.review-detail .review-head').innerText();
        const visibleCost = costText.match(/\$[\d,]+\.\d{2}/)?.[0] ?? '';
        return { ...await readState(), ui: { reviewNoteVisible: true, reviewCostText: visibleCost } };
      }

      if (name === 'merge') {
        const merge = page.locator('.review-actions').getByRole('button', { name: 'Merge', exact: true });
        await waitForLocator(merge, 'batch Merge action');
        await act.click(merge);
        await waitForLocator(page.getByRole('button', { name: 'Confirm merge', exact: true }), 'merge confirmation');
        await act.click(page.getByRole('button', { name: 'Confirm merge', exact: true }));
        await waitForLocator(page.getByText(`Batch ${batchId} merged into ${timeline.baseBranch}.`, { exact: true }), 'batch merge acknowledgement');
        const state = await readState();
        const changed = execFileSync('git', ['diff', '--name-only', `${state.batch.mergedCommit}^1`, state.batch.mergedCommit], { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();
        const weeklyPlan = fs.readFileSync(path.join(repoPath, timeline.tasks[0].file), 'utf8');
        state.git = { baseBranch: timeline.baseBranch, mergedFiles: changed ? changed.split(/\r?\n/) : [], repairedControlNamed: weeklyPlan.includes('aria-label="Previous week"') };
        return state;
      }
      throw new Error(`unknown timeline step ${name}`);
    },
    async close() {
      if (cleanupResult) return cleanupResult;
      if (closed) return cleanupResult;
      closed = true;
      try { await browser?.close(); } catch { /* The browser can already be closed after a failing step. */ }
      if (daemonState && daemonState.child.exitCode === null) {
        try {
          const sessions = await jsonRequest(`${daemonUrl}/api/sessions`);
          for (const session of sessions) if (session.pid) pids.set(session.pid, `${session.role}${session.bead_id ? `:${session.bead_id}` : ''}`);
        } catch { /* A failed startup may not have reached the session API. */ }
      }
      readPids(pidDir, pids);
      if (webState?.child.pid) pids.set(webState.child.pid, 'web app');
      if (daemonState?.child.pid) pids.set(daemonState.child.pid, 'daemon');
      const checked = [...pids].map(([pid, source]) => ({ pid, source }));
      for (const { pid } of checked) await stopPid(pid);
      await waitChildExit(webState);
      await waitChildExit(daemonState);
      for (const { pid } of checked) {
        if (await isAlive(pid)) await stopPid(pid);
      }
      const checkedProcesses = [];
      for (const item of checked) checkedProcesses.push({ ...item, alive: await isAlive(item.pid) });
      const demoProcessesRemaining = checkedProcesses.filter((item) => item.alive).map((item) => `${item.source} (pid ${item.pid})`);
      let tempDirRemoved = false;
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); tempDirRemoved = !fs.existsSync(root); }
      catch (error) { log(`temp cleanup error: ${error instanceof Error ? error.message : String(error)}`); }
      const notLive = daemonPort !== 4400 && webPort !== 5173 && webPort !== 5174 && webPort !== 4400
        && path.resolve(dataDir).toLowerCase() !== liveDataDir.toLowerCase();
      log(`checked demo processes: ${checkedProcesses.map((item) => `${item.pid} ${item.source} ${item.alive ? 'alive' : 'exited'}`).join('; ') || 'none recorded'}`);
      log(`demo processes remaining: ${demoProcessesRemaining.length ? demoProcessesRemaining.join('; ') : 'none'}`);
      log(`temporary directory removed: ${tempDirRemoved ? 'PASS' : 'FAIL'}`);
      log(`not-live assertions: ${notLive ? 'PASS' : 'FAIL'} (daemon port ${daemonPort}, web port ${webPort}, data dir ${dataDir})`);
      log(`run log: ${runLog}`);
      cleanupResult = {
        checkedProcesses,
        demoProcessesRemaining,
        tempDirRemoved,
        dataDirRemoved: !fs.existsSync(dataDir),
        repoDirRemoved: !fs.existsSync(repoPath),
        port: daemonPort,
        webPort,
        dataDir,
        liveDataDir,
        runLog: fs.readFileSync(runLog, 'utf8'),
        runLogPath: runLog,
      };
      return cleanupResult;
    },
  };

  async function api(route, method = 'GET', body) {
    return jsonRequest(new URL(route, daemonUrl), method, body);
  }

  async function createGate(name) {
    const gate = path.join(gateDir, name);
    fs.writeFileSync(gate, 'released\n', 'utf8');
    log(`released timeline gate: ${name}`);
  }

  async function readState() {
    const [board, chat, sessions] = await Promise.all([api('/api/board'), api('/api/chat'), api('/api/sessions')]);
    const repoBoard = board.repos.find((repo) => repo.repo.id === timeline.repo.id);
    const summaries = repoBoard?.batches ?? [];
    const summary = summaries.find((item) => item.title === timeline.batchTitle) ?? null;
    const cards = summary ? (repoBoard?.cards ?? []).filter((card) => card.batch_id === summary.id) : [];
    const tasks = cards.map((card) => ({
      id: card.bead.id,
      title: card.bead.title,
      status: card.bead.status,
      column: card.column,
      state: card.state,
      workerAttempts: sessions.filter((session) => session.role === 'worker' && session.bead_id === card.bead.id).length,
    }));
    const rows = chat.rows ?? [];
    const lastUser = rows.filter((row) => row.role === 'user').at(-1);
    const lastAssistant = rows.filter((row) => row.role === 'assistant').at(-1);
    const reviewNotice = rows.find((row) => /review round 1 of \d+ .* found issues; re-dispatched/i.test(row.text))?.text ?? '';
    const stripRepoTag = (text) => text?.replace(/^\[repo: [^\]]+\] /, '') ?? null;
    const base = {
      userText: stripRepoTag(lastUser?.text),
      assistantText: lastAssistant?.text ?? '',
      reviewNotice,
      rows,
    };
    const snapshot = {
      chat: base,
      batch: summary ? {
        id: summary.id,
        title: summary.title,
        branch: summary.branch,
        baseBranch: summary.base_branch,
        status: summary.status,
        note: summary.note,
        cost: summary.cost,
        mergedCommit: summary.merged_commit,
        taskTitles: tasks.map((task) => task.title),
        tasks,
      } : { id: null, title: null, branch: null, baseBranch: timeline.baseBranch, status: null, note: null, cost: 0, mergedCommit: null, taskTitles: [], tasks },
      sessions,
    };
    log(`timeline state: batch=${snapshot.batch.status ?? 'not-created'}; tasks=${tasks.map((task) => `${task.title}:${task.column}/${task.status}/workers-${task.workerAttempts}`).join(', ') || 'none'}; cost=$${Number(snapshot.batch.cost ?? 0).toFixed(2)}`);
    return snapshot;
  }

  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(gateDir, { recursive: true });
    fs.mkdirSync(pidDir, { recursive: true });
    const priceCache = path.join(dataDir, 'models.dev.json');
    fs.writeFileSync(priceCache, '{}\n', 'utf8');
    createRepository(repoPath);
    const fakeCli = copyFakeHarness(path.join(root, 'bin'));
    [daemonPort, webPort] = await Promise.all([freePort(), freePort()]);
    if (daemonPort === webPort) webPort = await freePort();
    demo.port = daemonPort;
    demo.webPort = webPort;
    daemonUrl = `http://127.0.0.1:${daemonPort}`;
    webUrl = `http://127.0.0.1:${webPort}`;
    demo.webUrl = `${webUrl}/#chat`;
    const livePortSafe = daemonPort !== 4400 && webPort !== 4400 && webPort !== 5173 && webPort !== 5174 && daemonPort !== webPort;
    const liveDataDirSafe = path.resolve(dataDir).toLowerCase() !== liveDataDir.toLowerCase();
    assert.ok(livePortSafe, `demo ports are not isolated: ${daemonPort}, ${webPort}`);
    assert.ok(liveDataDirSafe, `demo data directory is the live default: ${dataDir}`);
    log(`demo root: ${root}`);
    log(`temp daemon port: ${daemonPort}`);
    log(`temp web port: ${webPort}`);
    log(`temp data dir: ${dataDir}`);
    log(`live defaults: port 4400, web 5173/5174, data dir ${liveDataDir}`);
    log(`not-live assertions: PASS (daemon port, web port and data dir are temporary)`);
    const env = {
      ...process.env,
      OVERSEER_DATA_DIR: dataDir,
      OVERSEER_PORT: String(daemonPort),
      OVERSEER_WEB_PORT: String(webPort),
      OVERSEER_WEB_HOSTS: '127.0.0.1,localhost',
      OVERSEER_CLAUDE: fakeCli,
      OVERSEER_BD: 'bd',
      OVERSEER_PROMPTS_DIR: path.join(projectRoot, 'packages/daemon/prompts'),
      OVERSEER_REAP_MIN: '0',
      OVERSEER_STALL_MIN: '240',
      OVERSEER_IDLE_END_MIN: '0',
      OVERSEER_ORCHESTRATOR_IDLE_MIN: '240',
      OVERSEER_WATCH: '0',
      OVERSEER_DEMO_CONTROL_DIR: controlDir,
      OVERSEER_DEMO_PROJECT_ROOT: projectRoot,
      OVERSEER_DEMO_TIMELINE_PATH: path.join(root, 'bin/timeline.json'),
      OVERSEER_DEMO_FIXTURES_DIR: path.join(root, 'bin/fixtures'),
    };
    daemonState = childProcess(process.execPath, ['--disable-warning=ExperimentalWarning', tsxCli, path.join(projectRoot, 'packages/daemon/src/index.ts')], { cwd: projectRoot, env });
    await waitForLine(daemonState, (line) => line.includes('overseer daemon recovery finished; serving requests'), 'daemon readiness');

    webState = childProcess(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: path.join(projectRoot, 'packages/web'), env });
    await waitForLine(webState, (line) => line.includes(String(webPort)) && line.toLowerCase().includes('local'), 'web app readiness');
    const health = await api('/api/health');
    if (!health.ok) throw new Error('daemon health check returned a non-ready state');
    const repo = await api('/api/repos', 'POST', { id: timeline.repo.id, path: repoPath, base_branch: timeline.baseBranch, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, beads: 'stealth' });
    if (repo.id !== timeline.repo.id) throw new Error('fictional repository registration returned the wrong id');
    const account = await api('/api/accounts', 'POST', { name: 'Demo Guide', label: 'Demo Guide', harness: 'claude', kind: 'api_key', secret: 'sunroom-demo-key' });
    await api('/api/settings/orchestrator', 'PUT', { model: 'demo-guide', effort: null, promptOverride: null, account: account.id });
    const candidate = (model) => ({ harness: 'claude', model, effort: null, account: account.id });
    await api('/api/settings/tiers', 'PUT', {
      tiers: [
        { name: 'chore', candidates: [candidate('demo-worker')] },
        { name: 'standard', candidates: [candidate('demo-worker')] },
        { name: 'hard', candidates: [candidate('demo-worker')] },
        { name: 'critic', candidates: [candidate('demo-critic')] },
      ],
      denyModels: [],
    });
    const status = await api('/api/status');
    if (!status.bd_ok) throw new Error('the isolated daemon cannot run its bd binary');
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'no-preference', ...contextOptions });
    page = await context.newPage();
    demo.pageOpenedAt = Date.now();
    demo.page = page;
    await page.addInitScript(observedOfficeScript);
    await page.goto(demo.webUrl, { waitUntil: 'domcontentloaded' });
    await waitForLocator(page.getByRole('textbox', { name: 'Message the orchestrator' }), 'Chat composer', 30_000);
    return demo;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    if (page) {
      try { log(`browser location: ${page.url()}`); log(`browser title: ${await page.title()}`); log(`browser body: ${(await page.locator('body').innerText()).slice(0, 3000)}`); }
      catch (pageError) { log(`browser diagnostics: ${pageError instanceof Error ? pageError.message : String(pageError)}`); }
    }
    for (const [label, state] of [['daemon', daemonState], ['web', webState]]) if (state) log(`${label} output: ${state.tail.join(' | ')}`);
    log(`demo startup failure: ${detail}`);
    await demo.close();
    throw new Error(`scripted demo startup failed; see ${runLog}\n${detail}`);
  }
}
