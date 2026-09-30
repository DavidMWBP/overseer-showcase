import fs from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { InspectResponse } from '@overseer/shared';
import { RESTART_POLL_TIMEOUT_MS, Setup, doctorAlert } from './Setup';
import { mockApi } from '../test/setup';
import { repo, doctorOk, doctorBad, inspectNoBeads, inspectBad } from '../test/fixtures';
import { PHONE_MEDIA } from '../test/phoneMedia';

type Call = { method: string; url: string; body?: unknown };

/** Setup shows one section at a time, General by default: open the one a test works in. */
const open = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const sections = () => screen.getAllByRole('heading', { level: 2 }).map((h) => Array.from(h.childNodes).filter((n) => n.nodeName !== 'BUTTON').map((n) => n.textContent).join('').trim());
/** General holds two blocks that each wait on their own fetch, so a shimmer assertion names the one it means. */
const prerequisites = (container: HTMLElement) => container.querySelector('.setup-content section');
const shimmers = (el: Element | null) => el?.querySelector('[data-testid="shimmer"]') !== null && el !== null;
const noApi = () => mockApi((_method, url) => { throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });

describe('Setup', () => {
  it('waits longer than the daemon handoff budget before reporting a restart failure', () => {
    expect(RESTART_POLL_TIMEOUT_MS).toBeGreaterThan(40_000);
  });

  it('counts slow status reads against the wall-clock restart polling deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('confirm', () => true);
    let daemonReads = 0;
    mockApi(async (method, url) => {
      if (method === 'GET' && url.endsWith('/api/daemon')) {
        daemonReads += 1;
        if (daemonReads > 1) await new Promise((resolve) => setTimeout(resolve, 120_000));
        return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false, restart_in_progress: true, restart_failure: null };
      }
      if (method === 'POST' && url.endsWith('/api/daemon/restart')) return { ok: true, pid: 123 };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    try {
      render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(RESTART_POLL_TIMEOUT_MS + 60_000);
      });
      expect({ reads: daemonReads - 1, failure: screen.getByRole('alert').textContent }).toEqual({
        reads: 3,
        failure: 'Timed out waiting for the daemon to restart.',
      });
    } finally { vi.useRealTimers(); }
  });

  it.each([null, 'classic', 'pixi'])('offers no Office renderer setting in General with a stored value of %s', (stored) => {
    if (stored) localStorage.setItem('overseer.officeRenderer', stored);
    noApi();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect({
      general: screen.getByRole('heading', { name: 'Usage' }) !== null,
      officeHeading: screen.queryByRole('heading', { name: 'Office' }),
      select: screen.queryByRole('combobox', { name: 'Office renderer' }),
      pixiOption: screen.queryByRole('option', { name: 'Pixi (preview)' }),
    }).toEqual({ general: true, officeHeading: null, select: null, pixiOption: null });
  });

  it('opens Usage from General, the phone’s only way in', () => {
    noApi();
    const onOpenUsage = vi.fn();
    render(<Setup repos={[]} doctor={doctorOk} onOpenUsage={onOpenUsage} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open usage' }));
    expect(onOpenUsage).toHaveBeenCalled();
  });

  it('shows General by default and one section per nav entry', () => {
    noApi();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['General', 'Models', 'Accounts', 'Notifications', 'Repositories']);
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).classList.contains('active')).toBe(true);
    expect(sections()).toEqual(['Prerequisites', 'Usage', 'Daemon']);
    open('Models');
    expect(sections()).toEqual(['Models']);
    expect(screen.getByRole('tab', { name: 'Models' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('false');
    open('Accounts');
    expect(sections()).toEqual(['Accounts']);
    open('Notifications');
    expect(sections()).toEqual(['Notifications']);
    open('Repositories');
    expect(sections()).toEqual(['Repositories', 'Add repository']);
    expect(screen.getByText('No repositories registered yet.')).toBeTruthy();
    open('General');
    expect(sections()).toEqual(['Prerequisites', 'Usage', 'Daemon']);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.setup-nav button\.active \{[^}]*var\(--accent\)/);
    expect(css).toMatch(/\.setup-body \{[^}]*grid-template-columns: 190px/);
    expect(css).toMatch(/\.setup label\.checkbox \{[^}]*display: flex;[^}]*align-items: flex-start;[^}]*gap: 4px;/);
    expect(css).toMatch(/\.setup label\.checkbox > input \{[^}]*min-height: 0;[^}]*margin-top: \.15em;/);
  });

  it('shows the phone-only Discussions and Evidence links with the exact prompt and no Office button', () => {
    noApi();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    const paragraph = document.querySelector('.setup-office-link');
    expect(paragraph?.textContent).toBe('Put one question to several models on the Discussions Experimental page. Worker screenshots and captures are on the Evidence page.');
    expect(screen.getByRole('button', { name: 'Discussions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Office' })).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.setup-office-link \{[^}]*display: none;/);
    expect(css).toMatch(new RegExp(String.raw`@media ${PHONE_MEDIA} \{[^}]*\.setup-office-link \{ display: block; \}`, 's'));
  });

  it('opens Discussions from Setup with the same phone-only link', () => {
    noApi();
    const onOpenDiscussions = vi.fn();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} onOpenDiscussions={onOpenDiscussions} />);
    expect(screen.getByText('Experimental')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discussions' }));
    expect(onOpenDiscussions).toHaveBeenCalledOnce();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.setup-office-link \{[^}]*display: none;/);
  });

  it('opens Evidence from Setup General', () => {
    noApi();
    const onOpenEvidence = vi.fn();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} onOpenEvidence={onOpenEvidence} />);
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });

  it('shimmers the repo list while it loads instead of claiming there are none, and shows the table and Add repository once it arrives', () => {
    noApi();
    const { rerender } = render(<Setup repos={null} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(screen.getByTestId('shimmer')).toBeTruthy();
    expect(screen.queryByText('No repositories registered yet.')).toBeNull();
    // The Add form belongs to a repo-less install, not to one whose list has not answered yet.
    expect(screen.queryByRole('heading', { level: 2, name: 'Add repository' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add repository' }).hasAttribute('disabled')).toBe(true);
    rerender(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add repository' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(repo.path)).toBeTruthy();
  });

  it('shows a saved filter beside the repository id and no summary for an empty filter', async () => {
    mockApi((_method, url) => url === '/api/accounts' ? [{ id: 'a1', name: 'Studio', label: 'Private', harness: 'claude' }] : url.endsWith('/preflight') ? { runs: [], crashes: [] } : []);
    const filtered = { ...repo, model_filter: { harnesses: ['claude' as const], models: ['opus'], accounts: ['a1'] } };
    const { rerender } = render(<Setup repos={[filtered]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    await waitFor(() => expect(screen.getByText('claude · opus · Studio')).toBeTruthy());
    rerender(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(document.querySelector('.repo-filter-summary')).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.repo-filter-summary \{[^}]*display: block/);
    expect(css).toMatch(/\.repo-model-groups \{[^}]*grid-template-columns: repeat\(3/);
    expect(css).toMatch(new RegExp(String.raw`@media ${PHONE_MEDIA} \{[\s\S]*?\.repo-model-groups \{ grid-template-columns: 1fr; \}`));
  });

  it('stops the repo shimmer once the list fetch has failed, rather than shimmering an invented table for the outage', () => {
    noApi();
    render(<Setup repos={null} doctor={doctorOk} offline onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.queryByText('No repositories registered yet.')).toBeNull();
  });

  it('stops the repo shimmer when the daemon answered the list fetch with an error, which leaves it reachable', () => {
    noApi();
    render(<Setup repos={null} doctor={doctorOk} loadFailed={(paths) => paths.includes('/repos')} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.queryByText('No repositories registered yet.')).toBeNull();
  });

  it('shimmers the prerequisites table while the doctor answer loads, and replaces it with the real rows', () => {
    noApi();
    const { container, rerender } = render(<Setup repos={[repo]} doctor={null} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(shimmers(prerequisites(container))).toBe(true);
    rerender(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(shimmers(prerequisites(container))).toBe(false);
    expect(screen.getByText('git version 2.45.0')).toBeTruthy();
  });

  it('stops the prerequisites shimmer once the doctor fetch has failed', () => {
    noApi();
    const { container } = render(<Setup repos={[repo]} doctor={null} offline onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(shimmers(prerequisites(container))).toBe(false);
    expect(screen.getByText('checking…')).toBeTruthy();
  });

  it('stops the prerequisites shimmer when the daemon answered the doctor fetch with an error, and keeps shimmering while another endpoint is the one that failed', () => {
    noApi();
    const { container, rerender } = render(<Setup repos={[repo]} doctor={null} loadFailed={(paths) => paths.includes('/repos')} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(shimmers(prerequisites(container))).toBe(true);
    rerender(<Setup repos={[repo]} doctor={null} loadFailed={(paths) => paths.includes('/doctor')} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(shimmers(prerequisites(container))).toBe(false);
    expect(screen.getByText('checking…')).toBeTruthy();
  });

  it('shimmers the daemon line while /daemon loads, and replaces it with the real one', async () => {
    mockApi((_method, url) => {
      if (url.includes('/daemon')) return { pid: 4242, started_at: '2026-09-12T10:00:00.000Z', commit: 'abc1234', source_head: 'abc1234', restart_needed: false, data_dir: 'C:/x', source_root: 'C:/y' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { container } = render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(shimmers(container.querySelector('#daemon'))).toBe(true);
    await waitFor(() => expect(screen.getByText(/pid 4242/)).toBeTruthy());
    expect(shimmers(container.querySelector('#daemon'))).toBe(false);
  });

  it('stops the daemon shimmer once /daemon has failed, leaving its error line', async () => {
    noApi();
    const { container } = render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(shimmers(container.querySelector('#daemon'))).toBe(false);
  });

  it('remembers the last section for the browser session', () => {
    noApi();
    const first = render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Notifications');
    expect(sessionStorage.getItem('overseer.setupSection')).toBe('notifications');
    first.unmount();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(sections()).toEqual(['Notifications']);
    expect(screen.getByRole('tab', { name: 'Notifications' }).getAttribute('aria-selected')).toBe('true');
  });

  it('selects General for the daemon target even when another section was remembered', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    sessionStorage.setItem('overseer.setupSection', 'accounts');
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} target="daemon" />);
    expect(await screen.findByText('Daemon', { selector: 'h2' })).toBeTruthy();
    expect(sections()).toEqual(['Prerequisites', 'Usage', 'Daemon']);
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(sessionStorage.getItem('overseer.setupSection')).toBe('general');
  });

  it('lets the user leave General after the daemon target selected it', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} target="daemon" />);
    await screen.findByText('Daemon', { selector: 'h2' });
    open('Models');
    expect(sections()).toEqual(['Models']);
    expect(screen.getByRole('tab', { name: 'Models' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens Repositories when another view sent the user here for a repository', () => {
    noApi();
    sessionStorage.setItem('overseer.setupSection', 'models');
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} sentFrom="Board" />);
    expect(screen.getByText('Board needs a repository, so Setup opened instead. Add one below and it works.')).toBeTruthy();
    expect(sections()).toEqual(['Repositories', 'Add repository']);
    expect(screen.getByRole('tab', { name: 'Repositories' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens Repositories for Chat\'s first-run Setup action and releases the target once applied', () => {
    noApi();
    const onTargeted = vi.fn();
    sessionStorage.setItem('overseer.setupSection', 'models');
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} target="repositories" onTargeted={onTargeted} />);
    expect(sections()).toEqual(['Repositories', 'Add repository']);
    expect(screen.getByRole('tab', { name: 'Repositories' }).getAttribute('aria-selected')).toBe('true');
    expect(onTargeted).toHaveBeenCalledTimes(1);
  });

  it('releases a pending daemon target when the user picks another section', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    const onTargeted = vi.fn();
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} target="daemon" onTargeted={onTargeted} />);
    await screen.findByText('Daemon', { selector: 'h2' });
    expect(onTargeted).not.toHaveBeenCalled(); // the 2s re-anchor window is still open
    open('Models');
    expect(onTargeted).toHaveBeenCalledTimes(1);
  });

  it('adds, logs in, verifies, and removes accounts', async () => {
    const calls: Call[] = []; let polls = 0; let verifies = 0;
    let finishVerify: ((value: { ok: boolean }) => void) | undefined;
    vi.stubGlobal('confirm', () => true);
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/accounts') return [{ id: 'a1', name: 'Personal', harness: 'codex', kind: 'codex_home', home: 'x', created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: true }];
      if (method === 'POST' && url === '/api/accounts') return {};
      if (method === 'POST' && url === '/api/accounts/a1/login') return { state: 'pending', code: 'ABCD-1234', url: 'https://auth.example/device', instructions: 'Open the URL and enter the code.' };
      if (method === 'GET' && url === '/api/accounts/a1/login') return ++polls === 1 ? { state: 'pending', code: 'ABCD-1234', url: 'https://auth.example/device', instructions: 'Open the URL and enter the code.' } : { state: 'done' };
      if (method === 'POST' && url === '/api/accounts/a1/verify') return ++verifies === 1 ? new Promise((resolve) => { finishVerify = resolve; }) : { ok: false, error: 'verify failed' };
      if (method === 'DELETE' && url === '/api/accounts/a1') throw Object.assign(new Error('account a1 is referenced by settings'), { status: 409 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Accounts');
    await screen.findByText('Personal');
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Account harness'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Account kind'), { target: { value: 'api_key' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: '/api/accounts', body: { name: 'Work', label: 'Work', harness: 'claude', kind: 'api_key', secret: 'key' } }));
    expect(screen.getByText('logged in')).toBeTruthy();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText('Open the link on any device, enter the code, approve.')).toBeTruthy();
    expect(screen.queryByText('Open the URL and enter the code.')).toBeNull();
    const loginLink = screen.getByRole('link', { name: 'https://auth.example/device' });
    expect(loginLink.classList.contains('account-login-url')).toBe(true);
    expect(loginLink.getAttribute('target')).toBe('_blank');
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.account-login-url \{[^}]*min-height: 44px;/);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(polls).toBe(1);
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(polls).toBe(2);
    expect(screen.getByText('Logged in')).toBeTruthy();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByRole('button', { name: 'Verifying…' })).toHaveProperty('disabled', true);
    finishVerify?.({ ok: true });
    expect(await screen.findByText('Verified')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('verify failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('account a1 is referenced by settings')).toBeTruthy();
  });
  it('logs in a Claude account with OAuth while keeping setup-token fallback', async () => {
    const calls: Call[] = []; let loggedIn = false;
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/accounts') return [{ id: 'c1', name: 'Work', harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: loggedIn }];
      if (method === 'POST' && url === '/api/accounts/c1/login') return { state: 'pending', url: 'https://claude.ai/oauth/authorize?code_challenge=challenge&state=state', instructions: 'Open the authorization link, then paste the code. As a fallback, run claude setup-token.' };
      if (method === 'POST' && url === '/api/accounts/c1/login/code') { loggedIn = true; return { state: 'done' }; }
      if (method === 'DELETE' && url === '/api/accounts/c1/login') return {};
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Accounts');
    await screen.findByText('Work');
    vi.useFakeTimers();
    // Claude opens its own PKCE authorize page; the same field still accepts a setup-token fallback.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Open the authorization link, then paste the code. As a fallback, run claude setup-token.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open Claude authorization' });
    expect(link.getAttribute('href')).toContain('code_challenge=challenge');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByText(/Fallback: paste the value from/)).toBeNull();
    const field = screen.getByLabelText('Authorization code or setup token') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'sk-token' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit' })); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toContainEqual({ method: 'POST', url: '/api/accounts/c1/login/code', body: { code: 'sk-token' } });
    expect(screen.getByText('Logged in')).toBeTruthy();
    // The token never survives into the next attempt.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); await vi.advanceTimersByTimeAsync(0); });
    expect((screen.getByLabelText('Authorization code or setup token') as HTMLInputElement).value).toBe('');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toContainEqual({ method: 'DELETE', url: '/api/accounts/c1/login', body: undefined });
    expect(screen.queryByLabelText('Authorization code or setup token')).toBeNull();
    vi.useRealTimers();
  });

  it('stops polling a pending login when the account is removed', async () => {
    let polls = 0; let removed = false;
    vi.stubGlobal('confirm', () => true);
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return removed ? [] : [{ id: 'a1', name: 'Personal', harness: 'codex', kind: 'codex_home', home: 'x', created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }];
      if (method === 'POST' && url === '/api/accounts/a1/login') return { state: 'pending', code: 'ABCD-1234', url: 'https://auth.example/device' };
      if (method === 'GET' && url === '/api/accounts/a1/login') { polls++; throw Object.assign(new Error('no login for a1'), { status: 404 }); }
      if (method === 'DELETE' && url === '/api/accounts/a1') { removed = true; return {}; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Accounts');
    await screen.findByText('Personal');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(polls).toBe(0);
    vi.useRealTimers();
  });

  it('hides Copy without clipboard access and reports a rejected copy', async () => {
    const clipboard = navigator.clipboard;
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [{ id: 'a1', name: 'Personal', harness: 'codex', kind: 'codex_home', home: 'x', created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }];
      if (method === 'POST' && url === '/api/accounts/a1/login') return { state: 'pending', code: 'ABCD-1234', url: 'https://auth.example/device' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const missingClipboard = render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
      open('Accounts');
      await screen.findByText('Personal');
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
      await screen.findByText('ABCD-1234');
      expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
      missingClipboard.unmount();

      const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
      open('Accounts');
      await screen.findByText('Personal');
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
      await screen.findByText('ABCD-1234');
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
      expect(await screen.findByText('Could not copy code.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(writeText).toHaveBeenLastCalledWith('ABCD-1234');
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    }
  });

  it('recovers an existing login after a start conflict and closes it when it becomes idle', async () => {
    let polls = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [{ id: 'a1', name: 'Personal', harness: 'codex', kind: 'codex_home', home: 'x', created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }];
      if (method === 'POST' && url === '/api/accounts/a1/login') throw Object.assign(new Error('login already pending'), { status: 409 });
      if (method === 'GET' && url === '/api/accounts/a1/login') return polls++ === 0 ? { state: 'pending', code: 'RESTORED', url: 'https://auth.example/device' } : { state: 'idle' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Accounts');
    await screen.findByText('Personal');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('RESTORED')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByText('RESTORED')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    vi.useRealTimers();
  });

  it('reports an accounts refresh failure after login completes', async () => {
    let accountLoads = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') {
        // One load on mount (Models, which also lists accounts, is not mounted alongside any more), then the refresh after login fails.
        if (accountLoads++ < 1) return [{ id: 'a1', name: 'Personal', harness: 'codex', kind: 'codex_home', home: 'x', created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }];
        throw Object.assign(new Error('accounts refresh failed'), { status: 500 });
      }
      if (method === 'POST' && url === '/api/accounts/a1/login') return { state: 'pending', code: 'ABCD-1234', url: 'https://auth.example/device' };
      if (method === 'GET' && url === '/api/accounts/a1/login') return { state: 'done' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Accounts');
    await screen.findByText('Personal');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText('Logged in')).toBeTruthy();
    expect(screen.getByText('accounts refresh failed')).toBeTruthy();
    vi.useRealTimers();
  });

  it('scrolls to and focuses the daemon target, then re-anchors after layout changes', async () => {
    const scrollIntoView = vi.fn();
    const observe = vi.fn();
    let onResize: ResizeObserverCallback = () => {};
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { onResize = callback; }
      observe = observe;
      disconnect() {}
      unobserve() {}
    });
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    try {
      render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} target="daemon" />);
      const daemon = await screen.findByText('Daemon', { selector: 'h2' });
      const section = daemon.closest('section')!;
      expect(section.id).toBe('daemon');
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
      expect(document.activeElement).toBe(section);
      expect(observe).toHaveBeenCalledWith(document.querySelector('.setup'));
      act(() => onResize([], {} as ResizeObserver));
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
      expect(css).toMatch(/\.setup section:focus\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
  });

  it('shows daemon status, warns when restart is needed, and restarts it', async () => {
    const calls: Call[] = [];
    let restarted = false;
    vi.stubGlobal('confirm', () => true);
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith('/api/daemon') && method === 'GET') return restarted
        ? { pid: 456, started_at: '2026-09-15T10:00:00.000Z', commit: 'def', source_head: 'def', restart_needed: false }
        : { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      if (url.endsWith('/api/daemon/restart') && method === 'POST') { restarted = true; return { ok: true, pid: 123 }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(await screen.findByText(/Running since .*\(pid 123\), commit abc/)).toBeTruthy();
    expect(screen.getByText('main is at def; the daemon runs abc. Restart to pick up the change.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    expect((screen.getByRole('button', { name: 'Restart daemon' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/daemon/restart'))).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)); });
    expect(await screen.findByText('Daemon restarted (pid 456, commit def)')).toBeTruthy();
  });

  it('shows restart failure output and clears it after the next successful restart', async () => {
    let attempts = 0;
    let status = { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true, restart_in_progress: false, restart_failure: null as null | { reason: string; output: string[] } };
    vi.stubGlobal('confirm', () => true);
    mockApi((method, url) => {
      if (url.endsWith('/api/daemon') && method === 'GET') return status;
      if (url.endsWith('/api/daemon/restart') && method === 'POST') {
        attempts += 1;
        status = attempts === 1
          ? { ...status, restart_failure: { reason: 'pnpm install --frozen-lockfile exited with code 1', output: ['ERR_PNPM_FETCH_403', 'No packages were installed'] } }
          : { ...status, pid: 456, commit: 'def', source_head: 'def', restart_needed: false, restart_failure: null };
        return { ok: true, pid: status.pid };
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    await screen.findByText(/pid 123/);
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Restart failed: pnpm install --frozen-lockfile exited with code 1'), { timeout: 5_000 });
    expect(screen.getByLabelText('Restart output').textContent).toContain('ERR_PNPM_FETCH_403\nNo packages were installed');
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    await waitFor(() => expect(screen.getByText('Daemon restarted (pid 456, commit def)')).toBeTruthy(), { timeout: 5_000 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByLabelText('Restart output')).toBeNull();
  });

  it('hides the previous restart failure as soon as a retry starts', async () => {
    vi.stubGlobal('confirm', () => true);
    mockApi((method, url) => {
      if (url.endsWith('/api/daemon') && method === 'GET') {
        return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true, restart_in_progress: false, restart_failure: { reason: 'previous failure', output: ['old output'] } };
      }
      if (url.endsWith('/api/daemon/restart') && method === 'POST') return new Promise(() => {});
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    await screen.findByText('Restart failed: previous failure');
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    expect({ failure: screen.queryByRole('alert'), output: screen.queryByLabelText('Restart output'), status: screen.getByText('Restarting…').textContent })
      .toEqual({ failure: null, output: null, status: 'Restarting…' });
  });

  it('does not restart the daemon when confirmation is declined', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('confirm', () => false);
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith('/api/daemon') && method === 'GET') return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    await screen.findByText(/pid 123/);
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('computes the alert', () => {
    expect(doctorAlert(null)).toBe(false);
    expect(doctorAlert(doctorOk)).toBe(false);
    expect(doctorAlert(doctorBad)).toBe(true);
    expect(doctorAlert({ ...doctorOk, data_dir: { path: 'x', ok: false, problem: 'ro' } })).toBe(true);
  });

  it('renders doctor rows, removes and edits repos', async () => {
    const calls: Call[] = [];
    const asked: string[] = [];
    let savedRepo = repo;
    vi.stubGlobal('confirm', (m: string) => { asked.push(m); return true; });
    mockApi((method, url, body) => {
      if (method === 'GET' && url.endsWith('/preflight')) return { runs: [], crashes: [] };
      calls.push({ method, url, body });
      if (method === 'DELETE') throw Object.assign(new Error('repo r1 has running sessions'), { status: 409, body: { sessions: ['s1'] } });
      if (method === 'PATCH') { savedRepo = { ...savedRepo, ...(body as Partial<typeof repo>) }; return savedRepo; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() {
      const [repos, setRepos] = useState([repo]);
      return <Setup repos={repos} doctor={doctorBad} unfinishedBatches={{ r1: { open: 0, review: 1 } }} onRefreshDoctor={() => {}} onReposChanged={async () => setRepos([savedRepo])} />;
    }
    render(<Harness />);
    // The doctor table lives under General; the repos table under Repositories.
    expect(screen.getByText(/npm install -g @anthropic-ai\/claude-code/)).toBeTruthy();
    // A hint's inline code renders as code, not raw backticks (round 11).
    const hint = screen.getByText(/once in a terminal to log in/);
    expect(hint.textContent).toBe('npm install -g @anthropic-ai/claude-code\nRun claude once in a terminal to log in if you have not yet.');
    expect(hint.querySelector('code')!.textContent).toBe('claude');
    expect(screen.getAllByText('not found').length).toBe(3);
    expect(screen.getByText('C:/Users/me/.overseer')).toBeTruthy();
    open('Repositories');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(asked).toEqual(["Remove r1 from Overseer?\n\nDeleted: Overseer's worktrees for it and its batch and task records.\nKept: the repository, its beads data, and every feature/* and bead/* branch. 1 batch is still in review; its branch stays in the repo."]);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/repos/r1' }));
    await waitFor(() => expect(screen.getByText(/has running sessions: s1/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The form takes the row's cells with it, so it names what it is editing; position was the only cue (round 25 R25-2).
    expect(screen.getByText(`Editing ${repo.id} — ${repo.path}`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Worker limit'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Review command'), { target: { value: 'pnpm test:review' } });
    fireEvent.submit(screen.getByLabelText('Verify command')); // Enter in a field saves, like the button
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/repos/r1', body: { base_branch: 'main', verify_command: null, review_command: 'pnpm test:review', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3 , review_rounds: 2, model_filter: null} }));
    // Save says so (round 7: the form silently turned back into the row); the next Edit clears it.
    // The command was cleared, so the notice says what that means instead of promising a verification (fix round 20 review NB-B).
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved r1. Running workers keep the settings they started with; with no verify command, nothing is verified from now on; the daemon runs the review command before the next batch review request.'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('Review command') as HTMLInputElement).value).toBe('pnpm test:review');
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: 'pnpm test' } });
    fireEvent.change(screen.getByLabelText('Review command'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByLabelText('Verify command'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved r1. Running workers keep the settings they started with; the next verification uses the new verify command; the pre-review suite is disabled from now on.'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Review rounds') as HTMLInputElement).value).toBe('2');
    expect(screen.getByText(/The most review rounds a bead gets; 0 turns review off\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Review rounds'), { target: { value: '4' } });
    fireEvent.submit(screen.getByLabelText('Review rounds'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/repos/r1', body: { base_branch: 'main', verify_command: 'pnpm test', review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 4, model_filter: null } }));
  });

  it('edits the batch approver and shows it in the repository table', async () => {
    const calls: Call[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'PATCH') return { ...repo, batch_approver: 'orchestrator' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(screen.getByRole('columnheader', { name: 'approver' })).toBeTruthy();
    expect(document.querySelector('td[data-label="approver"]')?.textContent).toBe('user');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const select = screen.getByLabelText('Batch approver') as HTMLSelectElement;
    expect(select.value).toBe('user');
    fireEvent.change(select, { target: { value: 'orchestrator' } });
    fireEvent.submit(select);
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/repos/r1', body: { base_branch: 'main', verify_command: 'pnpm test', review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'orchestrator', worker_limit: 2, review_rounds: 2, model_filter: null } }));
  });

  it('drops the orchestrator approver, and says why, once the merge mode is GitLab', async () => {
    const calls: Call[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'PATCH') return { ...repo, merge_mode: 'gitlab-mr', batch_approver: 'user' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const selfMerge = { ...repo, batch_approver: 'orchestrator' as const };
    render(<Setup repos={[selfMerge]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Batch approver') as HTMLSelectElement).value).toBe('orchestrator');
    fireEvent.change(screen.getByLabelText('Merge mode'), { target: { value: 'gitlab-mr' } });
    expect(screen.queryByLabelText('Batch approver')).toBeNull();
    expect(screen.getByText('Batch approver: user. A GitLab merge request is always merged by you on GitLab, so the orchestrator value is offered only for local-merge.')).toBeTruthy();
    // The save sends user, so the refused combination can never be submitted from the form.
    fireEvent.submit(screen.getByLabelText('Merge mode'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/repos/r1', body: { base_branch: 'main', verify_command: 'pnpm test', review_command: null, setup_command: null, merge_mode: 'gitlab-mr', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null } }));
  });

  it('shows the last probe result and crash count, and re-probes', async () => {
    const calls: Call[] = [];
    let resolveProbe: (() => void) | undefined;
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/repos/r1/preflight') {
        return {
          runs: [{ id: 3, repo_id: 'r1', kind: 'verify_probe', command: 'pnpm test', head_sha: 'abc', result: 'fail', exit_code: 1, output_tail: null, started_at: 't', ended_at: 't' }],
          crashes: [{ harness: 'codex', crash_class: 'transient', count: 2 }],
        };
      }
      if (method === 'POST' && url === '/api/repos/r1/probe') return new Promise((resolve) => { resolveProbe = () => resolve({ started: true }); });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(await screen.findByText('probe: fails (exit 1)')).toBeTruthy();
    expect(screen.getByText('crashes: 2')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Re-probe' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/repos/r1/probe')).toBe(true));
    await act(async () => { resolveProbe?.(); });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('reports a removal with the branches that stay and drops the app selection under the repo', async () => {
    vi.stubGlobal('confirm', () => true);
    mockApi((method) => {
      if (method === 'DELETE') return { ok: true, warnings: [], kept_branches: ['feature/add-note', 'bead/r1-9'] };
      throw Object.assign(new Error('unexpected'), { status: 500 });
    });
    const removed: string[] = [];
    render(<Setup repos={[repo]} doctor={doctorOk} unfinishedBatches={{ r1: { open: 1, review: 1 } }} onRefreshDoctor={() => {}} onReposChanged={() => {}} onRemoved={(id) => removed.push(id)} />);
    open('Repositories');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Removed r1. Branches kept in the repository: feature/add-note, bead/r1-9.'));
    expect(removed).toEqual(['r1']);
  });

  it('gates Add on inspect, prefills, shows the beads checkbox and posts', async () => {
    const calls: Call[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith('/api/repos/inspect')) return (body as { path: string }).path === 'E:\\bad' ? inspectBad : inspectNoBeads;
      if (method === 'POST' && url.endsWith('/api/repos')) return repo;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    let listRefreshed: () => void = () => {};
    const onReposChanged = () => new Promise<void>((r) => { listRefreshed = r; });
    render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={onReposChanged} />);
    open('Repositories');
    // With a repository present the form sits behind the button (bead overseer-doz).
    expect(screen.queryByLabelText('Path')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Path'));
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'E:\\bad' } });
    await waitFor(() => expect(screen.getByText('folder does not exist')).toBeTruthy());
    expect(add.disabled).toBe(true);
    expect(screen.queryByLabelText(/My team uses beads/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'E:\\Projects\\demo' } });
    await waitFor(() => expect(screen.getByText(/git repository on branch main/)).toBeTruthy());
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('demo');
    expect((screen.getByLabelText('Base branch') as HTMLInputElement).value).toBe('main');
    expect(add.disabled).toBe(false);
    expect(screen.getByLabelText(/My team uses beads/).closest('label')?.classList.contains('checkbox')).toBe(true);
    fireEvent.click(screen.getByLabelText(/My team uses beads/));
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: 'pnpm test' } });
    // A worker limit outside 1-16 is refused inline like every other Setup error, not only by the browser's bubble (round 9), and
    // as the field is typed in like every other field of this form, not on the round trip to the server (round 27 nit).
    fireEvent.change(screen.getByLabelText('Worker limit'), { target: { value: '0' } });
    expect(screen.getByText('Worker limit must be a whole number from 1 to 16.')).toBeTruthy();
    expect(add.disabled).toBe(true);
    expect((screen.getByLabelText('Review rounds') as HTMLInputElement).value).toBe('2');
    fireEvent.submit(screen.getByLabelText('Path'));
    expect(calls.some((c) => c.url.endsWith('/api/repos'))).toBe(false); // inspect posts too; the add did not
    fireEvent.change(screen.getByLabelText('Worker limit'), { target: { value: '2' } });
    expect(screen.queryByText('Worker limit must be a whole number from 1 to 16.')).toBeNull();
    fireEvent.submit(screen.getByLabelText('Path')); // Enter in the path field adds
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'POST', url: '/api/repos', body: { path: 'E:\\Projects\\demo', id: 'demo', base_branch: 'main', verify_command: 'pnpm test', review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2, model_filter: null, beads: 'commit' } }));
    // The form stays busy until the repo list has been refetched, so the table never lags behind a cleared form.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adding…' })).toBeTruthy());
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('E:\\Projects\\demo');
    listRefreshed();
    // A successful add puts the form away again and re-enables the button.
    await waitFor(() => expect(screen.queryByLabelText('Path')).toBeNull());
    const addRepositoryButton = screen.getByRole('button', { name: 'Add repository' }) as HTMLButtonElement;
    expect(addRepositoryButton.disabled).toBe(false);
    expect(document.activeElement).toBe(addRepositoryButton);
    // Add says what it did, like Save and Remove do (round 9: the form cleared and the row appeared without a word).
    expect(screen.getByRole('status').textContent).toBe(`Added ${repo.id} and initialised beads in it. Ask the orchestrator for work in Chat.`);
  });

  it('shows the Add form at once on a fresh install, with no button and no Cancel', () => {
    noApi();
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(sections()).toEqual(['Repositories', 'Add repository']);
    expect(screen.getByLabelText('Path')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('keeps the Add form behind a button once a repository exists, and Cancel puts it away', () => {
    noApi();
    render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    expect(sections()).toEqual(['Repositories']);
    expect(screen.queryByLabelText('Path')).toBeNull();
    const button = screen.getByRole('button', { name: 'Add repository' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(sections()).toEqual(['Repositories', 'Add repository']);
    expect(screen.getByLabelText('Path')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Path'));
    expect(button.disabled).toBe(true); // open already
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Path')).toBeNull();
    expect(sections()).toEqual(['Repositories']);
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('disables Add repository while a row is being edited, and Edit closes an open Add form', () => {
    noApi();
    render(<Setup repos={[repo]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(screen.getByLabelText('Path')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Path')).toBeNull(); // the add form is gone
    expect(screen.getByText(`Editing ${repo.id} — ${repo.path}`)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Add repository' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByLabelText('Path')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); // the edit's Cancel
    expect(button.disabled).toBe(false);
    expect(screen.queryByLabelText('Path')).toBeNull(); // Edit closed it; it does not spring back
  });

  it('ignores a stale inspect response that resolves after a newer one', async () => {
    const calls: Call[] = [];
    let resolveSlow: ((r: InspectResponse) => void) | undefined;
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith('/api/repos/inspect')) {
        const path = (body as { path: string }).path;
        if (path === 'E:\\slow') return new Promise<InspectResponse>((resolve) => { resolveSlow = resolve; });
        return inspectNoBeads;
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Setup repos={[]} doctor={doctorOk} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    open('Repositories');
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'E:\\slow' } });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/repos/inspect'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'E:\\Projects\\demo' } });
    await waitFor(() => expect(screen.getByText(/git repository on branch main/)).toBeTruthy());
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('demo');
    await act(async () => {
      resolveSlow?.({ path: 'E:\\slow', exists: true, is_git_root: true, branch: 'slow-branch', has_beads: false, suggested_id: 'slow-id', problems: [] });
      await Promise.resolve();
    });
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('demo');
    expect((screen.getByLabelText('Base branch') as HTMLInputElement).value).toBe('main');
  });
});
