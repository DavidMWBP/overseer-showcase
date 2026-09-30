import { useEffect, useRef, useState } from 'react';
import type { BoardCard, BoardResponse, TaskDetail } from '@overseer/shared';
import { api, ApiError, COST_UNKNOWN_TITLE, fmtCost, isUnreachable, NO_VERIFY_RUN, verifyIsPrevious, verifyPassLabel } from '../api';
import { pendingLabel } from '../lib/actions';
import { sendAction, usePendingFor, useRunningJob, whenJobEnds } from '../lib/jobs';
import { PlainText } from '../components/PlainText';
import { fromBd, fromBdTitle } from '../components/Card';
import { batchStatusLabel } from '../components/BatchRow';
import { Trace } from '../components/Trace';
import { Loading } from '../components/Loading';
import { isPhoneLayout } from '../lib/phoneLayout';

type StopState = 'idle' | 'done' | { error: string };
/**
 * The pane's Retry verification / Re-dispatch / Close bead / Retry close / Land anyway: its acknowledgement (shown once the job
 * has ended well, with which action it was) or its error. Stop worker is an action too, with its own state below.
 */
type Action = 'verify' | 'redispatch' | 'close' | 'close-landed' | 'accept-review' | 'interrupt';
type ActState = 'idle' | { ack: string; action: Action } | { error: string };
/** Retry verification has none: its job is the verification run, so its button reads the run and the result toast its outcome. */
const ACKS: Partial<Record<Action, string>> = {
  redispatch: 'Re-dispatched; a new worker starts with the failed output in its instructions.',
  close: "Closed as won't do; the orchestrator was told.", // a bead that belongs to a batch adds the batch clause (see closeBead)
  'close-landed': 'Closed in bd; the card moves to Done.',
  'accept-review': 'Landed with the open findings recorded.',
};
/** The states a Stop is offered in, and whose end clears its acknowledgement. */
const stoppableState = (s: BoardCard['state']) => s === 'running' || s === 'settling' || s === 'reviewing';
/** The action blocks the pane can offer. */
type Offers = { landedUnclosed: boolean; canAct: boolean; canRedispatch: boolean; canClose: boolean; awaiting: boolean; stoppable: boolean };
/**
 * The blocks each action's button sits in, the first being the one a pane opened while the job already runs offers (a reload
 * or a reopen during a retried verification finds the card in Verifying, which offers none of them).
 */
const BLOCKS_OF: Partial<Record<string, (keyof Offers)[]>> = {
  verify: ['canAct'],
  redispatch: ['canAct', 'canRedispatch', 'awaiting'],
  close: ['canClose'],
  'close-landed': ['landedUnclosed'],
  'accept-review': ['awaiting'],
  interrupt: ['stoppable'],
};
/** Re-dispatch of a bead whose branch has nothing on it: no verification failed, so nothing travels in the new worker's instructions (round 26 R26-1). */
const ACK_REDISPATCH_EMPTY = 'Re-dispatched; a new worker starts on the bead.';
/**
 * What an outage does to the pane's actions: they are disabled, so a click is dropped, not queued — the same rule and almost the
 * same words as Review's (fix round 26 review: the Board's stayed enabled, so Stop worker and Close bead were sent into a daemon
 * that was not there). Nothing here holds a draft, so the sentence does not promise to keep one.
 */
const OFFLINE_ACTIONS = 'The daemon is unreachable: nothing is sent and nothing is queued. Press again once it is back.';

/**
 * The side pane's fetched part: History, the last assistant text and the verification output, each with its heading. Only the
 * blocks that can arrive for this card are reserved — a never-dispatched bead has no session, so it gets neither the assistant
 * text nor a verification, and reserving all three would collapse the pane upward when the detail lands (fix round 16 review).
 */
