import { useEffect, useState } from 'react';
import type { Account, Effort, HarnessName, OrchestratorSettings, Tier, TierCandidate, TierName, TierSettings } from '@overseer/shared';
import { supportsUltraEffort, TIER_NAMES } from '@overseer/shared';
import { api } from '../api';
import { Loading } from './Loading';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const HARNESSES: HarnessName[] = ['claude', 'codex', 'opencode'];
/** One line per tier on what the orchestrator sends there; the prompt uses the same words. */
const TIER_HELP: Record<TierName, string> = {
  chore: 'docs, config, renames, single-file edits with an obvious answer',
  standard: 'normal implementation work; the default',
  hard: 'work a standard attempt could not finish, or the user asked for the best model',
  critic: 'the review rounds: a different model than the worker reads the diff',
  'critic-chore': 'optional: the review round for chore beads, for a cheaper critic than the one above',
};

/** The tier blurb, shared with the placeholder below so the reserved height cannot drift from the arrived one. */
const TIERS_HELP = <>The orchestrator dispatches each bead with a tier, not a model. A tier is a list of candidates in fallback order: the first whose CLI is installed and whose model the bead has not tried yet runs it. A bead's first chore or standard dispatch instead takes the usable candidate with the lowest catalog input price (unpriced models last, ties in list order); hard and the critic tiers always keep list order. Model is what the CLI's <code>--model</code> takes (empty keeps that CLI's default); effort is its thinking effort (inherit keeps the CLI's default). After a failed attempt the bead moves one tier up.</>;
/** The orchestrator blurb, shared with its placeholder for the same reason. */
const ORCH_HELP = <>The session you chat with. Model and effort are passed to the Claude CLI on its next session; leave them empty for the CLI's defaults. The prompt override replaces the shipped orchestrator prompt entirely.</>;

