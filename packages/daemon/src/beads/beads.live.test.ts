import { beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Beads, bdRunner } from './beads';

const beads = new Beads(bdRunner('bd'));
const hasBd = await beads.available();

describe.skipIf(!hasBd)('Beads (live bd)', () => {
  // This remains a live integration suite: each assertion invokes the real bd binary and its local Dolt store.
  let repo: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bd-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('bd', ['init', '--prefix', 'ov'], { cwd: repo, shell: process.platform === 'win32' });
  });
  it('creates, blocks, transitions and closes', async () => {
    const a = (await beads.raw(repo, ['create', 'First', '-d', 'desc line one\ndesc line two %PATH%'])) as { id: string };
    expect((await beads.show(repo, a.id))?.description).toBe('desc line one\ndesc line two %PATH%');
    const b = (await beads.raw(repo, ['create', 'Second', '--deps', `blocked-by:${a.id}`])) as { id: string };
    expect(await beads.ready(repo)).toEqual([a.id]);
    // The board skips `bd ready` when no open bead has a dependency; that rests on this wire name and value.
    expect((await beads.list(repo)).find((x) => x.id === b.id)?.dependency_count).toBe(1);
    await beads.update(repo, a.id, { status: 'in_progress', phase: 'verifying' });
    await beads.update(repo, a.id, { phase: 'review', note: 'hello' }); // removes the absent phases without an error
    await beads.update(repo, a.id, { note: 'again' });
    const shown = await beads.show(repo, a.id);
    expect(shown).toMatchObject({ status: 'in_progress', labels: ['overseer:review'] });
    expect(shown?.notes).toBe('hello\nagain');
    await beads.close(repo, a.id, 'done');
    expect((await beads.show(repo, a.id))?.status).toBe('closed');
    expect(await beads.ready(repo)).toEqual([b.id]);
    // OVERSEER_RECORD=1 re-records the fixtures below from this live bd run.
    if (process.env.OVERSEER_RECORD === '1') {
      fs.writeFileSync(new URL('./fixtures/show.json', import.meta.url), JSON.stringify(await beads.raw(repo, ['show', a.id]), null, 2));
      fs.writeFileSync(new URL('./fixtures/list.json', import.meta.url), JSON.stringify(await beads.raw(repo, ['list', '--status', 'closed']), null, 2));
    }
  });
  it('create writes labels and several blocked-by dependencies in one call', async () => {
    const x = (await beads.raw(repo, ['create', 'Dep one'])) as { id: string };
    const y = (await beads.raw(repo, ['create', 'Dep two'])) as { id: string };
    const id = await beads.create(repo, { title: 'Needs both', description: 'line one\nline two', labels: ['overseer:batch:t-b1', 'extra'], blockedBy: [x.id, y.id] });
    const shown = await beads.show(repo, id);
    expect(shown?.labels).toEqual(expect.arrayContaining(['overseer:batch:t-b1', 'extra']));
    expect((await beads.blocked(repo)).find((b) => b.id === id)?.blocked_by.sort()).toEqual([x.id, y.id].sort());
  });
  it('a title or description starting with a dash is not read as a flag', async () => {
    const id = await beads.create(repo, { title: '--help looks like a flag', description: '-x not a flag either', labels: [], blockedBy: [] });
    const shown = await beads.show(repo, id);
    expect(shown?.title).toBe('--help looks like a flag');
    expect(shown?.description).toBe('-x not a flag either');
  });
});
