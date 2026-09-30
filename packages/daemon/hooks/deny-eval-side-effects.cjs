#!/usr/bin/env node
// PreToolUse guard for prompt-eval sessions. The runner gives the model read-oriented tools only; this is a second boundary
// for external clients, port probes, shell writes, and native file writes outside the run's temporary cwd. Every command in
// READ_ONLY_COMMANDS that has a form which runs another program or writes a file (find -exec, sed e/w, rg --pre, sort -o
// and --compress-program, any Git command in a repository that configures a helper, git grep -O, file -C, uniq with an
// output file) is refused below.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BLOCKED_TOOLS = new Set(['PowerShell', 'WebSearch', 'WebFetch', 'Task']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const READ_ONLY_COMMANDS = new Set([
  'basename', 'cat', 'cd', 'cmp', 'cut', 'date', 'diff', 'dir', 'dirname', 'echo', 'false', 'file', 'find', 'git', 'grep', 'head', 'id', 'ls', 'pwd', 'readlink', 'realpath', 'rg', 'sed', 'sort', 'stat', 'tail', 'test', 'true', 'type', 'uniq', 'uname', 'wc', 'where', 'which', 'whoami',
]);
const SAFE_GIT_COMMANDS = new Set(['blame', 'branch', 'diff', 'grep', 'log', 'ls-files', 'rev-parse', 'show', 'status']);
const GIT_HELPER_CONFIG = '^(diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process)|gpg\\.(.*\\.)?program|core\\.(fsmonitor|pager)|pager\\..*)$';
// Keys whose value is a program Git runs during a read: diff and textconv drivers, clean/smudge filters (status and diff run
// them on worktree files) and the signature verifier `log.showSignature` calls.
const GIT_HELPER_KEY = /^(?:diff\.external|diff\..*\.(?:command|textconv)|filter\..*\.(?:clean|smudge|process)|gpg\.(?:.*\.)?program)$/;
const NETWORK_WORDS = /\b(?:glab|gh|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp|Test-NetConnection|Test-Connection|Get-NetTCPConnection|Get-NetUDPEndpoint|netstat|traceroute|tracert|nslookup|dig|nmap|masscan)\b/i;

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

// Splits a segment into the words the shell hands the command: quotes are removed and joined with the text around them
// (`s'/x/'y` is one word), a backslash is literal inside single quotes, so a check reads the argument the command reads.
function words(segment) {
  const out = [];
  let word = null;
  let quote = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else if (ch === '\\' && '"\\$`'.includes(segment[i + 1] ?? '')) word += segment[++i];
      else word += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (word !== null) out.push(word); word = null; continue; }
    word ??= '';
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\' && i + 1 < segment.length) { word += segment[++i]; continue; }
    word += ch;
  }
  if (word !== null) out.push(word);
  return out;
}

const SED_FLAGS = new Set(['n', 'E', 'r', 's', 'u', 'z', 'b']);
const SED_LONG_FLAGS = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--debug', '--sandbox', '--follow-symlinks', '--binary', '--help', '--version']);
const SED_BLOCKED = 'sed commands that execute a command or read or write a file are blocked in prompt-eval sessions';

