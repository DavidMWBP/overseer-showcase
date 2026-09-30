import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { TaskPane } from './TaskPane';
import { Toasts } from '../components/Toasts';
import { jobEnded } from '../lib/jobs';
import { mockApi } from '../test/setup';
import { board, reviewDetail } from '../test/fixtures';

const noop = () => {};
/** A card whose branch carries a failed verification: the pane offers Retry verification and Re-dispatch. */
const failedCard = board.repos[0]!.cards[5]!;
const failedDetail = { ...reviewDetail, bead: failedCard.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-6', batch_id: 'r1-b1', verify_status: 'fail' as const, verify_output: '$ pnpm test\nexit 1' }, last_assistant_text: null };
const pane = () => screen.findByRole('complementary', { name: 'Details of ov-6' });
const actionButton = async (name: string) => within(await pane()).getByRole('button', { name });
/** The daemon's 202 for an action on ov-6, and the result the app shell passes on from the socket when its job ends. */
const accepted = (action: string) => ({ job_id: `job-${action}`, action, target: 'ov-6' });
const endJob = (action: string, ok: boolean) => act(() => { jobEnded({ ...accepted(action), ok, message: ok ? null : 'exit 1', data: null }); });
const disabled = (p: HTMLElement, name: string) => (within(p).getByRole('button', { name }) as HTMLButtonElement).disabled;
/** The fixture board with a job on ov-6's card, or none. */
const withJob = (jobId: string | null) => ({ ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, pending_action: jobId ? { job_id: jobId, action: 'verify', started_at: '2026-09-13T00:00:00.000Z' } : null } : c)) })) });

