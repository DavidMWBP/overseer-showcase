import { spawn } from 'node:child_process';
import { killProcess } from '../util/procs';

export interface VerifyResult { status: 'pass' | 'fail'; output: string }

/** Recorded as the output of a "run" with no command; the UI reads it back as "not run" (kept byte-identical to `NO_VERIFY_RUN` in the web package). */
export const NO_VERIFY_RUN = '(no verify command configured)';

export function runVerify(command: string | null, cwd: string, timeoutMs = 20 * 60_000): Promise<VerifyResult> {
  if (!command) return Promise.resolve({ status: 'pass', output: NO_VERIFY_RUN });
  return runShell(command, cwd, timeoutMs);
}

/** The repo's setup command in a worktree just created (dependencies, generated files): the same runner and output format as a verification. */
export const runSetup = (command: string, cwd: string, timeoutMs = 20 * 60_000): Promise<VerifyResult> => runShell(command, cwd, timeoutMs);

function runShell(command: string, cwd: string, timeoutMs: number): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = '';
    let timedOut = false;
    const cap = (d: Buffer) => { out += String(d); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) void killProcess(child.pid).catch(() => {}); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = timedOut ? '\n(timed out)' : `\nexit ${code}`;
      resolve({ status: code === 0 && !timedOut ? 'pass' : 'fail', output: `$ ${command}\n${out}${tail}` });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: 'fail', output: `$ ${command}\n${String(e)}` }); });
  });
}
