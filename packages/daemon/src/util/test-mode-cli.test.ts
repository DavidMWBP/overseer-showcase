import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const daemonRoot = path.resolve(import.meta.dirname, '../..');

describe('scripts/test.mts quoting', () => {
  it('keeps a quoted multi-word -t pattern intact instead of truncating it at the first space', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--disable-warning=ExperimentalWarning',
        'scripts/test.mts',
        'fast',
        'src/util/test-mode.test.ts',
        '-t',
        'no file is named',
        '--reporter=json',
      ],
      { cwd: daemonRoot, encoding: 'utf8', shell: false }
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    const ran: string[] = report.testResults.flatMap((f: { assertionResults: { fullName: string; status: string }[] }) =>
      f.assertionResults.filter((a) => a.status !== 'skipped' && a.status !== 'pending').map((a) => a.fullName)
    );
    // A truncated filter (the bug: `-t "no"` after losing its quoting) also matches
    // "does not refuse a slow file paired with a bare filter word" via the substring "not".
    expect(ran).toEqual(['selectTestRun runs the whole list matching the requested mode when no file is named']);
  });
});
