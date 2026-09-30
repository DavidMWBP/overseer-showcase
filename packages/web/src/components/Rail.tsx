import { useEffect, useState } from 'react';
import type { CostsResponse, DaemonStatus, OrchestratorActivity, Repo, StatusResponse } from '@overseer/shared';
import { fmtCostTotal } from '../api';
import { Loading } from './Loading';
import { Mascot } from './Mascot';
import { mascotFor } from '../lib/mascotFor';
import { usePhoneLayout } from '../lib/phoneLayout';

/**
 * The widest cost a chip can hold, so the reserve does not change when the value lands: `≥ $999999.99` is a six-figure
 * total at the `≥` marker and `cost unknown` is the longest of `fmtCostTotal`'s wordings, both twelve characters in the
 * mono face, so the placeholder reserves the wider chip and not the `$0.00` that would make it grow.
 */
const COST_RESERVE = '≥ $999999.99';

// `plan` is a page opened from the Office strip or Plans list; it has no tab of its own. Usage, Discussions and Evidence are desktop-only.
export type View = 'board' | 'office' | 'chat' | 'review' | 'setup' | 'plan' | 'usage' | 'discussions' | 'evidence';
export interface RailCounts { running: number; questions: number; failed: number; review: number; reviewWaiting: number }

export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [startedAt]);
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  // aria-hidden: the rail's live region is mounted on every view, and a per-second counter inside it would announce a clock
  // every second for the whole turn.
  return <span className="rail-status-elapsed" aria-hidden="true" title="elapsed in this turn">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

