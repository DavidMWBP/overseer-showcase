import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { SessionRow, WsMessage } from '@overseer/shared';
import { openDb } from '../db/db';
import type { Db } from '../db/db';
import { Bus } from '../bus';
import { Office } from '../office/office';
import { until } from '../test/until';
import { registerWs } from './ws';

type Snapshot = Extract<WsMessage, { type: 'office_snapshot' }>;
const snapshots = (got: WsMessage[]): Snapshot[] => got.filter((m): m is Snapshot => m.type === 'office_snapshot');

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1', harness: 'claude', role: 'worker', bead_id: 'r-1', repo_id: 'r', native_session_id: null,
    pid: 1, pid_started_at: 't', start_commit: null, cwd: '/w', status: 'running', started_at: '2026-09-17T10:00:00.000Z',
    ended_at: null, cost: null, batch_id: 'r-b1', log_path: null, log_offset: 0, tier: 'standard', model: 'sonnet', account: null,
    bead_title: 'Do the thing', ...over,
  };
}

async function listen(db: Db = openDb(':memory:')): Promise<{ app: ReturnType<typeof Fastify>; bus: Bus; port: number }> {
  const app = Fastify();
  const bus = new Bus();
  await registerWs(app, bus, new Office(db, bus));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, bus, port: (app.server.address() as { port: number }).port };
}

