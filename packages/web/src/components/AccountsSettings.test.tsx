import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react';
import type { Account, AccountUsage } from '@overseer/shared';
import { AccountsSettings, fmtAgo, fmtReset } from './AccountsSettings';
import { mockApi } from '../test/setup';
import { USAGE_POLL_MS } from '../api';
import fs from 'node:fs';
import path from 'node:path';
import { PHONE_MEDIA } from '../test/phoneMedia';

const claude: Account = { id: 'c1', name: 'Work', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: true, logged_in: true };
const codex: Account = { id: 'x1', name: 'Personal', label: null, harness: 'codex', kind: 'codex_home', home: 'x', created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: true };

const todayAt = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };

afterEach(() => { vi.useRealTimers(); });

describe('AccountsSettings usage line', () => {
  it('adds an OpenCode provider key without rendering the key', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const opencode = { id: 'o1', name: 'DeepSeek', label: null, harness: 'opencode' as const, kind: 'api_key' as const, provider: 'deepseek', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: true, logged_in: true };
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/accounts') return [opencode];
      if (method === 'POST' && url === '/api/accounts') return opencode;
      if (method === 'PATCH' && url === '/api/accounts/o1') return opencode;
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<AccountsSettings />);
    await screen.findByText('DeepSeek');
    expect(screen.getByText('opencode · API key · deepseek')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Another provider' } });
    fireEvent.change(screen.getByLabelText('Account harness'), { target: { value: 'opencode' } });
    fireEvent.change(screen.getByLabelText('OpenCode provider'), { target: { value: 'deepseek' } });
    fireEvent.change(document.querySelector('.account-add input[aria-label="API key"]')!, { target: { value: 'not-for-the-browser' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: '/api/accounts', body: { name: 'Another provider', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'not-for-the-browser' } }));
    fireEvent.change(screen.getByLabelText('API key for DeepSeek'), { target: { value: 'replacement-key' } });
    fireEvent.blur(screen.getByLabelText('API key for DeepSeek'));
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', url: '/api/accounts/o1', body: { secret: 'replacement-key' } }));
    expect(screen.getByLabelText('API key for DeepSeek').parentElement).toBe(screen.getByLabelText('Provider for DeepSeek').parentElement);
    expect(screen.queryByText('not-for-the-browser')).toBeNull();
    expect(screen.queryByText('replacement-key')).toBeNull();
  });

  it('creates with a label, shows its tag, and clears it from the row', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const labelled = { ...claude, label: 'Work' };
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/accounts') return [labelled];
      if (method === 'POST' && url === '/api/accounts') return labelled;
      if (method === 'PATCH' && url === '/api/accounts/c1') return { ...labelled, label: null };
      if (method === 'GET' && url === '/api/accounts/c1/usage') return null;
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<AccountsSettings />);
    expect((await screen.findByText('Work', { selector: '.chip' })).className).toBe('chip');
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'New account' } });
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'personal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: '/api/accounts', body: { name: 'New account', label: 'personal', harness: 'claude', kind: 'oauth_token' } }));
    const rowLabel = screen.getByLabelText('Label for Work');
    fireEvent.change(rowLabel, { target: { value: '' } });
    fireEvent.blur(rowLabel);
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', url: '/api/accounts/c1', body: { label: '' } }));
  });

  it('keeps each label control and action group inside its account row', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [claude];
      if (method === 'GET' && url === '/api/accounts/c1/usage') return null;
      return null;
    });
    render(<AccountsSettings />);
    const label = await screen.findByLabelText('Label for Work');
    const row = label.closest('.account-row');
    expect(row).not.toBeNull();
    expect(label.closest('.account-label')).not.toBeNull();
    expect(row!.querySelector('.account-actions')).not.toBeNull();
    expect(label.getAttribute('placeholder')).toBe('Label');
    expect(label.closest('label')).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.account-row \{[^}]*grid-template-columns: minmax\(160px, 1fr\) minmax\(0, 240px\) 230px;[^}]*align-items: start;/);
    expect(css).toMatch(/\.account-actions \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.account-label input, \.account-label select, \.account-actions button \{[^}]*height: 30px;/);
    expect(css).toMatch(/@media \(min-width: 1001px\) and \(max-width: 1199px\) \{[^@]*\.account-row \{ grid-template-columns: minmax\(0, 240px\) 230px; \}[^@]*\.account-meta \{ grid-column: 1 \/ -1; \}/);
    expect(css).toMatch(new RegExp(String.raw`@media ${PHONE_MEDIA} \{[^@]*\.account-actions button[^{]*\{[^}]*min-height: 44px;`));
    expect(css).toMatch(/@media \(max-width: 1000px\) \{[\s\S]*?\.account-row \{[^}]*grid-template-columns: minmax\(0, 1fr\);[\s\S]*?\.account-login-slot \{ display: none; \}/);
  });

  it('renders the OpenCode Provider and API key in one container on the second line, with a reserved Log in slot', async () => {
    const opencode: Account = { id: 'o1', name: 'DeepSeek', label: null, harness: 'opencode', kind: 'api_key', provider: 'deepseek', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: true, logged_in: true };
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [opencode];
      return null;
    });
    render(<AccountsSettings />);
    const label = await screen.findByLabelText('Label for DeepSeek');
    const provider = screen.getByLabelText('Provider for DeepSeek');
    const key = screen.getByLabelText('API key for DeepSeek');
    expect(label.getAttribute('placeholder')).toBe('Label');
    expect(key.getAttribute('placeholder')).toBe('API key');
    expect(provider.querySelector('option[value=""]')?.textContent).toBe('Provider');
    const pair = provider.parentElement!;
    expect(pair.className).toBe('account-key-fields');
    expect(key.parentElement).toBe(pair);
    expect(label.parentElement).toBe(pair.parentElement);
    const row = label.closest('.account-row')!;
    expect(row.querySelectorAll('label')).toHaveLength(0);
    expect(row.querySelector('.account-actions > .account-login-slot')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.account-key-fields \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });

  it('renders session, weekly and per-model percentages with reset times, marking the ones over 80', async () => {
    const usage: AccountUsage = { fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(), session: { percent: 42, resetsAt: todayAt(14) }, weekly: { percent: 91, resetsAt: '2026-09-18T07:00:00.000Z' }, models: [{ model: 'claude-fable-5-1', percent: 12, resetsAt: null }] };
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [claude, codex];
      if (method === 'GET' && url === '/api/accounts/c1/usage') return usage;
      return null;
    });
    render(<AccountsSettings />);
    const session = await screen.findByText('Session 42%');
    expect(session.parentElement!.textContent).toBe(`Session 42% resets ${fmtReset(todayAt(14))}`);
    expect(fmtReset(todayAt(14))).toMatch(/^\d\d:00$/); // today: time only
    const week = screen.getByText('Week 91%');
    expect(week.className).toBe('usage-high');
    expect(week.parentElement!.textContent).toBe(`Week 91% resets ${fmtReset('2026-09-18T07:00:00.000Z')}`);
    const other = new Date('2026-09-18T07:00:00.000Z');
    expect(fmtReset(other.toISOString(), new Date('2026-09-16T12:00:00Z'))).toBe(`${other.toLocaleDateString(undefined, { weekday: 'short' })} ${String(other.getHours()).padStart(2, '0')}:00`); // another day: weekday first
    expect(session.className).toBe('');
    expect(screen.getByText('claude-fable-5-1 12%').parentElement!.textContent).toBe('claude-fable-5-1 12%'); // no reset known
    expect(screen.getByText('updated 5m ago')).toBeTruthy();
    expect(screen.queryByText(/usage unavailable/)).toBeNull();
    // Only the Claude OAuth account asked for usage.
    expect(document.querySelectorAll('.account-usage')).toHaveLength(1);
  });

  it('renders no usage line when the route answers null', async () => {
    const calls: string[] = [];
    mockApi((method, url) => {
      calls.push(url);
      if (method === 'GET' && url === '/api/accounts') return [claude];
      return null;
    });
    render(<AccountsSettings />);
    await screen.findByText('Work');
    await waitFor(() => expect(calls).toContain('/api/accounts/c1/usage'));
    expect(document.querySelector('.account-usage')).toBeNull();
  });

  it('renders no usage line when the route answers no buckets without an error', async () => {
    const calls: string[] = [];
    mockApi((method, url) => {
      calls.push(url);
      if (method === 'GET' && url === '/api/accounts') return [claude];
      if (method === 'GET' && url === '/api/accounts/c1/usage') return { fetchedAt: new Date().toISOString(), session: null, weekly: null, models: [] };
      return null;
    });
    render(<AccountsSettings />);
    await screen.findByText('Work');
    await waitFor(() => expect(calls).toContain('/api/accounts/c1/usage'));
    expect(document.querySelector('.account-usage')).toBeNull();
  });

  it('shows the error with the last good values and the stale fetchedAt', async () => {
    const usage: AccountUsage = { fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), session: { percent: 10, resetsAt: null }, weekly: null, models: [], error: 'HTTP 503' };
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [claude];
      if (url === '/api/accounts/c1/usage') return usage;
      return null;
    });
    render(<AccountsSettings />);
    expect((await screen.findByText('Session 10%')).className).toBe('');
    expect(screen.getByText('usage unavailable (HTTP 503)').className).toBe('');
    expect(screen.getByText('updated 3h ago')).toBeTruthy();
    expect(screen.queryByText(/^Week/)).toBeNull();
  });

  it('polls the usage route every 60 seconds and stops on unmount', async () => {
    vi.useFakeTimers();
    let reads = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [claude];
      if (url === '/api/accounts/c1/usage') { reads++; return { fetchedAt: new Date().toISOString(), session: { percent: reads, resetsAt: null }, weekly: null, models: [] }; }
      return null;
    });
    const view = render(<AccountsSettings />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reads).toBe(1);
    expect(screen.getByText('Session 1%')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS - 1));
    expect(reads).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(reads).toBe(2);
    expect(screen.getByText('Session 2%')).toBeTruthy();
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 2));
    expect(reads).toBe(2);
  });

  it('formats staleness relative to now', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    expect(fmtAgo('2026-09-16T11:59:30Z', now)).toBe('just now');
    expect(fmtAgo('2026-09-16T11:40:00Z', now)).toBe('20m ago');
    expect(fmtAgo('2026-09-16T09:00:00Z', now)).toBe('3h ago');
    expect(fmtAgo('2026-09-14T09:00:00Z', now)).toBe('2d ago');
  });
  it('shimmers account-row-shaped placeholders while the list is in flight, then the real rows', async () => {
    let release!: (v: unknown) => void;
    let releaseUsage!: (v: unknown) => void;
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return new Promise<unknown>((r) => { release = r; });
      if (method === 'GET' && url === '/api/accounts/c1/usage') return new Promise<unknown>((r) => { releaseUsage = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<AccountsSettings />);
    const shimmer = await screen.findByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(shimmer.querySelectorAll('.shimmer-measure-container .account-row')).toHaveLength(2);
    // The usage line lands inside a row, so the reserved rows carry one too.
    expect(shimmer.querySelectorAll('.shimmer-measure-container .account-usage')).toHaveLength(1);
    // The arrived rows are grid items of .accounts-settings and carry its gap; the placeholder holds them in one wrapper, which carries it instead.
    expect(shimmer.querySelectorAll('.shimmer-measure-container .account-rows-placeholder > .account-row')).toHaveLength(2);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.accounts-settings \{[^}]*gap: 10px;/);
    expect(css).toMatch(/\.account-rows-placeholder \{[^}]*display: grid;[^}]*gap: 10px;/);
    release([claude]);
    await waitFor(() => expect(screen.getByText('Work')).toBeTruthy());
    // The usage line rides in an arrived row, so its read is a second in-flight fetch: resolve it before asserting both shimmers are gone.
    await waitFor(() => expect(releaseUsage).toBeTypeOf('function'));
    releaseUsage(null);
    await waitFor(() => expect(screen.queryByTestId('shimmer')).toBeNull());
  });

  it('stops the shimmer once the account list has failed, rather than shimmering for the whole outage', async () => {
    mockApi(() => { throw Object.assign(new Error('daemon is down'), { status: 500 }); });
    render(<AccountsSettings />);
    await screen.findByText('daemon is down');
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('shimmers the usage line inside an arrived row until the usage read answers, and stops it when that read fails', async () => {
    let release!: (v: unknown) => void;
    let failUsage!: (e: unknown) => void;
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [claude, codex];
      if (method === 'GET' && url === '/api/accounts/c1/usage') return new Promise<unknown>((resolve, reject) => { release = resolve; failUsage = reject; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { unmount } = render(<AccountsSettings />);
    const row = (await screen.findByText('Work')).closest('.account-row')!;
    const shimmer = within(row as HTMLElement).getByTestId('shimmer');
    expect(shimmer.querySelectorAll('.shimmer-measure-container .account-usage')).toHaveLength(1);
    // Only the Claude OAuth account asks for usage, so the codex row reserves nothing.
    expect(screen.getAllByTestId('shimmer')).toHaveLength(1);
    release({ fetchedAt: new Date().toISOString(), session: { percent: 42, resetsAt: null }, weekly: null, models: [] });
    await waitFor(() => expect(screen.getByText('Session 42%')).toBeTruthy());
    expect(screen.queryByTestId('shimmer')).toBeNull();
    unmount();

    // A usage read that fails must not leave a shimmer standing inside a row that has otherwise arrived.
    render(<AccountsSettings />);
    await screen.findByText('Work');
    await waitFor(() => expect(screen.getAllByTestId('shimmer')).toHaveLength(1));
    failUsage(Object.assign(new Error('usage is unreachable'), { status: 500 }));
    await waitFor(() => expect(screen.queryByTestId('shimmer')).toBeNull());
    expect(document.querySelectorAll('.account-usage')).toHaveLength(0);
  });
});
