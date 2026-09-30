import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../db/db';
import { Servers } from './servers';
import { pidExists } from '../util/procs';

/** A process that stays up and prints a ready line, the way a dev server does. */
const SERVER_CMD = `node -e "console.log('listening on 9999'); setInterval(()=>{}, 1000)"`;

const waitFor = async (f: () => boolean, ms = 10_000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (f()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return f();
};

describe('Servers', () => {
  let db: Db;
  let dir: string;
  let servers: Servers;

  beforeEach(() => {
    db = openDb(':memory:');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-servers-'));
    servers = new Servers(db, dir);
  });
  afterEach(async () => {
    for (const r of servers.running()) await servers.stop(r.id).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = (sessionId = 's1') => servers.start({ sessionId, repoId: 'r1', beadId: 'b1', cwd: process.cwd(), command: SERVER_CMD });

  it('starts a process, records it running and captures its output', async () => {
    const row = await start();
    expect(row.pid).toBeGreaterThan(0);
    expect(row.status).toBe('running');
    expect(pidExists(row.pid!)).toBe(true);
    expect(await waitFor(() => servers.logs(row.id).includes('listening on 9999'))).toBe(true);
  });

  it('stops the process and marks the row stopped', async () => {
    const row = await start();
    await servers.stop(row.id);
    expect(db.servers.get(row.id)!.status).toBe('stopped');
    expect(await waitFor(() => !pidExists(row.pid!))).toBe(true);
    expect(servers.running()).toHaveLength(0);
  });

  it('stops every server a session started when that session ends', async () => {
    const a = await start('s1');
    const b = await start('s1');
    const other = await start('s2');
    await servers.stopForSession('s1');
    expect(await waitFor(() => !pidExists(a.pid!) && !pidExists(b.pid!))).toBe(true);
    expect(servers.running('s1')).toHaveLength(0);
    // A different session's server is untouched: teardown is scoped to the session that asked.
    expect(servers.running('s2').map((r) => r.id)).toEqual([other.id]);
  });

  it('is idempotent: stopping twice does not throw', async () => {
    const row = await start();
    await servers.stop(row.id);
    await expect(servers.stop(row.id)).resolves.toBeUndefined();
  });

  it('reports an unknown id instead of failing silently', async () => {
    await expect(servers.stop('srv-nope')).rejects.toThrow(/not found/);
    expect(() => servers.logs('srv-nope')).toThrow(/not found/);
  });

  it('recover() kills a server that outlived the daemon and closes rows whose process is gone', async () => {
    const survived = await start();
    const gone = await start();
    await servers.stop(gone.id);
    db.servers.update(gone.id, { status: 'running' }); // a row the previous daemon never got to close

    await servers.recover();
    expect(await waitFor(() => !pidExists(survived.pid!))).toBe(true);
    expect(db.servers.get(survived.id)!.status).toBe('stopped');
    expect(db.servers.get(gone.id)!.status).toBe('stopped');
  });
});
