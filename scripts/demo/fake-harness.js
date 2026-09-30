import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.OVERSEER_DEMO_PROJECT_ROOT ?? path.resolve(here, '../..');
const daemonRequire = createRequire(path.join(projectRoot, 'packages/daemon/package.json'));
const { Client } = daemonRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = daemonRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');
const timeline = JSON.parse(fs.readFileSync(process.env.OVERSEER_DEMO_TIMELINE_PATH ?? path.join(here, 'timeline.json'), 'utf8'));
const fixtureRoot = process.env.OVERSEER_DEMO_FIXTURES_DIR ?? path.join(here, 'fixtures');
const controlDir = process.env.OVERSEER_DEMO_CONTROL_DIR;
const pidDir = path.join(controlDir, 'pids');
const configArg = process.argv.indexOf('--mcp-config');
if (!controlDir || configArg < 0 || !process.argv[configArg + 1]) throw new Error('demo harness requires the run control directory and MCP config');

const cliConfig = JSON.parse(fs.readFileSync(process.argv[configArg + 1], 'utf8'));
const mcpUrl = cliConfig.mcpServers?.overseer?.url;
if (!mcpUrl) throw new Error('demo harness did not receive its session MCP URL');
const sessionId = new URL(mcpUrl).pathname.split('/').at(-1);
const nativeIdArg = process.argv.indexOf('--session-id');
const resumeArg = process.argv.indexOf('--resume');
const nativeSessionId = nativeIdArg >= 0 ? process.argv[nativeIdArg + 1] : resumeArg >= 0 ? process.argv[resumeArg + 1] : randomUUID();
const daemonOrigin = new URL(mcpUrl).origin;
const api = (route) => fetch(new URL(route, `${daemonOrigin}/`));
const client = new Client({ name: 'sunroom-demo-harness', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sessionIdRow(id) {
  return api('api/sessions').then(async (response) => {
    if (!response.ok) throw new Error(`session lookup failed: HTTP ${response.status}`);
    const sessions = await response.json();
    const row = sessions.find((session) => session.id === id);
    if (!row) throw new Error(`session ${id} is not visible to the demo harness`);
    return row;
  });
}

async function emitAssistant(textOrTool) {
  const content = typeof textOrTool === 'string'
    ? [{ type: 'text', text: textOrTool }]
    : [{ type: 'tool_use', id: textOrTool.id, name: textOrTool.name, input: textOrTool.input }];
  writeEvent({
    type: 'assistant',
    session_id: nativeSessionId,
    message: {
      role: 'assistant',
      model: textOrTool.model ?? 'demo-model',
      usage: { input_tokens: 1400, output_tokens: 90 },
      content,
    },
  });
}

async function emitResult(cost) {
  writeEvent({
    type: 'result',
    session_id: nativeSessionId,
    is_error: false,
    total_cost_usd: cost,
    usage: { input_tokens: 4100, output_tokens: 520 },
    modelUsage: { 'demo-model': { contextWindow: 200000 } },
  });
}

async function emitTool(name, input, run, model) {
  const id = randomUUID();
  await emitAssistant({ id, name, input, model });
  const output = await run();
  writeEvent({
    type: 'user',
    session_id: nativeSessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }] }],
    },
  });
  return output;
}

