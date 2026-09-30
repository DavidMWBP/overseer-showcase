import type { KeyboardEvent } from 'react';
import type { BoardCard } from '@overseer/shared';
import { fmtElapsed } from '../api';
import { pendingLabel } from '../lib/actions';
import { useRunningJob } from '../lib/jobs';

/**
 * A bead this install never dispatched that no batch of it claims: it was in the repository's bd database before Overseer saw it.
 * A repository already using bd otherwise fills Ready and Done with cards Overseer did not make and has no action for (round 19).
 */
export const fromBd = (card: BoardCard) => card.batch_id === null && card.branch === null && card.session_id === null;
/**
 * Such a bead that still carries an `overseer:batch:` label was made by Overseer for a batch this install no longer has: its
 * repository was removed and registered again, or the data directory was reset. Saying it "was already in the bd database"
 * contradicts the History of Overseer's own actions three lines above it (round 21 R21-3).
 */
export const batchGone = (card: BoardCard) => card.bead.labels.some((l) => l.startsWith('overseer:batch:'));
export const FROM_BD_TITLE = "This bead was already in the repository's bd database; no batch in this Overseer install claims it.";
export const BATCH_GONE_TITLE = 'Overseer worked on this bead, but the batch that owned it is gone from its records: the repository was removed and registered again, or the data directory was reset.';
/** Only where there is something to ask for: a closed bead (Done) or one someone else put in review is not work to dispatch (fix round 19 review NB-2). */
export const fromBdTitle = (card: BoardCard) => {
  const what = batchGone(card) ? BATCH_GONE_TITLE : FROM_BD_TITLE;
  return card.column === 'ready' || card.column === 'blocked' ? `${what} Ask the orchestrator in Chat if you want it worked on.` : what;
};

/** Props that make a div behave like a button for mouse and keyboard users (Enter and Space activate it). */
export function pressable(onClick: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } },
  };
}

export function Card(p: { card: BoardCard; selected: boolean; onClick: () => void }) {
  const { card } = p;
  // The card's running job, unless its result has already arrived: a board sampled before the result is stale about it.
  const running = useRunningJob(card.pending_action);
  const abandoned = card.bead.labels.includes('overseer:abandoned');
  const closed = card.bead.labels.includes('overseer:closed'); // closed as won't do by the user: in Done without having landed
  const verified = card.bead.labels.includes('overseer:verified'); // a daemon command passed for a verification-only bead
  const workerReported = card.bead.labels.includes('overseer:worker-reported'); // only the worker reported its passing checks
  const verifyFailed = card.verify_failure !== null && card.column !== 'done';
  // A worker that ended without a commit (or crashed) sends the bead back to Ready; the red rule needs a label as much as a failed verification does.
  // The one Failed pill covers either failure; the pane keeps the last session and verification outcomes distinct.
  const workerFailed = card.session_status === 'failed' && (card.column === 'ready' || card.column === 'blocked');
  // Parked with a critic's open findings: the user decides (Re-dispatch, Close, Land anyway), so the rule is amber, not red.
  const awaiting = card.state === 'awaiting_decision';
  const cls = ['card', workerFailed || verifyFailed ? 'card-failed' : '', awaiting ? 'card-awaiting' : '', abandoned || closed ? 'card-abandoned' : '', p.selected ? 'card-selected' : ''].filter(Boolean).join(' ');
  const stateLabel = () => {
    if (card.state === 'running') return 'Running';
    if (card.state === 'settling') return 'settling…';
    if (card.state === 'verifying' || card.state === 'landed_unclosed') return 'Verifying';
    if (card.state === 'reviewing') return 'Reviewing';
    if (card.state === 'review') return 'Review';
    if (card.state === 'awaiting_decision') return 'Needs you';
    if (verifyFailed || workerFailed) return 'Failed';
    if (card.state === 'blocked') return 'Blocked';
    if (abandoned) return 'Abandoned';
    if (closed) return 'Closed';
    if (verified) return 'Verified';
    if (workerReported) return 'Worker-reported';
    if (card.state === 'done') return 'Done';
    return 'Ready';
  };
  const stateClass = workerFailed || verifyFailed ? 'fail' : awaiting ? 'awaiting' : card.state === 'review' || card.state === 'reviewing' ? 'review' : abandoned || closed ? 'abandoned' : '';
  // A duration on a card that is waiting reads as "running for"; say what it is: the last run's length.
  const waiting = card.column === 'ready' || card.column === 'blocked';
  // BoardCard account fields come from the latest session, which may be a critic while the harness/model remain the last worker's.
  // Show the account only while the latest session is the worker, so the tooltip never pairs a worker model with a critic account.
  const showAccount = card.state === 'running' || card.state === 'verifying';
  const agentTitle = showAccount && card.account_name
    ? `${card.tier ? `tier ${card.tier} · ` : ''}account ${card.account_name}${card.account_label ? ` (${card.account_label})` : ''}`
    : card.tier ?? undefined;
  return (
    <div className={cls} data-bead={card.bead.id} {...pressable(p.onClick)}>
      <div className="card-title-row" data-testid="card-title-row">
        <div className="card-title" title={card.bead.title}>{card.bead.title}</div>
        <span className="mono muted card-id">{card.bead.id}</span>
      </div>
      <div className="card-meta" data-testid="card-meta">
        <span className={`chip ${stateClass}`}>{card.state === 'running' && <span className="card-running-dot" aria-hidden="true" />}{stateLabel()}</span>
        {running && <span className="chip pending">{pendingLabel(running.action)}</span>}
        {card.harness && <span className="chip card-agent" title={agentTitle}>{card.harness}{card.model ? ` · ${card.model}` : ''}</span>}
        {card.elapsed_ms !== null && (waiting || card.state === 'running' || card.state === 'verifying') && <span className={`card-elapsed${waiting ? ' card-last-run' : ''}`}>{waiting ? `last run ${fmtElapsed(card.elapsed_ms)}` : fmtElapsed(card.elapsed_ms)}</span>}
      </div>
    </div>
  );
}
