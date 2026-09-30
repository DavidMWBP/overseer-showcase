import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { planProblem, type Plan as PlanT, type PlanStep } from '@overseer/shared';
import { api, ApiError } from '../api';
import { addStep, moveStep, removeStep, toggleDep } from '../lib/planEdit';
import { Loading } from '../components/Loading';

interface Draft { title: string; steps: PlanStep[] }
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const asDraft = (p: PlanT): Draft => ({ title: p.title, steps: p.steps });
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Follow both typed text and responsive width changes so a wrapping textarea never hides its last line. */
function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string, active = true) {
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const fit = () => {
      const content = field.closest('.plan-content');
      const contentScrollTop = content?.scrollTop;
      // A zero height lets scrollHeight shrink after a deletion or wider resize. Restore the enclosing scroll position
      // immediately afterwards: the temporary collapse otherwise makes the browser clamp it before the textarea grows.
      field.style.height = '0px';
      if (field.scrollHeight === 0) return;
      field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
      // Chromium can round the wrapped content up after the first border-box assignment; close that final pixel gap too.
      if (field.clientHeight < field.scrollHeight) {
        field.style.height = `${field.offsetHeight + field.scrollHeight - field.clientHeight}px`;
      }
      if (content && contentScrollTop !== undefined) content.scrollTop = contentScrollTop;
    };
    fit();
    void document.fonts?.ready.then(fit);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(field);
    return () => observer.disconnect();
  }, [active, ref, value]);
}

function AutoTextarea({ className, label, value, readOnly, onChange, onBlur }: {
  className: string; label: string; value: string; readOnly: boolean; onChange: (value: string) => void; onBlur: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(ref, value);
  return <textarea ref={ref} className={className} aria-label={label} rows={1} value={value} readOnly={readOnly}
    onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />;
}

const breakablePathText = (value: string) => value.split(/([/\\])/).map((part, i) => (
  <Fragment key={i}>{part}{part === '/' || part === '\\' ? <wbr /> : null}</Fragment>
));

/** Read as wrapping text; edit as the exact textarea value sent to the daemon. */
function ReadEditField({ className, label, value, editable, rows, breakPaths = false, onChange, onBlur }: {
  className: string; label: string; value: string; editable: boolean; rows: number; breakPaths?: boolean;
  onChange: (value: string) => void; onBlur: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const editPosition = useRef<{ start: number; end: number; fieldScrollTop: number; contentScrollTop: number } | null>(null);
  useAutoHeight(ref, value, editing);

  useLayoutEffect(() => {
    if (!editing || !ref.current || !editPosition.current) return;
    const position = editPosition.current;
    ref.current.focus({ preventScroll: true });
    ref.current.setSelectionRange(position.start, position.end);
    ref.current.scrollTop = position.fieldScrollTop;
    const content = ref.current.closest('.plan-content');
    if (content) content.scrollTop = position.contentScrollTop;
    editPosition.current = null;
  }, [editing]);

  const textOffset = (root: HTMLElement, node: Node, offset: number) => {
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) return total + offset;
      total += current.textContent?.length ?? 0;
    }
    return value.length;
  };
  const beginEdit = (root: HTMLElement, node: Node | null, offset: number) => {
    const start = node ? textOffset(root, node, offset) : 0;
    editPosition.current = {
      start,
      end: start,
      fieldScrollTop: root.scrollTop,
      contentScrollTop: root.closest('.plan-content')?.scrollTop ?? 0,
    };
    setEditing(true);
  };
  const editAtSelection = (root: HTMLElement) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    beginEdit(root, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  };
  const editAtPoint = (root: HTMLElement, x: number, y: number) => {
    const selection = window.getSelection();
    // Mouseup follows a drag: leave its native selection alone for copying.
    if (selection && !selection.isCollapsed) return;
    const caretDocument = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = caretDocument.caretPositionFromPoint?.(x, y);
    if (position) return beginEdit(root, position.offsetNode, position.offset);
    const range = caretDocument.caretRangeFromPoint?.(x, y);
    if (range) return beginEdit(root, range.startContainer, range.startOffset);
    editAtSelection(root);
  };

  if (editable && editing) {
    return <textarea ref={ref} className={`${className} plan-prose-editor`} aria-label={label} rows={rows} value={value}
      onChange={(e) => onChange(e.target.value)} onBlur={() => { setEditing(false); onBlur(); }} />;
  }
  return (
    <div className="plan-read-field">
      <div className={`${className} plan-prose`} data-testid={`read-${label}`} onMouseUp={(e) => editable && editAtPoint(e.currentTarget, e.clientX, e.clientY)}>
        {breakPaths ? breakablePathText(value) : value}
      </div>
      {editable && <button type="button" className="link plan-edit" onClick={(e) => beginEdit(e.currentTarget.previousElementSibling as HTMLElement, null, 0)}>Edit {label}</button>}
    </div>
  );
}

