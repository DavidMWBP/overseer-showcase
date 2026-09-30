import type { BoardCard } from '@overseer/shared';
import { fmtCost, fmtElapsed } from '../api';

const CAP_MS = 60 * 60_000;
const MAX_ROWS = 3;

export function Activity(p: { cards: BoardCard[]; refreshing?: boolean }) {
  // The strip uses the Running column, and its count line carries the rows beyond the first three, so its total agrees
  // with the column and rail. A card whose worker has exited but whose bead has not settled yet (the session-end rule
  // takes a moment) reads "settling" instead of vanishing from the strip.
  const running = p.cards
    .filter((c) => c.column === 'running')
    .sort((a, b) => (b.elapsed_ms ?? 0) - (a.elapsed_ms ?? 0));
  // A board build takes one to two seconds (one `bd list` per repo); the previous board stays and this says a newer one is coming.
  // Not a live region: a mounted `role=status` whose text changes is announced on every socket-driven fetch (fix round 8 review); the note is visual, the strip is already a named region.
  const refreshing = <span className="muted refreshing">{p.refreshing ? 'refreshing…' : ''}</span>;
  if (running.length === 0) return <div className="activity-empty">No workers running. {refreshing}</div>;
  return (
    <section className="activity" role="region" aria-label="Running workers">
      {refreshing}
      {running.slice(0, MAX_ROWS).map((c) => (
        <div key={c.bead.id} className="activity-row">
          <span className="activity-title" title={c.bead.title}>{c.bead.title}</span>
          <div className="activity-bar"><div style={{ width: `${Math.min(100, ((c.elapsed_ms ?? 0) / CAP_MS) * 100)}%` }} /></div>
          {c.state === 'running' ? <span className="mono">{fmtElapsed(c.elapsed_ms)}</span> : <span className="mono muted">settling…</span>}
          <span className="mono">{fmtCost(c.cost)}</span>
        </div>
      ))}
      {running.length > MAX_ROWS && <div className="activity-more muted">and {running.length - MAX_ROWS} more running</div>}
    </section>
  );
}
