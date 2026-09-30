// Windows worker launcher, started by spawnLines (procs.ts) with `detached: true`, so it has no console and survives the daemon.
// It starts the real worker without `detached`, so Windows gives the worker a hidden console (CREATE_NO_WINDOW) that its
// console children (cmd.exe, codex.exe, git.exe) share, instead of each one opening a visible console window of its own.
// The worker inherits stdin (the daemon's pipe) and the log files as stdout/stderr. Because it is not detached, it sits in
// libuv's kill-on-close job object and dies with this launcher. Its pid goes to <pidFile> so the daemon records, adopts
// and kills the worker itself. The launcher exits with the worker's exit code.
// Usage: node launcher.cjs <pidFile> <shell 0|1> <file> [args...]
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const [pidFile, shell, file, ...args] = process.argv.slice(2);
const child = spawn(file, args, { stdio: 'inherit', shell: shell === '1', windowsHide: true });
child.on('spawn', () => fs.writeFileSync(pidFile, String(child.pid)));
child.on('error', (err) => {
  process.stderr.write(`launcher: cannot start ${file}: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
