import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BatchDetail, BatchStatus, BoardResponse } from '@overseer/shared';
import { BatchPane } from './BatchPane';
import { batchDetail, board } from '../test/fixtures';
import { mockApi } from '../test/setup';
import { jobEnded } from '../lib/jobs';
import { PHONE_QUERY } from '../lib/phoneLayout';

const css = () => readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
const baseBatch = board.repos[0]!.batches[0]!;
const LONG_BATCH_TITLE = "Lessons from overseer overseer-b33-e4d5: a fallback that degrades the user's stated flow is a decision for the user, not a review finding to implement";
const LONG_TASK_TITLE = 'X'.repeat(60);

function withBatch(overrides: Partial<typeof baseBatch> = {}, cards = board.repos[0]!.cards): BoardResponse {
  return { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...baseBatch, ...overrides }], cards }] };
}

function reviewDetail(overrides: { batch?: Partial<BatchDetail['batch']>; repo?: Partial<BatchDetail['repo']> } = {}): BatchDetail {
  return {
    ...batchDetail,
    batch: { ...batchDetail.batch, status: 'review', ...overrides.batch },
    repo: { ...batchDetail.repo, ...overrides.repo },
  };
}

beforeEach(() => {
  mockApi((_method, url) => {
    if (url.endsWith('/api/batches/r1-b1')) return reviewDetail();
    throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
  });
});

function renderPane(props: Partial<Parameters<typeof BatchPane>[0]> = {}) {
  return render(<BatchPane id="r1-b1" board={board} onClose={vi.fn()} onSelect={vi.fn()} onOpenReview={vi.fn()} {...props} />);
}

