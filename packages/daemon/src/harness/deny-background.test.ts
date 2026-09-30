import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DENY_BACKGROUND_HOOK } from './claude';

let preloadDir: string;
/** Preload scripts that make the hook see the given `process.platform`, so both branches run on any host. */
const preload = (platform: string) => path.join(preloadDir, `${platform}.cjs`);

beforeAll(() => {
  preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deny-hook-'));
  for (const p of ['win32', 'linux']) fs.writeFileSync(preload(p), `Object.defineProperty(process, 'platform', { value: '${p}' });\n`);
});
afterAll(() => fs.rmSync(preloadDir, { recursive: true, force: true }));

function runHook(input: string, platform = 'win32'): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ['-r', preload(platform), DENY_BACKGROUND_HOOK], { input, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}
const bash = (command: string, platform?: string) => runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), platform);

describe('deny-background hook', () => {
  it('rejects a Bash call with run_in_background and tells the model what to do instead', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Background commands are blocked for Overseer workers');
    expect(r.stderr).toContain('timeout');
  });
  it('lets a foreground Bash call, another tool and malformed input through', () => {
    expect(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status', timeout: 600000 } })).status).toBe(0);
    expect(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { run_in_background: true } })).status).toBe(0);
    expect(runHook('not json').status).toBe(0);
  });
});

describe('deny-background hook: npm CLIs on Windows', () => {
  it('denies `pnpm test` with the PowerShell suggestion', () => {
    const r = bash('pnpm test');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('On Windows run this in the PowerShell tool instead: pnpm test');
  });
  it('denies `cd packages/web && pnpm test` and turns the cd into Set-Location', () => {
    const r = bash('cd packages/web && pnpm test');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('On Windows run this in the PowerShell tool instead: Set-Location packages/web && pnpm test');
  });
  it('denies `npx playwright test x`', () => {
    expect(bash('npx playwright test x').stderr).toContain('PowerShell tool instead: npx playwright test x');
  });
  it('denies an npm CLI after `&&`', () => {
    expect(bash('git status && npm run lint').stderr).toContain('PowerShell tool instead: git status && npm run lint');
  });
  it('denies an npm CLI after `;` and after `|`', () => {
    expect(bash('git fetch; vitest run').status).toBe(2);
    expect(bash('echo y | playwright-cli open').status).toBe(2);
  });
  it('allows `grep -r pnpm .`', () => {
    expect(bash('grep -r pnpm .').status).toBe(0);
  });
  it('allows `echo npm`', () => {
    expect(bash('echo npm').status).toBe(0);
  });
  it('allows `git log`', () => {
    expect(bash('git log').status).toBe(0);
  });
  it('allows an empty command', () => {
    expect(bash('').status).toBe(0);
  });
  it('still denies a background npm call for being in the background', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm test', run_in_background: true } }));
    expect(r.stderr).toContain('Background commands are blocked');
    expect(r.stderr).not.toContain('PowerShell');
  });
  it('allows `pnpm test` on a non-Windows platform', () => {
    expect(bash('pnpm test', 'linux').status).toBe(0);
  });
});
