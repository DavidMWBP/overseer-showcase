import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { Account, OrchestratorSettings, TierSettings } from '@overseer/shared';
import { ModelsSettings } from './ModelsSettings';
import { mockApi } from '../test/setup';

type Call = { method: string; url: string; body?: unknown };

const orchestrator: OrchestratorSettings = { model: 'claude-sonnet-4', effort: 'medium', promptOverride: null };
const tiers: TierSettings = {
  tiers: [
    { name: 'chore', candidates: [{ harness: 'claude', model: 'claude-haiku-4', effort: null }] },
    { name: 'standard', candidates: [{ harness: 'claude', model: 'claude-sonnet-4', effort: null }] },
    { name: 'hard', candidates: [{ harness: 'claude', model: 'claude-opus-4', effort: 'high' }] },
    { name: 'critic', candidates: [{ harness: 'codex', model: 'gpt-5', effort: null }] },
  ],
  denyModels: ['banned-model'],
};

function ultraTiers(model: string): TierSettings {
  return { ...tiers, tiers: tiers.tiers.map((t) => t.name === 'critic' ? { ...t, candidates: [{ harness: 'codex', model, effort: 'ultra' }] } : t) };
}

function mock(calls: Call[], getAccounts: () => Account[] = () => [{ id: 'a1', name: 'Work Claude', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: '', last_verified_at: null, has_secret: true, logged_in: true }], tierSettings: TierSettings = tiers) {
  mockApi((method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/settings/orchestrator') return orchestrator;
    if (method === 'GET' && url === '/api/settings/tiers') return tierSettings;
    if (method === 'GET' && url === '/api/accounts') return getAccounts();
    if (method === 'PUT' && url === '/api/settings/orchestrator') return { ...(body as OrchestratorSettings), applies_to: 'next-session' };
    if (method === 'PUT' && url === '/api/settings/tiers') return { ...(body as TierSettings), applies_to: 'next-session' };
    if (method === 'POST' && url === '/api/orchestrator/reset') return { ok: true };
    throw Object.assign(new Error('unexpected ' + url), { status: 500 });
  });
}

