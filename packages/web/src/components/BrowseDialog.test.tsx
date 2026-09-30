import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { BrowseDialog, parentOf } from './BrowseDialog';
import { mockApi } from '../test/setup';
import fs from 'node:fs';
import path from 'node:path';
import { PHONE_MEDIA } from '../test/phoneMedia';

describe('BrowseDialog', () => {
  it('computes parents', () => {
    expect(parentOf('E:\\Projects\\demo')).toBe('E:\\Projects');
    expect(parentOf('E:\\Projects')).toBe('E:\\');
    expect(parentOf('E:\\')).toBeNull();
    expect(parentOf('/home/x')).toBe('/home');
    expect(parentOf('/home')).toBeNull();
  });
  it('starts at the parent, navigates and selects', async () => {
    const urls: string[] = [];
    mockApi((_m, url) => {
      urls.push(url);
      if (url === '/api/fs/browse') return { path: null, parent: null, entries: [{ name: 'E:', path: 'E:\\', is_git_repo: false }] };
      const p = decodeURIComponent(url.split('?path=')[1] ?? '');
      if (p === 'E:\\Projects') return { path: 'E:\\Projects', parent: 'E:\\', entries: [{ name: 'demo', path: 'E:\\Projects\\demo', is_git_repo: true }, { name: 'plain', path: 'E:\\Projects\\plain', is_git_repo: false }] };
      if (p === 'E:\\Projects\\plain') return { path: 'E:\\Projects\\plain', parent: 'E:\\Projects', entries: [] };
      if (p === 'E:\\') return { path: 'E:\\', parent: null, entries: [{ name: 'Projects', path: 'E:\\Projects', is_git_repo: false }] };
      throw Object.assign(new Error('cannot read ' + p), { status: 400 });
    });
    let picked = '';
    render(<BrowseDialog initialPath={'E:\\Projects\\demo'} onPick={(p) => { picked = p; }} onClose={() => {}} />);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true); // keyboard users start inside the dialog
    await waitFor(() => expect(screen.getByText('E:\\Projects')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Select' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'plain' }));
    await waitFor(() => expect(screen.getByText('E:\\Projects\\plain')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(() => expect(screen.getByText('E:\\Projects')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(picked).toBe('E:\\Projects\\demo');
  });

  // Round 24 R24-1: the dialog teaches "click the name to go in", and going into the repository itself left an empty box with no
  // Select button, no explanation and no way out but Up.
  it('selects the folder it is standing in and says when that folder has no sub-folders', async () => {
    mockApi((_m, url) => {
      if (url === '/api/fs/browse') return { path: null, parent: null, entries: [{ name: 'E:', path: 'E:\\', is_git_repo: false }] };
      const p = decodeURIComponent(url.split('?path=')[1] ?? '');
      if (p === 'E:\\Projects') return { path: 'E:\\Projects', parent: 'E:\\', entries: [{ name: 'demo', path: 'E:\\Projects\\demo', is_git_repo: true }] };
      return { path: p, parent: 'E:\\Projects', entries: [] };
    });
    let picked = '';
    render(<BrowseDialog initialPath={'E:\\Projects\\demo'} onPick={(x) => { picked = x; }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('E:\\Projects')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'demo' })); // into the repository, the way the rows taught
    await waitFor(() => expect(screen.getByText('E:\\Projects\\demo')).toBeTruthy());
    expect(screen.getByText('No sub-folders in here. Select this folder, or go Up.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }));
    expect(picked).toBe('E:\\Projects\\demo');
  });

  // Round 25 R25-1: the dialog rendered every sub-folder of a generated directory (16,156 rows, 406,036 px) with no filter, and the
  // folder the Path field named was neither scrolled to nor marked, 159,000 px down the list. Posix paths here: the dialog reads both separators.
  it('filters the listing and marks the folder the Path field named', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `folder-${i}`, path: `/projects/folder-${i}`, is_git_repo: false }));
    mockApi((_m, url) => {
      const path = decodeURIComponent(url.split('?path=')[1] ?? '');
      if (path === '/projects') return { path, parent: '/', entries: [...many, { name: 'demo', path: '/projects/demo', is_git_repo: true }] };
      return { path, parent: '/projects', entries: [] };
    });
    render(<BrowseDialog initialPath="/projects/demo" onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('/projects')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'demo' }).getAttribute('aria-current')).toBe('true'); // the one the Path field named
    const filter = screen.getByLabelText('Filter this folder');
    fireEvent.change(filter, { target: { value: 'folder-1' } });
    expect(screen.getAllByRole('button', { name: /^folder-1/ })).toHaveLength(11); // folder-1 and folder-10 to folder-19
    expect(screen.queryByRole('button', { name: 'demo' })).toBeNull();
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText('No folder here matches "zzz".')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'folder-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'folder-2' }));
    await waitFor(() => expect(screen.getByText('/projects/folder-2')).toBeTruthy());
    expect((filter as HTMLInputElement).value).toBe(''); // the filter belonged to the listing it was typed for
  });

  it('closes on Escape, takes focus while open and gives it back to the opener', async () => {
    mockApi(() => ({ path: null, parent: null, entries: [] }));
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    let closed = 0;
    const { unmount } = render(<BrowseDialog initialPath="" onPick={() => {}} onClose={() => { closed++; }} />);
    await waitFor(() => expect(screen.getByText('Drives')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Select this folder' }) as HTMLButtonElement).disabled).toBe(true); // the drive list is no folder
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Browse folders' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toBe(1);
    unmount(); // the parent removes the dialog on close
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it('falls back to the roots when the start folder cannot be read', async () => {
    mockApi((_m, url) => {
      if (url === '/api/fs/browse') return { path: null, parent: null, entries: [{ name: 'C:', path: 'C:\\', is_git_repo: false }] };
      throw Object.assign(new Error('cannot read'), { status: 400 });
    });
    render(<BrowseDialog initialPath={'Z:\\nope\\x'} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'C:' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Up' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shimmers a folder-list-shaped placeholder while the first listing is in flight, then the folders', async () => {
    let release!: (v: unknown) => void;
    mockApi(() => new Promise<unknown>((r) => { release = r; }));
    render(<BrowseDialog initialPath="" onPick={() => {}} onClose={() => {}} />);
    const shimmer = await screen.findByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(shimmer.querySelectorAll('.shimmer-measure-container .browse-list li')).toHaveLength(6);
    // The shimmer wrapper sits in the sizing box, not in its place: on a phone the box grows so the footer stays at the sheet's bottom.
    expect(shimmer.parentElement?.className).toBe('browse-box');
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(new RegExp(String.raw`@media ${PHONE_MEDIA}[\s\S]*\.browse-box \{ flex: 1; \}`));
    release({ path: '/home/me', parent: '/home', entries: [{ name: 'demo', path: '/home/me/demo', is_git_repo: true }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'demo' })).toBeTruthy());
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByRole('button', { name: 'demo' }).closest('.browse-list')?.parentElement?.className).toBe('browse-box');
  });

  it('stops the shimmer once the listing has failed, rather than shimmering for the whole outage', async () => {
    mockApi(() => { throw Object.assign(new Error('cannot read the drives'), { status: 500 }); });
    render(<BrowseDialog initialPath="" onPick={() => {}} onClose={() => {}} />);
    await screen.findByText('cannot read the drives');
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('keeps the rows it has while a navigation is in flight instead of shimmering again', async () => {
    let release: ((v: unknown) => void) | null = null;
    mockApi((_m, url) => {
      if (url === '/api/fs/browse') return { path: null, parent: null, entries: [{ name: 'home', path: '/home', is_git_repo: false }] };
      return new Promise<unknown>((r) => { release = r; });
    });
    render(<BrowseDialog initialPath="" onPick={() => {}} onClose={() => {}} />);
    const first = await screen.findByRole('button', { name: 'home' });
    fireEvent.click(first);
    await waitFor(() => expect(release).not.toBeNull());
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'home' })).toBeTruthy();
  });
});
