import { useEffect, useRef, useState } from 'react';
import { effectiveBatchApprover, type BatchDetail, type BatchSummary, type BoardColumn, type BoardResponse } from '@overseer/shared';
import { api } from '../api';
import { usePendingFor, useRunningJobs } from '../lib/jobs';
import { Loading } from '../components/Loading';
import { Diff } from '../components/Diff';
import { batchStatusLabel, beadsLabel } from '../components/BatchRow';
import { BatchReviewBlock } from './BatchReviewBlock';
import { readDraft, writeDraft } from './reviewState';
import { isPhoneLayout } from '../lib/phoneLayout';

const ACK_MS = 60_000;

const COLUMN_LABELS: Record<BoardColumn, string> = {
  ready: 'Ready', blocked: 'Blocked', running: 'Running', verifying: 'Verifying', review: 'Review', done: 'Done',
};

const PLACEHOLDER_DIFF = [
  'diff --git a/src/placeholder.ts b/src/placeholder.ts',
  '--- a/src/placeholder.ts',
  '+++ b/src/placeholder.ts',
  '@@ -1 +1,2 @@',
  ' const first = 1;',
  '+const second = 2;',
  'diff --git a/src/other.ts b/src/other.ts',
  '--- /dev/null',
  '+++ b/src/other.ts',
  '@@ -0,0 +1 @@',
  '+const next = 2;',
].join('\n');

