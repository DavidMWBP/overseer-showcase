import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config';
import { runDoctor, type VersionRunner } from './doctor';

const runner: VersionRunner = async (bin) => {
  if (bin === 'git') return { code: 0, stdout: 'git version 2.45.0\nextra\n', stderr: '' };
  if (bin === '/custom/bd') return { code: 0, stdout: 'bd version 1.2.2', stderr: '' };
  if (bin === 'claude') throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  if (bin === 'codex') return new Promise(() => { /* never resolves: timeout */ });
  if (bin === 'opencode') return { code: 1, stdout: '', stderr: 'boom' };
  return { code: 0, stdout: 'glab 1.50', stderr: '' };
};

describe('doctor', () => {
  it('reports each tool and the data dir', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-doctor-'));
    const config = loadConfig({ OVERSEER_BD: '/custom/bd', OVERSEER_DATA_DIR: dataDir });
    const r = await runDoctor(config, runner, { timeoutMs: 50 });
    expect(r.tools.map((t) => [t.name, t.required, t.ok, t.version])).toEqual([
      ['git', true, true, 'git version 2.45.0'],
      ['bd', true, true, 'bd version 1.2.2'],
      ['claude', true, false, null],
      ['codex', false, false, null],
      ['opencode', false, false, null],
      ['glab', false, true, 'glab 1.50'],
    ]);
    expect(r.tools[1]!.fix).toBeNull();
    expect(r.tools[2]!.fix).toContain('npm install -g @anthropic-ai/claude-code');
    expect(r.tools[3]!.fix).toContain('npm install -g @openai/codex');
    expect(r.data_dir).toEqual({ path: dataDir, ok: true, problem: null });
  });
  it('keeps the login hint on a healthy claude row and flags an unwritable data dir', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-doctor-')), 'file');
    fs.writeFileSync(file, 'x');
    const ok: VersionRunner = async () => ({ code: 0, stdout: 'v1', stderr: '' });
    const r = await runDoctor(loadConfig({ OVERSEER_DATA_DIR: path.join(file, 'sub') }), ok, { timeoutMs: 50 });
    expect(r.tools.every((t) => t.ok)).toBe(true);
    expect(r.tools.find((t) => t.name === 'claude')!.fix).toContain('claude');
    expect(r.data_dir.ok).toBe(false);
    expect(r.data_dir.problem).toBeTruthy();
  });
});
