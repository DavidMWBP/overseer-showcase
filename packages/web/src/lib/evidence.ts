export const EVIDENCE_ROOT_FOLDER = '<evidence-root>';

export function evidenceFolderFromHash(hash: string): string | null {
  const match = /^#evidence\/([^/]+)$/.exec(hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}

export function evidenceHash(folder: string | null): string {
  return `#evidence${folder === null ? '' : `/${encodeURIComponent(folder)}`}`;
}

export function evidenceFileUrl(folder: string, relativePath: string): string {
  const path = relativePath.split('/').map(encodeURIComponent).join('/');
  return `/api/evidence/${encodeURIComponent(folder)}/${path}`;
}

export function evidenceFolderLabel(folder: string): string {
  return folder === EVIDENCE_ROOT_FOLDER ? 'Evidence root' : folder;
}
