import type * as ChildProcess from 'node:child_process';
import { promisify } from 'node:util';

/** One recorded child-process spawn: the command, its arguments and the `cwd` it ran in. */
export type ExecCall = { cmd: string; args: string[]; cwd?: string };
const calls: ExecCall[] = [];

function record(cmd: string, args: readonly string[], rest: unknown[]): void {
  const opts = rest.find((r): r is { cwd?: string } => r !== null && typeof r === 'object');
  calls.push({ cmd, args: [...args], cwd: opts?.cwd });
}

/**
 * A stand-in for `node:child_process` that records every `execFile` and delegates to the real one, so a test can count how
 * many times a command (typically `git`) ran per repository. A test file opts in once, above its imports:
 * `vi.mock('node:child_process', async (orig) => (await import('../test/execCalls')).recordingChildProcess(await orig()));`
 * Each test uses its own temp repository, so filtering by `cwd` isolates one test's calls from a concurrent neighbour's.
 */
export function recordingChildProcess(actual: typeof ChildProcess): typeof ChildProcess {
  const execFile = ((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    record(cmd, args, rest);
    return (actual.execFile as (...a: unknown[]) => unknown)(cmd, args, ...rest);
  }) as unknown as typeof ChildProcess.execFile;
  // `child_process.execFile` carries a `promisify.custom` that resolves to `{ stdout, stderr }`; replacing the function drops
  // it and `promisify(execFile)` would resolve to the bare stdout string instead. Keep the custom, and record through it too.
  const custom = (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom] as ((...a: unknown[]) => unknown) | undefined;
  if (custom) {
    (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args: readonly string[], options?: { cwd?: string }) => {
      record(file, args, [options]);
      return custom(file, args, options);
    };
  }
  return { ...actual, execFile };
}

/** How many `git <args...>` calls have run with `cwd` so far: the count is cumulative, so a test compares before and after an action. */
export function gitCalls(cwd: string, args: string[]): number {
  return calls.filter((c) => c.cmd === 'git' && c.cwd === cwd && c.args.length >= args.length && args.every((a, i) => c.args[i] === a)).length;
}
