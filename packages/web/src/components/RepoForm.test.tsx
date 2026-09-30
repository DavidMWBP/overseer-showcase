import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Account, Repo, TierSettings } from '@overseer/shared';
import { mockApi } from '../test/setup';
import { inspectNoBeads, repo } from '../test/fixtures';
import { RepoForm } from './RepoForm';

const account: Account = { id: 'a1', name: 'Studio', label: 'Private', harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: true, logged_in: true };
const settings: TierSettings = { denyModels: [], tiers: [
  { name: 'chore', candidates: [{ harness: 'claude', model: 'sonnet', effort: 'low', account: 'a1' }, { harness: 'codex', model: 'luna', effort: null }] },
  { name: 'standard', candidates: [{ harness: 'claude', model: 'opus', effort: 'medium', account: 'a1' }] },
  { name: 'hard', candidates: [{ harness: 'claude', model: 'opus', effort: 'high', account: 'a1' }] },
] };

function setup(saved: Repo['model_filter'] = null, options: { deleted?: boolean; reject?: boolean; tiers?: TierSettings } = {}) {
  const writes: unknown[] = [];
  mockApi((method, url, body) => {
    if (url === '/api/settings/tiers') return options.tiers ?? settings;
    if (url === '/api/accounts') return options.deleted ? [] : [account];
    if (method === 'PATCH') {
      writes.push(body);
      if (options.reject && (body as { model_filter: NonNullable<Repo['model_filter']> }).model_filter.accounts.includes('a1')) throw Object.assign(new Error('unknown account id "a1"'), { status: 400 });
      return { ...repo, ...(body as Partial<Repo>) };
    }
    throw new Error(`unexpected ${url}`);
  });
  render(<RepoForm mode="edit" repo={{ ...repo, model_filter: saved }} onDone={() => {}} onCancel={() => {}} />);
  return writes;
}

