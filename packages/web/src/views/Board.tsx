import { useEffect, useState } from 'react';
import type { BatchSummary, BoardCard, BoardColumn, BoardResponse } from '@overseer/shared';
import { Card, pressable } from '../components/Card';
import { Activity } from '../components/Activity';
import { BatchRow, beadsLabel, FINISHED_MAX } from '../components/BatchRow';
import { Loading } from '../components/Loading';
import { needsUser } from '../lib/needsYou';
import { TaskPane } from './TaskPane';

export const BOARD_COLUMNS: { key: BoardColumn; label: string }[] = [
  { key: 'ready', label: 'Ready' }, { key: 'blocked', label: 'Blocked' }, { key: 'running', label: 'Running' },
  { key: 'verifying', label: 'Verifying' }, { key: 'review', label: 'Review' }, { key: 'done', label: 'Done' },
];
/** Done keeps every bead Overseer handled; only the newest few render until the user asks for the rest. */
export const DONE_CAP = 6;

const isFinished = (b: BatchSummary) => b.status === 'merged' || b.status === 'abandoned';
const failedFirst = (a: BoardCard, b: BoardCard) => Number(needsUser(b)) - Number(needsUser(a));

/** Cards per placeholder column: the board's own columns rarely hold more than a couple at once, and two rows is the height a column settles at. */
const PLACEHOLDER_CARDS = 2;
/** The board as it arrives: one repo section with its batch row, its column switcher and its columns of cards. */
function BoardPlaceholder() {
  return (
    <>
      {/* The activity state is unknown until this response. `.activity-empty` has the same reserved footprint as one running row, so either arrived state starts the repository at the same position. */}
      <div className="activity-empty" data-shimmer-no-children>No workers running.</div>
      <section>
        <div className="board-repo"><h2 data-shimmer-no-children>overseer</h2><span className="mono muted" data-shimmer-no-children>main</span></div>
        <div className="batches">
          {Array.from({ length: 2 }, (_, i) => <div key={i} className="batch">
            {/* Both lines wrap, so the row's height is the line count, not the character count: these two strings are as long as the
                worst case an orchestrator writes (a 140-character sentence, a 99-character branch) and break the same way, so they
                wrap to the same 6/5/2/7/2 title lines and 5/5/2/5/1 branch lines at 390/440/767/768/1440 that the row settles at. */}
            <div><div className="batch-title" data-shimmer-no-children>A batch title as long as the longest one an orchestrator writes: a whole sentence that wraps across several lines in the narrow phone layout</div><div className="mono muted" data-shimmer-no-children>feature/board-loading-placeholder-matches-the-arrived-repository-section-height-at-every-breakpoint → main</div></div>
            <div><div className="progress" data-shimmer-no-children><div data-shimmer-no-children style={{ width: '50%' }} /></div><div className="mono muted" data-shimmer-no-children>10/12</div></div>
            <span className="mono" data-shimmer-no-children>$123456.78</span>
            <span className="chip open" data-shimmer-no-children>in progress</span>
          </div>)}
        </div>
        <details className="batches-finished"><summary data-shimmer-no-children>100 finished batches (newest 20 shown)</summary></details>
        <div className="column-tabs" role="tablist" aria-label="Columns">{BOARD_COLUMNS.map((col, i) => <button key={col.key} type="button" role="tab" aria-selected={i === 0}>{col.label} <span className="count">12</span></button>)}</div>
        <div className="columns">
          {BOARD_COLUMNS.map((col) => (
            <div key={col.key} className={`column ${col.key}${col.key === 'ready' ? ' column-selected' : ''}`}>
              <h3 data-shimmer-no-children>{col.label} (12)</h3>
              {Array.from({ length: PLACEHOLDER_CARDS }, (_, i) => (
                <div key={i} className="card">
                  <div className="card-title-row"><div className="card-title" data-shimmer-no-children>A task with a representative board title</div><span className="mono muted card-id" data-shimmer-no-children>ov-100</span></div>
                  <div className="card-meta"><span className="chip" data-shimmer-no-children>Ready</span><span className="chip card-agent" data-shimmer-no-children>codex · gpt-5.6-sol</span><span className="card-elapsed" data-shimmer-no-children>last run 12m 34s</span></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

interface Props {
  /** The last board App fetched; null only before the first response. */
  board: BoardResponse | null;
  /** When App fetched `board` (ms); elapsed times tick from it, so a remount does not reset them. */
  boardAt: number;
  version: number;
  /** The daemon is unreachable: elapsed times stop, since nothing is known to be running any more. */
  offline?: boolean;
  /** A board fetch is in flight: the previous board stays and a small note says it is being refreshed (a build takes one to two seconds). */
  refreshing?: boolean;
  /** Per session, a counter the app shell bumps (throttled) while that session records events; an open Trace of a live session refetches on it. */
  eventTicks?: Record<string, number>;
  /** A repo picked in the rail; `onJumped` clears it once scrolled, so a later visit does not scroll again. */
  jumpTo?: string | null;
  onJumped?: () => void;
  onOpenReview: (beadId: string) => void;
  onOpenBatch: (batchId: string) => void;
  /** The card whose pane is open when the view mounts, and every change of it: the shell keeps it in the URL hash, so a reload (or a return to the Board) reopens the pane (round 16). */
  initialSelected?: string | null;
  onSelected?: (beadId: string | null) => void;
}

export function Board(p: Props) {
  const board = p.board;
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelectedState] = useState<string | null>(() => p.initialSelected ?? null);
  const setSelected = (id: string | null) => { setSelectedState(id); p.onSelected?.(id); if (id) setGone(null); };
  // A `#board/<id>` naming a bead this board has no card for used to rewrite the hash and close the pane without a word; the id is
  // named instead, so a bookmark that stopped working says why (round 21 nit).
  const [gone, setGone] = useState<string | null>(null);
  // The shell's hash stays the source of truth after mount too: a `#board/<id>` that lands while this view is up opens the pane
  // (round 17: the hash named a card and no pane was open; a selection made here is reported up, so this never loops).
  const initialSelected = p.initialSelected ?? null;
  // Opening a card clears the line, whether the user clicked it or the shell's hash named it (fix round 21 review NB-3: a hash-driven
  // selection left "No card for <id>" standing above the pane of the card it had just opened).
  useEffect(() => { setSelectedState(initialSelected); if (initialSelected) setGone(null); }, [initialSelected]);
  const [allDone, setAllDone] = useState<Record<string, boolean>>({});
  // Per repo, the column the phone layout shows (one at a time, picked in the switcher above the columns); unset until the user
  // picks, so the default follows the board: the first column with cards, or Ready. Desktop shows every column and ignores it.
  const [colPick, setColPick] = useState<Record<string, BoardColumn>>({});

  useEffect(() => { setNow(Date.now()); }, [board]);
  // Elapsed times come from the last board payload; tick them locally while a worker runs.
  const anyRunning = board?.repos.some((r) => r.cards.some((c) => c.session_status === 'running')) ?? false;
  const ticking = anyRunning && !p.offline;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  // Closing hands focus back to the card that opened the pane, so a keyboard user does not restart from the rail.
  const close = () => {
    const card = selected ? document.querySelector<HTMLElement>(`[data-bead="${selected}"]`) : null;
    setSelected(null);
    card?.focus();
  };
  const hasBoard = board !== null;
  const { jumpTo, onJumped } = p;
  useEffect(() => {
    if (!jumpTo || !hasBoard) return;
    const target = document.getElementById(jumpTo.startsWith('batch:') ? `batch-${jumpTo.slice(6)}` : `repo-${jumpTo}`);
    const finished = target?.closest('details');
    if (finished) finished.open = true;
    target?.scrollIntoView?.({ block: 'start' });
    onJumped?.();
  }, [jumpTo, hasBoard, onJumped]);

  const tick = (c: BoardCard): BoardCard => (c.session_status === 'running' && c.elapsed_ms !== null ? { ...c, elapsed_ms: c.elapsed_ms + Math.max(0, now - p.boardAt) } : c);
  const all = board?.repos.flatMap((r) => r.cards).map(tick) ?? [];
  const card = selected ? all.find((c) => c.bead.id === selected) ?? null : null;
  // A refresh can drop the selected card (an abandoned batch's bead, a closed one past the cap); the pane closes with it instead of keeping a stale selection.
  const cardGone = selected !== null && hasBoard && card === null;
  useEffect(() => { if (cardGone) { setGone(selected); setSelected(null); } }, [cardGone]);

  if (!board) return (
    <div className="board-layout">
      <div className="board">
        {/* Once the first board fetch has failed the shimmer stops: invented columns for a whole outage are worse than the line. */}
        <Loading loading={!p.offline} label="Loading board…" placeholder={<BoardPlaceholder />}><div>Loading board…</div></Loading>
      </div>
    </div>
  );
  return (
    <div className="board-layout">
      <div className="board">
        {!board.bd_ok && <div className="banner-warn">bd unavailable: install it with <code>npm install -g @beads/bd</code> and restart the daemon. Workers cannot be dispatched until then.</div>}
        <Activity cards={all} refreshing={p.refreshing} />
        {gone && <p className="muted" role="status">No card for {gone} on the Board: no registered repository has that bead any more.</p>}
        {board.repos.length === 0 && <p className="muted">No repositories yet. Add one in Setup, then ask the orchestrator for work in Chat.</p>}
        {board.repos.map(({ repo, batches, cards }) => {
          const live = batches.filter((b) => !isFinished(b));
          const finishedAll = batches.filter(isFinished).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          const finished = finishedAll.slice(0, FINISHED_MAX);
          const count = (key: BoardColumn) => cards.filter((c) => c.column === key).length + (key === 'review' ? live.filter((b) => b.status === 'review').length : 0);
          const picked: BoardColumn = colPick[repo.id] ?? BOARD_COLUMNS.find((col) => count(col.key) > 0)?.key ?? 'ready';
          return (
            <section key={repo.id} id={`repo-${repo.id}`}>
              <div className="board-repo"><h2>{repo.id}</h2><span className="mono muted">{repo.base_branch}</span></div>
              {live.length > 0 && <div className="batches">{live.map((b) => <BatchRow key={b.id} batch={b} onClick={() => p.onOpenBatch(b.id)} />)}</div>}
              {finished.length > 0 && (
                <details className="batches-finished">
                  <summary>{finishedAll.length} finished {finishedAll.length === 1 ? 'batch' : 'batches'}{finishedAll.length > finished.length ? ` (newest ${finished.length} shown)` : ''}</summary>
                  <div className="batches">{finished.map((b) => <BatchRow key={b.id} batch={b} onClick={() => p.onOpenBatch(b.id)} />)}</div>
                </details>
              )}
              <div className="column-tabs" role="tablist" aria-label={`Columns of ${repo.id}`}>
                {BOARD_COLUMNS.map((col) => (
                  <button key={col.key} role="tab" aria-selected={col.key === picked} className={col.key === picked ? 'active' : ''} onClick={() => setColPick({ ...colPick, [repo.id]: col.key })}>
                    {col.label} <span className="count">{count(col.key)}</span>
                  </button>
                ))}
              </div>
              <div className="columns">
                {BOARD_COLUMNS.map((col) => {
                  const inCol = cards.filter((c) => c.column === col.key).map(tick).sort(failedFirst);
                  // Batches in review are what the Review badge counts; their beads are already Done, so the column shows the batch itself.
                  const reviewBatches = col.key === 'review' ? live.filter((b) => b.status === 'review') : [];
                  const expanded = col.key !== 'done' || allDone[repo.id] || inCol.length <= DONE_CAP;
                  const shown = expanded ? inCol : inCol.slice(0, DONE_CAP);
                  return (
                    <div key={col.key} className={`column ${col.key}${col.key === picked ? ' column-selected' : ''}`}>
                      <h3>{col.label} ({inCol.length + reviewBatches.length})</h3>
                      {reviewBatches.map((b) => (
                        <div key={b.id} className="card card-batch" {...pressable(() => p.onOpenBatch(b.id))}>
                          <div className="card-title">{b.title}</div>
                          <div className="card-meta"><span className="muted">{b.id}</span><span>{beadsLabel(b)} beads</span><span className="chip review">batch</span></div>
                        </div>
                      ))}
                      {shown.map((c) => <Card key={c.bead.id} card={c} selected={c.bead.id === selected} onClick={() => setSelected(c.bead.id)} />)}
                      {col.key === 'done' && inCol.length > DONE_CAP && (
                        <button className="link" onClick={() => setAllDone({ ...allDone, [repo.id]: !allDone[repo.id] })}>{allDone[repo.id] ? 'Show fewer' : `Show ${inCol.length - DONE_CAP} more`}</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {card && <TaskPane beadId={card.bead.id} board={board} version={p.version} eventTicks={p.eventTicks} offline={p.offline} onSelect={setSelected} onClose={close} onOpenReview={p.onOpenReview} onOpenBatch={p.onOpenBatch} />}
    </div>
  );
}
