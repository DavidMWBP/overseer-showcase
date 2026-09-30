import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act, cleanup } from '@testing-library/react';
import type { BoardResponse } from '@overseer/shared';
import { Board, DONE_CAP } from './Board';
import { FINISHED_MAX } from '../components/BatchRow';
import { Toasts } from '../components/Toasts';
import { jobEnded } from '../lib/jobs';
import { mockApi } from '../test/setup';
import { board, reviewDetail } from '../test/fixtures';
import { PHONE_MEDIA } from '../test/phoneMedia';

const noop = () => {};
// boardAt is taken at render time (frozen under fake timers), so no assertion depends on how long the file has been running.
const props = () => ({ version: 0, boardAt: Date.now(), onOpenReview: noop, onOpenBatch: noop });
/** The daemon's 202 for an action request, recorded so `endJobs` can end the job the way the app shell passes `action_result` on. */
const jobs: { job_id: string; action: string; target: string }[] = [];
let jobSeq = 0; // job ids are never reused: an ended one stays ended
const accept = (url: string) => {
  const [, target, action] = /\/api\/tasks\/([^/]+)\/([^/]+)$/.exec(url)!;
  const job = { job_id: `job-${++jobSeq}-${target}`, action: action!, target: target! };
  jobs.push(job);
  return job;
};
/** Ends every job accepted so far, after the pending 202s have been read. */
const endJobs = async (ok = true, message: string | null = null) => {
  await act(async () => {});
  act(() => { for (const j of jobs.splice(0)) jobEnded({ ...j, ok, message, data: null }); });
};
afterEach(() => { jobs.length = 0; });

describe('Board costs', () => {
  it('says a stopped worker\'s cost is unknown and shows the batch total as a floor instead of a clean number (round 14)', () => {
    // A worker stopped mid-turn never sends the harness's final event, the only one that carries a cost; the card and the row must not read as "free".
    const r = board.repos[0]!;
    const done = r.cards[6]!;
    const b: BoardResponse = { ...board, repos: [{ ...r, cards: [{ ...done, cost: null }, { ...r.cards[2]! }], batches: [{ ...r.batches[0]!, cost_unknown: 1 }] }] };
    render(<Board {...props()} board={b} />);
    const card = screen.getByText('Done task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(card).queryByText('cost unknown')).toBeNull();
    const running = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(running).queryByText('cost unknown')).toBeNull(); // a running worker has simply not reported yet
    const row = screen.getByText('#9310 Trend chart').closest('.batch') as HTMLElement;
    expect(within(row).getByText('≥ $1.20').title).toBe('At least: 1 worker session ended without a reported cost (stopped or crashed mid-turn, or a harness that reports none).');
  });

  it('says nothing about the cost of a card that is still settling in Running (round 19 R19-3)', () => {
    // The session has ended but the bead has not settled, so the card is in Running; "cost unknown" says the worker was stopped or crashed.
    const r = board.repos[0]!;
    const b: BoardResponse = { ...board, repos: [{ ...r, cards: [{ ...r.cards[2]!, cost: null, session_status: 'ended' as const, state: 'settling' as const }] }] };
    render(<Board {...props()} board={b} />);
    const card = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(screen.getByRole('heading', { name: 'Running (1)' })).toBeTruthy();
    expect(within(card).queryByText('cost unknown')).toBeNull();
    expect(card.textContent).toContain('settling…');
  });
});

