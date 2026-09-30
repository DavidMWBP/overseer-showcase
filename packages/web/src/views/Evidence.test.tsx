import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Evidence } from './Evidence';
import { evidenceFileUrl, evidenceFolderFromHash, evidenceHash } from '../lib/evidence';
import { mockApi } from '../test/setup';

const files = (rows: unknown[]) => mockApi((_method, url) => url === '/api/evidence' ? rows : ({ files: rows, total: rows.length, next_offset: null }));
const textFile = (relative_path: string) => ({ relative_path, size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'text' as const });
const fileRows = (length: number) => Array.from({ length }, (_, index) => textFile('capture-' + String(index).padStart(3, '0') + '.txt'));
const pageAt = (rows: ReturnType<typeof textFile>[], offset: number) => {
  const page = rows.slice(offset, offset + 100);
  const next = offset + page.length;
  return { files: page, total: rows.length, next_offset: next < rows.length ? next : null };
};

describe('Evidence', () => {
  it('keeps the thumbnail grid fluid and long file names wrapping', () => {
    const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    expect(css).toMatch(/\.evidence-files \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 150px\), 1fr\)\)[^}]*\}[\s\S]*\.evidence-file-name, \.evidence-file-link \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.evidence-pagination \{[^}]*display: flex[^}]*\}[\s\S]*\.evidence-load-more \{[^}]*min-height: 44px;/);
  });

  it('shows the arrived folder shape in its loading placeholder', () => {
    mockApi(() => new Promise(() => {}));
    render(<Evidence folder={null} />);
    expect(screen.getByTestId('shimmer').querySelector('.evidence-folder')).toBeTruthy();
  });

  it('stops shimmering and reports a failed initial fetch', async () => {
    mockApi(() => { throw new TypeError('offline'); });
    render(<Evidence folder={null} />);
    const alert = await screen.findByRole('alert');
    expect({ message: alert.textContent, shimmer: screen.queryByTestId('shimmer') }).toEqual({ message: 'Could not load evidence: offline', shimmer: null });
  });

  it('shows the empty list state when there are no folders', async () => {
    files([]);
    render(<Evidence folder={null} />);
    expect(await screen.findByText('No evidence yet.')).toBeTruthy();
  });

  it('keeps the API order and shows folder count, size and local newest time', async () => {
    const date = '2026-09-24T21:30:00.000Z';
    files([
      { name: 'newest', file_count: 3, total_size: 1536, modified_at: date },
      { name: 'older', file_count: 1, total_size: 5, modified_at: '2026-09-23T10:00:00.000Z' },
    ]);
    render(<Evidence folder={null} />);
    const names = await screen.findAllByRole('link');
    expect({ names: names.map((link) => link.textContent), newest: names[0]?.closest('li')?.textContent, localTime: names[0]?.closest('li')?.querySelector('time')?.textContent }).toEqual({
      names: ['newest', 'older'], newest: `newest3 files · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(1.5)} KB${new Date(date).toLocaleString()}`, localTime: new Date(date).toLocaleString(),
    });
  });

  it('shows a readable label for the synthetic root folder', async () => {
    files([{ name: '<evidence-root>', file_count: 1, total_size: 5, modified_at: null }]);
    render(<Evidence folder={null} />);
    expect({ name: (await screen.findByRole('link', { name: 'Evidence root' })).textContent, href: screen.getByRole('link', { name: 'Evidence root' }).getAttribute('href') }).toEqual({ name: 'Evidence root', href: '#evidence/%3Cevidence-root%3E' });
  });

  it('loads the folder named in the hash after a fresh render', async () => {
    const hash = evidenceHash('office-pixi-style');
    location.hash = hash;
    files([]);
    render(<Evidence folder={evidenceFolderFromHash(location.hash)} />);
    expect({ hash: location.hash, title: (await screen.findByRole('heading', { name: 'office-pixi-style' })).textContent, empty: (await screen.findByText('This folder is empty.')).textContent }).toEqual({
      hash, title: 'office-pixi-style', empty: 'This folder is empty.',
    });
  });

  it('opens a folder link by writing the encoded folder into the hash', async () => {
    files([{ name: 'office pixi-style', file_count: 0, total_size: 0, modified_at: null }]);
    render(<Evidence folder={null} />);
    const link = await screen.findByRole('link', { name: 'office pixi-style' });
    fireEvent.click(link);
    expect({ href: link.getAttribute('href'), hash: location.hash }).toEqual({ href: '#evidence/office%20pixi-style', hash: '#evidence/office%20pixi-style' });
  });

  it('does not render folder-list records as files while opening a folder', async () => {
    mockApi((_method, url) => url === '/api/evidence'
      ? [{ name: 'office-pixi-style', file_count: 0, total_size: 0, modified_at: null }]
      : ({ files: [], total: 0, next_offset: null }));
    const { rerender } = render(<Evidence folder={null} />);
    await screen.findByRole('link', { name: 'office-pixi-style' });
    rerender(<Evidence folder="office-pixi-style" />);
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
  });

  it('loads file pages only when opened and gives later pages their own loading state', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      relative_path: `capture-${String(index).padStart(3, '0')}.txt`, size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'text',
    }));
    const lastFile = { relative_path: 'capture-100.txt', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'text' };
    let finishFirstPage!: (page: unknown) => void;
    let finishLastPage!: (page: unknown) => void;
    const requests: string[] = [];
    mockApi((_method, url) => {
      requests.push(url);
      if (url === '/api/evidence') return [{ name: 'large', file_count: 101, total_size: 101, modified_at: '2026-09-24T00:00:00.000Z' }];
      if (url === '/api/evidence/large?offset=0&limit=100') return new Promise((resolve) => { finishFirstPage = resolve; });
      if (url === '/api/evidence/large?offset=100&limit=100') return new Promise((resolve) => { finishLastPage = resolve; });
      return { files: [], total: 0, next_offset: null };
    });

    const { rerender } = render(<Evidence folder={null} />);
    await screen.findByRole('link', { name: 'large' });
    expect(requests).toEqual(['/api/evidence']);

    rerender(<Evidence folder="large" />);
    expect(screen.getByTestId('shimmer')).toBeTruthy();
    expect(requests).toEqual(['/api/evidence', '/api/evidence/large?offset=0&limit=100']);
    await act(async () => finishFirstPage({ files: firstPage, total: 101, next_offset: 100 }));
    expect(await screen.findByRole('link', { name: 'capture-000.txt' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Showing 100 of 101 files.');

    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    expect(screen.getByRole('button', { name: 'Loading more files…' }).hasAttribute('disabled')).toBe(true);
    expect(requests).toEqual(['/api/evidence', '/api/evidence/large?offset=0&limit=100', '/api/evidence/large?offset=100&limit=100']);
    await act(async () => finishLastPage({ files: [lastFile], total: 101, next_offset: null }));
    expect(await screen.findByRole('link', { name: 'capture-100.txt' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Showing 101 of 101 files.');
    expect(screen.queryByRole('button', { name: 'Load more files' })).toBeNull();
  });

  it('reloads page one when files are added between pages', async () => {
    const original = fileRows(101);
    const updated = [...original, textFile('capture-050a.txt')].sort((left, right) => left.relative_path.localeCompare(right.relative_path));
    let currentRows = original;
    let changed = false;
    const requests: string[] = [];
    const consoleError = vi.spyOn(console, 'error');
    mockApi((_method, url) => {
      requests.push(url);
      if (url === '/api/evidence') return [{ name: 'large', file_count: original.length, total_size: original.length, modified_at: null }];
      if (url === '/api/evidence/large?offset=100&limit=100' && !changed) {
        currentRows = updated;
        changed = true;
      }
      if (url.startsWith('/api/evidence/large?offset=')) return pageAt(currentRows, url.includes('offset=100') ? 100 : 0);
      return { files: [], total: 0, next_offset: null };
    });

    render(<Evidence folder="large" />);
    expect(await screen.findByText('Showing 100 of 101 files.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    expect(await screen.findByText('capture-050a.txt')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Showing 100 of 102 files.');
    expect({
      visible: [...document.querySelectorAll<HTMLAnchorElement>('.evidence-files a')].map((link) => link.textContent),
      count: document.querySelectorAll('.evidence-files > *').length,
      pageOneRequests: requests.filter((url) => url === '/api/evidence/large?offset=0&limit=100').length,
    }).toEqual({ visible: updated.slice(0, 100).map((file) => file.relative_path), count: 100, pageOneRequests: 2 });

    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    expect(await screen.findByText('Showing 102 of 102 files.')).toBeTruthy();
    const duplicateKeyWarnings = consoleError.mock.calls.flatMap((call) => call.map(String)).filter((message) => /same key/i.test(message));
    expect({
      visible: [...document.querySelectorAll<HTMLAnchorElement>('.evidence-files a')].map((link) => link.textContent),
      count: document.querySelectorAll('.evidence-files > *').length,
      duplicateKeyWarnings,
    }).toEqual({ visible: updated.map((file) => file.relative_path), count: 102, duplicateKeyWarnings: [] });
    consoleError.mockRestore();
  });

  it('reloads page one when files are removed between pages', async () => {
    const original = fileRows(121);
    const updated = original.filter((file) => file.relative_path !== 'capture-020.txt');
    let currentRows = original;
    let changed = false;
    const consoleError = vi.spyOn(console, 'error');
    mockApi((_method, url) => {
      if (url === '/api/evidence') return [{ name: 'large', file_count: original.length, total_size: original.length, modified_at: null }];
      if (url === '/api/evidence/large?offset=100&limit=100' && !changed) {
        currentRows = updated;
        changed = true;
      }
      if (url.startsWith('/api/evidence/large?offset=')) return pageAt(currentRows, url.includes('offset=100') ? 100 : 0);
      return { files: [], total: 0, next_offset: null };
    });

    render(<Evidence folder="large" />);
    expect(await screen.findByText('Showing 100 of 121 files.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    expect(await screen.findByText('Showing 100 of 120 files.')).toBeTruthy();
    expect({
      visible: [...document.querySelectorAll<HTMLAnchorElement>('.evidence-files a')].map((link) => link.textContent),
      count: document.querySelectorAll('.evidence-files > *').length,
      removedFile: screen.queryByText('capture-020.txt'),
      shiftedFile: screen.queryByText('capture-100.txt')?.textContent,
    }).toEqual({ visible: updated.slice(0, 100).map((file) => file.relative_path), count: 100, removedFile: null, shiftedFile: 'capture-100.txt' });

    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    expect(await screen.findByText('Showing 120 of 120 files.')).toBeTruthy();
    const duplicateKeyWarnings = consoleError.mock.calls.flatMap((call) => call.map(String)).filter((message) => /same key/i.test(message));
    expect({
      visible: [...document.querySelectorAll<HTMLAnchorElement>('.evidence-files a')].map((link) => link.textContent),
      count: document.querySelectorAll('.evidence-files > *').length,
      duplicateKeyWarnings,
    }).toEqual({ visible: updated.map((file) => file.relative_path), count: 120, duplicateKeyWarnings: [] });
    consoleError.mockRestore();
  });

  it('renders image, video, HTML, text and download links at encoded file routes', async () => {
    const folder = 'office pixi';
    files([
      { relative_path: 'my screen.png', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'image' },
      { relative_path: 'still β.webp', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'image' },
      { relative_path: 'captures/café clip.mp4', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'video' },
      { relative_path: 'report page.html', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'html' },
      { relative_path: 'notes déjà.md', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'text' },
      { relative_path: 'archive dump.bin', size: 1, modified_at: '2026-09-24T00:00:00.000Z', kind: 'other' },
    ]);
    render(<Evidence folder={folder} />);
    await screen.findByRole('img', { name: 'my screen.png' });
    await screen.findByRole('link', { name: 'report page.html' });
    expect({
      images: [...document.querySelectorAll<HTMLImageElement>('.evidence-image img')].map((img) => [img.getAttribute('src'), img.alt, img.closest('a')?.getAttribute('href'), img.closest('a')?.target, img.closest('a')?.title]),
      video: document.querySelector<HTMLVideoElement>('video')?.getAttribute('src'),
      html: [...document.querySelectorAll<HTMLAnchorElement>('.evidence-file-link a')].map((link) => [link.textContent, link.getAttribute('href'), link.target, link.hasAttribute('download'), link.title]),
    }).toEqual({
      images: [
        [evidenceFileUrl(folder, 'my screen.png'), 'my screen.png', evidenceFileUrl(folder, 'my screen.png'), '_blank', 'my screen.png'],
        [evidenceFileUrl(folder, 'still β.webp'), 'still β.webp', evidenceFileUrl(folder, 'still β.webp'), '_blank', 'still β.webp'],
      ],
      video: evidenceFileUrl(folder, 'captures/café clip.mp4'),
      html: [
        ['report page.html', evidenceFileUrl(folder, 'report page.html'), '_blank', false, 'report page.html'],
        ['notes déjà.md', evidenceFileUrl(folder, 'notes déjà.md'), '', false, 'notes déjà.md'],
        ['archive dump.bin', evidenceFileUrl(folder, 'archive dump.bin'), '', true, 'archive dump.bin'],
      ],
    });
  });

  it('shows the empty folder state', async () => {
    files([]);
    render(<Evidence folder="empty" />);
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
  });

  it('shows an unknown folder name and a back link', async () => {
    mockApi(() => { throw Object.assign(new Error('Not Found'), { status: 404 }); });
    render(<Evidence folder="missing captures" />);
    expect({ message: (await screen.findByText('No evidence folder named missing captures.')).textContent, back: (await screen.findByRole('link', { name: '‹ Back to Evidence' })).getAttribute('href') }).toEqual({
      message: 'No evidence folder named missing captures.', back: '#evidence',
    });
  });

  it('returns to the list through the back link', async () => {
    location.hash = evidenceHash('office-pixi-style');
    files([]);
    render(<Evidence folder="office-pixi-style" />);
    const back = await screen.findByRole('link', { name: '‹ Back to Evidence' });
    fireEvent.click(back);
    expect({ href: back.getAttribute('href'), hash: location.hash }).toEqual({ href: '#evidence', hash: '#evidence' });
  });
});
