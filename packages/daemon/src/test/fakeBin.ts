import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A fake harness CLI for adapter tests: `body` is CommonJS run by node, wrapped in an npm-style `.cmd` shim on Windows
 * (which `spawnLines` resolves to node plus the script) or an executable shell script elsewhere. Returns the command
 * to pass as the adapter's `bin` and the directory it lives in.
 */
export function fakeBin(name: string, body: string): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ov-${name}-`));
  const script = path.join(dir, `${name}.js`);
  fs.writeFileSync(script, body);
  if (process.platform === 'win32') {
    const bin = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(bin, `@node "%dp0%\\${name}.js" %*\r\n`);
    return { bin, dir };
  }
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { bin, dir };
}

/** Body lines for `fakeBin` that print `lines` (JSON) and then keep a node child alive on inherited stdio, writing its pid to `pidFile`. */
export function lingeringChildBody(lines: object[], pidFile: string): string {
  return [
    "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
    ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
    "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    "c.on('exit', () => process.exit(0));",
  ].join('\n');
}

/**
 * Body lines for `fakeBin` that print `lines`, start a detached node child on inherited stdio (so it holds the
 * parent's stdout after the parent is gone), write its pid to `pidFile` and exit at once: the CLI-exits-first shape.
 */
export function orphaningChildBody(lines: object[], pidFile: string): string {
  return [
    "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
    ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
    "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit', detached: true });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    'c.unref(); process.exit(0);',
  ].join('\n');
}

/**
 * Like `orphaningChildBody`, but the detached child is started by an intermediate node process that exits at once, so
 * the child's recorded parent pid is dead and a parent-pid walk from the CLI cannot reach it: the shape of a worker
 * running `node bg.js` in a shell (codex → pwsh → node → detached server, the two in the middle gone).
 */
export function orphanBehindIntermediateBody(lines: object[], pidFile: string): string {
  const inner = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit', detached: true }); c.unref(); require('node:fs').writeFileSync(process.argv[1], String(c.pid));";
  return [
    "const { spawnSync } = require('node:child_process'); const fs = require('node:fs');",
    ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
    `spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}, ${JSON.stringify(pidFile)}], { stdio: 'inherit' });`,
    'process.exit(0);',
  ].join('\n');
}

/**
 * `orphanBehindIntermediateBody` without the exit: the CLI stays alive after it has left the detached, log-holding
 * orphan behind, the shape an interrupt must sweep once `killProcess` has killed the CLI it can still reach.
 *
 * The orphan is launched through `cmd /c start /b`: a plain `spawn(..., { detached: true })` stays in the launcher's
 * kill-on-close job object and dies with the worker, while `start /b` leaves it outside that job (what a harness's shell
 * does to a dev server) but still inheriting the session-log stdio, so only the log-handle sweep can reach it. The
 * orphan writes its own pid to `pidFile`; `<pidFile>.ready` is written once `cmd` has returned, so a test can wait for
 * the intermediate to be gone before it interrupts. Windows only, like the tests that use it.
 */
export function lingeringOrphanBehindIntermediateBody(lines: object[], pidFile: string): string {
  const orphanScript = path.join(path.dirname(pidFile), 'orphan.cjs');
  fs.writeFileSync(orphanScript, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(()=>{},1000);");
  return [
    "const { spawnSync } = require('node:child_process'); const fs = require('node:fs');",
    ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
    `spawnSync('cmd', ['/c', 'start', '', '/b', process.execPath, ${JSON.stringify(orphanScript)}, ${JSON.stringify(pidFile)}], { stdio: 'inherit' });`,
    `fs.writeFileSync(${JSON.stringify(pidFile + '.ready')}, '1');`,
    'setInterval(()=>{},1000);',
  ].join('\n');
}