/** One placeholder step, the same boxes an arrived step renders: a numbered title line, a three-line description and the dependency line. */
function StepPlaceholder({ n, title, description }: { n: number; title: string; description: string }) {
  return (
    <li className="plan-step">
      <div className="plan-step-head">
        <span className="plan-step-n" aria-hidden="true">{n}</span>
        <div className="plan-step-title plan-prose">{title}</div>
      </div>
      <div className="plan-read-field">
        <div className="plan-step-desc plan-prose">{description}</div>
        <span className="link plan-edit">Edit step description</span>
      </div>
      <p className="plan-deps-none muted">Depends on nothing</p>
      <div className="plan-step-actions"><span>Move up</span><span>Move down</span><span>Remove</span></div>
    </li>
  );
}

/**
 * The shape a plan arrives in. Two steps, not one and not four: a proposed plan is two to five steps, the step box is by far the
 * tallest thing on the page, and the delayed-response measurement matched the arrived height at two. Overshooting collapses the
 * page when the real plan lands, which is the same jump in the other direction.
 */
function PlanPlaceholder() {
  return (
    <div className="plan-content">
      <div className="plan-head"><span className="link">Back</span><span className="muted">overseer</span></div>
      <div className="plan-read-field">
        <div className="plan-title plan-prose">Shimmer the loading states instead of a blank</div>
        <span className="link plan-edit">Edit Plan title</span>
      </div>
      <ol className="plan-steps">
        <StepPlaceholder n={1} title="Pass the unloaded state down" description="Hand each view the null a fetch has not answered yet, so it can tell loading from empty instead of collapsing both into an empty list." />
        <StepPlaceholder n={2} title="Reserve the arrived shape" description="Give every view that waits on a fetch a placeholder of the height its content lands at, so nothing on the page moves when it arrives." />
      </ol>
      <span className="plan-add">Add step</span>
      <div className="plan-footer"><span className="plan-problem" /><span>Discard</span><span>Approve plan</span></div>
    </div>
  );
}

/**
 * One plan, edited in place. It is a draft only this page writes, saved on leaving a field (or at once for a structural change)
 * with the revision it was loaded at; a newer save elsewhere answers 409, and the page then keeps the user's text on screen
 * rather than replacing it. Approval hands the plan to the daemon, which creates the batch and its beads.
 */
