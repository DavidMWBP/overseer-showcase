import { afterEach, describe, expect, it, vi } from 'vitest';
import * as procs from '../util/procs';
import type { LineProcess } from '../util/procs';
import { BaseAdapter, TurnSession } from './base';
import type { AdoptOpts, HarnessEvent, StartOpts } from './types';

/** One turn whose CLI exits when the test calls `exit`. */
interface Turn { text: string; proc: LineProcess; exit: (code?: number) => void }

function turnProcess(pid: number | undefined): { proc: LineProcess; exit: (code?: number) => void } {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => { exit = r; });
  return { proc: { pid, stdin: null, lines: (async function* () {})(), exit: exited, logOffset: () => 0 }, exit: (code = 0) => exit(code) };
}

class TestSession extends TurnSession {
  protected readonly harness = 'codex' as const;
  readonly turns: Turn[] = [];
  /** Makes the next `end()` throw once, like an adapter whose teardown failed. */
  failNextEnd = false;

  constructor(logFile: string | undefined, id: string, private cliPid = 7) { super(logFile, id); }

  protected runTurn(text: string): void {
    const t = turnProcess(this.cliPid);
    this.turns.push({ text, ...t });
    this.follow(t.proc, false);
  }

  protected async pump(p: LineProcess, adopted: boolean): Promise<void> {
    await this.processStarted(p, adopted);
    await p.exit;
    this.proc = null;
    this.finishTurn({ type: 'turn_end', nativeSessionId: `after ${this.turns.length}` });
  }

  override async end(): Promise<void> {
    if (this.failNextEnd) { this.failNextEnd = false; throw new Error('teardown failed'); }
    await super.end();
  }

  get started(): number | undefined { return this.startedAt; }
}

class TestAdapter extends BaseAdapter<TestSession> {
  readonly name = 'codex' as const;
  readonly created: TestSession[] = [];
  constructor(private logFile?: string) { super(); }
  protected create(id: string, _opts: StartOpts): TestSession { return this.track(new TestSession(this.logFile, id)); }
  protected createAdopted(id: string, o: AdoptOpts): TestSession { return this.track(new TestSession(o.logFile, id)); }
  private track(s: TestSession): TestSession { this.created.push(s); return s; }
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.restoreAllMocks(); });

describe('BaseAdapter handle map', () => {
  it('start sends the prompt to a new session and returns its handle', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue('2026-09-23T01:00:00.000Z');
    const a = new TestAdapter();
    const h = a.start({ cwd: '/w', prompt: 'go' });
    expect(h.pid).toBe(7);
    expect(a.created[0]!.turns.map((t) => t.text)).toEqual(['go']);
    const second = a.start({ cwd: '/w', prompt: 'other' });
    expect(second.id).not.toBe(h.id);
  });

  it('adopt follows the pid it is given and reports no process_start for it', async () => {
    const adopted = turnProcess(4242);
    vi.spyOn(procs, 'adoptLines').mockReturnValue(adopted.proc);
    vi.spyOn(procs, 'processStartTime').mockResolvedValue('2026-09-23T01:00:00.000Z');
    const a = new TestAdapter();
    const h = a.adopt({ pid: 4242, cwd: '/w', logFile: '/data/sessions/row-1.log', logOffset: 12, nativeSessionId: null });
    expect(h.pid).toBe(4242);
    expect(procs.adoptLines).toHaveBeenCalledWith({ pid: 4242, logFile: '/data/sessions/row-1.log', offset: 12, pollMs: undefined });
    await flush();
    adopted.exit();
    const endP = a.end(h);
    const events = await collect(a.events(h));
    await endP;
    expect(events.map((e) => e.type)).toEqual(['turn_end']);
  });

  it('every call on a handle it does not hold throws, naming the harness', async () => {
    const a = new TestAdapter();
    const h = { id: 'missing' };
    await expect(a.send(h, 'x')).rejects.toThrow('codex session missing not found');
    await expect(a.interrupt(h)).rejects.toThrow('codex session missing not found');
    await expect(a.end(h)).rejects.toThrow('codex session missing not found');
    expect(() => a.events(h)).toThrow('codex session missing not found');
  });

  it('end drops the handle, so a second end on it throws', async () => {
    const a = new TestAdapter();
    vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    const h = a.start({ cwd: '/w', prompt: 'go' });
    a.created[0]!.turns[0]!.exit();
    await flush();
    await a.end(h);
    await expect(a.end(h)).rejects.toThrow(`codex session ${h.id} not found`);
  });

  it('a failed end keeps the handle, so the end can be retried', async () => {
    const a = new TestAdapter();
    vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    const h = a.start({ cwd: '/w', prompt: 'go' });
    a.created[0]!.turns[0]!.exit();
    await flush();
    a.created[0]!.failNextEnd = true;
    await expect(a.end(h)).rejects.toThrow('teardown failed');
    await expect(a.end(h)).resolves.toBeUndefined();
    await expect(a.end(h)).rejects.toThrow('not found');
  });
});