function DetailPlaceholder({ card }: { card: BoardCard }) {
  return (
    <>
      <h4>History</h4>
      {/* Notes grow one line per lifecycle transition, so a dispatched bead's History is a few lines and a never-dispatched one's is the line that created it. */}
      <pre>{card.session_id ? 'Dispatched to a worker.\nThe worker committed its change.\nVerification started.' : 'Created.'}</pre>
      {/* A worker writes text within its first turn, so a session means this block, unlike the verification below, which needs a finished run. */}
      {card.session_id &&<><h4>Last assistant text</h4><p className="pre">Done. The change is on the branch with a test covering it.</p></>}
      {/* The daemon reports whether a verification is recorded on this bead and whether it has output: neither the card state nor the branch predicts it (a failure survives a re-dispatch, a bead closed as won't-do never ran one). */}
      {card.verify_block !== 'none' && <><h4>Verification: passed</h4>{card.verify_block === 'output' && <pre>{'$ the verify command\nRunning it on the branch…\nexit 0'}</pre>}</>}
    </>
  );
}

export interface TaskPaneProps {
  /** The bead whose pane is open; the pane fetches its detail and names it. */
  beadId: string;
  /** The board the card came from: the header metadata, the batch a close names and the beads a blocked one waits on all read from it. */
  board: BoardResponse;
  /** The shell's board version: a bump refetches the detail, so a lifecycle change shows up while the pane is open. */
  version: number;
  eventTicks?: Record<string, number>;
  offline?: boolean;
  /** Open another bead's pane (a blocker link) where the board has a card for it; the Board and the Office both select in place. */
  onSelect: (beadId: string) => void;
  onClose: () => void;
  /** Return to the batch panel that opened this pane, when there is one. */
  onBackToBatch?: () => void;
  onOpenReview: (beadId: string) => void;
  onOpenBatch: (batchId: string) => void;
}

/**
 * The Board's card pane, in its own component so the Office can open the same pane over the room. It is the same markup and
 * behaviour wherever it is rendered: it takes the bead id, finds that bead's card on the board, and fills the pane in from the
 * detail fetch. A bead with no card on the board renders nothing.
 */
export function TaskPane(props: TaskPaneProps) {
  const card = props.board.repos.flatMap((r) => r.cards).find((c) => c.bead.id === props.beadId) ?? null;
  if (!card) return null;
  return <TaskPaneBody {...props} card={card} />;
}

