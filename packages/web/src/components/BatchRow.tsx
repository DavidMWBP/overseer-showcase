import type { BatchSummary } from '@overseer/shared';
import { fmtCostTotal } from '../api';
import { pendingLabel } from '../lib/actions';
import { useRunningJob } from '../lib/jobs';
import { pressable } from './Card';

/** A batch in review that waits on an overlapping one reads "waiting" (its Merge is disabled until the other leaves review). */
export const batchStatusLabel = (s: BatchSummary['status'], waitingOn: string | null = null) => (s === 'review' ? (waitingOn ? 'waiting' : 'in review') : s === 'open' ? 'in progress' : s);
/** "2/3", or with beads the user closed as won't do named apart ("1 landed, 1 closed of 3"): a closed bead is finished without having landed. */
export const beadsLabel = (b: BatchSummary) => (b.beads_closed ? `${b.beads_done} landed, ${b.beads_closed} closed of ${b.beads_total}` : `${b.beads_done}/${b.beads_total}`);
/** Finished batches shown per repo on the Board and in the Review list; the newest ones, the rest stay in the API. */
export const FINISHED_MAX = 20;

export function BatchRow(p: { batch: BatchSummary; onClick: () => void }) {
  const b = p.batch;
  // The row's running job, unless its result has already arrived: a board sampled before the result is stale about it.
  const running = useRunningJob(b.pending_action);
  const pct = b.beads_total ? ((b.beads_done + b.beads_closed) / b.beads_total) * 100 : 0;
  return (
    <div id={`batch-${b.id}`} className={`batch batch-${b.status}`} {...pressable(p.onClick)}>
      <div><div className="batch-title">{b.title}</div><div className="mono muted">{b.branch} → {b.base_branch}</div></div>
      <div><div className="progress"><div style={{ width: `${pct}%` }} /></div><div className="mono muted">{beadsLabel(b)}</div></div>
      <span className="mono" title={fmtCostTotal(b.cost, b.cost_unknown).title}>{fmtCostTotal(b.cost, b.cost_unknown).text}</span>
      <span className="batch-status"><span className={`chip ${b.status}`}>{batchStatusLabel(b.status, b.waiting_on)}</span>{running && <span className="chip pending">{pendingLabel(running.action)}</span>}</span>
    </div>
  );
}
