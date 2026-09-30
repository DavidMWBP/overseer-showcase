import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { Loading } from '../components/Loading';
import { evidenceFileUrl, evidenceFolderLabel, evidenceHash } from '../lib/evidence';

type EvidenceKind = 'image' | 'video' | 'html' | 'text' | 'other';
interface EvidenceFile { relative_path: string; size: number; modified_at: string; kind: EvidenceKind }
interface Folder { name: string; file_count: number; total_size: number; modified_at: string | null }
interface EvidenceFilesPage { files: EvidenceFile[]; total: number; next_offset: number | null }
type EvidenceResult = { folder: null; rows: Folder[] } | { folder: string; rows: EvidenceFile[]; total: number; nextOffset: number | null };

const FILES_PER_PAGE = 100;

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

function FolderPlaceholder() {
  return (
    <ul className="evidence-folders" aria-hidden="true">
      {['Office captures', 'Browser screenshots', 'Worker output'].map((name) => (
        <li className="evidence-folder" data-testid="evidence-folder-placeholder" key={name}>
          <span className="evidence-folder-name">{name}</span>
          <span className="evidence-folder-meta">3 files · 2.4 MB</span>
          <span className="evidence-folder-time">Sep 25, 2026, 12:00 PM</span>
        </li>
      ))}
    </ul>
  );
}

