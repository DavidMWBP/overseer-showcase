import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const home = process.env.USERPROFILE || process.env.HOME || homedir();
const privateTermsPath = path.join(home, '.overseer', 'private-terms.txt');
const hasPrivateTerms = existsSync(privateTermsPath);
const missingTermsMessage = 'private terms list ~/.overseer/private-terms.txt is missing; tracked-file scan skipped';

it.skipIf(!hasPrivateTerms)(
  hasPrivateTerms ? 'rejects private terms in tracked files' : missingTermsMessage,
  async () => {
    const terms = (await readFile(privateTermsPath, 'utf8'))
      .split(/\r?\n/)
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    expect(terms, 'private terms list must contain at least one term').not.toHaveLength(0);

    const { stdout: rootOutput } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
    const repoRoot = rootOutput.trim();
    const { stdout: trackedOutput } = await execFile('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const trackedFiles = trackedOutput.split('\0').filter(Boolean);
    expect(trackedFiles, 'private terms scan must cover tracked files').not.toHaveLength(0);
    const matches: string[] = [];

    for (const relativePath of trackedFiles) {
      const content = (await readFile(path.join(repoRoot, relativePath))).toString('utf8').toLowerCase();
      if (terms.some((term) => content.includes(term))) matches.push(relativePath);
    }

    expect(matches, `tracked files contain private terms: ${matches.join(', ')}`).toEqual([]);
  },
);