describe('TurnSession turns', () => {
  it('reports process_start with the start time, and dates startedAt from it', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue('2026-09-23T01:00:00.000Z');
    const s = new TestSession(undefined, 'h1');
    s.send('go');
    await flush();
    expect(s.started).toBe(Date.parse('2026-09-23T01:00:00.000Z'));
    s.turns[0]!.exit();
    const endP = (async () => { await flush(); await s.end(); })();
    const events = await collect(s.queue);
    await endP;
    expect(events).toEqual([{ type: 'process_start', pid: 7, pidStartedAt: '2026-09-23T01:00:00.000Z' }, { type: 'turn_end', nativeSessionId: 'after 1' }]);
  });

  it('dates startedAt from the spawn when the start time cannot be read, and reports no process_start without a pid', async () => {
    const lookup = vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    const before = Date.now();
    const s = new TestSession(undefined, 'h1', 0);
    s.send('go');
    await flush();
    expect(lookup).not.toHaveBeenCalled();
    expect(s.started).toBeGreaterThanOrEqual(before);
    expect(s.started).toBeLessThanOrEqual(Date.now());
    s.turns[0]!.exit();
    await flush();
    await s.end();
    expect((await collect(s.queue)).map((e) => e.type)).toEqual(['turn_end']);
  });

  it('a message sent during a turn waits for it, then runs as the next turn in order', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    const s = new TestSession(undefined, 'h1');
    s.send('first');
    s.send('second');
    s.send('third');
    expect(s.turns.map((t) => t.text)).toEqual(['first']);
    s.turns[0]!.exit();
    await vi.waitFor(() => expect(s.turns).toHaveLength(2));
    expect(s.turns[1]!.text).toBe('second');
    s.turns[1]!.exit();
    await vi.waitFor(() => expect(s.turns).toHaveLength(3));
    expect(s.turns[2]!.text).toBe('third');
  });

  it('a message sent between turns starts a turn at once', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    const s = new TestSession(undefined, 'h1');
    s.send('first');
    s.turns[0]!.exit();
    await flush();
    s.send('later');
    expect(s.turns.map((t) => t.text)).toEqual(['first', 'later']);
  });

  it('end during a turn drops waiting messages, waits for the CLI and closes after its turn_end', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    const s = new TestSession(undefined, 'h1');
    s.send('first');
    s.send('dropped');
    const ended = s.end();
    let done = false;
    void ended.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    s.turns[0]!.exit();
    await ended;
    const events = await collect(s.queue);
    expect(events.map((e) => e.type)).toEqual(['process_start', 'turn_end']);
    expect(s.turns.map((t) => t.text)).toEqual(['first']);
  });

  it('end with no turn running closes the queue at once', async () => {
    const s = new TestSession(undefined, 'h1');
    await s.end();
    expect(await collect(s.queue)).toEqual([]);
  });

  it('interrupt kills the CLI and sweeps, labelled with the session row id from the log file name', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue('2026-09-23T01:00:00.000Z');
    const kill = vi.spyOn(procs, 'killProcess').mockResolvedValue();
    const sweep = vi.spyOn(procs, 'sweepProcessTree').mockResolvedValue();
    const s = new TestSession('/data/sessions/row-9.log', 'handle-uuid');
    s.send('go');
    await flush();
    await s.interrupt();
    expect(kill).toHaveBeenCalledWith(7, Date.parse('2026-09-23T01:00:00.000Z'));
    expect(sweep).toHaveBeenCalledWith({ pid: 7, startedAt: Date.parse('2026-09-23T01:00:00.000Z'), logFile: '/data/sessions/row-9.log', label: 'codex session row-9 (pid 7) was interrupted' });
  });

  it('interrupt without a log file labels the session with its handle id', async () => {
    vi.spyOn(procs, 'processStartTime').mockResolvedValue(null);
    vi.spyOn(procs, 'killProcess').mockResolvedValue();
    const sweep = vi.spyOn(procs, 'sweepProcessTree').mockResolvedValue();
    const s = new TestSession(undefined, 'handle-uuid');
    s.send('go');
    await flush();
    await s.interrupt();
    expect(sweep.mock.calls[0]![0].label).toBe('codex session handle-uuid (pid 7) was interrupted');
  });

  it('interrupt before any process started neither kills nor sweeps', async () => {
    const kill = vi.spyOn(procs, 'killProcess').mockResolvedValue();
    const sweep = vi.spyOn(procs, 'sweepProcessTree').mockResolvedValue();
    await new TestSession(undefined, 'h1').interrupt();
    expect(kill).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });
});
