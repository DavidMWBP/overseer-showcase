import { useEffect, useState } from 'react';
import type { Account, AccountUsage } from '@overseer/shared';
import { api, fetchAccountUsage, USAGE_POLL_MS } from '../api';
import { Loading } from './Loading';

type Login = { state: 'idle' | 'pending' | 'done' | 'failed'; url?: string; code?: string; error?: string; instructions?: string };

const kindLabel = (a: Account) => a.kind === 'oauth_token' ? 'OAuth / setup-token' : a.kind === 'api_key' ? `API key${a.provider ? ` · ${a.provider}` : ''}` : 'device login';
const OPENCODE_PROVIDERS = ['deepseek'];
const hasUsage = (a: Account) => a.harness === 'claude' && a.kind === 'oauth_token';
const pad = (n: number) => String(n).padStart(2, '0');
/** Local time, `14:00` when the reset falls today, `Thu 09:00` otherwise. */
export function fmtReset(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
/** `just now`, `5m ago`, `2h ago`, `3d ago`: the staleness of the daemon's last successful read. */
export function fmtAgo(iso: string, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
const HIGH_USAGE = 80;
function Usage(p: { usage: AccountUsage }) {
  const u = p.usage;
  const buckets = [u.session && { label: 'Session', ...u.session }, u.weekly && { label: 'Week', ...u.weekly }, ...u.models.map((m) => ({ label: m.model, ...m }))].filter((b): b is { label: string; percent: number; resetsAt: string | null } => !!b);
  if (!buckets.length && !u.error) return null;
  return <div className="account-usage muted">
    {buckets.map((b) => <span key={b.label}><span className={b.percent > HIGH_USAGE ? 'usage-high' : undefined}>{b.label} {Math.round(b.percent)}%</span>{b.resetsAt && <> resets {fmtReset(b.resetsAt)}</>}</span>)}
    {u.error && <span>usage unavailable ({u.error})</span>}
    <span>updated {fmtAgo(u.fetchedAt)}</span>
  </div>;
}
/** The usage line as it arrives: the same flex row of buckets, with placeholder percentages. */
function UsagePlaceholder() {
  return <div className="account-usage muted"><span>Session 0% resets 00:00</span><span>Week 0% resets Thu 00:00</span><span>updated just now</span></div>;
}
/** Two rows: a logged-in Claude account and a second harness, which is what the Accounts list holds on a working install. */
const PLACEHOLDER_ROWS = 2;
/** The account rows as they arrive: the same three-column row, a usage line under the first, placeholder values throughout. */
function RowsPlaceholder() {
  return <div className="account-rows-placeholder">{Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
    <div className="account-row" key={i}>
      <div className="account-meta"><strong>Account name</strong> <span className="chip">label</span> <span className="muted">claude · OAuth / setup-token</span><div className="muted">logged in 01/01/2026, 00:00:00</div>{i === 0 && <UsagePlaceholder />}</div>
      <div className="account-label"><input readOnly placeholder="Label" value="" /></div>
      <div className="account-actions"><button type="button">Log in</button><button type="button">Verify</button><button type="button">Remove</button></div>
    </div>
  ))}</div>;
}

const status = (a: Account) => a.last_login_at ? `logged in ${new Date(a.last_login_at).toLocaleString()}` : a.last_verified_at ? `verified ${new Date(a.last_verified_at).toLocaleString()}` : a.logged_in ? 'logged in' : 'not logged in';

