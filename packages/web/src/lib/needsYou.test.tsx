import { describe, it, expect } from 'vitest';
import type { BoardResponse, ChatRow, Repo } from '@overseer/shared';
import { needsYouItems, needsUser } from './needsYou';
import { board as baseBoard, chat } from '../test/fixtures';

const cards = () => baseBoard.repos[0]!.cards;
const batches = () => baseBoard.repos[0]!.batches;
/** The shared board fixture with the first repo's cards and batches replaced. */
const boardWith = (o: { cards?: BoardResponse['repos'][0]['cards']; batches?: BoardResponse['repos'][0]['batches'] }): BoardResponse =>
  ({ ...baseBoard, repos: [{ ...baseBoard.repos[0]!, cards: o.cards ?? [], batches: o.batches ?? [] }] });

const question = (id: number, text: string, extra: Partial<ChatRow> = {}): ChatRow =>
  ({ id, role: 'assistant', kind: 'question', text, ts: '2026-09-12T10:01:00.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null, ...extra });

const failed = cards().find((c) => c.state === 'verify_failed')!;
const done = cards().find((c) => c.column === 'done')!;
const awaiting = { ...cards()[0]!, bead: { ...cards()[0]!.bead, id: 'ov-14' }, state: 'awaiting_decision' as const };
const inReview = { ...batches()[0]!, id: 'r1-b7', status: 'review' as const };

describe('needsUser', () => {
  it('is true for a failed verification and for a bead awaiting a decision, false otherwise', () => {
    expect(needsUser(failed)).toBe(true);
    expect(needsUser(awaiting)).toBe(true);
    expect(needsUser(cards().find((c) => c.state === 'running')!)).toBe(false);
  });

  it('reuses the failed Needs kind when a bead waits for a usable account', () => {
    const waiting = { ...cards()[0]!, bead: { ...cards()[0]!.bead, notes: 'Account Claude a1 exhausted until 2026-09-17; no usable account left: account a1 exhausted' }, state: 'idle' as const, verify_failure: null };
    expect(needsYouItems(boardWith({ cards: [waiting] }), [])).toMatchObject([{ kind: 'failed', detail: `${waiting.bead.id} waiting for a usable account` }]);
  });
});

describe('needsYouItems', () => {
  it('is empty when nothing is blocked on the user', () => {
    expect(needsYouItems(boardWith({ cards: [cards()[0]!] }), [])).toEqual([]);
  });

  it('is empty before the board has loaded', () => {
    expect(needsYouItems(null, [])).toEqual([]);
  });

  it('lists a question, a decision, a batch in review and a failed verification, in that order', () => {
    const items = needsYouItems(boardWith({ cards: [failed, awaiting], batches: [inReview] }), [question(3, 'Which base branch?')]);
    expect(items.map((i) => i.kind)).toEqual(['question', 'decision', 'batch', 'failed']);
    expect(items.map((i) => i.id)).toEqual(['3', 'ov-14', 'r1-b7', failed.bead.id]);
  });

  it('keeps an open question and hides the decision it names', () => {
    const questionRow = question(3, 'Should I re-dispatch overseer-yq2 or accept the findings?');
    const decision = { ...awaiting, bead: { ...awaiting.bead, id: 'overseer-yq2' } };
    const items = needsYouItems(boardWith({ cards: [decision] }), [questionRow]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'question', id: '3', label: questionRow.text });
  });

  it.each([
    ['answered_at', { answered_at: '2026-09-12T10:02:00.000Z' }],
    ['superseded_at', { superseded_at: '2026-09-12T10:02:00.000Z' }],
  ])('shows a decision again when its naming question has %s', (_state, extra) => {
    const decision = { ...awaiting, bead: { ...awaiting.bead, id: 'overseer-yq2' } };
    const items = needsYouItems(boardWith({ cards: [decision] }), [question(3, 'Decide overseer-yq2.', extra)]);
    expect(items).toMatchObject([{ kind: 'decision', id: 'overseer-yq2' }]);
  });

  it('does not hide a card for an unrelated or near-miss question id', () => {
    const decision = { ...awaiting, bead: { ...awaiting.bead, id: 'overseer-yq2' } };
    for (const text of ['Decide overseer-other.', 'Decide overseer-yq22.', 'Decide overseer-yq2.1.']) {
      expect(needsYouItems(boardWith({ cards: [decision] }), [question(3, text)])).toMatchObject([
        { kind: 'question', id: '3' },
        { kind: 'decision', id: 'overseer-yq2' },
      ]);
    }
  });

  it('hides a failed card when an open question names its bead', () => {
    const card = { ...failed, bead: { ...failed.bead, id: 'overseer-yq2' } };
    expect(needsYouItems(boardWith({ cards: [card] }), [question(3, 'What should happen with overseer-yq2?')])).toMatchObject([
      { kind: 'question', id: '3' },
    ]);
  });

  // The label is the headline of a row and the detail its second line, so the label must be what a person reads to recognise
  // the thing: the question itself, the bead's title, the batch's title — never an id.
  it('makes the readable title the label and puts the id and state in the detail', () => {
    const items = needsYouItems(boardWith({ cards: [awaiting], batches: [inReview] }), [question(3, 'Which base branch?')]);
    expect(items.find((i) => i.kind === 'question')).toMatchObject({ repoId: null, label: 'Which base branch?', detail: 'chat' });
    expect(items.find((i) => i.kind === 'decision')).toMatchObject({ repoId: 'r1', label: awaiting.bead.title, detail: 'ov-14 awaiting your decision' });
    expect(items.find((i) => i.kind === 'batch')).toMatchObject({ repoId: 'r1', label: inReview.title, detail: 'in review' });
  });

  it('says a failed verification in the detail, with the bead id', () => {
    const items = needsYouItems(boardWith({ cards: [failed] }), []);
    expect(items[0]).toMatchObject({ kind: 'failed', label: failed.bead.title, detail: `${failed.bead.id} verification failed` });
  });

  it('excludes a batch waiting on an overlapping one, which waits on the queue rather than on the user', () => {
    const blocked = { ...inReview, id: 'r1-b8', waiting_on: 'r1-b7', overlap_files: ['src/a.ts'] };
    const items = needsYouItems(boardWith({ batches: [inReview, blocked] }), []);
    expect(items.map((i) => i.id)).toEqual(['r1-b7']);
  });

  it('excludes a batch in review whose repository the orchestrator approves', () => {
    const approved: BoardResponse = { ...baseBoard, repos: [{ ...baseBoard.repos[0]!, repo: { ...baseBoard.repos[0]!.repo, batch_approver: 'orchestrator' }, cards: [], batches: [inReview] }] };
    expect(needsYouItems(approved, [])).toEqual([]);
    // The same batch waits for the user when the repository does not approve on its own, so the approver is what hides it.
    expect(needsYouItems(boardWith({ batches: [inReview] }), []).map((i) => i.id)).toEqual(['r1-b7']);
  });

  it('counts an invalid GitLab orchestrator value as waiting for the user', () => {
    const invalid: BoardResponse = { ...baseBoard, repos: [{ ...baseBoard.repos[0]!, repo: { ...baseBoard.repos[0]!.repo, merge_mode: 'gitlab-mr', batch_approver: 'orchestrator' }, cards: [], batches: [inReview] }] };
    expect(needsYouItems(invalid, []).map((i) => i.id)).toEqual(['r1-b7']);
  });

  it('excludes an open batch and one already merged', () => {
    const merged = { ...inReview, id: 'r1-b9', status: 'merged' as const };
    expect(needsYouItems(boardWith({ batches: [batches()[0]!, merged] }), [])).toEqual([]);
  });

  it('excludes a finished card whose verification once failed', () => {
    expect(needsYouItems(boardWith({ cards: [{ ...done, verify_failure: 'exit 1' }] }), [])).toEqual([]);
  });

  it('excludes an answered or superseded question', () => {
    const rows = [question(1, 'Answered?', { answered_at: '2026-09-12T10:02:00.000Z' }), question(2, 'Superseded?', { superseded_at: '2026-09-12T10:02:00.000Z' })];
    expect(needsYouItems(boardWith({}), rows)).toEqual([]);
  });

  it('takes the questions straight from the chat rows the shell already holds', () => {
    const items = needsYouItems(boardWith({}), chat);
    expect(items.map((i) => i.label)).toEqual(['Should the endpoint require auth?']);
  });

  it('lists a repo whose verify command fails on its base branch, right after plans', () => {
    const repos = [{ id: 'r1', path: '/r1', base_branch: 'main', verify_command: 'bad', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0, verify_suspect: 3 }] as Repo[];
    const items = needsYouItems(null, [], [], repos);
    expect(items).toEqual([{ kind: 'repo', id: 'r1', repoId: 'r1', label: 'Verify command fails on main', detail: 'bad' }]);
  });

  it('lists a draft plan first, by its title, and ignores plans that are no longer drafts', () => {
    const plan = (id: string, status: 'draft' | 'approved') => ({ id, repo_id: 'r1', title: `Plan ${id}`, status, batch_id: null, revision: 1, created_at: 't', updated_at: 't', steps: [{ title: 'a', description: '', dependsOn: [] }, { title: 'b', description: '', dependsOn: [] }] });
    const items = needsYouItems(boardWith({ cards: [failed] }), [question(3, 'Which base branch?')], [plan('r1-p1', 'draft'), plan('r1-p2', 'approved')]);
    expect(items.map((i) => i.kind)).toEqual(['plan', 'question', 'failed']);
    expect(items[0]).toEqual({ kind: 'plan', id: 'r1-p1', repoId: 'r1', label: 'Plan r1-p1', detail: '2 steps awaiting your review' });
  });

  it('reads a list that has not loaded as an empty one', () => {
    const suspect = [{ id: 'r1', path: '/r1', base_branch: 'main', verify_command: 'bad', setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0, verify_suspect: 3 }] as Repo[];
    const draft = [{ id: 'r1-p1', repo_id: 'r1', title: 'Plan r1-p1', status: 'draft' as const, batch_id: null, revision: 1, created_at: 't', updated_at: 't', steps: [{ title: 'a', description: '', dependsOn: [] }] }];
    const board = boardWith({ cards: [failed] });
    // Sanity: the same lists hold data, so the comparison below is not two empty answers.
    expect(needsYouItems(board, [question(3, 'Which base branch?')], draft, suspect).map((i) => i.kind)).toEqual(['plan', 'repo', 'question', 'failed']);
    expect(needsYouItems(board, null, null, null)).toEqual(needsYouItems(board, [], [], []));
    expect(needsYouItems(board, null, null, null).map((i) => i.kind)).toEqual(['failed']);
  });
});
