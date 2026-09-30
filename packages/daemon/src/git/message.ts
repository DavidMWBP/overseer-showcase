/** Merge commit messages in Conventional Commits form, so managed repos with a commitlint commit-msg hook accept them. */

export const HEADER_MAX = 72;
/** commitlint's default body-max-line-length; a bead title or a refresh line longer than this had the hook reject the merge (2026-09-14, acme-portal). */
export const BODY_MAX = 100;

/** Word-wraps one line at BODY_MAX; a single word longer than that stays whole (a URL). */
export function wrapLine(line: string, max = BODY_MAX): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > max) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

/** Lowercases and keeps only [a-z0-9-]; a branch prefix such as `feature/` or `bead/` is dropped first. */
export function mergeScope(branch: string): string {
  const short = branch.replace(/^[^/]+\//, '');
  return short.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'merge';
}

export interface MergeMessageInput {
  /** Branch the merge lands on; becomes the scope. */
  target: string;
  /** Bead or batch id; never truncated. */
  id: string;
  /** Full bead or batch title, first body line. */
  title: string;
  /** Branch being merged in. */
  source: string;
  /** Optional free text after the Source line. */
  description?: string;
}

/**
 * `chore(<scope>): merge <id>` (header at most HEADER_MAX chars, scope truncated first), blank line,
 * then the title, `Source: <branch>` and the description if any.
 */
export function mergeMessage({ target, id, title, source, description }: MergeMessageInput): string {
  const subject = `: merge ${id}`;
  let scope = mergeScope(target);
  const room = HEADER_MAX - 'chore()'.length - subject.length;
  if (scope.length > room) scope = scope.slice(0, Math.max(room, 1)).replace(/-$/, '');
  const body = [...wrapLine(title.trim()), `Source: ${source}`];
  if (description?.trim()) body.push('', ...description.trim().split('\n').flatMap((l) => (l.trim() ? wrapLine(l) : [''])));
  return `chore(${scope})${subject}\n\n${body.join('\n')}`;
}

/** Splits a message into `-m` arguments, one per paragraph, so the body survives `git merge` on every platform. */
export const messageArgs = (message: string): string[] => message.split(/\n{2,}/).flatMap((p) => ['-m', p]);