// The script sed would run, from its `-e`/`--expression` arguments or else its first operand. Returns { reason } for a form
// that must not run: in-place edits, script files (their contents are not read here) and any option not listed above,
// which also refuses a long-option abbreviation such as `--expr`.
function sedScript(tokens) {
  const scripts = [];
  const operands = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { operands.push(...tokens.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      const value = eq === -1 ? undefined : t.slice(eq + 1);
      if (name === '--expression') { const s = value ?? tokens[++i]; if (s === undefined) return { reason: SED_BLOCKED }; scripts.push(s); continue; }
      if (name === '--line-length') { if (value === undefined) i++; continue; }
      if (name === '--in-place') return { reason: 'in-place file edits are blocked in prompt-eval sessions' };
      if (name === '--file') return { reason: 'sed script files are blocked in prompt-eval sessions' };
      if (SED_LONG_FLAGS.has(name) && value === undefined) continue;
      return { reason: `sed option '${name}' is not permitted in prompt-eval sessions` };
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (SED_FLAGS.has(ch)) continue;
        if (ch === 'e') { const s = j + 1 < t.length ? t.slice(j + 1) : tokens[++i]; if (s === undefined) return { reason: SED_BLOCKED }; scripts.push(s); break; }
        if (ch === 'l') { if (j + 1 === t.length) i++; break; }
        if (ch === 'i') return { reason: 'in-place file edits are blocked in prompt-eval sessions' };
        if (ch === 'f') return { reason: 'sed script files are blocked in prompt-eval sessions' };
        return { reason: `sed option '-${ch}' is not permitted in prompt-eval sessions` };
      }
      continue;
    }
    operands.push(t);
  }
  if (!scripts.length && operands.length) scripts.push(operands[0]);
  return { script: scripts.join('\n') };
}

// Walks a sed script command by command (GNU sed 4.9 grammar) and refuses `e`, `w`, `W`, `r`, `R` and the `e` and `w`
// flags of `s`. Anything it cannot read, an unknown command or an unterminated regex, is refused too, so a form this parser
// does not know fails closed. A label ends at `;` or whitespace, the earliest point sed itself may end it, so no command
// after it goes unread.
function sedScriptReason(script) {
  const n = script.length;
  let i = 0;
  const space = () => { while (i < n && (script[i] === ' ' || script[i] === '\t')) i++; };
  const toLineEnd = () => { while (i < n && script[i] !== '\n') { if (script[i] === '\\') i++; i++; } };
  const delimited = (delim) => {
    while (i < n) {
      const ch = script[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === delim) { i++; return true; }
      if (ch === '\n') return false;
      i++;
    }
    return false;
  };
  const address = () => {
    if (/[0-9]/.test(script[i] ?? '')) { while (i < n && /[0-9~]/.test(script[i])) i++; return true; }
    if (script[i] === '$') { i++; return true; }
    if (script[i] === '/' || script[i] === '\\') {
      const delim = script[i] === '\\' ? script[++i] : '/';
      if (delim === undefined || delim === '\n') return false;
      i++;
      if (!delimited(delim)) return false;
      while (script[i] === 'I' || script[i] === 'M') i++;
    }
    return true;
  };
  const unreadable = 'sed script could not be read, so it is blocked in prompt-eval sessions';
  while (i < n) {
    const ch = script[i];
    if (/[\s;}]/.test(ch)) { i++; continue; }
    if (ch === '#') { toLineEnd(); continue; }
    if (!address()) return unreadable;
    space();
    if (script[i] === ',') {
      i++;
      space();
      if (script[i] === '+' || script[i] === '~') { i++; while (i < n && /[0-9]/.test(script[i])) i++; }
      else if (!address()) return unreadable;
    }
    space();
    while (script[i] === '!') { i++; space(); }
    const cmd = script[i++];
    if (cmd === undefined) return unreadable;
    if ('ewWrR'.includes(cmd)) return SED_BLOCKED;
    if (cmd === '{' || '=dDgGhHnNpPxzF'.includes(cmd)) continue;
    if ('qQlL'.includes(cmd)) { space(); while (i < n && /[0-9]/.test(script[i])) i++; continue; }
    if (':btTv'.includes(cmd)) { space(); while (i < n && !/[\s;]/.test(script[i])) i++; continue; }
    if ('aic'.includes(cmd)) { toLineEnd(); continue; }
    if (cmd === 's' || cmd === 'y') {
      const delim = script[i++];
      if (delim === undefined || delim === '\n' || delim === '\\') return unreadable;
      if (!delimited(delim) || !delimited(delim)) return unreadable;
      if (cmd === 'y') continue;
      while (i < n && /[gpiImM0-9ew]/.test(script[i])) { if (script[i] === 'e' || script[i] === 'w') return SED_BLOCKED; i++; }
      if (i < n && !/[\s;}#]/.test(script[i])) return unreadable;
      continue;
    }
    return unreadable;
  }
  return null;
}

