import { describe, it, expect } from 'vitest';
import type { OfficeSession, SessionRow } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { Office } from './office';

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1', harness: 'claude', role: 'worker', bead_id: 'r-1', repo_id: 'r', native_session_id: null,
    pid: 1, pid_started_at: 't', start_commit: null, cwd: '/w', status: 'running', started_at: '2026-09-17T10:00:00.000Z',
    ended_at: null, cost: null, batch_id: 'r-b1', log_path: null, log_offset: 0, tier: 'standard', model: 'sonnet', account: null,
    bead_title: 'Do the thing', ...over,
  };
}

function setup() {
  const db = openDb(':memory:');
  const bus = new Bus();
  const office = new Office(db, bus);
  const seen: OfficeSession[] = [];
  bus.on('office', (s) => seen.push(s));
  const emitStart = (row: SessionRow) => { db.sessions.insert(row); bus.emit('session:started', row); };
  return { db, bus, office, seen, emitStart };
}

describe('Office', () => {
  it('walks a worker in on session start, with the bead, batch, repo, model and account label it carries', () => {
    const { db, emitStart, seen } = setup();
    db.accounts.insert({ id: 'a1', name: 'work', label: 'Work account', harness: 'claude', kind: 'oauth_token', secret: null, home: null, created_at: 'now', last_login_at: null, last_verified_at: null });
    const row = sessionRow({ account: 'a1' });
    emitStart(row);
    expect(seen).toEqual([{
      session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: 'Work account',
      bead_id: 'r-1', bead_title: 'Do the thing', batch_id: 'r-b1', repo_id: 'r', state: 'walking_in', stalled_since: null,
    }]);
  });

  it('re-sends the character with the resolved model when the harness reports it, without changing its state', () => {
    const { bus, emitStart, seen } = setup();
    emitStart(sessionRow({ model: null }));
    seen.length = 0;
    bus.emit('event', { id: 3, session_id: 's1', seq: 3, type: 'context', payload: { tokens: 100, model: 'claude-opus-5' }, ts: 't' });
    expect(seen).toEqual([expect.objectContaining({ session_id: 's1', model: null, resolved_model: 'claude-opus-5', state: 'walking_in' })]);
  });

  it('ignores a repeated resolved model so it does not re-send the character on every request', () => {
    const { bus, emitStart, seen } = setup();
    emitStart(sessionRow({ model: null, resolved_model: 'claude-opus-5' }));
    seen.length = 0;
    bus.emit('event', { id: 3, session_id: 's1', seq: 3, type: 'context', payload: { tokens: 100, model: 'claude-opus-5' }, ts: 't' });
    expect(seen).toEqual([]);
  });

  it('types on a tool call and stops at the first one repeated', () => {
    const { bus, emitStart, seen } = setup();
    emitStart(sessionRow());
    bus.emit('event', { id: 1, session_id: 's1', seq: 1, type: 'tool_call', payload: { name: 'Read' }, ts: 't' });
    bus.emit('event', { id: 2, session_id: 's1', seq: 2, type: 'tool_call', payload: { name: 'Edit' }, ts: 't' });
    expect(seen.map((s) => s.state)).toEqual(['walking_in', 'working']);
  });

  it('puts a critic at review and keeps it there through its tool calls', () => {
    const { bus, emitStart, seen } = setup();
    emitStart(sessionRow({ id: 'c1', role: 'critic', model: 'fable' }));
    bus.emit('event', { id: 1, session_id: 'c1', seq: 1, type: 'tool_call', payload: { name: 'Read' }, ts: 't' });
    expect(seen.map((s) => s.state)).toEqual(['reviewing']);
  });

  it('moves the bead to the printer for the verification between sessions, then off it', () => {
    const { bus, emitStart, seen } = setup();
    emitStart(sessionRow());
    bus.emit('session:ended', { session: { ...sessionRow(), status: 'ended', ended_at: 't' }, lastText: null, lastError: null, files: [] });
    bus.emit('bead:verify', { bead_id: 'r-1', status: 'running' });
    bus.emit('bead:verify', { bead_id: 'r-1', status: 'pass' });
    expect(seen.map((s) => s.state)).toEqual(['walking_in', 'leaving', 'verifying', 'leaving']);
    expect(seen[2]).toMatchObject({ session_id: 's1', bead_id: 'r-1', state: 'verifying' });
  });

  it('attributes a verification to the worker, not the critic that reviewed the bead', () => {
    const { bus, emitStart, seen } = setup();
    emitStart(sessionRow({ id: 'w1', role: 'worker', model: 'sonnet' }));
    emitStart(sessionRow({ id: 'c1', role: 'critic', model: 'fable', started_at: '2026-09-17T11:00:00.000Z' }));
    seen.length = 0;
    bus.emit('bead:verify', { bead_id: 'r-1', status: 'running' });
    expect(seen).toEqual([expect.objectContaining({ session_id: 'w1', role: 'worker', model: 'sonnet', state: 'verifying' })]);
  });

  it('leaves when a session ends, and drops it from the snapshot', () => {
    const { db, bus, office, emitStart, seen } = setup();
    emitStart(sessionRow());
    expect(office.snapshot()).toHaveLength(1);
    db.sessions.update('s1', { status: 'ended', ended_at: 't' }); // SessionManager.finish updates the row before it emits
    bus.emit('session:ended', { session: { ...sessionRow(), status: 'ended', ended_at: 't' }, lastText: null, lastError: null, files: [] });
    expect(seen.at(-1)).toMatchObject({ session_id: 's1', state: 'leaving' });
    expect(office.snapshot()).toEqual([]);
  });

  it('leaves when recovery reaps a lost session, which emits no session:ended', () => {
    const { db, bus, emitStart, seen } = setup();
    emitStart(sessionRow());
    db.sessions.update('s1', { status: 'ended', ended_at: 't' }); // recovery writes `ended` straight onto a lost row
    bus.emit('session:reaped', { ...sessionRow(), status: 'ended', ended_at: 't' });
    expect(seen.at(-1)).toMatchObject({ session_id: 's1', state: 'leaving' });
  });

  it('seeds its snapshot from the sessions already running (a restart with adopted workers)', () => {
    const db = openDb(':memory:');
    db.sessions.insert(sessionRow({ id: 'o1', role: 'orchestrator', bead_id: null, bead_title: null, batch_id: null }));
    const office = new Office(db, new Bus());
    expect(office.snapshot()).toEqual([expect.objectContaining({ session_id: 'o1', role: 'orchestrator', state: 'walking_in' })]);
  });

  it('reconciles the snapshot against the running rows, so a session recovery ended without session:ended leaves no ghost', () => {
    const { db, emitStart, office } = setup();
    emitStart(sessionRow());
    db.sessions.update('s1', { status: 'ended', ended_at: 't' }); // recovery writes `ended` straight onto a lost row, with no bus event
    db.sessions.insert(sessionRow({ id: 'adopted', role: 'orchestrator', bead_id: null, bead_title: null, batch_id: null, started_at: '2026-09-17T09:00:00.000Z' }));
    expect(office.snapshot().map((s) => s.session_id)).toEqual(['adopted']);
  });

  it('marks a session the stall sweep names, publishing the time and keeping its pose', () => {
    const { bus, office, emitStart, seen } = setup();
    emitStart(sessionRow());
    bus.emit('event', { id: 1, session_id: 's1', seq: 1, type: 'tool_call', payload: { name: 'Read' }, ts: 't' });
    seen.length = 0;
    office.setStalled(['s1']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ session_id: 's1', state: 'working', stalled_since: expect.any(String) });
    expect(Number.isNaN(Date.parse(seen[0]!.stalled_since!))).toBe(false);
  });

  it('publishes nothing while the sweep keeps naming an already-stalled session', () => {
    const { office, emitStart, seen } = setup();
    emitStart(sessionRow());
    office.setStalled(['s1']);
    seen.length = 0;
    office.setStalled(['s1']);
    expect(seen).toEqual([]);
  });

  it('clears the mark on the session’s next event and publishes the clear, without changing its pose', () => {
    const { bus, office, emitStart, seen } = setup();
    emitStart(sessionRow());
    bus.emit('event', { id: 1, session_id: 's1', seq: 1, type: 'tool_call', payload: { name: 'Read' }, ts: 't' });
    office.setStalled(['s1']);
    seen.length = 0;
    bus.emit('event', { id: 2, session_id: 's1', seq: 2, type: 'assistant_text', payload: { text: 'back' }, ts: 't' });
    expect(seen).toEqual([expect.objectContaining({ session_id: 's1', state: 'working', stalled_since: null })]);
  });

  it('clears the mark on a later sweep that no longer names the session', () => {
    const { office, emitStart, seen } = setup();
    emitStart(sessionRow());
    office.setStalled(['s1']);
    seen.length = 0;
    office.setStalled([]);
    expect(seen).toEqual([expect.objectContaining({ session_id: 's1', stalled_since: null })]);
  });

  it('carries the stall mark in the snapshot a new socket receives', () => {
    const { office, emitStart } = setup();
    emitStart(sessionRow());
    office.setStalled(['s1']);
    expect(office.snapshot()[0]!.stalled_since).toEqual(expect.any(String));
  });
});
