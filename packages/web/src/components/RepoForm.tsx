import { useEffect, useRef, useState } from 'react';
import type { Account, BatchApprover, HarnessName, InspectResponse, MergeMode, Repo, Tier, TierSettings } from '@overseer/shared';
import { api } from '../api';
import { BrowseDialog } from './BrowseDialog';

/** `onDone` may return the list refresh; the form stays busy until it lands, so the table never lags behind a cleared form. */
export type RepoFormProps =
  | { mode: 'add'; onDone: (added: { id: string; beads_initialised: boolean }) => void | Promise<unknown>; /** Present when the form was revealed by a button and can be put away again. */ onCancel?: () => void }
  | { mode: 'edit'; repo: Repo; onDone: (saved: Repo) => void | Promise<unknown>; onCancel: () => void };

export function RepoForm(p: RepoFormProps) {
  const existing = p.mode === 'edit' ? p.repo : null;
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [inspect, setInspect] = useState<InspectResponse | null>(null);
  const [id, setId] = useState(existing?.id ?? '');
  const [branch, setBranch] = useState(existing?.base_branch ?? '');
  const [verify, setVerify] = useState(existing?.verify_command ?? '');
  const [reviewCommand, setReviewCommand] = useState(existing?.review_command ?? '');
  const [setupCmd, setSetupCmd] = useState(existing?.setup_command ?? '');
  const [limit, setLimit] = useState(String(existing?.worker_limit ?? 2));
  const [rounds, setRounds] = useState(String(existing?.review_rounds ?? 2));
  const [merge, setMerge] = useState<MergeMode>(existing?.merge_mode ?? 'local-merge');
  const [approver, setApprover] = useState<BatchApprover>(existing?.batch_approver ?? 'user');
  const [modelFilter, setModelFilter] = useState<NonNullable<Repo['model_filter']>>(existing?.model_filter ?? { harnesses: [], models: [], accounts: [] });
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const gitlab = merge === 'gitlab-mr';
  const [commitBeads, setCommitBeads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idTouched = useRef(false);
  const branchTouched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<TierSettings>('/settings/tiers'), api.get<Account[]>('/accounts')])
      .then(([settings, loadedAccounts]) => { if (!cancelled) { setTiers(settings.tiers); setAccounts(loadedAccounts); } })
      .catch((e: Error) => { if (!cancelled) setModelsError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const toggle = (kind: keyof NonNullable<Repo['model_filter']>, value: string) => {
    setModelFilter((current) => ({ ...current, [kind]: (current[kind] as string[]).includes(value)
      ? current[kind].filter((item) => item !== value)
      : [...current[kind], value] }));
  };
  const activeFilter = modelFilter.harnesses.length || modelFilter.models.length || modelFilter.accounts.length ? modelFilter : null;
  const harnesses: HarnessName[] = ['claude', 'codex', 'opencode'];
  const modelsByHarness = harnesses.map((harness) => ({ harness, models: [...new Set(tiers?.flatMap((tier) => tier.candidates.filter((candidate) => candidate.harness === harness && candidate.model).map((candidate) => candidate.model)) ?? [])] }));
  const knownModels = new Set(modelsByHarness.flatMap((group) => group.models));
  const deletedAccounts = accounts ? modelFilter.accounts.filter((accountId) => !accounts.some((account) => account.id === accountId)) : [];
  const missingModels = tiers ? modelFilter.models.filter((model) => !knownModels.has(model)) : [];
  const passes = (candidate: Tier['candidates'][number]) => !activeFilter ||
    (!activeFilter.harnesses.length || activeFilter.harnesses.includes(candidate.harness)) &&
    (!activeFilter.models.length || activeFilter.models.includes(candidate.model)) &&
    (!activeFilter.accounts.length || activeFilter.accounts.includes(candidate.account ?? '') && accounts?.some((account) => account.id === candidate.account));

  useEffect(() => {
    if (p.mode !== 'add') return;
    const value = path.trim();
    if (!value) { setInspect(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.post<InspectResponse>('/repos/inspect', { path: value }).then((r) => {
        if (cancelled) return;
        setInspect(r);
        if (!idTouched.current) setId(r.suggested_id);
        if (!branchTouched.current && r.branch) setBranch(r.branch);
      }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [path, p.mode]);

  // Checked as the field is typed in, like the path is: the server refuses it too, but every other field of this form answers at
  // once and the round trip left Save enabled over a value the form already knew was wrong (round 27 nit).
  const workers = Number(limit);
  const limitError = Number.isInteger(workers) && workers >= 1 && workers <= 16 ? null : 'Worker limit must be a whole number from 1 to 16.';
  const canSubmit = !limitError && (p.mode === 'edit' || (inspect !== null && inspect.problems.length === 0));
  const showBeads = p.mode === 'add' && inspect !== null && inspect.exists && !inspect.has_beads;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const fields = { base_branch: branch.trim(), verify_command: verify.trim() || null, review_command: reviewCommand.trim() || null, setup_command: setupCmd.trim() || null, merge_mode: merge, batch_approver: gitlab ? 'user' : approver, worker_limit: workers, review_rounds: Number(rounds), model_filter: activeFilter };
      if (p.mode === 'edit') {
        const saved = await api.patch<Repo>(`/repos/${p.repo.id}`, fields);
        await p.onDone(saved);
      } else {
        const added = await api.post<Repo>('/repos', { path: path.trim(), id: id.trim(), ...fields, ...(showBeads ? { beads: commitBeads ? 'commit' : 'stealth' } : {}) });
        await p.onDone({ id: added.id, beads_initialised: showBeads });
        setPath(''); setInspect(null); setId(''); setBranch(''); setVerify(''); setReviewCommand(''); setSetupCmd(''); setLimit('2'); setRounds('2'); setMerge('local-merge'); setApprover('user'); setCommitBeads(false); setModelFilter({ harnesses: [], models: [], accounts: [] });
        idTouched.current = false; branchTouched.current = false;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="repo-form" noValidate onSubmit={(e) => { e.preventDefault(); if (canSubmit && !busy) void submit(); }}>
      {/* The form replaces the row's own cells, so the only cue to which repository is being edited was its position in the table
          (round 25 R25-2). It names its target the way every confirm in this product does. */}
      {p.mode === 'edit' && <p className="muted breakable">Editing {p.repo.id} — {p.repo.path}</p>}
      {p.mode === 'add' && (
        <label>Path
          <div className="path-row">
            <input aria-label="Path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="E:\Projects\my-repo" />
            <button type="button" onClick={() => setBrowsing(true)}>Browse</button>
          </div>
          {inspect && (inspect.problems.length === 0
            ? <div className="ok">git repository on branch {inspect.branch}</div>
            : <div className="badge-warn">{inspect.problems.join('; ')}</div>)}
        </label>
      )}
      {p.mode === 'add' && <label>Id<input aria-label="Id" value={id} onChange={(e) => { idTouched.current = true; setId(e.target.value); }} /></label>}
      <label>Base branch<input aria-label="Base branch" value={branch} onChange={(e) => { branchTouched.current = true; setBranch(e.target.value); }} /></label>
      <label>Verify command<input aria-label="Verify command" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="pnpm test (empty: no verification)" /></label>
      <label>Review command<input aria-label="Review command" value={reviewCommand} onChange={(e) => setReviewCommand(e.target.value)} placeholder="pnpm test (empty: no pre-review suite)" />
        <div className="muted">Runs once for each batch head before review is requested. A failure keeps the batch open.</div>
      </label>
      <label>Setup command<input aria-label="Setup command" value={setupCmd} onChange={(e) => setSetupCmd(e.target.value)} placeholder="pnpm install (empty: nothing runs)" />
        <div className="muted">Runs once in every new bead and batch worktree, so commit hooks and both test commands find their dependencies.</div>
      </label>
      {/* The form is `noValidate`: the browser's own bubble for min/max is not how this form reports anything else (round 9). */}
      <label>Worker limit<input aria-label="Worker limit" type="number" min={1} max={16} value={limit} onChange={(e) => setLimit(e.target.value)} />
        {limitError && <div className="badge-warn">{limitError}</div>}
      </label>
      <label>Review rounds<input aria-label="Review rounds" type="number" min={0} max={5} value={rounds} onChange={(e) => setRounds(e.target.value)} />
        <div className="muted">The most review rounds a bead gets; 0 turns review off. A chore bead gets one, a standard bead one more only after a must finding or a diff over 400 lines, a hard bead all of them.</div>
      </label>
      <label>Merge mode
        <select aria-label="Merge mode" value={merge} onChange={(e) => setMerge(e.target.value as MergeMode)}>
          <option value="local-merge">local-merge</option>
          <option value="gitlab-mr">gitlab-mr</option>
        </select>
      </label>
      {gitlab
        ? <div className="muted">Batch approver: user. A GitLab merge request is always merged by you on GitLab, so the orchestrator value is offered only for local-merge.</div>
        : <label>Batch approver
            <select aria-label="Batch approver" value={approver} onChange={(e) => setApprover(e.target.value as BatchApprover)}>
              <option value="user">user</option>
              <option value="orchestrator">orchestrator</option>
            </select>
            <div className="muted">user: batches wait for your Merge; orchestrator: the orchestrator merges them on its own.</div>
          </label>}
      <fieldset className="repo-models">
        <legend>Models</legend>
        <p className="muted">Tick the harnesses, accounts and models this repository may use. An empty group allows all in that group.</p>
        {!activeFilter && <p className="muted">Nothing selected: this repository uses the global tier table.</p>}
        <div className="repo-model-groups">
          <div role="group" aria-label="Harnesses"><strong>Harnesses</strong>
            {harnesses.map((harness) => <label className="checkbox" key={harness}><input type="checkbox" checked={modelFilter.harnesses.includes(harness)} onChange={() => toggle('harnesses', harness)} />{harness}</label>)}
          </div>
          <div role="group" aria-label="Accounts"><strong>Accounts</strong>
            {harnesses.map((harness) => <div key={harness}><span className="muted">{harness}</span>
              {accounts?.filter((account) => account.harness === harness).map((account) => <label className="checkbox" key={account.id}><input type="checkbox" checked={modelFilter.accounts.includes(account.id)} onChange={() => toggle('accounts', account.id)} />{account.name}{account.label && ` (${account.label})`}</label>)}
            </div>)}
            {deletedAccounts.map((accountId) => <label className="checkbox" key={accountId}><input type="checkbox" checked onChange={() => toggle('accounts', accountId)} />Deleted account ({accountId})</label>)}
          </div>
          <div role="group" aria-label="Models"><strong>Models</strong>
            {modelsByHarness.map(({ harness, models }) => <div key={harness}><span className="muted">{harness}</span>
              {models.map((model) => <label className="checkbox" key={model}><input type="checkbox" checked={modelFilter.models.includes(model)} onChange={() => toggle('models', model)} />{model || 'CLI default'}</label>)}
            </div>)}
            {missingModels.map((model) => <label className="checkbox" key={model}><input type="checkbox" checked onChange={() => toggle('models', model)} />{model} (not in tiers)</label>)}
          </div>
        </div>
        {modelsError && <p className="badge-warn">Could not load models: {modelsError}</p>}
        <div className="repo-model-preview"><strong>Worker tier preview</strong>
          {(['chore', 'standard', 'hard'] as const).map((name) => {
            const candidates = tiers?.find((tier) => tier.name === name)?.candidates.filter(passes) ?? [];
            return <div key={name}><strong>{name}</strong>{tiers === null ? <span className="muted"> Loading…</span> : candidates.length
              ? <ol>{candidates.map((candidate, index) => <li key={index}>{candidate.harness} · {candidate.model || 'CLI default'} · {candidate.effort ?? 'inherit'} · {accounts?.find((account) => account.id === candidate.account)?.name ?? (candidate.account ? `Deleted account (${candidate.account})` : 'machine login')}</li>)}</ol>
              : <span className="badge-warn"> Dispatches are refused: no candidate remains.</span>}</div>;
          })}
          <p className="muted">Review critics use the global critic tier.</p>
        </div>
      </fieldset>
      {showBeads && (
        <label className="checkbox">
          <input type="checkbox" aria-label="My team uses beads: commit its files" checked={commitBeads} onChange={(e) => setCommitBeads(e.target.checked)} />
          <span>My team uses beads: commit its files<span className="muted">Unchecked: beads is set up in stealth mode, nothing is committed and teammates see nothing.</span></span>
        </label>
      )}
      <div className="form-actions">
        <button type="submit" disabled={!canSubmit || busy}>{p.mode === 'add' ? (busy ? 'Adding…' : 'Add') : busy ? 'Saving…' : 'Save'}</button>
        {p.onCancel && <button type="button" onClick={p.onCancel}>Cancel</button>}
        {error && <span className="badge-warn">{error}</span>}
      </div>
      {browsing && <BrowseDialog initialPath={path} onPick={(picked) => { setPath(picked); setBrowsing(false); }} onClose={() => setBrowsing(false)} />}
    </form>
  );
}
