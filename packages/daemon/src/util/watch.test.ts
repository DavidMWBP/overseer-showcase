import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_ROOT as root, watchWarning, WATCH_WARNING } from './watch';

describe('watchWarning', () => {
  it('fires only when running under the watcher from a managed checkout', () => {
    expect(watchWarning({ OVERSEER_WATCH: '1' }, ['/tmp/other', root], root)).toBe(WATCH_WARNING);
  });
  it('stays quiet without the watch marker', () => {
    expect(watchWarning({}, [root], root)).toBeNull();
  });
  it('stays quiet when no managed repo is the daemon source', () => {
    expect(watchWarning({ OVERSEER_WATCH: '1' }, ['/tmp/other'], root)).toBeNull();
  });
  it('resolves the source root to the repository root', () => {
    expect(root).toBe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'));
    expect(fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('start scripts', () => {
  const pkg = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) as { scripts: Record<string, string> };
  it('root `start` exists and the daemon `start` runs without a watcher', () => {
    expect(pkg('package.json').scripts.start).toBeDefined();
    expect(pkg('package.json').scripts.start).not.toContain('watch');
    expect(pkg('packages/daemon/package.json').scripts.start).not.toContain('watch');
    expect(pkg('packages/web/package.json').scripts.start).toBeDefined();
  });
  it('the daemon `dev` script marks watch mode for the startup warning', () => {
    expect(pkg('packages/daemon/package.json').scripts.dev).toContain('OVERSEER_WATCH=1');
  });
});
