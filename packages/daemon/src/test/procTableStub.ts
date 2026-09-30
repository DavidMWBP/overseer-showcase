import type * as ChildProcess from 'node:child_process';

/**
 * A stand-in for the process queries in `util/procs.ts` (PowerShell on Windows, `ps` elsewhere), for tests that do not
 * check how processes are found: each query starts a PowerShell, 0.2-0.5 s on an idle box and seconds under load.
 * While a `withStubbedProcessTable` body runs, every such query answers from one shared snapshot with no rows: the
 * process table is empty, no process holds a session log and no start time is known. `taskkill`, `spawn` and every
 * other command still run for real, so killing a live CLI still takes its tree with it.
 *
 * A test file opts in once, above its imports:
 * `vi.mock('node:child_process', async (orig) => (await import('../test/procTableStub')).stubbableChildProcess(await orig()));`
 * Tests that check real process discovery (a descendant walk, a log-holder sweep, the reaper) run without the wrapper.
 */
const SNAPSHOT = '';
let stubbed = false;

export function stubbableChildProcess(actual: typeof ChildProcess): typeof ChildProcess {
  const execFile = ((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    if (stubbed && (cmd === 'powershell' || cmd === 'ps')) {
      const cb = rest.find((r) => typeof r === 'function') as ((e: null, out: string, err: string) => void) | undefined;
      process.nextTick(() => cb?.(null, SNAPSHOT, ''));
      return undefined;
    }
    return (actual.execFile as (...a: unknown[]) => unknown)(cmd, args, ...rest);
  }) as unknown as typeof ChildProcess.execFile;
  return { ...actual, execFile };
}

/** Runs `body` with the process queries answered from the empty snapshot. */
export function withStubbedProcessTable<T>(body: () => Promise<T>): () => Promise<T> {
  return async () => {
    stubbed = true;
    try { return await body(); } finally { stubbed = false; }
  };
}