function FilePlaceholder() {
  return (
    <div className="evidence-files" aria-hidden="true">
      {['Screenshot 1.png', 'Capture 2.png', 'Screenshot 3.png', 'Capture 4.png'].map((name) => (
        <figure className="evidence-image" key={name}>
          <div className="evidence-image-placeholder" />
          <figcaption className="evidence-file-name" title={name}>{name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function FileEntry({ folder, file }: { folder: string; file: EvidenceFile }) {
  const href = evidenceFileUrl(folder, file.relative_path);
  const name = file.relative_path;
  if (file.kind === 'image') {
    return (
      <figure className="evidence-image">
        <a href={href} target="_blank" rel="noreferrer" title={name}>
          <img src={href} alt={name} loading="lazy" />
        </a>
        <figcaption className="evidence-file-name" title={name}>{name}</figcaption>
      </figure>
    );
  }
  if (file.kind === 'video') {
    return (
      <figure className="evidence-video">
        <video controls preload="metadata" src={href} aria-label={name} />
        <figcaption className="evidence-file-name" title={name}>{name}</figcaption>
      </figure>
    );
  }
  return (
    <div className="evidence-file-link">
      {file.kind === 'html'
        ? <a href={href} target="_blank" rel="noreferrer" title={name}>{name}</a>
        : file.kind === 'text'
          ? <a href={href} title={name}>{name}</a>
          : <a href={href} download title={name}>{name}</a>}
    </div>
  );
}

export function Evidence(p: { folder: string | null; offline?: boolean }) {
  const [result, setResult] = useState<EvidenceResult | null>(null);
  const [failure, setFailure] = useState<{ folder: string | null; message: string } | null>(null);
  const [moreFailure, setMoreFailure] = useState<{ folder: string; message: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [missingFolder, setMissingFolder] = useState<string | null>(null);
  const entries = result?.folder === p.folder ? result.rows : null;
  const error = failure?.folder === p.folder ? failure.message : null;
  const missing = p.folder !== null && missingFolder === p.folder;

  useEffect(() => {
    let live = true;
    const folder = p.folder;
    setFailure(null);
    setMoreFailure(null);
    setLoadingMore(null);
    setMissingFolder(null);
    if (folder === null) {
      api.get<Folder[]>('/evidence')
        .then((rows) => { if (live) setResult({ folder: null, rows }); })
        .catch((e: unknown) => {
          if (live) setFailure({ folder: null, message: e instanceof Error ? e.message : String(e) });
        });
    } else {
      const endpoint = `/evidence/${encodeURIComponent(folder)}?offset=0&limit=${FILES_PER_PAGE}`;
      api.get<EvidenceFilesPage>(endpoint)
        .then((page) => { if (live) setResult({ folder, rows: page.files, total: page.total, nextOffset: page.next_offset }); })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) {
          setResult(null);
          setMissingFolder(folder);
        } else setFailure({ folder, message: e instanceof Error ? e.message : String(e) });
      });
    }
    return () => { live = false; };
  }, [p.folder, p.offline]);

  const loadMore = async () => {
    const folder = p.folder;
    if (folder === null || !result || result.folder !== folder || !('nextOffset' in result) || result.nextOffset === null) return;
    const offset = result.nextOffset;
    setLoadingMore(folder);
    setMoreFailure(null);
    try {
      const page = await api.get<EvidenceFilesPage>(`/evidence/${encodeURIComponent(folder)}?offset=${offset}&limit=${FILES_PER_PAGE}`);
      const visiblePaths = new Set(result.rows.map((row) => row.relative_path));
      const pageOverlaps = page.files.some((file) => visiblePaths.has(file.relative_path));
      if (page.total !== result.total || pageOverlaps) {
        const refreshed = await api.get<EvidenceFilesPage>(`/evidence/${encodeURIComponent(folder)}?offset=0&limit=${FILES_PER_PAGE}`);
        setResult((current) => current && current.folder === folder && 'nextOffset' in current
          ? { ...current, rows: refreshed.files, total: refreshed.total, nextOffset: refreshed.next_offset }
          : current);
      } else {
        setResult((current) => current && current.folder === folder && 'nextOffset' in current
          ? { ...current, rows: [...current.rows, ...page.files], total: page.total, nextOffset: page.next_offset }
          : current);
      }
    } catch (e: unknown) {
      setMoreFailure({ folder, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoadingMore((current) => current === folder ? null : current);
    }
  };

  const loading = entries === null && error === null && !missing && !p.offline;
  const folder = p.folder;
  const title = folder === null ? 'Evidence' : evidenceFolderLabel(folder);
  const isFolderList = folder === null;
  const fileResult = folder !== null && result?.folder === folder && 'nextOffset' in result ? result : null;

  return (
    <section className="evidence-view" aria-labelledby="evidence-title">
      {folder !== null && <a className="link evidence-back" href={evidenceHash(null)} onClick={(event) => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) location.hash = evidenceHash(null);
      }}>‹ Back to Evidence</a>}
      <h2 id="evidence-title">{title}</h2>
      {error && <p className="badge-warn" role={entries === null ? 'alert' : 'status'}>{entries === null ? `Could not load evidence: ${error}` : `Could not refresh evidence (${error}).`}</p>}
      {missing && folder !== null && <p className="muted" role="status">No evidence folder named {folder}.</p>}
      {entries === null && !error && !missing && p.offline && <p className="muted" role="status">Evidence is unavailable while the daemon is offline.</p>}
      <Loading loading={loading} label={isFolderList ? 'Loading evidence folders…' : 'Loading evidence files…'} placeholder={isFolderList ? <FolderPlaceholder /> : <FilePlaceholder />}>
        {entries === null ? null : isFolderList
          ? (entries as Folder[]).length === 0
            ? <p className="muted">No evidence yet.</p>
            : <ul className="evidence-folders">
              {(entries as Folder[]).map((item) => (
                <li className="evidence-folder" key={item.name}>
                  <a className="evidence-folder-name" href={evidenceHash(item.name)} title={evidenceFolderLabel(item.name)} onClick={(event) => {
                    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) location.hash = evidenceHash(item.name);
                  }}>{evidenceFolderLabel(item.name)}</a>
                  <span className="evidence-folder-meta">{item.file_count} {item.file_count === 1 ? 'file' : 'files'} · {formatSize(item.total_size)}</span>
                  {item.modified_at
                    ? <time className="evidence-folder-time" dateTime={item.modified_at}>{new Date(item.modified_at).toLocaleString()}</time>
                    : <span className="evidence-folder-time">—</span>}
                </li>
              ))}
            </ul>
          : (entries as EvidenceFile[]).length === 0
            ? <p className="muted">This folder is empty.</p>
            : <div className="evidence-files">
              {(entries as EvidenceFile[]).map((file) => <FileEntry key={file.relative_path} folder={folder!} file={file} />)}
            </div>}
      </Loading>
      {fileResult && fileResult.total > FILES_PER_PAGE && (
        <div className="evidence-pagination">
          <span className="muted" role="status">Showing {fileResult.rows.length} of {fileResult.total} files.</span>
          {fileResult.nextOffset !== null && fileResult.nextOffset !== undefined && <button className="link evidence-load-more" type="button" disabled={loadingMore === folder} onClick={() => void loadMore()}>
            {loadingMore === folder ? 'Loading more files…' : 'Load more files'}
          </button>}
          {moreFailure?.folder === folder && <p className="badge-warn" role="alert">Could not load more evidence files: {moreFailure.message}</p>}
        </div>
      )}
    </section>
  );
}
