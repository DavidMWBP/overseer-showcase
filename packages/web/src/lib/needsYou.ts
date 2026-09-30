import { effectiveBatchApprover, type BatchSummary, type BoardCard, type BoardResponse, type ChatRow, type Plan, type Repo } from '@overseer/shared';

/**
 * A card whose verification failed, or that waits on a decision about the critic's findings, needs the user. The Board sorts such
 * cards to the top of their column and the "needs you" strip lists them, so both read one definition rather than two that drift.
 */
const waitsForUsableAccount = (c: BoardCard) => /no usable account(?: left)?/i.test(c.bead.notes);
/** Account exhaustion reuses the existing failed Needs kind; it is blocked on a human waiting for/resetting an account. */
export const needsUser = (c: BoardCard) => c.verify_failure !== null || c.state === 'awaiting_decision' || waitsForUsableAccount(c);

/** Ordered by how much the wait costs: a question may be holding a worker idle, while a failed verification holds nothing. */
export type NeedsYouKind = 'plan' | 'repo' | 'question' | 'decision' | 'batch' | 'failed';
// A waiting plan holds its whole request: nothing for it exists until the user approves. A suspect repo blocks everything in it.
const ORDER: NeedsYouKind[] = ['plan', 'repo', 'question', 'decision', 'batch', 'failed'];

export interface NeedsYouItem {
  kind: NeedsYouKind;
  /** Bead id, batch id, or the chat row id for a question; what the strip navigates to. */
  id: string;
  /** Null for a question: the orchestrator's questions are not about one repository. */
  repoId: string | null;
  label: string;
  detail: string;
}

/** The Review badge and its Ready for you list group share the same actionable batch rule. */
export function isReviewReadyForUser(repo: Repo, batch: BatchSummary): boolean {
  return effectiveBatchApprover(repo) === 'user' && batch.status === 'review' && !batch.waiting_on;
}

/** A question about a card subsumes its decision or failure until that question is resolved. */
const questionNamesBead = (chat: ChatRow[], beadId: string) => {
  const id = beadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return chat.some((row) => row.kind === 'question' && row.answered_at === null && row.superseded_at === null && new RegExp(`(?<![\\w.-])${id}(?![\\w-]|\\.\\w)`).test(row.text));
};

/**
 * Everything blocked on the user, from the board and the chat rows the shell already holds — no fetch of its own.
 * Within a kind the source order is kept: chat rows are chronological and the daemon returns batches oldest first, so
 * the list stays stable without inventing a timestamp the board does not carry for cards.
 */
export function needsYouItems(board: BoardResponse | null, chat: ChatRow[] | null, plans: Plan[] | null = [], repos: Repo[] | null = []): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const rows = chat ?? [];

  // A draft plan holds its whole request: nothing for it exists until the user approves.
  for (const p of plans ?? []) {
    if (p.status !== 'draft') continue;
    items.push({ kind: 'plan', id: p.id, repoId: p.repo_id, label: p.title, detail: `${p.steps.length} ${p.steps.length === 1 ? 'step' : 'steps'} awaiting your review` });
  }

  // A repo whose verify command fails on its base branch blocks everything in it: no bead there can be trusted as verified.
  for (const r of repos ?? []) {
    if (r.verify_suspect == null) continue;
    items.push({ kind: 'repo', id: r.id, repoId: r.id, label: `Verify command fails on ${r.base_branch}`, detail: r.verify_command ?? '' });
  }

  for (const row of rows) {
    if (row.kind !== 'question' || row.answered_at !== null || row.superseded_at !== null) continue;
    items.push({ kind: 'question', id: String(row.id), repoId: null, label: row.text, detail: 'chat' });
  }

  for (const r of board?.repos ?? []) {
    // A card in the done column is finished, whatever its verification once did.
    for (const c of r.cards) {
      if (c.column === 'done' || !needsUser(c)) continue;
      if (questionNamesBead(rows, c.bead.id)) continue;
      const decision = c.state === 'awaiting_decision';
      const accountWait = waitsForUsableAccount(c);
      // The title is the headline and the id goes to the context line: a list is scanned by what things are, not by their ids.
      items.push({
        kind: decision ? 'decision' : 'failed',
        id: c.bead.id,
        repoId: c.repo_id,
        label: c.bead.title,
        detail: `${c.bead.id} ${decision ? 'awaiting your decision' : accountWait ? 'waiting for a usable account' : 'verification failed'}`,
      });
    }
    for (const b of r.batches) {
      // `waiting_on` means the batch is held behind an overlapping one: it waits on the queue, not on the user.
      if (!isReviewReadyForUser(r.repo, b)) continue;
      items.push({ kind: 'batch', id: b.id, repoId: b.repo_id, label: b.title, detail: 'in review' });
    }
  }

  return items.sort((a, z) => ORDER.indexOf(a.kind) - ORDER.indexOf(z.kind));
}
