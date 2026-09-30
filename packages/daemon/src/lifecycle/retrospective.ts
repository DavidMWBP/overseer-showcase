import type { BatchRetrospective, BatchRow, Bead, CrashClass, ReopenReason } from '@overseer/shared';
import type { Db } from '../db/db';
import { batchMembers } from '../api/board';

/**
 * A user chat message during a batch's lifetime that contains one of these reads as a correction or a status ping and goes into the
 * retrospective. Plain substrings, matched case-insensitively, no LLM call: false positives are fine, the orchestrator reads the
 * record and decides what was a lesson. Extend the list rather than making the match cleverer.
 */
export const CORRECTION_PATTERNS = ["shouldn't", "don't", 'why', 'still working', 'wrong', 'not what', 'instead'];

/** The first pattern the text contains, or null when none does. */
export function correctionMatch(text: string): string | null {
  const lower = text.toLowerCase();
  return CORRECTION_PATTERNS.find((p) => lower.includes(p)) ?? null;
}

/** A batch whose title starts with this is the retrospective loop's own output; it gets no retrospective notice, so the loop does not feed itself. */
export const LESSONS_TITLE_PREFIX = 'Lessons from';
export const isLessonsBatch = (batch: BatchRow) => batch.title.startsWith(LESSONS_TITLE_PREFIX);

const REOPEN_REASONS: ReopenReason[] = ['no_commits', 'uncommitted_changes', 'verify_incomplete', 'verify_failed', 'merge_conflict', 'hook_rejected', 'setup_failed', 'stopped'];

/** A reopen signal's text is `<reason>: <note>`; the reason class is one word from the fixed list. */
export const reopenText = (reason: ReopenReason, note: string) => `${reason}: ${note}`;

function parseReopen(text: string): { reason: ReopenReason; note: string } {
  const i = text.indexOf(': ');
  const head = i === -1 ? text : text.slice(0, i);
  const reason = (REOPEN_REASONS as string[]).includes(head) ? (head as ReopenReason) : 'no_commits';
  return { reason, note: i === -1 ? '' : text.slice(i + 2) };
}

/** The end of a batch's lifetime for the chat scan and the wall clock: its close (merged or abandoned), or now while it lives. */
export function batchEndedAt(batch: BatchRow): string | null {
  if (batch.status === 'merged') return batch.merged_at ?? batch.updated_at;
  if (batch.status === 'abandoned') return batch.updated_at;
  return null;
}

/**
 * Builds the record from what the daemon stored while the batch ran: the `batch_signals` rows the lifecycle wrote as things went
 * wrong, the user's chat messages in the batch's lifetime, and the worker sessions of its beads. `beads` is the repo's bd list for
 * the total (null when bd could not be read: the total then counts dispatched beads only).
 */
export function buildRetrospective(db: Db, batch: BatchRow, beads: Bead[] | null): BatchRetrospective {
  const rows = db.signals.forBatch(batch.id);
  const endedAt = batchEndedAt(batch);
  const endMs = endedAt ? Date.parse(endedAt) : Date.now();
  const startMs = Date.parse(batch.created_at);
  const storedCorrections = rows.filter((r) => r.kind === 'correction')
    .map((r) => ({ text: r.text, matched: 'lifecycle', ts: r.ts }));
  const chatCorrections = db.chat.userMessagesBetween(batch.created_at, endedAt ?? new Date().toISOString())
    .flatMap((m) => { const matched = correctionMatch(m.text); return matched ? [{ text: m.text, matched, ts: m.ts }] : []; });
  const corrections = storedCorrections.concat(chatCorrections);
  const signals: BatchRetrospective['signals'] = {
    rejections: rows.filter((r) => r.kind === 'rejection').map((r) => ({ note: r.text, ts: r.ts })),
    reopens: rows.filter((r) => r.kind === 'reopen').map((r) => ({ bead_id: r.bead_id ?? '', ...parseReopen(r.text), ts: r.ts })),
    redispatches: rows.filter((r) => r.kind === 'redispatch').map((r) => ({ bead_id: r.bead_id ?? '', instructions: r.text || null, ts: r.ts })),
    closed: rows.filter((r) => r.kind === 'closed').map((r) => ({ bead_id: r.bead_id ?? '', note: r.text || null, ts: r.ts })),
    corrections,
  };
  const crashes = rows.filter((r) => r.kind === 'crash').map((r) => {
    const i = r.text.indexOf(': ');
    return { bead_id: r.bead_id ?? '', crash_class: r.text.slice(0, i) as CrashClass, reason: r.text.slice(i + 2), ts: r.ts };
  });
  const wts = db.worktrees.forBatch(batch.id);
  const workerCost = wts.flatMap((w) => db.sessions.forBead(w.bead_id)).reduce((sum, s) => sum + (s.cost ?? 0), 0);
  return {
    batch_id: batch.id,
    title: batch.title,
    status: batch.status,
    created_at: batch.created_at,
    ended_at: endedAt,
    signals,
    crashes,
    counts: {
      beads_total: batchMembers(db, batch.id, beads ?? []).total,
      reopens: signals.reopens.length,
      redispatches: signals.redispatches.length,
      signals: rows.length + chatCorrections.length,
      worker_cost: workerCost,
      wall_clock_ms: Math.max(0, endMs - startMs),
    },
  };
}