function sedReason(tokens) {
  const { script, reason } = sedScript(tokens);
  return reason ?? sedScriptReason(script);
}

// The short-option cluster of `token` (`-uo` → 'uo'), or '' for a long option or an operand.
function shortFlags(token) {
  return /^-[^-]/.test(token) ? token.slice(1) : '';
}

function hasRedirection(command) {
  let quote = '';
  let escaped = false;
  for (const ch of command) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>' || ch === '<') return true;
  }
  return false;
}

function splitSegments(command) {
  const segments = [];
  let segment = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { segment += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { segment += ch; escaped = true; continue; }
    if (quote) { segment += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { segment += ch; quote = ch; continue; }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push(segment);
      segment = '';
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      continue;
    }
    segment += ch;
  }
  segments.push(segment);
  return segments;
}

function isNetworkPath(value) {
  return typeof value === 'string' && (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value) || /\\\\|\/\/[A-Za-z0-9_.-]+[\\/]/.test(value));
}

function gitCommand(tokens, cwd) {
  if (cwd === null) return null;
  let i = 1;
  let currentCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const repositoryArgs = [];
  while (i < tokens.length) {
    const original = tokens[i];
    const token = original.toLowerCase();
    if (token === '--no-pager') { i++; continue; }
    if (original === '-C') {
      if (i + 1 >= tokens.length) return null;
      currentCwd = path.resolve(currentCwd, tokens[i + 1]);
      i += 2;
      continue;
    }
    if (original === '-c' || original.startsWith('-c') || token === '--config-env' || token.startsWith('--config-env=') || token === '--exec-path' || token.startsWith('--exec-path=')) return null;
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=')) { repositoryArgs.push(original); i++; continue; }
    if (token.startsWith('-')) return null;
    if (!SAFE_GIT_COMMANDS.has(token)) return null;
    if (token === 'branch' && tokens.slice(i + 1).some((arg) => !['--show-current', '--list', '-l'].includes(arg.toLowerCase()))) return null;
    if (tokens.slice(i + 1).some((arg) => ['-o', '--output'].includes(arg.toLowerCase()) || arg.toLowerCase().startsWith('--output='))) return null;
    return { name: token, args: tokens.slice(i + 1), cwd: currentCwd, repositoryArgs };
  }
  return null;
}

function gitOption(args, option) {
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === option) return true;
  }
  return false;
}

