import type { Plan as PlanT } from '@overseer/shared';
import { Loading } from '../components/Loading';

/**
 * Two rows: the list is every plan of every status, so it is rarely empty and rarely long, and two rows is the height the
 * user's own install arrived at in the delayed-response measurement. A row is a fixed two-line box, so the count is the only
 * free variable; one undershot the arrived height and three overshot it.
 */
function PlanListPlaceholder() {
  const rows = [{ title: 'Accounts and credentials', detail: 'draft · 4 steps' }, { title: 'Shimmer the loading states', detail: 'approved · 6 steps' }];
  return (
    <ul className="needs-list">
      {rows.map((r) => (
        <li key={r.title}>
          <span className="needs-row">
            <span className="needs-mark needs-mark-plan" aria-hidden="true">✎</span>
            <span className="needs-text">
              <span className="needs-title">{r.title}</span>
              <span className="needs-context">
                <span className="needs-repo">overseer</span>
                <span className="needs-detail">{r.detail}</span>
              </span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every plan the daemon knows about, newest first, so a draft, approved or discarded plan is all reachable from one place
 * (the Plans entry on the Office strip) rather than only while it happens to be a draft.
 */
export function PlanList({ plans, loading = false, onOpen }: { plans: PlanT[] | null; loading?: boolean; onOpen: (id: string) => void }) {
  const list = plans ?? [];
  return (
    <div className="plan-list needs">
      <h2>Plans</h2>
      {/* "No plans yet." is an answer the unloaded state cannot give: `plans` is null until the fetch lands. A failed first
          fetch is not loading either, so App stops passing `loading` then and the outage line stands alone. */}
      <Loading loading={loading} label="Loading the plans…" placeholder={<PlanListPlaceholder />}>
      {list.length === 0
        ? <p className="muted">No plans yet.</p>
        : (
          <ul className="needs-list">
            {list.map((p) => (
              <li key={p.id}>
                <button type="button" className="needs-row" aria-label={`${p.title}, ${p.status}, ${p.steps.length} ${p.steps.length === 1 ? 'step' : 'steps'}`} onClick={() => onOpen(p.id)}>
                  <span className="needs-mark needs-mark-plan" aria-hidden="true">✎</span>
                  <span className="needs-text">
                    <span className="needs-title">{p.title}</span>
                    <span className="needs-context">
                      <span className="needs-repo">{p.repo_id}</span>
                      <span className="needs-detail">{p.status} · {p.steps.length} {p.steps.length === 1 ? 'step' : 'steps'}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Loading>
    </div>
  );
}