/** The compact record `batch_retrospective` returns by default: the full record with long free text cut and re-dispatches grouped per bead. */
export type CompactBatchRetrospective = Omit<BatchRetrospective, 'signals'> & {
  signals: {
    rejections: { note: string; truncated: boolean; ts: string }[];
    reopens: BatchRetrospective['signals']['reopens'];
    redispatches: { bead_id: string; count: number; instructions: string[] }[];
    closed: BatchRetrospective['signals']['closed'];
    corrections: { text: string; truncated: boolean; matched: string; ts: string }[];
  };
};

/** How much of a rejection or correction the compact record keeps before it sets `truncated`. */
export const COMPACT_CORRECTION_LIMIT = 400;
/** How much free text the compact record keeps for every other signal, and for each re-dispatch instruction. */
export const COMPACT_SIGNAL_LIMIT = 300;

const cut = (text: string, limit: number): string => (text.length > limit ? text.slice(0, limit) : text);

/**
 * The default result of `batch_retrospective`: the same counts, re-dispatches grouped per bead with each instruction cut, and every
 * other free text cut to a fixed length. A rejection or correction carries `truncated: true` when it lost characters, so the caller
 * knows to ask for `full: true` (or `bead_id`) before quoting it. The notice, `GET /api/batches/:id/retrospective` and the nightly
 * report keep reading the full record; only this tool's default output is compact.
 */
export function compactRetrospective(r: BatchRetrospective): CompactBatchRetrospective {
  const grouped = new Map<string, string[]>();
  for (const d of r.signals.redispatches) {
    const list = grouped.get(d.bead_id);
    if (list) list.push(cut(d.instructions ?? '', COMPACT_SIGNAL_LIMIT));
    else grouped.set(d.bead_id, [cut(d.instructions ?? '', COMPACT_SIGNAL_LIMIT)]);
  }
  return {
    ...r,
    signals: {
      rejections: r.signals.rejections.map((x) => ({ note: cut(x.note, COMPACT_CORRECTION_LIMIT), truncated: x.note.length > COMPACT_CORRECTION_LIMIT, ts: x.ts })),
      reopens: r.signals.reopens.map((x) => ({ ...x, note: cut(x.note, COMPACT_SIGNAL_LIMIT) })),
      redispatches: [...grouped].map(([bead_id, instructions]) => ({ bead_id, count: instructions.length, instructions })),
      closed: r.signals.closed.map((x) => ({ ...x, note: x.note === null ? null : cut(x.note, COMPACT_SIGNAL_LIMIT) })),
      corrections: r.signals.corrections.map((x) => ({ text: cut(x.text, COMPACT_CORRECTION_LIMIT), truncated: x.text.length > COMPACT_CORRECTION_LIMIT, matched: x.matched, ts: x.ts })),
    },
    crashes: r.crashes.map((x) => ({ ...x, reason: cut(x.reason, COMPACT_SIGNAL_LIMIT) })),
  };
}

/** The full record limited to one bead's signals, for `batch_retrospective(..., bead_id)` so a signal can be quoted verbatim. */
export function beadRetrospective(r: BatchRetrospective, beadId: string): BatchRetrospective {
  return {
    ...r,
    signals: {
      rejections: [],
      reopens: r.signals.reopens.filter((s) => s.bead_id === beadId),
      redispatches: r.signals.redispatches.filter((s) => s.bead_id === beadId),
      closed: r.signals.closed.filter((s) => s.bead_id === beadId),
      corrections: [],
    },
    crashes: r.crashes.filter((c) => c.bead_id === beadId),
  };
}

/** The two-line summary of the retrospective notice: what ended the batch, then the counts by signal class. */
export function retrospectiveSummary(r: BatchRetrospective, ended: 'merged' | 'abandoned' | 'rejected'): string {
  const s = r.signals;
  const classes = [
    [s.rejections.length, 'rejection', 'rejections'],
    [s.reopens.length, 'reopen', 'reopens'],
    [s.redispatches.length, 're-dispatch', 're-dispatches'],
    [s.closed.length, "bead closed as won't do", "beads closed as won't do"],
    [s.corrections.length, 'correction', 'corrections'],
  ] as const;
  const counts = classes.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(', ');
  const minutes = Math.round(r.counts.wall_clock_ms / 60000);
  return `Retrospective ready for batch ${r.batch_id} (${r.counts.signals} ${r.counts.signals === 1 ? 'signal' : 'signals'}): ${ended}, ${r.counts.beads_total} ${r.counts.beads_total === 1 ? 'bead' : 'beads'}, ${minutes} min, worker cost $${r.counts.worker_cost.toFixed(2)}.\n${counts}.`;
}