// Every helper entry in every scope this process reads, as { scope, key, value }. The eval runner's environment
// (`src/evals/gitEnv.ts`) switches system and global configuration off, so there only the repository's local and worktree
// config (and the runner's own command-scope overrides) remain; without that environment a system or global helper is
// refused here too, rather than run.
function gitConfigEntries(command) {
  const result = spawnSync('git', ['--no-pager', ...command.repositoryArgs, 'config', '--null', '--show-scope', '--get-regexp', GIT_HELPER_CONFIG], {
    cwd: command.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  // `--null --show-scope` prints `scope\0key\nvalue\0` per entry.
  const fields = (result.stdout ?? '').split('\0');
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const separator = fields[i + 1].indexOf('\n');
    if (separator < 0) continue;
    entries.push({ scope: fields[i], key: fields[i + 1].slice(0, separator).toLowerCase(), value: fields[i + 1].slice(separator + 1).trim() });
  }
  return entries;
}

function activeConfig(entries, key) {
  return entries.filter((entry) => entry.key === key && entry.value !== '');
}

function isDisabled(value) {
  return ['false', 'no', 'off', '0'].includes(value.trim().toLowerCase());
}

function isSafePager(value) {
  return value.trim() === '' || value.trim().toLowerCase() === 'cat';
}

function gitHelperReason(command) {
  const { name, args } = command;
  const delimiter = args.indexOf('--');
  const options = delimiter < 0 ? args : args.slice(0, delimiter);

  // Which subcommand or flag reaches a helper (a patch log, `-u`, `--cc`, `--textconv`, `status` through a filter) is not
  // guessed: any Git command in a repository that configures one is refused.
  if (process.env.GIT_EXTERNAL_DIFF) return 'Git commands are blocked in prompt-eval sessions while GIT_EXTERNAL_DIFF names a diff helper';
  const entries = gitConfigEntries(command);
  if (!entries) return 'Git helper configuration could not be checked in prompt-eval sessions';
  const helper = entries.find((entry) => (GIT_HELPER_KEY.test(entry.key) && entry.value !== '') || (entry.key === 'core.fsmonitor' && entry.value !== '' && !isDisabled(entry.value)));
  if (helper && ['system', 'global'].includes(helper.scope)) {
    return `Git commands are blocked in prompt-eval sessions, because the ${helper.scope} Git config sets ${helper.key}, a command Git may run during a read; the eval runner's environment switches system and global Git config off, and this session did not get it`;
  }
  if (helper) return `Git commands are blocked in prompt-eval sessions in this repository, because its ${helper.scope} config sets ${helper.key}, a command Git may run during a read`;

  if (!gitOption(options, '--no-pager')) {
    const inheritedPager = process.env.GIT_PAGER !== undefined ? process.env.GIT_PAGER : process.env.PAGER;
    if (inheritedPager !== undefined && !isSafePager(inheritedPager)) return 'Git pager environment commands are blocked in prompt-eval sessions';
    const configuredPager = activeConfig(entries, 'core.pager').find((entry) => !isSafePager(entry.value));
    if (configuredPager) return 'Git core pager commands are blocked in prompt-eval sessions';
    const commandPager = activeConfig(entries, `pager.${name}`).find((entry) => !isDisabled(entry.value) && !isSafePager(entry.value));
    if (commandPager) return `Git pager.${name} commands are blocked in prompt-eval sessions`;
  }
  return null;
}

function shellReason(command, cwd) {
  if (isNetworkPath(command) || /\b(?:\/dev\/(?:tcp|udp)|\\\\\.\pipe\\)/i.test(command)) {
    return 'network paths and socket devices are blocked in prompt-eval sessions';
  }
  if (NETWORK_WORDS.test(command) || /\bgit\b(?:(?![;&|\n]).)*\b(?:fetch|push|pull|clone|remote|submodule|ls-remote|send-pack|receive-pack)\b/i.test(command)) {
    return 'network and local-port access are blocked in prompt-eval sessions';
  }
  if (hasRedirection(command)) return 'shell redirection is blocked in prompt-eval sessions';
  if (command.includes('`') || command.includes('$(') || /\b(?:eval|source)\b/i.test(command)) return 'shell command indirection is blocked in prompt-eval sessions';
  let currentCwd = typeof cwd === 'string' && cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  for (const segment of splitSegments(command)) {
    const tokens = words(segment);
    if (!tokens.length) continue;
    const first = path.basename(tokens[0]).replace(/\.exe$/i, '').replace(/\.cmd$/i, '').toLowerCase();
    if (!READ_ONLY_COMMANDS.has(first)) return `shell command '${first}' is not permitted in prompt-eval sessions`;
    if (first === 'cd') {
      const target = tokens[1] === '--' ? tokens[2] : tokens[1];
      if (tokens.length === 1) currentCwd = process.env.HOME || process.env.USERPROFILE || os.homedir();
      else if ((tokens[1] === '--' && tokens.length === 3) || (tokens.length === 2 && tokens[1] !== '-')) {
        const expanded = target === '~' ? os.homedir() : target.startsWith('~/') || target.startsWith('~\\') ? path.join(os.homedir(), target.slice(2)) : target;
        const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : currentCwd ? path.resolve(currentCwd, expanded) : null;
        currentCwd = resolved && fs.existsSync(resolved) ? resolved : null;
      } else currentCwd = null;
    }
    const git = first === 'git' ? gitCommand(tokens, currentCwd) : null;
    if (first === 'git' && !git) return 'only read-only git commands are permitted in prompt-eval sessions';
    if (git) { const reason = gitHelperReason(git); if (reason) return reason; }
    if (first === 'find' && tokens.some((t) => /^-(?:exec|execdir|delete|ok|fprint|fls)/i.test(t))) return 'find commands that execute or write are blocked in prompt-eval sessions';
    if (git?.name === 'grep' && tokens.some((t) => shortFlags(t).includes('O') || /^--op/.test(t))) return 'git grep with a pager command is blocked in prompt-eval sessions';
    if (first === 'sed') { const reason = sedReason(tokens); if (reason) return reason; }
    // GNU sort accepts any unique long-option prefix, so `--o=file` is `--output` and `--com` is `--compress-program`.
    if (first === 'sort' && tokens.some((t) => shortFlags(t).includes('o') || /^--o/.test(t))) return 'file-writing sort commands are blocked in prompt-eval sessions';
    if (first === 'sort' && tokens.some((t) => /^--com/.test(t))) return 'sort with a compress program is blocked in prompt-eval sessions';
    if (first === 'rg' && tokens.some((t) => /^--pre(?:=|$)/.test(t))) return 'rg with a preprocessor command is blocked in prompt-eval sessions';
    if (first === 'file' && tokens.some((t) => shortFlags(t).includes('C') || /^--co/.test(t))) return 'file-writing file commands are blocked in prompt-eval sessions';
    if (first === 'uniq') {
      const operands = [];
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '--') { operands.push(...tokens.slice(i + 1)); break; }
        if (['-f', '-s', '-w'].includes(tokens[i])) { i++; continue; }
        if (!tokens[i].startsWith('-') || tokens[i] === '-') operands.push(tokens[i]);
      }
      if (operands.length > 1) return 'uniq with an output file is blocked in prompt-eval sessions';
    }
  }
  return null;
}