const preview = () => document.querySelector('.repo-model-preview') as HTMLElement;
const checked = (name: string) => (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;

describe('repository model filter', () => {
  it('shows Codex ultra effort unchanged before and after applying a stored filter', async () => {
    const candidate = { harness: 'codex' as const, model: 'custom-codex', effort: 'ultra' as const };
    const tiers: TierSettings = { ...settings, tiers: settings.tiers.map((tier) => tier.name === 'hard'
      ? { ...tier, candidates: [...tier.candidates, candidate] } : tier) };
    setup({ harnesses: ['codex'], models: ['custom-codex'], accounts: [] }, { tiers });
    await screen.findByRole('checkbox', { name: 'custom-codex' });
    expect(within(preview()).getByText('codex · custom-codex · ultra · machine login')).toBeTruthy();
    expect(within(preview()).getAllByRole('listitem')).toHaveLength(1);

    fireEvent.click(screen.getByRole('checkbox', { name: 'custom-codex' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'codex' }));
    expect(screen.getByText('Nothing selected: this repository uses the global tier table.')).toBeTruthy();
    expect(within(preview()).getByText('codex · custom-codex · ultra · machine login')).toBeTruthy();
    expect(within(preview()).getAllByRole('listitem')).toHaveLength(5);
  });

  it('keeps deleted tier accounts in previews with no account restriction', async () => {
    setup(null, { deleted: true });
    await screen.findByRole('checkbox', { name: 'opus' });
    expect(within(preview()).queryAllByText('Dispatches are refused: no candidate remains.')).toHaveLength(0);
    expect(within(preview()).getByText('claude · sonnet · low · Deleted account (a1)')).toBeTruthy();
    expect(within(preview()).getByText('claude · opus · medium · Deleted account (a1)')).toBeTruthy();
    expect(within(preview()).getByText('claude · opus · high · Deleted account (a1)')).toBeTruthy();
    expect(within(preview()).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'claude · sonnet · low · Deleted account (a1)',
      'codex · luna · inherit · machine login',
      'claude · opus · medium · Deleted account (a1)',
      'claude · opus · high · Deleted account (a1)',
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'claude' }));
    expect(within(preview()).queryByText('codex · luna · inherit · machine login')).toBeNull();
    expect(within(preview()).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('checkbox', { name: 'opus' }));
    expect(within(preview()).getAllByText('Dispatches are refused: no candidate remains.')).toHaveLength(1);
    expect(within(preview()).getByText('claude · opus · medium · Deleted account (a1)')).toBeTruthy();
    expect(within(preview()).getByText('claude · opus · high · Deleted account (a1)')).toBeTruthy();
  });

  it('starts empty, filters the preview on each kind, saves the selection and clears to null', async () => {
    const writes = setup();
    await screen.findByRole('checkbox', { name: 'Studio (Private)' });
    expect(['claude', 'codex', 'opencode', 'Studio (Private)', 'sonnet', 'opus', 'luna'].map(checked)).toEqual([false, false, false, false, false, false, false]);
    expect(screen.getByText('Nothing selected: this repository uses the global tier table.')).toBeTruthy();
    expect(within(preview()).getByText('codex · luna · inherit · machine login')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'claude' }));
    expect(within(preview()).queryByText('codex · luna · inherit · machine login')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Studio (Private)' }));
    expect(within(preview()).getByText('claude · sonnet · low · Studio')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'opus' }));
    expect(within(preview()).getAllByText('Dispatches are refused: no candidate remains.')).toHaveLength(1);
    expect(within(preview()).getAllByText('claude · opus · medium · Studio')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0] as { model_filter: Repo['model_filter'] }).model_filter).toEqual({ harnesses: ['claude'], models: ['opus'], accounts: ['a1'] });

    fireEvent.click(screen.getByRole('checkbox', { name: 'claude' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Studio (Private)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'opus' }));
    expect(screen.getByText('Nothing selected: this repository uses the global tier table.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect((writes[1] as { model_filter: Repo['model_filter'] }).model_filter).toBeNull();
  });

  it('opens the stored selection exactly and keeps a deleted account available to clear', async () => {
    const filter: Repo['model_filter'] = { harnesses: ['claude'], models: ['opus'], accounts: ['a1'] };
    const writes = setup(filter, { deleted: true, reject: true });
    await screen.findByRole('checkbox', { name: 'Deleted account (a1)' });
    expect(checked('claude')).toBe(true);
    expect(checked('opus')).toBe(true);
    expect(checked('Deleted account (a1)')).toBe(true);
    expect(checked('sonnet')).toBe(false);
    expect(within(preview()).getAllByText('Dispatches are refused: no candidate remains.')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('unknown account id "a1"')).toBeTruthy());
    expect((writes[0] as { model_filter: Repo['model_filter'] }).model_filter?.accounts).toEqual(['a1']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Deleted account (a1)' }));
    expect(screen.queryByRole('checkbox', { name: 'Deleted account (a1)' })).toBeNull();
    expect(within(preview()).getAllByText('Dispatches are refused: no candidate remains.')).toHaveLength(1);
    expect(within(preview()).getByText('claude · opus · medium · Deleted account (a1)')).toBeTruthy();
    expect(within(preview()).getByText('claude · opus · high · Deleted account (a1)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect((writes[1] as { model_filter: Repo['model_filter'] }).model_filter?.accounts).toEqual([]);
  });

  it('offers the same filters when adding a repository and posts its selection', async () => {
    const writes: unknown[] = [];
    mockApi((method, url, body) => {
      if (url === '/api/settings/tiers') return settings;
      if (url === '/api/accounts') return [account];
      if (url === '/api/repos/inspect') return inspectNoBeads;
      if (method === 'POST' && url === '/api/repos') { writes.push(body); return repo; }
      throw new Error(`unexpected ${url}`);
    });
    render(<RepoForm mode="add" onDone={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Path' }), { target: { value: 'C:/example' } });
    await screen.findByText(/git repository on branch/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'claude' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Studio (Private)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'opus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0] as { model_filter: Repo['model_filter'] }).model_filter).toEqual({ harnesses: ['claude'], models: ['opus'], accounts: ['a1'] });
  });
});