describe('TaskPane', () => {
  it('uses the host header control to return to the batch when one is provided', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onBackToBatch = vi.fn();
    render(<TaskPane beadId="ov-5" board={board} version={0} onSelect={noop} onClose={noop} onBackToBatch={onBackToBatch} onOpenReview={noop} onOpenBatch={noop} />);
    const details = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(within(details).getByRole('button', { name: 'Back to batch' }));
    expect(onBackToBatch).toHaveBeenCalledOnce();
    expect(readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8')).toContain('.detail-head .detail-back-to-batch { display: inline-block; }');
  });

  it('renders the card metadata and the fetched detail for the bead it is given', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TaskPane beadId="ov-5" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    // Header metadata comes from the card the board holds; the description and history come from the detail fetch.
    expect(within(pane).getByText('bead/ov-5')).toBeTruthy();
    expect(within(pane).getByText('$1.20')).toBeTruthy();
    expect(await within(pane).findByText('Description of Review task')).toBeTruthy();
    expect(within(pane).getByText(/all green/)).toBeTruthy();
  });

  it('renders nothing when the board holds no card for the bead', () => {
    mockApi(() => { throw Object.assign(new Error('unexpected'), { status: 500 }); });
    render(<TaskPane beadId="ov-404" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('fetches the full bead for a Done card: the card carries no description or notes, the pane shows them once the detail lands', async () => {
    const card = board.repos[0]!.cards.find((c) => c.bead.id === 'ov-7')!;
    const slimmer = { ...card, bead: { ...card.bead, description: '', notes: '' } };
    const slimBoard = { ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-7' ? slimmer : c)) })) };
    const full = { ...reviewDetail, bead: { ...card.bead, notes: 'Merged after verification.' }, sessions: [], worktree: null, last_assistant_text: null, diff: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-7')) return full;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TaskPane beadId="ov-7" board={slimBoard} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-7' });
    // What the daemon now puts on a Done card: the title and metadata, no description or notes.
    expect(slimmer.bead.description).toBe('');
    expect(slimmer.bead.notes).toBe('');
    // The pane fetches /tasks/ov-7 and shows both from the fetched bead.
    expect(await within(pane).findByText('Description of Done task')).toBeTruthy();
    expect(within(pane).getByText(/Merged after verification/)).toBeTruthy();
    expect(within(pane).getByText('History')).toBeTruthy();
  });

  it('shows "(no description)" and no History for a Done card whose fetched bead is empty', async () => {
    const card = board.repos[0]!.cards.find((c) => c.bead.id === 'ov-8')!;
    const slimmer = { ...card, bead: { ...card.bead, description: '', notes: '' } };
    const slimBoard = { ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-8' ? slimmer : c)) })) };
    const empty = { ...reviewDetail, bead: { ...card.bead, description: '', notes: '' }, sessions: [], worktree: null, last_assistant_text: null, diff: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-8')) return empty;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TaskPane beadId="ov-8" board={slimBoard} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-8' });
    await waitFor(() => expect(pane.getAttribute('aria-busy')).toBe('false')); // the detail has arrived
    expect(within(pane).getByText('(no description)')).toBeTruthy();
    expect(within(pane).queryByText('History')).toBeNull();
  });

  it('calls its owner on the close control and Escape wherever focus is', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-5')) return reviewDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onClose = vi.fn();
    render(<TaskPane beadId="ov-5" board={board} version={0} onSelect={noop} onClose={onClose} onOpenReview={noop} onOpenBatch={noop} />);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Close details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('opens the pane of a bead a blocked card waits on through onSelect', async () => {
    const detail = { ...reviewDetail, bead: { ...board.repos[0]!.cards[1]!.bead, dependency_count: 2 }, blocked_by: ['ov-1', 'ov-404'], worktree: null, sessions: [], last_assistant_text: null, diff: null };
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-2')) return detail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onSelect = vi.fn();
    render(<TaskPane beadId="ov-2" board={board} version={0} onSelect={onSelect} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const pane = await screen.findByRole('complementary', { name: 'Details of ov-2' });
    await waitFor(() => expect(within(pane).getByText(/Blocked: waits on/)).toBeTruthy());
    fireEvent.click(within(pane).getByRole('button', { name: 'ov-1' }));
    expect(onSelect).toHaveBeenCalledWith('ov-1');
    // A blocker with no card on the board is named, never offered as a link.
    expect(within(pane).queryByRole('button', { name: 'ov-404' })).toBeNull();
  });

  it('shows the action in progress on its button and disables the others before the request resolves', async () => {
    let release: () => void = () => {};
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/verify')) return new Promise<unknown>((r) => { release = () => r(accepted('verify')); });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} /><Toasts /></>);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
    expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect(disabled(p, 'Re-dispatch')).toBe(true);
    await act(async () => { release(); });
  });

  it('keeps the pending state after the 202 until the job ends, and a job that fails in the background brings the buttons back', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/verify')) return accepted('verify');
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
    await act(async () => {}); // the 202 has been read
    expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect(disabled(p, 'Re-dispatch')).toBe(true);
    expect(within(p).queryByRole('status')).toBeNull(); // no acknowledgement before the outcome
    // The board carries the job, then the card moves to Verifying for the run: the pressed button stays with its label.
    rerender(<TaskPane beadId="ov-6" board={withJob('job-verify')} version={1} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const verifying = { ...withJob('job-verify'), repos: withJob('job-verify').repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, state: 'verifying' as const, column: 'verifying' as const } : c)) })) };
    rerender(<TaskPane beadId="ov-6" board={verifying} version={2} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect(disabled(p, 'Re-dispatch')).toBe(true);
    // It failed: the card is where it was, the result ends the job and the buttons are back.
    endJob('verify', false);
    rerender(<TaskPane beadId="ov-6" board={withJob(null)} version={3} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    await waitFor(() => expect(disabled(p, 'Retry verification')).toBe(false));
    expect(disabled(p, 'Re-dispatch')).toBe(false);
    expect(within(p).queryByRole('status')).toBeNull();
  });

  it('acknowledges a job whose result arrived before any board carried it, and brings no stale pending state back', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/redispatch')) return accepted('redispatch');
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Re-dispatch' }));
    await act(async () => {}); // 202
    expect(within(p).getByRole('button', { name: 'Re-dispatching…' })).toBeTruthy();
    endJob('redispatch', true); // the result, with no board in between
    expect(within(p).getByRole('status').textContent).toBe('Re-dispatched; a new worker starts with the failed output in its instructions.');
    expect(within(p).queryByRole('button', { name: /Re-dispatch/ })).toBeNull();
  });

  it('keeps Stop worker reading Stopping… after the 202 until the job ends', async () => {
    const running = board.repos[0]!.cards[2]!;
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: running.bead, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', bead_id: 'ov-3', status: 'running', ended_at: null }] };
      if (method === 'POST' && url.endsWith('/api/tasks/ov-3/interrupt')) return { job_id: 'job-stop', action: 'interrupt', target: 'ov-3' };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TaskPane beadId="ov-3" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    fireEvent.click(await within(p).findByRole('button', { name: 'Stop worker' }));
    await act(async () => {}); // 202
    expect(disabled(p, 'Stopping…')).toBe(true);
    expect(within(p).queryByText(/Stop requested/)).toBeNull();
    act(() => { jobEnded({ job_id: 'job-stop', action: 'interrupt', target: 'ov-3', ok: true, message: null, data: null }); });
    expect(within(p).getByText(/Stop requested/)).toBeTruthy();
    expect(within(p).queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('keeps Retrying… on the pane opened afresh while the verification runs, from the board row alone', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    // A reload, or a pane reopened, mid-run: the card is in Verifying and its row carries the job.
    const verifying = { ...withJob('job-verify'), repos: withJob('job-verify').repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, state: 'verifying' as const, column: 'verifying' as const } : c)) })) };
    render(<TaskPane beadId="ov-6" board={verifying} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    await waitFor(() => expect(within(p).getByRole('heading', { name: /verification/i })).toBeTruthy()); // the detail has arrived
    expect(disabled(p, 'Retrying…')).toBe(true);
    expect(disabled(p, 'Re-dispatch')).toBe(true);
  });

  it('keeps Retrying… when the pane is closed and reopened during the run it started', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/verify')) return accepted('verify');
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const first = render(<TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    fireEvent.click(await within(await pane()).findByRole('button', { name: 'Retry verification' }));
    await act(async () => {}); // 202
    const verifying = { ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, state: 'verifying' as const, column: 'verifying' as const } : c)) })) };
    first.rerender(<TaskPane beadId="ov-6" board={verifying} version={1} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    first.unmount();
    render(<TaskPane beadId="ov-6" board={verifying} version={1} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    expect(disabled(p, 'Retrying…')).toBe(true);
    expect(disabled(p, 'Re-dispatch')).toBe(true);
    endJob('verify', false);
    expect(within(p).queryByRole('button', { name: 'Retrying…' })).toBeNull(); // the job ended: the offers follow the card again
  });

  it('keeps a 409 for another action pending under the running one', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST') throw Object.assign(new Error('verify is already running for ov-6'), { status: 409, body: { job_id: 'job-verify', action: 'verify' } });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Re-dispatch' }));
    await act(async () => {}); // the 409 has been read, before any board carries the job
    expect(disabled(p, 'Retrying…')).toBe(true);
    expect(within(p).queryByRole('button', { name: 'Re-dispatching…' })).toBeNull();
    expect(disabled(p, 'Re-dispatch')).toBe(true);
  });

  it('frees the buttons after a 409 once the running job ends, and a board without the job keeps them free', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST') throw Object.assign(new Error('verify is already running for ov-6'), { status: 409, body: { job_id: 'job-verify', action: 'verify' } });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
    await waitFor(() => expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy());
    await act(async () => {}); // the 409 has been read
    // The short job ended before any board carried it: its result frees the buttons.
    endJob('verify', true);
    expect(disabled(p, 'Retry verification')).toBe(false);
    rerender(<TaskPane beadId="ov-6" board={withJob(null)} version={1} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    expect(disabled(p, 'Retry verification')).toBe(false);
    expect(disabled(p, 'Re-dispatch')).toBe(false);
  });

  it('frees the buttons once the result of the job the board row carries arrives, while no newer board has come', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const stale = withJob('job-old');
    const { rerender } = render(<TaskPane beadId="ov-6" board={stale} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    const p = await pane();
    await waitFor(() => expect(disabled(p, 'Retrying…')).toBe(true));
    expect(disabled(p, 'Re-dispatch')).toBe(true);
    act(() => { jobEnded({ job_id: 'job-old', action: 'verify', target: 'ov-6', ok: false, message: 'exit 1', data: null }); });
    // The row still names the job, but its result is known: nothing runs.
    expect(within(p).queryByRole('button', { name: 'Retrying…' })).toBeNull();
    expect(disabled(p, 'Retry verification')).toBe(false);
    expect(disabled(p, 'Re-dispatch')).toBe(false);
    // A board event whose refetch failed: the app shell keeps the stale board, and the buttons stay free.
    rerender(<TaskPane beadId="ov-6" board={stale} version={1} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    expect(disabled(p, 'Retry verification')).toBe(false);
    expect(disabled(p, 'Re-dispatch')).toBe(false);
    // A row naming a newer job is a job that runs.
    rerender(<TaskPane beadId="ov-6" board={withJob('job-new')} version={2} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} />);
    expect(disabled(p, 'Retrying…')).toBe(true);
    expect(disabled(p, 'Re-dispatch')).toBe(true);
  });

  it('sends one request when an action is clicked twice in one tick', async () => {
    const posts: string[] = [];
    let release: () => void = () => {};
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST' && url.endsWith('/api/tasks/ov-6/redispatch')) { posts.push(url); return new Promise<unknown>((r) => { release = () => r({ ok: true }); }); }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} /><Toasts /></>);
    const button = await actionButton('Re-dispatch');
    await act(async () => { button.click(); button.click(); });
    await waitFor(() => expect(posts).toEqual(['/api/tasks/ov-6/redispatch']));
    await act(async () => { release(); });
  });

  it('toasts the running action and keeps the pending state on a 409', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST') throw Object.assign(new Error('verify is already running for ov-6'), { status: 409, body: { job_id: 'j1', action: 'verify' } });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} /><Toasts /></>);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
    expect((await screen.findByRole('alert')).textContent).toContain('verify is already running for ov-6');
    // The job is still running: the button keeps its pending label and the others stay off.
    expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    expect((within(p).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('toasts a validation refusal and restores the buttons on a 4xx', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
      if (method === 'POST') throw Object.assign(new Error('the branch of ov-6 has no commits to verify; re-dispatch it instead'), { status: 400 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<><TaskPane beadId="ov-6" board={board} version={0} onSelect={noop} onClose={noop} onOpenReview={noop} onOpenBatch={noop} /><Toasts /></>);
    const p = await pane();
    fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
    expect(((await screen.findByRole('alert')).querySelector('.toast-text') as HTMLElement).textContent).toBe('Could not retry the verification: the branch of ov-6 has no commits to verify; re-dispatch it instead');
    expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(p).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
