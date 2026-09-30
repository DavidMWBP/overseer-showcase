import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, cleanup, act, within } from '@testing-library/react';
import type { BatchStatus, BoardResponse } from '@overseer/shared';
import { ACK_MS, beadOutcome, Review } from './Review';
import { Toasts } from '../components/Toasts';
import { splitDiff } from '../components/Diff';
import { jobEnded } from '../lib/jobs';
import { mockApi } from '../test/setup';
import { board, reviewDetail, batchDetail } from '../test/fixtures';
import { PHONE_QUERY } from '../lib/phoneLayout';

const noop = () => {};
/** The acknowledgement is the list's own `role=status`; a loading pane announces a second one, so scope the query to the list. */
const listStatus = () => within(document.querySelector('.review-list') as HTMLElement).getByRole('status');
const queryListStatus = () => within(document.querySelector('.review-list') as HTMLElement).queryByRole('status');
/** The daemon's 202 for an action request, recorded so `endJobs` can end the job the way the app shell passes `action_result` on. */
const jobs: { job_id: string; action: string; target: string }[] = [];
let jobSeq = 0; // job ids are never reused: an ended one stays ended
const accept = (url: string) => {
  const [, target, action] = /\/api\/(?:tasks|batches)\/([^/]+)\/([^/]+)$/.exec(url)!;
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

describe('splitDiff', () => {
  it('splits on diff --git boundaries', () => {
    expect(splitDiff(reviewDetail.diff!).map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(splitDiff('')).toEqual([]);
  });
});

describe('Review', () => {
  it('shows the daemon review check and counts in the batch header', async () => {
    const review_check = {
      status: 'pass' as const, command: 'pnpm test', head_sha: 'abc123', exit_code: 0, duration_ms: 1840, output_tail: 'Tests 16940 passed',
      counts: { passed: 16940, failed: 0, skipped: 21, todo: 5, flaky: 0 },
    };
    mockApi((_method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', review_check } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', review_check }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByTestId('review-check').textContent).toContain('Review check: passed · pnpm test · 16940 passed · 0 failed · 21 skipped · 5 todo'));
  });

  it('renders tables in the current summary and earlier rounds', async () => {
    const table = '| Check | Result |\n| --- | --- |\n| test | pass |';
    mockApi((_method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: table, history: table } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(document.querySelectorAll('.review-note table')).toHaveLength(2));
    expect(document.querySelector('.review-history table th')?.textContent).toBe('Check');
  });

  it('renders tables in the bead review note', async () => {
    mockApi((_method, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return { ...reviewDetail, worktree: { ...reviewDetail.worktree!, review_note: '| Check | Result |\n| --- | --- |\n| test | pass |' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected="ov-5" selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(document.querySelector('.review-note table')).toBeTruthy());
    expect(document.querySelector('.review-note td')?.textContent).toBe('test');
  });

  it('lists review tasks, shows detail, merges from an in-pane confirmation and rejects with a note', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-5/merge')) { posts.push(url); return accept(url); }
      if (method === 'POST' && url.endsWith('/api/tasks/ov-5/reject')) { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected="ov-5" onSelect={noop} selectedBatch={null} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText('Adds the greeting endpoint with a test.')).toBeTruthy());
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain('Review task');
    expect(screen.getByText(/verification: pass/i)).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    // A v1 merge writes to the base branch like a batch merge does; the question is in the pane now, and cancelling sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByText('Merge “Review task” (ov-5) into main? Its branch bead/ov-5 is deleted afterwards.')).toBeTruthy();
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/into main\?/)).toBeNull();
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-5/merge']));
    // Accepted, not done: the line says the merge runs until its job ends.
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Merging ov-5…'));
    await endJobs();
    expect(screen.getByRole('status').textContent).toBe('ov-5 merged.');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(posts.filter((p) => p.endsWith('/reject'))).toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText(/why/i), { target: { value: 'needs tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts.filter((p) => p.endsWith('/reject'))).toHaveLength(1));
  });

  it('reviews a batch: lists it first, merges, rejects with a note, abandons, and acknowledges each in the list', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'All four beads landed. Verified with pnpm test.' } };
      if (method === 'POST' && url.includes('/api/batches/r1-b1/')) { posts.push({ url, body }); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', note: 'All four beads landed. Verified with pnpm test.' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText('All four beads landed. Verified with pnpm test.')).toBeTruthy());
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('#9310 Trend chart');
    expect(screen.getByText('feature/9310-trend-chart → main')).toBeTruthy();
    expect(screen.getByText('$1.20')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => expect(posts.at(-1)?.url).toBe('/api/batches/r1-b1/merge'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Merging batch r1-b1 into main…'));
    expect(document.activeElement).toBe(screen.getByRole('status'));
    await endJobs();
    expect(screen.getByRole('status').textContent).toBe('Batch r1-b1 merged into main.');
    expect(document.activeElement).toBe(screen.getByRole('status'));
    fireEvent.change(screen.getByPlaceholderText(/why/i), { target: { value: 'missing TC-005' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/batches/r1-b1/reject', body: { note: 'missing TC-005' } }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Rejecting batch r1-b1…'));
    await endJobs();
    expect(screen.getByRole('status').textContent).toBe('Batch r1-b1 rejected; the orchestrator was notified.');
    fireEvent.click(screen.getByRole('button', { name: 'Abandon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm abandon' }));
    await waitFor(() => expect(posts.at(-1)?.url).toBe('/api/batches/r1-b1/abandon'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Abandoning batch r1-b1…'));
    await endJobs();
    expect(screen.getByRole('status').textContent).toBe('Batch r1-b1 abandoned.');
    fireEvent.click(screen.getByRole('button', { name: /#9310 Trend chart/ })); // picking a batch clears the acknowledgement
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('previews an image and posts its raw base64 with a batch rejection', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:proof'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('FileReader', class { result: string | null = null; error: DOMException | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.(); } });
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST' && url.endsWith('/api/batches/r1-b1/reject')) { posts.push(body); return accept(url); }
      throw new Error(`unexpected ${url}`);
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { container } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByRole('textbox', { name: /rejection note/i });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'proof.png', { type: 'image/png' })] } });
    expect(screen.getByAltText('proof.png')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /rejection note/i }), { target: { value: 'see proof' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts).toEqual([{ note: 'see proof', attachments: [{ name: 'proof.png', mime: 'image/png', data: 'AQID' }] }]));
    await waitFor(() => expect(screen.queryByAltText('proof.png')).toBeNull());
  });

  it('shows refused-file hints and accepts a file drop on the rejection note', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    mockApi((_method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      throw new Error(`unexpected ${url}`);
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { container, rerender } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const note = await screen.findByRole('textbox', { name: /rejection note/i });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('alert').textContent).toBe('notes.txt is not a supported image');
    const dropped = new File(['png'], 'dropped.png', { type: 'image/png' });
    expect(fireEvent.dragOver(note, { dataTransfer: { files: [dropped], types: ['Files'] } })).toBe(false);
    expect(note.classList.contains('drop-active')).toBe(true);
    fireEvent.drop(note, { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect(screen.getByAltText('dropped.png')).toBeTruthy();
    expect(note.classList.contains('drop-active')).toBe(false);
    rerender(<Review board={inReview} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    rerender(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByRole('textbox', { name: /rejection note/i });
    expect(screen.queryByAltText('dropped.png')).toBeNull();
  });

  it('disables the actions while the daemon is unreachable, names an outage instead of a status code, and clears it on recovery', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') throw new TypeError('Failed to fetch'); // the daemon is gone: fetch itself rejects
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { rerender } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    // The outage is noticed a moment after the click: the request fails as unreachable and says so, not "failed with 500".
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm abandon' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The daemon is unreachable; try again once it is back.'));
    rerender(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} offline />);
    for (const name of ['Merge', 'Reject', 'Abandon']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    // Round 25 R25-3: "Actions wait until the daemon is back." read as a promise to send the click later; nothing is queued.
    expect(screen.getByText('The daemon is unreachable: nothing is sent and nothing is queued. Your note is kept; press again once it is back.')).toBeTruthy();
    rerender(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} offline={false} />);
    expect(screen.queryByRole('alert')).toBeNull(); // the outage error does not outlive the outage
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // The v1 pane can only be open on a bead in the review column: a run on the bead takes it out of that column and the pane closes
  // with it, so its verification can never be one that is still going. The heading was gated on card states this list cannot hold,
  // and the test for it rewrote a card's state while leaving it in the review column - a board that cannot exist (fix round 24 review NB-1).
  it('heads the task pane verification plainly, and closes the pane when a run takes the bead out of the review column', async () => {
    const failed = { ...reviewDetail, worktree: { ...reviewDetail.worktree!, verify_status: 'fail' as const, verify_output: '$ pnpm test\nexit 3' } };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return failed;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const selected: (string | null)[] = [];
    const onSelect = (id: string | null) => selected.push(id);
    const { rerender } = render(<Review board={board} version={0} selected="ov-5" onSelect={onSelect} selectedBatch={null} onSelectBatch={noop} />);
    expect((await screen.findByText(/verification: failed/i)).textContent).toBe('Verification: failed');
    expect(screen.getByText(/exit 3/)).toBeTruthy();
    // A re-dispatch from the Board clears the review phase at once, so the card leaves the review column with its bead.
    const running: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: board.repos[0]!.cards.map((c) => (c.bead.id === 'ov-5' ? { ...c, column: 'running' as const, state: 'running' as const } : c)) }] };
    rerender(<Review board={running} version={0} selected="ov-5" onSelect={onSelect} selectedBatch={null} onSelectBatch={noop} />);
    expect(selected.at(-1)).toBeNull();
  });

  // Round 25 nit: two clicks in one tick both sent a request. The question opens once; only its own confirm sends.
  it('asks once when Merge is clicked twice in one tick, and sends once on confirm', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const merge = await screen.findByRole('button', { name: 'Merge' });
    fireEvent.click(merge);
    fireEvent.click(merge);
    expect(screen.getAllByRole('button', { name: 'Confirm merge' })).toHaveLength(1);
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => expect(posts).toEqual(['/api/batches/r1-b1/merge']));
  });

  // Fix round 25 review NB-B: Reject opens no confirm, so nothing stopped the second click of a double click; the daemon refused
  // the second request and its message painted an error over a rejection that had worked.
  it('sends once when Reject is clicked twice in one tick', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const reject = await screen.findByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), { target: { value: 'needs tests' } });
    // Both clicks in one tick: the disabled state reaches the button only on the next render, so only the synchronous hold on the target (`lib/jobs.ts`) can stop the second.
    await act(async () => { reject.click(); reject.click(); });
    await waitFor(() => expect(posts).toEqual(['/api/batches/r1-b1/reject']));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the review list cannot be loaded during an outage before any board arrived, and that it is loading before one, instead of "Nothing to review yet" (round 16)', () => {
    mockApi(() => { throw new TypeError('Failed to fetch'); });
    const { rerender } = render(<Review board={null} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} offline />);
    expect(screen.getByText('The review list cannot be loaded until the daemon is back.')).toBeTruthy();
    expect(screen.queryByText(/nothing to review yet/i)).toBeNull();
    rerender(<Review board={null} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} offline={false} />);
    expect(screen.getByText('Loading the review list…')).toBeTruthy();
    rerender(<Review board={{ bd_ok: true, repos: [{ repo: board.repos[0]!.repo, batches: [], cards: [] }] }} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    expect(screen.getByText(/nothing to review yet/i)).toBeTruthy();
  });
  it('holds the review list with a shimmer while the board is in flight, then shows the arrived batches', () => {
    const listShimmer = () => within(document.querySelector('.review-list') as HTMLElement).queryByTestId('shimmer');
    const { rerender } = render(<Review board={null} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    expect(listShimmer()).toBeTruthy();
    expect(listStatus().textContent).toBe('Loading the review list…');
    rerender(<Review board={board} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    expect(listShimmer()).toBeNull();
    expect(screen.getByRole('button', { name: /#9310 Trend chart/ })).toBeTruthy();
  });
  it('lays the list placeholder out on the review list grid, so the gap between its two sections is reserved', () => {
    render(<Review board={null} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    const placeholder = document.querySelector('.review-list .review-list-placeholder') as HTMLElement;
    expect(placeholder.querySelectorAll(':scope > div')).toHaveLength(2);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.review-list, \.review-list-placeholder \{ display: grid; gap: 8px;/);
  });
  it('drops the review list shimmer when the shell reports the board fetch failed', () => {
    render(<Review board={null} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} loadFailed={(paths) => paths.includes('/board')} />);
    expect(within(document.querySelector('.review-list') as HTMLElement).queryByTestId('shimmer')).toBeNull();
    expect(screen.getByText('Could not load the review list.')).toBeTruthy();
    expect(screen.queryByText('The review list cannot be loaded until the daemon is back.')).toBeNull();
  });
  it('says a landed batch was not verified when no bead ran a command, and pass when the beads did even if the command was cleared since', async () => {
    const landed = { ...batchDetail.beads[0]!, column: 'done' as const, verify_failure: null, bead: { ...batchDetail.beads[0]!.bead, labels: ['overseer:merged'] } };
    let ran = 0;
    mockApi((_m, url) => {
      // The repo has no command now; what counts is what the landed bead's own run recorded (fix round 8 review, M2b).
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, repo: { ...batchDetail.repo, verify_command: null }, batch: { ...batchDetail.batch, status: 'review' }, beads: [landed], landed_verified: ran };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', beads_total: 1, beads_done: 1 }] }] };
    const { rerender } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect((await screen.findByText(/^Verification:/)).textContent).toBe('Verification: not run (no verify command configured) (1/1 beads landed)');
    ran = 1;
    rerender(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText(/^Verification:/).textContent).toBe('Verification: pass (1/1 beads landed)'));
  });

  it('drops the acknowledgement once the batch has moved past the state it names', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (url.endsWith('/reject')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const withStatus = (status: 'open' | 'review'): BoardResponse => ({ ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status }] }] });
    function Harness(h: { b: BoardResponse; v: number }) { const [sel, setSel] = useState<string | null>('r1-b1'); return <Review board={h.b} version={h.v} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />; }
    const { rerender } = render(<Harness b={withStatus('review')} v={0} />);
    fireEvent.change(await screen.findByPlaceholderText(/why/i), { target: { value: 'line two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await endJobs();
    await waitFor(() => expect(listStatus().textContent).toBe('Batch r1-b1 rejected; the orchestrator was notified.'));
    rerender(<Harness b={withStatus('open')} v={1} />); // the rejection landed: the line still holds
    expect(listStatus().textContent).toBe('Batch r1-b1 rejected; the orchestrator was notified.');
    rerender(<Harness b={withStatus('review')} v={2} />); // back in review 17 s later (round 9): the line is stale
    await waitFor(() => expect(queryListStatus()).toBeNull());
  });

  it('keeps a typed rejection note for the batch across an unmount and a failed rejection, and drops it once the rejection has succeeded (round 12)', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'Summary.' } };
      if (method === 'POST' && url.endsWith('/api/batches/r1-b1/reject')) { posts.push({ url, body }); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', note: 'Summary.' }] }] };
    const view = () => <Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />;
    const first = render(view());
    fireEvent.change(await screen.findByPlaceholderText(/why/i), { target: { value: 'Please also append a second line' } });
    first.unmount(); // a visit to Chat
    render(view());
    const note = await screen.findByPlaceholderText(/why/i) as HTMLInputElement;
    expect(note.value).toBe('Please also append a second line');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/batches/r1-b1/reject', body: { note: 'Please also append a second line' } }));
    // The job fails: the note is still there to send again as it was.
    await endJobs(false, 'bd is unavailable');
    cleanup();
    render(view());
    expect(((await screen.findByPlaceholderText(/why/i)) as HTMLInputElement).value).toBe('Please also append a second line');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    await endJobs();
    cleanup();
    render(view());
    expect(((await screen.findByPlaceholderText(/why/i)) as HTMLInputElement).value).toBe('');
  });

  it('refetches the batch on a change notice even while an earlier request is in flight, so the summary is the one after the change (round 12)', async () => {
    const pending: ((v: unknown) => void)[] = [];
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return new Promise<unknown>((r) => { pending.push(r); });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { rerender } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(pending).toHaveLength(2)); // not served the first request's answer
    await act(async () => { pending[1]!({ ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'Two beads now.', history: 'One bead.\n\nRejected: more.' } }); });
    await act(async () => { pending[0]!({ ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'One bead.' } }); });
    expect(screen.getByText(/Two beads now/)).toBeTruthy();
  });

  it('asks in the pane before merging and does nothing when the user cancels', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    expect(screen.getByText('Merge batch “#9310 Trend chart” (r1-b1) into main? Its branch feature/9310-trend-chart is deleted afterwards.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(screen.queryByText(/into main\?/)).toBeNull();
    expect(posts).toEqual([]);
    // Escape cancels it too, wherever focus is.
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText(/into main\?/)).toBeNull();
    expect(posts).toEqual([]);
  });

  it.each([
    { action: 'Merge', confirm: 'Confirm merge', endpoint: '/merge', pane: 'batch' },
    { action: 'Abandon', confirm: 'Confirm abandon', endpoint: '/abandon', pane: 'batch' },
    { action: 'Merge', confirm: 'Confirm merge', endpoint: '/merge', pane: 'bead' },
  ])('replaces the $pane actions for $action, then restores the draft and attachment on Cancel', async ({ action, confirm, endpoint, pane }) => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:proof'), revokeObjectURL: vi.fn() });
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw new Error(`unexpected ${url}`);
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const view = (offline = false) => <Review board={inReview} version={0} selected={pane === 'bead' ? 'ov-5' : null} selectedBatch={pane === 'batch' ? 'r1-b1' : null} onSelect={noop} onSelectBatch={noop} offline={offline} />;
    const { container, rerender } = render(view());
    const note = await screen.findByRole('textbox', { name: 'Rejection note' });
    fireEvent.change(note, { target: { value: 'Keep this note' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'proof.png', { type: 'image/png' })] } });
    expect(screen.getByAltText('proof.png')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: action }));
    const question = container.querySelector('.review-detail .review-actions.close-confirm') as HTMLElement;
    expect(question).toBeTruthy();
    expect(question.textContent).toContain(pane === 'bead' ? 'Merge “Review task” (ov-5)' : `${action} batch “#9310 Trend chart” (r1-b1)`);
    expect(container.querySelectorAll('.review-detail .review-actions')).toHaveLength(1);
    for (const name of pane === 'bead' ? ['Merge', 'Reject'] : ['Merge', 'Reject', 'Abandon']) expect(within(question).queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Rejection note' })).toBeNull();
    expect(screen.queryByAltText('proof.png')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: confirm }));
    expect(posts).toEqual([]);
    rerender(view(true));
    expect((screen.getByRole('button', { name: confirm }) as HTMLButtonElement).disabled).toBe(true);
    rerender(view());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(container.querySelector('.review-detail .review-actions.close-confirm')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Rejection note' }) as HTMLTextAreaElement).value).toBe('Keep this note');
    expect(screen.getByAltText('proof.png')).toBeTruthy();
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: action }));
    fireEvent.click(screen.getByRole('button', { name: confirm }));
    await waitFor(() => expect(posts).toEqual([`/api/${pane === 'bead' ? 'tasks/ov-5' : 'batches/r1-b1'}${endpoint}`]));
  });

  it('scrolls an off-screen question into view', async () => {
    mockApi((_method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      throw new Error(`unexpected ${url}`);
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const scroll = vi.fn();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains('close-confirm') ? { top: 900, bottom: 1000 } as DOMRect : originalRect.call(this); };
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it('drops a selected batch that is no longer on the board instead of showing a dead entry', async () => {
    mockApi(() => { throw Object.assign(new Error('batch r1-b9 not found'), { status: 404 }); });
    const onSelectBatch = vi.fn();
    render(<Review board={board} version={0} selected={null} selectedBatch="r1-b9" onSelect={noop} onSelectBatch={onSelectBatch} />);
    await waitFor(() => expect(onSelectBatch).toHaveBeenCalledWith(null));
    // Until the board is known nothing is dropped: the batch may simply not have arrived yet.
    onSelectBatch.mockClear();
    render(<Review board={null} version={0} selected={null} selectedBatch="r1-b9" onSelect={noop} onSelectBatch={onSelectBatch} />);
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(onSelectBatch).not.toHaveBeenCalled();
  });

  it('closes the batch pane after Merge even when a board refresh refetches the old batch', async () => {
    const posts: string[] = [];
    const inReview = { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' as const, note: 'ready' } };
    const merged = { ...batchDetail, beads: [], cost: 0, diff: null, batch: { ...batchDetail.batch, status: 'merged' as const, merged_at: '2026-09-13T02:08:41.000Z' } };
    let bump: () => void = () => {};
    let releaseStale: () => void = () => {};
    let gets = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/batches/r1-b1')) {
        gets++;
        if (gets === 1) return inReview;
        return new Promise<unknown>((r) => { releaseStale = () => r(merged); }); // the refetch that lands after the pane closed
      }
      if (method === 'POST' && url.includes('/api/batches/')) { posts.push(url); bump(); return accept(url); } // the daemon emits a board event during the merge
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() {
      const [version, setVersion] = useState(0);
      const [sel, setSel] = useState<string | null>('r1-b1');
      bump = () => setVersion((v) => v + 1);
      const b = version > 0 ? { ...board, repos: [{ ...board.repos[0]!, batches: [] }] } : board;
      return <Review board={b} version={version} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />;
    }
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => expect(posts).toEqual(['/api/batches/r1-b1/merge']));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull());
    await waitFor(() => expect(gets).toBe(2));
    releaseStale();
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(screen.queryByRole('button', { name: 'Abandon' })).toBeNull();
    expect(screen.queryByText('in progress')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(posts.some((u) => u.includes('/batches/null/'))).toBe(false);
  });

  it('shows a placeholder from the board summary while the batch detail loads', async () => {
    let release: () => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return new Promise<unknown>((r) => { release = () => r({ ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'ready' } }); });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const pane = document.querySelector('.review-detail[aria-busy="true"]') as HTMLElement;
    expect(pane).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('#9310 Trend chart');
    expect(screen.getByText('feature/9310-trend-chart → main')).toBeTruthy();
    expect(screen.getByText(/loading the batch/i)).toBeTruthy();
    // One shimmer holds the header's verification line (it wraps the header to a second row once loaded), one the pane body.
    expect(pane.querySelector('.review-head .shimmer')).toBeTruthy();
    expect(within(pane).getAllByTestId('shimmer')).toHaveLength(2);
    release();
    await screen.findByText('ready');
    expect(document.querySelector('.review-detail[aria-busy="true"]')).toBeNull();
    expect(document.querySelector('.review-detail .shimmer')).toBeNull();
  });
  it('keeps the bead pane in place with a shimmer while /api/tasks/:id is in flight, then fills it in', async () => {
    let release: (d: unknown) => void = () => {};
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return new Promise<unknown>((r) => { release = r; });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected="ov-5" selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    const pane = document.querySelector('.review-detail[aria-busy="true"]') as HTMLElement;
    expect(pane).toBeTruthy();
    expect(within(pane).getByTestId('shimmer')).toBeTruthy();
    expect(within(pane).getByRole('status').textContent).toBe('Loading the bead…');
    expect(within(pane).getByRole('heading', { level: 2 }).textContent).toBe('Review task');
    // ov-5's card has verify_block 'output', so the placeholder reserves the verification output the arrived pane shows.
    expect(within(pane).getByText('Verification: passed')).toBeTruthy();
    expect(pane.querySelector('pre')?.textContent).toContain('exit 0');
    await act(async () => { release(reviewDetail); });
    expect(await screen.findByText('Adds the greeting endpoint with a test.')).toBeTruthy();
    expect(document.querySelector('.review-detail .shimmer')).toBeNull();
  });
  it('says so when the bead detail cannot be loaded instead of leaving the shimmer standing', async () => {
    mockApi((_m, url) => { throw Object.assign(new Error('gone'), { status: url.endsWith('/api/tasks/ov-5') ? 404 : 500 }); });
    render(<Review board={board} version={0} selected="ov-5" selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('Could not load ov-5.');
    expect(document.querySelector('.review-detail .shimmer')).toBeNull();
  });
  it('recovers from a failed refetch: Retry re-runs the fetch, and a v1 bead selected afterwards has live actions (fix round 14 review)', async () => {
    let down = false;
    mockApi((_m, url) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'All landed.' } };
      if (url.endsWith('/api/tasks/ov-4')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { rerender } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('All landed.');
    down = true;
    rerender(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('Showing the last known state of this batch; it could not be refreshed.');
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    // No board event follows; the failure line's Retry is the way back.
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
    // A failure left standing must not follow the user onto a v1 bead's pane.
    down = true;
    rerender(<Review board={inReview} version={2} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('Showing the last known state of this batch; it could not be refreshed.');
    down = false;
    rerender(<Review board={inReview} version={2} selected="ov-4" selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText(reviewDetail.bead.title);
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('says so when the batch detail cannot be loaded instead of loading forever', async () => {
    mockApi((_m, url) => { throw Object.assign(new Error('gone'), { status: url.endsWith('/api/batches/r1-b1') ? 404 : 500 }); });
    render(<Review board={board} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('Could not load batch r1-b1.');
    expect(screen.queryByText(/loading the batch/i)).toBeNull();
    expect(document.querySelector('.review-detail[aria-busy="true"]')).toBeNull();
  });
  it('announces an empty rejection note and moves focus to the note field', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('alert').textContent).toBe('A rejection note is required.');
    expect(document.activeElement).toBe(screen.getByLabelText('Rejection note'));
  });

  it('lists batches as buttons under Ready for you / In progress / Finished and shows a finished batch with its merge commit', async () => {
    const b1 = board.repos[0]!.batches[0]!;
    const merged = { ...b1, id: 'r1-b2', title: 'Landed one', status: 'merged' as const, merged_at: '2026-09-13T01:00:00.000Z', updated_at: '2026-09-13T01:00:00.000Z', merged_commit: '6dbb0f8abcdef', setup_at: null, beads_total: 1, beads_done: 1, cost: 0.7 };
    const landedBead = { ...board.repos[0]!.cards[6]!, batch_id: 'r1-b2' };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'ready' }, beads: [landedBead, batchDetail.beads[0]!], landed_verified: 1 };
      if (url.endsWith('/api/batches/r1-b2')) return { ...batchDetail, batch: merged, beads: [landedBead], diff: null, cost: 0.7, landed_verified: 1 };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const three: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...b1, status: 'review', beads_total: 2, beads_done: 1 }, { ...b1, id: 'r1-b3', title: 'Second one' }, merged] }] };
    function Harness() { const [sel, setSel] = useState<string | null>('r1-b1'); return <Review board={three} version={0} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />; }
    render(<Harness />);
    await screen.findByText('ready');
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent).slice(0, 3)).toEqual(['Ready for you', 'In progress', 'Finished (1)']);
    // Finished is collapsed until the selected batch is in it (the list only grows).
    const finished = screen.getByText('Finished', { exact: false, selector: 'summary h4' }).closest('details')!;
    expect(finished.open).toBe(false);
    expect(screen.getByText(/Verification: pass \(1\/2 beads landed\)/)).toBeTruthy();
    expect(screen.getByText('landed', { selector: '.review-beads .muted' })).toBeTruthy();
    const item = screen.getByRole('button', { name: /Landed one/ });
    expect(item.closest('li')).toBeTruthy();
    fireEvent.click(item);
    await screen.findByText(/Merged into main at 6dbb0f8 on/);
    expect(finished.open).toBe(true);
    expect(screen.getByText('$0.70')).toBeTruthy();
    expect(screen.getByText('Done task')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Merge|Reject|Abandon/ })).toBeNull();
    expect(screen.queryByText(/Diff against/)).toBeNull();
  });

  it('shows a batch waiting on an overlapping one as waiting, names the batch and the files, and disables Merge but not Reject or Abandon', async () => {
    const b1 = board.repos[0]!.batches[0]!;
    const waiting = { ...b1, id: 'r1-b2', title: 'Second one', branch: 'feature/second', status: 'review' as const, note: 'ready', waiting_on: 'r1-b1', overlap_files: ['src/a.ts', 'src/b.ts'] };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b2')) return { ...batchDetail, batch: waiting };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const two: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...b1, status: 'review' }, waiting] }] };
    render(<Review board={two} version={0} selected={null} selectedBatch="r1-b2" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('ready');
    expect(screen.getByRole('button', { name: /Second one/ }).textContent).toContain('waiting');
    const reviewList = document.querySelector('.review-list') as HTMLElement;
    expect(within(reviewList).getAllByRole('heading', { level: 4 }).map((h) => h.textContent).slice(0, 2)).toEqual(['Ready for you', 'Waiting']);
    const waitingRow = within(reviewList).getByRole('button', { name: /Second one/ });
    expect(waitingRow.closest('li')?.classList.contains('muted')).toBe(true);
    expect(within(waitingRow).getByText('Waiting on #9310 Trend chart').classList.contains('chip')).toBe(true);
    expect(waitingRow.textContent).toContain('waiting');
    expect(screen.getByText('Waiting on #9310 Trend chart: both change src/a.ts, src/b.ts. Merge is available once that batch is merged, rejected or abandoned.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows only Waiting when every review batch is held and falls back to an absent blocker id', async () => {
    const source = board.repos[0]!.batches[0]!;
    const waiting = { ...source, id: 'r1-held', title: 'Held change', status: 'review' as const, waiting_on: 'r1-gone' };
    const waitingOnly: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [], batches: [waiting] }] };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-held')) return { ...batchDetail, batch: waiting };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={waitingOnly} version={0} selected={null} selectedBatch="r1-held" onSelect={noop} onSelectBatch={noop} />);
    const reviewList = document.querySelector('.review-list') as HTMLElement;
    expect(within(reviewList).getByRole('heading', { name: 'Waiting' })).toBeTruthy();
    expect(within(reviewList).queryByRole('heading', { name: 'Ready for you' })).toBeNull();
    const waitingRow = within(reviewList).getByRole('button', { name: /Held change/ });
    expect(waitingRow.closest('li')?.classList.contains('muted')).toBe(true);
    expect(within(waitingRow).getByText('Waiting on r1-gone').classList.contains('chip')).toBe(true);
  });

  it('keeps review batches routed to the orchestrator in their own group', () => {
    const source = board.repos[0]!.batches[0]!;
    const routed = { ...source, title: 'Orchestrator change', status: 'review' as const, waiting_on: null };
    const orchestratorRepo = { ...board.repos[0]!.repo, batch_approver: 'orchestrator' as const };
    const orchestratorBoard: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, repo: orchestratorRepo, cards: [], batches: [routed] }] };
    render(<Review board={orchestratorBoard} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    const reviewList = document.querySelector('.review-list') as HTMLElement;
    expect(within(reviewList).getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual(['Handled by orchestrator']);
    expect(within(reviewList).getByRole('button', { name: /Orchestrator change/ })).toBeTruthy();
    expect(within(reviewList).queryByText(/Nothing to review yet/)).toBeNull();
  });

  it('keeps the existing empty state when no review batches or tasks remain', () => {
    const empty: BoardResponse = { ...board, repos: board.repos.map((r) => ({ ...r, cards: [], batches: [] })) };
    render(<Review board={empty} version={0} selected={null} selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    expect(screen.getByText('Nothing to review yet. Batches appear here as soon as the orchestrator creates one; those awaiting your decision come first.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ready for you' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Waiting' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Handled by orchestrator' })).toBeNull();
  });

  it('moves a held review row to Ready for you when the next board refresh clears its blocker', async () => {
    const source = board.repos[0]!.batches[0]!;
    const blocker = { ...source, id: 'r1-first', title: 'First change', status: 'review' as const, waiting_on: null };
    const waiting: BoardResponse['repos'][number]['batches'][number] = { ...source, id: 'r1-second', title: 'Second change', status: 'review', waiting_on: blocker.id };
    const boardWith = (held: BoardResponse['repos'][number]['batches'][number]) => ({ ...board, repos: [{ ...board.repos[0]!, cards: [], batches: [blocker, held] }] });
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-second')) return { ...batchDetail, batch: waiting };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Review board={boardWith(waiting)} version={0} selected={null} selectedBatch="r1-second" onSelect={noop} onSelectBatch={noop} />);
    const reviewList = document.querySelector('.review-list') as HTMLElement;
    expect(within(reviewList).getByRole('heading', { name: 'Waiting' })).toBeTruthy();
    const released = { ...waiting, waiting_on: null };
    rerender(<Review board={boardWith(released)} version={1} selected={null} selectedBatch="r1-second" onSelect={noop} onSelectBatch={noop} />);
    expect(within(reviewList).queryByRole('heading', { name: 'Waiting' })).toBeNull();
    expect(within(reviewList).getByRole('heading', { name: 'Ready for you' })).toBeTruthy();
    expect(within(reviewList).getByRole('button', { name: /Second change/ }).textContent).not.toContain('Waiting on');
  });

  it('describes a review refresh conflict in the correct merge direction', async () => {
    const conflicted = { ...batchDetail.batch, status: 'review' as const, conflict_files: ['README.md'], refresh_from: 'r1-b0' };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: conflicted };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(await screen.findByText('The refresh from main conflicted in: README.md. Reject with a note and the orchestrator adds a merge bead.')).toBeTruthy();
  });

  it('describes a local merge conflict as merging the batch into base', async () => {
    const conflicted = { ...batchDetail.batch, status: 'review' as const, conflict_files: ['README.md'], refresh_from: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: conflicted };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(await screen.findByText('Last merge into main conflicted in: README.md. Reject with a note and the orchestrator adds a merge bead.')).toBeTruthy();
  });

  it('shows a merged batch without actions, with a target even when the commit is unknown', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [], diff: null, batch: { ...batchDetail.batch, status: 'merged', merged_commit: null, setup_at: null, mr_url: null, conflict_files: ['README.md'] } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={{ ...board, repos: [{ ...board.repos[0]!, batches: [] }] }} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText(/this batch is merged/i)).toBeTruthy());
    expect(screen.getByText(/^Merged into main on /)).toBeTruthy();
    expect(screen.getByText('merged', { selector: '.chip' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Abandon' })).toBeNull();
    expect(screen.queryByText(/conflicted in/)).toBeNull();
  });

  it('names a failed verification in the batch header with the output tail, instead of "pending"', async () => {
    const failed = board.repos[0]!.cards.find((c) => c.bead.id === 'ov-6')!;
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [...batchDetail.beads, failed] };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected={null} onSelect={noop} selectedBatch="r1-b1" onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText('Verification: failed (ov-6)')).toBeTruthy());
    expect(screen.queryByText(/pending/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Verification of ov-6 failed' })).toBeTruthy();
    expect(screen.getByText(/1 failed\s+exit 1/)).toBeTruthy();
    expect(screen.getByText('verify failed', { selector: '.review-beads .muted' })).toBeTruthy();
  });

  it('names the outcome of each bead in a finished batch', () => {
    const c = board.repos[0]!.cards[6]!;
    expect(beadOutcome({ ...c, column: 'done', bead: { ...c.bead, labels: ['overseer:merged'] } })).toBe('landed');
    expect(beadOutcome({ ...c, column: 'done', bead: { ...c.bead, labels: ['overseer:abandoned'] } })).toBe('abandoned');
    expect(beadOutcome({ ...c, column: 'done', bead: { ...c.bead, labels: ['overseer:closed'] } })).toBe("closed (won't do)");
    expect(beadOutcome({ ...c, column: 'done', bead: { ...c.bead, labels: ['overseer:verified'] } })).toBe('verified (no commits)');
    expect(beadOutcome({ ...c, column: 'running', bead: { ...c.bead, labels: [] } })).toBe('running');
    expect(beadOutcome({ ...c, column: 'done', bead: { ...c.bead, labels: ['overseer:merged'] }, accepted_note: 'Landed with a should-fix noted.' })).toBe('landed with open findings');
  });

  it('shows a bead landed with open findings, its note and its findings, in the batch bead list', async () => {
    const c = board.repos[0]!.cards.find((x) => x.bead.id === 'ov-6')!;
    const findingsBead = { ...c, bead: { ...c.bead, labels: ['overseer:merged'] }, verify_failure: null, accepted_note: 'Accepted with a should-fix left open.', findings: [{ file: 'src/a.ts', summary: 'unused import', severity: 'should' as const }] };
    mockApi((_m, url) => { if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [findingsBead] }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Review board={board} version={0} selected={null} onSelect={noop} selectedBatch="r1-b1" onSelectBatch={noop} />);
    await screen.findByText('landed with open findings');
    expect(screen.getByText('Accepted with a should-fix left open.')).toBeTruthy();
    expect(screen.getByText(/should src\/a\.ts: unused import/)).toBeTruthy();
  });

  it('shows the current summary on top with earlier rounds folded, and says when a round has no summary yet (round 13)', async () => {
    let detail: typeof batchDetail = { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'Two lines now, hi then bye.', history: 'Adds the file with hi.\n\nRejected: also append bye.' } };
    mockApi((_m, url) => { if (url.endsWith('/api/batches/r1-b1')) return detail; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { rerender } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const summary = await screen.findByText('Two lines now, hi then bye.');
    const history = screen.getByText('Earlier rounds').closest('details')!;
    expect(history.open).toBe(false);
    expect(history.textContent).toContain('Rejected: also append bye.');
    expect(summary.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // newest first
    // After a rejection the round has no summary; the pane says so instead of showing the rejected one as if current.
    detail = { ...detail, batch: { ...detail.batch, status: 'open', note: null, history: `${detail.batch.history}\n\nTwo lines now, hi then bye.\n\nRejected: and a third.` } };
    rerender(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(await screen.findByText('No summary for this round yet: the orchestrator has not requested review again.')).toBeTruthy();
    expect(screen.getByText('Earlier rounds').closest('details')!.textContent).toContain('Rejected: and a third.');
  });

  it('says nothing landed, not pending, when every bead of a batch in review was closed as won\'t do (fix round 13 review)', async () => {
    const closed = { ...board.repos[0]!.cards[7]!, batch_id: 'r1-b1', bead: { ...board.repos[0]!.cards[7]!.bead, id: 'ov-9', title: 'Dropped task', labels: ['overseer:closed'] } };
    mockApi((_m, url) => { if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [closed], batch: { ...batchDetail.batch, status: 'review' } }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', beads_total: 1, beads_done: 0, beads_closed: 1 }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(await screen.findByText("Verification: nothing landed (1 closed as won't do)")).toBeTruthy();
  });

  it('counts a bead closed as won\'t do apart from the landed ones in the list and the header (round 13)', async () => {
    const landed = { ...board.repos[0]!.cards[6]!, batch_id: 'r1-b1' };
    const closed = { ...board.repos[0]!.cards[7]!, batch_id: 'r1-b1', bead: { ...board.repos[0]!.cards[7]!.bead, id: 'ov-9', title: 'Dropped task', labels: ['overseer:closed'] } };
    mockApi((_m, url) => { if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [landed, closed], landed_verified: 1, batch: { ...batchDetail.batch, status: 'review' } }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', beads_total: 2, beads_done: 1, beads_closed: 1 }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(screen.getByRole('button', { name: /#9310 Trend chart/ }).textContent).toContain('1 landed, 1 closed of 2');
    expect(await screen.findByText('Verification: pass (1 landed, 1 closed of 2 beads)')).toBeTruthy();
    expect(screen.getByText('Dropped task').parentElement!.textContent).toContain("closed (won't do)");
  });

  it('reads landed and closed from the batch summary for the verification line, so it agrees with the row above it (round 17 R17-2)', async () => {
    // Both cards carry `overseer:merged` (a bead's labels are what an older install wrote), but the daemon's rows say one landed and one was closed.
    const merged = (id: string) => ({ ...board.repos[0]!.cards[6]!, batch_id: 'r1-b1', bead: { ...board.repos[0]!.cards[6]!.bead, id, labels: ['overseer:merged'] } });
    mockApi((_m, url) => { if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [merged('ov-7'), merged('ov-9')], landed_verified: 1, batch: { ...batchDetail.batch, status: 'review' } }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', beads_total: 2, beads_done: 1, beads_closed: 1 }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(screen.getByRole('button', { name: /#9310 Trend chart/ }).textContent).toContain('1 landed, 1 closed of 2');
    expect(await screen.findByText('Verification: pass (1 landed, 1 closed of 2 beads)')).toBeTruthy();
  });

  it('keeps the last known batch detail, note field included, when a refetch fails and across a remount (round 13)', async () => {
    let down = false;
    mockApi((_m, url) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'All landed.' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    const { rerender, unmount } = render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('All landed.');
    down = true;
    fireEvent.change(screen.getByPlaceholderText(/why/i), { target: { value: 'typed while down' } });
    // A failed refetch for any reason (here without the outage flag): the stale pane keeps its actions disabled (fix round 13 review).
    rerender(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('Showing the last known state of this batch; it could not be refreshed.');
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Review board={inReview} version={2} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} offline />);
    await screen.findByText('Showing the last known state of this batch; it could not be refreshed.');
    expect(screen.getByText('All landed.')).toBeTruthy();
    expect((screen.getByPlaceholderText(/why/i) as HTMLInputElement).value).toBe('typed while down');
    expect(screen.queryByText(/Could not load batch/)).toBeNull();
    // A visit to Chat unmounts Review; back on it while still down, the pane shows the same last known state and the draft.
    unmount();
    render(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} offline />);
    await screen.findByText('Showing the last known state of this batch; it could not be refreshed.');
    expect(screen.getByText('All landed.')).toBeTruthy();
    expect((screen.getByPlaceholderText(/why/i) as HTMLInputElement).value).toBe('typed while down');
    // A batch never loaded before has nothing to show but the summary from the board and the failure.
    cleanup();
    render(<Review board={inReview} version={1} selected={null} selectedBatch="r1-b2" onSelect={noop} onSelectBatch={noop} offline />);
    expect(await screen.findByText('Could not load batch r1-b2.')).toBeTruthy();
  });

  it.each([
    ['review', /The orchestrator merges r1's batches/],
    ['merged', /Merged into main/],
  ] as const)('renders the %s batch leading line before the stale detail warning', async (status, leadingText) => {
    let fail = false;
    mockApi((_method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) {
        if (fail) throw Object.assign(new Error('refresh failed'), { status: 500 });
        return { ...batchDetail, batch: { ...batchDetail.batch, status }, repo: { ...batchDetail.repo, batch_approver: 'orchestrator' } };
      }
      throw Object.assign(new Error(`unexpected ${url}`), { status: 500 });
    });
    const summary = { ...board.repos[0]!.batches[0]!, status: status as BatchStatus };
    const current: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [summary] }] };
    const view = render(<Review board={current} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const leading = await screen.findByText(leadingText);
    fail = true;
    view.rerender(<Review board={current} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const stale = await screen.findByText(/Showing the last known state of this batch/);
    expect(leading.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names a bead in Verifying in the batch header instead of dropping to "pending" while it re-verifies', async () => {
    const reverifying = { ...board.repos[0]!.cards.find((c) => c.bead.id === 'ov-6')!, column: 'verifying' as const, verify_failure: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, beads: [reverifying] };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected={null} onSelect={noop} selectedBatch="r1-b1" onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText('Verification: verifying (ov-6)')).toBeTruthy());
    expect(screen.queryByText(/pending/)).toBeNull();
  });

  it('does not let a watch from an earlier action clear a later, unrelated acknowledgement', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (method === 'POST') return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const withStatus = (status: 'open' | 'review'): BoardResponse => ({ ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status }] }] });
    function Harness(h: { b: BoardResponse; v: number }) {
      const [sel, setSel] = useState<string | null>('r1-b1');
      const [bead, setBead] = useState<string | null>(null);
      return <Review board={h.b} version={h.v} selected={bead} selectedBatch={sel} onSelect={setBead} onSelectBatch={setSel} />;
    }
    const { rerender } = render(<Harness b={withStatus('review')} v={0} />);
    fireEvent.change(await screen.findByPlaceholderText(/why/i), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await endJobs();
    await waitFor(() => expect(listStatus().textContent).toBe('Batch r1-b1 rejected; the orchestrator was notified.'));
    // The user opens a v1 bead (the line goes) and merges it: a new line that has nothing to do with the batch.
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }));
    expect(queryListStatus()).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await endJobs();
    await waitFor(() => expect(listStatus().textContent).toBe('ov-5 merged.'));
    // The rejected batch goes through "open" and back to "review": that is the old watch's trigger, and it must not touch this line.
    rerender(<Harness b={withStatus('open')} v={1} />);
    rerender(<Harness b={withStatus('review')} v={2} />);
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(listStatus().textContent).toBe('ov-5 merged.');
  });

  it('restarts the minute when the same acknowledgement is shown again (fix round 10 review)', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (url.endsWith('/reject')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    // The selection is pinned, so the pane stays after each rejection (the board never leaves review in this test).
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    const field = await screen.findByPlaceholderText(/why/i);
    vi.useFakeTimers();
    try {
      const rejectOnce = async () => {
        fireEvent.change(field, { target: { value: 'again' } });
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        await endJobs();
        expect(screen.getByRole('status').textContent).toBe('Batch r1-b1 rejected; the orchestrator was notified.');
      };
      await rejectOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(ACK_MS - 1000); });
      await rejectOnce(); // identical text: the minute must start over
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByRole('status')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(ACK_MS); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders inline code in the v1 orchestrator note as code (fix round 10 review)', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return { ...reviewDetail, worktree: { ...reviewDetail.worktree!, review_note: 'Adds `GET /greet` with a test.' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected="ov-5" selectedBatch={null} onSelect={noop} onSelectBatch={noop} />);
    await screen.findByText('Adds', { exact: false });
    const note = document.querySelector('.review-note')!;
    expect(note.textContent).toBe('Adds GET /greet with a test.');
    expect(note.querySelector('code')!.textContent).toBe('GET /greet');
  });

  it('drops an acknowledgement after a minute even when the board never showed the state it names', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (url.endsWith('/reject')) return accept(url);
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const inReview: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] };
    render(<Review board={inReview} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    fireEvent.change(await screen.findByPlaceholderText(/why/i), { target: { value: 'x' } });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      await endJobs();
      expect(screen.getByRole('status').textContent).toBe('Batch r1-b1 rejected; the orchestrator was notified.');
      await act(async () => { await vi.advanceTimersByTimeAsync(ACK_MS - 20); });
      expect(screen.getByRole('status')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a selected v1 bead that the board no longer lists, and nothing before the board is known', async () => {
    mockApi(() => { throw Object.assign(new Error('task ov-99 not found'), { status: 404 }); });
    const onSelect = vi.fn();
    render(<Review board={board} version={0} selected="ov-99" selectedBatch={null} onSelect={onSelect} onSelectBatch={noop} />);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    onSelect.mockClear();
    render(<Review board={null} version={0} selected="ov-99" selectedBatch={null} onSelect={onSelect} onSelectBatch={noop} />);
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not act on the v1 bead the pane has left while the newly selected one is still loading (fix round 19 review NB-6)', async () => {
    const posts: string[] = [];
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      if (url.endsWith('/api/tasks/ov-50')) return new Promise(() => {}); // never resolves: the pane still shows ov-5's detail
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const asked: string[] = [];
    vi.stubGlobal('confirm', (m: string) => { asked.push(m); return true; });
    const second = { ...board.repos[0]!.cards[4]!, bead: { ...board.repos[0]!.cards[4]!.bead, id: 'ov-50', title: 'Second review task' } };
    const two: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [...board.repos[0]!.cards, second] }] };
    const { rerender } = render(<Review board={two} version={0} selected="ov-5" onSelect={noop} selectedBatch={null} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.getByText('Adds the greeting endpoint with a test.')).toBeTruthy());
    rerender(<Review board={two} version={0} selected="ov-50" onSelect={noop} selectedBatch={null} onSelectBatch={noop} />);
    // The batch path has this guard; without it here, Merge asked about ov-5 and would have merged it.
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.change(screen.getByPlaceholderText(/why/i), { target: { value: 'not this one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(asked).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('names the batch it acts on in the Abandon and Merge dialogs, and acts on the selection rather than the first row (round 18 R18-1)', async () => {
    const second = { ...batchDetail.batch, id: 'r1-b2', title: 'Second batch', branch: 'feature/second', status: 'review' as const };
    const posts: string[] = [];
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/batches/r1-b2')) return { ...batchDetail, batch: second };
      if (method === 'POST') { posts.push(url); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    // Two batches in review: the first row is not the selected one, which is what the round-18 mis-click turned on.
    const first = { ...board.repos[0]!.batches[0]!, status: 'review' as const };
    const two: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, batches: [first, { ...first, ...second }] }] };
    render(<Review board={two} version={0} selected={null} selectedBatch="r1-b2" onSelect={noop} onSelectBatch={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    expect(screen.getByText('Abandon batch “Second batch” (r1-b2) on feature/second? Running workers are stopped, that branch and its worktrees are deleted, its beads are closed, and nothing reaches main.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm abandon' }));
    await waitFor(() => expect(posts).toEqual(['/api/batches/r1-b2/abandon']));
    await endJobs(false, 'bd is unavailable'); // the abandon failed, so the batch is still there to merge
    // Merge asks with the same identity, and posts to the same batch.
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByText('Merge batch “Second batch” (r1-b2) into main? Its branch feature/second is deleted afterwards.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => expect(posts).toContain('/api/batches/r1-b2/merge'));
  });
  it('on a phone opens a batch as a sheet on tap only, and Back returns to the list', async () => {
    // The Board pane's sheet pattern: below the breakpoint nothing is picked for the user (the sheet would cover the list), a tap opens it, Back closes it.
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === PHONE_QUERY }));
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return batchDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() { const [sel, setSel] = useState<string | null>(null); return <Review board={board} version={0} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />; }
    render(<Harness />);
    expect(screen.getByRole('button', { name: /#9310 Trend chart/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to review list' })).toBeNull(); // no default selection on a phone
    fireEvent.click(screen.getByRole('button', { name: /#9310 Trend chart/ }));
    await screen.findByText('r1-b1', { selector: '.detail-head span' });
    await screen.findByRole('heading', { level: 4, name: 'Beads' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to review list' }));
    expect(screen.queryByRole('button', { name: 'Back to review list' })).toBeNull();
    expect(screen.getByRole('button', { name: /#9310 Trend chart/ })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('renders desktop close and phone Back controls in the shared header', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return batchDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={board} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await screen.findByRole('button', { name: 'Close details' });
    expect(screen.getByRole('button', { name: 'Back to review list' })).toBeTruthy(); // CSS selects the mobile control.
  });

  it('says which repositories the orchestrator merges on its own', async () => {
    let detail: typeof batchDetail = { ...batchDetail, repo: { ...batchDetail.repo, batch_approver: 'orchestrator' }, batch: { ...batchDetail.batch, status: 'review' } };
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return detail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const boardWithApprover = (approver: 'user' | 'orchestrator'): BoardResponse => ({ ...board, repos: [{ ...board.repos[0]!, repo: { ...board.repos[0]!.repo, batch_approver: approver }, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' }] }] });
    const { rerender } = render(<Review board={boardWithApprover('orchestrator')} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(await screen.findByText("The orchestrator merges r1's batches on its own; it will merge this one without waiting for you. Merge and Reject stay available.")).toBeTruthy();
    // The user can still act; the wording only says they do not have to.
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    detail = { ...detail, repo: { ...detail.repo, batch_approver: 'user' } };
    rerender(<Review board={boardWithApprover('user')} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.queryByText(/merges r1's batches on its own/)).toBeNull());
    detail = { ...detail, repo: { ...detail.repo, merge_mode: 'gitlab-mr', batch_approver: 'orchestrator' } };
    const invalidBoard = boardWithApprover('orchestrator');
    invalidBoard.repos[0]!.repo.merge_mode = 'gitlab-mr';
    rerender(<Review board={invalidBoard} version={2} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await waitFor(() => expect(screen.queryByText(/merges r1's batches on its own/)).toBeNull());
  });

  const inReviewBoard = (over: Partial<BoardResponse['repos'][number]['batches'][number]> = {}): BoardResponse => ({ ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review', ...over }] }] });

  it('shows the action in progress on its button and disables the rest from the click until the job ends', async () => {
    let release: () => void = () => {};
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') return new Promise<unknown>((r) => { release = () => r(accept(url)); });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<Review board={inReviewBoard()} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    // The 202 is not the end: the line says the merge was accepted and the buttons stay as they were until the result.
    expect(screen.getByRole('status').textContent).toBe('Merging batch r1-b1 into main…');
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(true);
    // Its result arrives before any board carried the job: it merged.
    await endJobs();
    expect(screen.getByRole('status').textContent).toBe('Batch r1-b1 merged into main.');
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows no success after a job that fails in the background, and keeps the rejection note to send again', async () => {
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') { posts.push(body); return accept(url); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() { const [sel, setSel] = useState<string | null>('r1-b1'); return <Review board={inReviewBoard()} version={0} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />; }
    render(<Harness />);
    fireEvent.change(await screen.findByRole('textbox', { name: /rejection note/i }), { target: { value: 'needs tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    // The pane closes on the 202 with the acceptance line.
    await waitFor(() => expect(listStatus().textContent).toBe('Rejecting batch r1-b1…'));
    expect(screen.queryByRole('textbox', { name: /rejection note/i })).toBeNull();
    await endJobs(false, 'bd is unavailable');
    expect(queryListStatus()).toBeNull();
    expect(screen.queryByText(/rejected; the orchestrator was notified/)).toBeNull();
    // Back on the batch: the note is there as it was typed, and Reject is live again.
    fireEvent.click(screen.getByRole('button', { name: /#9310 Trend chart/ }));
    const note = await screen.findByRole('textbox', { name: /rejection note/i }) as HTMLTextAreaElement;
    expect(note.value).toBe('needs tests');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts).toEqual([{ note: 'needs tests' }, { note: 'needs tests' }]));
  });

  it('hands focus to the line when the job result arrives before its 202 has been read', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') {
        const job = accept(url);
        jobEnded({ ...job, ok: true, message: null, data: null }); // the socket is faster than the answer
        return job;
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() { const [sel, setSel] = useState<string | null>('r1-b1'); return <Review board={inReviewBoard()} version={0} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />; }
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    // The pane closes on the 202 and the outcome is already known: the line says it, and it has focus, not the removed pane.
    await waitFor(() => expect(listStatus().textContent).toBe('Batch r1-b1 merged into main.'));
    expect(screen.queryByRole('button', { name: 'Confirm merge' })).toBeNull();
    expect(document.activeElement).toBe(listStatus());
  });

  it('hands focus to the review list when a failed job result arrives before its 202 has been read', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') {
        const job = accept(url);
        jobEnded({ ...job, ok: false, message: 'merge conflict in src/a.ts', data: null }); // the socket is faster than the answer
        return job;
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() { const [sel, setSel] = useState<string | null>('r1-b1'); return <Review board={inReviewBoard()} version={0} selected={null} selectedBatch={sel} onSelect={noop} onSelectBatch={setSel} />; }
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    // The pane closes on the 202 and the failure is already known: no line is shown (the result toast says why), and focus
    // lands on the list the pane closed over, not on <body>.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm merge' })).toBeNull());
    await act(async () => {});
    expect(queryListStatus()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(document.querySelector('.review-list'));
  });

  it('frees the buttons once the result of the job the board row carries arrives, while no newer board has come', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const running = (jobId: string) => inReviewBoard({ pending_action: { job_id: jobId, action: 'merge', started_at: '2026-09-13T00:00:00.000Z' } });
    const stale = running('job-old');
    const { rerender } = render(<Review board={stale} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(await screen.findByRole('button', { name: 'Merging…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { jobEnded({ job_id: 'job-old', action: 'merge', target: 'r1-b1', ok: false, message: 'merge conflict in src/a.ts', data: null }); });
    // The row still names the job, but its result is known: nothing runs.
    expect(screen.queryByRole('button', { name: 'Merging…' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(false);
    // A board event whose refetch failed: the app shell keeps the stale board, and the buttons stay free.
    rerender(<Review board={stale} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await act(async () => {});
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(false);
    // A row naming a newer job is a job that runs.
    rerender(<Review board={running('job-new')} version={2} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears the list and header badges of a job whose result arrived while the board is stale, and keeps a newer job\'s', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return new Promise(() => {}); // the detail never lands: the header comes from the board row
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const started_at = '2026-09-13T00:00:00.000Z';
    const badges = (batchJob: string, beadJob: string): BoardResponse => {
      const b = inReviewBoard({ pending_action: { job_id: batchJob, action: 'merge', started_at } });
      return { ...b, repos: b.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-5' ? { ...c, pending_action: { job_id: beadJob, action: 'reject', started_at } } : c)) })) };
    };
    const listChips = () => Array.from(document.querySelectorAll('.review-list .chip.pending')).map((e) => e.textContent);
    const headerChips = () => Array.from(document.querySelectorAll('.review-detail .review-head .chip.pending')).map((e) => e.textContent);
    const stale = badges('job-batch-old', 'job-bead-old');
    const { rerender } = render(<Review board={stale} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(listChips()).toEqual(['Merging…', 'Rejecting…']);
    expect(headerChips()).toEqual(['Merging…']);
    act(() => {
      jobEnded({ job_id: 'job-batch-old', action: 'merge', target: 'r1-b1', ok: false, message: 'merge conflict in src/a.ts', data: null });
      jobEnded({ job_id: 'job-bead-old', action: 'reject', target: 'ov-5', ok: true, message: null, data: null });
    });
    // Both rows still name their jobs, whose results are known: no badge says they run.
    expect(listChips()).toEqual([]);
    expect(headerChips()).toEqual([]);
    // A board event whose refetch failed: the app shell keeps the stale board, and the badges stay gone.
    rerender(<Review board={stale} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(listChips()).toEqual([]);
    expect(headerChips()).toEqual([]);
    // A newer job on a row is a job that runs; the other row's ended job stays cleared.
    rerender(<Review board={badges('job-batch-new', 'job-bead-old')} version={2} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(listChips()).toEqual(['Merging…']);
    expect(headerChips()).toEqual(['Merging…']);
    rerender(<Review board={badges('job-batch-new', 'job-bead-new')} version={3} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect(listChips()).toEqual(['Merging…', 'Rejecting…']);
  });

  it('keeps a 409 for another action pending under the running one, and frees the buttons once that job ends and a board without it follows', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') throw Object.assign(new Error('merge is already running for r1-b1'), { status: 409, body: { job_id: 'job-running', action: 'merge' } });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Review board={inReviewBoard()} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm abandon' }));
    await act(async () => {}); // the 409 has been read
    // Before any board carries the job: the pending state is the merge the daemon runs, not the abandon that was refused.
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Abandoning…' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(true);
    // The running job was short: it ended before any board carried it.
    act(() => { jobEnded({ job_id: 'job-running', action: 'merge', target: 'r1-b1', ok: true, message: null, data: null }); });
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<Review board={inReviewBoard({ pending_action: null })} version={1} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />);
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('toasts the running action and keeps the pending state on a 409', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') throw Object.assign(new Error('merge is already running for r1-b1'), { status: 409, body: { job_id: 'j1', action: 'merge' } });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><Review board={inReviewBoard()} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} /><Toasts /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(((await screen.findByRole('alert')).querySelector('.toast-text') as HTMLElement).textContent).toBe('merge is already running for r1-b1');
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('toasts a validation refusal and restores the buttons', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review' } };
      if (method === 'POST') throw Object.assign(new Error('batch r1-b1 is not in review'), { status: 400 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><Review board={inReviewBoard()} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} /><Toasts /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(((await screen.findByRole('alert')).querySelector('.toast-text') as HTMLElement).textContent).toBe('Could not merge: batch r1-b1 is not in review');
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Abandon' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the pending badge from the board row and keeps it across a remount', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/batches/r1-b1')) return { ...batchDetail, batch: { ...batchDetail.batch, status: 'review', note: 'ready' } };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const pending = inReviewBoard({ pending_action: { job_id: 'j1', action: 'merge', started_at: '2026-09-13T00:00:00.000Z' } });
    const view = () => <Review board={pending} version={0} selected={null} selectedBatch="r1-b1" onSelect={noop} onSelectBatch={noop} />;
    const first = render(view());
    await screen.findByText('ready');
    expect(within(document.querySelector('.review-list') as HTMLElement).getByText('Merging…')).toBeTruthy();
    expect(within(document.querySelector('.review-head') as HTMLElement).getByText('Merging…')).toBeTruthy();
    first.unmount();
    render(view());
    expect(within(document.querySelector('.review-list') as HTMLElement).getByText('Merging…')).toBeTruthy();
  });
});
