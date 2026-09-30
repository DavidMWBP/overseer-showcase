import { describe, it, expect, vi } from 'vitest';
import type { SessionRow } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { ClaudeAdapter } from '../harness/claude';
import { fakeBin } from '../test/fakeBin';
import type { HarnessEvent, SessionHandle } from '../harness/types';
import type { StartOpts } from '../harness/types';
import { SessionManager, TOOL_RESULT_MAX_BYTES, type SessionEnded } from './manager';
import { PriceCatalog } from '../pricing/catalog';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR = path.join(os.tmpdir(), 'overseer-test-sessions'); // the fake adapter never writes there
/** The fixture catalog stands in for models.dev; these tests never reach the network. */
const catalog = (): PriceCatalog => { const c = new PriceCatalog(fileURLToPath(new URL('../pricing/fixtures/models.dev.json', import.meta.url))); c.load(); return c; };

class ThrowingAdapter extends FakeAdapter {
  override events(h: SessionHandle): AsyncIterable<HarnessEvent> {
    const inner = super.events(h);
    return { async *[Symbol.asyncIterator]() { for await (const ev of inner) { yield ev; throw new Error('consumer boom'); } } };
  }
}

/**
 * A harness whose process death is observed inside the interrupt: `interrupt()` pushes the exit error and closes the
 * stream, exactly as `ClaudeSession.pump` does while `ending` is still false, so the consumer reaches its end-of-stream
 * decision before `end()` is called. This is the losing order of the stop race (manager.ts: the window between
 * `adapter.interrupt` and `adapter.end`).
 */
class DyingOnInterruptAdapter extends FakeAdapter {
  override async interrupt(h: SessionHandle): Promise<void> {
    await super.interrupt(h);
    this.emit(h, { type: 'error', message: 'claude exited with code null' });
    await super.end(h);
    await new Promise((r) => setTimeout(r, 5)); // the consumer drains and finishes before `end()` is reached
  }
}

class PollingAdapter extends FakeAdapter {
  override start(o: StartOpts): SessionHandle {
    const handle = super.start(o);
    queueMicrotask(() => { o.onLogOffset?.(1); o.onLogOffset?.(2); });
    return handle;
  }
}

/** Like the real adapters, refuses a second `end` on the same handle: the handle is gone, so it throws "not found". */
class SingleEndAdapter extends FakeAdapter {
  private closed = new Set<string>();
  override async end(h: SessionHandle): Promise<void> {
    if (this.closed.has(h.id)) throw new Error(`fake session ${h.id} not found`);
    this.closed.add(h.id);
    await super.end(h);
  }
}

/** Fails the first `end` and succeeds on the next, like an adapter whose teardown hit a transient error. */
class FlakyEndAdapter extends FakeAdapter {
  private attempts = 0;
  override async end(h: SessionHandle): Promise<void> {
    this.attempts++;
    if (this.attempts === 1) throw new Error('end boom');
    await super.end(h);
  }
}

function setup() {
  const db = openDb(':memory:');
  const bus = new Bus();
  const fake = new FakeAdapter();
  const mgr = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
  const ended: SessionEnded[] = [];
  bus.on('session:ended', (e) => ended.push(e));
  const waitEnded = () => new Promise<SessionEnded>((r) => bus.once('session:ended', r));
  return { db, bus, fake, mgr, ended, waitEnded };
}
const opts = { role: 'worker' as const, harness: 'claude' as const, repoId: 'r1', beadId: 'b1', cwd: '.', prompt: 'do it', startCommit: 'abc' };

