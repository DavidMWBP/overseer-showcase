import { useEffect, useRef, useState, type ReactNode } from 'react';
import { effectiveBatchApprover, type BatchDetail, type BatchSummary } from '@overseer/shared';
import { api } from '../api';
import { pendingLabel } from '../lib/actions';
import { pendingFor, sendAction, whenJobEnds } from '../lib/jobs';
import { AttachmentPicker, useAttachments } from '../components/AttachmentPicker';
import { Diff } from '../components/Diff';
import { PlainText } from '../components/PlainText';
import { OFFLINE_ACTIONS } from './reviewState';

type BatchAsk = 'merge-batch' | 'abandon-batch';
type AckWatch = { id: string; expect: BatchSummary['status'] };

interface Props {
  detail: BatchDetail;
  batches: BatchSummary[];
  blocked: boolean;
  boardActionPending: boolean;
  pendingAction: string | null;
  offline: boolean;
  note: string;
  onNoteChange: (text: string) => void;
  onNoteSent: (id: string) => void;
  error: string | null;
  setError: (error: string | null) => void;
  onSelectBatch: (id: null) => void;
  closeOnAccepted?: boolean;
  onActionAccepted: (text: string, jobId: string) => void;
  onActionOutcome: (jobId: string, ok: boolean, text: string, watch?: AckWatch) => void;
  afterFinished?: ReactNode;
  children?: ReactNode;
}

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

