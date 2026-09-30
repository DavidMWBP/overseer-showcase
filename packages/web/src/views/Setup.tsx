import { useEffect, useRef, useState } from 'react';
import type { Account, DaemonStatus, DeleteRepoResponse, DoctorResponse, PreflightReport, PreflightRun, Repo } from '@overseer/shared';
import { api, ApiError } from '../api';
import { RepoForm } from '../components/RepoForm';
import { PlainText } from '../components/PlainText';
import { ModelsSettings } from '../components/ModelsSettings';
import { PushSettings } from '../components/PushSettings';
import { AccountsSettings } from '../components/AccountsSettings';
import { Loading } from '../components/Loading';

export function doctorAlert(d: DoctorResponse | null): boolean {
  return d !== null && (d.tools.some((t) => t.required && !t.ok) || !d.data_dir.ok);
}

/** The Setup sub-navigation: one section visible at a time, General first. The choice lives in sessionStorage so Board and back returns to it. */
export const SETUP_SECTIONS = [
  { key: 'general', label: 'General' },
  { key: 'models', label: 'Models' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'repositories', label: 'Repositories' },
] as const;
export type SetupSection = typeof SETUP_SECTIONS[number]['key'];
const SECTION_KEY = 'overseer.setupSection';
const isSection = (v: unknown): v is SetupSection => SETUP_SECTIONS.some((s) => s.key === v);
const readSection = (): SetupSection => { try { const v = sessionStorage.getItem(SECTION_KEY); return isSection(v) ? v : 'general'; } catch { return 'general'; } };

