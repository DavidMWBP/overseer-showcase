import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { waitForEvidenceRefreshForTests } from './evidence';
import { cleanup, get, setup, type Context } from './evidence-test-helpers';

describe('slow evidence listing', () => {
  let x: Context;
  beforeEach(async () => { x = await setup(); });
  afterEach(async () => { await cleanup(x); });

  it('lists a 60-folder tree with 11,000 nested files and records current timings', async () => {
    const evidenceDir = x.evidenceDir;
    for (let folderIndex = 0; folderIndex < 60; folderIndex++) {
      const folder = path.join(evidenceDir, 'folder-' + String(folderIndex + 1).padStart(2, '0'));
      const left = path.join(folder, 'nested-a');
      const right = path.join(folder, 'nested-b');
      fs.mkdirSync(left, { recursive: true });
      fs.mkdirSync(right, { recursive: true });
      const count = folderIndex < 20 ? 184 : 183;
      for (let fileIndex = 0; fileIndex < count; fileIndex++) {
        const targetDir = fileIndex % 2 === 0 ? left : right;
        const name = 'capture-' + String(fileIndex + 1).padStart(3, '0') + '.png';
        fs.writeFileSync(path.join(targetDir, name), 'evidence performance sample\n');
      }
    }

    const firstStarted = performance.now();
    const first = await get(x.app, '/api/evidence');
    const firstMs = performance.now() - firstStarted;
    const repeatStarted = performance.now();
    const repeat = await get(x.app, '/api/evidence');
    const repeatMs = performance.now() - repeatStarted;
    const rows = first.json() as Array<{ file_count: number }>;
    expect({ status: first.statusCode, folders: rows.length, files: rows.reduce((total, row) => total + row.file_count, 0), repeatStatus: repeat.statusCode }).toEqual({ status: 200, folders: 60, files: 11_000, repeatStatus: 200 });
    expect(repeat.json()).toEqual(first.json());
    console.info('[evidence-list-perf] fixture=60 folders/11000 nested files; current first=' + firstMs.toFixed(1) + 'ms repeat=' + repeatMs.toFixed(1) + 'ms');
  });

  it('keeps a 5,000-file folder paged with the maximum and final pages', async () => {
    const folder = path.join(x.evidenceDir, 'large');
    fs.mkdirSync(folder, { recursive: true });
    for (let index = 0; index < 5_000; index++) {
      const name = 'capture-' + String(index).padStart(4, '0') + '.txt';
      fs.writeFileSync(path.join(folder, name), 'x');
    }

    const listing = await get(x.app, '/api/evidence');
    expect(listing.json()[0]).toMatchObject({ name: 'large', file_count: 5_000, total_size: 5_000 });

    const firstPage = await get(x.app, '/api/evidence/large?offset=0&limit=100');
    const maximumPage = await get(x.app, '/api/evidence/large?offset=0&limit=999');
    const lastPage = await get(x.app, '/api/evidence/large?offset=4900&limit=100');
    expect({ first: firstPage.json().files.length, firstTotal: firstPage.json().total, next: firstPage.json().next_offset }).toEqual({ first: 100, firstTotal: 5_000, next: 100 });
    expect({ maximum: maximumPage.json().files.length, last: lastPage.json().files.length, next: lastPage.json().next_offset }).toEqual({ maximum: 500, last: 100, next: null });
    await waitForEvidenceRefreshForTests(x.evidenceDir);
  });
});
