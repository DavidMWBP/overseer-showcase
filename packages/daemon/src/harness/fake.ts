import { randomUUID } from 'node:crypto';
import { EventQueue } from '../util/queue';
import type { HarnessName } from '@overseer/shared';
import type { AdoptOpts, HarnessAdapter, HarnessEvent, SessionHandle, StartOpts } from './types';

interface FakeSession { queue: EventQueue<HarnessEvent>; sent: string[]; opts: StartOpts; interrupted: boolean; adopted?: AdoptOpts }

export class FakeAdapter implements HarnessAdapter {
  readonly sessions = new Map<string, FakeSession>();
  /** Tests register a second fake under another name so tier resolution to that harness can start a session. */
  constructor(public name: HarnessName = 'claude') {}

  start(opts: StartOpts): SessionHandle {
    const id = randomUUID();
    const s: FakeSession = { queue: new EventQueue(), sent: [opts.prompt], opts, interrupted: false };
    this.sessions.set(id, s);
    s.queue.push({ type: 'process_start', pid: 4242, pidStartedAt: 'fake' });
    return { id, pid: 4242 };
  }
  adopt(o: AdoptOpts): SessionHandle {
    const id = randomUUID();
    this.sessions.set(id, { queue: new EventQueue(), sent: [], opts: { cwd: o.cwd, prompt: '' }, interrupted: false, adopted: o });
    return { id, pid: o.pid };
  }
  emit(h: SessionHandle, ev: HarnessEvent): void { this.get(h).queue.push(ev); }
  sent(h: SessionHandle): string[] { return this.get(h).sent; }
  async send(h: SessionHandle, text: string): Promise<void> { this.get(h).sent.push(text); }
  async interrupt(h: SessionHandle): Promise<void> { this.get(h).interrupted = true; }
  async end(h: SessionHandle): Promise<void> { this.get(h).queue.close(); }
  events(h: SessionHandle): AsyncIterable<HarnessEvent> { return this.get(h).queue; }
  private get(h: SessionHandle): FakeSession {
    const s = this.sessions.get(h.id);
    if (!s) throw new Error(`fake session ${h.id} not found`);
    return s;
  }
}
