import { useEffect, useState } from 'react';
import { Loading } from '../components/Loading';
import { usePhoneLayout } from '../lib/phoneLayout';
import type { NeedsYouItem, NeedsYouKind } from '../lib/needsYou';

/** One character per kind, so the list is scannable before it is read. The marker carries the colour; the text stays plain. */
const MARK: Record<NeedsYouKind, string> = { plan: '✎', repo: '⏸', question: '?', decision: '!', batch: '→', failed: '×' };
const WHAT: Record<NeedsYouKind, string> = { plan: 'plan', repo: 'paused', question: 'question', decision: 'decision', batch: 'batch', failed: 'verification' };

/**
 * One placeholder row of the strip, so it measures the same box as an arrived row rather than an approximation of it. The
 * title's text sits in its own span, so its shimmer bar is as long as a title rather than as wide as the row.
 */
function Row({ kind, mark, title, repo, detail }: { kind: string; mark: string; title: string; repo?: string; detail: string }) {
  return (
    <span className="needs-row" data-kind={kind}>
      <span className={`needs-mark needs-mark-${kind}`} aria-hidden="true">{mark}</span>
      <span className="needs-text">
        <span className="needs-title"><span>{title}</span></span>
        <span className="needs-context">
          {repo && <span className="needs-repo">{repo}</span>}
          <span className="needs-detail">{detail}</span>
        </span>
      </span>
    </span>
  );
}

function PlanRow({ draftPlans, onOpenPlans }: { draftPlans: number; onOpenPlans?: () => void }) {
  return (
    <button type="button" className="needs-row office-plans-row" data-kind="plan" aria-label="plans" onClick={onOpenPlans}>
      <span className="needs-mark needs-mark-plan" aria-hidden="true">{MARK.plan}</span>
      <span className="needs-text">
        <span className="needs-title">Plans</span>
        <span className="needs-context"><span className="needs-detail">{draftPlans === 0 ? 'No draft plans' : `${draftPlans} ${draftPlans === 1 ? 'draft plan' : 'draft plans'}`}</span></span>
      </span>
    </button>
  );
}

/** How many item rows the strip showed the last time it loaded in this browser, so the placeholder reserves that many. */
export const STRIP_ROWS_KEY = 'overseer.officeStripRows';

/** The stored count, or 1 when nothing (or no whole non-negative number) is stored. */
export function storedStripRows(): number {
  try {
    const raw = localStorage.getItem(STRIP_ROWS_KEY);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 1;
  } catch { return 1; }
}

export function rememberStripRows(n: number): void {
  try { localStorage.setItem(STRIP_ROWS_KEY, String(n)); } catch { /* storage unavailable */ }
}

/** How many item rows show before the `+N more` control: fewer on a phone, where each row takes the full width. */
export const PHONE_CAP = 3;
export const DESKTOP_CAP = 6;

/**
 * The loaded strip's shapes: the Plans row as a span (the library paints a button as one solid box, where the arrived row
 * shows an icon, a title and a sub line), then as many item rows as the strip showed last time, capped as the arrived strip is
 * and followed by the `+N more` control's shape when the stored count is over the cap. The sub line claims no count, since a
 * placeholder must not read as an answer.
 */
function NeedsPlaceholder({ rows: stored, cap }: { rows: number; cap: number }) {
  const rows = Math.min(stored, cap);
  return (
    <div className="office-needs-content">
      <span className="needs-row office-plans-row" data-kind="plan">
        <span className="needs-mark needs-mark-plan" aria-hidden="true">{MARK.plan}</span>
        <span className="needs-text">
          <span className="needs-title"><span>Plans</span></span>
          <span className="needs-context"><span className="needs-detail">Draft plans</span></span>
        </span>
      </span>
      {rows > 0 && (
        <section className="office-needs-strip" aria-label="Needs you">
          <ul className="needs-list">
            {Array.from({ length: rows }, (_, i) => (
              <li key={i}><Row kind="batch" mark={MARK.batch} title="Trend chart on the usage page" repo="overseer" detail="in review" /></li>
            ))}
          </ul>
          {stored > cap && <span className="needs-more">More</span>}
        </section>
      )}
    </div>
  );
}

/**
 * The item rows, the first `cap` of them until the `+N more` control expands the list. The control sits after the list in both
 * states, so it is the same element and keeps focus when it is toggled.
 */
function NeedsItems({ items, cap, expanded, onToggle, onOpen }: {
  items: NeedsYouItem[];
  cap: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (item: NeedsYouItem) => void;
}) {
  if (items.length === 0) return null;
  const hidden = items.length - cap;
  const shown = hidden > 0 && !expanded ? items.slice(0, cap) : items;
  return (
    <section className="office-needs-strip" data-testid="needs-strip" aria-label="Needs you">
      <ul className="needs-list">
        {shown.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <button type="button" className="needs-row" data-kind={item.kind} aria-label={`${WHAT[item.kind]}: ${item.label}`} onClick={() => onOpen(item)}>
              <span className={`needs-mark needs-mark-${item.kind}`} aria-hidden="true">{MARK[item.kind]}</span>
              <span className="needs-text">
                <span className="needs-title">{item.label}</span>
                <span className="needs-context">
                  {item.repoId && <span className="needs-repo">{item.repoId}</span>}
                  <span className="needs-detail">{item.detail}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="needs-more" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Show fewer' : `+${hidden} more`}
        </button>
      )}
    </section>
  );
}

/**
 * The Plans entry stays above the room; actionable items disappear when none need the user. Past the cap the list is capped
 * with a `+N more` control; the expanded state lives only here and collapses while the strip is not `active` (another view
 * shows, the strip stays mounted), so a return or a reload shows the capped list.
 */
export function NeedsStrip({ items, draftPlans = 0, loading = false, active = true, onOpen, onOpenPlans }: {
  items: NeedsYouItem[];
  draftPlans?: number;
  loading?: boolean;
  active?: boolean;
  onOpen: (item: NeedsYouItem) => void;
  onOpenPlans?: () => void;
}) {
  const cap = usePhoneLayout() ? PHONE_CAP : DESKTOP_CAP;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!active) setExpanded(false); }, [active]);
  return (
    <div className="office-needs">
      <Loading loading={loading} label="Loading what needs you…" placeholder={<NeedsPlaceholder rows={storedStripRows()} cap={cap} />}>
        <div className="office-needs-content">
          <PlanRow draftPlans={draftPlans} onOpenPlans={onOpenPlans} />
          <NeedsItems items={items} cap={cap} expanded={expanded} onToggle={() => setExpanded((open) => !open)} onOpen={onOpen} />
        </div>
      </Loading>
    </div>
  );
}