function EffortSelect(p: { value: Effort | null; onChange: (v: Effort | null) => void; blankLabel: string; ariaLabel: string; allowUltra?: boolean }) {
  const efforts = p.allowUltra ? [...EFFORTS, 'ultra'] : EFFORTS;
  return (
    <select aria-label={p.ariaLabel} value={p.value ?? ''} onChange={(e) => p.onChange((e.target.value || null) as Effort | null)}>
      <option value="">{p.blankLabel}</option>
      {efforts.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
    </select>
  );
}

/** The models each CLI takes on `--model` as the user knows them; this is a short set of suggestions, and anything else goes through the custom entry. */
const KNOWN_MODELS: Record<HarnessName, string[]> = {
  claude: ['haiku', 'sonnet', 'opus', 'fable'],
  codex: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  opencode: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
};
const CUSTOM = '\u0000custom';

/** A model picker: the harness's known models, the current value when it is not one of them, and a custom entry that opens a text input. */
function ModelField(p: { harness: HarnessName; value: string; onChange: (v: string) => void; ariaLabel: string }) {
  const known = KNOWN_MODELS[p.harness];
  const [custom, setCustom] = useState(() => known.length === 0 || (p.value !== '' && !known.includes(p.value)));
  if (custom) {
    return (
      <span className="model-custom">
        <input aria-label={p.ariaLabel} placeholder={p.harness === 'opencode' ? 'provider/model' : 'model id'} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
        {known.length > 0 && <button type="button" className="link" onClick={() => { setCustom(false); if (!known.includes(p.value)) p.onChange(''); }}>list</button>}
      </span>
    );
  }
  return (
    <select aria-label={p.ariaLabel} value={p.value} onChange={(e) => { if (e.target.value === CUSTOM) setCustom(true); else p.onChange(e.target.value); }}>
      <option value="">CLI default model</option>
      {known.map((m) => <option key={m} value={m}>{m}</option>)}
      <option value={CUSTOM}>Custom…</option>
    </select>
  );
}

function newCandidate(): TierCandidate { return { harness: 'claude', model: '', effort: null }; }

/** What the shipped tiers hold (the daemon's DEFAULT_TIERS): two candidates each but one for critic, and none for the optional cheaper chore critic. */
const PLACEHOLDER_CANDIDATES: Record<TierName, number> = { chore: 2, standard: 2, hard: 2, critic: 1, 'critic-chore': 0 };

/** The orchestrator form as it arrives: same heading, blurb, labelled controls and action row, with placeholder values. */
function OrchestratorPlaceholder() {
  return (
    <div className="orchestrator-settings">
      <h3>Orchestrator</h3>
      <p className="muted">{ORCH_HELP}</p>
      <label><span>Model</span><select data-shimmer-no-children><option>model id</option></select></label>
      <label><span>Effort</span><select data-shimmer-no-children><option>medium</option></select></label>
      <label><span>Account</span><select data-shimmer-no-children><option>machine login</option></select></label>
      <p className="muted">falls back to another logged-in Claude account when this one reaches its usage threshold, lowered by the per-session reserve for other sessions running on that account, or is exhausted</p>
      <label><span>Prompt override</span><textarea readOnly value="" /></label>
      <div className="form-actions"><button type="button">Save orchestrator</button></div>
    </div>
  );
}

/** The tier form as it arrives: one fieldset per tier, each with the candidate rows the shipped defaults hold. */
function TiersPlaceholder() {
  return (
    <div className="tiers-settings">
      <h3>Worker tiers</h3>
      <p className="muted" data-shimmer-no-children>{TIERS_HELP}</p>
      {TIER_NAMES.map((name) => (
        <fieldset className="tier" key={name}>
          <legend>{name} <span className="muted">{TIER_HELP[name]}</span></legend>
          {Array.from({ length: PLACEHOLDER_CANDIDATES[name] }, (_, idx) => (
            <div className="tier-candidate" key={idx}>
              <select data-shimmer-no-children><option>claude</option></select>
              <select data-shimmer-no-children><option>model id</option></select>
              <select data-shimmer-no-children><option>inherit effort</option></select>
              <select data-shimmer-no-children><option>machine login</option></select>
              <span className="tier-candidate-actions"><button type="button">↑</button><button type="button">↓</button><button type="button">Remove</button></span>
            </div>
          ))}
          <button type="button" className="link">Add candidate</button>
        </fieldset>
      ))}
      <div className="form-actions"><button type="button">Save tiers</button></div>
    </div>
  );
}

export function ModelsSettings(p: { accountsRefreshKey?: number }) {
  const [orch, setOrch] = useState<OrchestratorSettings | null>(null);
  const [orchApplied, setOrchApplied] = useState(false);
  const [orchError, setOrchError] = useState<string | null>(null);
  const [orchBusy, setOrchBusy] = useState(false);

  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [ultraCleared, setUltraCleared] = useState<Set<string>>(() => new Set());
  const [denyModels, setDenyModels] = useState<string[]>([]);
  const [tiersError, setTiersError] = useState<string | null>(null);
  const [tiersBusy, setTiersBusy] = useState(false);
  const [tiersSaved, setTiersSaved] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRetry, setLoadRetry] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsRetry, setAccountsRetry] = useState(0);

  useEffect(() => {
    setLoadError(null);
    void api.get<OrchestratorSettings>('/settings/orchestrator').then(setOrch).catch((e: Error) => setLoadError(e.message));
    void api.get<TierSettings>('/settings/tiers').then((s) => { setTiers(s.tiers); setDenyModels(s.denyModels); }).catch((e: Error) => setLoadError(e.message));
  }, [loadRetry]);

  useEffect(() => {
    setAccountsError(null);
    void api.get<Account[]>('/accounts', { fresh: true }).then(setAccounts).catch((e: Error) => setAccountsError(e.message));
  }, [p.accountsRefreshKey, accountsRetry]);

  /** An account picker: every account for the harness, plus a missing saved account, so what the select shows is what Save posts and the user can clear it. */
  const accountSelect = (ariaLabel: string, harness: HarnessName, value: string | null, onChange: (v: string | null) => void) => {
    const options = accounts.filter((a) => a.harness === harness).map((a) => {
      const name = a.label ? `${a.name} (${a.label})` : a.name;
      return { id: a.id, label: a.logged_in ? name : `${name} (logged out)` };
    });
    if (value && !options.some((o) => o.id === value)) {
      const account = accounts.find((a) => a.id === value);
      const name = account ? (account.label ? `${account.name} (${account.label})` : account.name) : value;
      options.push({ id: value, label: `${name} (logged out)` });
    }
    return (
      <select aria-label={ariaLabel} value={value ?? ''} disabled={options.length === 0} title="Add or log in to an account in Setup → Accounts" onChange={(e) => onChange(e.target.value || null)}>
        <option value="">machine login</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    );
  };

  const saveOrchestrator = async () => {
    if (!orch) return;
    setOrchError(null);
    setOrchBusy(true);
    setOrchApplied(false);
    try {
      const { usageThresholdPercent, ...saved } = { ...orch, model: orch.model?.trim() || null };
      await api.put<OrchestratorSettings & { applies_to: string }>('/settings/orchestrator', saved);
      setOrch({ ...saved, usageThresholdPercent });
      setOrchApplied(true);
    } catch (e) {
      setOrchError((e as Error).message);
    } finally {
      setOrchBusy(false);
    }
  };

  const resetOrchestrator = async () => {
    setOrchError(null);
    try {
      await api.post('/orchestrator/reset');
    } catch (e) {
      setOrchError((e as Error).message);
    }
  };

  const updateTier = (name: TierName, update: (t: Tier) => Tier) => {
    setTiersSaved(false);
    setTiers((ts) => ts?.map((t) => (t.name === name ? update(t) : t)) ?? ts);
  };
  const updateCandidate = (name: TierName, idx: number, update: (c: TierCandidate) => TierCandidate) => {
    updateTier(name, (t) => ({ ...t, candidates: t.candidates.map((c, i) => (i === idx ? update(c) : c)) }));
  };
  const setUltraClearedNotice = (name: TierName, idx: number, shown: boolean) => {
    const key = `${name}:${idx}`;
    setUltraCleared((current) => {
      const next = new Set(current);
      if (shown) next.add(key); else next.delete(key);
      return next;
    });
  };
  /** Adds a candidate, creating the tier row when Setup offers a tier the saved settings do not hold yet (the optional cheaper chore critic). */
  const addCandidate = (name: TierName) => {
    setTiersSaved(false);
    setTiers((ts) => {
      if (!ts) return ts;
      return ts.some((t) => t.name === name)
        ? ts.map((t) => (t.name === name ? { ...t, candidates: [...t.candidates, newCandidate()] } : t))
        : [...ts, { name, candidates: [newCandidate()] }];
    });
  };
  const removeCandidate = (name: TierName, idx: number) => {
    setUltraCleared(new Set());
    updateTier(name, (t) => ({ ...t, candidates: t.candidates.filter((_, i) => i !== idx) }));
  };
  const moveCandidate = (name: TierName, idx: number, dir: -1 | 1) => {
    setUltraCleared(new Set());
    updateTier(name, (t) => {
      const j = idx + dir;
      if (j < 0 || j >= t.candidates.length) return t;
      const candidates = [...t.candidates];
      [candidates[idx], candidates[j]] = [candidates[j]!, candidates[idx]!];
      return { ...t, candidates };
    });
  };

  const saveTiers = async () => {
    if (!tiers) return;
    setTiersError(null);
    setTiersBusy(true);
    setTiersSaved(false);
    try {
      // A tier with no candidates is not configured: omit it so the optional cheaper chore critic can stay absent.
      await api.put<TierSettings & { applies_to: string }>('/settings/tiers', { tiers: tiers.filter((t) => t.candidates.length > 0), denyModels });
      setTiersSaved(true);
    } catch (e) {
      setTiersError((e as Error).message);
    } finally {
      setTiersBusy(false);
    }
  };

  return (
    <section className="models-settings">
      <h2>Models</h2>
      {loadError && (
        <p className="badge-warn" role="alert">
          <span>Couldn't load model settings ({loadError}).</span> <button type="button" className="link" onClick={() => setLoadRetry((n) => n + 1)}>Retry</button>
        </p>
      )}
      {accountsError && (
        <p className="badge-warn" role="alert">
          <span>Couldn't load accounts ({accountsError}); the account pickers stay empty.</span> <button type="button" className="link" onClick={() => setAccountsRetry((n) => n + 1)}>Retry accounts</button>
        </p>
      )}
      {/* Each form waits on its own fetch, and a failed load stops its shimmer: invented controls for a whole outage are worse than the blank. */}
      <Loading loading={orch === null && loadError === null} label="Loading the orchestrator settings…" placeholder={<OrchestratorPlaceholder />}>
      <>{orch && (
        <div className="orchestrator-settings">
          <h3>Orchestrator</h3>
          <p className="muted">{ORCH_HELP}</p>
          <label>Model<ModelField harness="claude" ariaLabel="Orchestrator model" value={orch.model ?? ''} onChange={(model) => setOrch({ ...orch, model })} /></label>
          <label>Effort<EffortSelect ariaLabel="Orchestrator effort" value={orch.effort} blankLabel="CLI default" onChange={(effort) => setOrch({ ...orch, effort })} /></label>
          <label>Account{accountSelect('Orchestrator account', 'claude', orch.account ?? null, (account) => setOrch({ ...orch, account }))}</label>
          <p className="muted">falls back to another logged-in Claude account when this one reaches its usage threshold, lowered by the per-session reserve for other sessions running on that account, or is exhausted</p>
          <label>Prompt override
            <textarea aria-label="Orchestrator prompt override" value={orch.promptOverride ?? ''} onChange={(e) => setOrch({ ...orch, promptOverride: e.target.value || null })} />
          </label>
          {orch.promptOverride && (
            <a href="#" onClick={(e) => { e.preventDefault(); setOrch({ ...orch, promptOverride: null }); }}>Reset to shipped prompt</a>
          )}
          <div className="form-actions">
            <button type="button" disabled={orchBusy} onClick={() => void saveOrchestrator()}>{orchBusy ? 'Saving…' : 'Save orchestrator'}</button>
            {orchError && <span className="badge-warn">{orchError}</span>}
          </div>
          {orchApplied && (
            <p className="muted" role="status">
              Applies to the next orchestrator session. <a href="#" onClick={(e) => { e.preventDefault(); void resetOrchestrator(); }}>Reset now</a>
            </p>
          )}
        </div>
      )}</>
      </Loading>
      <Loading loading={tiers === null && loadError === null} label="Loading the worker tiers…" placeholder={<TiersPlaceholder />}>
      <>{tiers && (
        <div className="tiers-settings">
          <h3>Worker tiers</h3>
          <p className="muted">{TIERS_HELP}</p>
          {TIER_NAMES.map((name) => {
            // A tier the saved settings do not hold (the optional cheaper chore critic) still renders, empty, so it can be configured.
            const tier = tiers.find((t) => t.name === name) ?? { name, candidates: [] as TierCandidate[] };
            return (
              <fieldset className="tier" key={name}>
                <legend>{name} <span className="muted">{TIER_HELP[name]}</span></legend>
                {tier.candidates.map((c, idx) => (
                  <div className="tier-candidate" key={idx}>
                    <select aria-label={`${name} candidate ${idx + 1} harness`} value={c.harness} onChange={(e) => {
                      const harness = e.target.value as HarnessName;
                      const clearUltra = c.effort === 'ultra' && !supportsUltraEffort(harness, c.model);
                      setUltraClearedNotice(name, idx, clearUltra);
                      updateCandidate(name, idx, (cand) => ({ ...cand, harness, account: null, effort: clearUltra ? null : cand.effort }));
                    }}>
                      {HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <ModelField key={c.harness} harness={c.harness} ariaLabel={`${name} candidate ${idx + 1} model`} value={c.model} onChange={(model) => {
                      const clearUltra = c.effort === 'ultra' && !supportsUltraEffort(c.harness, model);
                      setUltraClearedNotice(name, idx, clearUltra);
                      updateCandidate(name, idx, (cand) => ({ ...cand, model, effort: clearUltra ? null : cand.effort }));
                    }} />
                    <div className="tier-effort-field">
                      <EffortSelect ariaLabel={`${name} candidate ${idx + 1} effort`} value={c.effort} blankLabel="inherit effort" allowUltra={supportsUltraEffort(c.harness, c.model)} onChange={(effort) => {
                        setUltraClearedNotice(name, idx, false);
                        updateCandidate(name, idx, (cand) => ({ ...cand, effort }));
                      }} />
                      {ultraCleared.has(`${name}:${idx}`) && <span className="muted" role="status">Ultra cleared because this model or harness does not support it.</span>}
                    </div>
                    {accountSelect(`${name} candidate ${idx + 1} account`, c.harness, c.account ?? null, (account) => updateCandidate(name, idx, (cand) => ({ ...cand, account })))}
                    <span className="tier-candidate-actions">
                      <button type="button" title="Try earlier" aria-label={`${name} candidate ${idx + 1} up`} onClick={() => moveCandidate(name, idx, -1)} disabled={idx === 0}>↑</button>
                      <button type="button" title="Try later" aria-label={`${name} candidate ${idx + 1} down`} onClick={() => moveCandidate(name, idx, 1)} disabled={idx === tier.candidates.length - 1}>↓</button>
                      <button type="button" onClick={() => removeCandidate(name, idx)}>Remove</button>
                    </span>
                  </div>
                ))}
                <button type="button" className="link" onClick={() => addCandidate(name)}>Add candidate</button>
              </fieldset>
            );
          })}
          <div className="form-actions">
            <button type="button" disabled={tiersBusy} onClick={() => void saveTiers()}>{tiersBusy ? 'Saving…' : 'Save tiers'}</button>
            {tiersError && <span className="badge-warn">{tiersError}</span>}
            {tiersSaved && !tiersError && <span className="muted" role="status">Saved; the next dispatch uses them.</span>}
          </div>
        </div>
      )}</>
      </Loading>
    </section>
  );
}