describe('ModelsSettings', () => {
  it('renders seeded orchestrator and tier values', async () => {
    const calls: Call[] = [];
    mock(calls);
    render(<ModelsSettings />);
    await waitFor(() => expect(screen.getByLabelText('Orchestrator model')).toHaveProperty('value', 'claude-sonnet-4'));
    expect(screen.getByLabelText('Orchestrator effort')).toHaveProperty('value', 'medium');
    expect(screen.getByLabelText('hard candidate 1 model')).toHaveProperty('value', 'claude-opus-4');
    expect(screen.getByLabelText('critic candidate 1 harness')).toHaveProperty('value', 'codex');
  });

  it('offers the documented DeepSeek models for OpenCode', async () => {
    const calls: Call[] = [];
    mock(calls);
    render(<ModelsSettings />);
    const currentModel = await screen.findByLabelText('critic candidate 1 model');
    fireEvent.change(currentModel, { target: { value: '' } });
    fireEvent.click(currentModel.parentElement!.querySelector('button')!);
    const harness = await screen.findByLabelText('critic candidate 1 harness');
    fireEvent.change(harness, { target: { value: 'opencode' } });
    const model = screen.getByLabelText('critic candidate 1 model') as HTMLSelectElement;
    expect(Array.from(model.options).map((o) => o.value)).toContain('deepseek/deepseek-flash');
    expect(Array.from(model.options).map((o) => o.value)).toContain('deepseek/deepseek-v4-pro');
  });

  it('edits a tier candidate model and saves it via PUT', async () => {
    const calls: Call[] = [];
    mock(calls);
    render(<ModelsSettings />);
    await waitFor(() => expect(screen.getByLabelText('standard candidate 1 model')).toHaveProperty('value', 'claude-sonnet-4'));
    fireEvent.change(screen.getByLabelText('standard candidate 1 model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')!;
    const sent = put.body as TierSettings;
    expect(sent.tiers.find((t) => t.name === 'standard')!.candidates[0]!.model).toBe('opus');
    expect(sent.denyModels).toEqual(['banned-model']);
  });

  it('offers the optional cheaper chore critic tier, omits it while empty and saves it once configured', async () => {
    const calls: Call[] = [];
    mock(calls);
    render(<ModelsSettings />);
    await waitFor(() => expect(screen.getByLabelText('critic candidate 1 harness')).toBeTruthy());
    // Not in the saved settings, but the fieldset is offered so the tier can be configured.
    const fieldset = screen.getByRole('group', { name: /critic-chore/ });
    expect(within(fieldset).queryByLabelText('critic-chore candidate 1 model')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toBe(true));
    // Empty: not sent, so an unconfigured user keeps the critic tier and nothing changes for them.
    expect((calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')!.body as TierSettings).tiers.some((t) => t.name === 'critic-chore')).toBe(false);

    fireEvent.click(within(fieldset).getByRole('button', { name: 'Add candidate' }));
    fireEvent.change(within(fieldset).getByLabelText('critic-chore candidate 1 model'), { target: { value: 'haiku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toHaveLength(2));
    const put = calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')[1]!;
    expect((put.body as TierSettings).tiers.find((t) => t.name === 'critic-chore')!.candidates[0]!.model).toBe('haiku');
  });

  it('offers matching accounts and saves the selected account', async () => {
    const calls: Call[] = [];
    mock(calls, () => [
      { id: 'a1', name: 'Work Claude', label: 'Work', harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: '', last_verified_at: null, has_secret: true, logged_in: true },
      { id: 'a2', name: 'Signed out', label: 'Personal', harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false },
    ]);
    render(<ModelsSettings />);
    const account = await screen.findByLabelText('standard candidate 1 account') as HTMLSelectElement;
    expect(Array.from(account.options).map((o) => o.text)).toEqual(['machine login', 'Work Claude (Work)', 'Signed out (Personal) (logged out)']);
    fireEvent.change(account, { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')!.body as TierSettings).tiers.find((t) => t.name === 'standard')!.candidates[0]!.account).toBe('a1');
  });

  it('filters candidate accounts by harness and saves the orchestrator account', async () => {
    const calls: Call[] = [];
    mock(calls);
    render(<ModelsSettings />);
    const orchestratorAccount = await screen.findByLabelText('Orchestrator account') as HTMLSelectElement;
    expect(Array.from(orchestratorAccount.options).map((o) => o.text)).toEqual(['machine login', 'Work Claude']);
    fireEvent.change(orchestratorAccount, { target: { value: 'a1' } });
    const criticAccount = screen.getByLabelText('critic candidate 1 account') as HTMLSelectElement;
    expect(Array.from(criticAccount.options).map((o) => o.text)).toEqual(['machine login']);
    expect(criticAccount.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save orchestrator' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/orchestrator')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/orchestrator')!.body as OrchestratorSettings).account).toBe('a1');
  });

  it('offers OpenCode accounts only to OpenCode candidates', async () => {
    const calls: Call[] = [];
    mock(calls, () => [
      { id: 'a1', name: 'Work Claude', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: '', last_verified_at: null, has_secret: true, logged_in: true },
      { id: 'o1', name: 'DeepSeek', label: null, harness: 'opencode', kind: 'api_key', provider: 'deepseek', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: true, logged_in: true },
    ]);
    render(<ModelsSettings />);
    const candidate = await screen.findByLabelText('standard candidate 1 harness');
    fireEvent.change(candidate, { target: { value: 'opencode' } });
    const account = screen.getByLabelText('standard candidate 1 account') as HTMLSelectElement;
    expect(Array.from(account.options).map((o) => o.text)).toEqual(['machine login', 'DeepSeek']);
    fireEvent.change(candidate, { target: { value: 'claude' } });
    expect(Array.from((screen.getByLabelText('standard candidate 1 account') as HTMLSelectElement).options).map((o) => o.text)).toEqual(['machine login', 'Work Claude']);
  });

  it('explains the orchestrator account fallback threshold', async () => {
    const calls: Call[] = [];
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/settings/orchestrator') return { ...orchestrator, usageThresholdPercent: 95 };
      if (method === 'GET' && url === '/api/settings/tiers') return tiers;
      if (method === 'GET' && url === '/api/accounts') return [];
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    expect(await screen.findByText('falls back to another logged-in Claude account when this one reaches its usage threshold, lowered by the per-session reserve for other sessions running on that account, or is exhausted')).toBeTruthy();
  });

  it('keeps the per-session reserve explanation in the fallback note after saving', async () => {
    const calls: Call[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/settings/orchestrator') return { ...orchestrator, usageThresholdPercent: 80 };
      if (method === 'GET' && url === '/api/settings/tiers') return tiers;
      if (method === 'GET' && url === '/api/accounts') return [];
      if (method === 'PUT' && url === '/api/settings/orchestrator') return { ...(body as OrchestratorSettings), applies_to: 'next-session' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    expect(await screen.findByText(/falls back to another logged-in Claude account when this one reaches its usage threshold, lowered by the per-session reserve for other sessions running on that account, or is exhausted/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Orchestrator model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save orchestrator' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/orchestrator')).toBe(true));
    expect(await screen.findByText(/falls back to another logged-in Claude account when this one reaches its usage threshold, lowered by the per-session reserve for other sessions running on that account, or is exhausted/)).toBeTruthy();
  });

  it('refetches accounts when the Accounts section changes', async () => {
    const calls: Call[] = []; let added = false;
    mock(calls, () => added ? [{ id: 'a1', name: 'Work Claude', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }] : []);
    const { rerender } = render(<ModelsSettings accountsRefreshKey={0} />);
    const account = await screen.findByLabelText('standard candidate 1 account') as HTMLSelectElement;
    expect(account.disabled).toBe(true);
    added = true;
    rerender(<ModelsSettings accountsRefreshKey={1} />);
    await waitFor(() => expect(Array.from(account.options).map((o) => o.text)).toEqual(['machine login', 'Work Claude (logged out)']));
    expect(account.disabled).toBe(false);
  });

  it('keeps an unsaved tier edit when the accounts refresh key bumps', async () => {
    const calls: Call[] = []; let added = false;
    mock(calls, () => added ? [{ id: 'a1', name: 'Work Claude', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }] : []);
    const { rerender } = render(<ModelsSettings accountsRefreshKey={0} />);
    await waitFor(() => expect(screen.getByLabelText('standard candidate 1 model')).toHaveProperty('value', 'claude-sonnet-4'));
    fireEvent.change(screen.getByLabelText('standard candidate 1 model'), { target: { value: 'opus' } });
    const settingsGetsBefore = calls.filter((c) => c.method === 'GET' && c.url === '/api/settings/tiers').length;
    added = true;
    rerender(<ModelsSettings accountsRefreshKey={1} />);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url === '/api/accounts')).toBe(true));
    expect(screen.getByLabelText('standard candidate 1 model')).toHaveProperty('value', 'opus');
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/settings/tiers').length).toBe(settingsGetsBefore);
  });

  it('keeps a candidate account that is logged out in the picker, so Save posts what is shown', async () => {
    const calls: Call[] = [];
    const saved: TierSettings = { ...tiers, tiers: tiers.tiers.map((t) => (t.name === 'standard' ? { ...t, candidates: [{ ...t.candidates[0]!, account: 'a2' }] } : t)) };
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/settings/orchestrator') return orchestrator;
      if (method === 'GET' && url === '/api/settings/tiers') return saved;
      if (method === 'GET' && url === '/api/accounts') return [{ id: 'a2', name: 'Signed out', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: null, last_verified_at: null, has_secret: false, logged_in: false }];
      if (method === 'PUT' && url === '/api/settings/tiers') return { ...(body as TierSettings), applies_to: 'next-session' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    const account = await screen.findByLabelText('standard candidate 1 account') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(account.options).map((o) => o.text)).toEqual(['machine login', 'Signed out (logged out)']));
    expect(account.value).toBe('a2');
    expect(account.disabled).toBe(false);
    // The user can clear it, which is the only way out of a saved id the daemon would reject.
    fireEvent.change(account, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')!.body as TierSettings).tiers.find((t) => t.name === 'standard')!.candidates[0]!.account).toBe(null);
  });

  it('reports a failed accounts load and refetches on retry', async () => {
    const calls: Call[] = []; let down = true;
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/settings/orchestrator') return orchestrator;
      if (method === 'GET' && url === '/api/settings/tiers') return tiers;
      if (method === 'GET' && url === '/api/accounts') {
        if (down) throw Object.assign(new Error('daemon down'), { status: 500 });
        return [{ id: 'a1', name: 'Work Claude', label: null, harness: 'claude', kind: 'oauth_token', home: null, created_at: '', last_login_at: '', last_verified_at: null, has_secret: true, logged_in: true }];
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    expect(await screen.findByText(/Couldn't load accounts \(daemon down\)/)).toBeTruthy();
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry accounts' }));
    await waitFor(() => expect(screen.queryByText(/Couldn't load accounts/)).toBeNull());
    const account = screen.getByLabelText('standard candidate 1 account') as HTMLSelectElement;
    expect(Array.from(account.options).map((o) => o.text)).toEqual(['machine login', 'Work Claude']);
  });

  it('saves the orchestrator block and resets on demand', async () => {
    const calls: Call[] = [];
    mock(calls);
    render(<ModelsSettings />);
    await waitFor(() => expect(screen.getByLabelText('Orchestrator model')).toHaveProperty('value', 'claude-sonnet-4'));
    fireEvent.change(screen.getByLabelText('Orchestrator model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save orchestrator' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/orchestrator')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/orchestrator')!;
    expect(put.body).toEqual({ model: 'opus', effort: 'medium', promptOverride: null });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Applies to the next orchestrator session'));
    fireEvent.click(screen.getByText('Reset now'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/orchestrator/reset')).toBe(true));
  });

  it('picks a model from the list and opens a text input for a custom one', async () => {
    mock([]);
    render(<ModelsSettings />);
    // The critic candidate is codex with an unknown model: custom input; "list" returns to the picker with the CLI default.
    const custom = await screen.findByLabelText('critic candidate 1 model');
    expect(custom.tagName).toBe('INPUT');
    fireEvent.click(custom.parentElement!.querySelector('button')!); // the field's own "list" button, not the orchestrator's
    const select = screen.getByLabelText('critic candidate 1 model');
    expect(select.tagName).toBe('SELECT');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.text)).toEqual(['CLI default model', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'Custom…']);
    fireEvent.change(select, { target: { value: 'gpt-5.6-sol' } });
    expect(select).toHaveProperty('value', 'gpt-5.6-sol');
    fireEvent.change(select, { target: { value: ' custom' } });
    expect(screen.getByLabelText('critic candidate 1 model').tagName).toBe('INPUT');
  });
  it('shows a saved codex model that is in the list as selected, not the custom input', async () => {
    const saved: TierSettings = { ...tiers, tiers: tiers.tiers.map((t) => (t.name === 'critic' ? { ...t, candidates: [{ harness: 'codex', model: 'gpt-6-sol', effort: null }] } : t)) };
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/settings/orchestrator') return orchestrator;
      if (method === 'GET' && url === '/api/settings/tiers') return saved;
      if (method === 'GET' && url === '/api/accounts') return [];
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    const model = await screen.findByLabelText('critic candidate 1 model');
    expect(model.tagName).toBe('SELECT');
    expect(model).toHaveProperty('value', 'gpt-6-sol');
  });
  it('offers ultra only for eligible Codex tier models and custom Codex ids', async () => {
    const calls: Call[] = [];
    mock(calls, () => [], ultraTiers('custom-codex-model'));
    render(<ModelsSettings />);
    const effortOptions = () => Array.from((screen.getByLabelText('critic candidate 1 effort') as HTMLSelectElement).options).map((o) => o.value);
    const customModel = await screen.findByLabelText('critic candidate 1 model') as HTMLInputElement;
    expect(customModel.tagName).toBe('INPUT');
    expect(effortOptions()).toContain('ultra');
    expect(effortOptions()).toContain('max');
    expect(new Set(effortOptions()).size).toBe(effortOptions().length);
    expect(Array.from((screen.getByLabelText('Orchestrator effort') as HTMLSelectElement).options).map((o) => o.value)).not.toContain('ultra');

    fireEvent.click(customModel.parentElement!.querySelector('button')!);
    let model = screen.getByLabelText('critic candidate 1 model') as HTMLSelectElement;
    expect(model.value).toBe('');
    expect(effortOptions()).not.toContain('ultra');
    for (const supported of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      fireEvent.change(model, { target: { value: supported } });
      expect(effortOptions()).toContain('ultra');
    }
    for (const unsupported of ['gpt-6-luna', 'gpt-5.6-luna']) {
      fireEvent.change(screen.getByLabelText('critic candidate 1 model'), { target: { value: unsupported } });
      expect(effortOptions()).not.toContain('ultra');
    }

    model = screen.getByLabelText('critic candidate 1 model') as HTMLSelectElement;
    fireEvent.change(model, { target: { value: '\u0000custom' } });
    fireEvent.change(screen.getByLabelText('critic candidate 1 model'), { target: { value: 'gpt-5.5' } });
    expect(effortOptions()).not.toContain('ultra');
    const harness = screen.getByLabelText('critic candidate 1 harness');
    fireEvent.change(harness, { target: { value: 'claude' } });
    expect(effortOptions()).not.toContain('ultra');
    fireEvent.change(harness, { target: { value: 'opencode' } });
    expect(effortOptions()).not.toContain('ultra');

    const optionalTier = within(screen.getByRole('group', { name: /critic-chore/ }));
    fireEvent.click(optionalTier.getByRole('button', { name: 'Add candidate' }));
    fireEvent.change(screen.getByLabelText('critic-chore candidate 1 harness'), { target: { value: 'codex' } });
    const newCandidateEfforts = () => Array.from((screen.getByLabelText('critic-chore candidate 1 effort') as HTMLSelectElement).options).map((o) => o.value);
    const newCandidateModel = screen.getByLabelText('critic-chore candidate 1 model') as HTMLSelectElement;
    expect(newCandidateModel.value).toBe('');
    expect(newCandidateEfforts()).not.toContain('ultra');
    fireEvent.change(newCandidateModel, { target: { value: '\u0000custom' } });
    fireEvent.change(screen.getByLabelText('critic-chore candidate 1 model'), { target: { value: 'new-codex-model' } });
    expect(newCandidateEfforts()).toContain('ultra');

    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toContain('.tier-effort-field { display: grid; gap: 2px; min-width: 0; }');
  });
  it('clears stored ultra on an unsupported model or harness switch and saves the CLI default', async () => {
    const calls: Call[] = [];
    mock(calls, () => [], ultraTiers('gpt-6.1-sol'));
    render(<ModelsSettings />);
    const effort = await screen.findByLabelText('critic candidate 1 effort') as HTMLSelectElement;
    expect(effort.value).toBe('ultra');
    const notice = () => effort.parentElement!.querySelector('[role="status"]')?.textContent;
    const save = screen.getByRole('button', { name: 'Save tiers' });

    fireEvent.change(screen.getByLabelText('critic candidate 1 model'), { target: { value: 'gpt-6-luna' } });
    expect(effort.value).toBe('');
    expect(notice()).toBe('Ultra cleared because this model or harness does not support it.');
    fireEvent.click(save);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toHaveLength(1));
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    let sent = calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')[0]!.body as TierSettings;
    expect(sent.tiers.find((t) => t.name === 'critic')!.candidates[0]).toMatchObject({ harness: 'codex', model: 'gpt-6-luna', effort: null });

    fireEvent.change(screen.getByLabelText('critic candidate 1 model'), { target: { value: 'gpt-6.1-sol' } });
    expect(notice()).toBeUndefined();
    fireEvent.change(effort, { target: { value: 'ultra' } });
    fireEvent.change(screen.getByLabelText('critic candidate 1 harness'), { target: { value: 'claude' } });
    expect(effort.value).toBe('');
    expect(notice()).toBe('Ultra cleared because this model or harness does not support it.');
    fireEvent.click(save);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')).toHaveLength(2));
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    sent = calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/tiers')[1]!.body as TierSettings;
    expect(sent.tiers.find((t) => t.name === 'critic')!.candidates[0]).toMatchObject({ harness: 'claude', model: 'gpt-6.1-sol', effort: null });
  });
  it('shows a load-error message with a retry when a settings GET fails', async () => {
    const calls: Call[] = [];
    mockApi((method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/settings/orchestrator') throw Object.assign(new Error('daemon down'), { status: 500 });
      if (method === 'GET' && url === '/api/settings/tiers') return tiers;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    await waitFor(() => expect(screen.getByText(/Couldn't load model settings/)).toBeTruthy());
    expect(screen.queryByLabelText('Orchestrator model')).toBeNull();
  });
  it('shimmers the orchestrator form and the tier fieldsets while their settings are in flight, then the real forms', async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise<unknown>((r) => { release = r; });
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/settings/orchestrator') return pending.then(() => orchestrator);
      if (method === 'GET' && url === '/api/settings/tiers') return pending.then(() => tiers);
      if (method === 'GET' && url === '/api/accounts') return [];
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<ModelsSettings />);
    const shimmers = await screen.findAllByTestId('shimmer');
    expect(shimmers).toHaveLength(2); // one per fetch: the orchestrator form and the tier list
    // The reserved shape is the arrived one: the orchestrator's four controls, and the shipped tiers' seven candidate rows.
    expect(shimmers[0]!.querySelectorAll('.shimmer-measure-container .orchestrator-settings label')).toHaveLength(4);
    expect(shimmers[1]!.querySelectorAll('.shimmer-measure-container .tier')).toHaveLength(5);
    expect(shimmers[1]!.querySelectorAll('.shimmer-measure-container .tier-candidate')).toHaveLength(7);
    // The library walks a select into its zero-sized options and never paints a label's own text, so the
    // placeholder marks every select and the tier blurb (which holds a <code>) as one box and wraps label text in a span.
    const measured = (i: number, sel: string) => shimmers[i]!.querySelectorAll(`.shimmer-measure-container ${sel}`);
    expect(measured(0, 'select:not([data-shimmer-no-children])')).toHaveLength(0);
    expect(measured(0, 'label > span')).toHaveLength(4);
    expect(measured(1, 'select[data-shimmer-no-children]')).toHaveLength(28);
    expect(measured(1, '.tiers-settings > p[data-shimmer-no-children]')).toHaveLength(1);
    release(null);
    await waitFor(() => expect(screen.getByLabelText('Orchestrator model')).toHaveProperty('value', 'claude-sonnet-4'));
    expect(screen.getByLabelText('critic candidate 1 harness')).toBeTruthy();
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('stops both shimmers once a settings load has failed, rather than shimmering for the whole outage', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url === '/api/accounts') return [];
      throw Object.assign(new Error('daemon is down'), { status: 500 });
    });
    render(<ModelsSettings />);
    await screen.findByText(/Couldn't load model settings/);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
