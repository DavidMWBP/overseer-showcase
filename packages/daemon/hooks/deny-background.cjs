#!/usr/bin/env node
// Claude Code PreToolUse hook for Overseer workers: rejects a Bash call with run_in_background.
// A headless `claude -p` session exits when the model yields its turn, so a background job's completion never
// reaches the model and its results are lost (acme-portal-sample-002 and acme-portal-sample-003, 2026-09-14). Exit code 2 blocks the call
// and feeds stderr back to the model.
// On Windows it also rejects a Bash call that runs an npm CLI (pnpm, npm, npx, vitest, playwright, playwright-cli):
// Git Bash rewrites `C:\program files\nodejs` so the corepack shim is not found (398 of 407 affected sessions were
// Claude, overseer-hpe1, 2026-09-24), and the reason names the same command for the PowerShell tool.
const NPM_CLIS = new Set(['pnpm', 'npm', 'npx', 'vitest', 'playwright', 'playwright-cli']);

/** The command a segment runs: its first word, without a `.cmd` suffix. */
function firstWord(segment) {
  return (segment.trim().split(/\s+/)[0] || '').replace(/\.cmd$/i, '').toLowerCase();
}

/** The PowerShell form of `command` when a segment of it (split on `&&`, `||`, `;`, `|`) starts with an npm CLI, else null. */
function npmCliSuggestion(command) {
  if (!command.split(/&&|\|\||;|\|/).some((s) => NPM_CLIS.has(firstWord(s)))) return null;
  return command.trim().replace(/^cd\s+(\S+)\s*&&/, 'Set-Location $1 &&');
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(data); } catch { process.exit(0); }
  if (!input || input.tool_name !== 'Bash' || !input.tool_input) process.exit(0);
  if (input.tool_input.run_in_background === true) {
    process.stderr.write('Background commands are blocked for Overseer workers: the session ends when you yield and the result would be lost. Run the command in the foreground with the timeout parameter (up to 600000 ms) and split longer runs.\n');
    process.exit(2);
  }
  const suggestion = process.platform === 'win32' && typeof input.tool_input.command === 'string' ? npmCliSuggestion(input.tool_input.command) : null;
  if (suggestion) {
    process.stderr.write(`On Windows run this in the PowerShell tool instead: ${suggestion}\n`);
    process.exit(2);
  }
  process.exit(0);
});
