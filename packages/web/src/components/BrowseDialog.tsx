import { useEffect, useRef, useState } from 'react';
import type { BrowseResponse } from '@overseer/shared';
import { api } from '../api';
import { Loading } from './Loading';

/** A listing row is one line, so the count alone sets the reserved height. Six reproduces the height a typical listing arrives at
 * (114 px of chrome plus about 25 px a row), and a folder with more entries only grows the dialog to its 70vh cap. */
const PLACEHOLDER_ROWS = 6;
/** The listing the arrived dialog shows: same list, same one-line rows, placeholder names. */
function ListPlaceholder() {
  return (
    <ul className="browse-list">
      {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
        <li key={i}><button type="button" className="link">One folder in here</button></li>
      ))}
    </ul>
  );
}

export function parentOf(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (i <= 0) return null;
  const parent = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

const url = (path: string | null) => (path ? `/fs/browse?path=${encodeURIComponent(path)}` : '/fs/browse');

/** Compares two folder paths the way Windows does: a trailing separator and case are not a difference. */
const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function BrowseDialog(p: { initialPath: string; onPick: (path: string) => void; onClose: () => void }) {
  const [state, setState] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A generated or deep directory can hold thousands of folders: the dialog rendered 16,156 rows of one Temp folder with no way to
  // search them, and the folder the Path field named sat 159,000 px down the list, unscrolled to and unmarked (round 25 R25-1).
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const marked = useRef<HTMLButtonElement>(null);
  // Focus moves into the dialog when it opens (keyboard users would otherwise Tab through the page behind the backdrop) and back to
  // whatever opened it (the Browse button) when it unmounts, instead of falling to <body>.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => opener?.focus();
  }, []);

  const open = (path: string | null) => {
    setError(null);
    setFilter(''); // the filter belongs to the listing it was typed for
    return api.get<BrowseResponse>(url(path)).then(setState).catch((e: Error) => setError(e.message));
  };
  // Every new listing brings the folder the Path field names into view, when it holds it.
  useEffect(() => { marked.current?.scrollIntoView?.({ block: 'center' }); }, [state]);

  useEffect(() => {
    const start = p.initialPath.trim() ? parentOf(p.initialPath.trim()) : null;
    api.get<BrowseResponse>(url(start)).then(setState).catch(() => open(null));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.onClose]);

  // The folder the Path field named: it is what the dialog listed the parent of, so it is marked and scrolled to here.
  const target = p.initialPath.trim();
  const needle = filter.trim().toLowerCase();
  const shown = (state?.entries ?? []).filter((e) => e.name.toLowerCase().includes(needle));
  return (
    <div className="dialog-backdrop" onClick={p.onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Browse folders" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        {/* Two groups: one row on desktop; on phones the sheet keeps Up and the path on top and Select this folder / Close as its footer. */}
        <div className="dialog-head">
          <div className="dialog-nav">
            <button type="button" disabled={!state || state.path === null} onClick={() => void open(state?.parent ?? null)}>Up</button>
            <span className="dialog-path">{state?.path ?? 'Drives'}</span>
          </div>
          {/* The rows teach "click the name to go in", so clicking the repository itself used to land in a box with no Select at
              all (round 24 R24-1). The path the form gets is inspected there, so choosing a folder that is no repository is
              refused inline, the same as a typed one. */}
          <div className="dialog-foot">
            <button type="button" disabled={!state?.path} onClick={() => { if (state?.path) p.onPick(state.path); }}>Select this folder</button>
            <button type="button" onClick={p.onClose}>Close</button>
          </div>
        </div>
        <input className="browse-filter" aria-label="Filter this folder" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <div className="badge-warn">{error}</div>}
        {state && state.entries.length === 0 && <p className="muted">{state.path ? 'No sub-folders in here. Select this folder, or go Up.' : 'No drives to browse.'}</p>}
        {state && state.entries.length > 0 && shown.length === 0 && <p className="muted">{`No folder here matches "${filter.trim()}".`}</p>}
        {/* Only the first listing shimmers: a navigation keeps the rows it has until the new ones land, and a failure shows the warning instead. */}
        {/* The sizing lives on this box, above the shimmer wrapper, so the phone sheet grows the list (placeholder or arrived) and keeps its footer at the bottom. */}
        <div className="browse-box">
        <Loading loading={state === null && error === null} label="Loading folders…" placeholder={<ListPlaceholder />}>
        <ul className="browse-list">
          {shown.map((e) => {
            const isTarget = target !== '' && samePath(e.path, target);
            return (
              <li key={e.path}>
                <button type="button" className="link" ref={isTarget ? marked : undefined} aria-current={isTarget || undefined} onClick={() => void open(e.path)}>{e.name}</button>
                {e.is_git_repo && <button type="button" onClick={() => p.onPick(e.path)}>Select</button>}
              </li>
            );
          })}
        </ul>
        </Loading>
        </div>
      </div>
    </div>
  );
}