export function Plan({ id, version, offline, onBack, onOpenBoard }: { id: string; version: number; offline: boolean; onBack: () => void; onOpenBoard: (repoId: string) => void }) {
  const [plan, setPlanState] = useState<PlanT | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Refs hold the newest values between renders: two saves in a row must send the revision the first one returned.
  const planRef = useRef<PlanT | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  // Saves run one at a time: each queued save awaits the one before it, then re-reads the latest plan and draft, so two
  // saves fired close together (a blur followed by Approve) never both read the same stale revision.
  const saveChainRef = useRef<Promise<PlanT | null>>(Promise.resolve(null));
  const setPlan = (p: PlanT) => { planRef.current = p; setPlanState(p); };
  const url = `/plans/${encodeURIComponent(id)}`;

  const load = () => api.get<PlanT>(url, { fresh: true })
    .then((p) => { setPlan(p); setDraft(asDraft(p)); setStale(false); setLoadError(null); setActionError(null); })
    .catch((e: unknown) => setLoadError(text(e)));

  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Something changed a plan: reload only when nothing typed here is unsaved, so a refresh never eats the user's words.
  useEffect(() => {
    if (version === 0) return;
    const p = planRef.current, d = draftRef.current;
    if (p && d && same(d, asDraft(p))) void load();
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) return <div className="plan-load"><button type="button" className="link" onClick={onBack}>Back</button><p className="banner-warn" role="alert">Could not load this plan: {loadError}</p></div>;
  // A load that failed returned above, so reaching here means the fetch is still in flight: the page reserves the shape it will
  // arrive in rather than one line that the whole plan then pushes out of the way.
  if (!plan || !draft) return (
    <div className="plan">
      <Loading loading label="Loading the plan…" placeholder={<PlanPlaceholder />}><p className="muted">Loading plan…</p></Loading>
    </div>
  );

  const editable = plan.status === 'draft' && !stale;
  const problem = planProblem(draft);

  // The queued body of one save: reads the latest plan/draft (not what was current when it was queued), since an earlier
  // save in the chain may have already landed this exact draft.
  const runSave = async (): Promise<PlanT | null> => {
    const requested = draftRef.current;
    const current = planRef.current;
    if (!requested || !current) return current;
    if (same(requested, asDraft(current))) return current;
    if (planProblem(requested)) return null; // shown next to Approve; a half-typed draft is not sent
    try {
      const saved = await api.put<PlanT>(url, { ...requested, revision: current.revision });
      setPlan(saved);
      // Adopt the daemon's stored form (trimmed, deduped, sorted) only if the user has not typed since this save was sent;
      // otherwise their newer text would be clobbered.
      if (draftRef.current === requested) {
        const adopted = asDraft(saved);
        setDraft(adopted);
        draftRef.current = adopted;
      }
      setActionError(null);
      return saved;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setStale(true);
      else setActionError(text(e));
      return null;
    }
  };
  const save = (): Promise<PlanT | null> => {
    const run = saveChainRef.current.then(runSave);
    saveChainRef.current = run;
    return run;
  };
  const saveCurrent = () => { void save(); };
  const commit = (steps: PlanStep[]) => { const next = { ...draft, steps }; setDraft(next); draftRef.current = next; setNote(null); void save(); };
  const setStep = (i: number, patch: Partial<PlanStep>) => setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const r = moveStep(draft.steps, i, dir);
    if (typeof r === 'string') { setNote(r); return; }
    commit(r);
  };
  const approve = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const saved = await save();
      if (!saved) return;
      setPlan(await api.post<PlanT>(`${url}/approve`, { revision: saved.revision }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setStale(true);
      else setActionError(text(e));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!confirm('Discard this plan? Nothing was created for it, so nothing else changes.')) return;
    setBusy(true);
    try { setPlan(await api.post<PlanT>(`${url}/discard`)); } catch (e) { if (e instanceof ApiError && e.status === 409) setStale(true); else setActionError(text(e)); } finally { setBusy(false); }
  };

  return (
    <div className="plan">
      <div className="plan-content">
        <div className="plan-head">
          <button type="button" className="link" onClick={onBack}>Back</button>
          <span className="muted">{plan.repo_id}</span>
        </div>
        <ReadEditField className="plan-title" label="Plan title" value={draft.title} editable={editable} rows={1}
          onChange={(title) => setDraft({ ...draft, title })} onBlur={saveCurrent} />
        {plan.status === 'approved' && (
          <p className="plan-state">Approved. {plan.batch_id && <button type="button" className="link" onClick={() => onOpenBoard(plan.repo_id)}>Batch {plan.batch_id} is on the Board</button>}</p>
        )}
        {plan.status === 'discarded' && <p className="plan-state muted">Discarded. Nothing was created for this plan.</p>}
        {stale && (
          <div className="banner-warn" role="alert">
            This plan changed elsewhere. Your text is still here, so copy what you need, then <button type="button" className="link" onClick={() => void load()}>reload it</button>.
          </div>
        )}
        <ol className="plan-steps">
          {draft.steps.map((s, i) => {
            // Earlier steps, plus any later one this step already depends on (a proposed plan may name one).
            const choices = draft.steps.map((_, j) => j).filter((j) => j !== i && (j < i || s.dependsOn.includes(j)));
            return (
              <li key={i} className="plan-step">
                <div className="plan-step-head">
                  <span className="plan-step-n" aria-hidden="true">{i + 1}</span>
                  <AutoTextarea className="plan-step-title" label={`Step ${i + 1} title`} value={s.title} readOnly={!editable}
                    onChange={(title) => setStep(i, { title })} onBlur={saveCurrent} />
                </div>
                <ReadEditField className="plan-step-desc" label={`Step ${i + 1} description`} value={s.description} editable={editable} rows={3} breakPaths
                  onChange={(description) => setStep(i, { description })} onBlur={saveCurrent} />
                {choices.length === 0
                  ? <p className="plan-deps-none muted" aria-label={`Step ${i + 1} depends on nothing`}>Depends on nothing</p>
                  : (
                    <fieldset className="plan-deps" disabled={!editable}>
                      <legend>Depends on</legend>
                      {choices.map((j) => (
                        <label key={j}>
                          <input type="checkbox" checked={s.dependsOn.includes(j)} onChange={() => commit(toggleDep(draft.steps, i, j))} />
                          <span>{j + 1}. {draft.steps[j]!.title || 'Untitled step'}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                {editable && (
                  <div className="plan-step-actions">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0}>Move up</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === draft.steps.length - 1}>Move down</button>
                    <button type="button" className="danger" onClick={() => commit(removeStep(draft.steps, i))} disabled={draft.steps.length === 1}>Remove</button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {note && <p className="plan-note" role="status">{note}</p>}
        {editable && <button type="button" className="plan-add" onClick={() => commit(addStep(draft.steps))}>Add step</button>}
      </div>
      {editable && (
        <div className="plan-footer">
          <span className="plan-problem" role="status">{actionError ?? problem ?? ''}</span>
          <button type="button" className="danger" onClick={() => void discard()} disabled={busy || offline}>Discard</button>
          <button type="button" className="primary" onClick={() => void approve()} disabled={busy || offline || !!problem}>Approve plan</button>
        </div>
      )}
    </div>
  );
}
