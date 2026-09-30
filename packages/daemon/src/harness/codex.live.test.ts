import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexAdapter } from './codex';
import { commandExists } from '../util/procs';

// Spends tokens; needs OVERSEER_LIVE=1 and the codex CLI on PATH. The model is the default chore tier's,
// because a ChatGPT-account codex rejects some models a local config may default to.
describe.skipIf(process.env.OVERSEER_LIVE !== '1' || !commandExists('codex'))('CodexAdapter (live)', () => {
  it('starts the turn without waiting for stdin and reaches turn_end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codex-live-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const logFile = path.join(dir, 'session.log');
    const a = new CodexAdapter();
    const started = Date.now();
    const h = a.start({ cwd: dir, prompt: 'reply with the single word ok', logFile, model: 'gpt-5.6-luna' });
    const types: string[] = [];
    for await (const e of a.events(h)) { types.push(e.type); if (e.type === 'turn_end') break; }
    await a.end(h);
    console.log(`codex live: turn_end after ${Date.now() - started} ms; events ${types.join(',')}`);
    expect(types).toContain('turn_end');
    expect(types).not.toContain('error');
    // codex announces "Reading additional input from stdin..." whenever stdin is not a TTY, even at EOF;
    // the bug was that with stdin left open the turn never started, so turn.started is the proof.
    expect(fs.readFileSync(logFile, 'utf8')).toContain('"type":"turn.started"');
  }, 120_000);
});
