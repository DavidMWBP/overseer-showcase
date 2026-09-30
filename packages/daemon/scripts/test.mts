// Runs vitest in the mode a focused daemon test run needs: `pnpm test <file>` and
// `pnpm test:slow <file>` both reach the file whichever list it is in, because the decision lives in
// `src/util/test-mode.ts`. A call naming files from both lists fails there with a message pointing at
// the two commands instead of vitest's "No test files found".
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectTestRun } from '../src/util/test-mode.ts';

const [requestedMode, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith('-'));

const selection = selectTestRun(requestedMode ?? 'fast', positional);
if ('error' in selection) {
  console.error(selection.error);
  process.exit(1);
}

// spawnSync('vitest', ..., { shell: true }) is needed on Windows to resolve the .cmd shim, but shell:
// true forces Node's windowsVerbatimArguments, which joins argv with plain spaces and drops quoting, so
// a quoted multi-word filter (`-t "no file is named"`) silently degrades to its first word. Running the
// resolved JS entry directly keeps argv intact without a shell.
const vitestEntry = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));
const vitestArgs = ['run', ...(selection.mode === 'slow' ? ['--mode', 'slow'] : []), ...rest];
const result = spawnSync(process.execPath, [vitestEntry, ...vitestArgs], { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
