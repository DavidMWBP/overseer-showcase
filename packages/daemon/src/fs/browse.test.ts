import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browse, BrowseError } from './browse';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-browse-'));
  fs.mkdirSync(path.join(root, 'b-plain'));
  fs.mkdirSync(path.join(root, 'a-repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'c-worktree'));
  fs.writeFileSync(path.join(root, 'c-worktree', '.git'), 'gitdir: elsewhere');
  fs.symlinkSync(path.join(root, 'a-repo'), path.join(root, 'd-link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  return root;
}

describe('browse', () => {
  it('lists subfolders, marks git repos, skips dot folders and files', async () => {
    const root = tree();
    const r = await browse(root);
    expect(r.path).toBe(root);
    expect(r.parent).toBe(path.dirname(root));
    expect(r.entries).toEqual([
      { name: 'a-repo', path: path.join(root, 'a-repo'), is_git_repo: true },
      { name: 'b-plain', path: path.join(root, 'b-plain'), is_git_repo: false },
      { name: 'c-worktree', path: path.join(root, 'c-worktree'), is_git_repo: true },
      { name: 'd-link', path: path.join(root, 'd-link'), is_git_repo: true },
    ]);
  });
  it('returns roots without a path', async () => {
    const r = await browse(undefined);
    expect(r.path).toBeNull();
    expect(r.parent).toBeNull();
    expect(r.entries.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(r.entries[0]!.path).toMatch(/^[A-Z]:\\$/);
    else expect(r.entries[0]!.path).toBe(os.homedir());
  });
  it('has a null parent at a filesystem root', async () => {
    const root = path.parse(os.tmpdir()).root;
    expect((await browse(root)).parent).toBeNull();
  });
  it('rejects missing paths and files', async () => {
    const root = tree();
    await expect(browse(path.join(root, 'nope'))).rejects.toBeInstanceOf(BrowseError);
    await expect(browse(path.join(root, 'file.txt'))).rejects.toBeInstanceOf(BrowseError);
  });
});