describe('SessionManager', () => {
  it('logs a busy offset write and continues polling', async () => {
    const { db, bus } = setup();
    const adapter = new PollingAdapter();
    const mgr2 = new SessionManager(db, { claude: adapter }, bus, LOG_DIR);
    const originalUpdate = db.sessions.update;
    let busy = true;
    const update = vi.spyOn(db.sessions, 'update');
    update.mockImplementation((id, patch) => {
      if (busy && patch.log_offset !== undefined) {
        busy = false;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return originalUpdate(id, patch);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const s = mgr2.start(opts);
      await new Promise((r) => setTimeout(r, 10));
      expect(db.sessions.get(s.id)?.log_offset).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(s.id), expect.objectContaining({ code: 'SQLITE_BUSY' }));
    } finally {
      update.mockRestore();
      error.mockRestore();
    }
  });

  it('persists events and ends a worker after turn_end', async () => {
    const { db, fake, mgr, waitEnded } = setup();
    const s = mgr.start(opts);
    expect(db.sessions.get(s.id)?.status).toBe('running');
    expect(db.sessions.get(s.id)).toMatchObject({ tier: null, model: null });
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'assistant_text', text: 'working' });
    fake.emit(h, { type: 'file_change', path: 'a.ts' });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ pid: 4242, pid_started_at: 'fake' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.2, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 } });
    const e = await waitEnded();
    expect(e.session.status).toBe('ended');
    expect(e.lastText).toBe('working');
    expect(e.files).toEqual(['a.ts']);
    expect(db.sessions.get(s.id)).toMatchObject({ native_session_id: 'n1', cost: 0.2, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, reasoning_tokens: 50, pid: null, status: 'ended' });
    expect(db.events.forSession(s.id).map((x) => x.type)).toEqual(['process_start', 'assistant_text', 'file_change', 'turn_end']);
  });

  it('caps a stored tool_result output at 16 KB and records the cut size', async () => {
    const { db, fake, mgr } = setup();
    const s = mgr.start(opts);
    const big = 'x'.repeat(TOOL_RESULT_MAX_BYTES + 500);
    fake.emit(mgr.handleOf(s.id)!, { type: 'tool_result', id: 't1', output: big });
    await new Promise((r) => setTimeout(r, 10));
    const p = db.events.forSession(s.id).find((e) => e.type === 'tool_result')!.payload as { id: string; output: string; truncated_bytes: number };
    expect(Buffer.byteLength(p.output, 'utf8')).toBe(TOOL_RESULT_MAX_BYTES);
    expect(p.truncated_bytes).toBe(500);
    expect(p.id).toBe('t1');
  });

  it('stores a tool_result at or under 16 KB unchanged', async () => {
    const { db, fake, mgr } = setup();
    const s = mgr.start(opts);
    const small = 'y'.repeat(TOOL_RESULT_MAX_BYTES);
    fake.emit(mgr.handleOf(s.id)!, { type: 'tool_result', id: 't1', output: small });
    await new Promise((r) => setTimeout(r, 10));
    const p = db.events.forSession(s.id).find((e) => e.type === 'tool_result')!.payload as Record<string, unknown>;
    expect(p.output).toBe(small);
    expect(p).not.toHaveProperty('truncated_bytes');
  });

  it('caps a tool_result without splitting a multibyte character', async () => {
    const { db, fake, mgr } = setup();
    const s = mgr.start(opts);
    // 'é' is two bytes, so the byte cap lands inside a rune and must back off to its start.
    const out = 'é'.repeat(TOOL_RESULT_MAX_BYTES / 2 + 10);
    fake.emit(mgr.handleOf(s.id)!, { type: 'tool_result', id: 't1', output: out });
    await new Promise((r) => setTimeout(r, 10));
    const p = db.events.forSession(s.id).find((e) => e.type === 'tool_result')!.payload as { output: string; truncated_bytes: number };
    expect(Buffer.byteLength(p.output, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(p.output.endsWith('é')).toBe(true);
    expect(p.truncated_bytes).toBe(Buffer.byteLength(out, 'utf8') - Buffer.byteLength(p.output, 'utf8'));
  });

  it('caps a non-string tool_result by its JSON text and leaves a small one typed', async () => {
    const { db, fake, mgr } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    const big = { blocks: 'q'.repeat(TOOL_RESULT_MAX_BYTES) };
    fake.emit(h, { type: 'tool_result', id: 'big', output: big });
    fake.emit(h, { type: 'tool_result', id: 'small', output: { ok: true } });
    await new Promise((r) => setTimeout(r, 10));
    const events = db.events.forSession(s.id);
    const capped = events.find((e) => (e.payload as { id: string }).id === 'big')!.payload as { output: unknown; truncated_bytes: number };
    expect(typeof capped.output).toBe('string');
    expect(Buffer.byteLength(capped.output as string, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(capped.truncated_bytes).toBe(Buffer.byteLength(JSON.stringify(big), 'utf8') - Buffer.byteLength(capped.output as string, 'utf8'));
    const small = events.find((e) => (e.payload as { id: string }).id === 'small')!.payload as { output: unknown };
    expect(small.output).toEqual({ ok: true });
    expect(small).not.toHaveProperty('truncated_bytes');
  });

  it('stores every other event type and every other field unchanged', async () => {
    const { db, fake, mgr } = setup();
    const s = mgr.start(opts);
    const long = 'z'.repeat(TOOL_RESULT_MAX_BYTES + 100);
    fake.emit(mgr.handleOf(s.id)!, { type: 'assistant_text', text: long });
    fake.emit(mgr.handleOf(s.id)!, { type: 'tool_call', id: 'c1', name: 'Read', input: { file: 'a.ts' } });
    fake.emit(mgr.handleOf(s.id)!, { type: 'raw', line: long });
    await new Promise((r) => setTimeout(r, 10));
    const events = db.events.forSession(s.id);
    expect((events.find((e) => e.type === 'assistant_text')!.payload as { text: string }).text).toBe(long);
    expect((events.find((e) => e.type === 'raw')!.payload as { line: string }).line).toBe(long);
    expect(events.find((e) => e.type === 'tool_call')!.payload).toMatchObject({ id: 'c1', name: 'Read', input: { file: 'a.ts' } });
  });

  it('emits session:started with the row, so the office feed draws a character from the dispatch', () => {
    const { bus, mgr } = setup();
    const started: SessionRow[] = [];
    bus.on('session:started', (s) => started.push(s));
    const s = mgr.start({ ...opts, beadTitle: 'Do the thing' });
    expect(started).toEqual([s]);
    expect(started[0]).toMatchObject({ id: s.id, role: 'worker', bead_id: 'b1', bead_title: 'Do the thing' });
  });

  it('keeps a sub-agent assistant_text out of the live lastText', async () => {
    const { db, fake, mgr, waitEnded } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'assistant_text', text: 'working' });
    fake.emit(h, { type: 'assistant_text', text: 'sub-agent note', parentId: 'call_task' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.2 });
    const e = await waitEnded();
    expect(e.lastText).toBe('working'); // a sub-agent's text is not the session's own
    expect(db.sessions.get(s.id)?.last_text).toBe('working');
  });

  it('ends the row with the reason when the adapter fails to spawn, and rethrows', () => {
    const { db, mgr } = setup();
    class NoSpawnAdapter extends FakeAdapter { override start(): SessionHandle { throw new Error('spawn ENAMETOOLONG'); } }
    const bad = new SessionManager(db, { claude: new NoSpawnAdapter() }, new Bus(), LOG_DIR);
    expect(() => bad.start(opts)).toThrow('spawn ENAMETOOLONG');
    const rows = db.sessions.forBead('b1');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ status: 'failed', pid: null, end_reason: 'could not start: spawn ENAMETOOLONG' });
    expect(row.ended_at).not.toBeNull();
    expect(bad.isLive(row.id)).toBe(false);
    expect(mgr.status(row.id).endReason).toBe('could not start: spawn ENAMETOOLONG');
  });

  it('stores tier/model on the row and passes model/effort to the adapter', () => {
    const { db, fake, mgr } = setup();
    const s = mgr.start({ ...opts, tier: 'standard', model: 'gpt-5.6-terra', effort: 'high' });
    expect(db.sessions.get(s.id)).toMatchObject({ tier: 'standard', model: 'gpt-5.6-terra' });
    const h = mgr.handleOf(s.id)!;
    const fakeSession = (fake as any).sessions.get(h.id);
    expect(fakeSession.opts.model).toBe('gpt-5.6-terra');
    expect(fakeSession.opts.effort).toBe('high');
  });

  it('forwards prompt-eval sandbox options to the selected adapter', () => {
    const { fake, mgr } = setup();
    const tools = ['Bash', 'Read', 'Grep', 'Glob'];
    const s = mgr.start({ ...opts, role: 'orchestrator', beadId: null, repoId: null, evalSandbox: true, denyBackground: true, tools });
    const h = mgr.handleOf(s.id)!;
    expect(fake.sessions.get(h.id)!.opts).toMatchObject({ evalSandbox: true, denyBackground: true, tools });
  });

  it('forwards the session role to the adapter', () => {
    const { fake, mgr } = setup();
    for (const role of ['worker', 'critic', 'orchestrator'] as const) {
      const s = mgr.start({ ...opts, role });
      expect(fake.sessions.get(mgr.handleOf(s.id)!.id)!.opts.role).toBe(role);
    }
  });

  it('stores the account and forwards its environment to the adapter', () => {
    const { db, fake, mgr } = setup();
    const env = { CODEX_HOME: 'C:/accounts/a1' };
    const s = mgr.start({ ...opts, account: 'a1', env });
    expect(db.sessions.get(s.id)?.account).toBe('a1');
    const h = mgr.handleOf(s.id)!;
    expect(fake.sessions.get(h.id)!.opts.env).toEqual(env);
  });

  it('marks failed and emits session:ended when the event stream throws', async () => {
    const { db, bus } = setup();
    const boom = new ThrowingAdapter();
    const mgr2 = new SessionManager(db, { claude: boom }, bus, LOG_DIR);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ended = new Promise<SessionEnded>((r) => bus.once('session:ended', r));
      const s = mgr2.start(opts);
      const e = await ended;
      expect(e.session.status).toBe('failed');
      expect(db.sessions.get(s.id)).toMatchObject({ status: 'failed', pid: null, end_reason: 'event stream failed: consumer boom' });
      expect(e.lastError).toBe('event stream failed: consumer boom');
      expect(db.sessions.get(s.id)?.ended_at).toBeTruthy();
      expect(mgr2.isLive(s.id)).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(s.id), expect.any(Error));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      error.mockRestore();
    }
  });

  it('logs a failed session update without an unhandled rejection', async () => {
    const { db, bus, fake } = setup();
    const mgr2 = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
    const originalAppend = db.events.append;
    const append = vi.spyOn(db.events, 'append').mockImplementation((sessionId, type, payload) => {
      if (type === 'assistant_text') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return originalAppend(sessionId, type, payload);
    });
    const originalUpdate = db.sessions.update;
    const update = vi.spyOn(db.sessions, 'update').mockImplementation((id, patch) => {
      if (patch.status === 'failed') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return originalUpdate(id, patch);
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const s = mgr2.start(opts);
      fake.emit(mgr2.handleOf(s.id)!, { type: 'assistant_text', text: 'working' });
      await new Promise((r) => setTimeout(r, 10));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`event consumer for ${s.id} failed`), expect.objectContaining({ code: 'SQLITE_BUSY' }));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`could not mark ${s.id} failed`), expect.objectContaining({ code: 'SQLITE_BUSY' }));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      append.mockRestore();
      update.mockRestore();
      error.mockRestore();
    }
  });

  it('marks failed when an error is not followed by turn_end', async () => {
    const { fake, mgr, waitEnded } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'error', message: 'exited with code 1' });
    await fake.end(h);
    const e = await waitEnded();
    expect(e.session.status).toBe('failed');
    expect(e.lastError).toBe('exited with code 1');
  });

  it('keeps the last assistant text and the exit reason when the process dies before turn_end (overseer-xen: worker_status showed the opening line and nothing else)', async () => {
    const { fake, mgr, waitEnded } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'assistant_text', text: 'Starting on it.' });
    fake.emit(h, { type: 'assistant_text', text: 'Merged main; now writing the feature.' });
    fake.emit(h, { type: 'error', message: 'claude exited with code 1' });
    await fake.end(h);
    const e = await waitEnded();
    expect(e.session.status).toBe('failed');
    expect(mgr.status(s.id)).toMatchObject({ state: 'failed', lastText: 'Merged main; now writing the feature.', endReason: 'claude exited with code 1', cost: null });
  });

  it('a clean end records the last text and no reason', async () => {
    const { fake, mgr, waitEnded } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'assistant_text', text: 'All done.' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.3 });
    await waitEnded();
    expect(mgr.status(s.id)).toMatchObject({ state: 'ended', lastText: 'All done.', endReason: null, cost: 0.3 });
  });

  it('a queued send survives one turn_end', async () => {
    const { db, fake, mgr, ended } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    await mgr.send(s.id, 'more');
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 1, output: 2 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(ended).toHaveLength(0);
    expect(mgr.isLive(s.id)).toBe(true);
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 3, output: 4 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(ended).toHaveLength(1);
    expect(db.sessions.get(s.id)).toMatchObject({ input_tokens: 4, output_tokens: 6 });
  });

  it('send records a message event, so an idle-end sweep sees the session as live', async () => {
    const { db, mgr } = setup();
    const s = mgr.start(opts);
    await mgr.send(s.id, 'still there?');
    expect(db.events.lastOfType(s.id, 'message')).toMatchObject({ payload: { text: 'still there?' } });
  });

  it('keepAlive sessions stay up; interrupt ends them', async () => {
    const { fake, mgr, waitEnded } = setup();
    const s = mgr.start({ ...opts, role: 'orchestrator', beadId: null, keepAlive: true });
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'o1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(mgr.isLive(s.id)).toBe(true);
    const p = waitEnded();
    await mgr.interrupt(s.id);
    expect((await p).session.status).toBe('ended');
    expect(fake.sessions.get(h.id)?.interrupted).toBe(true);
  });

  it('records a stop as ended even when the process death is seen before the stop is finished', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new DyingOnInterruptAdapter();
    const mgr = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
    const s = mgr.start(opts);
    await mgr.interrupt(s.id, { by: 'user' });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)?.status).toBe('ended');
  });

  it('a stopped session whose death is seen before end() still ends, not fails', async () => {
    const { fake, mgr, waitEnded } = setup();
    const s = mgr.start(opts);
    const h = mgr.handleOf(s.id)!;
    // What an adopted claude process does when its poller notices the kill first: an exit error, then the stream closes.
    fake.interrupt = async (handle) => { fake.emit(handle, { type: 'error', message: 'claude exited without finishing its turn' }); await fake.end(handle); };
    const p = waitEnded();
    await mgr.interrupt(s.id, { by: 'user' });
    expect((await p).session.status).toBe('ended');
  });

  it('an interrupt followed by a late turn_end leaves the session ended, not failed', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new SingleEndAdapter();
    const mgr2 = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
    const ended = new Promise<SessionEnded>((r) => bus.once('session:ended', r));
    const s = mgr2.start(opts);
    const h = mgr2.handleOf(s.id)!;
    // The turn end is already on the stream when the stop lands; by the time it is read the adapter's handle is gone.
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1' });
    await mgr2.interrupt(s.id, { by: 'user' });
    const e = await ended;
    expect(e.session.status).toBe('ended');
    expect(db.sessions.get(s.id)).toMatchObject({ status: 'ended', end_reason: null });
  });

  it('a failed end can be retried and the second end succeeds', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new FlakyEndAdapter();
    const mgr2 = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
    const ended = new Promise<SessionEnded>((r) => bus.once('session:ended', r));
    const s = mgr2.start(opts);
    await expect(mgr2.end(s.id)).rejects.toThrow('end boom');
    // A throw from the adapter's teardown must not latch the session ended, or no later end could ever retry.
    expect(mgr2.isLive(s.id)).toBe(true);
    await mgr2.end(s.id);
    const e = await ended;
    expect(e.session.status).toBe('ended');
    expect(db.sessions.get(s.id)).toMatchObject({ status: 'ended', end_reason: null });
    expect(mgr2.isLive(s.id)).toBe(false);
  });

  it('an idle end followed by a late turn_end leaves the session ended, not failed', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new SingleEndAdapter();
    const mgr2 = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
    const ended = new Promise<SessionEnded>((r) => bus.once('session:ended', r));
    const s = mgr2.start(opts);
    const h = mgr2.handleOf(s.id)!;
    fake.emit(h, { type: 'assistant_text', text: 'Final report: done.' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1' });
    // The clean-end path the idle-end sweep calls, with the turn end still in flight.
    await mgr2.end(s.id);
    const e = await ended;
    expect(e.session.status).toBe('ended');
    expect(db.sessions.get(s.id)).toMatchObject({ status: 'ended', end_reason: null });
  });

  it('a throwing adapter.interrupt leaves the session unstopped, with no interrupt event', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new FakeAdapter();
    fake.interrupt = async () => { throw new Error('interrupt boom'); };
    const mgr = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
    const s = mgr.start(opts);
    const ended = new Promise<SessionEnded>((r) => bus.once('session:ended', r));
    await expect(mgr.interrupt(s.id, { by: 'user' })).rejects.toThrow('interrupt boom');
    // The signal never went out, so the session is still its own: the stop flag is cleared and no interrupt event is recorded.
    expect(mgr.isLive(s.id)).toBe(true);
    expect(db.events.lastOfType(s.id, 'interrupt')).toBeUndefined();
    // A real stream error with no stop outstanding still settles the session as failed, so the cleared flag is what decided it.
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'error', message: 'exited with code 1' });
    await mgr.end(s.id);
    expect((await ended).session.status).toBe('failed');
  });
});