export function BatchReviewBlock(p: Props) {
  const { batch: b } = p.detail;
  const [asking, setAsking] = useState<BatchAsk | null>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const attachmentState = useAttachments(p.blocked);

  useEffect(() => { attachmentState.clear(); }, [b.id]);
  useEffect(() => { setAsking(null); }, [b.id]);

  const act = async (action: string, id: string, post: () => Promise<unknown>, accepted: (jobId: string) => void, outcome: (jobId: string, ok: boolean) => void) => {
    if (p.boardActionPending) return;
    p.setError(null);
    const sent = await sendAction(id, action, post);
    if (!sent) return;
    if ('unreachable' in sent) { p.setError('The daemon is unreachable; try again once it is back.'); return; }
    if (!sent.ours) return;
    accepted(sent.jobId);
    whenJobEnds(sent.jobId, (r) => outcome(sent.jobId, r.ok));
  };

  const nameOf = (x: { id: string; title: string }) => `“${x.title}” (${x.id})`;
  const confirmQuestion = (kind: BatchAsk): string => {
    const local = p.detail.repo.merge_mode === 'local-merge';
    if (kind === 'merge-batch') return local ? `Merge batch ${nameOf(b)} into ${b.base_branch}? Its branch ${b.branch} is deleted afterwards.` : `Mark batch ${nameOf(b)} merged? Its worktrees and the local ${b.branch} are deleted.`;
    return `Abandon batch ${nameOf(b)} on ${b.branch}? Running workers are stopped, that branch and its worktrees are deleted, its beads are closed, and nothing reaches ${b.base_branch}.`;
  };
  const confirmLabel = (kind: BatchAsk): string => {
    if (kind === 'abandon-batch') return 'Confirm abandon';
    if (p.detail.repo.merge_mode !== 'local-merge') return 'Confirm mark merged';
    return 'Confirm merge';
  };

  const mergeBatch = () => {
    if (pendingFor(b.id)) return;
    setAsking('merge-batch');
  };
  const abandonBatch = () => {
    if (pendingFor(b.id)) return;
    setAsking('abandon-batch');
  };
  const runConfirm = () => {
    const kind = asking;
    if (!kind) return;
    setAsking(null);
    if (kind === 'merge-batch') {
      const local = p.detail.repo.merge_mode === 'local-merge';
      void act('merge', b.id, () => api.post(`/batches/${b.id}/merge`),
        (jobId) => { p.onActionAccepted(local ? `Merging batch ${b.id} into ${b.base_branch}…` : `Marking batch ${b.id} merged…`, jobId); if (p.closeOnAccepted !== false) p.onSelectBatch(null); },
        (jobId, ok) => p.onActionOutcome(jobId, ok, `Batch ${b.id} merged into ${b.base_branch}.`, { id: b.id, expect: 'merged' }));
      return;
    }
    void act('abandon', b.id, () => api.post(`/batches/${b.id}/abandon`),
      (jobId) => { p.onActionAccepted(`Abandoning batch ${b.id}…`, jobId); if (p.closeOnAccepted !== false) p.onSelectBatch(null); },
      (jobId, ok) => p.onActionOutcome(jobId, ok, `Batch ${b.id} abandoned.`, { id: b.id, expect: 'abandoned' }));
  };

  // Escape cancels the in-pane question, wherever focus is.
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAsking(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [asking]);
  useEffect(() => {
    if (!asking) return;
    confirmRef.current?.focus();
    const rect = questionRef.current?.getBoundingClientRect();
    if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) questionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [asking]);

  const needNote = () => { p.setError('A rejection note is required.'); noteRef.current?.focus(); };
  const rejectionBody = async () => ({ note: p.note.trim(), ...(attachmentState.attachments.length ? { attachments: await attachmentState.toBody() } : {}) });
  const rejectBatch = () => {
    if (pendingFor(b.id)) return;
    if (!p.note.trim()) { needNote(); return; }
    void act('reject', b.id, async () => api.post(`/batches/${b.id}/reject`, await rejectionBody()),
      (jobId) => { attachmentState.clear(); p.onActionAccepted(`Rejecting batch ${b.id}…`, jobId); if (p.closeOnAccepted !== false) p.onSelectBatch(null); },
      (jobId, ok) => { if (ok) p.onNoteSent(b.id); p.onActionOutcome(jobId, ok, `Batch ${b.id} rejected; the orchestrator was notified.`, { id: b.id, expect: 'open' }); });
  };

  const confirmBlock = (kind: BatchAsk) => (
    <div className="review-actions close-confirm" ref={questionRef}>
      <span>{confirmQuestion(kind)}</span>
      <button ref={confirmRef} className={kind === 'abandon-batch' ? 'danger' : 'primary'} disabled={p.blocked} onClick={runConfirm}>{confirmLabel(kind)}</button>
      <button onClick={() => setAsking(null)}>Cancel</button>
    </div>
  );

  const live = b.status === 'open' || b.status === 'review';
  const finishedLine = b.status === 'merged'
    ? `Merged into ${b.base_branch}${b.merged_commit ? ` at ${b.merged_commit.slice(0, 7)}` : b.mr_url ? ` (${b.mr_url})` : ''} on ${fmtWhen(b.merged_at ?? b.updated_at)}`
    : `Abandoned by the user on ${fmtWhen(b.updated_at)}`;
  const label = (action: string, text: string) => (action === p.pendingAction ? pendingLabel(action) : text);

  return (
    <>
      {b.status === 'review' && effectiveBatchApprover(p.detail.repo) === 'orchestrator' && <p className="muted">The orchestrator merges {p.detail.repo.id}'s batches on its own; it will merge this one without waiting for you. Merge and Reject stay available.</p>}
      {!live && <p className="muted">{finishedLine}. This batch is {b.status}; its branch and worktrees are gone and no actions remain.</p>}
      {p.afterFinished}
      <h4>Summary from the orchestrator</h4>
      {/* The current round only; earlier summaries and rejection notes are history, folded below (round 13: the pane opened with the previous round). */}
      <div className="pre review-note">{b.note ? <PlainText text={b.note} tables /> : b.history ? 'No summary for this round yet: the orchestrator has not requested review again.' : 'The orchestrator has not requested review yet.'}</div>
      {b.history && <details className="review-history"><summary>Earlier rounds</summary><div className="pre review-note"><PlainText text={b.history} tables /></div></details>}
      {p.children}
      {/* Held behind an overlapping batch: Merge is disabled here and refused by the daemon; Reject and Abandon stay. */}
      {b.status === 'review' && b.waiting_on && <div className="banner-warn">Waiting on {p.batches.find((x) => x.id === b.waiting_on)?.title ?? b.waiting_on}: both change {(b.overlap_files ?? []).join(', ')}. Merge is available once that batch is merged, rejected or abandoned.</div>}
      {b.status === 'review' && b.conflict_files && b.conflict_files.length > 0 && <div className="banner-warn">{b.refresh_from ? `The refresh from ${b.base_branch} conflicted in: ${b.conflict_files.join(', ')}` : `Last merge into ${b.base_branch} conflicted in: ${b.conflict_files.join(', ')}`}. Reject with a note and the orchestrator adds a merge bead.</div>}
      {live && (
        asking ? confirmBlock(asking) : <div className="review-actions">
          {b.status === 'review' && p.detail.repo.merge_mode === 'local-merge' && <button className="primary" disabled={p.blocked || !!b.waiting_on} onClick={mergeBatch}>{label('merge', 'Merge')}</button>}
          {b.status === 'review' && p.detail.repo.merge_mode === 'gitlab-mr' && <>
            {b.mr_url && <a href={b.mr_url} target="_blank" rel="noreferrer">Open merge request</a>}
            <button className="primary" disabled={p.blocked || !!b.waiting_on} onClick={mergeBatch}>{label('merge', 'Mark merged')}</button>
          </>}
          {b.status === 'review' && <><textarea ref={noteRef} rows={2} value={p.note} placeholder="Why? (required to reject)" aria-label="Rejection note" onChange={(e) => p.onNoteChange(e.target.value)} {...attachmentState.pasteProps} {...attachmentState.dropProps} /><AttachmentPicker state={attachmentState} disabled={p.blocked} showHint /><button disabled={p.blocked} onClick={rejectBatch}>{label('reject', 'Reject')}</button></>}
          <button className="danger" disabled={p.blocked} onClick={abandonBatch}>{label('abandon', 'Abandon')}</button>
          {p.offline && <span className="muted">{OFFLINE_ACTIONS}</span>}
        </div>
      )}
      {p.error && <div className="badge-warn" role="alert">{p.error}</div>}
      {p.detail.diff !== null && <><h4>Diff against {b.base_branch}</h4><Diff diff={p.detail.diff} /></>}
      {/* A gitlab-mr batch carries no diff: the MR shows it, and not computing it keeps the detail small and quick to load. */}
      {p.detail.diff === null && b.mr_url && b.status === 'review' && <p className="muted">The diff is on the merge request.</p>}
    </>
  );
}