function realpathForFuture(target) {
  let cursor = path.resolve(target);
  const rest = [];
  while (true) {
    try { return path.resolve(fs.realpathSync.native(cursor), ...rest); }
    catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      rest.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isInside(cwd, file) {
  if (typeof cwd !== 'string' || !cwd || typeof file !== 'string' || !file) return false;
  const root = realpathForFuture(cwd);
  const expanded = file === '~' ? os.homedir() : file.startsWith('~/') || file.startsWith('~\\') ? path.join(os.homedir(), file.slice(2)) : file;
  const target = realpathForFuture(path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded));
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(data); } catch { refuse('could not read prompt-eval guard input'); }
  if (!input || typeof input.tool_name !== 'string') refuse('could not identify prompt-eval tool call');
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  if (tool === 'Bash') {
    if (toolInput.run_in_background === true) refuse('Background commands are blocked in prompt-eval sessions.');
    if (typeof toolInput.command !== 'string') process.exit(0);
    const reason = shellReason(toolInput.command, input.cwd);
    if (reason) refuse(`${reason}: ${toolInput.command.slice(0, 180)}`);
    process.exit(0);
  }
  if (BLOCKED_TOOLS.has(tool)) refuse(`${tool} is disabled in prompt-eval sessions.`);
  if (READ_TOOLS.has(tool)) {
    const target = tool === 'Read' ? toolInput.file_path : toolInput.path;
    if (isNetworkPath(target)) refuse(`${tool} may not access network paths in prompt-eval sessions.`);
  }
  if (FILE_TOOLS.has(tool)) {
    const target = toolInput.file_path ?? toolInput.notebook_path;
    if (!isInside(input.cwd, target)) refuse(`${tool} may write only inside this eval cwd.`);
  }
  process.exit(0);
});
