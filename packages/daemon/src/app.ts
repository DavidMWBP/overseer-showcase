import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/db';
import type { Bus } from './bus';
import type { Config } from './config';
import type { TaskStore } from './beads/store';
import type { SessionManager } from './sessions/manager';
import type { Lifecycle } from './lifecycle/lifecycle';
import type { Prober } from './lifecycle/probe';
import type { Orchestrator } from './orchestrator/orchestrator';
import type { Plans } from './plans/plans';
import type { Discussions } from './discussions/discussions';
import type { VersionRunner } from './doctor/doctor';
import { registerRest } from './api/rest';
import { registerWs } from './api/ws';
import type { ActionJobs } from './api/jobs';
import { Office } from './office/office';
import { registerMcp } from './mcp/server';
import type { Servers } from './servers/servers';
import type { Push } from './push/push';
import type { AccountLogins } from './accounts/login';
import type { DaemonRestartFailure } from '@overseer/shared';

export interface DaemonRuntime {
  pid: number;
  startedAt: string;
  commit: string | null;
  sourceRoot: string;
  sourceHead: () => Promise<string | null>;
  relaunch: () => Promise<void>;
  restarting: boolean;
  restartFailure?: DaemonRestartFailure | null;
}

export interface AppDeps { db: Db; bus: Bus; config: Config; store: TaskStore; sessions: SessionManager; lifecycle: Lifecycle; orchestrator: Orchestrator; plans: Plans; discussions: Discussions; servers: Servers; daemon: DaemonRuntime; logins: AccountLogins; prober: Prober; jobs: ActionJobs; doctorRunner?: VersionRunner; push?: Push;
  /** The office feed, shared with the stall sweep so it can mark and clear stalled sessions; one is created here when omitted. */
  office?: Office;
  /** Resolves when startup recovery has finished; while it is pending the app serves nothing that could carry pre-recovery rows. */
  ready?: Promise<void>;
}

export function buildApp(d: AppDeps): FastifyInstance {
  // A hijacked MCP request is not tracked as a reply, so Fastify's default `forceCloseConnections: 'idle'` leaves its
  // socket open and `app.close()` waits on it until the restart bound. Close active and idle connections too.
  const app = Fastify({ logger: false, forceCloseConnections: true, routerOptions: { maxParamLength: 255 } });
  const office = d.office ?? new Office(d.db, d.bus);
  app.addHook('onClose', async () => { d.logins.close(); });
  if (d.ready) registerReadyGate(app, d.ready);
  app.register(async (inst) => {
    await registerWs(inst, d.bus, office);
    registerRest(inst, d);
    await registerMcp(inst, { db: d.db, store: d.store, sessions: d.sessions, lifecycle: d.lifecycle, bus: d.bus, plans: d.plans, servers: d.servers, push: d.push, originChatId: (id) => d.orchestrator.originChatId(id) });
  });
  return app;
}

/**
 * The port binds before recovery runs (a restart successor must claim it before its parent hands it over), but recovery
 * ends the sessions whose process is gone: a board, a websocket snapshot or any other read answered before it returns
 * reports rows recovery is about to change. Everything waits in `onRequest` instead, including the websocket upgrade,
 * which is a normal route and runs the same hooks.
 *
 * MCP is held like everything else: `worker_status` reads a session row `lifecycle.recover()` is about to end and
 * `list_servers` a row `servers.recover()` is about to stop. Recovery may start the orchestrator (a reopened bead posts
 * a wake notice) and this daemon is that session's MCP server, but starting it is `sessions.start`, which spawns the CLI
 * and returns: recovery never awaits that turn or its tool calls, so a held call cannot stall `recover()`.
 *
 * One path is never held, and it cannot carry a pre-recovery session row:
 * - `/api/daemon`, which reports this process's pid, data dir and source root; a later `pnpm start` reads it to decide
 *   whether the port may be taken over, and that handshake must not stall behind recovery.
 *
 * `/api/health` is answered at once with 503 rather than held, so the web's offline poll backs off and refetches
 * everything when the daemon answers ok again.
 */
function registerReadyGate(app: FastifyInstance, ready: Promise<void>): void {
  let done = false;
  void ready.then(() => { done = true; }, () => { done = true; });
  app.addHook('onRequest', async (req, reply) => {
    if (done) return;
    const url = req.url.split('?')[0] ?? '';
    if (url === '/api/daemon') return;
    if (url === '/api/health') { await reply.code(503).send({ ok: false, ready: false }); return reply; }
    await ready;
  });
}