function RepoFilterSummary(p: { filter: NonNullable<Repo['model_filter']> }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  useEffect(() => {
    if (!p.filter.accounts.length) return;
    let cancelled = false;
    void api.get<Account[]>('/accounts').then((rows) => { if (!cancelled) setAccounts(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [p.filter]);
  const parts = [
    ...p.filter.harnesses,
    ...p.filter.models.map((model) => model || 'CLI default'),
    ...p.filter.accounts.map((id) => accounts?.find((account) => account.id === id)?.name ?? (accounts ? `Deleted account (${id})` : id)),
  ];
  return <span className="repo-filter-summary muted">{parts.join(' · ')}</span>;
}

const restartConfirm = 'Restart the daemon now? The orchestrator chat session ends (a new one starts on your next message) and running workers continue and are re-adopted. The page reconnects by itself.';
export const RESTART_POLL_TIMEOUT_MS = 6 * 60_000;

function DaemonSection(p: { refreshKey?: number }) {
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const load = async () => {
    const next = await api.get<DaemonStatus>('/daemon', { fresh: true });
    setDaemon(next);
    return next;
  };
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [p.refreshKey]);
  const restart = async () => {
    if (!daemon || !confirm(restartConfirm)) return;
    setError(null); setStatus('Restarting…'); setRestarting(true);
    const oldPid = daemon.pid;
    try {
      await api.post('/daemon/restart');
      const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        try {
          const next = await load();
          if (next.pid !== oldPid) {
            setStatus(`Daemon restarted (pid ${next.pid}, commit ${next.commit ?? 'unknown'})`);
            setRestarting(false);
            return;
          }
          if (!next.restart_in_progress && next.restart_failure) {
            setStatus(null);
            setRestarting(false);
            return;
          }
        } catch { /* expected while the daemon re-execs */ }
      }
      throw new Error('Timed out waiting for the daemon to restart.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
      setRestarting(false);
    }
  };
  return <section id="daemon" tabIndex={-1}>
    <h2>Daemon <button onClick={() => void restart()} disabled={restarting || daemon === null}>Restart daemon</button></h2>
    {/* The running-since line is the whole arrived body of this section; a failed fetch has its own line below, so the shimmer stops then.
        The restart-needed banner underneath is deliberately not reserved: it is the exception (this daemon reports restart_needed
        false most of the time, where reserving it would overshoot by its own ~37 px), and #daemon is the last block in General, so
        the banner landing shifts nothing below it. Measured: 74 px unloaded, 106 px arrived without the banner, 143 px with it. */}
    <Loading loading={daemon === null && error === null} label="Loading the daemon status…" placeholder={<p className="muted" aria-hidden="true">Running since 12/09/2026, 10:00:00 (pid 12345), commit abc1234</p>}>
      {daemon && <p className="muted" role="status">Running since {new Date(daemon.started_at).toLocaleString()} (pid {daemon.pid}), commit {daemon.commit ?? 'unknown'}</p>}
    </Loading>
    {daemon?.restart_needed && <p className="badge-warn">main is at {daemon.source_head}; the daemon runs {daemon.commit}. Restart to pick up the change.</p>}
    {daemon?.restart_failure && !daemon.restart_in_progress && !restarting && <>
      <p className="badge-warn" role="alert">Restart failed: {daemon.restart_failure.reason}</p>
      {daemon.restart_failure.output.length > 0 && <pre aria-label="Restart output">{daemon.restart_failure.output.join('\n')}</pre>}
    </>}
    {status && <p className="muted" role="status">{status}</p>}
    {error && <p className="badge-warn" role="alert">{error}</p>}
  </section>;
}

const probeWord = (r?: PreflightRun) =>
  !r ? 'probe: —'
    : r.result === 'pass' ? 'probe: pass'
    : r.result === 'fail' ? `probe: fails (exit ${r.exit_code})`
    : r.result === 'timeout' ? 'probe: timed out'
    : r.result === 'error' ? 'probe: could not run'
    : 'probe: running';

/**
 * The last verify probe on the repo's base branch, and a way to re-run it. Fetched on mount and whenever the repo row itself
 * changes identity, which happens when the shell reloads `/api/repos` on the `repos` socket message it already listens to
 * (fired whenever a probe finishes) — a second socket connection here would only duplicate that.
 */
function ProbeStatus({ repo }: { repo: Repo }) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState(false);
  // A repo the daemon does not yet have preflight data for (or a fetch error) shows the same '—' as no runs; nothing here is fatal to the rest of the row.
  useEffect(() => { void api.get<PreflightReport>(`/repos/${repo.id}/preflight`, { fresh: true }).then(setReport).catch(() => {}); }, [repo]);
  const reprobe = async () => {
    setBusy(true);
    try { await api.post(`/repos/${repo.id}/probe`); } finally { setBusy(false); }
  };
  const crashes = report?.crashes.reduce((n, c) => n + c.count, 0) ?? 0;
  return (
    <>
      <span>{probeWord(report?.runs[0])}</span>
      {crashes > 0 && <span> crashes: {crashes}</span>}
      {' '}
      <button type="button" onClick={() => void reprobe()} disabled={busy}>Re-probe</button>
    </>
  );
}

/**
 * The doctor answer has a fixed shape: one row per tool in the daemon's own TOOLS list (git, bd, claude, codex, opencode,
 * glab), then the data dir. The values below are placeholders, but the row count and the fix blocks are the ones the table
 * arrives with on a machine that has the required tools and not every optional one.
 */
function DoctorPlaceholder() {
  const rows = [
    { name: 'git', required: 'required', value: 'git version 2.45.0', fix: null },
    { name: 'bd', required: 'required', value: 'bd version 1.2.2', fix: null },
    { name: 'claude', required: 'required', value: '2.1.269', fix: 'Run `claude` once in a terminal to log in if you have not yet.' },
    { name: 'codex', required: 'optional', value: 'not found', fix: 'npm install -g @openai/codex\nThen run `codex login`.' },
    { name: 'opencode', required: 'optional', value: '1.0.0', fix: null },
    { name: 'glab', required: 'optional', value: 'not found', fix: 'Install glab (https://gitlab.com/gitlab-org/cli) and run `glab auth login`.' },
  ];
  return (
    <table className="doctor" aria-hidden="true">
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td><td>{r.required}</td><td>{r.value}</td>
            <td className="breakable">{r.fix && <pre className="fix">{r.fix}</pre>}</td>
          </tr>
        ))}
        <tr><td>data dir</td><td>required</td><td className="breakable">C:/Users/me/.overseer</td><td className="breakable" /></tr>
      </tbody>
    </table>
  );
}

/**
 * Two rows: the arrived length is unknown before the fetch, and two is the count a working install settles at — the repository
 * being worked on plus Overseer's own checkout, which is how the lessons flow registers it.
 */
