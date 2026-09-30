/**
 * Polls until `check` holds. The cap is generous because it costs nothing on a passing run — the poll returns the instant the
 * condition holds — while a tight one fails honest tests on a loaded machine: `pnpm -r test` runs the web and daemon vitest
 * pools at the same time, and 5000ms was not enough for a worker stop or a critic session to be observed under that load.
 * The 15s cap also failed an honest test under the daemon suite's own full parallelism (4 forks) on an idle machine: the
 * longest honest run observed took 25969ms. 45s is headroom above that, not a measured bound.
 */
export async function until(check: () => boolean | Promise<boolean>, ms = 45000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
