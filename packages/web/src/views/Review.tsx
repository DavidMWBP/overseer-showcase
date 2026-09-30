import { useEffect, useRef, useState, type ReactNode } from 'react';
import { type BatchDetail, type BatchSummary, type BoardCard, type BoardResponse, type TaskDetail } from '@overseer/shared';
import { api, fmtCostTotal, NO_VERIFY_RUN, verifyPassLabel } from '../api';
import { pendingLabel } from '../lib/actions';
import { pendingFor, sendAction, usePendingFor, useRunningJobs, whenJobEnds } from '../lib/jobs';
import { Diff } from '../components/Diff';
import { Loading } from '../components/Loading';
import { PlainText } from '../components/PlainText';
import { AttachmentPicker, useAttachments } from '../components/AttachmentPicker';
import { batchStatusLabel as statusLabel, beadsLabel, FINISHED_MAX } from '../components/BatchRow';
import { BatchReviewBlock } from './BatchReviewBlock';
import { OFFLINE_ACTIONS, readDraft, writeDraft } from './reviewState';
import { isPhoneLayout } from '../lib/phoneLayout';
import { isReviewReadyForUser } from '../lib/needsYou';

interface Props { board: BoardResponse | null; version: number; selected: string | null; selectedBatch: string | null; onSelect: (id: string | null) => void; onSelectBatch: (id: string | null) => void; /** The daemon is unreachable: actions are disabled rather than failing with an HTTP code. */ offline?: boolean; /** Has a fetch this view waits on failed? The shell's per-path check, which also covers the offline case: a 500 the daemon answered leaves it reachable, so `offline` alone does not stop a shimmer. */ loadFailed?: (paths: string[]) => boolean }

/** How long a Merge / Reject / Abandon acknowledgement stays at most. */
export const ACK_MS = 60_000;
/** The bead merge asks in the pane before it runs. */
type Ask = 'merge-bead';
/** What happened to a bead of a batch: "done" is the column, but a bead of an abandoned batch never necessarily ran, and a closed one never landed. */
export const beadOutcome = (c: BoardCard): string => (c.accepted_note ? 'landed with open findings' : c.bead.labels.includes('overseer:merged') ? 'landed' : c.bead.labels.includes('overseer:abandoned') ? 'abandoned' : c.bead.labels.includes('overseer:closed') ? "closed (won't do)" : c.bead.labels.includes('overseer:verified') ? 'verified (no commits)' : c.verify_failure !== null ? 'verify failed' : c.column);
/**
 * The last batch detail fetched per batch, kept across Review unmounts: while the daemon is unreachable the pane shows it as the
 * last known state instead of "Could not load" (round 13: the banner promised the last known state and the pane dropped it).
 */
let lastKnown: { id: string; detail: BatchDetail } | null = null; // one slot: the pane shows one batch, and a diff can be large (fix round 13 review)
/** Tests: one test's detail must not serve the next. */
export function resetLastKnown(): void { lastKnown = null; }

/**
 * A diff for the two detail placeholders: file headers and a handful of lines give the `Diff` block its arrived shape,
 * which the shimmer library can only measure from real boxes. The inventory's typical batch diff is a couple of files.
 */
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

/**
 * The review list's arrived shape with placeholder values: two sections, a two-line batch row and a single-line bead row.
 * Two is what an ordinary board holds — a batch is in one section at a time, and the Finished section is collapsed — and three
 * sections of two-line rows overshot the arrived list by 91 px. It carries `.review-list`'s own grid and gap, since the
 * shimmer wrapper is one grid item where the arrived sections are two, and the gap between them was lost (8 px short).
 */
function ReviewListPlaceholder() {
  return (
    <div className="review-list-placeholder">
      <div>
        <h4>In progress</h4>
        <ul><li><button disabled>Batch still running<span className="muted mono">feature/branch · 1/2 beads · In progress</span></button></li></ul>
      </div>
      <div>
        <h4>Beads in review</h4>
        <ul><li><button disabled>Bead awaiting your review</button></li></ul>
      </div>
    </div>
  );
}