function TaskPaneBody({ beadId, card, board, version, eventTicks, offline, onSelect, onClose, onBackToBatch, onOpenReview, onOpenBatch }: TaskPaneProps & { card: BoardCard }) {
  const all = board.repos.flatMap((r) => r.cards);
  const [loaded, setLoaded] = useState<TaskDetail | null>(null);
  // A detail fetch that failed, with why: shown in place of "Loading details…" with a Retry (round 15: an error and a pending fetch looked the same, forever).
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [loadRetry, setLoadRetry] = useState(0);
  const [stopState, setStopState] = useState<StopState>('idle');
  const [actState, setActState] = useState<ActState>('idle');
  // The action this pane asked for on the bead (`lib/jobs.ts`), from the click until its job ends: the button reads the action
  // in progress and the bead's other buttons are disabled, also between the 202 and the first board that carries the job.
  const held = usePendingFor(card.bead.id);
  // The job the card's row carries, unless its result has already arrived: that row predates the result.
  const running = useRunningJob(card.pending_action);
  // The bead the pane shows now: a job's result for a bead the pane has left must not paint its acknowledgement here.
  const shown = useRef(beadId);
  shown.current = beadId;
  // The note typed for Close bead while its in-pane question is open; null when it is not.
  const [closing, setClosing] = useState<string | null>(null);
  // The same for Land anyway: the note typed while its question is open; null when it is not.
  const [landing, setLanding] = useState<string | null>(null);
  const [trace, setTrace] = useState(false);
  const pane = useRef<HTMLElement>(null);
  // The close handler lives in a ref: the Board re-renders on its one-second tick, and the key listener must not be re-registered for it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // Fresh: a refetch that follows a change notice must not be answered by a request that was in flight before the change (round 12: History a step behind).
    // Cancelled: an earlier request's answer landing after a later one's must not paint stale detail either (fix round 12 review).
    let cancelled = false;
    setLoadFailed(null);
    void api.get<TaskDetail>(`/tasks/${beadId}`, { fresh: true })
      .then((d) => { if (!cancelled) setLoaded(d); })
      .catch((e: unknown) => { if (!cancelled) setLoadFailed(isUnreachable(e) ? 'the daemon is unreachable' : e instanceof ApiError ? e.message : String(e)); }); // a refetch that fails keeps the detail already shown
    return () => { cancelled = true; };
  }, [beadId, version, loadRetry]);
  // The pane opens from the card's own data; the fetched part (history, verification, actions) fills in when it arrives.
  const detail = loaded && loaded.bead.id === beadId ? loaded : null;
  // The card carries the description itself except on a Done card, which the daemon slims; there the fetched bead supplies it.
  const description = detail?.bead.description ?? card.bead.description;
  const last = detail?.sessions[detail.sessions.length - 1];
  useEffect(() => { setStopState('idle'); setActState('idle'); setClosing(null); setLanding(null); setTrace(false); }, [beadId]);
  // A new note ends an error line and keeps an acknowledgement. A re-dispatch's first note is the start of the run it announced, not its
  // end (it arrives while the board can still say verify_failed, and clearing on it brought the buttons back for a blink, round 12),
  // and a close's note is the close itself: acknowledgements are cleared by the card's state, not by a note.
  const notes = detail?.bead.notes;
  useEffect(() => { setActState((a) => (typeof a === 'object' && 'ack' in a ? a : 'idle')); }, [notes]);
  // In the phone layout the pane is a full-screen sheet; bring it to the top of the viewport (wider layouts overlay from the
  // right at a fixed position, so scrolling the page does not move it) and give it focus so Escape closes it.
  useEffect(() => {
    if (!pane.current) return;
    const stacked = isPhoneLayout();
    pane.current.scrollIntoView?.({ block: stacked ? 'start' : 'nearest' });
    pane.current.scrollTop = 0; // the phone sheet scrolls on its own; a second card opens at its top, not where the first was read
    pane.current.focus({ preventScroll: true });
  }, [beadId]);
  // Escape closes the pane wherever focus is, as a side pane does (round 17: it worked only with focus inside the pane, so a user
  // who had tabbed away, or come back to the Board with the pane reopened from the hash, took Escape for broken).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Every action is driven by the card's state, which the daemon computes (round 11: the pane inferred it from three fields and
  // offered Retry / Re-dispatch to a worker that had exited but not settled). The stop acknowledgement stays until the bead has
  // left Running (the session ends first, the bead settles a moment later); an action's acknowledgement stays until the run it
  // announced is over, that is until the state has left Verifying, or Running and the settling that follows it after a
  // re-dispatch; the notes effect above covers a run the board never sampled.
  const cardState = card.state;
  const prevState = useRef(cardState);
  useEffect(() => {
    if (!stoppableState(cardState)) setStopState('idle');
    const prev = prevState.current;
    prevState.current = cardState;
    // `awaiting_decision` counts as a run for the acknowledgement's sake: Land anyway's line stays until the bead has left that state.
    const inRun = (s: typeof cardState) => s === 'verifying' || s === 'running' || s === 'settling' || s === 'landed_unclosed' || s === 'reviewing' || s === 'awaiting_decision';
    if (inRun(prev) && !inRun(cardState)) setActState('idle');
  }, [cardState]);

  // Stop needs only the card (the board already knows a worker is live), so it is there before the detail has loaded (round 11).
  // Its "Stop requested" line follows the job's success, and only while the card can still be stopped: a job that ends after the
  // bead has settled would leave the line under a card it no longer describes.
  const stop = () => {
    if (running) return;
    const id = card.bead.id;
    setStopState('idle');
    void sendAction(id, 'interrupt', () => api.post(`/tasks/${id}/interrupt`)).then((sent) => {
      if (!sent) return;
      if ('unreachable' in sent) { setStopState({ error: 'The daemon is unreachable; try again once it is back.' }); return; }
      if (sent.ours) whenJobEnds(sent.jobId, (r) => { if (r.ok && shown.current === id && stoppableState(prevState.current)) setStopState('done'); });
    });
  };
  // A click shows the action in progress at once (its button reads it, the bead's other buttons go off) and keeps it until the
  // job ends: its result, or a board that no longer carries it (`lib/jobs.ts`). The acknowledgement follows a job that ended
  // well; a failure is the result toast, and the buttons are back where they were.
  const act = (kind: Action, body?: unknown, ack = ACKS[kind]) => {
    if (running) return;
    const id = card.bead.id;
    setActState('idle');
    void sendAction(id, kind, () => api.post(`/tasks/${id}/${kind}`, body)).then((sent) => {
      if (!sent) return;
      if ('unreachable' in sent) { setActState({ error: 'The daemon is unreachable; try again once it is back.' }); return; }
      if (sent.ours && ack) whenJobEnds(sent.jobId, (r) => { if (r.ok && shown.current === id) setActState({ ack, action: kind }); });
    });
  };
  // Close bead: the way out for a bead that is idle and no longer wanted (stopped, verify-failed, never dispatched) that does not abandon
  // its batch (round 13: the card sent the user to Chat and the orchestrator sent them back to the card). One question in the pane asks
  // and takes the optional note for the orchestrator; Cancel does nothing.
  // In the pane, not in a native `prompt()`: an embedded browser (a sandboxed iframe, a webview) answers `prompt()` with null without
  // showing it, and the handler took that for Cancel, so the button did nothing at all: no request, no word (overseer-f63).
  // The dialog and the acknowledgement name the bead the way the card does — title and id — and both drop the batch clause for a
  // bead that belongs to no batch this install knows (round 18: the line said "the batch stays open" for a batchless bead).
  // A batch that is no longer open does not stay open: the clause names its status instead, the way the daemon's own notice does
  // (`lifecycle.ts`, fix round 18 review M1: a never-dispatched bead of a merged batch was told "batch r1-b1 stays open").
  // "batch <id> stays open" was true for a second when the bead was the batch's last unresolved one: the orchestrator hands the
  // batch over as soon as it hears of the close, and the Board had it in Review on the next refresh (round 26 nit). The counts the
  // batch row already shows say which of the two it is.
  // The title is quoted with curly quotes: the orchestrator writes titles that carry `"` themselves (`Add r26b.txt containing "b"`),
  // and the straight pair nested three deep in one line (round 26 nit).
  const closeWords = () => {
    const batch = card.batch_id ? board.repos.find((r) => r.repo.id === card.repo_id)?.batches.find((b) => b.id === card.batch_id) ?? null : null;
    const open = batch?.status === 'open';
    const lastOpen = !!batch && batch.beads_done + batch.beads_closed + 1 >= batch.beads_total;
    const clause = !batch ? ''
      : !open ? `; its batch ${batch.id} is ${batchStatusLabel(batch.status)}`
      : lastOpen ? `; batch ${batch.id} then has no bead left open, so the orchestrator hands it over for review`
      : `; batch ${batch.id} stays open and counts it as closed`;
    const ack = !batch ? undefined
      : !open ? `Closed as won't do; the orchestrator was told; its batch ${batch.id} is ${batchStatusLabel(batch.status)}.`
      : lastOpen ? `Closed as won't do; batch ${batch.id} has no bead left open and the orchestrator hands it over for review.`
      : `Closed as won't do; the orchestrator was told and batch ${batch.id} stays open.`;
    return { question: `Close “${card.bead.title}” (${card.bead.id}) as won't do? Its branch and worktree are removed${clause}.`, ack };
  };
  const confirmClose = () => {
    const words = closeWords();
    if (!words || closing === null) return;
    const note = closing.trim();
    setClosing(null);
    act('close', note ? { note } : undefined, words.ack);
  };
  // Land anyway: the bead lands with the critic's open findings recorded; the note says why they are acceptable. Same in-pane question as Close bead.
  const confirmLand = () => {
    if (landing === null) return;
    const note = landing.trim();
    setLanding(null);
    act('accept-review', { note });
  };
  const ack = typeof actState === 'object' && 'ack' in actState ? actState.ack : null;
  // What this target's action buttons are waiting on: the daemon's running job (from the board, so a reload keeps it) or the
  // action this pane asked for, until its job ends. The button for it reads the action in progress; every other action button is disabled.
  const pendingAction = running?.action ?? held;
  const label = (kind: Action, text: string) => (kind === pendingAction ? pendingLabel(pendingAction) : text);
  const blocked = !!offline || pendingAction !== null;
  // Parked with the critic's findings after the last review round: the user decides between a new worker, dropping the bead and landing as is.
  const awaiting = card.state === 'awaiting_decision';
  // The two ways forward for a branch with commits that has not landed: run the command again (it was wrong), or a new worker (the work was).
  // Offered in the two states where nothing runs on the bead and it has not landed (`verify_failed`, `idle`; the latter covers a
  // re-dispatched worker that added nothing and a fixed verify command, round 6), never while it runs, settles or is verified. A
  // v1 bead in review with a failed verification is `verify_failed` too: Review offers Merge and Reject there, not a re-run.
  const canAct = (card.state === 'verify_failed' || card.state === 'idle') && !!detail?.worktree && !detail.worktree.merged_at && !!detail.diff;
  // The same Re-dispatch for a bead whose worker left nothing on the branch (stopped before it committed, crashed, wrote nothing):
  // there is no run to retry, so Retry verification is not offered, but starting a new worker is the obvious next act and the
  // neighbouring state has it one click away (round 26 R26-1: the pane sent the user to Chat and a whole orchestrator turn for it).
  const canRedispatch = card.state === 'idle' && !!last && !!detail?.worktree && !detail.worktree.merged_at && !detail.diff;
  // Close bead is offered in the same two states, and on a blocked bead, for any bead that has not landed, branch or no branch: nothing
  // runs on it and it can be dropped. A blocked one had no way out of the UI at all (round 25 R25-4: the pane's only button was the close X).
  const canClose = (card.state === 'verify_failed' || card.state === 'idle' || card.state === 'blocked' || card.state === 'awaiting_decision') && !!detail && !detail.worktree?.merged_at;
  // Whether the pane offers anything that writes: the outage sentence belongs under those buttons and nowhere else (Trace, Open batch,
  // Open in Review and the blocker links only read, and stay enabled during an outage).
  const stoppable = card.state === 'running' || card.state === 'reviewing';
  // While a job runs for the bead, the pane keeps offering what it offered when the job started: the pressed button reads the
  // action in progress and its siblings stay, disabled, while the card moves through the states the job causes (a retried
  // verification sits in Verifying for its whole run). The offers follow the card's state again once the job has ended.
  // A pane mounted while the job runs has no such snapshot of its own; it offers the running action's block, so the button
  // reads the action in progress there too.
  const live: Offers = { landedUnclosed: card.state === 'landed_unclosed', canAct, canRedispatch, canClose, awaiting, stoppable };
  const offeredAtJobStart = useRef(live);
  if (pendingAction === null) offeredAtJobStart.current = live;
  const frozen = pendingAction === null ? live : offeredAtJobStart.current;
  const blocks = pendingAction ? BLOCKS_OF[pendingAction] : undefined;
  const offer: Offers = blocks && !blocks.some((b) => frozen[b]) ? { ...frozen, [blocks[0]!]: true } : frozen;
  const anyAction = !!((!ack && (offer.canAct || offer.canRedispatch || offer.canClose || offer.awaiting || offer.landedUnclosed)) || (offer.stoppable && stopState !== 'done'));
  // Which beads a blocked one waits on: `bd list` carries the count alone, the detail names them (round 25 R25-4). Each id opens its
  // own card when the board has one, so the blocker can be read, closed or followed without leaving the Board.
  const blockerIds = (ids: string[]) => ids.flatMap((id, i) => [
    i > 0 ? <span key={`sep-${id}`}>, </span> : null,
    all.some((c) => c.bead.id === id)
      ? <button key={id} className="link" onClick={() => onSelect(id)}>{id}</button>
      : <span key={id} className="mono">{id}</span>,
  ]);
  return (
    <aside className="detail" ref={pane} tabIndex={-1} aria-label={`Details of ${card.bead.id}`} aria-busy={!detail && !loadFailed}>
      {/* A pane opened from a batch keeps Back to batch in both layouts; other panes use Back on phones and the close icon on desktop. */}
      <div className="detail-head">
        <button className={`link detail-back${onBackToBatch ? ' detail-back-to-batch' : ''}`} onClick={onBackToBatch ?? onClose} aria-label={onBackToBatch ? 'Back to batch' : 'Back to board'}>{onBackToBatch ? '‹ Back to batch' : '‹ Back'}</button>
        <span className="mono muted">{card.bead.id}</span>
        <button className="link detail-close" onClick={onClose} aria-label="Close details" title="Close details">×</button>
      </div>
      <h2>{card.bead.title} <span className="muted mono">{card.bead.id}</span></h2>
      <section className="detail-card-meta" aria-label="Card details">
        <div><span>Branch</span><code>{card.branch ?? 'None'}</code></div>
        <div><span>Batch</span><code>{card.batch_id ?? 'None'}</code></div>
        <div><span>Cost</span><span>{card.cost !== null ? fmtCost(card.cost)
          // "cost unknown" says the worker was stopped or crashed; a live or settling session has simply not reported yet.
          : card.state !== 'settling' && (card.session_status === 'ended' || card.session_status === 'failed') ? <span title={COST_UNKNOWN_TITLE}>cost unknown</span>
          : <span className="muted">not reported yet</span>}</span></div>
        <div><span>Tier</span><span>{card.tier ?? 'None'}</span></div>
        {(card.state === 'running' || card.state === 'verifying') && card.account_name && <div><span>Account</span><span>{`${card.account_name}${card.account_label ? ` (${card.account_label})` : ''}`}</span></div>}
        <div><span>Flags</span><span>{[
          card.bead.labels.includes('overseer:verified') && 'verified',
          card.bead.labels.includes('overseer:worker-reported') && 'worker-reported',
          fromBd(card) && 'from bd',
          card.bead.labels.includes('overseer:closed') && 'closed',
          card.bead.labels.includes('overseer:abandoned') && 'abandoned',
        ].filter(Boolean).join(', ') || 'None'}</span></div>
      </section>
      <p className="pre">{description ? <PlainText text={description} /> : '(no description)'}</p>
      {!detail && loadFailed && <p className="badge-warn" role="alert"><span>Could not load details ({loadFailed}).</span> <button className="link" onClick={() => setLoadRetry((n) => n + 1)}>Retry</button></p>}
      {/* A refetch that failed keeps what is shown and says so, like Review's batch pane (fix round 15 review). */}
      {detail && loadFailed && <p className="muted" role="status"><span>Showing the last known details; they could not be refreshed ({loadFailed}).</span> <button className="link" onClick={() => setLoadRetry((n) => n + 1)}>Retry</button></p>}
      {/* The fetched blocks arrive together, so they shimmer as one: History, the last assistant text and the verification output. */}
      <Loading loading={!detail && !loadFailed} label="Loading details…" placeholder={<DetailPlaceholder card={card} />}>
        <>
          {/* Notes are the bead's log, oldest first; a re-dispatch adds its own line, so the last line is the current state. */}
          {detail?.bead.notes && <><h4>History</h4><pre><PlainText text={detail.bead.notes} /></pre></>}
          {detail?.last_assistant_text && <><h4>Last assistant text</h4><p className="pre"><PlainText text={detail.last_assistant_text} /></p></>}
          {/* While a worker or a verification is running, that output is the last finished run's, not this one's: the card's chip is
              hidden for the same reason (fix round 21 review NB-2: the pane read "Verification: failed" for the whole life of a re-dispatched worker). */}
          {detail?.worktree?.verify_output && <><h4>{verifyIsPrevious(card.state) ? 'Previous verification' : 'Verification'}: {detail.worktree.verify_status === 'fail' ? 'failed' : detail.worktree.verify_status === 'pass' ? verifyPassLabel(detail.worktree.verify_output !== NO_VERIFY_RUN) : detail.worktree.verify_status}</h4>{detail.worktree.verify_output !== NO_VERIFY_RUN && <pre>{detail.worktree.verify_output}</pre>}</>}
        </>
      </Loading>
      {/* The worker has exited and the session-end rule has not finished: nothing is actionable for a few seconds, and the pane says so like the card does. */}
      {card.state === 'settling' && stopState === 'idle' && <p className="muted">settling… The worker has exited; the bead moves on in a moment.</p>}
      {/* A critic reads the branch against the worker's instructions; like a verification, nothing but Stop is actionable until it ends. */}
      {card.state === 'reviewing' && <p className="muted">reviewing… {card.model ? `a ${card.model} critic` : 'a critic'} is checking the change; the bead lands if it passes, or comes back here with its findings.</p>}
      {awaiting && card.findings && (
        <>
          <h4>Open findings</h4>
          <ul className="findings">
            {card.findings.map((f, i) => <li key={i}><span className={f.severity === 'must' ? 'chip fail' : 'chip'}>{f.severity}</span>{f.file && <code>{f.file}</code>} {f.summary}</li>)}
          </ul>
        </>
      )}
      {fromBd(card) && <p className="muted">{fromBdTitle(card)}</p>}
      {ack && <p className="muted" role="status">{ack}</p>}
      {/* Landed on the batch branch while bd could not record the close: nothing to re-run, only the close to retry (fix round 16 review). */}
      {offer.landedUnclosed && !ack && (
        <div className="detail-actions">
          <button disabled={blocked} onClick={() => act('close-landed')}>{label('close-landed', 'Retry close')}</button>
          <span className="muted">Its work is merged into the batch branch, but bd could not record the close, so bd still has it in Verifying. Retry closes it in bd; the daemon also retries when it restarts.</span>
        </div>
      )}
      {offer.canAct && !ack && (
        <div className="detail-actions">
          <button disabled={blocked} onClick={() => act('verify')}>{label('verify', 'Retry verification')}</button>
          <button disabled={blocked} onClick={() => act('redispatch')}>{label('redispatch', 'Re-dispatch')}</button>
          <span className="muted">Retry runs the verify command again on the branch as it is (the command was wrong); Re-dispatch starts a new worker on it (the work was).</span>
        </div>
      )}
      {/* A bead whose last worker ended without leaving anything on the branch: nothing to verify, so only the new worker is offered. */}
      {offer.canRedispatch && stopState === 'idle' && !ack && (
        <div className="detail-actions">
          <button disabled={blocked} onClick={() => act('redispatch', undefined, ACK_REDISPATCH_EMPTY)}>{label('redispatch', 'Re-dispatch')}</button>
          <span className="muted">Nothing runs on this bead and its branch has no commits, so there is nothing to verify: Re-dispatch starts a new worker on it, and Close bead drops it.</span>
        </div>
      )}
      {/* The critic's last round left findings: a new worker takes them on, or the change lands as it is with a note saying why that is fine; Close bead sits with the other buttons below. */}
      {offer.awaiting && !ack && landing === null && (
        <div className="detail-actions">
          <button disabled={blocked} onClick={() => act('redispatch', undefined, ACK_REDISPATCH_EMPTY)}>{label('redispatch', 'Re-dispatch')}</button>
          <button disabled={blocked} onClick={() => setLanding('')}>{label('accept-review', 'Land anyway')}</button>
          <span className="muted">Re-dispatch starts a new worker on the branch (the findings stay in History); Land anyway merges the branch as it is and records the findings as accepted; Close bead drops it.</span>
        </div>
      )}
      {offer.awaiting && !ack && landing !== null && (
        <div className="detail-actions close-confirm">
          <span>Land “{card.bead.title}” ({card.bead.id}) with its open findings? They are recorded as accepted with your note.</span>
          <input aria-label="Why the findings are acceptable (optional)" placeholder="Optional note: why the findings are acceptable" value={landing} onChange={(e) => setLanding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmLand(); }} autoFocus />
          <button className="primary" disabled={blocked} onClick={confirmLand}>Confirm land</button>
          <button onClick={() => setLanding(null)}>Cancel</button>
        </div>
      )}
      {typeof actState === 'object' && 'error' in actState && <p className="badge-warn" role="alert">{actState.error}</p>}
      {offer.canClose && !ack && closing !== null && (
        <div className="detail-actions close-confirm">
          <span>{closeWords()?.question}</span>
          <input aria-label="Note for the orchestrator (optional)" placeholder="Optional note for the orchestrator" value={closing} onChange={(e) => setClosing(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmClose(); }} autoFocus />
          <button className="danger" disabled={blocked} onClick={confirmClose}>Confirm close</button>
          <button onClick={() => setClosing(null)}>Cancel</button>
        </div>
      )}
      <div className="detail-actions">
        {/* The critic is the running session of a reviewing bead, so the same Stop reaches it. */}
        {offer.stoppable && stopState !== 'done' && <button className="danger" disabled={blocked} onClick={stop}>{label('interrupt', 'Stop worker')}</button>}
        {/* A critic stopped mid-review has no verdict to apply: the daemon reopens the bead without landing (`lifecycle.ts`). */}
        {stopState === 'done' && card.state === 'reviewing' && <span className="muted">Stop requested. Once the critic exits the bead goes back to Ready without landing; the stop is recorded in History.</span>}
        {/* Both outcomes, because the daemon decides between them by what is on the branch when the worker exits: a stop that
            arrives after the worker has committed lands the work and the card went to Review under a line promising Ready (round 20 R20-1). */}
        {stopState === 'done' && card.state !== 'reviewing' && <span className="muted">Stop requested. Once the worker exits the card moves back to Ready, unless it had already committed: then its work stays on the branch and the bead goes on to verification. Either way the stop is recorded in History.</span>}
        {typeof stopState === 'object' && <span className="badge-warn">Stop failed: {stopState.error}</span>}
        {/* Blocked: the bead waits on a dependency. The detail names the beads; until it has loaded (or when the bd read failed) the card's own count stands, as it did before (fix round 12 review, round 25 R25-4). */}
        {card.state === 'blocked' && <span className="muted">Blocked: waits on {detail?.blocked_by.length ? blockerIds(detail.blocked_by) : card.bead.dependency_count === 1 ? 'another bead' : `${card.bead.dependency_count} other beads`} to close; the orchestrator dispatches it once it is ready.</span>}
        {offer.canClose && !ack && closing === null && <button className="danger" disabled={blocked} onClick={() => setClosing('')}>{label('close', 'Close bead')}</button>}
        {detail?.bead.labels.includes('overseer:review') && <button className="primary" onClick={() => onOpenReview(detail.bead.id)}>Open in Review</button>}
        {/* The card knows the batch of a never-dispatched bead (its label); the worktree row exists only after a dispatch (round 16). */}
        {(card.batch_id ?? detail?.worktree?.batch_id) && <button onClick={() => onOpenBatch((card.batch_id ?? detail!.worktree!.batch_id)!)}>Open batch {card.batch_id ?? detail?.worktree?.batch_id}</button>}
        {last && <button onClick={() => setTrace((t) => !t)} aria-expanded={trace}>{trace ? 'Hide trace' : 'Trace'}</button>}
        {offline && anyAction && <span className="muted">{OFFLINE_ACTIONS}</span>}
      </div>
      {trace && last && <Trace sessionId={last.id} status={last.status} endedAt={last.ended_at} refresh={version + (eventTicks?.[last.id] ?? 0)} />}
    </aside>
  );
}