async function callMcp(name, input, model) {
  return emitTool(`mcp__overseer__${name}`, input, async () => {
    const result = await client.callTool({ name, arguments: input });
    const text = result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
    if (result.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  }, model);
}

async function callMcpChecked(name, input, model) {
  const result = await callMcp(name, input, model);
  if (typeof result === 'string') throw new Error(`${name} returned text instead of JSON: ${result}`);
  return result;
}

async function waitForGate(name) {
  const gateDir = path.join(controlDir, 'gates');
  const gatePath = path.join(gateDir, name);
  if (fs.existsSync(gatePath)) return;
  await new Promise((resolve, reject) => {
    const watcher = fs.watch(gateDir, (_event, filename) => {
      if (String(filename) !== name || !fs.existsSync(gatePath)) return;
      watcher.close();
      resolve();
    });
    watcher.once('error', reject);
    if (fs.existsSync(gatePath)) { watcher.close(); resolve(); }
  });
}

function fixtureFile(relative) {
  return fs.readFileSync(path.join(fixtureRoot, relative), 'utf8');
}

function commit(cwd, file, subject) {
  execFileSync('git', ['add', '--', file], { cwd, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Rowan Finch', '-c', 'user.email=rowan.finch@example.invalid', 'commit', '-m', subject, '--no-gpg-sign'], { cwd, stdio: 'pipe', windowsHide: true });
}

function findTask(title) {
  const task = timeline.tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`unknown demo task ${title}`);
  return task;
}

async function createStory() {
  await emitAssistant('I’ll split the planner into independent pieces, then check the review note before handing it back.');
  const repoRows = await callMcpChecked('list_repos', {}, 'demo-guide');
  if (!repoRows.some((repo) => repo.id === timeline.repo.id)) throw new Error(`fictional repository ${timeline.repo.id} was not registered`);
  const batch = await callMcpChecked('create_batch', { repo: timeline.repo.id, title: timeline.batchTitle }, 'demo-guide');
  activeBatchId = batch.batch_id;
  const beads = [];
  for (const task of timeline.tasks) {
    const created = await callMcpChecked('bd', {
      repo: timeline.repo.id,
      args: ['create', task.title, '-d', task.description],
      batch_id: batch.batch_id,
    }, 'demo-guide');
    const bead = Array.isArray(created) ? created[0] : created;
    const id = bead?.id ?? bead?.issue_id;
    if (!id) throw new Error(`bd create did not return an id for ${task.title}`);
    beads.push({ ...bead, id, title: task.title });
  }
  await callMcpChecked('bd', { repo: timeline.repo.id, args: ['dep', 'add', beads[2].id, beads[1].id] }, 'demo-guide');
  for (const bead of beads.slice(0, 2)) {
    await callMcpChecked('spawn_worker', { repo: timeline.repo.id, bead_id: bead.id, harness: 'claude', tier: 'standard', batch_id: batch.batch_id }, 'demo-guide');
  }
  await emitAssistant(timeline.reply);
  await emitResult(0.006);
  return batch.batch_id;
}

async function progressBatch() {
  await emitAssistant('I’ll check which parts of the plan are ready and start the next task when its ingredients arrive.');
  const taskRows = await callMcpChecked('list_tasks', { repo: timeline.repo.id, filter: 'all' }, 'demo-guide');
  const beads = Array.isArray(taskRows) ? taskRows : [];
    const thirdTask = findTask(timeline.tasks[2].title);
  const waiting = beads.find((bead) => bead.title === thirdTask.title);
  if (waiting?.column === 'ready' && waiting.status !== 'closed') {
    await callMcpChecked('spawn_worker', { repo: timeline.repo.id, bead_id: waiting.id, harness: 'claude', tier: 'standard', batch_id: activeBatchId }, 'demo-guide');
    await emitAssistant('The weekly grid and recipe cards are on the batch branch. I’m starting the grouped shopping list now.');
    await emitResult(0.002);
    return;
  }
  if (activeBatchId && timeline.tasks.every((task) => beads.some((bead) => bead.title === task.title && bead.status === 'closed'))) {
    const handoff = await callMcpChecked('request_batch_review', { repo: timeline.repo.id, batch_id: activeBatchId, note: timeline.reviewNote }, 'demo-guide');
    if (!handoff.in_review) throw new Error(`batch was not handed to review: ${JSON.stringify(handoff)}`);
    await emitAssistant('All three tasks have landed. The batch is ready for your review and merge.');
    await emitResult(0.003);
    return;
  }
  await emitAssistant('The remaining work is still running; I’ll hand over the batch when every task has landed.');
  await emitResult(0.001);
}

let activeBatchId = null;

async function orchestratorTurn(text) {
  if (text.includes(timeline.request.text) && !activeBatchId) {
    const batches = await callMcpChecked('list_batches', { repo: timeline.repo.id }, 'demo-guide');
    const existing = Array.isArray(batches) ? batches.find((batch) => batch.title === timeline.batchTitle) : null;
    if (!existing) {
      await createStory();
    } else {
      activeBatchId = existing.id;
      await progressBatch();
    }
    return;
  }
  await progressBatch();
}

async function workerTurn(session) {
  const task = findTask(session.bead_title);
  const rows = await api(`api/sessions?bead_id=${encodeURIComponent(session.bead_id)}`).then((response) => response.json());
  const attempt = rows.filter((row) => row.role === 'worker').length;
  const model = 'demo-worker';
  const appFile = path.join(session.cwd, 'src/app.js');
  await waitForGate(`type-${session.bead_id}-${attempt}`);
  await emitAssistant('I’ll inspect the app entry point and then update the planned view.');
  await emitTool('Read', { file_path: appFile }, () => fs.readFileSync(appFile, 'utf8'), model);
  await waitForGate(`worker-${session.bead_id}-${attempt}`);
  const change = attempt > 1 && task.repairChange ? task.repairChange : task.initialChange;
  fs.writeFileSync(path.join(session.cwd, task.file), fixtureFile(change));
  const commitText = `git add ${task.file} && git commit -m "feat: ${task.title.toLowerCase()}"`;
  await emitAssistant(`I’ve updated ${task.file} and am committing the change.`);
  await emitTool('Bash', { command: commitText, description: `Commit ${task.title.toLowerCase()}` }, () => {
    commit(session.cwd, task.file, `feat: ${task.title.toLowerCase()}`);
    return `Committed ${task.file}.`;
  }, model);
  await emitAssistant(`Implemented ${task.title.toLowerCase()} in ${task.file}. Check: PASS - The change is committed on the task branch.`);
  const costs = task === timeline.tasks[0] ? (attempt === 1 ? 0.03 : 0.045) : task === timeline.tasks[1] ? 0.024 : 0.02;
  await emitResult(costs);
}

async function criticTurn(session) {
  const task = findTask(session.bead_title);
  const rows = await api(`api/sessions?bead_id=${encodeURIComponent(session.bead_id)}`).then((response) => response.json());
  const workerAttempts = rows.filter((row) => row.role === 'worker').length;
  const mustFinding = task === timeline.tasks[0] && workerAttempts === 1;
  const model = 'demo-critic';
  await emitAssistant(`I’ll compare the branch with the keyboard and review requirements for ${task.title.toLowerCase()}.`);
  await callMcp('worker_diff', { repo: timeline.repo.id, bead_id: session.bead_id }, model);
  if (mustFinding) {
    await callMcpChecked('submit_review', {
      repo: timeline.repo.id,
      bead_id: session.bead_id,
      verdict: 'findings',
      findings: [{ file: timeline.reviewFinding.file, summary: timeline.reviewFinding.summary, severity: 'must' }],
    }, model);
    await emitAssistant(`The previous-week control has no accessible name in ${timeline.reviewFinding.file}.`);
    await emitResult(0.012);
    return;
  }
  await callMcpChecked('submit_review', { repo: timeline.repo.id, bead_id: session.bead_id, verdict: 'pass', findings: [] }, model);
  await emitAssistant(`The branch for ${task.title.toLowerCase()} passes review.`);
  await emitResult(0.01);
}

await fs.promises.mkdir(pidDir, { recursive: true });
const current = await sessionIdRow(sessionId);
fs.writeFileSync(path.join(pidDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, role: current.role, beadId: current.bead_id, title: current.bead_title }));
if (current.role === 'orchestrator') {
  const batches = await callMcpChecked('list_batches', { repo: timeline.repo.id }, 'demo-guide');
  const existing = Array.isArray(batches) ? batches.find((batch) => batch.title === timeline.batchTitle) : null;
  if (existing) activeBatchId = existing.id;
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  input.on('line', (line) => {
    queue = queue.then(async () => {
      const message = JSON.parse(line);
      const text = message.message?.content?.find((part) => part.type === 'text')?.text ?? '';
      await orchestratorTurn(text);
    }).catch((error) => { console.error(error); process.exitCode = 1; input.close(); });
  });
  input.on('close', async () => { await queue; await client.close(); process.exit(process.exitCode ?? 0); });
} else if (current.role === 'worker') {
  try { await workerTurn(current); await client.close(); process.exit(0); }
  catch (error) { console.error(error); await client.close().catch(() => undefined); process.exit(1); }
} else if (current.role === 'critic') {
  try { await criticTurn(current); await client.close(); process.exit(0); }
  catch (error) { console.error(error); await client.close().catch(() => undefined); process.exit(1); }
} else {
  await client.close();
  throw new Error(`unsupported demo harness role ${current.role}`);
}