function ReposPlaceholder() {
  const rows = [
    { id: 'overseer', path: 'E:/Projects/overseer', verify: 'pnpm test' },
    { id: 'demo', path: 'E:/Projects/demo', verify: 'pnpm test' },
  ];
  return (
    <div aria-hidden="true">
      <table className="repos">
        <thead><tr><th>id</th><th>path</th><th>base</th><th>merge</th><th>approver</th><th>workers</th><th>verify</th><th>setup</th><th>probe</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="breakable">{r.id}</td><td className="breakable" data-label="path">{r.path}</td><td data-label="base">main</td><td data-label="merge">local-merge</td><td data-label="approver">user</td><td data-label="workers">2</td><td className="breakable" data-label="verify">{r.verify}</td><td className="breakable" data-label="setup" /><td>probe: pass <button type="button" tabIndex={-1}>Re-probe</button></td>
              <td><button type="button" tabIndex={-1}>Edit</button> <button type="button" tabIndex={-1}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Setup(p: { repos: Repo[] | null; doctor: DoctorResponse | null; /** Per repo, the batches that are not finished, by status: named with their real status words in the confirm (round 14). */ unfinishedBatches?: Record<string, { open: number; review: number }>; /** Opens the Usage view. It is the phone's way in: the tab bar has no room for a sixth tab, so the rail entry is desktop-only. */ onOpenUsage?: () => void; onRefreshDoctor: () => void; onReposChanged: () => void | Promise<unknown>; /** A repo was removed: the app drops anything it still had selected under it. */ onRemoved?: (id: string) => void; /** The view the URL asked for, which an install with no repositories cannot show: this view opened instead and says so (round 21 nit). */ sentFrom?: string | null; daemonRefreshKey?: number; target?: SetupSection | 'daemon' | null; onTargeted?: () => void; /** Opens the Discussions view; Discussion is desktop-only and phones reach it from here. */ onOpenDiscussions?: () => void; /** Opens the Evidence view; Evidence is desktop-only and phones reach it from here. */ onOpenEvidence?: () => void; /** The daemon is unreachable: an unloaded section shows its plain state instead of shimmering content that never arrived. */ offline?: boolean; /** Has a fetch this section waits on failed? The shell's per-path check, which also covers the offline case: a 500 the daemon answered leaves it reachable, so `offline` alone does not stop a shimmer. */ loadFailed?: (paths: string[]) => boolean }) {
  const repos = p.repos ?? [];
  const setupRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // The Add form sits behind a button once a repository exists; a fresh install shows it at once, since there is nothing else to do here.
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [restoreAddFocus, setRestoreAddFocus] = useState(false);
  // Unloaded is not "no repositories": the cold load must not flash the Add form before /api/repos answers.
  const showAdd = p.repos !== null && editing === null && (adding || repos.length === 0);
  useEffect(() => { if (adding && showAdd) addRef.current?.querySelector('input')?.focus(); }, [adding, showAdd]);
  useEffect(() => { if (restoreAddFocus && !showAdd) { addButtonRef.current?.focus(); setRestoreAddFocus(false); } }, [restoreAddFocus, showAdd]);
  const closeAdd = () => { setAdding(false); setRestoreAddFocus(true); };
  const [error, setError] = useState<string | null>(null);
  // Save and Remove otherwise end without a word (the form turns back into a row, a row vanishes); one line, replaced by the next action.
  const [notice, setNotice] = useState<string | null>(null);
  const [section, setSection] = useState<SetupSection>(readSection);
  const select = (next: SetupSection) => { setSection(next); try { sessionStorage.setItem(SECTION_KEY, next); } catch { /* storage unavailable */ } };
  // The user's own pick supersedes a pending target: released here, so the next "Restart needed" click is a new target, not a bail-out.
  const pick = (next: SetupSection) => { select(next); if (p.target && !(p.target === 'daemon' && next === 'general')) p.onTargeted?.(); };

  // "Add one below and it works": the view that needs a repository sends the user to the section holding the Add form.
  useEffect(() => { if (p.sentFrom) select('repositories'); }, [p.sentFrom]);

  useEffect(() => {
    if (p.target === 'daemon') select('general');
    else if (p.target) { select(p.target); p.onTargeted?.(); } // applied at once; the daemon target is released by the scroll effect below
  }, [p.target]);

  useEffect(() => {
    if (p.target !== 'daemon' || section !== 'general') return;
    const setup = setupRef.current;
    const daemon = setup?.querySelector<HTMLElement>('#daemon');
    if (!setup || !daemon) return;
    const behavior = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const scroll = () => daemon.scrollIntoView?.({ block: 'start', behavior });
    scroll();
    daemon.focus({ preventScroll: true });

    if (typeof ResizeObserver !== 'function') {
      p.onTargeted?.();
      return;
    }
    // Settings above this section expand after their fetches finish. Re-anchor while that layout settles.
    const observer = new ResizeObserver(scroll);
    observer.observe(setup);
    const timer = window.setTimeout(() => {
      observer.disconnect();
      p.onTargeted?.();
    }, 2_000);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, [p.target, p.onTargeted, section]);

  const remove = async (r: Repo) => {
    const { open = 0, review = 0 } = p.unfinishedBatches?.[r.id] ?? {};
    const n = open + review;
    // The branches are never deleted here: a batch in review or an open bead may hold commits that landed nowhere else (round 8).
    const which = open && review ? `unfinished (${open} in progress, ${review} in review)` : review ? 'in review' : 'in progress';
    const unmerged = n > 0 ? ` ${n === 1 ? '1 batch is' : `${n} batches are`} still ${which}; ${n === 1 ? 'its branch stays' : 'their branches stay'} in the repo.` : '';
    if (!confirm(`Remove ${r.id} from Overseer?\n\nDeleted: Overseer's worktrees for it and its batch and task records.\nKept: the repository, its beads data, and every feature/* and bead/* branch.${unmerged}`)) return;
    setError(null); setNotice(null);
    try {
      const res = await api.delete<DeleteRepoResponse>(`/repos/${r.id}`);
      await p.onReposChanged();
      p.onRemoved?.(r.id);
      setNotice(`Removed ${r.id}.${res.kept_branches.length > 0 ? ` Branches kept in the repository: ${res.kept_branches.join(', ')}.` : ''}${res.warnings.length > 0 ? ` Could not remove: ${res.warnings.join('; ')}.` : ''}`);
    } catch (e) {
      const err = e as ApiError;
      const sessions = (err.body as { sessions?: string[] } | null)?.sessions;
      setError(sessions?.length ? `${err.message}: ${sessions.join(', ')}` : err.message);
    }
  };

  const d = p.doctor;
  return (
    <div className="setup" ref={setupRef}>
      {p.sentFrom && <p className="muted" role="status">{`${p.sentFrom} needs a repository, so Setup opened instead. Add one below and it works.`}</p>}
      <div className="setup-body">
        <nav className="setup-nav" role="tablist" aria-label="Setup sections" aria-orientation="vertical">
          {SETUP_SECTIONS.map((s) => (
            <button key={s.key} role="tab" aria-selected={s.key === section} className={s.key === section ? 'active' : ''} onClick={() => pick(s.key)}>{s.label}</button>
          ))}
        </nav>
        <div className="setup-content">
          {section === 'general' && <>
            <p className="setup-office-link">Put one question to several models on the <button className="link" onClick={p.onOpenDiscussions}>Discussions</button> <span className="experimental-tag">Experimental</span> page. Worker screenshots and captures are on the <button className="link" onClick={p.onOpenEvidence}>Evidence</button> page.</p>
            <section>
              <h2>Prerequisites <button onClick={p.onRefreshDoctor}>Refresh</button></h2>
              {/* The doctor table is the section's whole body; a fetch that failed — unreachable or answered with an error — falls back to the plain line rather than shimmering a table that never arrives. */}
              <Loading loading={!d && !p.offline && !p.loadFailed?.(['/doctor'])} label="Checking prerequisites…" placeholder={<DoctorPlaceholder />}>
              {!d ? <div className="muted">checking…</div> : (
                <table className="doctor">
                  <tbody>
                    {d.tools.map((t) => (
                      <tr key={t.name} className={t.ok ? '' : t.required ? 'row-bad' : 'row-warn'}>
                        <td>{t.name}</td>
                        <td>{t.required ? 'required' : 'optional'}</td>
                        <td>{t.ok ? t.version ?? 'ok' : 'not found'}</td>
                        <td className="breakable">{t.fix && <pre className="fix"><PlainText text={t.fix} /></pre>}</td>
                      </tr>
                    ))}
                    <tr className={d.data_dir.ok ? '' : 'row-bad'}>
                      <td>data dir</td><td>required</td><td className="breakable">{d.data_dir.ok ? d.data_dir.path : 'not writable'}</td><td className="breakable">{d.data_dir.problem}</td>
                    </tr>
                  </tbody>
                </table>
              )}
              </Loading>
            </section>
            <section>
              <h2>Usage</h2>
              {/* The rail's Usage entry is hidden in the phone layout (styles.css), so this link is how a phone reaches the view. */}
              <p className="muted">What the sessions cost and how many tokens they used, by day, model, account, harness and repository.</p>
              <button className="usage-link" onClick={p.onOpenUsage}>Open usage</button>
            </section>
            <DaemonSection refreshKey={p.daemonRefreshKey} />
          </>}
          {section === 'models' && <ModelsSettings />}
          {section === 'accounts' && <AccountsSettings />}
          {section === 'notifications' && <PushSettings />}
          {section === 'repositories' && <>
            <section>
              {/* The heading is known before the fetch and stays; only the list below it is reserved. An unloaded list is not an empty one. */}
              {/* The button is present but disabled while the list loads: it is this section's own action, and reserving the real
                  control keeps the heading from growing by its height when the list lands. */}
              <h2>Repositories {(p.repos === null || repos.length > 0) && <button ref={addButtonRef} className="h2-action" onClick={() => { setNotice(null); setAdding(true); }} disabled={p.repos === null || showAdd || editing !== null}>Add repository</button>}</h2>
              <Loading loading={p.repos === null && !p.offline && !p.loadFailed?.(['/repos'])} label="Loading repositories…" placeholder={<ReposPlaceholder />}>
              {p.repos !== null && repos.length === 0 && <div className="muted">No repositories registered yet.</div>}
              {repos.length > 0 && (
                <table className="repos">
                  <thead><tr><th>id</th><th>path</th><th>base</th><th>merge</th><th>approver</th><th>workers</th><th>verify</th><th>setup</th><th>probe</th><th /></tr></thead>
                  <tbody>
                    {repos.map((r) => editing === r.id ? (
                      <tr key={r.id}><td colSpan={10}>
                        {/* A cleared verify command verifies nothing from now on; the notice said the opposite of what the daemon tells the orchestrator (fix round 20 review NB-B). */}
                        <RepoForm mode="edit" repo={r} onDone={async (saved) => {
                            await p.onReposChanged();
                            setEditing(null);
                            const changes = [
                              saved.verify_command !== r.verify_command ? (saved.verify_command ? 'the next verification uses the new verify command' : 'with no verify command, nothing is verified from now on') : null,
                              saved.review_command !== r.review_command ? (saved.review_command ? 'the daemon runs the review command before the next batch review request' : 'the pre-review suite is disabled from now on') : null,
                            ].filter((change): change is string => Boolean(change));
                            if (!changes.length) changes.push(saved.verify_command ? 'the next verification uses the new verify command' : 'with no verify command, nothing is verified from now on');
                            setNotice(`Saved ${r.id}. Running workers keep the settings they started with; ${changes.join('; ')}.`);
                          }} onCancel={() => setEditing(null)} />
                      </td></tr>
                    ) : (
                      <tr key={r.id}>
                        {/* data-label names the cell on phones, where the table stacks and the header row is hidden. */}
                        <td className="breakable">{r.id}{r.model_filter && <RepoFilterSummary filter={r.model_filter} />}</td><td className="breakable" title={r.path} data-label="path">{r.path}</td><td data-label="base">{r.base_branch}</td><td data-label="merge">{r.merge_mode}</td><td data-label="approver">{r.batch_approver}</td><td data-label="workers">{r.worker_limit}</td><td className="breakable" data-label="verify">{r.verify_command ?? ''}</td><td className="breakable" data-label="setup">{r.setup_command ?? ''}</td>
                        {/* No data-label: the cell's own text already says "probe: …", so the phone layout's generated label would double it. */}
                        <td><ProbeStatus repo={r} /></td>
                        <td><button onClick={() => { setNotice(null); setAdding(false); setEditing(r.id); }}>Edit</button> <button onClick={() => void remove(r)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              </Loading>
              {notice && <p className="muted" role="status">{notice}</p>}
              {error && <div className="badge-warn">{error}</div>}
            </section>
            {showAdd && (
              <section ref={addRef}>
                <h2>Add repository</h2>
                <RepoForm mode="add" onDone={async (added) => { await p.onReposChanged(); closeAdd(); setNotice(`Added ${added.id}${added.beads_initialised ? ' and initialised beads in it' : ''}. Ask the orchestrator for work in Chat.`); }} onCancel={repos.length > 0 ? closeAdd : undefined} />
              </section>
            )}
          </>}
        </div>
      </div>
    </div>
  );
}