/** Opens a socket and collects every message it receives. */
async function connect(port: number): Promise<{ socket: WebSocket; got: WsMessage[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`); // Node's own client
  const got: WsMessage[] = [];
  socket.onmessage = (e) => got.push(JSON.parse(String(e.data)) as WsMessage);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('socket error')); });
  return { socket, got };
}

/** True once no further message arrived inside a settle window read off a clock taken before the loop; proves no replay was sent, not that one had not arrived yet. */
async function quiet(got: WsMessage[], ms = 100): Promise<boolean> {
  const seen = got.length;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (got.length !== seen) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return got.length === seen;
}

describe('ws', () => {
  it('resends the current orchestrator activity to a socket that connects mid-turn', async () => {
    const { app, bus, port } = await listen();
    try {
      bus.emit('orchestrator:activity', { state: 'tool', tool: 'Bash', summary: 'Run tests', started_at: '2026-09-14T10:00:00.000Z' });
      const first = await new Promise<WsMessage>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/api/events`); // Node's own client
        s.onmessage = (e) => { resolve(JSON.parse(String(e.data)) as WsMessage); s.close(); };
        s.onerror = () => reject(new Error('socket error'));
      });
      expect(first).toEqual({ type: 'orchestrator_activity', activity: { state: 'tool', tool: 'Bash', summary: 'Run tests', started_at: '2026-09-14T10:00:00.000Z' } });
    } finally {
      await app.close();
    }
  });

  it('sends one empty office snapshot to a socket when no session is running', async () => {
    const { app, bus, port } = await listen();
    try {
      const { socket, got } = await connect(port);
      await until(() => got.length >= 1);
      expect(got).toEqual([{ type: 'office_snapshot', sessions: [] }]);
      expect(await quiet(got)).toBe(true); // empty is a snapshot, not a missing message
      socket.close();
    } finally {
      await app.close();
    }
  });

  it('sends one snapshot with every running session and no per-session replay', async () => {
    const db = openDb(':memory:');
    db.sessions.insert(sessionRow());
    db.sessions.insert(sessionRow({ id: 's2', bead_id: 'r-2', bead_title: 'Do the other thing' }));
    const { app, port } = await listen(db);
    try {
      const { socket, got } = await connect(port);
      await until(() => snapshots(got).length >= 1);
      const snaps = snapshots(got);
      expect(snaps).toHaveLength(1);
      expect(snaps[0]!.sessions.map((s) => s.session_id).sort()).toEqual(['s1', 's2']);
      expect(snaps[0]!.sessions).toEqual([
        expect.objectContaining({ session_id: 's1', state: 'walking_in' }),
        expect.objectContaining({ session_id: 's2', state: 'walking_in' }),
      ]);
      // The set arrived as one message; no `office` message replayed it session by session.
      expect(got.some((m) => m.type === 'office')).toBe(false);
      expect(await quiet(got)).toBe(true);
      socket.close();
    } finally {
      await app.close();
    }
  });

  it('sends a live office update after the snapshot', async () => {
    const db = openDb(':memory:');
    db.sessions.insert(sessionRow());
    const { app, bus, port } = await listen(db);
    try {
      const { socket, got } = await connect(port);
      await until(() => snapshots(got).length >= 1);
      // A tool call is a real state change the feed derives a live `office` message from.
      bus.emit('event', { id: 1, session_id: 's1', seq: 1, type: 'tool_call', payload: null, ts: 't' });
      await until(() => got.some((m) => m.type === 'office'));
      expect(got.find((m) => m.type === 'office')).toMatchObject({ type: 'office', session: { session_id: 's1', state: 'working' } });
      socket.close();
    } finally {
      await app.close();
    }
  });

  it('broadcasts an office milestone to connected sockets', async () => {
    const { app, bus, port } = await listen();
    try {
      const { socket, got } = await connect(port);
      await until(() => snapshots(got).length === 1);
      bus.emit('office_milestone', { kind: 'verify_passed', repo_id: 'r1', batch_id: 'r1-b1', bead_id: 'r-1', at: '2026-09-25T10:00:00.000Z' });
      await until(() => got.some((m) => m.type === 'office_milestone'));
      expect(got.filter((m) => m.type === 'office_milestone')).toEqual([
        { type: 'office_milestone', kind: 'verify_passed', repo_id: 'r1', batch_id: 'r1-b1', bead_id: 'r-1', at: '2026-09-25T10:00:00.000Z' },
      ]);
      socket.close();
    } finally {
      await app.close();
    }
  });

  it('does not replay office milestones to a socket that connects afterwards', async () => {
    const { app, bus, port } = await listen();
    try {
      bus.emit('office_milestone', { kind: 'verify_failed', repo_id: 'r1', batch_id: null, bead_id: 'r-1', at: '2026-09-25T10:00:00.000Z' });
      const { socket, got } = await connect(port);
      await until(() => snapshots(got).length === 1);
      await quiet(got);
      expect(got).toEqual([{ type: 'office_snapshot', sessions: [] }]);
      socket.close();
    } finally {
      await app.close();
    }
  });

  it('sends a fresh snapshot on every connect, not the one the first socket saw', async () => {
    const db = openDb(':memory:');
    db.sessions.insert(sessionRow());
    const { app, port } = await listen(db);
    try {
      const first = await connect(port);
      await until(() => snapshots(first.got).length >= 1);
      expect(snapshots(first.got)[0]!.sessions.map((s) => s.session_id)).toEqual(['s1']);
      first.socket.close();
      db.sessions.insert(sessionRow({ id: 's2', bead_id: 'r-2' }));
      const second = await connect(port);
      await until(() => snapshots(second.got).length >= 1);
      expect(snapshots(second.got)[0]!.sessions.map((s) => s.session_id).sort()).toEqual(['s1', 's2']);
      second.socket.close();
    } finally {
      await app.close();
    }
  });

  it('sends a connected socket a leave event when a session ends', async () => {
    const db = openDb(':memory:');
    db.sessions.insert(sessionRow());
    const { app, bus, port } = await listen(db);
    const { socket, got } = await connect(port);
    try {
      await until(() => snapshots(got).length >= 1); // the snapshot arrives first
      bus.emit('session:ended', { session: { ...sessionRow(), status: 'ended', ended_at: 't' }, lastText: null, lastError: null, files: [] });
      await until(() => got.some((m) => m.type === 'office' && m.session.state === 'leaving'));
      expect(got.find((m) => m.type === 'office' && m.session.state === 'leaving')).toMatchObject({ type: 'office', session: { session_id: 's1', state: 'leaving' } });
    } finally {
      socket.close();
      await app.close();
    }
  });

  it('closes an open board socket during daemon shutdown', async () => {
    const { app, port } = await listen();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('socket error'));
    });
    const closed = new Promise<void>((resolve) => { socket.onclose = () => resolve(); });
    await app.close();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
