import fs from 'node:fs';
import path from 'node:path';
import type { InspectResponse, Repo } from '@overseer/shared';
import { git } from '../git/git';
import { samePath, suggestId } from './paths';

export async function inspectRepo(raw: string, registered: Repo[]): Promise<InspectResponse> {
  let p = path.resolve(raw);
  const res: InspectResponse = { path: p, exists: false, is_git_root: false, branch: null, has_beads: false, suggested_id: suggestId(p), problems: [] };
  let isDir = false;
  try { isDir = fs.statSync(p).isDirectory(); } catch { /* missing */ }
  if (!isDir) { res.problems.push('folder does not exist'); return res; }
  res.exists = true;
  try { p = fs.realpathSync.native(p); } catch { /* keep resolved path */ }
  res.path = p;
  let top: string | null = null;
  try { top = await git(p, ['rev-parse', '--show-toplevel']); } catch { /* not inside a repo */ }
  if (!top || !samePath(top, p)) { res.problems.push('not the root of a git repository'); return res; }
  res.is_git_root = true;
  try { res.branch = await git(p, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { res.branch = null; }
  res.has_beads = fs.existsSync(path.join(p, '.beads'));
  const dup = registered.find((r) => samePath(r.path, p));
  if (dup) res.problems.push(`already registered as ${dup.id}`);
  return res;
}