/** The batch pane's arrived shape: the summary, two bead rows, the action row and the diff, while `/api/batches/:id` is in flight. */
function BatchDetailPlaceholder({ baseBranch }: { baseBranch: string }) {
  return (
    <>
      <h4>Summary from the orchestrator</h4>
      <p className="pre">The orchestrator's summary of this round appears here once the batch loads.</p>
      <h4>Beads</h4>
      <ul className="review-beads">
        <li><span className="mono">ov-000</span> A bead of this batch <span className="muted">landed</span></li>
      </ul>
      {/* One button: an open batch renders Abandon alone, and the Merge + note + Abandon row overshot even a batch in review by 47 px. */}
      <div className="review-actions">
        <button disabled>Abandon</button>
      </div>
      <h4>Diff against {baseBranch}</h4>
      <Diff diff={PLACEHOLDER_DIFF} />
    </>
  );
}

/**
 * The bead pane's arrived shape: the verification and note blocks, the action row and the diff, while `/api/tasks/:id` is in flight.
 * The card's `verify_block` decides whether the verification output is reserved, as the Board's card pane does: no card state predicts it.
 */
function BeadDetailPlaceholder({ card }: { card: BoardCard | undefined }) {
  return (
    <>
      <h4>Verification: {card && card.verify_block !== 'none' ? 'passed' : 'not run'}</h4>
      {card?.verify_block === 'output' && <pre>{'$ the verify command\nRunning it on the branch…\nexit 0'}</pre>}
      <h4>Orchestrator note</h4>
      <p className="pre">The orchestrator's note for this bead appears here once it loads.</p>
      <div className="review-actions">
        <button disabled>Merge</button>
        <textarea rows={2} disabled />
        <button disabled>Reject</button>
      </div>
      <h4>Diff against the base branch</h4>
      <Diff diff={PLACEHOLDER_DIFF} />
    </>
  );
}