function BatchReviewPlaceholder({ batch, repoId, mergeMode, approver, batches }: { batch: BatchSummary; repoId: string; mergeMode: 'local-merge' | 'gitlab-mr'; approver: string; batches: BatchSummary[] }) {
  const waiting = batch.waiting_on ? batches.find((x) => x.id === batch.waiting_on) : null;
  return <>
    {approver === 'orchestrator' && <p className="muted">The orchestrator merges {repoId}'s batches on its own; it will merge this one without waiting for you. Merge and Reject stay available.</p>}
    <h4>Summary from the orchestrator</h4>
    <div className="pre review-note">The orchestrator's summary of this round appears here once the batch loads.</div>
    {batch.history && <details className="review-history"><summary>Earlier rounds</summary><div className="pre review-note">Earlier summaries appear here once the batch loads.</div></details>}
    {batch.waiting_on && <div className="banner-warn">Waiting on {waiting?.title ?? batch.waiting_on}: both change {(batch.overlap_files ?? []).join(', ')}. Merge is available once that batch is merged, rejected or abandoned.</div>}
    {batch.conflict_files && batch.conflict_files.length > 0 && <div className="banner-warn">{batch.refresh_from ? `The refresh from ${batch.base_branch} conflicted in: ${batch.conflict_files.join(', ')}` : `Last merge into ${batch.base_branch} conflicted in: ${batch.conflict_files.join(', ')}`}. Reject with a note and the orchestrator adds a merge bead.</div>}
    <div className="review-actions">
      {mergeMode === 'gitlab-mr' && batch.mr_url && <a href={batch.mr_url} target="_blank" rel="noreferrer">Open merge request</a>}
      <button className="primary" disabled>{mergeMode === 'local-merge' ? 'Merge' : 'Mark merged'}</button>
      <textarea rows={2} disabled placeholder="Why? (required to reject)" aria-label="Rejection note" />
      <button disabled>Reject</button>
      <button className="danger" disabled>Abandon</button>
    </div>
    <h4>Diff against {batch.base_branch}</h4>
    <Diff diff={PLACEHOLDER_DIFF} />
  </>;
}

export function BatchPane(p: {
  id: string;
  board: BoardResponse | null;
  version?: number;
  offline?: boolean;
  /** True while this batch detail path has not failed in the shell. */
  loading?: boolean;
  onFetchState?: (path: string, failed: boolean) => void;
  onClose: () => void;
  onSelect: (beadId: string) => void;
  onOpenReview: (batchId: string) => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const closeRef = useRef(p.onClose);
  const fetchStateRef = useRef(p.onFetchState);
  closeRef.current = p.onClose;
  fetchStateRef.current = p.onFetchState;
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [note, setNote] = useState(() => readDraft(p.id));
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const [ackSeq, setAckSeq] = useState(0);
  const [resultStatus, setResultStatus] = useState<{ id: string; status: BatchSummary['status'] } | null>(null);
  const ackJob = useRef<string | null>(null);
  const ackWatch = useRef<{ id: string; expect: BatchSummary['status']; seen: boolean } | null>(null);
  const resultWatch = useRef<{ id: string; expect: BatchSummary['status']; seen: boolean } | null>(null);
  const entry = p.board?.repos.find((r) => r.batches.some((b) => b.id === p.id));
  const batches = p.board?.repos.flatMap((r) => r.batches) ?? [];
  const boardBatch = entry?.batches.find((b) => b.id === p.id) ?? null;
  const batch = boardBatch && resultStatus?.id === boardBatch.id ? { ...boardBatch, status: resultStatus.status } : boardBatch;
  const cards = p.board?.repos.flatMap((r) => r.cards).filter((card) => card.batch_id === p.id) ?? [];
  const matchingDetail = detail?.batch.id === p.id ? detail : null;
  const detailFailure = batch?.status === 'review' && (detailFailed || !!p.offline || p.loading === false);
  const reviewDetail = matchingDetail && batch ? {
    ...matchingDetail,
    batch: { ...matchingDetail.batch, ...batch, note: batch.note ?? matchingDetail.batch.note, history: batch.history ?? matchingDetail.batch.history },
  } : matchingDetail;

  useEffect(() => {
    if (batch?.status !== 'review') {
      setDetailFailed(false);
      return;
    }
    const path = `/batches/${p.id}`;
    let cancelled = false;
    setDetailFailed(false);
    fetchStateRef.current?.(path, false);
    void api.get<BatchDetail>(path, { fresh: true })
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setDetailFailed(false);
        fetchStateRef.current?.(path, false);
      })
      .catch(() => {
        if (cancelled) return;
        setDetailFailed(true);
        fetchStateRef.current?.(path, true);
      });
    return () => { cancelled = true; };
  }, [p.id, p.version, retry, batch?.status]);

  useEffect(() => {
    if (!pane.current) return;
    const stacked = isPhoneLayout();
    pane.current.scrollIntoView?.({ block: stacked ? 'start' : 'nearest' });
    pane.current.scrollTop = 0;
    pane.current.focus({ preventScroll: true });
  }, [p.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pane.current?.querySelector('.close-confirm')) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setNote(readDraft(p.id)); setError(null); ackJob.current = null; ackWatch.current = null; resultWatch.current = null; setResultStatus(null); setAck(null); }, [p.id]);
  useEffect(() => { if (!p.offline) setError(null); }, [p.offline]);
  useEffect(() => {
    const watch = ackWatch.current;
    if (!watch) return;
    const current = batches.find((x) => x.id === watch.id)?.status;
    if (current === watch.expect) watch.seen = true;
    else if (watch.seen) { ackJob.current = null; ackWatch.current = null; setAck(null); }
  }, [p.board]);
  useEffect(() => {
    const watch = resultWatch.current;
    if (!watch) return;
    const current = batches.find((x) => x.id === watch.id)?.status;
    if (current === watch.expect) watch.seen = true;
    else if (watch.seen) { resultWatch.current = null; setResultStatus(null); }
  }, [p.board]);
  useEffect(() => {
    if (!ack) return;
    const timer = setTimeout(() => { ackJob.current = null; ackWatch.current = null; setAck(null); }, ACK_MS);
    return () => clearTimeout(timer);
  }, [ack, ackSeq]);

  const runningJob = useRunningJobs();
  const boardPending = runningJob(batch?.pending_action);
  const held = usePendingFor(p.id);
  const pendingAction = boardPending?.action ?? held;
  const blocked = !!p.offline || detailFailure || pendingAction !== null;
  const onNoteChange = (text: string) => { setNote(text); writeDraft(p.id, text); };
  const clearAck = () => { ackJob.current = null; ackWatch.current = null; setAck(null); };
  const onActionAccepted = (text: string, jobId: string) => {
    ackJob.current = jobId;
    ackWatch.current = null;
    setAck(text);
    setAckSeq((n) => n + 1);
  };
  const onActionOutcome = (jobId: string, ok: boolean, text: string, watch?: { id: string; expect: BatchSummary['status'] }) => {
    if (ackJob.current !== jobId) return;
    if (!ok) { clearAck(); return; }
    ackWatch.current = watch ? { ...watch, seen: false } : null;
    if (watch) {
      resultWatch.current = { id: watch.id, expect: watch.expect, seen: boardBatch?.id === watch.id && boardBatch.status === watch.expect };
      setResultStatus({ id: watch.id, status: watch.expect });
    }
    setAck(text);
    setAckSeq((n) => n + 1);
  };

  return (
    <aside className="detail batch-pane" ref={pane} tabIndex={-1} aria-label={`Batch details for ${p.id}`}>
      <div className="detail-head">
        <button className="link detail-back" onClick={p.onClose} aria-label="Back">‹ Back</button>
        <span className="mono muted">{p.id}</span>
        <button className="link detail-close" onClick={p.onClose} aria-label="Close batch details" title="Close details">×</button>
      </div>
      {batch ? <>
        <h2 className="batch-pane-title">{batch.title}</h2>
        <div className="batch-pane-status"><span className={`chip ${batch.status}`}>{batchStatusLabel(batch.status, batch.waiting_on)}</span></div>
        <div className="batch-pane-branch"><span>Branch</span><code>{batch.branch} → {batch.base_branch}</code></div>
        <p className="muted">{beadsLabel(batch)} beads</p>
        {batch.status === 'review' && <button className="primary" onClick={() => p.onOpenReview(batch.id)}>Open in Review</button>}
        {ack && <p className="muted" role="status">{ack}</p>}
        {batch.status === 'review' && (reviewDetail ? <BatchReviewBlock
          detail={reviewDetail}
          batches={batches}
          blocked={blocked}
          boardActionPending={!!boardPending}
          pendingAction={pendingAction ?? null}
          offline={!!p.offline}
          note={note}
          onNoteChange={onNoteChange}
          onNoteSent={(id) => { if (id === p.id) { setNote(''); writeDraft(id, ''); } }}
          error={error}
          setError={setError}
          onSelectBatch={() => {}}
          closeOnAccepted={false}
          onActionAccepted={onActionAccepted}
          onActionOutcome={onActionOutcome}
          afterFinished={detailFailure && <p className="muted" role="status"><span>Showing the last known state of this batch; it could not be refreshed.</span> <button className="link" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>}
        /> : detailFailure
          ? <p className="badge-warn"><span>Could not load batch {p.id}.</span> <button className="link" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>
          : <Loading loading={p.loading !== false} label="Loading the batch…" placeholder={<BatchReviewPlaceholder batch={batch} repoId={entry?.repo.id ?? batch.repo_id} mergeMode={entry?.repo.merge_mode ?? 'local-merge'} approver={entry ? effectiveBatchApprover(entry.repo) : 'user'} batches={batches} />}>{null}</Loading>)}
        {cards.length > 0 && <ul className="batch-pane-tasks" aria-label="Batch tasks">
          {cards.map((card) => <li key={card.bead.id}>
            <button className="batch-pane-task" onClick={() => p.onSelect(card.bead.id)}>
              <span className="batch-pane-task-title">{card.bead.title}</span>
              <span className="batch-pane-task-meta"><span className="mono">{card.bead.id}</span><span>{COLUMN_LABELS[card.column]}</span></span>
            </button>
          </li>)}
        </ul>}
        {cards.length === 0 && batch.beads_total === 0 && <p className="muted">No tasks yet.</p>}
        {cards.length < batch.beads_total && batch.beads_total > 0 && <p className="muted">Showing {cards.length} of {batch.beads_total} tasks.</p>}
      </> : <p className="muted">Batch {p.id} is no longer on the board.</p>}
    </aside>
  );
}
