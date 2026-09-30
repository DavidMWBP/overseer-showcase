import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { openDb } from './db/db';
import { Bus } from './bus';
import { ActionJobs } from './api/jobs';
import { Beads, bdRunner } from './beads/beads';
import { makeAdapters } from './harness/index';
import { SessionManager } from './sessions/manager';
import { Lifecycle } from './lifecycle/lifecycle';
import { Prober } from './lifecycle/probe';
import { startStallSweep, SWEEP_MS } from './lifecycle/stall';
import { Office } from './office/office';
import { startIdleEndSweep } from './lifecycle/idle-end';
import { reapEndedSession, startReaper } from './lifecycle/reap';
import { startNightlyReport } from './report/nightly';
import { startRetention } from './report/retention';
import { startGitlabMrWatcher } from './lifecycle/mrWatcher';
import { Orchestrator } from './orchestrator/orchestrator';
import { Plans } from './plans/plans';
import { Discussions } from './discussions/discussions';
import { Servers } from './servers/servers';
import { Push } from './push/push';
import { commandExists } from './util/procs';
import { opencodeOwnLoginReaches } from './accounts/env';
import { providerFor } from './git/provider';
import { PriceCatalog } from './pricing/catalog';
import { buildApp, type DaemonRuntime } from './app';
import { AccountLogins } from './accounts/login';
import { initLog, log } from './util/log';
import { SOURCE_ROOT, watchWarning } from './util/watch';
import { gitHead, listenWithRetry, relaunchDaemon, startupRestartInputHash, takeOverPort, waitForRestartParent } from './util/daemon';