describe('Board', () => {
  it('renders six columns with cards and details', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onOpenReview = vi.fn();
    render(<Board {...props()} board={board} onOpenReview={onOpenReview} />);
    expect(screen.getByText('Ready task')).toBeTruthy();
    const headers = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headers).toEqual(['Ready (2)', 'Blocked (1)', 'Running (1)', 'Verifying (1)', 'Review (1)', 'Done (2)']);
    const abandoned = screen.getByText('Abandoned task', { selector: '.card-title' }).closest('.card')!;
    expect(abandoned.className).toContain('card-abandoned');
    expect(within(abandoned as HTMLElement).getByText('Abandoned')).toBeTruthy();
    const running = screen.getByText('Running task', { selector: '.card-title' }).closest('.card')!;
    expect(within(running as HTMLElement).getByText('Running')).toBeTruthy();
    expect(within(running as HTMLElement).getByText('ov-3')).toBeTruthy();
    expect(within(running as HTMLElement).queryByText('bead/ov-3')).toBeNull();
    expect(within(running as HTMLElement).queryByText('$0.42')).toBeNull();
    expect(within(running as HTMLElement).getByText('2m 5s')).toBeTruthy();
    expect(screen.getByText('Failed task').closest('.card')!.className).toContain('card-failed');
    fireEvent.click(screen.getByText('Review task'));
    await waitFor(() => expect(screen.getByText('Description of Review task')).toBeTruthy());
    expect(screen.getByText(/all green/)).toBeTruthy();
    expect(screen.getByText('Done. Added the endpoint and a test.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Review' }));
    expect(onOpenReview).toHaveBeenCalledWith('ov-5');
  });
  it('uses one state pill per state and keeps agent metadata compact', () => {
    const source = board.repos[0]!.cards[2]!;
    const states = [
      ['running', 'Running'], ['settling', 'settling…'], ['verifying', 'Verifying'], ['review', 'Review'],
      ['verify_failed', 'Failed'], ['blocked', 'Blocked'], ['idle', 'Ready'], ['landed_unclosed', 'Verifying'],
      ['done', 'Done'], ['reviewing', 'Reviewing'], ['awaiting_decision', 'Needs you'],
    ] as const;
    const cards = states.map(([state, label], i) => ({ ...source, bead: { ...source.bead, id: `state-${i}`, title: `${label} task`, labels: [] }, state, verify_failure: state === 'verify_failed' ? 'exit 1' : null, column: state === 'blocked' ? 'blocked' as const : state === 'verifying' || state === 'landed_unclosed' ? 'verifying' as const : state === 'review' || state === 'reviewing' ? 'review' as const : state === 'done' ? 'done' as const : 'running' as const, harness: state === 'idle' ? null : 'codex' as const, tier: state === 'idle' ? null : 'hard' as const, model: state === 'idle' ? null : 'gpt-5.6-sol' }));
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards, batches: [] }] }} />);
    const variant: Record<string, string> = { verify_failed: 'fail', awaiting_decision: 'awaiting', review: 'review', reviewing: 'review' };
    states.forEach(([state, label], i) => {
      const face = document.querySelector(`[data-bead="state-${i}"]`) as HTMLElement;
      const pill = face.querySelector('.card-meta > .chip') as HTMLElement;
      expect(pill.textContent).toBe(label);
      expect(pill.className).toBe(`chip ${variant[state] ?? ''}`);
    });
    const running = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(running).getByText('codex · gpt-5.6-sol').title).toBe('hard');
    expect(within(running).getByTestId('card-title-row').querySelector('.card-id')?.textContent).toBe('state-0');
    expect(within(running).getByTestId('card-meta').querySelector('.card-id')).toBeNull();
    expect(within(running).getByText('Running').querySelector('.card-running-dot')).toBeTruthy();
    const noHarness = screen.getByText('Ready task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(noHarness).queryByText(/ · /)).toBeNull();
  });
  it('marks last-run elapsed text to hide on a narrow card', () => {
    const source = board.repos[0]!.cards[2]!;
    const waiting = { ...source, bead: { ...source.bead, id: 'waiting', title: 'Waiting task' }, column: 'ready' as const, state: 'idle' as const };
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: [waiting], batches: [] }] }} />);
    expect(screen.getByText('last run 2m 5s').className).toContain('card-last-run');
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    expect(css).toMatch(/@container \(max-width: 340px\) \{ \.card-last-run \{ display: none; \} \}/);
  });
  it('labels Done flags and a worker failure in the state pill', () => {
    const source = board.repos[0]!.cards[2]!;
    const mk = (id: string, labels: string[], extra: object) => ({ ...source, bead: { ...source.bead, id, title: id, labels }, verify_failure: null, ...extra });
    const cards = [
      mk('f-verified', ['overseer:verified'], { state: 'done', column: 'done' }),
      mk('f-worker-reported', ['overseer:worker-reported'], { state: 'done', column: 'done' }),
      mk('f-closed', ['overseer:closed'], { state: 'done', column: 'done' }),
      mk('f-abandoned', ['overseer:abandoned'], { state: 'done', column: 'done' }),
      mk('f-worker', [], { state: 'idle', column: 'ready', session_status: 'failed' }),
      mk('f-blocked-verify', [], { state: 'blocked', column: 'blocked', verify_failure: 'exit 1' }),
    ] as typeof source[];
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards, batches: [] }] }} />);
    const pill = (id: string) => document.querySelector(`[data-bead="${id}"] .card-meta > .chip`) as HTMLElement;
    expect([pill('f-verified').textContent, pill('f-verified').className]).toEqual(['Verified', 'chip ']);
    expect([pill('f-worker-reported').textContent, pill('f-worker-reported').className]).toEqual(['Worker-reported', 'chip ']);
    expect([pill('f-closed').textContent, pill('f-closed').className]).toEqual(['Closed', 'chip abandoned']);
    expect([pill('f-abandoned').textContent, pill('f-abandoned').className]).toEqual(['Abandoned', 'chip abandoned']);
    expect([pill('f-worker').textContent, pill('f-worker').className]).toEqual(['Failed', 'chip fail']);
    expect([pill('f-blocked-verify').textContent, pill('f-blocked-verify').className]).toEqual(['Failed', 'chip fail']);
  });
  it('moves branch, batch, cost, tier and flags into the card pane', async () => {
    const card = { ...board.repos[0]!.cards[2]!, tier: 'hard' as const, model: 'gpt-5.6-sol', bead: { ...board.repos[0]!.cards[2]!.bead, labels: ['overseer:verified', 'overseer:closed'] } };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: card.bead };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: [card] }] }} />);
    const face = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(face).queryByText('bead/ov-3')).toBeNull();
    expect(within(face).queryByText('r1-b1')).toBeNull();
    expect(within(face).queryByText('$0.42')).toBeNull();
    fireEvent.click(face);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    expect(within(pane).getByText('bead/ov-3')).toBeTruthy();
    expect(within(pane).getByText('r1-b1')).toBeTruthy();
    expect(within(pane).getByText('$0.42')).toBeTruthy();
    expect(within(pane).getByText('hard')).toBeTruthy();
    expect(within(pane).getByText('verified, closed')).toBeTruthy();
  });
  it('offers Open batch on a never-dispatched bead of a batch from the card, before it has a worktree (round 16)', async () => {
    const onOpenBatch = vi.fn();
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: board.repos[0]!.cards.map((c) => (c.bead.id === 'ov-1' ? { ...c, batch_id: 'r1-b1' } : c)) }] };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-1')) return { ...reviewDetail, bead: b.repos[0]!.cards[0]!.bead, worktree: null, sessions: [], last_assistant_text: null, diff: null };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={b} onOpenBatch={onOpenBatch} />);
    fireEvent.click(screen.getByText('Ready task'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open batch r1-b1' }));
    expect(onOpenBatch).toHaveBeenCalledWith('r1-b1');
  });
  it('opens the card the shell names at mount and reports every selection change, so the pane can live in the URL (round 16)', async () => {
    const onSelected = vi.fn();
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} initialSelected="ov-5" onSelected={onSelected} />);
    await waitFor(() => expect(screen.getByText('Description of Review task')).toBeTruthy());
    const pane = screen.getByRole('complementary', { name: 'Details of ov-5' });
    // Both controls stay in the DOM; the responsive CSS selects desktop close or phone Back.
    expect(within(pane).getByRole('button', { name: 'Close details' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Back to board' })).toBeTruthy();
    const card = screen.getByText('Review task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    fireEvent.click(within(pane).getByRole('button', { name: 'Close details' }));
    expect(onSelected).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(card);
    fireEvent.click(screen.getByText('Review task'));
    expect(onSelected).toHaveBeenLastCalledWith('ov-5');
  });
  it('returns focus to the Board card when Escape closes its pane', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    const card = screen.getByText('Review task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    fireEvent.click(screen.getByText('Review task', { selector: '.card-title' }));
    await screen.findByRole('complementary', { name: 'Details of ov-5' });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull());
    expect(document.activeElement).toBe(card);
  });
  it('opens the same shared pane for a clicked card and from the deep link, and closes it either way', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { unmount } = render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Review task', { selector: '.card-title' }));
    const clicked = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    await within(clicked).findByText('Description of Review task');
    fireEvent.click(within(clicked).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    unmount();
    // The hash the shell keeps reopens the same pane, with the same fetched parts.
    render(<Board {...props()} board={board} initialSelected="ov-5" />);
    const deepLinked = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    expect(await within(deepLinked).findByText('Description of Review task')).toBeTruthy();
    expect(within(deepLinked).getByText(/all green/)).toBeTruthy();
  });
  it('says when the pane could not be refreshed and keeps the last known details, with a Retry (fix round 15 review M-6)', async () => {
    let fail = false;
    mockApi((_m, url) => {
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Review task'));
    await waitFor(() => expect(screen.getByText(/all green/)).toBeTruthy());
    fail = true;
    rerender(<Board {...props()} board={board} version={1} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Showing the last known details; they could not be refreshed (boom). Retry'));
    expect(screen.getByText(/all green/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.getByText(/all green/)).toBeTruthy();
  });
  it('shows a pending badge on the card and the batch row from the board, and keeps it through an outage', () => {
    const r = board.repos[0]!;
    const pendingCard = { ...r.cards[2]!, pending_action: { job_id: 'j1', action: 'merge', started_at: '2026-09-13T00:00:00.000Z' } };
    const pendingBatch = { ...r.batches[0]!, pending_action: { job_id: 'j2', action: 'abandon', started_at: '2026-09-13T00:00:00.000Z' } };
    const pending = { ...board, repos: [{ ...r, cards: [pendingCard], batches: [pendingBatch] }] };
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    const { rerender } = render(<Board {...props()} board={pending} />);
    const card = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(card).getByText('Merging…')).toBeTruthy();
    const row = screen.getByText('#9310 Trend chart').closest('.batch') as HTMLElement;
    expect(within(row).getByText('Abandoning…')).toBeTruthy();
    // The daemon going offline leaves it in place: only the next board data, or the job's result, can clear it.
    rerender(<Board {...props()} board={pending} offline />);
    expect(within(card).getByText('Merging…')).toBeTruthy();
    expect(within(row).getByText('Abandoning…')).toBeTruthy();
    // The next board, with no pending action, drops both.
    rerender(<Board {...props()} board={board} />);
    const settled = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(settled).queryByText('Merging…')).toBeNull();
    expect(within(screen.getByText('#9310 Trend chart').closest('.batch') as HTMLElement).queryByText('Abandoning…')).toBeNull();
  });
  it('drops the card and batch row badges of a job whose result arrived while the board is stale, and keeps a newer job\'s', () => {
    const r = board.repos[0]!;
    const started_at = '2026-09-13T00:00:00.000Z';
    const withJobs = (cardJob: string, batchJob: string): BoardResponse => ({ ...board, repos: [{ ...r, cards: [{ ...r.cards[2]!, pending_action: { job_id: cardJob, action: 'merge', started_at } }], batches: [{ ...r.batches[0]!, pending_action: { job_id: batchJob, action: 'abandon', started_at } }] }] });
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    const stale = withJobs('j-card-old', 'j-batch-old');
    const { rerender } = render(<Board {...props()} board={stale} />);
    const card = () => screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    const row = () => screen.getByText('#9310 Trend chart').closest('.batch') as HTMLElement;
    expect(within(card()).getByText('Merging…')).toBeTruthy();
    expect(within(row()).getByText('Abandoning…')).toBeTruthy();
    act(() => {
      jobEnded({ job_id: 'j-card-old', action: 'merge', target: r.cards[2]!.bead.id, ok: true, message: null, data: null });
      jobEnded({ job_id: 'j-batch-old', action: 'abandon', target: 'r1-b1', ok: false, message: 'bd is unavailable', data: null });
    });
    // Both rows still name their jobs, whose results are known: no badge says they run.
    expect(within(card()).queryByText('Merging…')).toBeNull();
    expect(within(row()).queryByText('Abandoning…')).toBeNull();
    // A board event whose refetch failed: the app shell keeps the stale board, and the badges stay gone.
    rerender(<Board {...props()} board={stale} />);
    expect(within(card()).queryByText('Merging…')).toBeNull();
    expect(within(row()).queryByText('Abandoning…')).toBeNull();
    // A newer job on a row is a job that runs; the other row's ended job stays cleared.
    rerender(<Board {...props()} board={withJobs('j-card-new', 'j-batch-old')} />);
    expect(within(card()).getByText('Merging…')).toBeTruthy();
    expect(within(row()).queryByText('Abandoning…')).toBeNull();
    rerender(<Board {...props()} board={withJobs('j-card-new', 'j-batch-new')} />);
    expect(within(row()).getByText('Abandoning…')).toBeTruthy();
  });

  it('shimmers the arrived board shape before the first board, and replaces it with the real columns', () => {
    const { rerender } = render(<Board {...props()} board={null} />);
    const shimmer = screen.getByTestId('shimmer');
    // The measured structure is the arrived one: the empty activity line, two live rows, the finished disclosure, tabs and two cards per column.
    expect(shimmer.querySelector('.shimmer-measure-container .activity-empty')?.textContent).toBe('No workers running.');
    expect(shimmer.querySelectorAll('.shimmer-measure-container .batch')).toHaveLength(2);
    expect(shimmer.querySelector('.shimmer-measure-container .batches-finished summary')?.textContent).toContain('100 finished batches');
    expect(shimmer.querySelector('.shimmer-measure-container .column-tabs[role="tablist"]')).toBeTruthy();
    expect(shimmer.querySelectorAll('.shimmer-measure-container .column')).toHaveLength(6);
    expect(shimmer.querySelectorAll('.shimmer-measure-container .card')).toHaveLength(12);
    expect(shimmer.querySelector('.shimmer-measure-container .column.ready')?.className).toContain('column-selected');
    expect(shimmer.querySelector('.shimmer-measure-container .batch-title')?.textContent).toContain('as long as the longest one an orchestrator writes');
    expect(shimmer.querySelector('.shimmer-measure-container .batch .mono.muted')?.textContent).toContain('feature/board-loading-placeholder-matches-the-arrived-repository-section-height-at-every-breakpoint');
    expect(shimmer.querySelector('.shimmer-measure-container .progress')?.getAttribute('data-shimmer-no-children')).toBe('true');
    expect(shimmer.querySelector('.shimmer-measure-container .batch .chip.open')?.textContent).toBe('in progress');
    expect(shimmer.querySelector('.shimmer-measure-container .batch > .mono')?.textContent).toContain('$123456.78');
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    expect(css).toMatch(/\.activity-empty\s*\{[^}]*min-height:\s*52px;[^}]*padding:\s*16px 0 10px;[^}]*margin-bottom:\s*20px;/);
    expect(css).toMatch(new RegExp(String.raw`@media ${PHONE_MEDIA}\s*\{[\s\S]*?\.activity-empty\s*\{\s*min-height:\s*58px;`));
    expect(screen.queryByText('Ready task')).toBeNull();
    rerender(<Board {...props()} board={board} />);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByText('Ready task')).toBeTruthy();
  });
  // Both lines of a batch row wrap, so the row's height is a line count. With shorter strings the placeholder row wrapped to fewer
  // lines than the arrived one and the batch row settled 21 to 81 px taller (measured at 390/440/767/768/1440). These two strings
  // are as long as the worst case a batch carries (a 139-character sentence title, a 100-character branch): 140 and 99, which wrap to the
  // same 6/5/2/7/2 title lines and 5/5/2/5/1 branch lines the arrived row does, and the row's delta is 0 px at all five widths.
  // jsdom does not lay text out, so the length is what is checked here: shorten either string and the wrapping stops matching.
  it('reserves the batch row with strings as long as the worst-case title and branch, which is what its wrapping depends on', () => {
    render(<Board {...props()} board={null} />);
    const shimmer = screen.getByTestId('shimmer');
    const title = shimmer.querySelector('.shimmer-measure-container .batch-title')?.textContent ?? '';
    const branch = shimmer.querySelector('.shimmer-measure-container .batch .mono.muted')?.textContent ?? '';
    expect(title.length).toBeGreaterThanOrEqual(139);
    // The branch line renders as `<branch> → <base>`; the branch alone is the 99 characters that were measured.
    expect(branch.replace(/ → .*$/, '').length).toBeGreaterThanOrEqual(99);
  });
  it('stops the board shimmer during an outage, rather than shimmering invented columns for its whole length', () => {
    render(<Board {...props()} board={null} offline />);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByText('Loading board…')).toBeTruthy();
  });
  it('shimmers the fetched blocks of the side pane, and replaces them with the real History', async () => {
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    const shimmer = within(pane).getByTestId('shimmer');
    // A freshly dispatched Running card has a branch and a session but no finished verification, so only History and the text are reserved.
    const running = [...shimmer.querySelectorAll('.shimmer-measure-container h4')].map((h) => h.textContent);
    expect(running).toEqual(['History', 'Last assistant text']);
    expect(within(pane).queryByRole('heading', { name: 'History' })).toBeNull();
    release({ ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-3', notes: 'Created' }, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', status: 'running' }], worktree: { ...reviewDetail.worktree!, verify_status: null, verify_output: null } });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy());
    expect(within(pane).queryByTestId('shimmer')).toBeNull();
    // What arrived is what was reserved: no verification block, so the pane does not collapse by its height.
    expect([...pane.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['History', 'Last assistant text']);
  });
  it('reserves the verification block once a verification has run, and not before', async () => {
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Failed task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-6' });
    const shimmer = within(pane).getByTestId('shimmer');
    const headings = [...shimmer.querySelectorAll('.shimmer-measure-container h4')].map((h) => h.textContent);
    expect(headings).toEqual(['History', 'Last assistant text', 'Verification: passed']);
    release({ ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-6', notes: 'Verification failed' }, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-6' }], worktree: { ...reviewDetail.worktree!, verify_status: 'fail', verify_output: '$ pnpm test\n1 failed\nexit 1' } });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy());
    expect([...pane.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['History', 'Last assistant text', 'Verification: failed']);
  });
  it('reserves the verification block of a re-dispatched card whose branch still carries a failed verification', async () => {
    // The daemon hides the failure from a running card (the chip and the badge count what failed now) but the pane still shows the
    // previous verification, so only the card's own verify_block predicts it (round 3 review, finding 1).
    const cards = board.repos[0]!.cards;
    const rerun: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-3' ? { ...c, verify_block: 'output' as const } : c)) }] };
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={rerun} />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    const shimmer = within(pane).getByTestId('shimmer');
    expect([...shimmer.querySelectorAll('.shimmer-measure-container h4')].map((h) => h.textContent)).toEqual(['History', 'Last assistant text', 'Verification: passed']);
    release({ ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-3', notes: 'Re-dispatched' }, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', status: 'running' }], worktree: { ...reviewDetail.worktree!, verify_status: 'fail', verify_output: '$ pnpm test\nexit 1' } });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy());
    // The block that arrives is the one that was reserved, so Stop worker does not move when the detail lands.
    expect([...pane.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['History', 'Last assistant text', 'Previous verification: failed']);
  });

  it('reserves no verification block for a bead closed before any verification ran', async () => {
    // Done holds landed beads and beads closed as won't-do; only the latter has no verification to show (round 3 review, finding 2).
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-8')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Abandoned task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-8' });
    const shimmer = within(pane).getByTestId('shimmer');
    expect([...shimmer.querySelectorAll('.shimmer-measure-container h4')].map((h) => h.textContent)).toEqual(['History', 'Last assistant text']);
    release({ ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-8', notes: 'Closed' }, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-8' }], worktree: { ...reviewDetail.worktree!, verify_status: null, verify_output: null } });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy());
    expect([...pane.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['History', 'Last assistant text']);
  });

  it('reserves only the blocks a never-dispatched bead can have, so the pane does not collapse when the detail lands', async () => {
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-1')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Ready task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-1' });
    const shimmer = within(pane).getByTestId('shimmer');
    // No session and no branch, so neither the last assistant text nor a verification can arrive: History alone is reserved.
    const headings = [...shimmer.querySelectorAll('.shimmer-measure-container h4')].map((h) => h.textContent);
    expect(headings).toEqual(['History']);
    release({ ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-1', notes: 'Created' }, sessions: [], last_assistant_text: null, worktree: null });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy());
    expect(within(pane).queryByTestId('shimmer')).toBeNull();
  });
  it('renders the board it is given without fetching it, and a placeholder only before the first one', () => {
    const fetches: string[] = [];
    mockApi((_m, url) => { fetches.push(url); throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const { rerender } = render(<Board {...props()} board={null} />);
    expect(screen.getByText(/loading board/i)).toBeTruthy();
    rerender(<Board {...props()} board={board} />);
    expect(screen.queryByText(/loading board/i)).toBeNull();
    expect(screen.getByText('Ready task')).toBeTruthy();
    rerender(<Board {...props()} board={board} version={1} />);
    expect(screen.getByText('Ready task')).toBeTruthy();
    expect(fetches).toEqual([]);
  });
  it('shows the bd banner', () => {
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    render(<Board {...props()} board={{ bd_ok: false, repos: [{ repo: board.repos[0]!.repo, batches: [], cards: [] }] }} />);
    expect(screen.getByText(/bd unavailable/i)).toBeTruthy();
    expect(screen.queryByText('Ready task')).toBeNull();
  });
  it('shows the activity strip, batch rows, and stops a worker from the detail pane', async () => {
    const posts: string[] = [];
    const repo = board.repos[0]!;
    const running = repo.cards[2]!;
    const twoWorkers: BoardResponse = { ...board, repos: [{ ...repo, cards: [...repo.cards, { ...running, bead: { ...running.bead, id: 'ov-9', title: 'Another running task' }, cost: 0.73, session_id: 'sess-9' }] }] };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: board.repos[0]!.cards[2]!.bead, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', bead_id: 'ov-3', status: 'running', ended_at: null }] };
      if (method === 'POST' && url.endsWith('/api/tasks/ov-3/interrupt')) { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onOpenBatch = vi.fn();
    render(<Board {...props()} board={twoWorkers} onOpenBatch={onOpenBatch} />);
    const strip = screen.getByRole('region', { name: 'Running workers' });
    expect(strip.querySelectorAll('.activity-row')).toHaveLength(2);
    expect(within(strip).getByText('Running task')).toBeTruthy();
    expect(within(strip).getByText('Another running task')).toBeTruthy();
    expect(within(strip).getByText('$0.42')).toBeTruthy();
    fireEvent.click(screen.getByText('#9310 Trend chart'));
    expect(onOpenBatch).toHaveBeenCalledWith('r1-b1');
    expect(screen.getByText('2/4')).toBeTruthy();
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop worker' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Trace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop worker' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-3/interrupt']));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy(); // the job runs until the worker has been stopped
    await endJobs();
    // Both outcomes: the daemon lands the work of a worker that had already committed, and the line promised Ready either way (round 20 R20-1).
    await waitFor(() => expect(screen.getByText(/stop requested/i).textContent).toBe('Stop requested. Once the worker exits the card moves back to Ready, unless it had already committed: then its work stays on the branch and the bead goes on to verification. Either way the stop is recorded in History.'));
    expect(screen.queryByRole('button', { name: 'Stop worker' })).toBeNull();
  });
  it('reports a failed stop and keeps the button', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: board.repos[0]!.cards[2]!.bead, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', bead_id: 'ov-3', status: 'running', ended_at: null }] };
      if (method === 'POST' && url.endsWith('/api/tasks/ov-3/interrupt')) throw Object.assign(new Error('no running worker for ov-3'), { status: 400 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><Board {...props()} board={board} /><Toasts /></>);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop worker' }));
    await waitFor(() => expect((screen.getByRole('alert').querySelector('.toast-text') as HTMLElement).textContent).toBe('Could not stop the worker: no running worker for ov-3'));
    expect(screen.getByRole('button', { name: 'Stop worker' })).toBeTruthy();
  });
  it('opens a card with Enter and Space and exposes the batch behind a bead', async () => {
    const onOpenBatch = vi.fn();
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: board.repos[0]!.cards[2]!.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-3', batch_id: 'r1-b1' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} onOpenBatch={onOpenBatch} />);
    const card = screen.getByText('Review task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Description of Review task')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByText('Description of Review task')).toBeNull();
    fireEvent.keyDown(card, { key: ' ' });
    await waitFor(() => expect(screen.getByText('Description of Review task')).toBeTruthy());
    const batchRow = screen.getByText('#9310 Trend chart').closest('.batch') as HTMLElement;
    fireEvent.keyDown(batchRow, { key: ' ' });
    expect(onOpenBatch).toHaveBeenLastCalledWith('r1-b1');
    fireEvent.keyDown(screen.getByText('Running task', { selector: '.card-title' }).closest('.card')!, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open batch r1-b1' }));
    expect(onOpenBatch).toHaveBeenLastCalledWith('r1-b1');
  });
  it('scrolls the detail pane into view and focuses it; Escape closes it and returns focus to the card', async () => {
    const scrolls: Element[] = [];
    Element.prototype.scrollIntoView = function () { scrolls.push(this); };
    try {
      mockApi((_m, url) => {
        if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
        throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      });
      render(<Board {...props()} board={board} />);
      const card = screen.getByText('Review task', { selector: '.card-title' }).closest('.card') as HTMLElement;
      card.focus();
      fireEvent.keyDown(card, { key: 'Enter' });
      const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
      expect(scrolls).toEqual([pane]);
      expect(document.activeElement).toBe(pane);
      fireEvent.keyDown(pane, { key: 'Escape' });
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(document.activeElement).toBe(card);
    } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
  });
  it('closes the pane on Escape wherever focus is, and opens the card a later hash names without a remount (round 17 R17-3, R17-4)', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onSelected = vi.fn();
    const { rerender } = render(<Board {...props()} board={board} initialSelected={null} onSelected={onSelected} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    // The shell read `#board/ov-5` while this view was up: the pane opens from the prop, and the selection is not reported back (no loop).
    rerender(<Board {...props()} board={board} initialSelected="ov-5" onSelected={onSelected} />);
    await screen.findByRole('complementary', { name: 'Details of ov-5' });
    expect(onSelected).not.toHaveBeenCalled();
    // Focus is nowhere near the pane (a user who tabbed away, or came back to the Board): Escape still closes it.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(onSelected).toHaveBeenLastCalledWith(null);
  });

  it('offers Retry close, and nothing else, on a bead that landed while bd could not record it (fix round 16 review N16-1)', async () => {
    const landedDetail = { ...reviewDetail, bead: board.repos[0]!.cards[3]!.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-4', batch_id: 'r1-b1', merged_at: '2026-09-13T01:00:00.000Z' }, last_assistant_text: null };
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-4')) return landedDetail;
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const cards = board.repos[0]!.cards;
    const unclosed: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-4' ? { ...c, state: 'landed_unclosed' as const, batch_id: 'r1-b1' } : c)) }] };
    const { rerender } = render(<Board {...props()} board={unclosed} />);
    fireEvent.click(screen.getByText('Verifying task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-4' });
    await within(pane).findByText(/^Verification:/);
    expect(within(pane).queryByRole('button', { name: /Retry verification|Re-dispatch|Close bead|Stop worker/ })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Retry close' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-4/close-landed']));
    expect(within(pane).getByRole('button', { name: 'Closing…' })).toBeTruthy();
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe('Closed in bd; the card moves to Done.'));
    expect(within(pane).queryByRole('button', { name: 'Retry close' })).toBeNull();
    // Once bd has the close, the card is done and the acknowledgement has done its job.
    const done: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-4' ? { ...c, column: 'done' as const, state: 'done' as const, batch_id: 'r1-b1' } : c)) }] };
    rerender(<Board {...props()} board={done} version={1} />);
    await waitFor(() => expect(within(pane).queryByRole('status')).toBeNull());
  });

  it('scrolls to a repo section when the rail asks for it', () => {
    const scrolls: Element[] = [];
    Element.prototype.scrollIntoView = function () { scrolls.push(this); };
    try {
      mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
      const two = { ...board, repos: [board.repos[0]!, { ...board.repos[0]!, repo: { ...board.repos[0]!.repo, id: 'r2' }, batches: [], cards: [] }] };
      const onJumped = vi.fn();
      const { rerender } = render(<Board {...props()} board={null} jumpTo="r2" onJumped={onJumped} />);
      expect(scrolls).toEqual([]); // nothing to scroll to before the board arrives
      expect(onJumped).not.toHaveBeenCalled();
      rerender(<Board {...props()} board={two} jumpTo="r2" onJumped={onJumped} />);
      expect(scrolls.map((e) => e.id)).toEqual(['repo-r2']);
      expect(onJumped).toHaveBeenCalledTimes(1); // App clears the request, so a later visit to the Board does not scroll again
      rerender(<Board {...props()} board={two} jumpTo={null} onJumped={onJumped} />);
      rerender(<Board {...props()} board={two} jumpTo="r2" onJumped={onJumped} />);
      expect(scrolls.map((e) => e.id)).toEqual(['repo-r2', 'repo-r2']); // a second click on the same repo scrolls again
    } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
  });
  it('shows batches in review inside the Review column and finished batches in a capped, collapsed group', () => {
    const b1 = board.repos[0]!.batches[0]!;
    const batches = [
      { ...b1, status: 'review' as const },
      { ...b1, id: 'r1-b2', title: 'Merged one', status: 'merged' as const, merged_at: '2026-09-13T01:00:00.000Z', updated_at: '2026-09-13T01:00:00.000Z', merged_commit: '6dbb0f8abc' , setup_at: null},
      { ...b1, id: 'r1-b3', title: 'Dropped one', status: 'abandoned' as const, updated_at: '2026-09-13T02:00:00.000Z' },
    ];
    const onOpenBatch = vi.fn();
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    const { rerender } = render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, batches }] }} onOpenBatch={onOpenBatch} />);
    const review = screen.getByRole('heading', { level: 3, name: 'Review (2)' }).closest('.column') as HTMLElement;
    const batchCard = within(review).getByText('#9310 Trend chart').closest('.card') as HTMLElement;
    expect(batchCard.className).toContain('card-batch');
    fireEvent.keyDown(batchCard, { key: 'Enter' });
    expect(onOpenBatch).toHaveBeenCalledWith('r1-b1');
    const finished = screen.getByText('2 finished batches').closest('details') as HTMLElement;
    expect(within(finished).getAllByText(/Merged one|Dropped one/).map((e) => e.textContent)).toEqual(['Dropped one', 'Merged one']);
    expect(within(finished).getByText('merged', { selector: '.chip' })).toBeTruthy();
    expect(screen.getAllByText('#9310 Trend chart')).toHaveLength(2); // the live row and the Review column card, not the finished group
    const many = Array.from({ length: FINISHED_MAX + 2 }, (_, i) => ({ ...batches[1]!, id: `r1-m${i}`, title: `Old ${i}`, updated_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z` }));
    rerender(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, batches: many }] } as BoardResponse} />);
    expect(screen.getByText(`${FINISHED_MAX + 2} finished batches (newest ${FINISHED_MAX} shown)`)).toBeTruthy();
    expect(screen.getAllByText(/^Old \d+$/)).toHaveLength(FINISHED_MAX);
  });
  it('caps the Done column and reveals the rest on demand', () => {
    const done = board.repos[0]!.cards[6]!;
    const many = Array.from({ length: DONE_CAP + 3 }, (_, i) => ({ ...done, bead: { ...done.bead, id: `d-${i}`, title: `Done ${i}` } }));
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: [...board.repos[0]!.cards.slice(0, 6), ...many] }] }} />);
    expect(screen.getByRole('heading', { level: 3, name: `Done (${DONE_CAP + 3})` })).toBeTruthy();
    expect(screen.getByText('Done 0')).toBeTruthy();
    expect(screen.queryByText(`Done ${DONE_CAP}`)).toBeNull();
    // "3 more" alone read as a label, not a control (round 25 nit).
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getByText(`Done ${DONE_CAP + 2}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText(`Done ${DONE_CAP}`)).toBeNull();
  });
  it('keeps the stop acknowledgement while the bead settles and drops it for another card', async () => {
    const running = (id: string, i: number) => ({ ...reviewDetail, bead: { ...board.repos[0]!.cards[i]!.bead, id }, sessions: [{ ...reviewDetail.sessions[0]!, id: `sess-${id}`, bead_id: id, status: 'running' as const, ended_at: null }] });
    let stoppedSessionEnded = false;
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-3')) { const d = running('ov-3', 2); return stoppedSessionEnded ? { ...d, sessions: [{ ...d.sessions[0]!, status: 'ended', ended_at: 'x' }] } : d; }
      if (url.endsWith('/api/tasks/ov-4')) return running('ov-4', 3);
      if (method === 'POST' && url.endsWith('/api/tasks/ov-3/interrupt')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const twoRunning = { ...board, repos: [{ ...board.repos[0]!, cards: board.repos[0]!.cards.map((c) => (c.bead.id === 'ov-4' ? { ...c, column: 'running' as const, state: 'running' as const, session_status: 'running' as const } : c)) }] };
    const { rerender } = render(<Board {...props()} board={twoRunning} />);
    fireEvent.click(await screen.findByText('Running task', { selector: '.card-title' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop worker' }));
    await endJobs();
    await screen.findByText(/stop requested/i);
    stoppedSessionEnded = true; // the session ends before the bead leaves Running
    rerender(<Board {...props()} board={{ ...twoRunning }} version={1} />);
    await waitFor(() => expect(screen.getByText(/stop requested/i)).toBeTruthy());
    fireEvent.click(screen.getByText('Verifying task', { selector: '.card-title' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop worker' })).toBeTruthy());
    expect(screen.queryByText(/stop requested/i)).toBeNull();
  });
  it('ticks the elapsed time of running workers between board fetches', async () => {
    vi.useFakeTimers();
    try {
      mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
      render(<Board {...props()} board={board} />);
      const strip = screen.getByRole('region', { name: 'Running workers' });
      expect(within(strip).getByText('2m 5s')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      expect(within(strip).getByText('2m 8s')).toBeTruthy();
      const running = screen.getByText('Running task', { selector: '.card-title' }).closest('.card')!;
      expect(within(running as HTMLElement).getByText('2m 8s')).toBeTruthy();
      expect(screen.getByText('5m 0s')).toBeTruthy(); // ended sessions do not tick
    } finally { vi.useRealTimers(); }
  });
  it('says when the details cannot be loaded and offers Retry, instead of "Loading details…" forever (round 15)', async () => {
    let fail = true;
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-3')) {
        if (fail) throw Object.assign(new Error('task ov-3 not found in any repo'), { status: 404 });
        return { ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-3', notes: 'Created' }, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', status: 'running' }] };
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    const alert = await within(pane).findByRole('alert');
    expect(alert.textContent).toContain('Could not load details (task ov-3 not found in any repo).');
    expect(within(pane).queryByText(/loading details/i)).toBeNull();
    expect(pane.getAttribute('aria-busy')).toBe('false');
    expect(within(pane).getByRole('button', { name: 'Stop worker' })).toBeTruthy(); // the card's own actions stay
    fail = false;
    fireEvent.click(within(pane).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy());
    expect(within(pane).queryByRole('alert')).toBeNull();
  });
  it('opens the pane from the card at once and fills in the fetched details', async () => {
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    expect(pane.getAttribute('aria-busy')).toBe('true');
    expect(within(pane).getByText('Description of Running task')).toBeTruthy();
    expect(within(pane).getByText(/loading details/i)).toBeTruthy();
    expect(document.activeElement).toBe(pane);
    release({ ...reviewDetail, bead: { ...reviewDetail.bead, id: 'ov-3', notes: 'Stopped by the user from the Board\nRe-dispatched to claude' }, last_assistant_text: '**Content verified:** `hi` is there', sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', status: 'running' }] });
    await waitFor(() => expect(within(pane).getByRole('button', { name: 'Stop worker' })).toBeTruthy());
    expect(within(pane).queryByText(/loading details/i)).toBeNull();
    expect(pane.getAttribute('aria-busy')).toBe('false');
    expect(within(pane).getByRole('heading', { name: 'History' })).toBeTruthy();
    // Markdown markers are not shown raw; an inline code span keeps its meaning as <code> (round 10).
    const lastText = within(pane).getByText('Content verified:', { exact: false });
    expect(lastText.textContent).toBe('Content verified: hi is there');
    expect(lastText.querySelector('code')!.textContent).toBe('hi');
  });
  it('stops ticking while the daemon is unreachable', async () => {
    vi.useFakeTimers();
    try {
      mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
      const p = props();
      const { rerender } = render(<Board {...p} board={board} offline />);
      const strip = screen.getByRole('region', { name: 'Running workers' });
      expect(within(strip).getByText('2m 5s')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      expect(within(strip).getByText('2m 5s')).toBeTruthy(); // frozen: nothing is known to be running
      rerender(<Board {...p} board={board} offline={false} />);
      await vi.advanceTimersByTimeAsync(1000);
      await act(async () => {}); // the tick's state update flushes with the next task
      expect(within(strip).getByText('2m 9s')).toBeTruthy(); // back: the real elapsed time, not a restart from the frozen value
    } finally { vi.useRealTimers(); }
  });
  // Fix round 26 review: Review disables Merge / Reject / Abandon during an outage and says why, while the Board pane left Retry
  // verification, Re-dispatch, Close bead and Stop worker enabled, so a click there went nowhere without a word.
  it('disables the pane actions while the daemon is unreachable, the way Review does', async () => {
    const failedDetail = { ...reviewDetail, bead: { ...board.repos[0]!.cards[5]!.bead }, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-6', batch_id: 'r1-b1', verify_status: 'fail' as const, verify_output: '$ pnpm test\nexit 1' }, last_assistant_text: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: board.repos[0]!.cards[2]!.bead, worktree: null, sessions: [], last_assistant_text: null, diff: null };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} offline />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const live = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    expect((within(live).getByRole('button', { name: 'Stop worker' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Failed task'));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-6' });
    const button = (name: string) => within(pane).getByRole('button', { name }) as HTMLButtonElement;
    await waitFor(() => expect(button('Retry verification').disabled).toBe(true));
    expect([button('Re-dispatch').disabled, button('Close bead').disabled]).toEqual([true, true]);
    expect(within(pane).getByText('The daemon is unreachable: nothing is sent and nothing is queued. Press again once it is back.')).toBeTruthy();
    expect(button('Open batch r1-b1').disabled).toBe(false); // reading the pane and moving around it is not sending
    rerender(<Board {...props()} board={board} />);
    await waitFor(() => expect(button('Retry verification').disabled).toBe(false));
    expect(within(pane).queryByText(/nothing is sent and nothing is queued/)).toBeNull();
  });
  it('marks a failed verification on the card, sorts it first, and offers Retry verification and Re-dispatch in the pane', async () => {
    const posts: string[] = [];
    const failedDetail = { ...reviewDetail, bead: { ...board.repos[0]!.cards[5]!.bead }, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-6', batch_id: 'r1-b1', verify_status: 'fail' as const, verify_output: '$ pnpm test\n1 failed\nexit 1' }, last_assistant_text: null };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && (url.endsWith('/api/tasks/ov-6/verify') || url.endsWith('/api/tasks/ov-6/redispatch'))) { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} />);
    const ready = screen.getByRole('heading', { level: 3, name: 'Ready (2)' }).closest('.column') as HTMLElement;
    const titles = [...ready.querySelectorAll('.card-title')].map((e) => e.textContent);
    expect(titles).toEqual(['Failed task', 'Ready task']); // the failed one first
    const card = within(ready).getByText('Failed task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(card).getByText('Failed').className).toContain('chip fail');
    expect(within(card).getByText('last run 20s')).toBeTruthy(); // not a bare "20s" that reads as running
    fireEvent.click(card);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-6' });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'Verification: failed' })).toBeTruthy());
    fireEvent.click(within(pane).getByRole('button', { name: 'Retry verification' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-6/verify']));
    // The job is the verification run: the button reads it and Re-dispatch is off until it ends.
    expect(within(pane).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect((within(pane).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(true);
    // It fails again: the job ends and the buttons are back.
    failedDetail.bead = { ...failedDetail.bead, notes: `${failedDetail.bead.notes}\nVerification failed:\nexit 1` };
    rerender(<Board {...props()} board={board} version={1} />);
    await endJobs(false, 'exit 1');
    const redispatch = await within(pane).findByRole('button', { name: 'Re-dispatch' });
    expect((redispatch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(redispatch);
    await waitFor(() => expect(posts.at(-1)).toBe('/api/tasks/ov-6/redispatch'));
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toMatch(/re-dispatched/i));
  });
  it('offers Retry verification and Re-dispatch for a branch with commits whose last verification did not fail, and labels a failed worker', async () => {
    // The round-6 dead end: after a re-dispatch the worker committed nothing, the verify status was cleared, the branch still carries the earlier commit.
    const crashed = { ...board.repos[0]!.cards[5]!, bead: { ...board.repos[0]!.cards[5]!.bead, id: 'ov-9', title: 'Crashed task' }, verify_failure: null, session_status: 'failed' as const, state: 'idle' as const };
    const withCrashed: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...board.repos[0]!.cards, crashed] }] };
    const detail = { ...reviewDetail, bead: crashed.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-9', batch_id: 'r1-b1', verify_status: null, verify_output: null }, sessions: [{ ...reviewDetail.sessions[0]!, status: 'failed' as const }], last_assistant_text: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={withCrashed} />);
    const card = screen.getByText('Crashed task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(card.className).toContain('card-failed');
    expect(within(card).getByText('Failed').className).toContain('chip fail');
    // One Failed pill covers both outcomes; the pane tells the session failure and branch verification apart.
    cleanup();
    const both = { ...crashed, verify_failure: 'exit 1' };
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: [both] }] }} />);
    const red = screen.getByText('Crashed task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(red).getByText('Failed')).toBeTruthy();
    cleanup();
    render(<Board {...props()} board={withCrashed} />);
    const card2 = screen.getByText('Crashed task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    fireEvent.click(card2);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    expect(await within(pane).findByRole('button', { name: 'Retry verification' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Re-dispatch' })).toBeTruthy();
    expect(within(pane).getByText(/Retry runs the verify command again/)).toBeTruthy();
    // Nothing on the branch (no diff): nothing to verify, so no Retry; Re-dispatch and Close bead are the two ways forward (round 26 R26-1).
    cleanup();
    mockApi((_m, url) => { if (url.endsWith('/api/tasks/ov-9')) return { ...detail, diff: '' }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Board {...props()} board={withCrashed} />);
    fireEvent.click(screen.getByText('Crashed task', { selector: '.card-title' }));
    const pane2 = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    await waitFor(() => expect(within(pane2).getByRole('heading', { name: 'History' })).toBeTruthy());
    expect(within(pane2).queryByRole('button', { name: 'Retry verification' })).toBeNull();
    expect(within(pane2).getByText(/Re-dispatch starts a new worker on it, and Close bead drops it/)).toBeTruthy();
    expect(within(pane2).getByRole('button', { name: 'Re-dispatch' })).toBeTruthy();
    expect(within(pane2).getByRole('button', { name: 'Close bead' })).toBeTruthy();
    // A v1 bead in review whose verification failed (the daemon states it verify_failed) keeps both buttons: Review offers Merge and Reject, not a re-run of a fixed command.
    cleanup();
    const v1 = { ...detail, bead: { ...detail.bead, labels: ['overseer:review'] }, worktree: { ...detail.worktree, batch_id: null, verify_status: 'fail' as const, verify_output: '$ pnpm test\nexit 1' }, sessions: [{ ...detail.sessions[0]!, status: 'ended' as const }] };
    mockApi((_m, url) => { if (url.endsWith('/api/tasks/ov-9')) return v1; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const v1Card = { ...crashed, bead: v1.bead, column: 'review' as const, state: 'verify_failed' as const, session_status: 'ended' as const, verify_failure: '$ pnpm test\nexit 1' };
    render(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: [...board.repos[0]!.cards, v1Card] }] }} />);
    fireEvent.click(screen.getByText('Crashed task', { selector: '.card-title' }));
    const pane3 = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    expect(await within(pane3).findByRole('button', { name: 'Retry verification' })).toBeTruthy();
    expect(within(pane3).getByRole('button', { name: 'Re-dispatch' })).toBeTruthy();
  });

  it('says the board is refreshing while a fetch is in flight and labels a passed verification without a command as not run', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return { ...reviewDetail, repo: { ...reviewDetail.repo, verify_command: null }, worktree: { ...reviewDetail.worktree!, verify_output: '(no verify command configured)' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} refreshing />);
    expect(document.querySelector('.refreshing')!.textContent).toBe('refreshing…');
    expect(screen.queryByRole('status')).toBeNull(); // not a live region: it would be announced on every fetch
    expect(screen.getByText('Running task', { selector: '.card-title' })).toBeTruthy(); // the previous board stays
    rerender(<Board {...props()} board={board} refreshing={false} />);
    expect(document.querySelector('.refreshing')!.textContent).toBe(''); // the node stays mounted; only its text changes
    fireEvent.click(screen.getByText('Review task', { selector: '.card-title' }));
    expect((await screen.findByRole('heading', { name: /^Verification:/ })).textContent).toBe('Verification: not run (no verify command configured)');
    expect(screen.queryByText('(no verify command configured)', { selector: 'pre' })).toBeNull(); // the sentinel output is not printed under the heading again (round 8)
  });

  it('closes the pane when its card leaves the board', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Review task', { selector: '.card-title' }));
    await screen.findByRole('complementary', { name: 'Details of ov-5' });
    rerender(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: board.repos[0]!.cards.filter((c) => c.bead.id !== 'ov-5') }] }} />);
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });
  it('keeps elapsed times when it is remounted with the same board', () => {
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    const boardAt = Date.now() - 60_000; // fetched a minute ago: the running card has ticked to 3m 5s
    const first = render(<Board {...props()} boardAt={boardAt} board={board} />);
    expect(within(screen.getByRole('region', { name: 'Running workers' })).getByText('3m 5s')).toBeTruthy();
    first.unmount();
    render(<Board {...props()} boardAt={boardAt} board={board} />);
    expect(within(screen.getByRole('region', { name: 'Running workers' })).getByText('3m 5s')).toBeTruthy();
  });

  it('keeps the strip, the Running column and the card in agreement while a worker settles, from one board', () => {
    const cards = board.repos[0]!.cards;
    const settling: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-3' ? { ...c, session_status: 'ended' as const, state: 'settling' as const } : c)) }] };
    const { rerender } = render(<Board {...props()} board={settling} />);
    const strip = screen.getByRole('region', { name: 'Running workers' });
    expect(within(strip).getByText('Running task')).toBeTruthy();
    expect(within(strip).getByText('settling…')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Running (1)' })).toBeTruthy();
    const card = screen.getByText('Running task', { selector: '.card-title' }).closest('.card')!;
    expect(card.textContent).toContain('settling…');
    expect(card.textContent).not.toContain('2m 5s');
    // Once the bead has settled the strip empties and the column with it: both read the same payload in the same render.
    const settled: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-3' ? { ...c, column: 'ready' as const, state: 'idle' as const, session_status: 'ended' as const } : c)) }] };
    rerender(<Board {...props()} board={settled} />);
    expect(screen.getByText(/No workers running\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Running (0)' })).toBeTruthy();
    expect(screen.getByText('Running task', { selector: '.card-title' }).closest('.card')!.textContent).toContain('last run 2m 5s');
    // A settling card with no session known (nothing to time) still says so (fix round 10 review).
    rerender(<Board {...props()} board={{ ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-3' ? { ...c, state: 'settling' as const, session_status: null, elapsed_ms: null } : c)) }] }} />);
    expect(screen.getByText('Running task', { selector: '.card-title' }).closest('.card')!.textContent).toContain('settling…');
  });

  it('offers nothing while a worker settles: no Retry verification, Re-dispatch or Stop, only "settling…" (round 11)', async () => {
    // The window after a worker's last message: session ended, bead still in_progress, no phase label, branch with commits, no failure.
    const cards = board.repos[0]!.cards;
    const settling: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-3' ? { ...c, session_status: 'ended' as const, state: 'settling' as const } : c)) }] };
    const detail = { ...reviewDetail, bead: cards[2]!.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-3', batch_id: 'r1-b1', verify_status: null, verify_output: null }, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', bead_id: 'ov-3' }], last_assistant_text: 'Done. The file now exists.' };
    mockApi((_m, url) => { if (url.endsWith('/api/tasks/ov-3')) return detail; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Board {...props()} board={settling} />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    await waitFor(() => expect(within(pane).getByText('Done. The file now exists.')).toBeTruthy()); // the detail has arrived
    expect(within(pane).getByText(/^settling…/)).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Retry verification' })).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Re-dispatch' })).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Stop worker' })).toBeNull();
    expect(within(pane).queryByText(/the command was wrong/)).toBeNull();
    expect(within(pane).getByRole('button', { name: 'Open batch r1-b1' })).toBeTruthy(); // navigation stays
  });

  it('offers Stop from the card data before the detail has loaded (round 11)', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return new Promise<unknown>(() => {}); // never resolves
      if (method === 'POST' && url.endsWith('/api/tasks/ov-3/interrupt')) { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    expect(within(pane).getByText(/loading details/i)).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Stop worker' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-3/interrupt']));
    await endJobs();
    await within(pane).findByText(/stop requested/i);
  });

  it('keeps Retry verification pending while the card is in Verifying, and brings the buttons back when it fails (round 11)', async () => {
    let release: () => void = () => {};
    const failedDetail = { ...reviewDetail, bead: board.repos[0]!.cards[5]!.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-6', batch_id: 'r1-b1', verify_status: 'fail' as const, verify_output: 'exit 1' }, last_assistant_text: null };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/verify')) return new Promise<unknown>((r) => { release = () => r(accept(url)); });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Failed task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-6' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Retry verification' }));
    // Before the request has returned: the button reads the action in progress and the target's others are off.
    expect(within(pane).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect((within(pane).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(true);
    // The board moves the card to Verifying and the 202 arrives: the job is the whole run, so the pressed button stays with its
    // label and the other stays off, in a state that offers neither (round 11: the line said nothing once the buttons went).
    const cards = board.repos[0]!.cards;
    const verifying: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, column: 'verifying' as const, state: 'verifying' as const, verify_failure: null } : c)) }] };
    rerender(<Board {...props()} board={verifying} version={1} />);
    await act(async () => { release(); });
    expect(within(pane).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect((within(pane).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(true);
    // It fails again: the card is back with a failure, the job ends and the buttons return, even before the new note has been fetched.
    rerender(<Board {...props()} board={board} version={2} />);
    await endJobs(false, 'exit 1');
    expect((await within(pane).findByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(pane).queryByRole('status')).toBeNull();
  });

  it('renders inline code in the bead description as code (round 11)', () => {
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    const cards = board.repos[0]!.cards;
    const withCode: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-1' ? { ...c, bead: { ...c.bead, description: 'Success criterion: `cat hi.txt` prints `hi`.' } } : c)) }] };
    render(<Board {...props()} board={withCode} />);
    fireEvent.click(screen.getByText('Ready task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-1' });
    const desc = within(pane).getByText('Success criterion:', { exact: false });
    expect(desc.textContent).toBe('Success criterion: cat hi.txt prints hi.');
    expect([...desc.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['cat hi.txt', 'hi']);
  });

  it('keeps the Re-dispatch acknowledgement while the board still says verify_failed and through the run, until the bead settles (round 12)', async () => {
    const cards = board.repos[0]!.cards;
    const failedDetail = { ...reviewDetail, bead: cards[5]!.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-6', batch_id: 'r1-b1', verify_status: 'fail' as const, verify_output: 'exit 1' }, last_assistant_text: null };
    let detail = failedDetail;
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return detail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/redispatch')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const withState = (state: 'verify_failed' | 'running' | 'settling'): BoardResponse => ({ ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, column: state === 'verify_failed' ? 'ready' as const : 'running' as const, state, verify_failure: state === 'verify_failed' ? c.verify_failure : null, session_status: state === 'running' ? 'running' as const : 'ended' as const } : c)) }] });
    const { rerender } = render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Failed task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-6' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Re-dispatch' }));
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toMatch(/re-dispatched/i));
    // The detail refetch brings the re-dispatch note before the board has caught up (it still says verify_failed): no buttons, the line stays.
    detail = { ...failedDetail, bead: { ...failedDetail.bead, notes: `${failedDetail.bead.notes}\nRe-dispatched to claude` } };
    rerender(<Board {...props()} board={withState('verify_failed')} version={1} />);
    await waitFor(() => expect(within(pane).getByText(/Re-dispatched to claude/)).toBeTruthy());
    expect(within(pane).queryByRole('button', { name: 'Re-dispatch' })).toBeNull();
    expect(within(pane).getByRole('status').textContent).toMatch(/re-dispatched/i);
    // Running, then settling: still the line; back in verify_failed after the run: the buttons return.
    rerender(<Board {...props()} board={withState('running')} version={2} />);
    expect(within(pane).getByRole('status')).toBeTruthy();
    rerender(<Board {...props()} board={withState('settling')} version={3} />);
    expect(within(pane).getByRole('status')).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Re-dispatch' })).toBeNull();
    rerender(<Board {...props()} board={withState('verify_failed')} version={4} />);
    expect(await within(pane).findByRole('button', { name: 'Re-dispatch' })).toBeTruthy();
    expect(within(pane).queryByRole('status')).toBeNull();
  });

  it('offers no Retry verification or Re-dispatch on a blocked bead, even with commits on its branch (fix round 11 review)', async () => {
    const blockedDetail = { ...reviewDetail, bead: board.repos[0]!.cards[1]!.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-2', verify_status: 'fail' as const, verify_output: 'exit 1' }, last_assistant_text: null };
    mockApi((_m, url) => { if (url.endsWith('/api/tasks/ov-2')) return blockedDetail; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Blocked task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-2' });
    await waitFor(() => expect(within(pane).getByText(/exit 1/)).toBeTruthy()); // the detail has arrived
    expect(within(pane).queryByRole('button', { name: 'Retry verification' })).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Re-dispatch' })).toBeNull();
  });

  // Round 26 R26-1: the card of a worker stopped before it committed offered Close bead and nothing else, so re-starting it cost a
  // Chat round trip and a whole orchestrator turn, where the neighbouring card state (verification failed) has the button.
  it('offers Re-dispatch on a bead whose worker was stopped before it committed, and sends it', async () => {
    const cards = board.repos[0]!.cards;
    const stopped = { ...cards[5]!, bead: { ...cards[5]!.bead, id: 'ov-9', title: 'Stopped task', notes: 'Stopped by the user from the Board (worker session sess-5, no new commits)' }, column: 'ready' as const, verify_failure: null, state: 'idle' as const };
    const withStopped: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...cards, stopped] }] };
    const detail = { ...reviewDetail, bead: stopped.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-9', batch_id: 'r1-b1', verify_status: null, verify_output: null }, last_assistant_text: null, diff: '' };
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={withStopped} />);
    // The card is back in Ready, as the stop acknowledgement promised.
    expect(within(screen.getByText('Stopped task', { selector: '.card-title' }).closest('.column')!).getByRole('heading').textContent).toMatch(/^Ready/);
    fireEvent.click(screen.getByText('Stopped task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    // Nothing is on the branch, so there is no run to retry: the new worker is the only action beside Close bead.
    expect(await within(pane).findByRole('button', { name: 'Re-dispatch' })).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Retry verification' })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Re-dispatch' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-9/redispatch']));
    expect(within(pane).getByRole('button', { name: 'Re-dispatching…' })).toBeTruthy();
    await endJobs();
    // Acknowledged once its job has ended well and without the verify-failed line: no output travels in this worker's instructions.
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe('Re-dispatched; a new worker starts on the bead.'));
    expect(within(pane).queryByRole('button', { name: /Re-dispatch/ })).toBeNull();
  });

  // The question and the note live in the pane, not in a native `prompt()`: an embedded browser (a sandboxed iframe, a webview) answers
  // `prompt()` with null without showing it, and the handler took that for Cancel, so the button did nothing at all (overseer-f63).
  it('closes an idle bead as won\'t do from the pane after an in-pane confirmation that takes the note, and names closed beads in the batch counts (round 13)', async () => {
    const cards = board.repos[0]!.cards;
    const stopped = { ...cards[5]!, bead: { ...cards[5]!.bead, id: 'ov-9', title: 'Stopped task', notes: 'Stopped by the user from the Board (worker session s, no new commits)' }, verify_failure: null, state: 'idle' as const };
    const withStopped: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, beads_done: 1, beads_closed: 1 }], cards: [...cards, stopped] }] };
    const detail = { ...reviewDetail, bead: stopped.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-9', batch_id: 'r1-b1', verify_status: null, verify_output: null }, last_assistant_text: null, diff: '' };
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-9/close')) { posts.push({ url, body }); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    // The batch row and the Review-column card say what landed and what was closed instead of a bare fraction.
    render(<Board {...props()} board={withStopped} />);
    expect(screen.getByText('1 landed, 1 closed of 4')).toBeTruthy();
    fireEvent.click(screen.getByText('Stopped task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    const close = await within(pane).findByRole('button', { name: 'Close bead' });
    // No native dialog is involved: one that is suppressed must not be able to swallow the click.
    vi.stubGlobal('prompt', () => { throw new Error('prompt() must not be used'); });
    fireEvent.click(close);
    expect(within(pane).getByText(/Close “Stopped task” \(ov-9\) as won't do\? .* batch r1-b1 stays open/)).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Close bead' })).toBeNull();
    // Cancel: nothing is sent, the question goes and the button is back.
    fireEvent.click(within(pane).getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    expect(within(pane).queryByText(/as won't do\?/)).toBeNull();
    expect(within(pane).getByRole('button', { name: 'Close bead' })).toBeTruthy();
    // Confirm with a note: the request carries it, the button reads Closing… until the job ends, then the line acknowledges it and the buttons go.
    fireEvent.click(within(pane).getByRole('button', { name: 'Close bead' }));
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Note for the orchestrator (optional)' }), { target: { value: '  Not needed after all ' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/tasks/ov-9/close', body: { note: 'Not needed after all' } }]));
    expect(within(pane).getByRole('button', { name: 'Closing…' })).toBeTruthy();
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe("Closed as won't do; the orchestrator was told and batch r1-b1 stays open."));
    expect(within(pane).queryByText(/as won't do\?/)).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Close bead' })).toBeNull();
    expect(within(pane).queryByText(/Re-dispatch starts a new worker on it/)).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Re-dispatch' })).toBeNull();
    // A refusal replaces the line with the reason.
    cleanup();
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      if (method === 'POST') throw Object.assign(new Error('bead ov-9 is busy: a worker runs on it'), { status: 400 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><Board {...props()} board={withStopped} /><Toasts /></>);
    fireEvent.click(screen.getByText('Stopped task', { selector: '.card-title' }));
    const pane2 = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    fireEvent.click(await within(pane2).findByRole('button', { name: 'Close bead' }));
    fireEvent.click(within(pane2).getByRole('button', { name: 'Confirm close' }));
    expect(((await screen.findByRole('alert')).querySelector('.toast-text') as HTMLElement).textContent).toBe('Could not close the bead: bead ov-9 is busy: a worker runs on it');
    expect(within(pane2).getByRole('button', { name: 'Close bead' })).toBeTruthy();
  });

  it("names the batch's real status when the bead closed as won't do belongs to one that is no longer open (fix round 18 review M1)", async () => {
    const cards = board.repos[0]!.cards;
    const stopped = { ...cards[5]!, bead: { ...cards[5]!.bead, id: 'ov-9', title: 'Stopped task' }, batch_id: 'r1-b1', verify_failure: null, state: 'idle' as const };
    // The round-16 case: a bead of a batch that has since merged is still closable from the Board, and the batch does not "stay open".
    const merged: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'merged' as const }], cards: [...cards, stopped] }] };
    const detail = { ...reviewDetail, bead: stopped.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-9', batch_id: 'r1-b1', verify_status: null, verify_output: null }, last_assistant_text: null, diff: '' };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-9/close')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={merged} />);
    fireEvent.click(screen.getByText('Stopped task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Close bead' }));
    expect(within(pane).getByText(`Close “Stopped task” (ov-9) as won't do? Its branch and worktree are removed; its batch r1-b1 is merged.`)).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Confirm close' }));
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe("Closed as won't do; the orchestrator was told; its batch r1-b1 is merged."));
  });

  // Round 26 nit: "batch <id> stays open and counts it as closed" was true for the second before the orchestrator handed the batch
  // over; the Board had it in Review on the next refresh. The counts the batch row already carries say which of the two it is.
  it('says the batch goes to review instead of staying open when the closed bead is its last open one', async () => {
    const cards = board.repos[0]!.cards;
    const stopped = { ...cards[5]!, bead: { ...cards[5]!.bead, id: 'ov-9', title: 'Stopped task' }, verify_failure: null, state: 'idle' as const };
    const lastOpen: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, beads_total: 2, beads_done: 1, beads_closed: 0 }], cards: [...cards, stopped] }] };
    const detail = { ...reviewDetail, bead: stopped.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-9', batch_id: 'r1-b1', verify_status: null, verify_output: null }, last_assistant_text: null, diff: '' };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-9/close')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={lastOpen} />);
    fireEvent.click(screen.getByText('Stopped task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Close bead' }));
    expect(within(pane).getByText(`Close “Stopped task” (ov-9) as won't do? Its branch and worktree are removed; batch r1-b1 then has no bead left open, so the orchestrator hands it over for review.`)).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Confirm close' }));
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe("Closed as won't do; batch r1-b1 has no bead left open and the orchestrator hands it over for review."));
  });

  it("marks a bead that came from the repository's own bd database and says so in its pane (round 19 R19-5)", async () => {
    const note = "This bead was already in the repository's bd database; no batch in this Overseer install claims it. Ask the orchestrator in Chat if you want it worked on.";
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-1')) return { ...reviewDetail, bead: board.repos[0]!.cards[0]!.bead, worktree: null, sessions: [], last_assistant_text: null, diff: null };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    // ov-1 has no batch, no branch and no session of this install; ov-3 was dispatched here.
    const ready = screen.getByText('Ready task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(ready).queryByText('from bd')).toBeNull();
    const running = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(running).queryByText('from bd')).toBeNull();
    fireEvent.click(screen.getByText('Ready task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-1' });
    expect(within(pane).getByText(note)).toBeTruthy();
    // A bead in Done is closed: there is nothing to ask for, so only the fact is said (fix round 19 review NB-2).
    cleanup();
    const r = board.repos[0]!;
    const oldDone = { ...r.cards[6]!, bead: { ...r.cards[6]!.bead, id: 'ov-70', title: 'Closed before Overseer' }, batch_id: null, branch: null, session_id: null, session_status: null };
    render(<Board {...props()} board={{ ...board, repos: [{ ...r, cards: [oldDone] }] }} />);
    const done = screen.getByText('Closed before Overseer', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(done).queryByText('from bd')).toBeNull();
  });

  it('says the batch is gone, not that the bead predates Overseer, when its record was removed with the repository (round 21 R21-3)', async () => {
    const r = board.repos[0]!;
    // The repo was removed from Overseer and registered again: bd still has the label, this install has no such batch, no branch and no session.
    const orphan = { ...r.cards[0]!, bead: { ...r.cards[0]!.bead, id: 'ov-40', title: 'Worked on before', notes: 'Re-dispatched to claude' }, batch_id: null, branch: null, session_id: null };
    orphan.bead.labels = ['overseer:batch:r1-b9'];
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-40')) return { ...reviewDetail, bead: orphan.bead, worktree: null, sessions: [], last_assistant_text: null, diff: null };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={{ ...board, repos: [{ ...r, cards: [orphan] }] }} />);
    const note = 'Overseer worked on this bead, but the batch that owned it is gone from its records: the repository was removed and registered again, or the data directory was reset. Ask the orchestrator in Chat if you want it worked on.';
    const card = screen.getByText('Worked on before', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(card).queryByText('from bd')).toBeNull();
    fireEvent.click(screen.getByText('Worked on before', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-40' });
    expect(within(pane).getByText(note)).toBeTruthy();
    expect(within(pane).queryByText(/already in the repository's bd database/)).toBeNull();
  });

  it('names a bead the board has no card for instead of closing the pane without a word (round 21 nit)', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-404')) throw Object.assign(new Error('task ov-404 not found'), { status: 404 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} initialSelected="ov-404" />);
    await waitFor(() => expect(screen.getByText('No card for ov-404 on the Board: no registered repository has that bead any more.')).toBeTruthy());
    expect(screen.queryByRole('complementary')).toBeNull();
    // Opening any card answers it, so the line does not outstay its welcome.
    fireEvent.click(screen.getByText('Ready task', { selector: '.card-title' }));
    expect(screen.queryByText(/No card for ov-404/)).toBeNull();
  });

  it("clears that line when the shell's hash opens a card, not only a click (fix round 21 review NB-3)", async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-404')) throw Object.assign(new Error('task ov-404 not found'), { status: 404 });
      if (url.endsWith('/api/tasks/ov-1')) return { ...reviewDetail, bead: board.repos[0]!.cards[0]!.bead, worktree: null, sessions: [], last_assistant_text: null, diff: null };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Board {...props()} board={board} initialSelected="ov-404" />);
    await waitFor(() => expect(screen.getByText(/No card for ov-404/)).toBeTruthy());
    rerender(<Board {...props()} board={board} initialSelected="ov-1" />);
    expect(await screen.findByRole('complementary', { name: 'Details of ov-1' })).toBeTruthy();
    expect(screen.queryByText(/No card for ov-404/)).toBeNull();
  });

  it('heads the verification block as the previous run while a worker runs on the bead (fix round 21 review NB-2)', async () => {
    // The failure stays on the worktree row through a re-dispatch (round 21 R21-1); until the new run is verified it is the previous run's result, and the card's chip is hidden for the same reason.
    const running = board.repos[0]!.cards[2]!;
    const failed = { ...reviewDetail, bead: running.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-3', verify_status: 'fail' as const, verify_output: '$ pnpm test\n1 failed\nexit 1' }, last_assistant_text: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return failed;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} initialSelected="ov-3" />);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'Previous verification: failed' })).toBeTruthy());
    expect(within(pane).getByText(/1 failed/)).toBeTruthy(); // the output stays: the new worker starts on that branch
  });

  it("says nothing about a batch when the bead closed as won't do belongs to none (round 18 R18-3)", async () => {
    const cards = board.repos[0]!.cards;
    // A bead whose only batch label names a batch this install does not have: the daemon reports no batch_id for it.
    const loose = { ...cards[5]!, bead: { ...cards[5]!.bead, id: 'ov-9', title: 'Loose task' }, batch_id: null, verify_failure: null, state: 'idle' as const };
    const withLoose: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...cards, loose] }] };
    const detail = { ...reviewDetail, bead: loose.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-9', batch_id: null, verify_status: null, verify_output: null }, last_assistant_text: null, diff: '' };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-9')) return detail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-9/close')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={withLoose} />);
    fireEvent.click(screen.getByText('Loose task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-9' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Close bead' }));
    expect(within(pane).getByText(`Close “Loose task” (ov-9) as won't do? Its branch and worktree are removed.`)).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Confirm close' }));
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe("Closed as won't do; the orchestrator was told."));
  });

  // Round 25 R25-4: the sentence counted the blockers without naming them (a `bd show` in a terminal was the only way to learn which),
  // and a blocked bead could not be closed from the UI at all, unlike every other undispatched card.
  it('names the beads a blocked one waits on, links to their cards and offers Close bead (round 25 R25-4, fix round 12 review)', async () => {
    const detail = { ...reviewDetail, bead: { ...board.repos[0]!.cards[1]!.bead, dependency_count: 2 }, blocked_by: ['ov-1', 'ov-404'], worktree: null, sessions: [], last_assistant_text: null, diff: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-2')) return detail;
      if (url.endsWith('/api/tasks/ov-1')) return { ...detail, bead: board.repos[0]!.cards[0]!.bead, blocked_by: [] };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const blocked = { ...board, repos: [{ ...board.repos[0]!, cards: board.repos[0]!.cards.map((c) => (c.bead.id === 'ov-2' ? { ...c, bead: { ...c.bead, dependency_count: 2 } } : c)) }] };
    const { unmount } = render(<Board {...props()} board={blocked} />);
    fireEvent.click(screen.getByText('Blocked task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-2' });
    await waitFor(() => expect(within(pane).getByText(/Blocked: waits on/).textContent).toBe('Blocked: waits on ov-1, ov-404 to close; the orchestrator dispatches it once it is ready.'));
    expect(within(pane).queryByRole('button', { name: 'ov-404' })).toBeNull(); // no card on this board: named, not offered as a link
    expect(within(pane).getByRole('button', { name: 'Close bead' })).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Retry verification' })).toBeNull(); // nothing to re-run on a bead no worker has touched
    fireEvent.click(within(pane).getByRole('button', { name: 'ov-1' }));
    expect(await screen.findByRole('complementary', { name: 'Details of ov-1' })).toBeTruthy();
    unmount();
    // Before the detail lands, and when the bd read behind it failed, the card's own count stands, the way it did before.
    mockApi((_m, url) => { if (url.endsWith('/api/tasks/ov-2')) return { ...detail, blocked_by: [] }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Board {...props()} board={blocked} initialSelected="ov-2" />);
    const again = await screen.findByRole('complementary', { name: 'Details of ov-2' });
    await waitFor(() => expect(again.getAttribute('aria-busy')).toBe('false'));
    expect(within(again).getByText(/Blocked: waits on/).textContent).toBe('Blocked: waits on 2 other beads to close; the orchestrator dispatches it once it is ready.');
  });

  it('paints the newest detail when two detail responses land out of order (fix round 12 review)', async () => {
    const pending: ((v: unknown) => void)[] = [];
    mockApi((_m, url) => { if (url.endsWith('/api/tasks/ov-5')) return new Promise<unknown>((r) => { pending.push(r); }); throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const { rerender } = render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Review task', { selector: '.card-title' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<Board {...props()} board={board} version={1} />);
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]!({ ...reviewDetail, last_assistant_text: 'newer' }); });
    await act(async () => { pending[0]!({ ...reviewDetail, last_assistant_text: 'older' }); });
    expect(screen.getByText('newer')).toBeTruthy();
    expect(screen.queryByText('older')).toBeNull();
  });

  it('opens a readable trace under the pane instead of a raw JSON tab', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (url.endsWith('/api/sessions/sess-5/events')) return [{ id: 1, session_id: 'sess-5', seq: 1, type: 'assistant_text', payload: { type: 'assistant_text', text: 'Done. Added the endpoint.' }, ts: '2026-09-12T10:06:40.000Z' }];
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByText('Review task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    expect(within(pane).queryByRole('link', { name: 'Trace' })).toBeNull();
    fireEvent.click(await within(pane).findByRole('button', { name: 'Trace' }));
    const trace = within(pane).getByRole('region', { name: 'Trace' });
    expect((await within(trace).findByText('assistant_text')).closest('summary')!.textContent).toContain('Done. Added the endpoint.');
    expect((within(trace).getByRole('link', { name: 'raw JSON' }) as HTMLAnchorElement).getAttribute('href')).toBe('/api/sessions/sess-5/events');
    fireEvent.click(within(pane).getByRole('button', { name: 'Hide trace' }));
    expect(within(pane).queryByRole('region', { name: 'Trace' })).toBeNull();
  });

  it('lists the six columns with their counts in a tab strip and switches the selected column, for the one-column phone layout', () => {
    render(<Board {...props()} board={board} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Columns of r1' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Ready 2', 'Blocked 1', 'Running 1', 'Verifying 1', 'Review 1', 'Done 2']);
    // The default is the first column with cards; every column stays in the DOM (desktop shows them all), the phone CSS shows the selected one.
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.column.column-selected')!.className).toContain('ready');
    fireEvent.click(tabs[2]!);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    const selected = document.querySelectorAll('.column.column-selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.className).toContain('running');
    expect(within(selected[0] as HTMLElement).getByText('Running task')).toBeTruthy();
  });
  it('defaults the phone column to Ready when no column has a card', () => {
    const r = board.repos[0]!;
    render(<Board {...props()} board={{ ...board, repos: [{ ...r, cards: [], batches: [] }] }} />);
    expect(screen.getByRole('tab', { name: 'Ready 0' }).getAttribute('aria-selected')).toBe('true');
  });
  it('opens the card as a sheet with a Back button that returns to the board and keeps the picked column', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={board} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Review 1' }));
    fireEvent.click(screen.getByText('Review task'));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    expect(within(pane).getByText('ov-5', { selector: '.detail-head span' })).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Back to board' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Review 1' }).getAttribute('aria-selected')).toBe('true');
  });
});

