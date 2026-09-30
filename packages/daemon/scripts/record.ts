import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { codexArgs } from '../src/harness/codex';

const which = process.argv[2];
const prompt = 'Create a file named hello.txt containing the single word hi. Then stop.';
const commands: Record<string, string[]> = {
  claude: ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', prompt],
  opencode: ['opencode', 'run', '--format', 'json', '--auto', prompt],
  codex: ['codex', ...codexArgs('.', null)], // codex takes the prompt over stdin
};
const cmd = commands[which ?? ''];
if (!cmd) { console.error('usage: record.ts <claude|opencode|codex>'); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ov-record-${which}-`));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
const out = path.join(process.cwd(), 'src', 'harness', 'fixtures', `${which}.jsonl`);
const file = fs.createWriteStream(out);
const child = spawn(cmd[0]!, cmd.slice(1).map((a) => (process.platform === 'win32' ? `"${a.replace(/"/g, '\\"')}"` : a)), { cwd: dir, shell: process.platform === 'win32', stdio: [which === 'codex' ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
child.stdin?.end(prompt);
child.stdout.pipe(file);
child.on('close', (code) => {
  console.log(`${which} exited ${code}; hello.txt exists: ${fs.existsSync(path.join(dir, 'hello.txt'))}; fixture: ${out}`);
});
