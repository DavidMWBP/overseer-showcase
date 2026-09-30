import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForEvidenceRefreshForTests } from './evidence';
import { cleanup, get, setup, writeFile, type Context } from './evidence-test-helpers';

const fileUrl = (folder: string, relative: string) => `/api/evidence/${encodeURIComponent(folder)}/${relative.split('/').map(encodeURIComponent).join('/')}`;
const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('read-only evidence REST API', () => {
  let x: Context;
  beforeEach(async () => { x = await setup(); });
  afterEach(async () => { await cleanup(x); });

  it('resolves evidence under the configured temp home and away from both live defaults', () => {
    const liveRoots = [path.resolve('C:\\Workspace\\dev\\.overseer\\evidence'), path.resolve(os.homedir(), '.overseer', 'evidence')];
    expect({ root: x.evidenceDir, expected: path.resolve(x.config.dataDir, 'evidence'), live: liveRoots.includes(x.evidenceDir) }).toEqual({ root: path.resolve(x.config.dataDir, 'evidence'), expected: path.resolve(x.config.dataDir, 'evidence'), live: false });
  });

  it('returns an empty list when the evidence root is missing', async () => {
    const response = await get(x.app, '/api/evidence');
    expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: [] });
  });

  it('returns an empty list for an existing empty root', async () => {
    fs.mkdirSync(x.evidenceDir, { recursive: true });
    const response = await get(x.app, '/api/evidence');
    expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: [] });
  });

  it('returns no files for an empty folder', async () => {
    fs.mkdirSync(path.join(x.evidenceDir, 'empty'), { recursive: true });
    const response = await get(x.app, '/api/evidence/empty');
    const page = await get(x.app, '/api/evidence/empty?offset=0&limit=100');
    const zeroLimit = await get(x.app, '/api/evidence/empty?limit=0');
    expect({
      full: { status: response.statusCode, body: response.json() },
      page: { status: page.statusCode, body: page.json() },
      zeroLimit: { status: zeroLimit.statusCode, body: zeroLimit.json() },
    }).toEqual({
      full: { status: 200, body: [] },
      page: { status: 200, body: { files: [], total: 0, next_offset: null } },
      zeroLimit: { status: 400, body: { error: 'Invalid evidence page' } },
    });
  });

  it('lists folders newest first with recursive counts, sizes, and the latest file time', async () => {
    const old = writeFile(x.evidenceDir, 'older/a.txt', 'a');
    const latestOld = writeFile(x.evidenceDir, 'older/nested/b.txt', 'bb');
    const newest = writeFile(x.evidenceDir, 'newer/c.txt', 'ccc');
    fs.mkdirSync(path.join(x.evidenceDir, 'empty'), { recursive: true });
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    const latestOldTime = new Date('2021-01-01T00:00:00.000Z');
    const newestTime = new Date('2022-01-01T00:00:00.000Z');
    fs.utimesSync(old, oldTime, oldTime);
    fs.utimesSync(latestOld, latestOldTime, latestOldTime);
    fs.utimesSync(newest, newestTime, newestTime);
    const response = await get(x.app, '/api/evidence');
    expect(response.json()).toEqual([
      { name: 'newer', file_count: 1, total_size: 3, modified_at: fs.statSync(newest).mtime.toISOString() },
      { name: 'older', file_count: 2, total_size: 3, modified_at: fs.statSync(latestOld).mtime.toISOString() },
      { name: 'empty', file_count: 0, total_size: 0, modified_at: null },
    ]);
  });

  it('refreshes a cached folder after nested files are added and removed', async () => {
    writeFile(x.evidenceDir, 'changing/nested/item.txt', 'a');
    const first = await get(x.app, '/api/evidence');
    expect(first.json()[0]).toMatchObject({ name: 'changing', file_count: 1, total_size: 1 });

    writeFile(x.evidenceDir, 'changing/nested/added.txt', 'bbb');
    writeFile(x.evidenceDir, 'changing/other/item.txt', 'z');
    const nested = path.join(x.evidenceDir, 'changing', 'nested');
    const newerDirectoryTime = new Date(Date.now() + 2_000);
    fs.utimesSync(nested, newerDirectoryTime, newerDirectoryTime);
    const second = await get(x.app, '/api/evidence');
    expect(second.json()[0]).toMatchObject({ name: 'changing', file_count: 1, total_size: 1 });
    await waitForEvidenceRefreshForTests(x.evidenceDir, 'changing');
    const third = await get(x.app, '/api/evidence');
    expect(third.json()[0]).toMatchObject({ name: 'changing', file_count: 3, total_size: 5 });

    const page = await get(x.app, '/api/evidence/changing?offset=0&limit=100');
    expect(page.json().files.map((file: { relative_path: string }) => file.relative_path)).toEqual([
      'nested/added.txt', 'nested/item.txt', 'other/item.txt',
    ]);
    expect(new Set(page.json().files.map((file: { relative_path: string }) => file.relative_path)).size).toBe(3);
    await waitForEvidenceRefreshForTests(x.evidenceDir, 'changing');

    fs.rmSync(path.join(nested, 'added.txt'));
    const fourth = await get(x.app, '/api/evidence');
    expect(fourth.json()[0]).toMatchObject({ name: 'changing', file_count: 3, total_size: 5 });
    await waitForEvidenceRefreshForTests(x.evidenceDir, 'changing');
    const fifth = await get(x.app, '/api/evidence');
    expect(fifth.json()[0]).toMatchObject({ name: 'changing', file_count: 2, total_size: 2 });
  });

  it('refreshes cached summary and file metadata when an existing file changes in place', async () => {
    const file = writeFile(x.evidenceDir, 'rewrite/report.txt', 'before');
    const folder = path.dirname(file);
    const first = await get(x.app, '/api/evidence');
    expect(first.json()[0]).toMatchObject({ name: 'rewrite', file_count: 1, total_size: 6 });
    const directoryMtime = fs.statSync(folder).mtimeMs;

    fs.writeFileSync(file, 'after rewrite is larger');
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(file, changedAt, changedAt);
    const fileStat = fs.statSync(file);
    expect(fs.statSync(folder).mtimeMs).toBe(directoryMtime);

    const second = await get(x.app, '/api/evidence');
    expect(second.json()[0]).toMatchObject({ name: 'rewrite', file_count: 1, total_size: 6 });
    await waitForEvidenceRefreshForTests(x.evidenceDir, 'rewrite');
    const third = await get(x.app, '/api/evidence');
    const page = await get(x.app, '/api/evidence/rewrite?offset=0&limit=100');
    expect(third.json()[0]).toMatchObject({ name: 'rewrite', file_count: 1, total_size: fileStat.size, modified_at: fileStat.mtime.toISOString() });
    expect(page.json().files).toEqual([{ relative_path: 'report.txt', size: fileStat.size, modified_at: fileStat.mtime.toISOString(), kind: 'text' }]);
    await waitForEvidenceRefreshForTests(x.evidenceDir, 'rewrite');
  });

  it('lets a trivial request complete during a small evidence listing', async () => {
    writeFile(x.evidenceDir, 'small/nested/first.txt', 'one');
    writeFile(x.evidenceDir, 'small/second.txt', 'two');
    const order: string[] = [];
    const listingPromise = get(x.app, '/api/evidence').then((response) => { order.push('listing'); return response; });
    const trivialPromise = new Promise<{ status: number; body: unknown }>((resolve) => {
      setImmediate(async () => {
        const response = await get(x.app, '/__evidence-test/trivial');
        order.push('trivial');
        resolve({ status: response.statusCode, body: response.json() });
      });
    });
    const [listing, trivial] = await Promise.all([listingPromise, trivialPromise]);
    expect({ order, trivial, folders: listing.json() }).toEqual({
      order: ['trivial', 'listing'],
      trivial: { status: 200, body: { ok: true } },
      folders: [{ name: 'small', file_count: 2, total_size: 6, modified_at: expect.any(String) }],
    });
  });

  it('caps evidence pages at 500 files and returns the final page', async () => {
    const folder = path.join(x.evidenceDir, 'page-limit');
    fs.mkdirSync(folder, { recursive: true });
    for (let index = 0; index < 501; index++) {
      const name = 'capture-' + String(index).padStart(3, '0') + '.txt';
      fs.writeFileSync(path.join(folder, name), 'x');
    }

    const first = await get(x.app, '/api/evidence/page-limit?offset=0&limit=999');
    const last = await get(x.app, '/api/evidence/page-limit?offset=500&limit=999');
    expect({ first: first.json().files.length, total: first.json().total, next: first.json().next_offset }).toEqual({ first: 500, total: 501, next: 500 });
    expect({ last: last.json().files.length, file: last.json().files[0].relative_path, total: last.json().total, next: last.json().next_offset }).toEqual({ last: 1, file: 'capture-500.txt', total: 501, next: null });
  });

  it('lists and opens a folder with a very long name', async () => {
    const name = `long-${'x'.repeat(160)}`;
    writeFile(x.evidenceDir, `${name}/entry.txt`, 'long');
    const list = await get(x.app, '/api/evidence');
    const folder = list.json().find((entry: { name: string }) => entry.name === name);
    const files = await get(x.app, `/api/evidence/${encodeURIComponent(name)}?limit=10`);
    expect(files.statusCode).toBe(200);
    expect({ folder, files: files.json().files.map((file: { relative_path: string }) => file.relative_path) }).toEqual({
      folder: { name, file_count: 1, total_size: 4, modified_at: expect.any(String) }, files: ['entry.txt'],
    });
  });

  it('keeps a real root folder reachable beside the synthetic root entry', async () => {
    writeFile(x.evidenceDir, 'first.txt', 'one');
    writeFile(x.evidenceDir, 'second.md', 'two!');
    writeFile(x.evidenceDir, 'root/inside.txt', 'inside');
    writeFile(x.evidenceDir, 'batch/nested.txt', 'nested');
    const list = await get(x.app, '/api/evidence');
    const rootFiles = await get(x.app, '/api/evidence/%3Cevidence-root%3E');
    const realRoot = await get(x.app, '/api/evidence/root');
    const syntheticFile = await get(x.app, fileUrl('<evidence-root>', 'first.txt'));
    const realRootFile = await get(x.app, fileUrl('root', 'inside.txt'));
    expect({ names: list.json().map((entry: { name: string }) => entry.name).sort(), synthetic: rootFiles.json().map((entry: { relative_path: string }) => entry.relative_path), real: realRoot.json().map((entry: { relative_path: string }) => entry.relative_path), bodies: [syntheticFile.body, realRootFile.body] }).toEqual({
      names: ['<evidence-root>', 'batch', 'root'],
      synthetic: ['first.txt', 'second.md'],
      real: ['inside.txt'],
      bodies: ['one', 'inside'],
    });
  });

  it('lists nested files recursively with relative paths and path ordering', async () => {
    const first = writeFile(x.evidenceDir, 'batch/a.txt', 'a');
    writeFile(x.evidenceDir, 'batch/deep/b.md', 'bb');
    writeFile(x.evidenceDir, 'batch/z.txt', 'zzz');
    const firstTime = new Date('2023-01-01T00:00:00.000Z');
    fs.utimesSync(first, firstTime, firstTime);
    const response = await get(x.app, '/api/evidence/batch');
    expect(response.json().map((file: { relative_path: string; size: number; kind: string; modified_at: string }) => [file.relative_path, file.size, file.kind, file.modified_at])).toEqual([
      ['a.txt', 1, 'text', fs.statSync(first).mtime.toISOString()], ['deep/b.md', 2, 'text', expect.any(String)], ['z.txt', 3, 'text', expect.any(String)],
    ]);
  });

  it('serves a folder whose name is also a route word', async () => {
    writeFile(x.evidenceDir, 'health/status.txt', 'ok');
    const response = await get(x.app, '/api/evidence/health');
    expect({ status: response.statusCode, paths: response.json().map((file: { relative_path: string }) => file.relative_path) }).toEqual({ status: 200, paths: ['status.txt'] });
  });

  it('serves file names with spaces', async () => {
    writeFile(x.evidenceDir, 'batch/a screen.png', 'pixels');
    const response = await get(x.app, fileUrl('batch', 'a screen.png'));
    expect({ status: response.statusCode, type: response.headers['content-type'], body: response.body }).toEqual({ status: 200, type: 'image/png', body: 'pixels' });
  });

  it('serves file names with non-ASCII characters', async () => {
    writeFile(x.evidenceDir, 'batch/überblick.txt', 'Grüße');
    const response = await get(x.app, fileUrl('batch', 'überblick.txt'));
    expect({ status: response.statusCode, type: response.headers['content-type'], body: response.body }).toEqual({ status: 200, type: 'text/plain; charset=utf-8', body: 'Grüße' });
  });

  it('serves a requested byte range for a video', async () => {
    writeFile(x.evidenceDir, 'batch/capture.mp4', '0123456789');
    const response = await x.app.inject({ method: 'GET', url: fileUrl('batch', 'capture.mp4'), headers: { range: 'bytes=2-5' } });
    expect({ status: response.statusCode, acceptRanges: response.headers['accept-ranges'], contentRange: response.headers['content-range'], contentLength: response.headers['content-length'], body: response.body }).toEqual({
      status: 206, acceptRanges: 'bytes', contentRange: 'bytes 2-5/10', contentLength: '4', body: '2345',
    });
  });

  it('returns 416 for a byte range beyond the end of a video', async () => {
    writeFile(x.evidenceDir, 'batch/capture.mp4', '0123456789');
    const response = await x.app.inject({ method: 'GET', url: fileUrl('batch', 'capture.mp4'), headers: { range: 'bytes=10-' } });
    expect({ status: response.statusCode, acceptRanges: response.headers['accept-ranges'], contentRange: response.headers['content-range'] }).toEqual({ status: 416, acceptRanges: 'bytes', contentRange: 'bytes */10' });
  });

  const kindCases: Array<{ extension: string; kind: string; contentType: string }> = [
    { extension: '.png', kind: 'image', contentType: 'image/png' },
    { extension: '.jpg', kind: 'image', contentType: 'image/jpeg' },
    { extension: '.jpeg', kind: 'image', contentType: 'image/jpeg' },
    { extension: '.gif', kind: 'image', contentType: 'image/gif' },
    { extension: '.webp', kind: 'image', contentType: 'image/webp' },
    { extension: '.svg', kind: 'image', contentType: 'image/svg+xml' },
    { extension: '.mp4', kind: 'video', contentType: 'video/mp4' },
    { extension: '.webm', kind: 'video', contentType: 'video/webm' },
    { extension: '.html', kind: 'html', contentType: 'text/html; charset=utf-8' },
    { extension: '.txt', kind: 'text', contentType: 'text/plain; charset=utf-8' },
    { extension: '.md', kind: 'text', contentType: 'text/markdown; charset=utf-8' },
    { extension: '.log', kind: 'text', contentType: 'text/plain; charset=utf-8' },
    { extension: '.json', kind: 'text', contentType: 'application/json' },
    { extension: '.csv', kind: 'text', contentType: 'text/csv; charset=utf-8' },
    { extension: '.bin', kind: 'other', contentType: 'application/octet-stream' },
  ];

  it.each(kindCases)('classifies and serves $extension with its content type', async ({ extension, kind, contentType }) => {
    const name = `sample${extension}`;
    writeFile(x.evidenceDir, `batch/${name}`, 'sample');
    const listing = await get(x.app, '/api/evidence/batch');
    const file = await get(x.app, fileUrl('batch', name));
    expect({ kind: listing.json()[0]?.kind, contentType: file.headers['content-type'] }).toEqual({ kind, contentType });
  });

  it.each([
    { extension: '.html', contentType: 'text/html; charset=utf-8' },
    { extension: '.svg', contentType: 'image/svg+xml' },
  ])('sandboxes $extension evidence with an opaque origin', async ({ extension, contentType }) => {
    const name = `sample${extension}`;
    writeFile(x.evidenceDir, `batch/${name}`, '<svg/>');
    const response = await get(x.app, fileUrl('batch', name));
    expect({ status: response.statusCode, contentType: response.headers['content-type'], csp: response.headers['content-security-policy'] }).toEqual({ status: 200, contentType, csp: 'sandbox allow-scripts' });
  });

  it('sends other evidence as a download', async () => {
    writeFile(x.evidenceDir, 'batch/archive.bin', Buffer.from([0, 1, 2]));
    const response = await get(x.app, fileUrl('batch', 'archive.bin'));
    expect({ type: response.headers['content-type'], disposition: response.headers['content-disposition'] }).toEqual({ type: 'application/octet-stream', disposition: 'attachment' });
  });

  const traversalPaths = [
    { name: 'parent segments', path: 'batch/../../outside/secret.txt' },
    { name: 'encoded parent segments', path: 'batch/%2e%2e/%2e%2e/outside/secret.txt' },
    { name: 'backslashes', path: 'batch/%5C..%5C..%5Coutside%5Csecret.txt' },
    { name: 'absolute paths', path: 'batch/%2Foutside%2Fsecret.txt' },
    { name: 'drive letters', path: 'batch/C%3A%5Coutside%5Csecret.txt' },
  ];

  it.each(traversalPaths)('returns 404 for $name', async ({ path: requestedPath }) => {
    fs.mkdirSync(path.join(x.evidenceDir, 'batch'), { recursive: true });
    writeFile(x.dataDir, 'outside/secret.txt', 'outside sentinel');
    const response = await get(x.app, `/api/evidence/${requestedPath}`);
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for an outside junction', async () => {
    const outside = path.join(x.dataDir, 'external');
    fs.mkdirSync(outside, { recursive: true });
    writeFile(outside, 'secret.txt', 'outside sentinel');
    fs.mkdirSync(x.evidenceDir, { recursive: true });
    fs.symlinkSync(outside, path.join(x.evidenceDir, 'linked'), 'junction');
    const list = await get(x.app, '/api/evidence');
    const folder = await get(x.app, '/api/evidence/linked?limit=100');
    const response = await get(x.app, '/api/evidence/linked/secret.txt');
    expect({ names: list.json().map((entry: { name: string }) => entry.name), folder: folder.statusCode, file: response.statusCode }).toEqual({ names: [], folder: 404, file: 404 });
  });

  it.each(writeMethods)('does not expose a %s evidence route', async (method) => {
    const response = await x.app.inject({ method, url: '/api/evidence' });
    expect(response.statusCode).toBe(404);
  });
});