export function AccountsSettings(p: { onAccountsChanged?: () => void }) {
  // null until the first list lands, so the rows can tell loading from an install with no accounts yet.
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [harness, setHarness] = useState<'claude' | 'codex' | 'opencode'>('claude');
  const [kind, setKind] = useState<'oauth_token' | 'api_key' | 'codex_home'>('oauth_token');
  const [provider, setProvider] = useState('');
  const [secret, setSecret] = useState('');
  const [loginSecret, setLoginSecret] = useState('');
  const [login, setLogin] = useState<{ id: string; state: Login } | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifiedId, setVerifiedId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, AccountUsage | null>>({});
  const load = async () => {
    const next = await api.get<Account[]>('/accounts', { fresh: true });
    setAccounts(next);
    setLabels(Object.fromEntries(next.map((a) => [a.id, a.label ?? ''])));
    setProviders(Object.fromEntries(next.map((a) => [a.id, a.provider ?? ''])));
    setSecrets({});
  };
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, []);
  const usageIds = (accounts ?? []).filter(hasUsage).map((a) => a.id).join(',');
  useEffect(() => {
    if (!usageIds) return;
    // A failed read keeps the previous line: the daemon itself reports a refresh failure inside `error`. A first read that
    // fails records null instead, so the shimmer in an otherwise arrived row stops rather than standing for the whole outage.
    const poll = () => { for (const id of usageIds.split(',')) void fetchAccountUsage(id).then((u) => setUsage((prev) => ({ ...prev, [id]: u }))).catch(() => setUsage((prev) => (id in prev ? prev : { ...prev, [id]: null }))); };
    poll();
    const timer = setInterval(poll, USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [usageIds]);
  useEffect(() => {
    if (!login || login.state.state !== 'pending') return;
    // A failed poll ends the login: leaving the state 'pending' would keep this interval asking forever (the account can be gone).
    const timer = setInterval(() => void api.get<Login>(`/accounts/${login.id}/login`, { fresh: true }).then((state) => {
      if (state.state === 'idle') { setLogin(null); return; }
      setLogin({ id: login.id, state });
      if (state.state !== 'pending') void load().then(() => p.onAccountsChanged?.()).catch((e: Error) => setError(e.message));
    }).catch((e: Error) => setLogin({ id: login.id, state: { state: 'failed', error: e.message } })), 2000);
    return () => clearInterval(timer);
  }, [login?.id, login?.state.state]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.post('/accounts', { name, ...(label ? { label } : {}), harness, kind, ...(harness === 'opencode' ? { provider } : {}), ...(kind === 'api_key' ? { secret } : {}) }); setName(''); setLabel(''); setProvider(''); setSecret(''); await load(); p.onAccountsChanged?.(); } catch (e) { setError((e as Error).message); }
  };
  const saveLabel = async (a: Account) => {
    const next = labels[a.id] ?? '';
    if (next === (a.label ?? '')) return;
    setError(null);
    try { const saved = await api.patch<Account>(`/accounts/${a.id}`, { label: next }); setAccounts((current) => current?.map((account) => account.id === a.id ? saved : account) ?? current); p.onAccountsChanged?.(); } catch (e) { setError((e as Error).message); }
  };
  const saveOpenCode = async (a: Account) => {
    const provider = providers[a.id] ?? a.provider ?? '';
    const secret = secrets[a.id] ?? '';
    if (provider === a.provider && !secret) return;
    setError(null);
    try {
      const saved = await api.patch<Account>(`/accounts/${a.id}`, { ...(provider !== a.provider ? { provider } : {}), ...(secret ? { secret } : {}) });
      setAccounts((current) => current?.map((account) => account.id === a.id ? saved : account) ?? current);
      if (provider !== a.provider) setProviders((current) => current[a.id] === provider ? { ...current, [a.id]: saved.provider ?? '' } : current);
      if (secret) setSecrets((current) => current[a.id] === secret ? { ...current, [a.id]: '' } : current);
      p.onAccountsChanged?.();
    } catch (e) { setError((e as Error).message); }
  };
  const start = async (a: Account) => {
    setError(null); setVerifiedId(null); setCopied(false);
    try {
      let state: Login;
      try { state = await api.post<Login>(`/accounts/${a.id}/login`); }
      catch (e) {
        if ((e as { status?: number }).status !== 409) throw e;
        state = await api.get<Login>(`/accounts/${a.id}/login`, { fresh: true });
      }
      setLogin(state.state === 'idle' ? null : { id: a.id, state });
      if (state.state !== 'pending' && state.state !== 'idle') { await load(); p.onAccountsChanged?.(); }
    } catch (e) { setError((e as Error).message); }
  };
  const copyCode = async (code: string) => {
    setError(null); setCopied(false);
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Could not copy code.'); }
  };
  const verify = async (a: Account) => {
    setError(null); setVerifiedId(null); setVerifyingId(a.id);
    try { const r = await api.post<{ ok: boolean; error?: string }>(`/accounts/${a.id}/verify`); if (!r.ok) setError(r.error ?? 'Verification failed'); else { setVerifiedId(a.id); await load(); p.onAccountsChanged?.(); } } catch (e) { setError((e as Error).message); } finally { setVerifyingId(null); }
  };
  const remove = async (a: Account) => { if (!window.confirm(`Remove account ${a.name}?`)) return; setError(null); setVerifiedId(null); try { await api.delete(`/accounts/${a.id}`); if (login?.id === a.id) setLogin(null); await load(); p.onAccountsChanged?.(); } catch (e) { setError((e as Error).message); } };
  const submitCode = async (e: React.FormEvent) => { e.preventDefault(); if (!login) return; const code = loginSecret; setLoginSecret(''); try { const state = await api.post<Login>(`/accounts/${login.id}/login/code`, { code }); setLogin({ id: login.id, state }); if (state.state !== 'pending') { await load(); p.onAccountsChanged?.(); } } catch (e) { setError((e as Error).message); } };
  return <section className="accounts-settings" id="accounts">
    <h2>Accounts</h2>
    <p className="muted">An account keeps credentials separate from this machine's login.</p>
    {/* A failed load stops the shimmer: the warning below stands in for the rows rather than invented ones. */}
    <Loading loading={accounts === null && error === null} label="Loading the accounts…" placeholder={<RowsPlaceholder />}>
    <>{(accounts ?? []).map((a) => <div className="account-row" key={a.id}>
      <div className="account-meta"><strong>{a.name}</strong>{a.label && <> <span className="chip">{a.label}</span></>} <span className="muted">{a.harness} · {kindLabel(a)}</span><div className="muted">{status(a)}</div>{/* The usage line lands after its row; a read that failed records null and stops this shimmer rather than leaving one standing in an arrived row. */}
        <Loading loading={hasUsage(a) && usage[a.id] === undefined} label={`Loading usage for ${a.name}…`} placeholder={<UsagePlaceholder />}><>{usage[a.id] && <Usage usage={usage[a.id]!} />}</></Loading></div>
      <div className="account-label"><input aria-label={`Label for ${a.name}`} placeholder="Label" value={labels[a.id] ?? a.label ?? ''} onChange={(e) => setLabels((current) => ({ ...current, [a.id]: e.target.value }))} onBlur={() => void saveLabel(a)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        {a.harness === 'opencode' && <div className="account-key-fields"><select aria-label={`Provider for ${a.name}`} value={providers[a.id] ?? a.provider ?? ''} onChange={(e) => setProviders((current) => ({ ...current, [a.id]: e.target.value }))} onBlur={() => void saveOpenCode(a)}><option value="" disabled>Provider</option>{OPENCODE_PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select><input aria-label={`API key for ${a.name}`} placeholder="API key" type="password" value={secrets[a.id] ?? ''} onChange={(e) => setSecrets((current) => ({ ...current, [a.id]: e.target.value }))} onBlur={() => void saveOpenCode(a)} /></div>}</div>
      <div className="account-actions">{a.kind !== 'api_key' ? <button type="button" onClick={() => void start(a)}>Log in</button> : <span className="account-login-slot" aria-hidden="true" />}<button type="button" disabled={verifyingId === a.id} onClick={() => void verify(a)}>{verifyingId === a.id ? 'Verifying…' : 'Verify'}</button><button type="button" onClick={() => void remove(a)}>Remove</button>{verifiedId === a.id && <span className="muted" role="status">Verified</span>}</div>
    </div>)}</>
    </Loading>
    {login && <div className="account-login">
      {login.state.state === 'pending' && <>
        {login.state.code && <div className="login-code"><code>{login.state.code}</code>{navigator.clipboard && <button type="button" onClick={() => void copyCode(login.state.code!)}>{copied ? 'Copied' : 'Copy'}</button>}</div>}
        {login.state.url && <a className="account-login-url" href={login.state.url} target="_blank" rel="noreferrer">{accounts?.find((a) => a.id === login.id)?.kind === 'oauth_token' ? 'Open Claude authorization' : login.state.url}</a>}
        {login.state.code && <p>Open the link on any device, enter the code, approve.</p>}
        {login.state.instructions && !login.state.code && <p>{login.state.instructions}</p>}
        {accounts?.find((a) => a.id === login.id)?.kind === 'oauth_token' && <form onSubmit={submitCode}><label>Authorization code or setup token<input aria-label="Authorization code or setup token" type="password" value={loginSecret} onChange={(e) => setLoginSecret(e.target.value)} /></label><button>Submit</button></form>}
        <button type="button" onClick={() => void api.delete(`/accounts/${login.id}/login`).then(() => setLogin(null)).catch((e: Error) => setError(e.message))}>Cancel</button>
      </>}
      {login.state.state === 'done' && <p role="status">Logged in</p>}
      {login.state.state === 'failed' && <p className="badge-warn">{login.state.error}</p>}
    </div>}
    <form className="account-add" onSubmit={add}>
      <h3>Add account</h3><label>Name<input aria-label="Account name" value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Label<input aria-label="Account label" placeholder="e.g. Work, personal" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>Harness<select aria-label="Account harness" value={harness} onChange={(e) => { const next = e.target.value as typeof harness; setHarness(next); setKind(next === 'claude' ? 'oauth_token' : next === 'codex' ? 'codex_home' : 'api_key'); }}><option value="claude">claude</option><option value="codex">codex</option><option value="opencode">opencode</option></select></label>
      <label>Kind<select aria-label="Account kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={harness !== 'claude'}>{harness === 'claude' ? <><option value="oauth_token">OAuth / setup-token</option><option value="api_key">API key</option></> : harness === 'codex' ? <option value="codex_home">device login</option> : <option value="api_key">API key</option>}</select></label>
      {harness === 'opencode' && <label>Provider<select aria-label="OpenCode provider" value={provider} onChange={(e) => setProvider(e.target.value)} required><option value="">Select provider</option>{OPENCODE_PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>}
      {kind === 'api_key' && <label>API key<input aria-label="API key" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required /></label>}
      <button>Add account</button>
    </form>
    {error && <p className="badge-warn" role="alert">{error}</p>}
  </section>;
}
