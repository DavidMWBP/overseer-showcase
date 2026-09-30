export interface DiffFile { file: string; body: string }

export function splitDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.trim());
  return parts.map((p) => {
    const m = p.match(/^diff --git a\/(\S+) b\/(\S+)/);
    return { file: m?.[2] ?? m?.[1] ?? '(unknown)', body: p };
  });
}

function lineClass(l: string): string {
  if (l.startsWith('+++') || l.startsWith('---')) return 'diff-meta';
  if (l.startsWith('@@')) return 'diff-hunk';
  if (l.startsWith('+')) return 'diff-add';
  if (l.startsWith('-')) return 'diff-del';
  return '';
}

export function Diff(p: { diff: string | null }) {
  const files = splitDiff(p.diff ?? '');
  if (files.length === 0) return <p className="muted">No changes against the base branch.</p>;
  return (
    <div className="diff">
      {files.map((f) => (
        <details key={f.file} open>
          <summary>{f.file}</summary>
          <pre>{f.body.split('\n').map((l, i) => <div key={i} className={lineClass(l)}>{l}</div>)}</pre>
        </details>
      ))}
    </div>
  );
}