describe('SessionManager cost estimate', () => {
  it('keeps the reported cost and writes the catalog estimate beside it as reported', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, model: 'claude-sonnet-4-6' });
    fake.emit(mgr.handleOf(s.id)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.5, usage: { input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ cost: 0.5, estimated_cost: (1000 * 3 + 2000 * 15 + 5000 * 0.3 + 400 * 3.75) / 1_000_000, cost_source: 'reported' });
  });

  it('gives a Codex session an estimate only, billing its non-cached input once', async () => {
    const db = openDb(':memory:');
    const codex = new FakeAdapter('codex');
    const mgr = new SessionManager(db, { codex }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra' });
    // Codex `input_tokens` is the total input with the cache counters inside it; 100k with 90k cached + 500 cache-write leaves 9.5k at the input rate.
    codex.emit(mgr.handleOf(s.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 100_000, output: 2000, cacheRead: 90_000, cacheWrite: 500 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ cost: null, estimated_cost: (9_500 * 2 + 2000 * 12 + 90_000 * 0.2 + 500 * 2.5) / 1_000_000, cost_source: 'estimated' });
  });

  it('prices a Claude session from the model id the stream resolves, not the tier alias', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, model: 'fable' }); // the tier alias, which the catalog does not carry
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'context', tokens: 10, model: 'claude-fable-5-1' }); // the resolved id the assistant messages carry
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.5, usage: { input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ model: 'fable', cost: 0.5, estimated_cost: (1000 * 10 + 2000 * 50 + 5000 * 0.25 + 400 * 12.5) / 1_000_000, cost_source: 'reported' });
  });

  it('ignores a <synthetic> context model: the real resolved id stays and still prices the session', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, model: 'fable' });
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'context', tokens: 10, model: 'claude-fable-5-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)?.resolved_model).toBe('claude-fable-5-1');
    // Claude Code stamps its own error messages with `<synthetic>`; that is not a model and must not replace the real id.
    fake.emit(h, { type: 'context', tokens: 10, model: '<synthetic>' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.5, usage: { input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({
      resolved_model: 'claude-fable-5-1',
      estimated_cost: (1000 * 10 + 2000 * 50 + 5000 * 0.25 + 400 * 12.5) / 1_000_000,
      cost_source: 'reported',
    });
  });

  it('does not record <synthetic> as a model when it is the first context event', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, model: 'fable' });
    fake.emit(mgr.handleOf(s.id)!, { type: 'context', tokens: 10, model: '<synthetic>' });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)?.resolved_model).toBeNull();
  });

  it('records a later real resolved model over an earlier one', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, model: 'fable' });
    const h = mgr.handleOf(s.id)!;
    fake.emit(h, { type: 'context', tokens: 10, model: 'claude-fable-5-1' });
    await new Promise((r) => setTimeout(r, 10));
    fake.emit(h, { type: 'context', tokens: 10, model: 'claude-opus-5-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)?.resolved_model).toBe('claude-opus-5-1');
  });

  it('records an unknown model as no estimate, with the reported figure when the CLI gave one', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const noReport = mgr.start({ ...opts, model: 'fable' });
    fake.emit(mgr.handleOf(noReport.id)!, { type: 'context', tokens: 10, model: 'claude-mystery-9' }); // resolved, but absent from the catalog
    fake.emit(mgr.handleOf(noReport.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 1000, output: 2000 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(noReport.id)).toMatchObject({ cost: null, estimated_cost: null, cost_source: 'unknown' });

    const reported = mgr.start({ ...opts, beadId: 'b2', model: 'fable' });
    fake.emit(mgr.handleOf(reported.id)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.2, usage: { input: 1000, output: 2000 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(reported.id)).toMatchObject({ cost: 0.2, estimated_cost: null, cost_source: 'reported' });
  });

  it('prices a Codex session from its final thread-cumulative counters, not by summing each turn', async () => {
    const db = openDb(':memory:');
    const codex = new FakeAdapter('codex');
    const mgr = new SessionManager(db, { codex }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra', keepAlive: true });
    const h = mgr.handleOf(s.id)!;
    // The real CLI reports turn.completed.usage as the thread's running total (2.04M, 3.23M, 4.74M input on a 3-turn
    // session), not that turn's own usage, so the second turn's counters already include the first's.
    codex.emit(h, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 100_000, output: 1000, cacheRead: 0, cacheWrite: 0 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ estimated_cost: (100_000 * 2 + 1000 * 12) / 1_000_000, cost_source: 'estimated', input_tokens: 100_000 });
    codex.emit(h, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 300_000, output: 2500, cacheRead: 0, cacheWrite: 0 } });
    await new Promise((r) => setTimeout(r, 10));
    // The totals are the final snapshot (300k), not the 100k + 300k that accumulating the running totals would store.
    expect(db.sessions.get(s.id)).toMatchObject({ estimated_cost: (300_000 * 2 + 2500 * 12) / 1_000_000, cost_source: 'estimated', input_tokens: 300_000, output_tokens: 2500 });
  });

  it('prices an opencode session per response at the context tier each response selects', async () => {
    const db = openDb(':memory:');
    const opencode = new FakeAdapter('opencode');
    const mgr = new SessionManager(db, { opencode }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, harness: 'opencode', model: 'opencode/claude-sonnet-4-5' });
    // One turn, two responses: one below 200k at the base price, one above at the tier; the aggregate counters match their sum.
    opencode.emit(mgr.handleOf(s.id)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0, usage: { input: 350_000, output: 300 }, requests: [
      { input: 100_000, output: 100 },
      { input: 250_000, output: 200 },
    ] });
    await new Promise((r) => setTimeout(r, 10));
    const base = (100_000 * 3 + 100 * 15) / 1_000_000;
    const tier = (250_000 * 6 + 200 * 22.5) / 1_000_000;
    // Pricing the whole 350k aggregate at one tier would give a different figure; opencode's per-response rule is what matches.
    expect(db.sessions.get(s.id)).toMatchObject({ estimated_cost: base + tier, cost_source: 'reported' });
  });

  it('keeps the codex estimate at the base context tier even above 272k', async () => {
    const db = openDb(':memory:');
    const codex = new FakeAdapter('codex');
    const mgr = new SessionManager(db, { codex }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra' });
    // gpt-5.6-terra's entry carries context_over_200k, but the codex stream reports no per-request context, so base applies.
    codex.emit(mgr.handleOf(s.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 900_000, output: 1000 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ estimated_cost: (900_000 * 2 + 1000 * 12) / 1_000_000, cost_source: 'estimated' });
  });

  it('bills an opencode session\'s reasoning tokens at the catalog output price', async () => {
    const db = openDb(':memory:');
    const opencode = new FakeAdapter('opencode');
    const mgr = new SessionManager(db, { opencode }, new Bus(), LOG_DIR, catalog());
    // This entry carries no `cost.reasoning` at all; opencode's own cost function bills the reasoning slice at the output price.
    const s = mgr.start({ ...opts, harness: 'opencode', model: 'anthropic/claude-sonnet-4-6' });
    opencode.emit(mgr.handleOf(s.id)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0, usage: { input: 9052, output: 73, reasoning: 1000, cacheRead: 1792 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ estimated_cost: (9052 * 3 + (73 + 1000) * 15 + 1792 * 0.3) / 1_000_000, cost_source: 'reported' });
  });

  it('prices a resumed codex session from the thread delta above the counters recorded at resume', async () => {
    const db = openDb(':memory:');
    const codex = new FakeAdapter('codex');
    const mgr = new SessionManager(db, { codex }, new Bus(), LOG_DIR, catalog());
    const first = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra' });
    codex.emit(mgr.handleOf(first.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 100_000, output: 1000 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(first.id)?.estimated_cost).toBeCloseTo((100_000 * 2 + 1000 * 12) / 1_000_000, 12);
    // The continuation resumes the same thread, so the second row's `turn.completed.usage` carries the first session's tokens too.
    const second = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra', resumeId: 'n1' });
    expect(db.sessions.get(second.id)?.usage_baseline).toBe(JSON.stringify({ input: 100_000, output: 1000 }));
    codex.emit(mgr.handleOf(second.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 300_000, output: 2500 } });
    await new Promise((r) => setTimeout(r, 10));
    // Only the delta (input 200k, output 1500) is charged, not the thread's full 300k.
    expect(db.sessions.get(second.id)).toMatchObject({ estimated_cost: (200_000 * 2 + 1500 * 12) / 1_000_000, cost_source: 'estimated', input_tokens: 200_000, output_tokens: 1500 });
  });

  it('stores a resumed codex session\'s own turns, so a bead\'s rows sum to the thread total once', async () => {
    const db = openDb(':memory:');
    const codex = new FakeAdapter('codex');
    const mgr = new SessionManager(db, { codex }, new Bus(), LOG_DIR, catalog());
    const first = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra' });
    codex.emit(mgr.handleOf(first.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 100_000, output: 1000 } });
    await new Promise((r) => setTimeout(r, 10));
    // A first, unresumed session has no baseline, so its row carries the whole thread: unchanged.
    expect(db.sessions.get(first.id)).toMatchObject({ input_tokens: 100_000, output_tokens: 1000, usage_baseline: null });

    const second = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra', resumeId: 'n1' });
    codex.emit(mgr.handleOf(second.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 300_000, output: 2500 } });
    await new Promise((r) => setTimeout(r, 10));
    // The continuation stores its own 200k/1500 delta, not the thread's running 300k/2500.
    expect(db.sessions.get(second.id)).toMatchObject({ input_tokens: 200_000, output_tokens: 1500, usage_baseline: JSON.stringify({ input: 100_000, output: 1000 }) });

    // A second continuation resumes above the thread total the first two rows add up to, not the last row's own counters.
    const third = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra', resumeId: 'n1' });
    expect(db.sessions.get(third.id)?.usage_baseline).toBe(JSON.stringify({ input: 300_000, output: 2500 }));
    codex.emit(mgr.handleOf(third.id)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 400_000, output: 3000 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(third.id)).toMatchObject({ input_tokens: 100_000, output_tokens: 500 });

    // Summing the bead's rows counts the thread once (400k/3000), not once per continuation.
    const rows = db.sessions.forBead('b1');
    expect(rows.map((r) => r.input_tokens)).toEqual([100_000, 200_000, 100_000]);
    expect(rows.reduce((n, r) => n + (r.input_tokens ?? 0), 0)).toBe(400_000);
    expect(rows.reduce((n, r) => n + (r.output_tokens ?? 0), 0)).toBe(3000);
  });

  it('adds a Claude or opencode session\'s per-turn counters to its own row: the codex baseline does not apply to them', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const opencode = new FakeAdapter('opencode');
    const mgr = new SessionManager(db, { claude: fake, opencode }, new Bus(), LOG_DIR, catalog());
    const claude = mgr.start({ ...opts, harness: 'claude', model: 'claude-sonnet-4-6', keepAlive: true, beadId: 'b-claude' });
    const ch = mgr.handleOf(claude.id)!;
    fake.emit(ch, { type: 'turn_end', nativeSessionId: 'c1', usage: { input: 1, output: 2 } });
    await new Promise((r) => setTimeout(r, 10));
    fake.emit(ch, { type: 'turn_end', nativeSessionId: 'c1', usage: { input: 3, output: 4 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(claude.id)).toMatchObject({ input_tokens: 4, output_tokens: 6, usage_baseline: null });

    const oc = mgr.start({ ...opts, harness: 'opencode', model: 'opencode/claude-sonnet-4-5', keepAlive: true, beadId: 'b-opencode' });
    const oh = mgr.handleOf(oc.id)!;
    opencode.emit(oh, { type: 'turn_end', nativeSessionId: 'o1', usage: { input: 100, output: 10 } });
    await new Promise((r) => setTimeout(r, 10));
    opencode.emit(oh, { type: 'turn_end', nativeSessionId: 'o1', usage: { input: 200, output: 20 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(oc.id)).toMatchObject({ input_tokens: 300, output_tokens: 30, usage_baseline: null });
  });

  it('bills a Claude session\'s 1-hour cache-write slice at 2x input, separately from the 5-minute rate', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, model: 'claude-fable-5-1' });
    const h = mgr.handleOf(s.id)!;
    // fixtures/claude.jsonl's result line (input 34, cache_read 43017, output 231, all 43514 cache-write tokens 1h-TTL).
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 34, output: 231, cacheRead: 43_017, cacheWrite: 43_514, cacheWrite1h: 43_514 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)?.estimated_cost).toBeCloseTo(0.89292425, 8);
  });

  it('does not price a session that reported no token counters', async () => {
    const db = openDb(':memory:');
    const codex = new FakeAdapter('codex');
    const mgr = new SessionManager(db, { codex }, new Bus(), LOG_DIR, catalog());
    const s = mgr.start({ ...opts, harness: 'codex', model: 'gpt-5.6-terra' });
    codex.emit(mgr.handleOf(s.id)!, { type: 'turn_end', nativeSessionId: 'n1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get(s.id)).toMatchObject({ cost: null, estimated_cost: null, cost_source: 'unknown' });
  });
});

