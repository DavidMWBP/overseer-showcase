import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { mkTmpRepo, copyTmpRepo, sh } from '../test/tmpgit';
import { Prober, refusalText, outcome } from './probe';

const shellExit = (code: number) => `node -e "process.exit(${code})"`;
const template = mkTmpRepo();

function setup(verify: string | null, patch: Partial<Repo> = {}) {
  const t = copyTmpRepo(template);
  const db = openDb(':memory:');
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: verify, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0, ...patch, model_filter: patch.model_filter ?? null };
  db.repos.insert(repo);
  const notes: string[] = []; const pushes: string[] = [];
  const prober = new Prober({ db, bus: new Bus(), worktreesDir: t.worktreesDir,
    notify: async (m) => { notes.push(m); }, push: { notify: async (m: { title: string }) => { pushes.push(m.title); return []; } } as never });
  return { db, prober, notes, pushes, t };
}

describe.concurrent('Prober', () => {
  it('flags a verify command that fails on the base branch and notifies once', async () => {
    const x = setup(shellExit(1));
    await x.prober.probe('r1');
    const run = x.db.preflight.latest('r1')!;
    expect(run).toMatchObject({ result: 'fail', exit_code: 1 });
    expect(x.db.repos.get('r1')!.verify_suspect).toBe(run.id);
    const sha = sh(x.t.path, ['rev-parse', '--short', 'main']);
    expect(x.notes).toHaveLength(1);
    expect(x.notes[0]).toContain(`verify command "${shellExit(1)}" exits 1 on main at ${sha}`);
    expect(x.pushes).toEqual(['r1: verify command fails on main']);
    await x.prober.probe('r1');
    expect(x.notes).toHaveLength(1);
    expect(fs.existsSync(path.join(x.t.worktreesDir, 'r1', 'probe'))).toBe(false);
  });

  it('clears the flag when the command passes', async () => {
    const x = setup(shellExit(1));
    await x.prober.probe('r1');
    x.db.repos.update('r1', { verify_command: shellExit(0) });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')!.result).toBe('pass');
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
  });

  it('records nothing and clears the flag without a verify command', async () => {
    const x = setup(null);
    x.db.repos.update('r1', { verify_suspect: 99 });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')).toBeUndefined();
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
  });

  it('records a probe that cannot start as an error without flagging the repo', async () => {
    const x = setup(shellExit(1), { base_branch: 'nope' });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')!.result).toBe('error');
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
    expect(x.notes).toEqual([]);
  });

  it('fails the probe on a failing setup command and names it, not the verify command', async () => {
    const x = setup(shellExit(0), { setup_command: shellExit(4) });
    await x.prober.probe('r1');
    expect(x.db.preflight.latest('r1')).toMatchObject({ result: 'fail', exit_code: 4, step: 'setup', command: shellExit(4) });
    expect(x.notes).toHaveLength(1);
    expect(x.notes[0]).toContain(`setup command "${shellExit(4)}"`);
    expect(x.pushes).toEqual(['r1: setup command fails on main']);
  });

  it('runs concurrent probes one after the other; the last result wins', async () => {
    const x = setup(shellExit(1));
    const first = x.prober.probe('r1');
    x.db.repos.update('r1', { verify_command: shellExit(0) });
    await Promise.all([first, x.prober.probe('r1')]);
    expect(x.db.preflight.recent('r1', 5).map((r) => r.result)).toEqual(['pass', expect.any(String)]);
    expect(x.db.repos.get('r1')!.verify_suspect).toBeNull();
  });

  it('words the refusal', () => {
    expect(refusalText({ command: 'c', exit_code: null, result: 'timeout', head_sha: 'abcdef1234', step: 'verify' }, 'main')).toBe('verify command "c" times out on main at abcdef1; fix it in Setup → Edit, then Re-probe');
    expect(refusalText({ command: 'c', exit_code: 3, result: 'fail', head_sha: 'abcdef1234', step: 'setup' }, 'main')).toBe('setup command "c" exits 3 on main at abcdef1; fix it in Setup → Edit, then Re-probe');
  });

  it('treats a fail with no parsable exit code as an error, not "exits null"', () => {
    expect(outcome({ status: 'fail', output: '$ x\nError: spawn x ENOENT' })).toEqual({ result: 'error', exit_code: null });
  });
});