// A `.env` at the repository root (next to package.json, two levels above packages/daemon) sets the OVERSEER_* variables for both the
// daemon and the web server; variables already in the shell win, as Node's loader never overwrites them. Never committed (.gitignore).
const envFile = path.resolve(import.meta.dirname, '../../../.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
initLog(path.join(config.dataDir, 'daemon.log'));
const startupInputHash = startupRestartInputHash(SOURCE_ROOT);
// A detached restart successor exists before shutdown begins, but must not open the shared database or bind until its parent exits.
const restartSuccessor = await waitForRestartParent();
const fatal = (kind: string, error: unknown): void => {
  log.error(`overseer daemon ${kind}`, error);
  process.exit(1);
};
process.once('uncaughtException', (error) => fatal('uncaught exception', error));
process.once('unhandledRejection', (error) => fatal('unhandled rejection', error));
const db = openDb(config.dbPath);
const bus = new Bus();
const office = new Office(db, bus);
const jobs = new ActionJobs(bus);
const store = new Beads(bdRunner(config.bdBin));
// The models.dev price catalog: cached at <dataDir>/models.dev.json, refreshed daily, and read for each session's estimate.
const prices = new PriceCatalog(path.join(config.dataDir, 'models.dev.json'));
prices.start();
const sessions = new SessionManager(db, makeAdapters(config), bus, config.sessionsDir, prices);
const push = new Push(db);
// A quiet notice starts no turn, so the daemon writes it to its bead's notes itself.
const noteBead = async (beadId: string, text: string) => {
  const repoId = db.sessions.forBead(beadId).at(-1)?.repo_id;
  const repo = repoId ? db.repos.get(repoId) : undefined;
  if (repo) await store.update(repo.path, beadId, { note: text });
};
const orchestrator = new Orchestrator({ db, sessions, bus, config, push, noteBead });
const servers = new Servers(db, path.join(config.dataDir, 'servers'));
// A worker's servers are the daemon's to clean up: the session that asked for them is over, and nothing else will.
bus.on('session:ended', (e) => { void servers.stopForSession(e.session.id).catch((err: unknown) => log.warn('servers: session teardown failed', err)); });
const lifecycle = new Lifecycle({ db, store, sessions, bus, config, provider: (repo) => providerFor(repo, config), notify: (m, o) => orchestrator.systemMessage(m, o), push, prices, harnessAvailable: (h) => commandExists(h === 'claude' ? config.claudeBin : h === 'codex' ? config.codexBin : config.opencodeBin), opencodeLoginReaches: (model) => opencodeOwnLoginReaches(model) });
const plans = new Plans({ db, store, lifecycle, bus, notify: (m, o) => orchestrator.systemMessage(m, o), push });
const discussions = new Discussions({ db, sessions, bus, config });
const prober = new Prober({ db, bus, worktreesDir: config.worktreesDir, notify: (m, o) => orchestrator.systemMessage(m, o), push });

if (!(await store.available())) log.warn('overseer: `bd` is not available; the board will show a banner and spawn_worker will refuse until it is installed');

// Once per process: the dev script's `OVERSEER_WATCH=1` plus a managed repo at this source root means a merge restarts the daemon.
const watched = watchWarning(process.env, db.repos.all().map((r) => r.path), SOURCE_ROOT);
if (watched) { log.warn(`overseer: ${watched}`); await orchestrator.systemMessage(watched); }

const daemon: DaemonRuntime = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  commit: await gitHead(SOURCE_ROOT),
  sourceRoot: SOURCE_ROOT,
  sourceHead: () => gitHead(SOURCE_ROOT),
  relaunch: async () => undefined,
  restarting: false,
};
// The gate every request, websocket upgrade and MCP call waits on: the port can bind early, but nothing is answered
// with rows recovery is about to change (see `registerReadyGate`).
let recovered: () => void;
const ready = new Promise<void>((resolve) => { recovered = resolve; });
const app = buildApp({ db, bus, config, store, sessions, lifecycle, orchestrator, plans, discussions, servers, push, daemon, logins: new AccountLogins(db, config), prober, jobs, office, ready });
let stopStallSweep: (() => void) | null = null;
let stopIdleEndSweep: (() => void) | null = null;
let stopReaper: (() => void) | null = null;
let stopGitlabMrWatcher: (() => void) | null = null;
let stopNightlyReport: (() => void) | null = null;
let stopRetention: (() => void) | null = null;
app.addHook('onClose', () => {
  lifecycle.stopPendingBasePushes();
  stopStallSweep?.();
  stopIdleEndSweep?.();
  stopReaper?.();
  stopGitlabMrWatcher?.();
  stopNightlyReport?.();
  stopRetention?.();
  prices.stop();
  db.sql.close();
  log.info('overseer daemon shutdown complete; sweeps stopped and database closed');
});
daemon.relaunch = () => relaunchDaemon(app, config.dataDir, { sourceRoot: SOURCE_ROOT, startupInputHash });
const listen = (): Promise<unknown> => app.listen({ port: config.port, host: '127.0.0.1' });
try { await listenWithRetry(listen, true, undefined, restartSuccessor ? undefined : 30); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  // Watch reloads must never replace another worktree's daemon (which may be the user's long-running instance).
  if (process.env.OVERSEER_WATCH === '1') {
    await takeOverPort(config.port, { takeOver: false });
    process.exit(1);
  }
  // A plain start takes the port from another Overseer daemon and keeps retrying until that process releases it.
  const takeover = await takeOverPort(config.port, { dataDir: config.dataDir, sourceRoot: SOURCE_ROOT });
  if (takeover === null) await listenWithRetry(listen, true, undefined, 30);
  else {
    if (!takeover) process.exit(1);
    await listenWithRetry(listen, true);
  }
}
log.info(`overseer daemon listening on http://127.0.0.1:${config.port}`);
// A probe left running by a crash or restart never finishes on its own; closed here so its row does not read "probe: running" forever.
db.preflight.abandonOpen();
// After listen: a notice from recovery (a reopened bead) may start the orchestrator, whose MCP server is this daemon.
// Starting it spawns the CLI and returns, so the tool calls the gate holds are never awaited here.
await lifecycle.recover();
await servers.recover();
// A discussion cannot outlive its participant processes: recovery above has ended them, so a still-running discussion is
// marked failed with "daemon restarted" and its worktrees are removed rather than left running with no sessions.
await discussions.recover();
// Accepted chat retries are durable queue entries too; restore them before the readiness gate admits new sends.
void orchestrator.recoverPendingUserRetries();
recovered!();
log.info('overseer daemon recovery finished; serving requests');
// After recovery, so an adopted worker is running before its silence is measured.
stopStallSweep = startStallSweep({ db, stallMs: config.stallMs, notify: (m, o) => orchestrator.systemMessage(m, o), onStalled: (ids) => office.setStalled(ids) });
// A worker idling after its turn ended with a result costs the idle time for nothing; ending it settles the bead on that result instead of waiting for the stall threshold.
stopIdleEndSweep = startIdleEndSweep({ db, idleEndMs: config.idleEndMs, end: (id) => sessions.end(id) }, SWEEP_MS);
// After recovery too, so an adopted worker's session is running and its worktree is left alone; the first pass runs now.
const reapDeps = { db, worktreesDir: config.worktreesDir, keepPaths: [SOURCE_ROOT] };
stopReaper = startReaper({ ...reapDeps, intervalMs: config.reapMs });
stopGitlabMrWatcher = startGitlabMrWatcher({
  db,
  mergeBatch: (batchId, actor) => lifecycle.mergeBatch(batchId, actor),
  notify: (m, o) => orchestrator.systemMessage(m, o),
});
// The nightly count, on the daemon's own clock; it schedules the next local hour and never replays a missed night.
stopNightlyReport = startNightlyReport({
  db,
  worktreesDir: config.worktreesDir,
  reportsDir: config.reportsDir,
  notify: (m) => orchestrator.systemMessage(m),
});
// The nightly retention pass, on the daemon's own clock beside it: a session ended past the window loses its events and log, its row stays.
stopRetention = startRetention({ db, sessionsDir: config.sessionsDir, retentionDays: config.retentionDays });
// Every session end (clean, silence, interrupt, crash) stops what that session left in its worktree; the periodic pass
// covers a daemon that died instead. The notice makes a leak visible rather than silent.
bus.on('session:ended', (e) => {
  void reapEndedSession(reapDeps, e.session.cwd, { notify: (m) => { void orchestrator.systemMessage(m, { beadId: e.session.bead_id ?? undefined }).catch((err) => log.error('reaper: could not post the leak notice', err)); } })
    .catch((err) => log.error('reaper: session-end pass failed', err));
});
