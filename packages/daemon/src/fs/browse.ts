import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowseEntry, BrowseResponse } from '@overseer/shared';

export class BrowseError extends Error {}

function roots(platform: NodeJS.Platform): BrowseEntry[] {
  if (platform !== 'win32') {
    const home = os.homedir();
    return [{ name: home, path: home, is_git_repo: fs.existsSync(path.join(home, '.git')) }];
  }
  const out: BrowseEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(p)) out.push({ name: p.slice(0, 2), path: p, is_git_repo: false });
  }
  return out;
}

function isFolderEntry(dir: string, d: fs.Dirent): boolean {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, d.name)).isDirectory();
  } catch {
    return false;
  }
}

export async function browse(p: string | undefined, platform: NodeJS.Platform = process.platform): Promise<BrowseResponse> {
  if (!p) return { path: null, parent: null, entries: roots(platform) };
  const dir = path.resolve(p);
  let names: fs.Dirent[];
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new BrowseError(`cannot read ${dir}: ${(e as Error).message}`);
  }
  const entries = names
    .filter((d) => !d.name.startsWith('.') && isFolderEntry(dir, d))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), is_git_repo: fs.existsSync(path.join(dir, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}
