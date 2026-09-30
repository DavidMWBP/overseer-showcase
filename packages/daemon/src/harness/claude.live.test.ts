import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeAdapter } from './claude';

describe.skipIf(process.env.OVERSEER_LIVE !== '1')('ClaudeAdapter (live)', () => {
  it('creates a file, stays alive after turn_end, ends on end()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claude-live-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const a = new ClaudeAdapter();
    const h = a.start({ cwd: dir, prompt: 'Create a file named hello.txt containing the single word hi. Then stop.' });
    const types: string[] = [];
    let turnEnds = 0;
    let done = false;
    const consumer = (async () => { for await (const e of a.events(h)) { types.push(e.type); if (e.type === 'turn_end') turnEnds++; } done = true; })();
    while (turnEnds < 1) await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(path.join(dir, 'hello.txt'))).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(done).toBe(false);
    await a.send(h, 'Now append the word there to hello.txt. Then stop.');
    while (turnEnds < 2) await new Promise((r) => setTimeout(r, 200));
    expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toMatch(/there/);
    await a.end(h);
    await consumer;
    expect(done).toBe(true);
    expect(types.filter((t) => t === 'process_start')).toHaveLength(1);
  }, 240_000);
});
