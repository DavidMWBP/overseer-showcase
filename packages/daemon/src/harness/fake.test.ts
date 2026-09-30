import { describe, it, expect } from 'vitest';
import { FakeAdapter } from './fake';

describe('FakeAdapter', () => {
  it('replays a script and records sends', async () => {
    const fake = new FakeAdapter();
    const h = fake.start({ cwd: '.', prompt: 'go' });
    fake.emit(h, { type: 'assistant_text', text: 'hi' });
    fake.emit(h, { type: 'turn_end', nativeSessionId: 'n1' });
    await fake.send(h, 'more');
    await fake.end(h);
    const types: string[] = [];
    for await (const e of fake.events(h)) types.push(e.type);
    expect(types).toEqual(['process_start', 'assistant_text', 'turn_end']);
    expect(fake.sent(h)).toEqual(['go', 'more']);
  });
});
