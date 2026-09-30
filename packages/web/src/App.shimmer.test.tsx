import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { App } from './App';
import { mockApi } from './test/setup';
import { board, chat, doctorOk, plans, repo, status } from './test/fixtures';
import { STRIP_ROWS_KEY } from './office/NeedsStrip';
import type { ChatRow } from '@overseer/shared';
import { drawnRoomProps } from './test/fakeOfficeScene';
import { PHONE_QUERY } from './lib/phoneLayout';

vi.mock('./office/pixi/scene', () => import('./test/fakeOfficeScene'));

const answers = (path: string): unknown => {
  if (path.endsWith('/api/repos')) return [repo];
  if (path.endsWith('/api/plans/all')) return plans;
  if (path.endsWith('/api/plans')) return plans.filter((p) => p.status === 'draft');
  if (path.startsWith('/api/chat')) return { rows: chat, has_more: false, oldest_id: null };
  if (path.endsWith('/api/status')) return status;
  if (path.endsWith('/api/daemon')) return { pid: 1, started_at: 't', commit: 'a', source_head: 'a', restart_needed: false };
  if (path.endsWith('/api/doctor')) return doctorOk;
  if (path.endsWith('/api/board')) return board;
  if (path.endsWith('/api/costs')) return { repos: [], batches: [] };
  return {};
};

// The phone count row shimmers too, so the strip's own shimmer is read inside the strip.
const strip = () => within(document.querySelector<HTMLElement>('.office-needs')!);