describe('BatchPane', () => {
  it('shows the batch metadata and one selectable row per board card', () => {
    const onSelect = vi.fn();
    renderPane({ onSelect });
    const pane = within(screen.getByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.getByRole('heading', { name: '#9310 Trend chart' })).toBeTruthy();
    expect(pane.getByText('in progress')).toBeTruthy();
    expect(pane.getByText('feature/9310-trend-chart → main')).toBeTruthy();
    expect(pane.getByText('2/4 beads')).toBeTruthy();
    expect(pane.getByRole('button', { name: /Running task.*ov-3.*Running/ })).toBeTruthy();
    expect(pane.getByRole('button', { name: /Failed task.*ov-6.*Ready/ })).toBeTruthy();
    fireEvent.click(pane.getByRole('button', { name: /Running task/ }));
    expect(onSelect).toHaveBeenCalledWith('ov-3');
  });

  it('refreshes its title and review link from the next board snapshot', () => {
    const props = { id: 'r1-b1', onClose: vi.fn(), onSelect: vi.fn(), onOpenReview: vi.fn() };
    const view = render(<BatchPane {...props} board={board} />);
    view.rerender(<BatchPane {...props} board={withBatch({ title: 'Updated title', status: 'review' })} />);
    const pane = within(screen.getByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.getByRole('heading', { name: 'Updated title' })).toBeTruthy();
    expect(pane.getByRole('button', { name: 'Open in Review' })).toBeTruthy();
  });

  it('shimmers the arrived review block while the batch detail is loading', async () => {
    let release!: (detail: BatchDetail) => void;
    mockApi(() => new Promise<BatchDetail>((resolve) => { release = resolve; }));
    renderPane({ board: withBatch({ status: 'review', history: 'Earlier round' }) });
    const shimmer = screen.getByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText("The orchestrator's summary of this round appears here once the batch loads.")).toBeTruthy();
    expect(shimmer.querySelector('.shimmer-measure-container .review-actions button')?.hasAttribute('disabled')).toBe(true);
    await act(async () => { release(reviewDetail({ batch: { history: 'Earlier round' } })); });
    expect(await screen.findByText('No summary for this round yet: the orchestrator has not requested review again.')).toBeTruthy();
  });

  it('stops the first-detail placeholder after the fetch fails', async () => {
    mockApi(() => { throw Object.assign(new Error('detail failed'), { status: 500 }); });
    renderPane({ board: withBatch({ status: 'review' }) });
    expect(await screen.findByText('Could not load batch r1-b1.')).toBeTruthy();
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('renders the shared summary, earlier rounds, orchestrator note and attachment picker', async () => {
    const summary = '| Check | Result |\n| --- | --- |\n| tests | pass |';
    mockApi((_method, url) => url.endsWith('/api/batches/r1-b1')
      ? reviewDetail({ batch: { note: summary, history: summary }, repo: { batch_approver: 'orchestrator' } })
      : Object.assign(new Error(`unexpected ${url}`), { status: 500 }));
    const { container } = renderPane({ board: withBatch({ status: 'review', note: summary, history: summary }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.getByText(/The orchestrator merges r1's batches/)).toBeTruthy();
    expect(pane.getByText('Summary from the orchestrator')).toBeTruthy();
    expect(pane.getByText('Earlier rounds')).toBeTruthy();
    expect(pane.queryByRole('link', { name: 'Open merge request' })).toBeNull();
    expect(pane.getByRole('button', { name: 'Attach image' })).toBeTruthy();
    await pane.findByRole('button', { name: 'Reject' });
    expect(container.querySelectorAll('.review-note table')).toHaveLength(2);
  });

  it.each([
    ['local-merge', null, 'Merge', false],
    ['gitlab-mr', 'https://gitlab.example/r1/merge_requests/7', 'Mark merged', true],
  ] as const)('%s renders the matching merge action and MR link', async (mergeMode, mrUrl, action, hasMr) => {
    mockApi((_method, url) => url.endsWith('/api/batches/r1-b1')
      ? reviewDetail({ batch: { mr_url: mrUrl }, repo: { merge_mode: mergeMode } })
      : Object.assign(new Error(`unexpected ${url}`), { status: 500 }));
    const pane = within((await renderPane({ board: withBatch({ status: 'review', mr_url: mrUrl }) })).container.querySelector('.batch-pane')!);
    await pane.findByRole('button', { name: action });
    expect(pane.queryByRole('link', { name: 'Open merge request' }) !== null).toBe(hasMr);
  });

  it('shows waiting and conflict banners and disables Merge for an overlapping batch', async () => {
    const detail = reviewDetail({ batch: { waiting_on: 'r1-b2', overlap_files: ['src/a.ts'], conflict_files: ['src/b.ts'] } });
    mockApi((_method, url) => url.endsWith('/api/batches/r1-b1') ? detail : Object.assign(new Error(`unexpected ${url}`), { status: 500 }));
    renderPane({ board: withBatch({ status: 'review', waiting_on: 'r1-b2', overlap_files: ['src/a.ts'], conflict_files: ['src/b.ts'] }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.getByText(/Waiting on r1-b2: both change src\/a.ts/)).toBeTruthy();
    expect((pane.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    expect(pane.getByText(/Last merge into main conflicted in: src\/b.ts/)).toBeTruthy();
  });

  it('shows the empty summary placeholder and refuses Reject without a note', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return reviewDetail();
      if (method === 'POST') posts.push(url);
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    renderPane({ board: withBatch({ status: 'review' }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.getByText('The orchestrator has not requested review yet.')).toBeTruthy();
    expect(pane.getByRole('textbox', { name: 'Rejection note' }).getAttribute('placeholder')).toBe('Why? (required to reject)');
    fireEvent.click(pane.getByRole('button', { name: 'Reject' }));
    expect(pane.getByRole('alert').textContent).toBe('A rejection note is required.');
    expect(posts).toEqual([]);
  });

  it('asks the Review questions for Merge and Abandon, and Cancel returns to the actions', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return reviewDetail();
      if (method === 'POST') posts.push(url);
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    renderPane({ board: withBatch({ status: 'review' }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Merge' }));
    await pane.findByRole('button', { name: 'Confirm merge' });
    expect(pane.getByText(/Merge batch .*into main\? Its branch feature\/9310-trend-chart is deleted afterwards\./)).toBeTruthy();
    fireEvent.click(pane.getByRole('button', { name: 'Cancel' }));
    expect(pane.getByRole('button', { name: 'Merge' })).toBeTruthy();
    fireEvent.click(pane.getByRole('button', { name: 'Abandon' }));
    await pane.findByRole('button', { name: 'Confirm abandon' });
    expect(pane.getByText(/Abandon batch .*nothing reaches main\./)).toBeTruthy();
    fireEvent.click(pane.getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
  });

  it('keeps the pane open and shows the successful status when a job result arrives before the POST response', async () => {
    let release!: (result: { job_id: string }) => void;
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return reviewDetail();
      if (url.endsWith('/api/batches/r1-b1/merge') && method === 'POST') return new Promise((resolve) => { release = resolve; });
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    const reviewBoard = withBatch({ status: 'review' });
    const view = renderPane({ board: reviewBoard });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => jobEnded({ job_id: 'job-early', action: 'merge', target: 'r1-b1', ok: true, message: null, data: null }));
    await act(async () => { release({ job_id: 'job-early' }); });
    expect(await pane.findByText('Batch r1-b1 merged into main.')).toBeTruthy();
    view.rerender(<BatchPane id="r1-b1" board={withBatch({ status: 'merged' })} onClose={vi.fn()} onSelect={vi.fn()} onOpenReview={vi.fn()} />);
    expect(view.container.querySelector('.batch-pane-status .chip')?.classList.contains('merged')).toBe(true);
    expect(pane.queryByRole('button', { name: /^(Merge|Mark merged|Reject|Abandon|Open in Review)$/ })).toBeNull();
  });

  it('clears a failed job line and returns the review actions', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return reviewDetail();
      if (url.endsWith('/api/batches/r1-b1/merge') && method === 'POST') return { job_id: 'job-failed' };
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    renderPane({ board: withBatch({ status: 'review' }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Confirm merge' }));
    await pane.findByText('Merging batch r1-b1 into main…');
    act(() => jobEnded({ job_id: 'job-failed', action: 'merge', target: 'r1-b1', ok: false, message: 'merge conflict in src/a.ts', data: null }));
    await waitFor(() => expect(pane.queryByText('Merging batch r1-b1 into main…')).toBeNull());
    expect((pane.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the abandoned status and removes actions after the Abandon job succeeds', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return reviewDetail();
      if (url.endsWith('/api/batches/r1-b1/abandon') && method === 'POST') return { job_id: 'job-abandon' };
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    renderPane({ board: withBatch({ status: 'review' }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Abandon' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Confirm abandon' }));
    await pane.findByText('Abandoning batch r1-b1…');
    act(() => jobEnded({ job_id: 'job-abandon', action: 'abandon', target: 'r1-b1', ok: true, message: null, data: null }));
    await pane.findByText('Batch r1-b1 abandoned.');
    expect(document.querySelector('.batch-pane-status .chip')?.classList.contains('abandoned')).toBe(true);
    expect(pane.queryByRole('button', { name: /^(Merge|Mark merged|Reject|Abandon|Open in Review)$/ })).toBeNull();
  });

  it('does not retain the progress line after closing and reopening during a pending action', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return reviewDetail();
      if (url.endsWith('/api/batches/r1-b1/merge') && method === 'POST') return { job_id: 'job-pending' };
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    function Host() {
      const [open, setOpen] = useState(true);
      return <>{!open && <button onClick={() => setOpen(true)}>Reopen pane</button>}{open && <BatchPane id="r1-b1" board={withBatch({ status: 'review' })} onClose={() => setOpen(false)} onSelect={vi.fn()} onOpenReview={vi.fn()} />}</>;
    }
    render(<Host />);
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Confirm merge' }));
    await pane.findByText('Merging batch r1-b1 into main…');
    fireEvent.click(pane.getByRole('button', { name: 'Close batch details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen pane' }));
    const reopened = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    await reopened.findByRole('textbox', { name: 'Rejection note' });
    expect(reopened.queryByRole('status')).toBeNull();
  });

  it('keeps a failed refetch under the warning after the approver note', async () => {
    let fail = false;
    mockApi((_method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) {
        if (fail) throw Object.assign(new Error('server unavailable'), { status: 500 });
        return reviewDetail({ batch: { note: 'Current summary' }, repo: { batch_approver: 'orchestrator' } });
      }
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    const view = renderPane({ board: withBatch({ status: 'review', note: 'Current summary' }), version: 0 });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    const approver = await pane.findByText(/The orchestrator merges r1's batches/);
    fail = true;
    view.rerender(<BatchPane id="r1-b1" board={withBatch({ status: 'review', note: 'Current summary' })} version={1} onClose={vi.fn()} onSelect={vi.fn()} onOpenReview={vi.fn()} />);
    const stale = await pane.findByText(/Showing the last known state of this batch/);
    expect(approver.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pane.getByText('Current summary')).toBeTruthy();
  });

  it('keeps the batch header and says no tasks yet when its total is zero', () => {
    const zero = withBatch({ beads_total: 0, beads_done: 0 }, []);
    renderPane({ board: zero });
    const pane = within(screen.getByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.getByRole('heading', { name: '#9310 Trend chart' })).toBeTruthy();
    expect(pane.getByText('No tasks yet.')).toBeTruthy();
  });

  it('reports how many tasks are shown when the board card list is capped', () => {
    const capped = withBatch({ beads_total: 7, beads_done: 6 }, [board.repos[0]!.cards[2]!]);
    renderPane({ board: capped });
    expect(screen.getByText('Showing 1 of 7 tasks.')).toBeTruthy();
  });

  it('names the batch when it disappears from the board', () => {
    const gone = { ...board, repos: [{ ...board.repos[0]!, batches: [] }] };
    const view = renderPane();
    view.rerender(<BatchPane id="r1-b1" board={gone} onClose={vi.fn()} onSelect={vi.fn()} onOpenReview={vi.fn()} />);
    expect(screen.getByText('Batch r1-b1 is no longer on the board.')).toBeTruthy();
  });

  it('focuses the batch pane when it opens', () => {
    renderPane();
    expect(document.activeElement).toBe(screen.getByRole('complementary', { name: 'Batch details for r1-b1' }));
  });

  it('closes the batch pane on Escape wherever focus is', () => {
    const onClose = vi.fn();
    renderPane({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the drawer open when Escape cancels the Merge question', async () => {
    renderPane({ board: withBatch({ status: 'review' }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Merge' }));
    await pane.findByRole('button', { name: 'Confirm merge' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await pane.findByRole('button', { name: 'Merge' });
    expect({ drawerOpen: screen.queryByRole('complementary', { name: 'Batch details for r1-b1' }) !== null, questionOpen: pane.queryByRole('button', { name: 'Confirm merge' }) !== null, mergeRestored: pane.queryByRole('button', { name: 'Merge' }) !== null }).toEqual({ drawerOpen: true, questionOpen: false, mergeRestored: true });
  });

  it.each<BatchStatus>(['open', 'merged', 'abandoned'])('does not fetch batch detail for a %s batch', (status) => {
    const requests: string[] = [];
    mockApi((_method, url) => { requests.push(url); throw Object.assign(new Error(`unexpected ${url}`), { status: 500 }); });
    renderPane({ board: withBatch({ status }) });
    expect(requests.filter((url) => url.endsWith('/api/batches/r1-b1'))).toEqual([]);
  });

  it.each<BatchStatus>(['open', 'review', 'merged', 'abandoned'])('%s chips show Open in Review only for a review batch', (status) => {
    const onOpenReview = vi.fn();
    renderPane({ board: withBatch({ status }) , onOpenReview });
    const link = screen.queryByRole('button', { name: 'Open in Review' });
    if (status === 'review') {
      expect(link).toBeTruthy();
      fireEvent.click(link!);
      expect(onOpenReview).toHaveBeenCalledWith('r1-b1');
    } else {
      expect(link).toBeNull();
    }
  });

  it.each<BatchStatus>(['open', 'merged', 'abandoned'])('%s batches show no review actions', async (status) => {
    renderPane({ board: withBatch({ status }) });
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    expect(pane.queryByRole('button', { name: /^(Merge|Mark merged|Reject|Abandon)$/ })).toBeNull();
  });

  it('wraps the longest batch title and a 60-character task title inside the phone sheet', () => {
    const longCards = board.repos[0]!.cards.map((card) => card.bead.id === 'ov-3' ? { ...card, bead: { ...card.bead, title: LONG_TASK_TITLE } } : card);
    const longBoard = withBatch({ title: LONG_BATCH_TITLE, beads_total: 2 }, longCards);
    const { container } = renderPane({ board: longBoard });
    const pane = within(container.querySelector('.batch-pane')!);
    expect(pane.getByRole('heading', { name: LONG_BATCH_TITLE })).toBeTruthy();
    expect(pane.getByText(LONG_TASK_TITLE)).toBeTruthy();
    const styles = css();
    expect(styles).toContain('.batch-pane-title { min-width: 0; overflow-wrap: anywhere; }');
    expect(styles).toContain('.batch-pane-task-title { min-width: 0; overflow-wrap: anywhere; }');
    expect(styles.slice(styles.indexOf(`@media ${PHONE_QUERY}`))).toContain('.detail, .review-detail { overflow-x: hidden; }');
  });
});
