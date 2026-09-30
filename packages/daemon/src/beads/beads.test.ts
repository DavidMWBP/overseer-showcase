import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Beads, parseBead, LIST_TTL_MS, type BdRunner } from './beads';
import { blockersOf, dependentsOf } from './store';

const fixture = (n: string) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

function fakeRunner(responses: Record<string, string>) {
  const calls: { cwd: string; args: string[] }[] = [];
  const run: BdRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.slice(0, 2).join(' ');
    return { code: 0, stdout: responses[key] ?? responses[args[0]!] ?? '', stderr: '' };
  };
  return { run, calls };
}

describe('Beads', () => {
  it('lists with one --all call, no row limit, --json and repo cwd', async () => {
    const f = fakeRunner({ 'list --all': fixture('list.json') });
    const beads = await new Beads(f.run).list('/repo');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ cwd: '/repo', args: ['list', '--all', '-n', '0', '--json'] });
    expect(beads.length).toBeGreaterThan(0);
    expect(beads[0]).toMatchObject({ id: 'ov-327', status: 'closed', closed_at: '2026-09-12T17:05:47Z', dependency_count: 0 });
  });
  it('serves a repeated list from memory, and drops it when .beads changed on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-beads-cache-'));
    fs.mkdirSync(path.join(dir, '.beads'));
    const touched = path.join(dir, '.beads', 'last-touched');
    fs.writeFileSync(touched, 'ov-327');
    const f = fakeRunner({ 'list --all': fixture('list.json') });
    const b = new Beads(f.run);
    const first = await b.list(dir);
    expect(f.calls.filter((c) => c.args[0] === 'list')).toHaveLength(1);
    expect(await b.list(dir)).toEqual(first);
    expect(f.calls.filter((c) => c.args[0] === 'list')).toHaveLength(1); // still one bd read
    // An outside write (a worker's own bd call) moves last-touched: the next read refetches instead of trusting the cache.
    fs.writeFileSync(touched, 'ov-1');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(touched, future, future);
    await b.list(dir);
    expect(f.calls.filter((c) => c.args[0] === 'list')).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('refetches after the TTL even when nothing on disk moved, so a write that leaves no file signal is caught', async () => {
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    try {
      const f = fakeRunner({ 'list --all': fixture('list.json') });
      const b = new Beads(f.run);
      await b.list('/repo');
      await b.list('/repo');
      expect(f.calls.filter((c) => c.args[0] === 'list')).toHaveLength(1);
      t += LIST_TTL_MS + 1;
      await b.list('/repo');
      expect(f.calls.filter((c) => c.args[0] === 'list')).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });
  it('caches a positive available() for 60 s', async () => {
    const f = fakeRunner({});
    const b = new Beads(f.run);
    expect(await b.available()).toBe(true);
    expect(await b.available()).toBe(true);
    expect(f.calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
  });
  it('issues the documented argument lists', async () => {
    const f = fakeRunner({ show: fixture('show.json'), ready: '[{"id":"ov-1"}]' });
    const b = new Beads(f.run);
    await b.update('/r', 'ov-1', { status: 'in_progress' });
    await b.update('/r', 'ov-1', { note: 'note' });
    await b.close('/r', 'ov-1', 'merged');
    expect(await b.ready('/r')).toEqual(['ov-1']);
    expect(f.calls.map((c) => c.args)).toEqual([
      ['update', 'ov-1', '--status', 'in_progress', '--json'],
      ['update', 'ov-1', '--append-notes', 'note', '--json'],
      ['close', 'ov-1', '--reason', 'merged', '--json'],
      ['ready', '--json'],
    ]);
  });
  it('update writes status, phase and note in one bd call without reading the bead first', async () => {
    const f = fakeRunner({});
    const b = new Beads(f.run);
    await b.update('/r', 'ov-1', { status: 'open', phase: 'review', note: 'Rejected: x' });
    await b.update('/r', 'ov-1', { phase: null });
    const remove = (phases: string[]) => phases.flatMap((p) => ['--remove-label', `overseer:${p}`]);
    expect(f.calls.map((c) => c.args)).toEqual([
      ['update', 'ov-1', '--status', 'open', ...remove(['verifying', 'merged', 'rejected', 'abandoned', 'closed', 'verified', 'worker-reported']), '--add-label', 'overseer:review', '--append-notes', 'Rejected: x', '--json'],
      ['update', 'ov-1', ...remove(['verifying', 'review', 'merged', 'rejected', 'abandoned', 'closed', 'verified', 'worker-reported']), '--json'],
    ]);
  });
  it('runs reads of one repo alongside each other and writes alone, in call order', async () => {
    const started: string[] = [];
    let active = 0, maxActive = 0;
    const run: BdRunner = async (_cwd, args) => {
      started.push(args[0]!); active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10)); active--;
      return { code: 0, stdout: args[0] === 'update' ? '' : '[]', stderr: '' };
    };
    const b = new Beads(run);
    // A different repo warms the concurrency check: a second list of the same repo would now be served from the cache.
    await Promise.all([b.ready('/warm'), b.list('/warm'), b.show('/warm', 'ov-1')]);
    expect(maxActive).toBe(3);
    maxActive = 0; started.length = 0;
    // list ‖ show, then the write, then the list issued after the write; the other repo's list is not held up.
    await Promise.all([b.list('/r'), b.show('/r', 'ov-1'), b.update('/r', 'ov-1', { status: 'open' }), b.list('/r'), b.list('/other')]);
    expect(maxActive).toBe(3); // list, show and the other repo's list; the write and the later list waited
    expect(started.slice(0, 3).sort()).toEqual(['list', 'list', 'show']);
    expect(started.slice(3)).toEqual(['update', 'list']);
  });
  it('carries both directions of the blocked relation in one `bd blocked` read (bd show carries only a count)', async () => {
    const blocked = JSON.stringify([{ id: 'ov-2', blocked_by: ['ov-1'] }, { id: 'ov-3', blocked_by: ['ov-1', 'ov-2'] }, { id: 'ov-4', blocked_by: ['ov-9'] }]);
    const f = fakeRunner({ blocked });
    const rows = await new Beads(f.run).blocked('/r');
    expect(f.calls[0]).toMatchObject({ cwd: '/r', args: ['blocked', '--json'] });
    // What waited on a bead, for the close notice, and what a bead waits on, for its own pane (round 25 R25-4) — from the one read.
    expect(dependentsOf(rows, 'ov-1')).toEqual(['ov-2', 'ov-3']);
    expect(blockersOf(rows, 'ov-3')).toEqual(['ov-1', 'ov-2']);
    expect(blockersOf(rows, 'ov-1')).toEqual([]);
    expect(await new Beads(fakeRunner({ blocked: '' }).run).blocked('/r')).toEqual([]);
  });

  it('show answers null for bd 1.2.2\'s "no issue found matching" (exit 1) and still throws on other failures (round 15)', async () => {
    const run: BdRunner = async (_cwd, args) => args[1] === 'ov-9'
      ? { code: 1, stdout: '{"error":"no issues found matching the provided IDs"}', stderr: 'Error fetching ov-9: no issue found matching "ov-9"' }
      : { code: 1, stdout: '', stderr: 'database is locked' };
    const b = new Beads(run);
    expect(await b.show('/r', 'ov-9')).toBeNull();
    await expect(b.show('/r', 'ov-1')).rejects.toThrow(/database is locked/);
  });

  it('parseBead tolerates label shapes', () => {
    expect(parseBead({ id: 'x', labels: [{ label: 'a' }, 'b'] }).labels).toEqual(['a', 'b']);
    expect(parseBead({ id: 'x' })).toMatchObject({ title: '', status: 'open', priority: 2, notes: '', assignee: null });
  });
});

describe('Beads.init', () => {
  it('passes the exact arguments and surfaces failures', async () => {
    const calls: { cwd: string; args: string[] }[] = [];
    let code = 0;
    const run: BdRunner = async (cwd, args) => { calls.push({ cwd, args }); return { code, stdout: '', stderr: 'no dolt' }; };
    const b = new Beads(run);
    await b.init('/r', 'demo', 'stealth');
    await b.init('/r', 'demo', 'commit');
    expect(calls).toEqual([
      { cwd: '/r', args: ['init', '--prefix', 'demo', '--non-interactive', '--stealth'] },
      { cwd: '/r', args: ['init', '--prefix', 'demo', '--non-interactive'] },
    ]);
    code = 1;
    await expect(b.init('/r', 'demo', 'stealth')).rejects.toThrow('bd init failed: no dolt');
  });
});
