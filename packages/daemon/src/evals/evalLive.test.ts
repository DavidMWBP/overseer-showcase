import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE, claudeCall } from '../../scripts/evalLive';

// A stand-in `claude` binary: `target.js` runs under node with the call's argv, as an npm shim would start it.
function stubClaude(source: string): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-claude-stub-'));
  fs.writeFileSync(path.join(dir, 'target.js'), source);
  if (process.platform === 'win32') {
    const bin = path.join(dir, 'claude.cmd');
    fs.writeFileSync(bin, `@ECHO off\r\nSET dp0=%~dp0\r\n"${process.execPath}" "%dp0%\\target.js" %*\r\n`);
    return { bin, dir };
  }
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/target.js" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, dir };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const realBin = LIVE.claudeBin;
const dirs: string[] = [];
afterEach(() => {
  LIVE.claudeBin = realBin;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('claudeCall deadline', () => {
  it('kills a CLI that never answers once the timeout passes and returns the timeout as its error', async () => {
    const pidFile = path.join(os.tmpdir(), `overseer-claude-stub-${process.pid}-${Date.now()}.pid`);
    const { bin, dir } = stubClaude(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    dirs.push(dir);
    LIVE.claudeBin = bin;
    const started = Date.now();
    const res = await claudeCall('hello', undefined, {}, 1, { timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    expect(res).toEqual({ text: '', cost: 0, error: 'claude timed out after 2 s and its process tree was killed' });
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(15_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    fs.rmSync(pidFile, { force: true });
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('returns the answer of a CLI that finishes before the timeout', async () => {
    const { bin, dir } = stubClaude(`process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: 'ok', total_cost_usd: 0.12 })));`);
    dirs.push(dir);
    LIVE.claudeBin = bin;
    const res = await claudeCall('hello', undefined, {}, 1, { timeoutMs: 10_000 });
    expect(res).toEqual({ text: 'ok', cost: 0.12, error: null });
  }, 30_000);
});