// Model routing and review rounds: the card names the tier and model a bead was routed to, a critic's run reads as a review, and a
// bead parked with the critic's findings asks the user for a decision (Re-dispatch, Close bead, Land anyway).
describe('Board review rounds', () => {
  const cards = board.repos[0]!.cards;
  const findings = [{ file: 'src/a.ts', summary: 'Missing null check on the response.', severity: 'must' as const }, { file: null, summary: 'No test for the empty case.', severity: 'should' as const }];
  const awaiting = { ...cards[5]!, bead: { ...cards[5]!.bead, id: 'ov-10', title: 'Awaiting task' }, verify_failure: null, state: 'awaiting_decision' as const, tier: 'standard' as const, model: 'gpt-5.6-terra', findings };
  const reviewing = { ...cards[3]!, bead: { ...cards[3]!.bead, id: 'ov-11', title: 'Reviewing task' }, state: 'reviewing' as const, session_status: 'running' as const, session_id: 'sess-11', tier: 'standard' as const, model: 'gpt-5.6-terra' };
  const detailFor = (c: typeof awaiting | typeof reviewing) => ({ ...reviewDetail, bead: c.bead, worktree: { ...reviewDetail.worktree!, bead_id: c.bead.id, batch_id: 'r1-b1', review_findings: c.findings }, sessions: [{ ...reviewDetail.sessions[0]!, id: c.session_id!, bead_id: c.bead.id, status: c.session_status!, ended_at: c.session_status === 'running' ? null : reviewDetail.sessions[0]!.ended_at }], last_assistant_text: null });

  it('shows the tier and model on a card that has them, and the harness alone on one that does not', () => {
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...cards, awaiting] }] };
    render(<Board {...props()} board={b} />);
    const card = screen.getByText('Awaiting task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(card).getByText('claude · gpt-5.6-terra').className).toContain('card-agent');
    const legacy = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(legacy).getByText('claude')).toBeTruthy();
    expect(within(legacy).queryByText(/ · /)).toBeNull();
  });

  it('keeps the selected account off the card face, in the agent tooltip and pane', async () => {
    const [running, verifying] = [cards[2]!, cards[3]!];
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [
      { ...running, tier: 'standard', model: 'gpt-5.6-terra', account_name: 'Work Account', account_label: 'Work' },
      { ...verifying, account_name: 'Personal', account_label: null },
    ] }] };
    render(<Board {...props()} board={b} />);
    const runningCard = screen.getByText('Running task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    const verifyingCard = screen.getByText('Verifying task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(runningCard.textContent).not.toContain('Work Account (Work)');
    expect(verifyingCard.textContent).not.toContain('Personal');
    expect(within(runningCard).getByText('claude · gpt-5.6-terra').getAttribute('title')).toBe('tier standard · account Work Account (Work)');
    expect(within(verifyingCard).getByText('claude').getAttribute('title')).toBe('account Personal');
    fireEvent.click(runningCard);
    const runningPane = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    expect(within(runningPane).getByText('Account').nextElementSibling?.textContent).toBe('Work Account (Work)');
    fireEvent.click(verifyingCard);
    const verifyingPane = await screen.findByRole('complementary', { name: 'Details of ov-4' });
    expect(within(verifyingPane).getByText('Account').nextElementSibling?.textContent).toBe('Personal');
  });

  it('does not pair a critic account with the worker agent after a critic round', async () => {
    const criticFinished = { ...awaiting, account_name: 'Critic', account_label: 'Review' };
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [criticFinished] }] };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-10')) return detailFor(criticFinished);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={b} />);
    const card = screen.getByText('Awaiting task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(within(card).getByText('claude · gpt-5.6-terra').getAttribute('title')).toBe('standard');
    fireEvent.click(card);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-10' });
    expect(within(pane).getByText('Tier')).toBeTruthy();
    expect(within(pane).queryByText('Account')).toBeNull();
    expect(within(pane).queryByText(/Critic/)).toBeNull();
  });

  it('renders a reviewing card like a verifying one, says a critic is checking the change and offers Stop alone', async () => {
    const posts: string[] = [];
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...cards, reviewing] }] };
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-11')) return detailFor(reviewing);
      if (method === 'POST' && url.endsWith('/api/tasks/ov-11/interrupt')) { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={b} />);
    const verifying = screen.getByRole('heading', { level: 3, name: 'Verifying (2)' }).closest('.column') as HTMLElement;
    const card = within(verifying).getByText('Reviewing task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(card.className).not.toContain('card-failed');
    expect(within(card).getByText('Reviewing')).toBeTruthy();
    fireEvent.click(card);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-11' });
    expect(within(pane).getByText(/reviewing… a gpt-5.6-terra critic is checking the change/)).toBeTruthy();
    await within(pane).findByRole('button', { name: 'Trace' }); // the detail has loaded: the actions it would unlock are still absent
    expect(within(pane).queryByRole('button', { name: /Retry verification|Re-dispatch|Close bead|Land anyway/ })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Stop worker' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-11/interrupt']));
    await endJobs();
    await waitFor(() => expect(within(pane).getByText(/Stop requested/).textContent).toContain('Once the critic exits the bead goes back to Ready without landing'));
  });

  it('sorts an awaiting-decision card first with an amber rule and a chip, lists the findings and offers Re-dispatch, Close bead and Land anyway, which posts accept-review with the note', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...cards, awaiting] }] };
    mockApi((method, url, body) => {
      if (url.endsWith('/api/tasks/ov-10')) return detailFor(awaiting);
      if (method === 'POST' && url.endsWith('/api/tasks/ov-10/accept-review')) { posts.push({ url, body }); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={b} />);
    const ready = screen.getByRole('heading', { level: 3, name: 'Ready (3)' }).closest('.column') as HTMLElement;
    expect([...ready.querySelectorAll('.card-title')].map((e) => e.textContent)).toEqual(['Failed task', 'Awaiting task', 'Ready task']); // both above the plain Ready card
    const card = within(ready).getByText('Awaiting task', { selector: '.card-title' }).closest('.card') as HTMLElement;
    expect(card.className).toContain('card-awaiting');
    expect(card.className).not.toContain('card-failed');
    expect(within(card).getByText('Needs you').className).toBe('chip awaiting');
    fireEvent.click(card);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-10' });
    const items = within(within(pane).getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['mustsrc/a.ts Missing null check on the response.', 'should No test for the empty case.']);
    expect(within(items[0]!).getByText('must').className).toBe('chip fail');
    expect(within(pane).getByRole('button', { name: 'Re-dispatch' })).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Retry verification' })).toBeNull();
    await within(pane).findByRole('button', { name: 'Close bead' });
    vi.stubGlobal('prompt', () => { throw new Error('prompt() must not be used'); });
    fireEvent.click(within(pane).getByRole('button', { name: 'Land anyway' }));
    expect(within(pane).getByText(/Land “Awaiting task” \(ov-10\) with its open findings\?/)).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Land anyway' })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    fireEvent.click(within(pane).getByRole('button', { name: 'Land anyway' }));
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Why the findings are acceptable (optional)' }), { target: { value: '  Covered by the integration test ' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Confirm land' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/tasks/ov-10/accept-review', body: { note: 'Covered by the integration test' } }]));
    expect(within(pane).getByRole('button', { name: 'Landing…' })).toBeTruthy();
    await endJobs();
    await waitFor(() => expect(within(pane).getByRole('status').textContent).toBe('Landed with the open findings recorded.'));
    expect(within(pane).queryByRole('button', { name: /Re-dispatch|Close bead|Land anyway/ })).toBeNull();
  });

  it('disables Re-dispatch, Close bead and Land anyway while the daemon is unreachable', async () => {
    const b: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...cards, awaiting] }] };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-10')) return detailFor(awaiting);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Board {...props()} board={b} offline />);
    fireEvent.click(screen.getByText('Awaiting task', { selector: '.card-title' }));
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-10' });
    const button = (name: string) => within(pane).getByRole('button', { name }) as HTMLButtonElement;
    await waitFor(() => expect(button('Close bead').disabled).toBe(true));
    expect([button('Re-dispatch').disabled, button('Land anyway').disabled]).toEqual([true, true]);
    expect(within(pane).getByText(/nothing is sent and nothing is queued/)).toBeTruthy();
  });
});
