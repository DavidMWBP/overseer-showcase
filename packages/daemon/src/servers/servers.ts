import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { killProcess, sweepProcessTree, pidExists, processStartTime } from '../util/procs';
import { log } from '../util/log';
import type { Db } from '../db/db';
import type { ServerRow } from '@overseer/shared';

/**
 * Long-lived processes a worker needs but cannot hold itself: dev servers, preview servers, Playwright.
 *
 * Every harness fails at this differently and none of them can be fixed from our side. OpenCode's shell tool is
 * synchronous, so it reaps a backgrounded process and blocks forever on a detached one (upstream closed the feature
 * request as not planned). Codex's command policy refuses `Start-Process ... -PassThru` outright on Windows, so the
 * launch never happens. Claude workers are denied `run_in_background` by our own hook, because a headless session exits
 * when the model yields and the job's result would be lost. So `spawn_worker(needs_server: true)` had to route around
 * the problem by skipping harnesses instead of solving it.
 *
 * The daemon owns the process instead. It is a child of the daemon rather than of the worker, and its output goes to a
 * file, so it holds none of the session's stdio and cannot keep a turn open the way a worker-started dev server did
 * (overseer-41x, 75 minutes). It is recorded in the DB, so a restart can reap it, and it is stopped when the session
 * that asked for it ends.
 */
export interface StartServerOpts {
  sessionId: string;
  repoId: string;
  beadId: string | null;
  cwd: string;
  command: string;
  /** Optional label so a worker running two servers can tell them apart in `list_servers`. */
  name?: string | null;
}

export class Servers {
  constructor(private db: Db, private dir: string) {}

  private logPath(id: string): string {
    return path.join(this.dir, `${id}.log`);
  }

  /**
   * Starts `command` in `cwd` and returns the row once the process is up. The command runs through the platform shell,
   * because that is how a worker would have typed it (`pnpm dev`, `npx playwright ...`).
   */
  async start(o: StartServerOpts): Promise<ServerRow> {
    const id = `srv-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const logFile = this.logPath(id);
    const fd = fs.openSync(logFile, 'a');
    // `shell: true` is how every other command a user configures is run (`runShell` in lifecycle/verify.ts), so
    // `pnpm dev --port 5201` behaves the way the worker would have typed it. Output goes to a file rather than a pipe,
    // so nothing the server spawns can hold a handle open. It is a child of the daemon, not of the worker session, and
    // it is unref'd: the daemon never waits on it, and no server survives the daemon that owns it.
    const child = spawn(o.command, { cwd: o.cwd, shell: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.unref();
    child.on('error', (e) => { fs.appendFileSync(logFile, `\n${String(e)}\n`); });
    const pid = child.pid ?? null;
    if (!pid) throw new Error(`server did not start: ${o.command}`);
    const startedAt = await processStartTime(pid);
    const row: ServerRow = {
      id, session_id: o.sessionId, repo_id: o.repoId, bead_id: o.beadId, name: o.name ?? null,
      command: o.command, cwd: o.cwd, pid, pid_started_at: startedAt, log_path: logFile,
      status: 'running', started_at: new Date().toISOString(), stopped_at: null,
    };
    this.db.servers.insert(row);
    return row;
  }

  /**
   * Stops a server and everything it started. This is the one place a dev server's own children (a vite worker, a
   * chromium a Playwright run left behind) are cleaned up, so it goes through the same `sweepProcessTree` every
   * harness adapter uses rather than killing the pid alone.
   */
  async stop(id: string, reason = 'stopped'): Promise<void> {
    const row = this.db.servers.get(id);
    if (!row) throw new Error(`server ${id} not found; call list_servers`);
    if (row.status !== 'running') return;
    if (row.pid && pidExists(row.pid)) {
      await killProcess(row.pid, row.pid_started_at ? Date.parse(row.pid_started_at) : undefined);
      await sweepProcessTree({
        pid: row.pid,
        startedAt: row.pid_started_at ? Date.parse(row.pid_started_at) : Date.now(),
        logFile: row.log_path ?? undefined,
        label: `server ${id} (${row.command}) ${reason}`,
      });
    }
    this.db.servers.update(id, { status: 'stopped', stopped_at: new Date().toISOString() });
  }

  /** The tail of a server's log, so a worker can wait for "ready in 400ms" or read a stack trace without a shell. */
  logs(id: string, lines = 50): string {
    const row = this.db.servers.get(id);
    if (!row) throw new Error(`server ${id} not found; call list_servers`);
    let text = '';
    try { text = fs.readFileSync(row.log_path!, 'utf8'); } catch { return ''; }
    const all = text.split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  }

  running(sessionId?: string): ServerRow[] {
    const rows = sessionId ? this.db.servers.forSession(sessionId) : this.db.servers.running();
    return rows.filter((r) => r.status === 'running');
  }

  /** Every server a session started, stopped when that session ends. Nothing a worker leaves behind outlives it. */
  async stopForSession(sessionId: string): Promise<void> {
    for (const row of this.running(sessionId)) {
      await this.stop(row.id, 'its session ended').catch((e) => log.warn(`servers: stopping ${row.id} failed`, e));
    }
  }

  /**
   * On daemon start: a server whose process is gone is marked stopped, and one that survived the restart is killed.
   * A worker is adopted across a restart but its MCP session is not, so it can no longer stop what it started.
   */
  async recover(): Promise<void> {
    for (const row of this.db.servers.running()) {
      if (row.pid && pidExists(row.pid)) await this.stop(row.id, 'the daemon restarted').catch(() => {});
      else this.db.servers.update(row.id, { status: 'stopped', stopped_at: new Date().toISOString() });
    }
  }
}