describe('App shimmer gate', () => {
  it('shimmers the Office strip while its fetches are in flight and shows the real list once they land', async () => {
    const held: (() => void)[] = [];
    // Board, chat, plans and repos are the four strip inputs; each is answered only when the test releases it.
    const slow = new Set(['/api/board', '/api/chat', '/api/plans', '/api/repos']);
    mockApi((_m, url) => {
      const answer = answers(url);
      if (![...slow].some((s) => url.startsWith(s))) return answer;
      return new Promise((resolve) => held.push(() => resolve(answer)));
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    const shimmer = await strip().findByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Nothing needs you.')).toBeNull(); // the false answer the shimmer replaces
    expect(screen.queryByText('No draft plans')).toBeNull();

    await act(async () => { held.forEach((release) => release()); });
    await waitFor(() => expect(strip().queryByTestId('shimmer')).toBeNull());
    expect(screen.getByText('1 draft plan')).toBeTruthy();
  });

  it('stops the Office strip shimmer once a fetch it waits on has failed, rather than shimmering for the whole outage', async () => {
    mockApi((_m, url) => { if (url.endsWith('/api/board')) throw Object.assign(new Error('boom'), { status: 500 }); return answers(url); });
    history.replaceState(null, '', '#office');
    render(<App />);
    await screen.findByText(/Could not load \/api\/board/);
    expect(strip().queryByTestId('shimmer')).toBeNull();
  });

  it('keeps the Office strip shimmer while an endpoint it does not wait on fails', async () => {
    const held: (() => void)[] = [];
    mockApi((_m, url) => {
      if (url.endsWith('/api/costs')) throw Object.assign(new Error('boom'), { status: 500 });
      if (url.startsWith('/api/board')) return new Promise((resolve) => held.push(() => resolve(answers(url))));
      return answers(url);
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    await screen.findByText(/Could not load \/api\/costs/);
    // /board is still in flight, so the strip is still unknown: the shimmer must outlive the unrelated failure.
    expect(strip().getByTestId('shimmer').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Nothing needs you.')).toBeNull();

    await act(async () => { held.forEach((release) => release()); });
    await waitFor(() => expect(strip().queryByTestId('shimmer')).toBeNull());
  });

  it('stops the Plans shimmer once the plan list fetch has failed', async () => {
    mockApi((_m, url) => { if (url.endsWith('/api/plans/all')) throw Object.assign(new Error('boom'), { status: 500 }); return answers(url); });
    history.replaceState(null, '', '#plan');
    render(<App />);
    await screen.findByText(/Could not load \/api\/plans\/all/);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByText('No plans yet.')).toBeTruthy();
  });

  it.each([0, 1, 5])('stores the %i item rows the Office strip loaded with, over an older stored count', async (n) => {
    localStorage.setItem(STRIP_ROWS_KEY, '3');
    // An empty board and no draft plans, so the strip's items are exactly the n open questions.
    const questions: ChatRow[] = Array.from({ length: n }, (_, i) => ({ ...chat[2]!, id: 10 + i, text: `Question ${i + 1}?` }));
    mockApi((_m, url) => {
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.startsWith('/api/chat')) return { rows: questions, has_more: false, oldest_id: null };
      return answers(url);
    });
    history.replaceState(null, '', '#office');
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('No draft plans')).toBeTruthy());
    await waitFor(() => expect({ rows: container.querySelectorAll('[data-testid="needs-strip"] .needs-row').length, stored: localStorage.getItem(STRIP_ROWS_KEY) }).toEqual({ rows: n, stored: String(n) }));
  });

  it('shows the Office strip capped again after it was expanded and the user left Office and came back', async () => {
    const questions: ChatRow[] = Array.from({ length: 7 }, (_, i) => ({ ...chat[2]!, id: 10 + i, text: `Question ${i + 1}?` }));
    mockApi((_m, url) => {
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.startsWith('/api/chat')) return { rows: questions, has_more: false, oldest_id: null };
      return answers(url);
    });
    history.replaceState(null, '', '#office');
    const { container } = render(<App />);
    const rows = () => container.querySelectorAll('[data-testid="needs-strip"] .needs-row').length;
    fireEvent.click(await screen.findByRole('button', { name: '+1 more' }));
    expect(rows()).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await waitFor(() => expect(location.hash).toBe('#chat'));
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));
    await waitFor(() => expect(location.hash).toBe('#office'));
    expect(rows()).toBe(6);
    expect(screen.getByRole('button', { name: '+1 more' })).toBeTruthy();
  });

  // What each object's button carries on desktop: its hover chip and its accessible name.
  const objects = () => [...document.querySelectorAll<HTMLElement>('.office-room-prop')].map((prop) => ({ chip: prop.textContent, name: prop.getAttribute('aria-label') }));

  it('draws no count and names no digit on the room objects while their fetches are in flight, then the real counts', async () => {
    const held: (() => void)[] = [];
    const slow = new Set(['/api/board', '/api/chat', '/api/plans', '/api/repos']);
    mockApi((_m, url) => {
      const answer = answers(url);
      if (![...slow].some((s) => url.startsWith(s))) return answer;
      return new Promise((resolve) => held.push(() => resolve(answer)));
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    await strip().findByTestId('shimmer');
    await waitFor(() => expect(drawnRoomProps()).toBeTruthy());
    expect({ objects: objects(), drawn: drawnRoomProps() }).toEqual({
      objects: [
        { chip: 'Questions', name: 'Open Chat, questions loading' },
        { chip: 'In review', name: 'Open Review, batches in review loading' },
        { chip: 'Board', name: 'Open Board, columns loading' },
      ],
      drawn: { questions: null, reviewBatches: null, columns: null, reviewReady: null },
    });

    await act(async () => { held.forEach((release) => release()); });
    await waitFor(() => expect(strip().queryByTestId('shimmer')).toBeNull());
    const cards = board.repos.flatMap((r) => r.cards);
    const column = (key: string) => cards.filter((c) => c.column === key).length;
    const review = document.querySelectorAll('[data-testid="needs-strip"] [data-kind="batch"]').length;
    expect(objects().map(({ chip }) => chip)).toEqual([
      '1 Questions', `${review} In review`,
      `Ready ${column('ready')} · Blocked ${column('blocked')} · Running ${column('running')} · Verifying ${column('verifying')} · Review ${column('review')} · Done today 0`,
    ]);
    expect({ questions: drawnRoomProps()?.questions, reviewBatches: drawnRoomProps()?.reviewBatches?.length, ready: drawnRoomProps()?.columns?.ready.length })
      .toEqual({ questions: 1, reviewBatches: review, ready: column('ready') });
  });

  it('shimmers every number of the phone count row while its fetches are in flight, then shows the counts', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const held: (() => void)[] = [];
    const slow = new Set(['/api/board', '/api/chat', '/api/plans', '/api/repos']);
    mockApi((_m, url) => {
      const answer = answers(url);
      if (![...slow].some((s) => url.startsWith(s))) return answer;
      return new Promise((resolve) => held.push(() => resolve(answer)));
    });
    history.replaceState(null, '', '#office');
    const { container } = render(<App />);
    await strip().findByTestId('shimmer');
    // What each count reads outside its shimmer (nothing), and whether it shimmers.
    const read = () => [...container.querySelectorAll<HTMLElement>('.office-count')].map((count) => ({
      text: [...count.childNodes].filter((node) => !(node instanceof HTMLElement && node.dataset.testid === 'shimmer')).map((node) => node.textContent).join('').trim(),
      shimmer: count.querySelector('[data-testid="shimmer"]') !== null,
    }));
    expect(read()).toEqual(Array.from({ length: 8 }, () => ({ text: '', shimmer: true })));
    expect(container.querySelector<HTMLElement>('.office-count[data-office-count="done"]')?.title).toBe('Open Board, Done today: loading');

    await act(async () => { held.forEach((release) => release()); });
    await waitFor(() => expect(strip().queryByTestId('shimmer')).toBeNull());
    const cards = board.repos.flatMap((r) => r.cards);
    const column = (key: string) => String(key === 'done' ? 0 : cards.filter((c) => c.column === key).length);
    const review = String(container.querySelectorAll('[data-testid="needs-strip"] [data-kind="batch"]').length);
    await waitFor(() => expect(read().map(({ text }) => text)).toEqual(['1', review, column('ready'), column('blocked'), column('running'), column('verifying'), column('review'), column('done')]));
    expect(container.querySelector<HTMLElement>('.office-count[data-office-count="done"]')?.title).toBe('Open Board, Done today: 0');
    vi.unstubAllGlobals();
  });

  // What the In review object's button names and its chip reads.
  const reviewProp = () => {
    const prop = document.querySelector<HTMLElement>('[data-office-prop="review"]')!;
    return { chip: prop.textContent, name: prop.getAttribute('aria-label') };
  };
  // One batch in review, so the arrived count (1) cannot be mistaken for the false 0 the object used to show.
  const reviewBoard = { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, status: 'review' as const }] }] };

  it('keeps the In review object without a count while /board is in flight even after the other strip fetches fail, then shows its count', async () => {
    const held: (() => void)[] = [];
    mockApi((_m, url) => {
      if (url.endsWith('/api/plans') || url.endsWith('/api/repos') || url.startsWith('/api/chat')) throw Object.assign(new Error('boom'), { status: 500 });
      if (url.startsWith('/api/board')) return new Promise((resolve) => held.push(() => resolve(reviewBoard)));
      return answers(url);
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    await screen.findByText(/Could not load \/api\/(plans|repos|chat)/);
    await waitFor(() => expect(strip().queryByTestId('shimmer')).toBeNull()); // the strip's own gate has stopped
    expect({ ...reviewProp(), drawn: drawnRoomProps()?.reviewBatches }).toEqual({ chip: 'In review', name: 'Open Review, batches in review loading', drawn: null });

    await act(async () => { held.forEach((release) => release()); });
    await waitFor(() => expect({ ...reviewProp(), drawn: drawnRoomProps()?.reviewBatches }).toEqual({ chip: '1 In review', name: 'Open Review, 1 batch in review', drawn: ['r1/r1-b1'] }));
  });

  it('shows the In review count once /board lands while the other strip fetches are still in flight', async () => {
    mockApi((_m, url) => {
      if (url.endsWith('/api/plans') || url.endsWith('/api/repos') || url.startsWith('/api/chat')) return new Promise(() => {});
      return url.endsWith('/api/board') ? reviewBoard : answers(url);
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    await waitFor(() => expect(reviewProp()).toEqual({ chip: '1 In review', name: 'Open Review, 1 batch in review' }));
    expect(strip().getByTestId('shimmer').getAttribute('aria-busy')).toBe('true'); // the strip still waits on the rest
  });

  // The meeting table counts every Board batch in review, while the Review tab badge keeps counting the ones the user reviews.
  describe('meeting-table folders', () => {
    const inReview = board.repos[0]!.batches[0]!;
    const withBatches = (batches: (typeof inReview)[], approver: 'user' | 'orchestrator' = 'user') =>
      ({ ...board, repos: [{ ...board.repos[0]!, repo: { ...board.repos[0]!.repo, batch_approver: approver }, batches }] });
    const load = async (shown: typeof board) => {
      mockApi((_m, url) => (url.endsWith('/api/board') ? shown : answers(url)));
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(drawnRoomProps()?.columns).toBeTruthy());
    };
    const reviewTab = () => document.querySelector('.rail [data-view="review"]')!.getAttribute('aria-label');

    it('draws a folder for a batch in review that waits on another batch', async () => {
      await load(withBatches([{ ...inReview, id: 'r1-held', status: 'review', waiting_on: 'r1-b9' }]));
      expect(drawnRoomProps()?.reviewBatches).toEqual(['r1/r1-held']);
    });
    it('draws a folder for a batch in review in a repository whose orchestrator merges without asking', async () => {
      await load(withBatches([{ ...inReview, id: 'r1-auto', status: 'review' }], 'orchestrator'));
      expect(drawnRoomProps()?.reviewBatches).toEqual(['r1/r1-auto']);
    });
    it('draws no folder when no batch is in review', async () => {
      await load(withBatches([{ ...inReview, status: 'open' }]));
      expect(drawnRoomProps()?.reviewBatches).toEqual([]);
    });
    it('labels ready and waiting separately while the Office strip lists both review rows', async () => {
      await load(withBatches([
        { ...inReview, id: 'r1-mine', status: 'review' },
        { ...inReview, id: 'r1-held', status: 'review', waiting_on: 'r1-mine' },
        { ...inReview, id: 'r1-open', status: 'open' },
      ]));
      expect({ folders: drawnRoomProps()?.reviewBatches, tab: reviewTab() }).toEqual({ folders: ['r1/r1-mine', 'r1/r1-held'], tab: 'Review, 1 ready for review, 1 waiting' });
    });
  });
});