describe('SessionManager.adopt', () => {
  it('follows an adopted session like a started one: events persist, turn_end ends it, status reads the same fields', async () => {
    const { db, fake, mgr, waitEnded } = setup();
    const row = { ...mgr.start(opts), id: 'lost', pid: 777, pid_started_at: 'earlier', log_path: '/logs/lost.log', log_offset: 12, native_session_id: 'n-old' };
    db.sessions.insert(row);
    db.events.append('lost', 'assistant_text', { type: 'assistant_text', text: 'before the restart' });
    mgr.adopt(row);
    expect(mgr.isLive('lost')).toBe(true);
    const h = mgr.handleOf('lost')!;
    expect(h.pid).toBe(777);
    expect(fake.sessions.get(h.id)?.adopted).toMatchObject({ pid: 777, logFile: '/logs/lost.log', logOffset: 12, nativeSessionId: 'n-old' });
    expect(mgr.status('lost')).toMatchObject({ state: 'running', lastText: 'before the restart', files: [] });
    fake.emit(h, { type: 'file_change', path: 'b.ts' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n-old', cost: 0.3 });
    const e = await waitEnded();
    expect(e.session).toMatchObject({ id: 'lost', status: 'ended', pid: null, cost: 0.3 });
    expect(e.files).toEqual(['b.ts']);
  });

  it('keeps adding to the token totals already on the row instead of restarting them at zero', async () => {
    const { db, fake, mgr, waitEnded } = setup();
    const row = { ...mgr.start(opts), id: 'lost-usage', pid: 780, pid_started_at: 'earlier', log_path: '/logs/lost-usage.log', log_offset: 0,
      input_tokens: 100, output_tokens: 200, cache_read_tokens: 300, cache_write_tokens: 400, reasoning_tokens: 500 };
    db.sessions.insert(row);
    mgr.adopt(row);
    fake.emit(mgr.handleOf('lost-usage')!, { type: 'turn_end', nativeSessionId: 'n-old', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 } });
    await waitEnded();
    expect(db.sessions.get('lost-usage')).toMatchObject({ input_tokens: 101, output_tokens: 202, cache_read_tokens: 303, cache_write_tokens: 404, reasoning_tokens: 505 });
  });

  it('an adopted worker that exits non-zero ends with end_reason persisted, like a started one', async () => {
    const { db, fake, mgr, waitEnded } = setup();
    const row = { ...mgr.start(opts), id: 'lost-fail', pid: 778, pid_started_at: 'earlier', log_path: '/logs/lost-fail.log', log_offset: 0, tier: null, model: null };
    db.sessions.insert(row);
    mgr.adopt(row);
    const h = mgr.handleOf('lost-fail')!;
    fake.emit(h, { type: 'assistant_text', text: 'halfway there' });
    fake.emit(h, { type: 'error', message: 'claude exited with code 1' });
    await fake.end(h);
    const e = await waitEnded();
    expect(e.session).toMatchObject({ id: 'lost-fail', status: 'failed', pid: null, last_text: 'halfway there', end_reason: 'claude exited with code 1' });
    expect(mgr.status('lost-fail')).toMatchObject({ state: 'failed', lastText: 'halfway there', endReason: 'claude exited with code 1' });
  });

  it('start records the pid, log path and batch on the row at spawn time', () => {
    const { db, mgr } = setup();
    const s = mgr.start({ ...opts, batchId: 'r1-b1' });
    expect(db.sessions.get(s.id)).toMatchObject({ pid: 4242, batch_id: 'r1-b1', log_path: path.join(LOG_DIR, `${s.id}.log`), log_offset: 0, tier: null, model: null });
  });

  it('adopting a row with an account forwards that account\'s environment to the adapter (overseer-wcw: an adopted codex worker must keep CODEX_HOME on its next turn)', () => {
    const { db, fake, mgr } = setup();
    db.accounts.insert({ id: 'a1', name: 'work', harness: 'codex', kind: 'codex_home', secret: null, home: 'C:/accounts/a1', created_at: 'now', last_login_at: null, last_verified_at: null });
    const row = { ...mgr.start(opts), id: 'lost-acct', pid: 779, pid_started_at: 'earlier', log_path: '/logs/lost-acct.log', log_offset: 0, account: 'a1' };
    db.sessions.insert(row);
    mgr.adopt(row);
    const h = mgr.handleOf('lost-acct')!;
    expect(fake.sessions.get(h.id)!.adopted).toMatchObject({ env: { CODEX_HOME: 'C:/accounts/a1' } });
  });

  it('records the native id the Claude adapter chose at spawn before any turn ends, and never over a resume id', () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const { bin } = fakeBin('claude-native', 'process.exit(0);');
    const mgr = new SessionManager(db, { claude: new ClaudeAdapter(bin) }, bus, LOG_DIR);
    const row = mgr.start(opts);
    // The real adapter chose the id it passes with `--session-id`; the handle must expose it so the row can be resumed.
    const nativeId = mgr.handleOf(row.id)!.nativeId;
    expect(nativeId).toBeTruthy();
    expect(db.sessions.get(row.id)?.native_session_id).toBe(nativeId);
    expect(row.native_session_id).toBe(nativeId);
    const resumed = mgr.start({ ...opts, resumeId: 'earlier-thread' });
    expect(db.sessions.get(resumed.id)?.native_session_id).toBe('earlier-thread');
  });

  it('records the spawn native id for a worker or critic only, never the orchestrator', () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const { bin } = fakeBin('claude-native-role', 'process.exit(0);');
    const mgr = new SessionManager(db, { claude: new ClaudeAdapter(bin) }, bus, LOG_DIR);
    // A worker or critic is resumed by its spawn id when its first turn is rejected on its login.
    for (const role of ['worker', 'critic'] as const) {
      const row = mgr.start({ ...opts, role });
      expect(db.sessions.get(row.id)?.native_session_id).toBe(mgr.handleOf(row.id)!.nativeId);
    }
    // The orchestrator is not: its resume reads the id a completed turn recorded, since a process that died before its first
    // turn saved no transcript and resuming a spawn-only id fails with "no conversation found" on every message.
    const orchestrator = mgr.start({ ...opts, role: 'orchestrator', beadId: null, repoId: null });
    expect(mgr.handleOf(orchestrator.id)!.nativeId).toBeTruthy();
    expect(db.sessions.get(orchestrator.id)?.native_session_id).toBeNull();
  });

  it('a harness that reports no native id at spawn keeps waiting for turn_end', () => {
    const { db, fake, mgr } = setup();
    const row = mgr.start(opts);
    expect(db.sessions.get(row.id)?.native_session_id).toBeNull();
    expect(fake.sessions.get(mgr.handleOf(row.id)!.id)!.opts.resumeId).toBeUndefined();
  });

  it('an adopted session whose recorded stream carried auth_failed still ends with the auth signal', async () => {
    const { db, fake, mgr, waitEnded } = setup();
    const row = { ...mgr.start(opts), id: 'lost-auth', pid: 785, pid_started_at: 'earlier', log_path: '/logs/lost-auth.log', log_offset: 0 };
    db.sessions.insert(row);
    // The previous daemon's consumer recorded the structured signal before it died; the adopted log replays no further turn.
    db.events.append('lost-auth', 'auth_failed', { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401', error: 'authentication_failed' });
    mgr.adopt(row);
    const ended = waitEnded();
    await fake.end(mgr.handleOf('lost-auth')!);
    const e = await ended;
    expect(e.authFailed).toBe(true);
    expect(e.lastError).toBeNull();
    expect(db.sessions.get('lost-auth')?.status).toBe('ended');
  });

  it('records auth_resumed on a session started as an auth resume and keeps it across adoption', () => {
    const { db, mgr } = setup();
    expect(db.sessions.get(mgr.start(opts).id)?.auth_resumed ?? null).toBeNull();
    const row = { ...mgr.start({ ...opts, authResumed: true }), id: 'lost-resume', pid: 783, pid_started_at: 'earlier', log_path: '/logs/lost-resume.log', log_offset: 0 };
    expect(row.auth_resumed).toBe(1);
    db.sessions.insert(row);
    mgr.adopt(row);
    expect(db.sessions.get('lost-resume')?.auth_resumed).toBe(1);
  });

  it('keeps the token expiry recorded before the restart on an adopted session', async () => {
    const { db, fake, mgr } = setup();
    const expiry = 1_800_000_000_000;
    const row = { ...mgr.start({ ...opts, tokenExpiresAt: expiry }), id: 'lost-token', pid: 782, pid_started_at: 'earlier', log_path: '/logs/lost-token.log', log_offset: 0 };
    db.sessions.insert(row);
    mgr.adopt(row);
    expect(db.sessions.get('lost-token')?.token_expires_at).toBe(expiry);
    await fake.end(mgr.handleOf('lost-token')!);
    expect(db.sessions.get('lost-token')?.token_expires_at).toBe(expiry);
  });

  it('prices an adopted session from the resolved model persisted before the restart', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const row = { ...mgr.start({ ...opts, model: 'fable' }), id: 'lost-resolved', pid: 781, pid_started_at: 'earlier', log_path: '/logs/lost-resolved.log', log_offset: 0,
      resolved_model: 'claude-fable-5-1', input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 5000, cache_write_tokens: 400 };
    db.sessions.insert(row);
    mgr.adopt(row);
    // It ends without emitting another context event; the persisted resolved id still prices it.
    await fake.end(mgr.handleOf('lost-resolved')!);
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get('lost-resolved')).toMatchObject({ status: 'ended', estimated_cost: (1000 * 10 + 2000 * 50 + 5000 * 0.25 + 400 * 12.5) / 1_000_000, cost_source: 'estimated' });
  });

  it('does not overwrite an estimate a previous daemon wrote when the resolved model is a tier alias the catalog lacks', async () => {
    const db = openDb(':memory:');
    const fake = new FakeAdapter();
    const mgr = new SessionManager(db, { claude: fake }, new Bus(), LOG_DIR, catalog());
    const written = 0.5;
    const row = { ...mgr.start({ ...opts, model: 'sonnet' }), id: 'lost-alias', pid: 782, pid_started_at: 'earlier', log_path: '/logs/lost-alias.log', log_offset: 0,
      input_tokens: 1000, output_tokens: 2000, estimated_cost: written, cost_source: 'estimated' as const };
    db.sessions.insert(row);
    mgr.adopt(row);
    await fake.end(mgr.handleOf('lost-alias')!);
    await new Promise((r) => setTimeout(r, 10));
    expect(db.sessions.get('lost-alias')).toMatchObject({ estimated_cost: written, cost_source: 'estimated' });
  });
});