export function Rail(p: { repos: Repo[] | null; status: StatusResponse | null; daemon?: DaemonStatus | null; costs: CostsResponse | null; counts: RailCounts; view: View; onView: (v: View, target?: { section: 'daemon' }) => void; onRepo: (id: string) => void; setupAlert: boolean; onNewSession: () => void; activity?: OrchestratorActivity | null; pendingQuestion?: boolean; offline?: boolean; /** Has a fetch the rail waits on failed? `offline` alone does not stop a shimmer after a 500, so the shell's per-path check gates the cost reserve too. */ loadFailed?: (paths: string[]) => boolean }) {
  const repos = p.repos ?? [];
  const views: { v: View; label: string; count: number; what: string }[] = [
    // Office is the default and first on the phone tab bar.
    { v: 'office', label: 'Office', count: 0, what: '' },
    { v: 'board', label: 'Board', count: p.counts.running, what: p.counts.running === 1 ? 'worker running' : 'workers running' },
    { v: 'chat', label: 'Chat', count: p.counts.questions, what: p.counts.questions === 1 ? 'question waiting for your answer' : 'questions waiting for your answer' },
    // The visible number counts batches ready for the user; the accessible name and tooltip also mention held batches.
    { v: 'review', label: 'Review', count: p.counts.review, what: 'ready for review' },
    // Desktop only (`.rail-views [data-view="usage"]` is display:none in the phone layout); Setup → General links to it on phones.
    { v: 'usage', label: 'Usage', count: 0, what: '' },
    // Desktop only too; Setup → General links to it on phones (`.rail-views [data-view="discussions"]`).
    { v: 'discussions', label: 'Discussions', count: 0, what: '' },
    // Desktop only; Setup → General carries the phone link because the tab bar has room for five entries.
    { v: 'evidence', label: 'Evidence', count: 0, what: '' },
    { v: 'setup', label: 'Setup', count: 0, what: '' },
  ];
  const orch = p.status?.orchestrator;
  const [now, setNow] = useState(() => Date.now());
  const phone = usePhoneLayout();
  useEffect(() => {
    setNow(Date.now());
    if (p.offline) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [p.offline]);
  // The repo chips arrive with the repo list; only their cost waits on /costs. Keep the arrived chip and shimmer the value,
  // as Setup does for each account's usage line, and stop once that fetch has failed rather than reserving through an outage.
  const costsLoading = p.costs === null && !p.offline && !p.loadFailed?.(['/costs']);
  const costOf = (id: string): { text: string; title?: string } => { const c = p.costs?.repos.find((r) => r.repo_id === id); return c ? fmtCostTotal(c.total, c.unknown) : { text: '' }; };
  const context = orch?.context;
  const mascot = mascotFor({ activity: p.activity ?? null, contextPercentage: context ? Math.round(context.tokens / context.window * 100) : null, lastActivityAt: orch?.last_activity_at ?? null, pendingQuestion: p.pendingQuestion ?? false, sessionLive: orch?.native_session_id != null || p.activity != null, sessionStatus: orch?.status, offline: p.offline ?? false }, now);
  return (
    <div className="rail">
      <h1>Overseer</h1>
      {/* Below the phone breakpoint (styles.css) this nav is the fixed bottom tab bar and the rest of the rail becomes a header row above main; the markup is the same. */}
      <nav className="rail-views" aria-label="Views">
        {views.map(({ v, label, count, what }) => {
          // The visible text stays the label and the badge; the accessible name carries the counts ("Board, 2 workers running, 1 verification failed")
          // so a screen reader hears them: an aria-label on the dot's span alone is not exposed by most assistive technology.
          const waiting = v === 'review' ? p.counts.reviewWaiting : 0;
          const parts = [
            count > 0 || waiting > 0 ? `${count} ${what}` : null,
            waiting > 0 ? `${waiting} waiting` : null,
            v === 'board' && p.counts.failed > 0 ? `${p.counts.failed} ${p.counts.failed === 1 ? 'verification' : 'verifications'} failed` : null,
          ].filter((x): x is string => x !== null);
          return (
          <button key={v} data-view={v} className={v === p.view ? 'active' : ''} aria-current={v === p.view ? 'page' : undefined} onClick={() => p.onView(v)} title={parts.length ? parts.join(', ') : undefined} aria-label={parts.length ? `${label}, ${parts.join(', ')}` : undefined}>
            {/* The badge sits inside the label span so the phone rules can pin it to the label's top-right corner; on desktop it is pushed to the row's right end. */}
            <span className="rail-label">
              {label}
              {v === 'discussions' && <span className="experimental-tag">Experimental</span>}
              {v === 'setup' && p.setupAlert && <span className="dot-warn" aria-label="setup needs attention" />}
              {/* A failed verification is the one Board state that needs the user; the dot follows the Setup alert's pattern. */}
              {v === 'board' && p.counts.failed > 0 && <span className="dot-warn" />}
              {count > 0 && <span className={`count count-${v}`} aria-hidden="true">{count}</span>}
            </span>
          </button>
          );
        })}
      </nav>
      <div className="rail-context">
      <h2>Repos</h2>
      <ul>{repos.map((r) => { const cost = costOf(r.id); return (
        <li key={r.id}><button className="rail-repo" title={r.path} onClick={() => p.onRepo(r.id)}><span>{r.id}</span>
          <Loading loading={costsLoading} label={`Loading the cost for ${r.id}…`} placeholder={<span className="mono">{COST_RESERVE}</span>}>
            <span className="mono" title={cost.title}>{cost.text}</span>
          </Loading>
        </button></li>
      ); })}</ul>
      <div className="rail-status">
        <div className="rail-status-live" role="status" aria-live="polite">
          <Mascot state={mascot.state} energy={mascot.energy} size={phone ? 32 : 64} label={mascot.label} />
          {!phone && !p.offline && p.activity && p.activity.state !== 'idle' && <Elapsed startedAt={p.activity.started_at} />}
        </div>
        {!p.offline && orch?.context && <div className="rail-status-metadata" title={`Context used by the orchestrator's last request: ${orch.context.tokens.toLocaleString()} of ${orch.context.window.toLocaleString()} tokens`}>context {Math.round((orch.context.tokens / orch.context.window) * 100)}%</div>}
        {!p.offline && orch?.last_activity_at && <div className="rail-status-metadata">last active {relTime(orch.last_activity_at, now)}</div>}
        {!p.offline && p.daemon?.restart_needed && <button className="daemon-restart-needed badge-warn" onClick={() => p.onView('setup', { section: 'daemon' })}>Restart needed</button>}
        <button onClick={p.onNewSession} title="Ends the current orchestrator session; the next message starts a fresh one with no memory of this thread. Batches and tasks are unaffected.">New session</button>
        {p.status && !p.status.bd_ok && <div className="badge-warn">bd unavailable</div>}
      </div>
      </div>
    </div>
  );
}