export function Review(p: Props) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const noteFor = p.selectedBatch ?? p.selected;
  const [note, setNoteState] = useState(() => readDraft(noteFor));
  useEffect(() => { setNoteState(readDraft(noteFor)); }, [noteFor]);
  const setNote = (text: string) => { setNoteState(text); writeDraft(noteFor, text); };
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  // Counts every acknowledgement shown, so the minute restarts for a repeated identical text too (fix round 10 review).
  const [ackSeq, setAckSeq] = useState(0);
  // The acknowledgement names a state ("rejected"): once the board has shown that state and moved on (the batch is back in review), the line is stale and goes (round 9).
  // Every path that shows or clears a line resets the watch, so a watch left by an earlier action cannot clear a later, unrelated line (fix round 9 review).
  const ackWatch = useRef<{ id: string; expect: BatchSummary['status']; seen: boolean } | null>(null);
  // The job whose acceptance the line shows ("Merging batch r1-b1 into main…"): its result replaces the line with the outcome, or
  // clears it on a failure, which the result toast explains. Any other line, or none, leaves that result to the toast alone.
  const ackJob = useRef<string | null>(null);
  // The acceptance line owes focus (the pane has just closed under it) until the focus effect has given it, even when the outcome
  // replaced its text before that render (a result read before its 202); the outcome alone never moves focus.
  const ackFocus = useRef(false);
  const showAck = (text: string, watch?: { id: string | undefined; expect: BatchSummary['status'] }, job: string | null = null) => { ackJob.current = job; ackFocus.current = true; ackWatch.current = watch?.id ? { id: watch.id, expect: watch.expect, seen: false } : null; setAck(text); setAckSeq((n) => n + 1); };
  const clearAck = () => { ackJob.current = null; ackWatch.current = null; setAck(null); };
  // The in-pane question a destructive action opens (the three native `confirm()` calls it replaced); null when none is.
  const [asking, setAsking] = useState<Ask | null>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [batchFailed, setBatchFailed] = useState(false);
  const [batchRetry, setBatchRetry] = useState(0); // Retry on the failure line re-runs the batch fetch; a board event may never come (fix round 14 review)
  const ackRef = useRef<HTMLParagraphElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A textarea: the note is prose for the orchestrator, and a one-line input hid all but its last words (round 25 nit).
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // The list comes from the board App already holds; nothing is fetched for it.
  const allCards = p.board?.repos.flatMap((r) => r.cards) ?? [];
  const cards = allCards.filter((c) => c.column === 'review' && !c.batch_id);
  const batches = p.board?.repos.flatMap((r) => r.batches) ?? [];
  // On a phone the pane is a full-screen sheet over the list, so nothing is picked for the user: the list is the view, a tap opens the sheet.
  const phone = isPhoneLayout();
  useEffect(() => {
    if (!p.board || p.selected || p.selectedBatch || phone) return;
    const first = batches.find((x) => x.status === 'review') ?? batches.find((x) => x.status === 'open');
    if (first) p.onSelectBatch(first.id); else if (cards[0]) p.onSelect(cards[0].bead.id);
    // Only a new board may pick a default; re-running on a selection change would re-select what the user just closed.
  }, [p.board]);
  // A batch that is no longer on the board (its repo was removed) cannot stay selected: the pane would show a dead "could not load" entry until a reload.
  const selectedGone = p.board !== null && p.selectedBatch !== null && !batches.some((x) => x.id === p.selectedBatch);
  useEffect(() => { if (selectedGone) p.onSelectBatch(null); }, [selectedGone]);
  // The same for a v1 bead: its id need not carry the repo prefix the app shell checks on a repo removal (fix round 8 review, M7).
  const selectedBeadGone = p.board !== null && p.selected !== null && !cards.some((c) => c.bead.id === p.selected);
  useEffect(() => { if (selectedBeadGone) p.onSelect(null); }, [selectedBeadGone]);
  useEffect(() => {
    const w = ackWatch.current;
    if (!w) return;
    const now = batches.find((x) => x.id === w.id)?.status;
    if (now === w.expect) w.seen = true;
    else if (w.seen) clearAck();
  }, [p.board]);
  // A board may never sample the state the line names (a rejection re-dispatched within one refresh); the line is a receipt, not a status, so it goes after a minute either way.
  useEffect(() => {
    if (!ack) return;
    const t = setTimeout(clearAck, ACK_MS);
    return () => clearTimeout(t);
  }, [ack, ackSeq]);
  useEffect(() => {
    if (!p.selected) { setDetail(null); setDetailFailed(false); return; }
    // Fresh: a refetch that follows a change notice must not be answered by a request that was in flight before the change (round 12: a stale batch summary).
    // Cancelled: an earlier request's answer landing after a later one's must not paint stale detail either (fix round 12 review).
    let cancelled = false;
    setDetailFailed(false);
    void api.get<TaskDetail>(`/tasks/${p.selected}`, { fresh: true })
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) { setDetail(null); setDetailFailed(true); } });
    return () => { cancelled = true; };
  }, [p.selected, p.version, detailRetry]);
  useEffect(() => {
    if (!p.selectedBatch) { setBatch(null); setBatchFailed(false); return; } // a v1 bead selected afterwards must not inherit the batch's failure
    // A board refresh during Merge/Abandon refetches the old id; the response must not repopulate a pane the action closed.
    let cancelled = false;
    const id = p.selectedBatch;
    setBatchFailed(false);
    void api.get<BatchDetail>(`/batches/${id}`, { fresh: true })
      .then((x) => { if (!cancelled) { lastKnown = { id, detail: x }; setBatch(x); } })
      .catch(() => { if (!cancelled) { setBatch(lastKnown?.id === id ? lastKnown.detail : null); setBatchFailed(true); } });
    return () => { cancelled = true; };
  }, [p.selectedBatch, p.version, batchRetry]);
  // After Merge/Reject/Abandon the pane is gone; the acknowledgement takes focus so keyboard users are not dropped on <body>.
  // A failed result read before its 202 clears the line in the same render that shows it: the list the pane closed over takes
  // focus instead (the result toast says why).
  useEffect(() => { if (ackFocus.current) { ackFocus.current = false; (ack ? ackRef : listRef).current?.focus(); } }, [ack, ackSeq]);
  // An error raised while the daemon was down has nothing to say once it is back; the next action speaks for itself.
  useEffect(() => { if (!p.offline) setError(null); }, [p.offline]);
  // The action the daemon is running for the target the pane shows, from its board row, so a reload keeps it; a row that
  // still names a job whose result has arrived predates that result.
  // The list badges and the loading header read their rows the same way.
  const runningJob = useRunningJobs();
  const pendingBadge = (row: { pending_action?: BoardCard['pending_action'] } | null) => { const job = runningJob(row?.pending_action); return job && <span className="chip pending">{pendingLabel(job.action)}</span>; };
  const boardPending = runningJob(p.selectedBatch !== null
    ? batches.find((x) => x.id === p.selectedBatch)?.pending_action
    : allCards.find((c) => c.bead.id === p.selected)?.pending_action);
  // The action this pane asked for on the target (`lib/jobs.ts`), from the click until its job ends, also before any board row
  // carries it. A target the pane left keeps it there, so coming back to it before the job ends still shows it.
  const held = usePendingFor(noteFor);
  // Leaving the target drops the question the pane was asking about the previous one.
  useEffect(() => { setAsking(null); }, [noteFor]);
  // The target the pane shows now: a rejection that succeeds empties the note field only while the pane still shows its target.
  const shown = useRef(noteFor);
  shown.current = noteFor;
  const pendingAction = boardPending?.action ?? held;
  /** A button whose action is the one running reads so; the others keep their label and are disabled. */
  const label = (action: string, text: string) => (action === pendingAction ? pendingLabel(action) : text);

  // A click shows the action in progress at once: its button reads it and the target's other buttons go off until its job ends
  // (`lib/jobs.ts`). A refusal the request answers clears that state; a 409 keeps it (a job already runs) and names the running
  // action in a toast. `accepted` runs on the 202 alone: it closes the pane and says the action was accepted, and `outcome`
  // follows with the job's result.
  const act = async (action: string, id: string, post: () => Promise<unknown>, accepted: (jobId: string) => void, outcome: (jobId: string, ok: boolean) => void) => {
    if (boardPending) return;
    setError(null);
    const sent = await sendAction(id, action, post);
    if (!sent) return;
    if ('unreachable' in sent) { setError('The daemon is unreachable; try again once it is back.'); return; }
    if (!sent.ours) return;
    accepted(sent.jobId);
    whenJobEnds(sent.jobId, (r) => outcome(sent.jobId, r.ok));
  };
  /** The outcome of the job the line shows: the success replaces the acceptance line, a failure clears it. */
  const settleAck = (jobId: string, ok: boolean, text: string, watch?: { id: string; expect: BatchSummary['status'] }) => {
    if (ackJob.current !== jobId) return;
    if (!ok) { clearAck(); return; }
    ackWatch.current = watch ? { ...watch, seen: false } : null;
    setAck(text);
    setAckSeq((n) => n + 1);
  };
  // A stale pane (the refetch failed, outage or not) keeps its actions off: an action on the last known state could target a batch that has moved on (fix round 13 review).
  // While the target's own job runs the rest are off too, whether the board row or the click says so.
  const blocked = !!p.offline || (batchFailed && !!p.selectedBatch) || pendingAction !== null;
  // The same gate the attach button and every remove x get: paste and drop must not stage a file the user then cannot remove.
  const attachmentState = useAttachments(blocked);
  useEffect(() => { attachmentState.clear(); }, [noteFor]);
  const pickBatch = (id: string) => { setError(null); clearAck(); p.onSelect(null); p.onSelectBatch(id); };
  const pickBead = (id: string) => { setError(null); clearAck(); p.onSelectBatch(null); p.onSelect(id); };
  const back = () => { setError(null); p.onSelectBatch(null); p.onSelect(null); };
  // One sticky header: phones use Back for the sheet; desktop uses the close icon.
  // One sticky block per pane: the id/× bar and the title share it so no scrolled content shows between or above them.
  const sheetHead = (id: string, head: ReactNode) => <div className="pane-sticky"><div className="detail-head"><button className="link detail-back" onClick={back} aria-label="Back to review list">‹ Back</button><span className="mono muted">{id}</span><button className="link detail-close" onClick={back} aria-label="Close details" title="Close details">×</button></div>{head}</div>;

  const wt = detail?.worktree;
  const b = batch?.batch;
  // A destructive dialog names its target the way the list and the header do — title and id — and every action reads it from the
  // batch the pane rendered (`target`), not from the selection alone, so the dialog can never describe a batch other than the one
  // it acts on (round 18: Abandon asked "Abandon this batch?" and destroyed the batch the user was not looking at).
  // Curly quotes: the orchestrator writes titles that carry `"` themselves (`Add ui-check-1.txt containing "hi"`), and the straight
  // pair nested three deep in one line (round 26 nit, found on the Board's Close bead prompt).
  const nameOf = (x: { id: string; title: string }) => `“${x.title}” (${x.id})`;
  // legacy bead actions (unchanged apart from the name in the dialog)
  // Guarded like `target`: the pane keeps the previous bead's detail while the newly selected one is fetched, so an action taken
  // in that moment would name and act on a bead the user has left (fix round 19 review NB-6).
  const targetBead = detail && detail.bead.id === p.selected ? detail : null;
  // The bead merge asks in the pane, not in a native `confirm()`: the question, a confirm and a cancel,
  // with Escape cancelling (a suppressed dialog must not be able to swallow the click, and the question names its target).
  const askMergeBead = () => { if (targetBead && !pendingFor(targetBead.bead.id)) setAsking('merge-bead'); };
  const confirmQuestion = (kind: Ask): string => {
    if (kind === 'merge-bead' && targetBead) {
      const { bead, worktree } = targetBead;
      return `Merge ${nameOf(bead)} into ${worktree?.base_branch ?? 'its base branch'}? ${worktree?.branch ? `Its branch ${worktree.branch}` : 'Its branch'} is deleted afterwards.`;
    }
    return '';
  };
  const confirmLabel = (_kind: Ask): string => 'Confirm merge';
  const runConfirm = () => {
    const kind = asking;
    if (!kind) return;
    setAsking(null);
    if (kind !== 'merge-bead' || !targetBead) return;
    const { bead } = targetBead;
    void act('merge', bead.id, () => api.post(`/tasks/${bead.id}/merge`),
      (jobId) => { showAck(`Merging ${bead.id}…`, undefined, jobId); p.onSelect(null); },
      (jobId, ok) => settleAck(jobId, ok, `${bead.id} merged.`));
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
  // An empty note is refused here (the daemon refuses it too); the message is announced and the note field takes focus.
  const needNote = () => { setError('A rejection note is required.'); noteRef.current?.focus(); };
  // Reads the bead from the pane, like the v1 Merge above it: one source for both actions (fix round 18 review M6).
  // Guarded like Merge: Reject opens no dialog, so two clicks in one tick both sent a request and the second one's refusal painted
  // an error over a rejection that had worked (fix round 25 review NB-B).
  const rejectionBody = async () => ({ note: note.trim(), ...(attachmentState.attachments.length ? { attachments: await attachmentState.toBody() } : {}) });
  // The note stays in the target's draft until the rejection has succeeded, so a rejection that fails can be sent again as it was.
  const noteSent = (id: string) => { writeDraft(id, ''); if (shown.current === id) setNoteState(''); };
  const reject = () => {
    if (!targetBead || pendingFor(targetBead.bead.id)) return;
    const { bead } = targetBead;
    if (!note.trim()) { needNote(); return; }
    void act('reject', bead.id, async () => api.post(`/tasks/${bead.id}/reject`, await rejectionBody()),
      (jobId) => { attachmentState.clear(); showAck(`Rejecting ${bead.id}…`, undefined, jobId); p.onSelect(null); },
      (jobId, ok) => { if (ok) noteSent(bead.id); settleAck(jobId, ok, `${bead.id} rejected; the orchestrator was notified.`); });
  };
  // The question replaces the bead's action group.
  const confirmBlock = (kind: Ask) => (
    <div className="review-actions close-confirm" ref={questionRef}>
      <span>{confirmQuestion(kind)}</span>
      <button ref={confirmRef} className="primary" disabled={blocked} onClick={runConfirm}>{confirmLabel(kind)}</button>
      <button onClick={() => setAsking(null)}>Cancel</button>
    </div>
  );
  // One set of counts for the list row, the header and the verification line: the daemon's summary (worktree rows and labels, the
  // same numbers `landed_verified` is compared with), not the cards' labels (round 17: the two lines of one card disagreed).
  const summary = batches.find((x) => x.id === b?.id);
  const landed = summary?.beads_done ?? 0;
  const closed = summary?.beads_closed ?? 0;
  const total = summary?.beads_total ?? 0;
  const landedOf = batch ? (closed ? `${landed} landed, ${closed} closed of ${total} beads` : `${landed}/${total} beads landed`) : '';
  // A bead whose verification failed is what blocks the batch; the header says so instead of "pending".
  const failed = batch?.beads.filter((c) => c.verify_failure !== null && c.column !== 'done') ?? [];
  // While a bead is in Verifying its failure is not counted (the daemon clears it for the run); the header names the run instead of dropping to "pending" (fix round 9 review).
  const verifying = batch?.beads.filter((c) => c.column === 'verifying') ?? [];
  // What the landed beads' own runs recorded, not the repo's current command: a command cleared later must not relabel real verify output "not run" (fix round 8 review).
  const ran = batch?.landed_verified ?? 0;
  const passLabel = ran >= landed ? 'pass' : ran === 0 ? verifyPassLabel(false) : `pass for ${ran} of ${landed} landed beads (the others landed with no verify command configured)`;
  const verification = failed.length > 0 ? `failed (${failed.map((c) => c.bead.id).join(', ')})` : verifying.length > 0 ? `verifying (${verifying.map((c) => c.bead.id).join(', ')})` : landed > 0 ? `${passLabel} (${landedOf})` : closed > 0 && b?.status !== 'open' ? `nothing landed (${closed} closed as won't do)` : 'pending (no bead has landed yet)'; // an open batch with closed beads is still working (fix round 14 review)
  // Finished is collapsed by default (the list only grows) and opens itself while the selected batch is in it.
  const sections: { title: string; items: BatchSummary[]; collapsible?: boolean }[] = [
    { title: 'Ready for you', items: p.board?.repos.flatMap((r) => r.batches.filter((x) => isReviewReadyForUser(r.repo, x))) ?? [] },
    { title: 'Waiting', items: batches.filter((x) => x.status === 'review' && !!x.waiting_on) },
    { title: 'Handled by orchestrator', items: p.board?.repos.flatMap((r) => r.batches.filter((x) => x.status === 'review' && !x.waiting_on && !isReviewReadyForUser(r.repo, x))) ?? [] },
    { title: 'In progress', items: batches.filter((x) => x.status === 'open') },
    { title: 'Finished', items: batches.filter((x) => x.status === 'merged' || x.status === 'abandoned').sort((x, y) => y.updated_at.localeCompare(x.updated_at)).slice(0, FINISHED_MAX), collapsible: true },
  ];
  // While the detail loads (or a different batch is still in state) the header comes from the board summary, so the pane never stays blank.
  const pending = p.selectedBatch !== null && b?.id !== p.selectedBatch ? batches.find((x) => x.id === p.selectedBatch) ?? null : null;
  const showBatch = batch && b && b.id === p.selectedBatch;
  return (
    <div className="review-layout">
      <div className="review-list" tabIndex={-1} ref={listRef}>
        {ack && <p className="muted" role="status" tabIndex={-1} ref={ackRef}>{ack}</p>}
        {/* Before any board arrived nothing is known: an outage says so instead of "nothing to review" (round 16: a reload during an outage read as an empty list while a batch waited), and otherwise the shimmer holds the list's arrived shape instead of a one-line note that left the column at 42 px. */}
        <Loading loading={p.board === null && !p.offline && !p.loadFailed?.(['/board'])} label="Loading the review list…" placeholder={<ReviewListPlaceholder />}>
          {p.board === null
            ? <p className="muted">{p.offline ? 'The review list cannot be loaded until the daemon is back.' : 'Could not load the review list.'}</p>
            : <>
              {batches.length === 0 && cards.length === 0 && <p className="muted">Nothing to review yet. Batches appear here as soon as the orchestrator creates one; those awaiting your decision come first.</p>}
              {sections.filter((s) => s.items.length > 0).map((s) => {
                const list = (
                  <ul>
                    {s.items.map((x) => (
                      <li key={x.id} className={`${x.id === p.selectedBatch ? 'active' : ''}${x.waiting_on ? ' muted' : ''}`.trim()}>
                        <button onClick={() => pickBatch(x.id)} aria-current={x.id === p.selectedBatch || undefined}>
                          {x.title}<span className="muted mono">{x.branch} · {beadsLabel(x)} · {statusLabel(x.status, x.waiting_on)}</span>{x.waiting_on && <span className="chip">Waiting on {batches.find((b) => b.id === x.waiting_on)?.title ?? x.waiting_on}</span>}{pendingBadge(x)}
                        </button>
                      </li>
                    ))}
                  </ul>
                );
                if (s.collapsible) {
                  return (
                    <details key={s.title} className="review-section" open={s.items.some((x) => x.id === p.selectedBatch) || undefined}>
                      <summary><h4>{s.title} <span className="muted">({s.items.length})</span></h4></summary>
                      {list}
                    </details>
                  );
                }
                return <div key={s.title}><h4>{s.title}</h4>{list}</div>;
              })}
              {cards.length > 0 && (
                <div>
                  <h4>Beads in review</h4>
                  <ul>{cards.map((c) => <li key={c.bead.id} className={c.bead.id === p.selected ? 'active' : ''}><button onClick={() => pickBead(c.bead.id)} aria-current={c.bead.id === p.selected || undefined}>{c.bead.title}{pendingBadge(c)}</button></li>)}</ul>
                </div>
              )}
            </>}
        </Loading>
      </div>
      {p.selectedBatch && !showBatch && (
        <div className="review-detail" aria-busy={!batchFailed}>
          {sheetHead(p.selectedBatch, (
            <div className="review-head">
              <h2>{pending?.title ?? p.selectedBatch}</h2>
              {pending && <span className="mono muted">{pending.branch} → {pending.base_branch}</span>}
              {/* The verification line needs the detail; its placeholder keeps the header at its arrived height, since that line wraps it to a second row (30 px short without it). */}
              {pending && pending.status !== 'abandoned' && !batchFailed && <Loading loading placeholder={<span className="mono">The verification of this batch and how many of its beads landed</span>}>{null}</Loading>}
              {pending && <span className="mono" title={fmtCostTotal(pending.cost, pending.cost_unknown).title}>{fmtCostTotal(pending.cost, pending.cost_unknown).text}</span>}
              {pending && <span className={`chip ${pending.status}`}>{statusLabel(pending.status, pending.waiting_on)}</span>}
              {pendingBadge(pending)}
            </div>
          ))}
          {batchFailed
            ? <p className="badge-warn"><span>Could not load batch {p.selectedBatch}.</span> <button className="link" onClick={() => setBatchRetry((n) => n + 1)}>Retry</button></p>
            : <Loading loading label="Loading the batch…" placeholder={<BatchDetailPlaceholder baseBranch={pending?.base_branch ?? 'the base branch'} />}>{null}</Loading>}
        </div>
      )}
      {showBatch && (
        <div className="review-detail">
          {sheetHead(b.id, (
            <div className="review-head">
              <h2>{b.title}</h2>
              <span className="mono muted">{b.branch} → {b.base_branch}</span>
              {b.status !== 'abandoned' && <span className={`mono ${failed.length > 0 ? 'badge-warn' : ''}`}>Verification: {verification}</span>}
              {b.review_check && <span className={`mono ${b.review_check.status === 'fail' ? 'badge-warn' : ''}`} data-testid="review-check" title={`${b.review_check.head_sha} · ${b.review_check.duration_ms} ms`}>
                Review check: {b.review_check.status === 'pass' ? 'passed' : 'failed'} · {b.review_check.command}{b.review_check.counts && ` · ${b.review_check.counts.passed} passed · ${b.review_check.counts.failed} failed · ${b.review_check.counts.skipped} skipped · ${b.review_check.counts.todo} todo${b.review_check.counts.flaky ? ` · ${b.review_check.counts.flaky} flaky` : ''}`}
              </span>}
              <span className="mono" title={fmtCostTotal(batch.cost, batch.cost_unknown).title}>{fmtCostTotal(batch.cost, batch.cost_unknown).text}</span>
              <span className={`chip ${b.status}`}>{statusLabel(b.status, b.waiting_on)}</span>
              {boardPending && <span className="chip pending">{pendingLabel(boardPending.action)}</span>}
            </div>
          ))}
          <BatchReviewBlock
            detail={batch}
            batches={batches}
            blocked={blocked}
            boardActionPending={!!boardPending}
            pendingAction={pendingAction ?? null}
            offline={!!p.offline}
            note={note}
            onNoteChange={setNote}
            onNoteSent={noteSent}
            error={error}
            setError={setError}
            onSelectBatch={p.onSelectBatch}
            afterFinished={batchFailed && <p className="muted" role="status"><span>Showing the last known state of this batch; it could not be refreshed.</span> <button className="link" onClick={() => setBatchRetry((n) => n + 1)}>Retry</button></p>}
            onActionAccepted={(text, jobId) => showAck(text, undefined, jobId)}
            onActionOutcome={settleAck}
          >
            <>
              <h4>Beads</h4>
              <ul className="review-beads">{batch.beads.map((c) => (
                <li key={c.bead.id}>
                  <span className="mono">{c.bead.id}</span> {c.bead.title} <span className="muted">{beadOutcome(c)}</span>
                  {c.accepted_note && <p className="pre muted">{c.accepted_note}</p>}
                  {c.findings && c.findings.length > 0 && (
                    <ul className="review-findings">{c.findings.map((f, i) => <li key={i} className="muted">{f.severity}{f.file ? ` ${f.file}` : ''}: {f.summary}</li>)}</ul>
                  )}
                </li>
              ))}</ul>
              {b.status === 'open' || b.status === 'review' ? failed.map((c) => <div key={c.bead.id}><h4>Verification of {c.bead.id} failed</h4><pre>{c.verify_failure}</pre><p className="muted">Retry verification or Re-dispatch from its card on the Board.</p></div>) : null}
            </>
          </BatchReviewBlock>
        </div>
      )}
      {!p.selectedBatch && detail && (
        <div className="review-detail">
          {sheetHead(detail.bead.id, (
            <div className="review-head">
              <h2>{detail.bead.title} <span className="muted">{detail.bead.id} · {wt?.branch}</span></h2>
            </div>
          ))}
          {/* No "Previous verification" heading here, unlike the Board's pane: this pane is only ever open on a bead in the review
              column, and a run on the bead takes it out of that column and closes the pane with it (`selectedBeadGone`). The
              heading was gated on card states this list can never hold, so it could not be reached (fix round 24 review NB-1). */}
          <h4>Verification: {wt?.verify_status === 'fail' ? 'failed' : wt?.verify_status === 'pass' ? verifyPassLabel(wt.verify_output !== NO_VERIFY_RUN) : 'not run'}</h4>
          {wt?.verify_output && wt.verify_output !== NO_VERIFY_RUN && <pre>{wt.verify_output}</pre>}
          <h4>Orchestrator note</h4>
          <div className="pre review-note">{wt?.review_note ? <PlainText text={wt.review_note} tables /> : 'No note yet: the orchestrator has not called request_merge. The bead title and description will be used as the merge description.'}</div>
          {wt?.conflict_files && wt.conflict_files.length > 0 && (
            <div className="banner-warn">Last merge conflicted in: {wt.conflict_files.join(', ')}</div>
          )}
          {asking === 'merge-bead' ? confirmBlock(asking) : <div className="review-actions">
            <button disabled={blocked} onClick={askMergeBead}>{label('merge', 'Merge')}</button>
            <textarea ref={noteRef} rows={2} value={note} placeholder="Why? (required to reject)" aria-label="Rejection note" onChange={(e) => setNote(e.target.value)} {...attachmentState.pasteProps} {...attachmentState.dropProps} />
            <AttachmentPicker state={attachmentState} disabled={blocked} showHint />
            <button disabled={blocked} onClick={reject}>{label('reject', 'Reject')}</button>
            {p.offline && <span className="muted">{OFFLINE_ACTIONS}</span>}
          </div>}
          {error && <div className="badge-warn" role="alert">{error}</div>}
          <h4>Diff against {wt?.base_branch}</h4>
          <Diff diff={detail.diff} />
        </div>
      )}
      {/* The pane waits on `/api/tasks/:id` like the batch pane waits on its own fetch: before, nothing rendered at all, so on a phone the full-screen sheet simply did not appear until the fetch resolved (the inventory's second pure-blank case). */}
      {!p.selectedBatch && !detail && p.selected && (
        <div className="review-detail" aria-busy={!detailFailed}>
          {sheetHead(p.selected, (
            <div className="review-head">
              <h2>{cards.find((c) => c.bead.id === p.selected)?.bead.title ?? p.selected}</h2>
            </div>
          ))}
          {detailFailed
            ? <p className="badge-warn" role="alert"><span>Could not load {p.selected}.</span> <button className="link" onClick={() => setDetailRetry((n) => n + 1)}>Retry</button></p>
            : <Loading loading label="Loading the bead…" placeholder={<BeadDetailPlaceholder card={cards.find((c) => c.bead.id === p.selected)} />}>{null}</Loading>}
        </div>
      )}
    </div>
  );
}
