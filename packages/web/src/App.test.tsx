import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { BatchStatus, BoardResponse, ChatRow, CostsResponse, DoctorResponse, Plan as PlanT, ProgramDetail, Repo, RepoCommand, UsageResponse, WsMessage } from '@overseer/shared';
import { App, EVENT_REFRESH_MS, REFRESH_NOTE_MS } from './App';
import { api } from './api';
import { mockApi, lastSocket } from './test/setup';
import { batchDetail, board, chat, defaultTiers, discussionDetail, discussionSummary, doctorBad, doctorOk, repo, reviewDetail, status } from './test/fixtures';
import { drawnOfficeAgent, drawnOfficeAtDesk, drawnOfficeEffects, drawnRoomProps, officeFrames, officeLoop } from './test/fakeOfficeScene';
import { RoomPropsAnimator } from './office/pixi/roomProps';
import { PHONE_QUERY } from './lib/phoneLayout';

vi.mock('./office/pixi/scene', () => import('./test/fakeOfficeScene'));

function linkedBoard(batchStatus: BatchStatus): BoardResponse {
  const batch = board.repos[0]!.batches[0]!;
  return { ...board, repos: [{ ...board.repos[0]!, batches: [{ ...batch, origin_chat_id: chat[0]!.id, linked_chat_ids: [chat[0]!.id], status: batchStatus }] }] };
}

function mockApp(boardResponse: BoardResponse | (() => BoardResponse), rows: ChatRow[] | (() => ChatRow[]) = chat, commands: RepoCommand[] = [], options: { repos?: Repo[]; plans?: PlanT[]; costs?: CostsResponse; programs?: () => ProgramDetail[]; boardRequest?: () => unknown } = {}): string[] {
  const getBoard = () => typeof boardResponse === 'function' ? boardResponse() : boardResponse;
  const commandRequests: string[] = [];
  mockApi((_method, url) => {
    if (url.endsWith('/api/repos')) return options.repos ?? [repo];
    if (url.endsWith('/commands')) { commandRequests.push(url); return commands; }
    if (url.endsWith('/api/doctor')) return doctorOk;
    if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
    if (url.endsWith('/api/settings/tiers')) return defaultTiers;
    if (url.endsWith('/api/status')) return status;
    if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-24T00:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
    if (url.endsWith('/api/board')) return options.boardRequest ? options.boardRequest() : getBoard();
    if (url.startsWith('/api/chat')) {
      const pageRows = typeof rows === 'function' ? rows() : rows;
      return { rows: pageRows, has_more: false, oldest_id: pageRows[0]?.id ?? null };
    }
    if (url.includes('/api/tasks/')) {
      const id = url.split('/').at(-1);
      const card = getBoard().repos.flatMap((r) => r.cards).find((c) => c.bead.id === id);
      return { ...reviewDetail, bead: card?.bead ?? reviewDetail.bead, blocked_by: id === 'ov-2' ? ['ov-1'] : [] };
    }
    if (/\/api\/batches\/[^/]+$/.test(url)) {
      const id = url.split('/').at(-1);
      const selected = getBoard().repos.flatMap((r) => r.batches).find((b) => b.id === id);
      return selected ? { ...batchDetail, batch: selected } : batchDetail;
    }
    if (url.endsWith('/api/costs')) return options.costs ?? { repos: [], batches: [] };
    if (url.endsWith('/api/plans') || url.endsWith('/api/plans/all')) return options.plans ?? [];
    if (url === '/api/programs') return options.programs?.() ?? [];
    if (url.startsWith('/api/programs/')) return options.programs?.().find((p) => url.endsWith(`/${p.id}`));
    if (url.startsWith('/api/usage')) return emptyUsage;
    if (url === '/api/evidence') return [];
    if (url.startsWith('/api/evidence/')) return { files: [], total: 0, next_offset: null };
    throw new Error(`unexpected ${url}`);
  });
  return commandRequests;
}

const commandEntry = (name: string): RepoCommand => ({ name, description: 'Test command', kind: 'command', source: 'repo' });

const emptyUsage: UsageResponse = {
  from: '2026-08-26', to: '2026-09-24',
  totals: { sessions: 0, reported_cost: 0, reported_unknown: 0, estimated_cost: 0, estimated_unknown: 0, codex_sessions: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } },
  days: [], groups: { model: [], account: [], harness: [], repo: [] }, days_by_model: [],
};

const officeMilestone = (kind: Extract<WsMessage, { type: 'office_milestone' }>['kind']): Extract<WsMessage, { type: 'office_milestone' }> => ({
  type: 'office_milestone', kind, repo_id: 'r2', batch_id: 'r2-b4', bead_id: 'ov-9', at: '2026-09-25T12:00:00.000Z',
});

function withDecision(boardResponse: BoardResponse): BoardResponse {
  return { ...boardResponse, repos: boardResponse.repos.map((r) => ({ ...r, cards: r.cards.map((card) => card.bead.id === 'ov-2' ? { ...card, state: 'awaiting_decision' } : card) })) };
}

function withDoneClosedAt(boardResponse: BoardResponse, closedAt: (string | null)[]): BoardResponse {
  let index = 0;
  return { ...boardResponse, repos: boardResponse.repos.map((r) => ({ ...r, cards: r.cards.map((card) => card.column === 'done'
    ? { ...card, bead: { ...card.bead, closed_at: closedAt[index++] ?? null } }
    : card) })) };
}

const localClosedAt = (day: number, hour: number, minute: number, second = 0) => new Date(2030, 0, day, hour, minute, second).toISOString();

const needsQuestions = (): ChatRow[] => ['Question A?', 'Question B?', 'Question C?'].map((text, index) => ({ ...chat[2]!, id: 101 + index, text }));

function questionState() {
  const activeQuestion = document.querySelector('.question-page-active .question-text')?.textContent ?? null;
  const activeAnswer = document.querySelector('.question-page-active textarea[aria-label="Your answer"]');
  return {
    pager: screen.queryByText(/^Question \d+ of \d+$/)?.textContent ?? null,
    activeQuestion,
    answerFocused: document.activeElement === activeAnswer,
    office: screen.getByRole('button', { name: /^Office/ }).getAttribute('aria-current') === 'page',
    chat: screen.getByRole('button', { name: /^Chat/ }).getAttribute('aria-current') === 'page',
    docked: document.querySelector('.office-chat-dock') !== null,
    error: screen.queryByText(/Could not load the thread/)?.textContent ?? null,
  };
}

function rect(width: number, height: number): DOMRect {
  return { width, height, x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
}

function measuredOfficeForDock(contentWidth = 1580, stageWidth = 1200): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  const measurement = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('office')) return rect(contentWidth, 900);
    if (this.classList.contains('office-stage')) return rect(stageWidth, stageWidth * 1056 / 1680);
    return original.call(this);
  });
  return () => measurement.mockRestore();
}

describe('App', () => {
  it('shows a 2.5-second board response while socket reloads keep arriving every second', async () => {
    vi.useFakeTimers();
    let boardCalls = 0;
    const getSpy = vi.spyOn(api, 'get');
    mockApp(board, chat, [], { boardRequest: () => {
      boardCalls += 1;
      return new Promise((resolve) => setTimeout(() => resolve(board), 2500));
    } });
    history.replaceState(null, '', '#office');
    let unmount: (() => void) | undefined;
    try {
      unmount = render(<App />).unmount;
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      for (const untilNextEvent of [1000, 700]) {
        await act(async () => { await vi.advanceTimersByTimeAsync(untilNextEvent); });
        act(() => lastSocket().push({ type: 'board' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(boardCalls).toBe(1); // neither one-second trigger overlaps the 2.5-second request
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(within(document.querySelector('.office-needs')!).queryByTestId('shimmer')).toBeNull(); // the board answered at 2.5 s despite repeated reload triggers
      expect(boardCalls).toBe(2); // the triggers coalesced into one trailing reload
      expect(getSpy.mock.calls.filter(([path]) => path === '/board').map(([, opts]) => opts?.fresh ?? false)).toEqual([false, true]);
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(boardCalls).toBe(2);
      expect(within(document.querySelector('.office-needs')!).queryByTestId('shimmer')).toBeNull();
    } finally {
      unmount?.();
      getSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the mascot accessible name in the app rail', async () => {
    mockApp(board);
    history.replaceState(null, '', '/');
    render(<App />);
    await screen.findByTestId('needs-strip');
    expect(screen.getByRole('img', { name: /^orchestrator:/ }).getAttribute('aria-label')).toMatch(/^orchestrator: /);
  });

  it('opens Office by default with the needs-you count still in the tab title', async () => {
    mockApp(board);
    history.replaceState(null, '', '/');
    render(<App />);
    await screen.findByTestId('needs-strip');
    await waitFor(() => expect(location.hash).toBe('#office'));
    expect(screen.getByRole('button', { name: 'Office' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(document.title).toBe('(2) Overseer'));
  });

  it('redirects an old #needs load or revisit to #office and shows the Office strip', async () => {
    mockApp(board);
    history.replaceState(null, '', '#needs');
    render(<App />);
    await screen.findByTestId('needs-strip');
    await waitFor(() => expect(location.hash).toBe('#office'));
    act(() => { location.hash = '#needs'; });
    await waitFor(() => expect(location.hash).toBe('#office'));
    expect(screen.getByRole('button', { name: 'Office' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: /^Needs/ })).toBeNull();
  });

  it('waits for focus before opening suggestions for a restored slash draft', async () => {
    const commandRequests = mockApp(board, chat, [commandEntry('foo')]);
    history.replaceState(null, '', '#chat');
    localStorage.setItem('overseer.chatRepo', 'r1');
    localStorage.setItem('overseer.chatDraft.r1', '/foo');
    render(<App />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    await waitFor(() => expect((screen.getByLabelText('Repo') as HTMLSelectElement).value).toBe('r1'));
    expect([input.value, screen.queryByRole('listbox'), commandRequests]).toEqual(['/foo', null, []]);
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    await screen.findByRole('listbox', { name: 'Chat command suggestions' });
    expect(commandRequests).toEqual(['/api/repos/r1/commands']);
  });

  it('uses one Escape to close Chat suggestions before the open outcome panel', async () => {
    mockApp(linkedBoard('open'), chat, [commandEntry('foo')]);
    history.replaceState(null, '', '#chat');
    localStorage.setItem('overseer.chatRepo', 'r1');
    render(<App />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/foo' } });
    await screen.findByRole('listbox', { name: 'Chat command suggestions' });
    fireEvent.click(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' }));
    const panelName = 'Batch details for r1-b1';
    await screen.findByRole('complementary', { name: panelName });
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    fireEvent.select(input);
    await screen.findByRole('listbox', { name: 'Chat command suggestions' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect([screen.queryByRole('listbox'), screen.queryByRole('complementary', { name: panelName }) !== null]).toEqual([null, true]);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: panelName })).toBeNull();
  });

  it.each([
    ['open', 'in progress'], ['review', 'in review'], ['merged', 'merged'], ['abandoned', 'abandoned'],
  ] as const)('opens a %s Chat outcome in place', async (batchStatus, label) => {
    mockApp(linkedBoard(batchStatus));
    history.replaceState(null, '', '#chat');
    render(<App />);
    const chip = await screen.findByRole('button', { name: `#9310 Trend chart: ${label}` });
    fireEvent.click(chip);
    expect(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' })).toBeTruthy();
    expect(location.hash).toBe('#chat');
  });

  it('opens the docked Chat outcome in place in Office', async () => {
    const restoreMeasure = measuredOfficeForDock();
    mockApp(linkedBoard('merged'));
    history.replaceState(null, '', '#office');
    try {
      render(<App />);
      const dock = await waitFor(() => {
        const element = document.querySelector('.office-chat-dock');
        if (!element) throw new Error('Office Chat dock did not mount');
        return element;
      });
      fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: '#9310 Trend chart: merged' }));
      expect(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' })).toBeTruthy();
      expect(location.hash).toBe('#office');
      expect(document.querySelector('.office-chat-dock')).toBeTruthy();
    } finally {
      restoreMeasure();
    }
  });

  it.each([
    { kind: 'failed', boardResponse: board, row: 'verification: Failed task', beadId: 'ov-6' },
    { kind: 'decision', boardResponse: withDecision(board), row: 'decision: Blocked task', beadId: 'ov-2' },
  ])('opens a $kind Office strip item in its TaskPane without leaving Office', async ({ boardResponse, row, beadId }) => {
    mockApp(boardResponse);
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: row }));
    expect(await screen.findByRole('complementary', { name: `Details of ${beadId}` })).toBeTruthy();
    expect(location.hash).toBe('#office');
  });

  it('switches an Office strip TaskPane to its batch panel without leaving Office', async () => {
    mockApp(board);
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'verification: Failed task' }));
    const taskPane = await screen.findByRole('complementary', { name: 'Details of ov-6' });
    fireEvent.click(await within(taskPane).findByRole('button', { name: 'Open batch r1-b1' }));
    expect(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Details of ov-6' })).toBeNull();
    expect(location.hash).toBe('#office');
  });

  it('routes an Office strip question to Chat', async () => {
    mockApp(board);
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'question: Should the endpoint require auth?' }));
    await waitFor(() => expect(location.hash).toBe('#chat'));
    expect(await screen.findByText('Should the endpoint require auth?', { selector: '.question-text' })).toBeTruthy();
  });

  it('opens a Needs batch in its drawer and stays on Office', async () => {
    mockApp(linkedBoard('review'));
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'batch: #9310 Trend chart' }));
    await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    expect([location.hash, screen.getByRole('button', { name: 'Office' }).getAttribute('aria-current')]).toEqual(['#office', 'page']);
  });

  it('shows a gone line when an Office strip task disappears from the board', async () => {
    let currentBoard = board;
    mockApp(() => currentBoard);
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'verification: Failed task' }));
    await screen.findByRole('complementary', { name: 'Details of ov-6' });
    currentBoard = { ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.filter((card) => card.bead.id !== 'ov-6') })) };
    act(() => lastSocket().push({ type: 'board' }));
    expect(await screen.findByText('Task ov-6 is no longer on the board.', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('routes an Office strip repository to Setup at Repositories', async () => {
    mockApp(board, chat, [], { repos: [{ ...repo, verify_suspect: 2 }] });
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'paused: Verify command fails on main' }));
    await waitFor(() => expect(location.hash).toBe('#setup'));
    expect(await screen.findByRole('heading', { name: /^Repositories/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Repositories' }).getAttribute('aria-selected')).toBe('true');
  });

  it('excludes Done cards without closed_at and keeps them on the Board', async () => {
    const costData: CostsResponse = { repos: [{ repo_id: 'r1', total: 10, today: 2.34, unknown: 0 }], batches: [] };
    const served = linkedBoard('review');
    mockApp(served, chat, [], { costs: costData });
    history.replaceState(null, '', '#office');
    render(<App />);

    const cards = served.repos.flatMap((r) => r.cards);
    const count = (key: string) => cards.filter((c) => c.column === key).length;
    const boardName = `Open Board, Ready: ${count('ready')}, Blocked: ${count('blocked')}, Running: ${count('running')}, Verifying: ${count('verifying')}, Review: ${count('review')}, Done today: 0`;
    await screen.findByRole('button', { name: 'Open Chat, 1 question' });
    const group = within(document.querySelector('.office-room-props') as HTMLElement);
    expect(group.getAllByRole('button').map((button) => ({ name: button.getAttribute('aria-label'), native: button.tagName === 'BUTTON' && button.getAttribute('type') === 'button' }))).toEqual([
      { name: 'Open Chat, 1 question', native: true }, { name: 'Open Review, 1 batch in review', native: true }, { name: boardName, native: true },
    ]);
    expect(document.querySelectorAll('.office-props-layer, .office-prop')).toHaveLength(0);
    expect(drawnRoomProps()?.columns?.ready).toEqual(served.repos.flatMap((r) => r.cards.filter((c) => c.column === 'ready').map((c) => `${r.repo.id}/${c.bead.id}`)));
    const drawn = drawnRoomProps()!;
    const animator = new RoomPropsAnimator();
    animator.update(drawn, 0);
    expect({
      doneIds: drawn.columns?.done,
      doneNotes: animator.items(0, true).filter((item) => 'texture' in item.paint && item.paint.texture === 'props/note-done').length,
    }).toEqual({ doneIds: [], doneNotes: 0 });

    fireEvent.click(screen.getByRole('button', { name: 'Open Chat, 1 question' }));
    await waitFor(() => expect(location.hash).toBe('#chat'));
    expect(await screen.findByText('Should the endpoint require auth?', { selector: '.question-text' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Office' }));
    await waitFor(() => expect(location.hash).toBe('#office'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Review, 1 batch in review' }));
    await waitFor(() => expect(location.hash).toBe('#review'));
    expect(await screen.findByRole('heading', { name: '#9310 Trend chart' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Office' }));
    await waitFor(() => expect(location.hash).toBe('#office'));
    fireEvent.click(screen.getByRole('button', { name: boardName }));
    await waitFor(() => expect(location.hash).toBe('#board'));
    fireEvent.click(screen.getByRole('tab', { name: /^Done/ }));
    expect(await screen.findByText('Done task')).toBeTruthy();
    expect(screen.getByText('Abandoned task')).toBeTruthy();
  });

  it('counts the local midnight boundary inclusively and excludes the previous second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 15, 12));
    let unmount: (() => void) | undefined;
    try {
      const served = withDoneClosedAt(board, [localClosedAt(14, 23, 59, 59), localClosedAt(15, 0, 0)]);
      mockApp(served);
      history.replaceState(null, '', '#office');
      unmount = render(<App />).unmount;
      await vi.waitFor(() => expect(drawnRoomProps()?.columns?.done).toEqual(['r1/ov-8']));
      expect({
        label: screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label'),
        doneIds: drawnRoomProps()?.columns?.done,
      }).toEqual({
        label: 'Open Board, Ready: 2, Blocked: 1, Running: 1, Verifying: 1, Review: 1, Done today: 1',
        doneIds: ['r1/ov-8'],
      });
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('adds a task closed today after the board refreshes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 15, 12));
    let unmount: (() => void) | undefined;
    try {
      let served = withDoneClosedAt(board, [null, null]);
      mockApp(() => served);
      history.replaceState(null, '', '#office');
      unmount = render(<App />).unmount;
      await vi.waitFor(() => expect(drawnRoomProps()?.columns?.done).toEqual([]));
      const prior = served.repos[0]!.cards.find((card) => card.bead.id === 'ov-7')!;
      const newTask = { ...prior, bead: { ...prior.bead, id: 'ov-new', title: 'Newly done task', closed_at: localClosedAt(15, 11, 59) } };
      served = { ...served, repos: served.repos.map((r) => ({ ...r, cards: [...r.cards, newTask] })) };
      act(() => lastSocket().push({ type: 'board' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await vi.waitFor(() => expect(drawnRoomProps()?.columns?.done).toEqual(['r1/ov-new']));
      expect(screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label')).toBe('Open Board, Ready: 2, Blocked: 1, Running: 1, Verifying: 1, Review: 1, Done today: 1');
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('drops yesterday\'s Done cards at local midnight without refreshing the board', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 15, 23, 59, 59));
    let unmount: (() => void) | undefined;
    try {
      let boardRequests = 0;
      mockApp(() => { boardRequests += 1; return withDoneClosedAt(board, [localClosedAt(15, 23, 59, 59), null]); });
      history.replaceState(null, '', '#office');
      unmount = render(<App />).unmount;
      await vi.waitFor(() => expect(drawnRoomProps()?.columns?.done).toEqual(['r1/ov-7']));
      const before = screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label');
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      const after = screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label');
      const doneIds = drawnRoomProps()?.columns?.done;
      unmount?.();
      unmount = undefined;
      expect({ before, after, doneIds, boardRequests, timersAfterUnmount: vi.getTimerCount() }).toEqual({
        before: 'Open Board, Ready: 2, Blocked: 1, Running: 1, Verifying: 1, Review: 1, Done today: 1',
        after: 'Open Board, Ready: 2, Blocked: 1, Running: 1, Verifying: 1, Review: 1, Done today: 0',
        doneIds: [],
        boardRequests: 1,
        timersAfterUnmount: 0,
      });
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('rechecks Done today when the tab becomes visible after midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 14, 23, 45));
    let unmount: (() => void) | undefined;
    try {
      let served = withDoneClosedAt(board, [localClosedAt(14, 23, 30), null]);
      mockApp(() => served);
      history.replaceState(null, '', '#office');
      unmount = render(<App />).unmount;
      await vi.waitFor(() => expect(drawnRoomProps()?.columns?.done).toEqual(['r1/ov-7']));
      expect(screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label')).toContain('Done today: 1');

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(drawnRoomProps()?.columns?.done).toEqual(['r1/ov-7']);

      vi.setSystemTime(new Date(2030, 0, 15, 8));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(drawnRoomProps()?.columns?.done).toEqual([]);
      expect(screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label')).toContain('Done today: 0');

      served = withDoneClosedAt(board, [localClosedAt(14, 23, 30), localClosedAt(15, 0, 15)]);
      act(() => lastSocket().push({ type: 'board' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(drawnRoomProps()?.columns?.done).toEqual(['r1/ov-8']);
      expect(screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label')).toContain('Done today: 1');
    } finally {
      unmount?.();
      vi.useRealTimers();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    }
  });

  it('keeps duplicate Done ids distinct and caps Done today at 99+ and ten notes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 15, 12));
    let unmount: (() => void) | undefined;
    try {
      const second: Repo = { ...repo, id: 'r2', path: 'E:/Projects/second' };
      const firstRepo = board.repos[0]!;
      const doneTemplate = firstRepo.cards.find((card) => card.bead.id === 'ov-7')!;
      const abandonedTemplate = firstRepo.cards.find((card) => card.bead.id === 'ov-8')!;
      const closedToday = localClosedAt(15, 11, 59);
      const doneTasks = Array.from({ length: 100 }, (_, index) => {
        const template = index === 0 ? abandonedTemplate : doneTemplate;
        return { ...template, bead: { ...template.bead, id: `ov-day-${index}`, title: `Done today ${index}`, closed_at: closedToday } };
      });
      const duplicate = { ...doneTasks[0]!, repo_id: 'r2' };
      const served: BoardResponse = {
        ...board,
        repos: [
          { ...firstRepo, cards: [...firstRepo.cards.filter((card) => card.column !== 'done'), ...doneTasks] },
          { repo: second, batches: [], cards: [duplicate] },
        ],
      };
      mockApp(served, chat, [], { repos: [repo, second] });
      history.replaceState(null, '', '#office');
      unmount = render(<App />).unmount;
      await vi.waitFor(() => expect(drawnRoomProps()?.columns?.done).toHaveLength(101));
      const drawn = drawnRoomProps()!;
      const animator = new RoomPropsAnimator();
      animator.update(drawn, 0);
      const items = animator.items(0, true);
      const doneNotes = items.filter((item) => item.key.startsWith('note-') && 'texture' in item.paint && item.paint.texture === 'props/note-done');
      const header = items.find((item) => item.key === 'header-done')?.paint;
      expect({
        repeatedId: drawn.columns!.done.filter((key) => key.endsWith('/ov-day-0')),
        doneCount: drawn.columns!.done.length,
        labels: screen.getByRole('button', { name: /^Open Board,/ }).getAttribute('aria-label'),
        noteCount: doneNotes.length,
        header: header && 'marker' in header ? [header.marker, header.zero] : null,
        includesAbandoned: drawn.columns!.done.includes('r1/ov-day-0'),
      }).toEqual({
        repeatedId: ['r1/ov-day-0', 'r2/ov-day-0'],
        doneCount: 101,
        labels: 'Open Board, Ready: 2, Blocked: 1, Running: 1, Verifying: 1, Review: 1, Done today: 101',
        noteCount: 10,
        header: ['99+', false],
        includesAbandoned: true,
      });
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('keeps Office to one pane as a host batch opens and a character task is selected', async () => {
    const restoreMeasure = measuredOfficeForDock();
    const linked = linkedBoard('open');
    const withOfficeTaskInBatch = { ...linked, repos: linked.repos.map((r) => ({ ...r, cards: r.cards.map((card) => card.bead.id === 'ov-5' ? { ...card, batch_id: 'r1-b1' } : card) })) };
    mockApp(withOfficeTaskInBatch);
    history.replaceState(null, '', '#office');
    try {
      render(<App />);
      const session = { session_id: 's-office', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: 'r1-b1', repo_id: 'r1', state: 'working' as const, stalled_since: null };
      act(() => lastSocket().push({ type: 'office_snapshot', sessions: [session] }));
      const dock = await waitFor(() => {
        const element = document.querySelector('.office-chat-dock');
        if (!element) throw new Error('Office Chat dock did not mount');
        return element;
      });
      fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: '#9310 Trend chart: in progress' }));
      await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
      fireEvent.click(await screen.findByRole('button', { name: 'claude · sonnet · ov-5' }));
      const taskPane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
      expect(document.querySelector('.office-chat-dock')).toBe(dock);
      expect(screen.queryByRole('complementary', { name: 'Batch details for r1-b1' })).toBeNull();
      fireEvent.click(await within(taskPane).findByRole('button', { name: 'Open batch r1-b1' }));
      expect(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' })).toBeTruthy();
      expect(document.querySelector('.office-chat-dock')).toBe(dock);
      expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull();
      expect(location.hash).toBe('#office');
    } finally {
      restoreMeasure();
    }
  });

  it('drills into a task and returns to the batch, and Open batch returns from the task pane', async () => {
    mockApp(linkedBoard('open'));
    history.replaceState(null, '', '#chat');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' }));
    let pane = await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    fireEvent.click(within(pane).getByRole('button', { name: /Running task/ }));
    const taskPane = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    fireEvent.click(within(taskPane).getByRole('button', { name: 'Back to batch' }));
    pane = await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    fireEvent.click(within(pane).getByRole('button', { name: /Running task/ }));
    const taskPaneAgain = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    fireEvent.click(await within(taskPaneAgain).findByRole('button', { name: 'Open batch r1-b1' }));
    expect(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' })).toBeTruthy();
    expect(location.hash).toBe('#chat');
  });

  it('follows a selected blocker inside the host and keeps its Back to batch control', async () => {
    const linked = linkedBoard('open');
    const withBlockedTask = { ...linked, repos: linked.repos.map((r) => ({ ...r, cards: r.cards.map((c) => c.bead.id === 'ov-2' ? { ...c, batch_id: 'r1-b1' } : c) })) };
    mockApp(withBlockedTask);
    history.replaceState(null, '', '#chat');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' }));
    const batchPane = await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    fireEvent.click(within(batchPane).getByRole('button', { name: /Blocked task/ }));
    const blockedPane = await screen.findByRole('complementary', { name: 'Details of ov-2' });
    fireEvent.click(await within(blockedPane).findByRole('button', { name: 'ov-1' }));
    const blockerPane = await screen.findByRole('complementary', { name: 'Details of ov-1' });
    expect(within(blockerPane).getByRole('button', { name: 'Back to batch' })).toBeTruthy();
  });

  it('closes the host when the view changes', async () => {
    mockApp(linkedBoard('open'));
    history.replaceState(null, '', '#chat');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' }));
    await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));
    await waitFor(() => expect(location.hash).toBe('#office'));
    expect(screen.queryByRole('complementary', { name: 'Batch details for r1-b1' })).toBeNull();
  });

  it('opens a review batch in Review with that batch selected', async () => {
    mockApp(linkedBoard('review'));
    history.replaceState(null, '', '#chat');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '#9310 Trend chart: in review' }));
    const pane = await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Open in Review' }));
    await waitFor(() => expect(location.hash).toBe('#review'));
    expect(await screen.findByRole('heading', { name: '#9310 Trend chart' })).toBeTruthy();
  });

  it('replaces an open task pane with the Needs batch drawer', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mockApp(linkedBoard('review'));
    history.replaceState(null, '', '#office');
    render(<App />);
    lastSocket().push({ type: 'office_snapshot', sessions: [{ session_id: 'needs-pane-task', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'walking_in', stalled_since: null }] });
    fireEvent.click(await screen.findByRole('button', { name: 'claude · sonnet · ov-5' }));
    await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(screen.getByRole('button', { name: 'batch: #9310 Trend chart' }));
    await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    expect(document.querySelectorAll('main > aside.detail')).toHaveLength(1);
  });

  it('shows the Review error toast and restores actions when a drawer job fails', async () => {
    const inReview = linkedBoard('review');
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-24T00:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      if (url.endsWith('/api/board')) return inReview;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans') || url.endsWith('/api/plans/all')) return [];
      if (url.endsWith('/api/batches/r1-b1') && method === 'GET') return { ...batchDetail, batch: inReview.repos[0]!.batches[0]! };
      if (url.endsWith('/api/batches/r1-b1/merge') && method === 'POST') return { job_id: 'job-drawer-failure' };
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'batch: #9310 Trend chart' }));
    const pane = within(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' }));
    fireEvent.click(await pane.findByRole('button', { name: 'Merge' }));
    fireEvent.click(pane.getByRole('button', { name: 'Confirm merge' }));
    await pane.findByText('Merging batch r1-b1 into main…');
    act(() => lastSocket().push({ type: 'action_result', job_id: 'job-drawer-failure', action: 'merge', target: 'r1-b1', ok: false, message: 'merge conflict in src/a.ts', data: null }));
    expect((await within(screen.getByTestId('toasts')).findByRole('alert')).textContent).toContain('Merge failed: merge conflict in src/a.ts');
    expect(pane.queryByText('Merging batch r1-b1 into main…')).toBeNull();
    expect((pane.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens a host task in Review from its existing review action', async () => {
    const linked = linkedBoard('open');
    const withReviewTask = { ...linked, repos: linked.repos.map((r) => ({ ...r, cards: r.cards.map((c) => c.bead.id === 'ov-5' ? { ...c, batch_id: 'r1-b1' } : c) })) };
    mockApp(withReviewTask);
    history.replaceState(null, '', '#chat');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' }));
    const batchPane = await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    fireEvent.click(within(batchPane).getByRole('button', { name: /Review task/ }));
    const taskPane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(await within(taskPane).findByRole('button', { name: 'Open in Review' }));
    await waitFor(() => expect(location.hash).toBe('#review'));
    expect(screen.queryByRole('complementary', { name: 'Details of ov-5' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Batch details for r1-b1' })).toBeNull();
  });

  it('keeps Board batch rows and its TaskPane Open batch action routed to Review', async () => {
    mockApp(linkedBoard('open'));
    history.replaceState(null, '', '#board');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /#9310 Trend chart/ }));
    await waitFor(() => expect(location.hash).toBe('#review'));
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Running task.*ov-3/ }));
    const taskPane = await screen.findByRole('complementary', { name: 'Details of ov-3' });
    fireEvent.click(await within(taskPane).findByRole('button', { name: 'Open batch r1-b1' }));
    await waitFor(() => expect(location.hash).toBe('#review'));
  });

  it('keeps the Board task pane Open in Review action routed to Review', async () => {
    mockApp(board);
    history.replaceState(null, '', '#board');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Review task/ }));
    const taskPane = await screen.findByRole('complementary', { name: 'Details of ov-5' });
    fireEvent.click(await within(taskPane).findByRole('button', { name: 'Open in Review' }));
    await waitFor(() => expect(location.hash).toBe('#review'));
  });
  it('shows a restart-needed header badge that opens Setup', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    const badge = await screen.findByRole('button', { name: 'Restart needed' });
    fireEvent.click(badge);
    await screen.findByText('Daemon', { selector: 'h2' });
    expect(location.hash).toBe('#setup');
  });

  it('targets the daemon again after the user left General inside the first target window', async () => {
    // A real ResizeObserver keeps the daemon target pending for 2s; leaving General must release it, or the second click is dead.
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true };
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart needed' }));
    const daemon = await screen.findByText('Daemon', { selector: 'h2' });
    expect(document.activeElement).toBe(daemon.closest('section'));
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    await screen.findByText('Models', { selector: 'h2' });
    fireEvent.click(screen.getByRole('button', { name: 'Restart needed' }));
    const again = await screen.findByText('Daemon', { selector: 'h2' });
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(again.closest('section'));
  });

  it('lists an open question the latest page carries from below oldest_id in the Office strip', async () => {
    const question = { id: 3, role: 'assistant', kind: 'question', text: 'Old but open?', ts: '2026-09-12T10:01:00.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null };
    const latest = { id: 101, role: 'user', kind: 'message', text: 'latest row', ts: '2026-09-16T10:00:00.000Z', answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null };
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [question, latest], has_more: true, oldest_id: 101 };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Chat, 1 question waiting for your answer' })).toBeTruthy());
    expect(await screen.findByRole('button', { name: 'question: Old but open?' })).toBeTruthy();
  });

  it('selects and focuses a Needs question in docked Chat without leaving Office', async () => {
    const restore = measuredOfficeForDock();
    try {
      mockApp(board, needsQuestions());
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(document.querySelector('.office-chat-dock')).not.toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: 'question: Question B?' }));
      await waitFor(() => expect(questionState()).toEqual({ pager: 'Question 2 of 3', activeQuestion: 'Question B?', answerFocused: true, office: true, chat: false, docked: true, error: null }));
    } finally { restore(); }
  });

  it('opens Chat with the selected Needs question focused when the dock is absent', async () => {
    mockApp(board, needsQuestions());
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'question: Question B?' }));
    await screen.findByText('Question 2 of 3');
    await waitFor(() => expect(questionState()).toEqual({ pager: 'Question 2 of 3', activeQuestion: 'Question B?', answerFocused: true, office: false, chat: true, docked: false, error: null }));
  });

  it('focuses the same Needs question again on a repeated click', async () => {
    const restore = measuredOfficeForDock();
    try {
      mockApp(board, needsQuestions());
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(document.querySelector('.office-chat-dock')).not.toBeNull());
      const question = await screen.findByRole('button', { name: 'question: Question B?' });
      fireEvent.click(question);
      await waitFor(() => expect(questionState().answerFocused).toBe(true));
      screen.getByLabelText('Message the orchestrator').focus();
      fireEvent.click(question);
      await waitFor(() => expect(questionState()).toEqual({ pager: 'Question 2 of 3', activeQuestion: 'Question B?', answerFocused: true, office: true, chat: false, docked: true, error: null }));
    } finally { restore(); }
  });

  it('keeps the latest Needs question selected when question A is followed by B', async () => {
    const restore = measuredOfficeForDock();
    try {
      mockApp(board, needsQuestions());
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(document.querySelector('.office-chat-dock')).not.toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: 'question: Question A?' }));
      fireEvent.click(screen.getByRole('button', { name: 'question: Question B?' }));
      await waitFor(() => expect(questionState()).toEqual({ pager: 'Question 2 of 3', activeQuestion: 'Question B?', answerFocused: true, office: true, chat: false, docked: true, error: null }));
    } finally { restore(); }
  });

  it('uses the default open question without focus when the requested question was answered before Chat loaded', async () => {
    const questions = needsQuestions();
    let chatLoads = 0;
    mockApp(board, () => {
      chatLoads++;
      return chatLoads === 1 ? questions : [{ ...questions[0]!, answer: 'Handled elsewhere', answered_at: '2026-09-25T10:00:00.000Z' }, ...questions.slice(1)];
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'question: Question A?' }));
    await waitFor(() => expect(questionState()).toEqual({ pager: 'Question 1 of 2', activeQuestion: 'Question B?', answerFocused: false, office: false, chat: true, docked: false, error: null }));
  });

  it('does not replay a Needs question selection when Chat is later opened from the rail', async () => {
    const restore = measuredOfficeForDock();
    try {
      mockApp(board, needsQuestions());
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(document.querySelector('.office-chat-dock')).not.toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: 'question: Question B?' }));
      await waitFor(() => expect(questionState().answerFocused).toBe(true));
      fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
      await screen.findByText('Question 1 of 3');
      await waitFor(() => expect(questionState()).toEqual({ pager: 'Question 1 of 3', activeQuestion: 'Question A?', answerFocused: false, office: false, chat: true, docked: false, error: null }));
    } finally { restore(); }
  });

  it('keeps focus on Previous after navigating from a question selected through Needs', async () => {
    const restore = measuredOfficeForDock();
    try {
      mockApp(board, needsQuestions());
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(document.querySelector('.office-chat-dock')).not.toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: 'question: Question B?' }));
      await waitFor(() => expect(questionState().activeQuestion).toBe('Question B?'));
      const previous = screen.getByRole('button', { name: 'Previous' });
      previous.focus();
      fireEvent.click(previous);
      expect(document.activeElement).toBe(previous);
    } finally { restore(); }
  });

  it('keeps focus on Next after navigating from a question selected through Needs', async () => {
    const restore = measuredOfficeForDock();
    try {
      mockApp(board, needsQuestions());
      history.replaceState(null, '', '#office');
      render(<App />);
      await waitFor(() => expect(document.querySelector('.office-chat-dock')).not.toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: 'question: Question A?' }));
      await waitFor(() => expect(questionState().activeQuestion).toBe('Question A?'));
      const next = screen.getByRole('button', { name: 'Next' });
      next.focus();
      fireEvent.click(next);
      expect(document.activeElement).toBe(next);
    } finally { restore(); }
  });

  it('renders the rail, switches views and reacts to status messages', async () => {
    let statusCalls = 0;
    let resets = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) { statusCalls++; return statusCalls === 1 ? status : { ...status, bd_ok: false, orchestrator: { status: 'ended', native_session_id: 'abc' } }; }
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [{ repo_id: 'r1', total: 3.1, today: 0.5 }], batches: [] };
      if (method === 'POST' && url.endsWith('/api/orchestrator/reset')) { resets++; return { ok: true }; }
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTitle('E:/Projects/demo')).toBeTruthy());
    expect(within(document.querySelector('.rail-status-live') as HTMLElement).getByRole('img').getAttribute('aria-label')).not.toContain('offline');
    expect(screen.queryByText(/bd unavailable/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    lastSocket().push({ type: 'status' });
    await waitFor(() => expect(screen.getByText(/bd unavailable/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('$3.10')).toBeTruthy());
    // New session throws away the orchestrator's memory of the thread: it asks like Merge, Abandon and Remove do, and a refusal posts nothing (round 10).
    const asked: string[] = [];
    let accept = false;
    vi.stubGlobal('confirm', (m: string) => { asked.push(m); return accept; });
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(asked).toEqual(["Start a new orchestrator session? The orchestrator's memory of this conversation is lost; the next message starts fresh. Batches and tasks are unaffected."]);
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(resets).toBe(0);
    accept = true;
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await waitFor(() => expect(resets).toBe(1));
  });

  it('shows an action result from the socket as a toast, one per target', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    // Two actions on different targets end together: two toasts, each with its own outcome.
    act(() => {
      lastSocket().push({ type: 'action_result', job_id: 'j1', action: 'merge', target: 'r1-b1', ok: true, message: null, data: null });
      lastSocket().push({ type: 'action_result', job_id: 'j2', action: 'merge', target: 'r1-b2', ok: false, message: 'merge conflict in src/a.ts', data: null });
    });
    const toasts = within(screen.getByTestId('toasts'));
    expect(toasts.getByRole('status').textContent).toContain('r1-b1 merged.');
    expect(toasts.getByRole('alert').textContent).toContain('Merge failed: merge conflict in src/a.ts');
  });

  describe('a pending action in the card pane', () => {
    const failedCard = board.repos[0]!.cards[5]!;
    const failedDetail = { ...reviewDetail, bead: failedCard.bead, worktree: { ...reviewDetail.worktree!, bead_id: 'ov-6', batch_id: 'r1-b1', verify_status: 'fail' as const, verify_output: '$ pnpm test\nexit 1' }, last_assistant_text: null };
    const withJob = (jobId: string | null) => ({ ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, pending_action: jobId ? { job_id: jobId, action: 'verify', started_at: '2026-09-13T00:00:00.000Z' } : null } : c)) })) });
    const setup = (post: () => unknown) => {
      const state = { board: withJob(null), boardFails: false, boardFailures: 0 };
      mockApi((method, url) => {
        if (url.endsWith('/api/repos')) return [repo];
        if (url.endsWith('/api/doctor')) return doctorOk;
        if (url.endsWith('/api/status')) return status;
        if (url.endsWith('/api/board') && state.boardFails) { state.boardFailures++; throw Object.assign(new Error('bd unavailable'), { status: 500 }); }
        if (url.endsWith('/api/board')) return state.board;
        if (url.endsWith('/api/tasks/ov-6')) return failedDetail;
        if (method === 'POST' && url.endsWith('/api/tasks/ov-6/verify')) return post();
        if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
        if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
        if (url.endsWith('/api/plans')) return [];
        if (url.endsWith('/api/plans/all')) return [];
        throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
      });
      location.hash = '#board/ov-6';
      render(<App />);
      return state;
    };
    const pane = () => screen.findByRole('complementary', { name: 'Details of ov-6' });

    it('keeps the pressed button pending after the 202 until the socket brings the job result', async () => {
      setup(() => ({ job_id: 'j1', action: 'verify', target: 'ov-6' }));
      const p = await pane();
      fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
      // The 202 has been read and no board has carried the job yet: the job still runs.
      await act(async () => {});
      expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
      expect((within(p).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(true);
      act(() => { lastSocket().push({ type: 'action_result', job_id: 'j1', action: 'verify', target: 'ov-6', ok: false, message: 'exit 1', data: null }); });
      // The job failed in the background and the card is where it was: its buttons are back, the failure is a toast.
      expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
      expect((within(p).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(false);
      expect(within(screen.getByTestId('toasts')).getByRole('alert').textContent).toContain('Retry verification failed: exit 1');
    });

    it('releases a 409 whose short job ended before any board sampled it: 409, result, then a board with no job', async () => {
      const state = setup(() => { throw Object.assign(new Error('verify is already running for ov-6'), { status: 409, body: { job_id: 'j1', action: 'verify' } }); });
      const p = await pane();
      fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
      await waitFor(() => expect(within(screen.getByTestId('toasts')).getByRole('alert').textContent).toContain('verify is already running for ov-6'));
      expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy();
      act(() => { lastSocket().push({ type: 'action_result', job_id: 'j1', action: 'verify', target: 'ov-6', ok: true, message: null, data: null }); });
      expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
      state.board = withJob(null);
      act(() => { lastSocket().push({ type: 'board' }); });
      await act(async () => {});
      expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
      expect((within(p).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('frees the buttons on the result of the job a board row carries, and keeps them free when the next board refetch fails', async () => {
      const state = setup(() => { throw Object.assign(new Error('unexpected POST'), { status: 500 }); });
      const p = await pane();
      await within(p).findByRole('button', { name: 'Retry verification' });
      // A board carries a job this page did not start (a reload mid-run, another tab).
      state.board = withJob('j1');
      act(() => { lastSocket().push({ type: 'board' }); });
      await waitFor(() => expect(within(p).getByRole('button', { name: 'Retrying…' })).toBeTruthy());
      act(() => { lastSocket().push({ type: 'action_result', job_id: 'j1', action: 'verify', target: 'ov-6', ok: false, message: 'exit 1', data: null }); });
      expect(within(p).queryByRole('button', { name: 'Retrying…' })).toBeNull();
      expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
      // The refetch that follows fails: the app keeps the stale row, which still names j1, whose result is known.
      state.boardFails = true;
      act(() => { lastSocket().push({ type: 'board' }); });
      await waitFor(() => expect(state.boardFailures).toBeGreaterThan(0));
      await act(async () => {});
      expect(within(p).queryByRole('button', { name: 'Retrying…' })).toBeNull();
      expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false);
      expect((within(p).getByRole('button', { name: 'Re-dispatch' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('releases a 409 on a board requested after it whose row carries no job, when the result never arrives', async () => {
      const state = setup(() => { throw Object.assign(new Error('verify is already running for ov-6'), { status: 409, body: { job_id: 'j1', action: 'verify' } }); });
      const p = await pane();
      fireEvent.click(await within(p).findByRole('button', { name: 'Retry verification' }));
      await waitFor(() => expect(within(screen.getByTestId('toasts')).getByRole('alert')).toBeTruthy());
      state.board = withJob(null);
      act(() => { lastSocket().push({ type: 'board' }); });
      await waitFor(() => expect((within(p).getByRole('button', { name: 'Retry verification' }) as HTMLButtonElement).disabled).toBe(false));
    });
  });

  it('refetches board and status after the socket reconnects', async () => {
    const calls: string[] = [];
    mockApi((method, url) => {
      calls.push(url);
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    const count = (suffix: string) => calls.filter((u) => u.endsWith(suffix)).length;
    const boardBefore = count('/api/board');
    const statusBefore = count('/api/status');
    const reposBefore = count('/api/repos');
    const first = lastSocket();
    vi.useFakeTimers();
    try {
      act(() => first.close());
      expect(lastSocket()).toBe(first);
      // Lost: the page says so, elapsed times stop and the mascot switches offline.
      expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable, retrying/i);
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain('offline');
      const strip = screen.getByRole('region', { name: 'Running workers' });
      expect(within(strip).getByText('2m 5s')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(1000);
      expect(within(strip).getByText('2m 5s')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
    const second = lastSocket();
    expect(second).not.toBe(first);
    act(() => second.onopen?.());
    await waitFor(() => {
      expect(count('/api/board')).toBeGreaterThan(boardBefore);
      expect(count('/api/status')).toBeGreaterThan(statusBefore);
      expect(count('/api/repos')).toBeGreaterThan(reposBefore);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('offline');
  });

  it('shows a card settling as soon as the daemon reports its session ended, and keeps it so while a board built before the exit lands (round 12)', async () => {
    let served = board; // what /api/board answers: the running board until the "rebuilt" one is swapped in
    let boardCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) { boardCalls++; return served; }
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/tasks/ov-3')) return new Promise<unknown>(() => {}); // the detail is not what drives Stop
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Running task', { selector: '.card-title' })).toBeTruthy());
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    expect(within(pane).getByRole('button', { name: 'Stop worker' })).toBeTruthy();
    const calls = boardCalls;
    // The worker exits: the notice names the session; no board has been fetched yet, the card and the pane read settling and Stop is gone.
    act(() => lastSocket().push({ type: 'session_ended', session_id: 'sess-3' }));
    expect(boardCalls).toBe(calls);
    expect(within(pane).queryByRole('button', { name: 'Stop worker' })).toBeNull();
    expect(within(pane).getByText(/^settling…/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Running workers' })).getByText(/settling…/)).toBeTruthy();
    // The board notice that follows fetches a board that was built before the exit (still running): the card stays settling.
    act(() => lastSocket().push({ type: 'board' }));
    await waitFor(() => expect(boardCalls).toBe(calls + 1));
    await act(async () => {}); // the response paints within this flush
    expect(within(pane).queryByRole('button', { name: 'Stop worker' })).toBeNull();
    expect(within(pane).getByText(/^settling…/)).toBeTruthy();
    // A board built after the exit knows the session ended and moves the bead on: it is shown as it is.
    const cards = board.repos[0]!.cards;
    served = { ...board, repos: [{ ...board.repos[0]!, cards: cards.map((c) => (c.bead.id === 'ov-3' ? { ...c, column: 'verifying' as const, state: 'verifying' as const, session_status: 'ended' as const } : c)) }] };
    act(() => lastSocket().push({ type: 'board' }));
    await waitFor(() => expect(within(pane).queryByText(/^settling…/)).toBeNull());
    expect(screen.getByRole('heading', { level: 3, name: 'Verifying (2)' })).toBeTruthy();
  });

  it('refetches an open trace of a live session on its event notices, at most once a second (fix round 12 review)', async () => {
    let eventCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/tasks/ov-3')) return { ...reviewDetail, bead: board.repos[0]!.cards[2]!.bead, sessions: [{ ...reviewDetail.sessions[0]!, id: 'sess-3', status: 'running' as const, ended_at: null }] };
      if (url.includes('/api/sessions/sess-3/events')) { eventCalls++; return []; }
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Running task', { selector: '.card-title' })).toBeTruthy());
    fireEvent.click(screen.getByText('Running task', { selector: '.card-title' }));
    const pane = screen.getByRole('complementary', { name: 'Details of ov-3' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Trace' }));
    await waitFor(() => expect(eventCalls).toBe(1));
    vi.useFakeTimers();
    try {
      // Three events in quick succession, one of them for another session: one refetch, a second later.
      act(() => { lastSocket().push({ type: 'event', session_id: 'sess-3' }); lastSocket().push({ type: 'event', session_id: 'sess-3' }); lastSocket().push({ type: 'event', session_id: 'orch-1' }); });
      await act(() => vi.advanceTimersByTimeAsync(EVENT_REFRESH_MS - 1));
      expect(eventCalls).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(eventCalls).toBe(2);
      await act(() => vi.advanceTimersByTimeAsync(EVENT_REFRESH_MS));
      expect(eventCalls).toBe(2); // nothing arrived since
      act(() => lastSocket().push({ type: 'event', session_id: 'sess-3' }));
      await act(() => vi.advanceTimersByTimeAsync(EVENT_REFRESH_MS));
      expect(eventCalls).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it('retries the initial loads with backoff instead of staying on "Loading board…" when the daemon is down at page load', async () => {
    let up = false;
    const calls: string[] = [];
    mockApi((method, url) => {
      calls.push(url);
      if (!up) return new Response('', { status: 500, headers: { 'content-type': 'text/plain' } }); // the dev proxy answers a bare 500 while the daemon boots
      if (url.endsWith('/api/health')) return { ok: true };
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable/i));
    // Nothing was ever loaded: the banner must not call the empty views a last known state (fix round 15 review).
    expect(screen.getByRole('alert').textContent).toBe('Daemon unreachable, retrying… Nothing has been loaded yet.');
    expect(screen.getByText(/loading board/i)).toBeTruthy();
    const initial = calls.length;
    up = true;
    // The first health probe comes after a second (then 2 s, 4 s, capped at 5 s); everything is refetched once it answers.
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy(), { timeout: 4000 });
    expect(calls.slice(initial)[0]).toBe('/api/health');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTitle('E:/Projects/demo')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('offline');
  });

  it('shows an endpoint error inline and goes offline only when the daemon cannot be reached', async () => {
    let boardMode: 'ok' | 'error' | 'down' = 'error';
    const calls: string[] = [];
    mockApi((method, url) => {
      calls.push(url);
      if (url.endsWith('/api/board')) {
        if (boardMode === 'error') throw Object.assign(new Error('bd list failed: database is locked'), { status: 500 });
        if (boardMode === 'down') throw new TypeError('Failed to fetch');
        return board;
      }
      if (url.endsWith('/api/health')) return { ok: true };
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    // A 500 the daemon answered: the shell stays online (no health polling), the error names the endpoint.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not load /api/board: bd list failed: database is locked'));
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('offline');
    expect(calls.filter((u) => u.endsWith('/api/health'))).toHaveLength(0);
    // The next successful load of that endpoint clears it.
    boardMode = 'ok';
    lastSocket().push({ type: 'board' });
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    // A fetch that cannot reach the daemon at all is the outage.
    boardMode = 'down';
    lastSocket().push({ type: 'board' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable/i));
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('offline');
    boardMode = 'ok';
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 4000 });
    expect(calls.filter((u) => u.endsWith('/api/health')).length).toBeGreaterThan(0);
  });

  it('counts ready and waiting batches separately and moves a released batch to Ready for you', async () => {
    const b0 = board.repos[0]!.batches[0]!;
    const batch = (id: string, over: Partial<typeof b0>) => ({ ...b0, id, title: id, ...over });
    const orchRepo = { ...repo, id: 'r2', path: 'E:/Projects/other', batch_approver: 'orchestrator' as const };
    const boardWith = (first: 'review' | 'merged') => ({ ...board, repos: [
      { ...board.repos[0]!, cards: [], batches: [
        batch('r1-a', { status: first }), // (a) user-approved, in review
        batch('r1-b', { status: 'review', waiting_on: first === 'review' ? 'r1-a' : null }), // (b) moves from waiting to ready after (a) merges
        batch('r1-d', { status: 'open' }), // (d) still open
      ] },
      { repo: orchRepo, cards: [], batches: [batch('r2-c', { repo_id: 'r2', status: 'review' })] }, // (c) orchestrator-approved
    ] });
    let current = boardWith('review');
    mockApi((method, url) => {
      if (url.endsWith('/api/board')) return current;
      if (url.endsWith('/api/repos')) return [repo, orchRepo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    const review = await screen.findByRole('button', { name: 'Review, 1 ready for review, 1 waiting' });
    expect(review.title).toBe('1 ready for review, 1 waiting');
    expect(review.getAttribute('aria-label')).toBe('Review, 1 ready for review, 1 waiting');
    expect(review.textContent).toBe('Review1');
    fireEvent.click(review);
    const reviewList = document.querySelector('.review-list') as HTMLElement;
    const readyGroup = (await within(reviewList).findByRole('heading', { name: 'Ready for you' })).parentElement as HTMLElement;
    expect(within(reviewList).getByRole('heading', { name: 'Waiting' })).toBeTruthy();
    expect(within(readyGroup).queryByRole('button', { name: /r2-c/ })).toBeNull();
    const orchestratorGroup = within(reviewList).getByRole('heading', { name: 'Handled by orchestrator' }).parentElement as HTMLElement;
    expect(within(orchestratorGroup).getByRole('button', { name: /r2-c/ })).toBeTruthy();
    current = boardWith('merged');
    lastSocket().push({ type: 'board' });
    const moved = await screen.findByRole('button', { name: 'Review, 1 ready for review' });
    expect(moved.title).toBe('1 ready for review');
    expect(moved.getAttribute('aria-label')).toBe('Review, 1 ready for review');
    expect(moved.textContent).toBe('Review1');
    await waitFor(() => expect(within(reviewList).queryByRole('heading', { name: 'Waiting' })).toBeNull());
  });

  it('shows the Waiting section without a Review badge when no batch is ready', async () => {
    const source = board.repos[0]!.batches[0]!;
    const held = { ...source, id: 'r1-held', title: 'Held change', status: 'review' as const, waiting_on: 'r1-missing' };
    const waitingOnly: BoardResponse = { ...board, repos: [{ ...board.repos[0]!, cards: [], batches: [held] }] };
    mockApp(waitingOnly);
    render(<App />);
    const review = await screen.findByRole('button', { name: 'Review, 0 ready for review, 1 waiting' });
    expect(review.title).toBe('0 ready for review, 1 waiting');
    expect(review.getAttribute('aria-label')).toBe('Review, 0 ready for review, 1 waiting');
    expect(review.textContent).toBe('Review');
    expect(review.querySelector('.count')).toBeNull();
    fireEvent.click(review);
    const reviewList = document.querySelector('.review-list') as HTMLElement;
    expect(await within(reviewList).findByRole('heading', { name: 'Waiting' })).toBeTruthy();
    expect(within(reviewList).queryByRole('heading', { name: 'Ready for you' })).toBeNull();
    expect(within(reviewList).getByText('Waiting on r1-missing')).toBeTruthy();
  });

  it('queues a fresh board reload behind the in-flight response and keeps the refreshing note continuous', async () => {
    vi.useFakeTimers();
    let boardCalls = 0;
    let releaseSecond: (b: unknown) => void = () => {};
    let releaseThird: (b: unknown) => void = () => {};
    const refreshed = { ...board, repos: board.repos.map((r) => ({ ...r, cards: r.cards.filter((c) => c.bead.title !== 'Ready task') })) };
    mockApp(board, chat, [], { boardRequest: () => {
      boardCalls += 1;
      if (boardCalls === 1) return board;
      return new Promise((resolve) => { if (boardCalls === 2) releaseSecond = resolve; else releaseThird = resolve; });
    } });
    history.replaceState(null, '', '#board');
    let unmount: (() => void) | undefined;
    try {
      unmount = render(<App />).unmount;
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(boardCalls).toBe(1);
      expect(screen.getByText('Ready task')).toBeTruthy();

      act(() => lastSocket().push({ type: 'board' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(boardCalls).toBe(2);
      act(() => lastSocket().push({ type: 'board' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(boardCalls).toBe(2); // the next change queues a reload instead of overlapping the slow request
      await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_NOTE_MS); });
      expect(screen.getByText('refreshing…')).toBeTruthy();

      await act(async () => { releaseSecond(board); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
      await vi.waitFor(() => expect(boardCalls).toBe(3));
      expect(screen.getByText('refreshing…')).toBeTruthy(); // starting the queued request does not reset the note timer

      await act(async () => { releaseThird(refreshed); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(screen.queryByText('Ready task')).toBeNull());
      expect(screen.queryByText('refreshing…')).toBeNull();
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('runs a queued board reload after the first request fails and keeps the failed path until recovery', async () => {
    vi.useFakeTimers();
    let boardCalls = 0;
    let failFirst: (error: Error) => void = () => {};
    let releaseSecond: (b: unknown) => void = () => {};
    const recoveredBoard = linkedBoard('review');
    mockApp(recoveredBoard, chat, [], { boardRequest: () => {
      boardCalls += 1;
      return new Promise((resolve, reject) => {
        if (boardCalls === 1) failFirst = reject;
        else releaseSecond = resolve;
      });
    } });
    history.replaceState(null, '', '#office');
    let unmount: (() => void) | undefined;
    try {
      unmount = render(<App />).unmount;
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      act(() => lastSocket().push({ type: 'board' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(boardCalls).toBe(1);

      await act(async () => { failFirst(new Error('board build failed')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load /api/board'));
      expect(boardCalls).toBe(2);
      expect(screen.getByRole('alert').textContent).toContain('Could not load /api/board'); // fetchFailed stays true until the trailing request succeeds
      expect(within(document.querySelector('.office-needs')!).queryByTestId('shimmer')).toBeNull();

      await act(async () => { releaseSecond(recoveredBoard); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'batch: #9310 Trend chart' })).toBeTruthy());
      expect(screen.queryByRole('alert')).toBeNull();
      expect(boardCalls).toBe(2);
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('reloads repos on a repos socket message', async () => {
    let reposCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) { reposCalls++; return reposCalls === 1 ? [repo] : [repo, { ...repo, id: 'r2', path: 'E:/Projects/two' }]; }
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTitle('E:/Projects/demo')).toBeTruthy());
    lastSocket().push({ type: 'repos' });
    await waitFor(() => expect(screen.getByTitle('E:/Projects/two')).toBeTruthy());
  });

  it('restores the view from the hash and the chat repo from storage, and refreshes status on chat events', async () => {
    let statusCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorBad; // a hash beats the cold-start redirect
      if (url.endsWith('/api/status')) { statusCalls++; return status; }
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#chat';
    localStorage.setItem('overseer.chatRepo', 'r1');
    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('setup needs attention')).toBeTruthy());
    expect((screen.getByLabelText('Repo') as HTMLSelectElement).value).toBe('r1');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: '' } });
    expect(localStorage.getItem('overseer.chatRepo')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(location.hash).toBe('#board'));
    const before = statusCalls;
    lastSocket().push({ type: 'chat' });
    await waitFor(() => expect(statusCalls).toBe(before + 1));
  });

  it('keeps the chat draft and its pending attachment when the view is left and reopened', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: revoke });
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'half a message' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    expect(revoke).not.toHaveBeenCalled(); // the preview URL outlives the composer's unmount
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    const again = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    expect(again.value).toBe('half a message');
    expect(screen.getByAltText('shot.png')).toBeTruthy();
  });

  it('clears the chat draft and attachments on send, and they stay cleared when Chat is reopened', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: vi.fn() });
    mockApi((method, url) => {
      if (method === 'POST' && url.endsWith('/api/chat')) return { ok: true };
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    localStorage.setItem('overseer.chatRepo', 'r1');
    history.replaceState(null, '', '#board');
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'ship it' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect((screen.getByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement).value).toBe(''));
    expect(screen.queryByAltText('shot.png')).toBeNull();
    expect(localStorage.getItem('overseer.chatDraft.r1')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    const again = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    expect(again.value).toBe('');
    expect(screen.queryByAltText('shot.png')).toBeNull();
  });

  it('restores the chat draft from localStorage on load, keyed by the chosen repository', async () => {
    const repo2 = { ...repo, id: 'r2', path: 'E:/Projects/two' };
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo, repo2];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#chat';
    localStorage.setItem('overseer.chatRepo', 'r1');
    sessionStorage.setItem('overseer.chatRepoChosen', '1');
    localStorage.setItem('overseer.chatDraft.r1', 'drafted for r1');
    localStorage.setItem('overseer.chatDraft.r2', 'drafted for r2');
    render(<App />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    expect(input.value).toBe('drafted for r1');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r2' } });
    expect(input.value).toBe('drafted for r2');
  });

  it('a send that lands after a repository switch clears only the sent repository\'s draft', async () => {
    const repo2 = { ...repo, id: 'r2', path: 'E:/Projects/two' };
    let release: () => void = () => {};
    mockApi((method, url) => {
      if (method === 'POST' && url.endsWith('/api/chat')) return new Promise<unknown>((resolve) => { release = () => resolve({ ok: true }); });
      if (url.endsWith('/api/repos')) return [repo, repo2];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    localStorage.setItem('overseer.chatRepo', 'r1');
    sessionStorage.setItem('overseer.chatRepoChosen', '1');
    localStorage.setItem('overseer.chatDraft.r2', 'draft for r2');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Chat/ }));
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'draft for r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r2' } });
    expect(input.value).toBe('draft for r2');
    act(() => release());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.value).toBe('draft for r2');
    expect(localStorage.getItem('overseer.chatDraft.r2')).toBe('draft for r2');
    expect(localStorage.getItem('overseer.chatDraft.r1')).toBe('');
  });

  it('keeps a re-typed draft and a new attachment when an earlier send resolves after navigation', async () => {
    let release: () => void = () => {};
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: revoke });
    vi.stubGlobal('FileReader', class { result: string | null = null; error: DOMException | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.(); } });
    mockApi((method, url) => {
      if (method === 'POST' && url.endsWith('/api/chat')) return new Promise<unknown>((resolve) => { release = () => resolve({ ok: true }); });
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    localStorage.setItem('overseer.chatRepo', 'r1');
    sessionStorage.setItem('overseer.chatRepoChosen', '1');
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Chat/ }));
    const firstInput = await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(firstInput, { target: { value: 'same' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['first'], 'first.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await screen.findByText('Ready task');
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    const currentInput = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    // The re-entered draft lands on the same text the pending send carried: text equality cannot tell the two apart, so the
    // completion must key off the draft revision the send captured rather than the value.
    fireEvent.change(currentInput, { target: { value: 'same, edited' } });
    fireEvent.change(currentInput, { target: { value: 'same' } });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] } });
    expect(screen.getByAltText('first.png')).toBeTruthy();
    expect(screen.getByAltText('second.png')).toBeTruthy();
    act(() => release());
    await waitFor(() => expect(screen.queryByAltText('first.png')).toBeNull());
    expect(currentInput.value).toBe('same');
    expect(screen.getByAltText('second.png')).toBeTruthy();
    expect(revoke).toHaveBeenCalledWith('blob:first.png');
    expect(revoke).not.toHaveBeenCalledWith('blob:second.png');
  });

  it('keeps a staged attachment when the repository is switched', async () => {
    const repo2 = { ...repo, id: 'r2', path: 'E:/Projects/two' };
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: revoke });
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo, repo2];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    localStorage.setItem('overseer.chatRepo', 'r1');
    sessionStorage.setItem('overseer.chatRepoChosen', '1');
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Chat/ }));
    await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r2' } });
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('keeps the selected card in the hash: #board/<id> opens its pane at load and the hash follows the selection (round 16)', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.includes('/api/tasks/')) return reviewDetail;
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#board/ov-5';
    render(<App />);
    await waitFor(() => expect(screen.getByText('Description of Review task')).toBeTruthy());
    expect(location.hash).toBe('#board/ov-5');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(location.hash).toBe('#board'));
    fireEvent.click(screen.getByText('Ready task'));
    await waitFor(() => expect(location.hash).toBe('#board/ov-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(location.hash).toBe('#board'));
  });

  it('opens Setup when no repo is registered', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'Repositories' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByLabelText('setup needs attention')).toBeNull();
  });

  it('lands the repo-less redirect on Repositories over a remembered section, and lets the user leave it', async () => {
    let reposCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) { reposCalls++; return []; }
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    sessionStorage.setItem('overseer.setupSection', 'models');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'Repositories' }).getAttribute('aria-selected')).toBe('true');
    // The user moves on inside Setup; a repos refetch (still empty) must not pull them back to Repositories.
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    await screen.findByText('Models', { selector: 'h2' });
    const before = reposCalls;
    act(() => { lastSocket().push({ type: 'repos' }); });
    await waitFor(() => expect(reposCalls).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Models' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('Add repository')).toBeNull();
  });

  it('lets the doctor alert win over the repo-less redirect with Prerequisites', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorBad;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Prerequisites')).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Add repository')).toBeNull();
  });

  it('keeps the doctor alert on General after reloading repo-less Setup', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorBad;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#setup';
    render(<App />);
    await waitFor(() => expect(screen.getByText('Prerequisites')).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Add repository')).toBeNull();
  });

  it('stops the prerequisites shimmer when the daemon answers /doctor with an error, while /repos keeps shimmering', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/doctor')) throw Object.assign(new Error('doctor failed'), { status: 500 });
      if (url.endsWith('/api/repos')) return new Promise(() => {}); // still in flight: its own section must keep its shimmer
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#setup';
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load /api/doctor'));
    const general = container.querySelector('.setup-content section');
    expect(general?.querySelector('[data-testid="shimmer"]')).toBeNull();
    expect(screen.getByText('checking…')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Repositories' }));
    expect(screen.getByTestId('shimmer')).toBeTruthy();
  });

  it('opens Setup and marks the rail when a required tool is missing', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorBad;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    sessionStorage.setItem('overseer.setupSection', 'models');
    render(<App />);
    // The doctor alert must override a remembered Settings tab so its Prerequisites warning is visible.
    await waitFor(() => expect(screen.getByText('Prerequisites')).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('setup needs attention')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
  });

  it('keeps the last board across view changes instead of refetching and blanking', async () => {
    const calls: string[] = [];
    mockApi((method, url) => {
      calls.push(url);
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    const boardFetches = calls.filter((u) => u.endsWith('/api/board')).length;
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    expect(screen.queryByText(/loading board/i)).toBeNull();
    expect(screen.getByText('Ready task')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Review(,|$)/ }));
    expect(screen.getByRole('button', { name: /#9310 Trend chart/ })).toBeTruthy(); // the Review list needs no fetch either
    expect(calls.filter((u) => u.endsWith('/api/board')).length).toBe(boardFetches);
  });

  it('follows a hash change without a reload and normalises an unknown hash', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    act(() => { location.hash = '#chat'; dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy());
    act(() => { location.hash = '#bogus'; dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy();
    expect(location.hash).toBe('#chat');
  });

  it('opens Setup for a hash view when no repo is registered, and says which view sent the user there (round 21 nit)', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeTruthy());
    expect(location.hash).toBe('#setup');
    expect(await screen.findByText('Board needs a repository, so Setup opened instead. Add one below and it works.')).toBeTruthy();
    // A click on Setup itself is not a redirect: the line goes.
    fireEvent.click(screen.getByRole('button', { name: /^Setup/ }));
    expect(screen.queryByText(/so Setup opened instead/)).toBeNull();
  });

  it('does not re-announce the redirect after the last repository is removed (fix round 21 review NB-1)', async () => {
    let reposCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) { reposCalls++; return reposCalls === 2 ? [repo] : []; }
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText(/^Board needs a repository/)).toBeTruthy());
    lastSocket().push({ type: 'repos' }); // a repository is registered: the redirect is over
    await waitFor(() => expect(screen.queryByText(/so Setup opened instead/)).toBeNull());
    lastSocket().push({ type: 'repos' }); // and removed again, by the user, from this very view
    await waitFor(() => expect(reposCalls).toBe(3));
    expect(screen.queryByText(/so Setup opened instead/)).toBeNull();
  });

  it('never flashes "refreshing…" for a board fetch that answers at once (fix round 20 review R20-2)', async () => {
    let boardCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/board')) { boardCalls++; return board; }
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#board');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
    lastSocket().push({ type: 'board' });
    await waitFor(() => expect(boardCalls).toBe(2));
    // Waited out past the delay rather than sampled the moment the response landed: a machine that took longer than
    // REFRESH_NOTE_MS to answer would otherwise fail a page that behaves (fix round 21 review NB-5). The fetch is over here, so
    // the note can only appear if its timer was never cleared.
    await new Promise((r) => setTimeout(r, REFRESH_NOTE_MS + 100));
    expect(screen.queryByText('refreshing…')).toBeNull();
  });

  it('jumps to a repo section on the Board when its rail row is clicked', async () => {
    const scrolls: string[] = [];
    Element.prototype.scrollIntoView = function () { scrolls.push(this.id); };
    try {
      mockApi((method, url) => {
        if (url.endsWith('/api/repos')) return [repo, { ...repo, id: 'r2', path: 'E:/Projects/two' }];
        if (url.endsWith('/api/doctor')) return doctorOk;
        if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
        if (url.endsWith('/api/settings/tiers')) return defaultTiers;
        if (url.endsWith('/api/status')) return status;
        if (url.endsWith('/api/board')) return { ...board, repos: [board.repos[0]!, { ...board.repos[0]!, repo: { ...repo, id: 'r2' }, batches: [], cards: [] }] };
        if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
        if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
        if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
        throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
      });
      location.hash = '#chat';
      render(<App />);
      await waitFor(() => expect(screen.getByTitle('E:/Projects/two')).toBeTruthy());
      fireEvent.click(screen.getByTitle('E:/Projects/two'));
      await waitFor(() => expect(screen.getByText('Ready task')).toBeTruthy());
      expect(scrolls.filter(Boolean)).toEqual(['repo-r2']); // the Chat thread scrolls its own bottom marker too
    } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
  });

  it('does not clobber a manual navigation with a slow-to-resolve doctor', async () => {
    let resolveDoctor!: (d: DoctorResponse) => void;
    const doctorPromise = new Promise<DoctorResponse>((resolve) => { resolveDoctor = resolve; });
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/doctor')) return doctorPromise;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/board')) return { bd_ok: true, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy());
    await act(async () => { resolveDoctor(doctorBad); await doctorPromise; });
    await waitFor(() => expect(screen.getByLabelText('setup needs attention')).toBeTruthy());
    expect(screen.getByPlaceholderText(/message the orchestrator/i)).toBeTruthy();
  });

  it('opens Plans from Office, lists every status newest first, and Back returns to the list or Office strip', async () => {
    const draft = { id: 'r1-p1', repo_id: 'r1', title: 'Accounts plan', status: 'draft', batch_id: null, revision: 1, created_at: '2026-09-01T00:00:00.000Z', updated_at: 't', steps: [{ title: 'Accounts table', description: '', dependsOn: [] }] };
    const approved = { id: 'r1-p2', repo_id: 'r1', title: 'Billing plan', status: 'approved', batch_id: 'r1-b1', revision: 1, created_at: '2026-09-02T00:00:00.000Z', updated_at: 't', steps: [{ title: 'Billing table', description: '', dependsOn: [] }] };
    const discarded = { id: 'r1-p3', repo_id: 'r1', title: 'Legacy plan', status: 'discarded', batch_id: null, revision: 1, created_at: '2026-09-03T00:00:00.000Z', updated_at: 't', steps: [{ title: 'Legacy table', description: '', dependsOn: [] }] };
    mockApi((method, url) => {
      if (url.endsWith('/api/plans')) return [draft];
      if (url.endsWith('/api/plans/all')) return [discarded, approved, draft]; // the daemon answers newest first
      if (url.endsWith('/api/plans/r1-p2')) return approved;
      if (url.endsWith('/api/plans/r1-p1')) return draft;
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 1, started_at: 't', commit: 'a', source_head: 'a', restart_needed: false };
      if (url.endsWith('/api/board')) return board;
      if (url.endsWith('/api/chat')) return [];
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    await screen.findByTestId('needs-strip');
    fireEvent.click(await screen.findByRole('button', { name: 'plans' }));
    const heading = await screen.findByRole('heading', { name: 'Plans' });
    const rows = [...heading.closest('.plan-list')!.querySelectorAll('button.needs-row')];
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual(['Legacy plan, discarded, 1 step', 'Billing plan, approved, 1 step', 'Accounts plan, draft, 1 step']);
    const nav = screen.getByRole('navigation', { name: 'Views' });
    expect([...nav.querySelectorAll('button')].map((b) => b.textContent?.replace(/\d+$/, ''))).toEqual(['Office', 'Board', 'Chat', 'Review', 'Usage', 'DiscussionsExperimental', 'Evidence', 'Setup']);
    fireEvent.click(screen.getByRole('button', { name: 'Billing plan, approved, 1 step' }));
    expect((await screen.findByTestId('read-Plan title')).textContent).toBe('Billing plan');
    expect(location.hash).toBe('#plan/r1-p2');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Plans' }); // Back returned to the list.
    expect(location.hash).toBe('#plan');
    fireEvent.click(screen.getByRole('button', { name: 'Office' }));
    fireEvent.click(await screen.findByRole('button', { name: 'plan: Accounts plan' }));
    await screen.findByTestId('read-Plan title');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByTestId('needs-strip');
    await waitFor(() => expect(location.hash).toBe('#office'));
  });

  it('shows open programs on the Plans page, refreshes them on a board message and opens a batch card in the batch panel', async () => {
    let title = 'Accounts rework';
    const program = (): ProgramDetail => ({ id: 'pg1', repo_id: 'r1', title, status: 'open', created_at: 't', origin_chat_id: null, batches: [{ program_id: 'pg1', batch_id: 'r1-b1', lane: 'api', position: 0, title: '#9310 Trend chart', status: 'open', beads_total: 4, beads_done: 2, beads_closed: 0 }], waits: [], entries: [], merge_order: ['r1-b1'] });
    mockApp(board, chat, [], { programs: () => [program()] });
    history.replaceState(null, '', '#plan');
    render(<App />);
    expect(await screen.findByRole('region', { name: 'Accounts rework' })).toBeTruthy();
    title = 'Accounts rework, renamed';
    act(() => lastSocket().push({ type: 'board' }));
    expect(await screen.findByRole('region', { name: 'Accounts rework, renamed' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /#9310 Trend chart/ }));
    expect(await screen.findByRole('complementary', { name: 'Batch details for r1-b1' })).toBeTruthy();
    expect(location.hash).toBe('#plan');
  });

  it('opens a cold plan hash and Back falls back to the Office strip', async () => {
    let planStatus: 'draft' | 'approved' = 'draft';
    const plan = () => ({ id: 'r1-p1', repo_id: 'r1', title: 'Accounts plan', status: planStatus, batch_id: planStatus === 'approved' ? 'r1-b1-aaaa' : null, revision: 1, created_at: 't', updated_at: 't', steps: [{ title: 'Accounts table', description: '', dependsOn: [] }] });
    mockApi((method, url) => {
      if (url.endsWith('/api/plans')) return planStatus === 'draft' ? [plan()] : [];
      if (url.endsWith('/api/plans/all')) return [plan()];
      if (url.endsWith('/api/plans/r1-p1')) return plan();
      if (method === 'POST' && url.endsWith('/approve')) { planStatus = 'approved'; return plan(); }
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 1, started_at: 't', commit: 'a', source_head: 'a', restart_needed: false };
      if (url.endsWith('/api/board')) return board;
      if (url.endsWith('/api/chat')) return [];
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#plan/r1-p1');
    render(<App />);
    await screen.findByTestId('read-Plan title');
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await screen.findByTestId('needs-strip');
    await waitFor(() => expect(location.hash).toBe('#office'));
  });

  it('draws an office character from an office message and opens its task pane in place, staying on the office', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0); // the walk is not under test here
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.includes('/api/tasks/')) return reviewDetail;
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    // The daemon sends the whole office set as one snapshot on connect.
    lastSocket().push({ type: 'office_snapshot', sessions: [{ session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'walking_in', stalled_since: null }] });
    fireEvent.click(await screen.findByRole('button', { name: 'claude · sonnet · ov-5' }));
    await screen.findByRole('complementary', { name: 'Details of ov-5' });
    await screen.findByText('Description of Review task');
    // Opening the pane left the view where it was: still the office, not the board.
    expect(location.hash).toBe('#office');
    expect(document.querySelector('.office-stage')).toBeTruthy();
    expect(document.querySelector('.board-layout')).toBeNull();
  });

  it('keeps the office’s last-known characters, dimmed and frozen, while the socket is lost', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.includes('/api/tasks/')) return reviewDetail;
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    lastSocket().push({ type: 'office_snapshot', sessions: [{ session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null }] });
    await screen.findByRole('button', { name: 'claude · sonnet · ov-5' });
    // The socket drops: the shell keeps the set, so the room stays drawn instead of collapsing to the empty note.
    act(() => lastSocket().close());
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-5' })).toBeTruthy();
    expect(screen.getByText('Activity unavailable, reconnecting')).toBeTruthy();
    expect(screen.queryByText('No sessions are running, so the office is empty.')).toBeNull();
    expect(document.querySelector('.office-stage')?.className).toContain('office-offline');
  });

  it('drops an office character the reconnect snapshot no longer names', async () => {
    // Frames are driven by hand: the character leaves by walking to the door, which takes a bounded number of them.
    const frame = officeFrames();
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.includes('/api/tasks/')) return reviewDetail;
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    const s1 = { session_id: 's1', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'working' as const, stalled_since: null };
    const s2 = { ...s1, session_id: 's2', bead_id: 'ov-6', model: 'opus' };
    lastSocket().push({ type: 'office_snapshot', sessions: [s1, s2] });
    await screen.findByRole('button', { name: 'claude · sonnet · ov-5' });
    await waitFor(() => expect(officeLoop()).toBeTypeOf('function'));
    // s1 ends while the socket is down, so no `leaving` arrives; the fresh snapshot the daemon sends on reconnect omits it
    // and replaces the whole set.
    // The room stays frozen while reconnecting, so the socket reopens before the snapshot lands.
    const first = lastSocket();
    vi.useFakeTimers();
    try {
      act(() => first.close());
      await vi.advanceTimersByTimeAsync(1000);
    } finally { vi.useRealTimers(); }
    const second = lastSocket();
    expect(second).not.toBe(first);
    act(() => second.onopen?.());
    act(() => second.push({ type: 'office_snapshot', sessions: [s2] }));
    const agent = (id: string) => document.querySelector<HTMLButtonElement>(`.office-char[data-agent-id="${id}"]`);
    const gone = () => agent('s1') === null;
    for (let i = 0; i < 4000 && !gone(); i++) frame();
    expect(gone()).toBe(true);
    expect(agent('s2')).toBeTruthy();
  });

  it('replaces the office set on a second snapshot over the same open socket', async () => {
    // Same frame driver: the dropped character walks to the door before it is removed, so the loop must tick.
    const frame = officeFrames();
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.includes('/api/tasks/')) return reviewDetail;
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#office');
    render(<App />);
    const s1 = { session_id: 's1', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'working' as const, stalled_since: null };
    const s2 = { ...s1, session_id: 's2', bead_id: 'ov-6', model: 'opus' };
    lastSocket().push({ type: 'office_snapshot', sessions: [s1, s2] });
    await screen.findByRole('button', { name: 'claude · sonnet · ov-5' });
    await waitFor(() => expect(officeLoop()).toBeTypeOf('function'));
    // The socket stays open: the second snapshot must still replace the whole set, dropping the session it no longer names.
    lastSocket().push({ type: 'office_snapshot', sessions: [s2] });
    const agent = (id: string) => document.querySelector<HTMLButtonElement>(`.office-char[data-agent-id="${id}"]`);
    const gone = () => agent('s1') === null;
    for (let i = 0; i < 4000 && !gone(); i++) frame();
    expect(gone()).toBe(true);
    expect(agent('s2')).toBeTruthy();
  });

  const officeApi = (method: string, url: string) => {
    if (url.endsWith('/api/repos')) return [repo];
    if (url.endsWith('/api/doctor')) return doctorOk;
    if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
    if (url.endsWith('/api/settings/tiers')) return defaultTiers;
    if (url.endsWith('/api/status')) return status;
    if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
    if (url.endsWith('/api/board')) return board;
    if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
    if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
    if (url.includes('/api/tasks/')) return reviewDetail;
    if (url.endsWith('/api/plans')) return [];
    if (url.endsWith('/api/plans/all')) return [];
    throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
  };

  it('opens Chat from the orchestrator character when the measured Office width cannot dock it', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0); // the walk is not under test here
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const restoreMeasure = measuredOfficeForDock(1500, 1200);
    mockApi(officeApi);
    history.replaceState(null, '', '#office');
    try {
      render(<App />);
      lastSocket().push({ type: 'office_snapshot', sessions: [{ session_id: 'orch', role: 'orchestrator', harness: 'claude', model: 'opus', account_label: null, bead_id: null, bead_title: null, batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null }] });
      const orchestrator = await screen.findByRole('button', { name: 'claude · opus · orchestrator (opens Chat)' });
      expect((orchestrator as HTMLButtonElement).disabled).toBe(false);
      expect(document.querySelector('.office-chat-dock')).toBeNull();
      fireEvent.click(orchestrator);
      await screen.findByPlaceholderText(/message the orchestrator/i);
      expect(location.hash).toBe('#chat');
    } finally {
      restoreMeasure();
    }
  });

  it('opens Chat at the latest row after a Board round trip', async () => {
    let rows = [chat[0]!, chat[1]!];
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows, has_more: false, oldest_id: rows[0]?.id ?? null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans') || url.endsWith('/api/plans/all')) return [];
      throw new Error(`unexpected ${method} ${url}`);
    });
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });
    try {
      history.replaceState(null, '', '#chat');
      render(<App />);
      await screen.findByText(chat[1]!.text);
      const firstThread = screen.getByRole('log') as HTMLDivElement;
      firstThread.scrollTop = 100;
      fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
      rows = [...rows, { ...chat[1]!, id: 99, text: 'a fresh arrival' }];
      act(() => lastSocket().push({ type: 'chat' }));
      fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
      await screen.findByText('a fresh arrival');
      const thread = screen.getByRole('log') as HTMLDivElement;
      expect(thread.scrollTop).toBe(thread.scrollHeight);
      expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('a fresh arrival');
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    } finally {
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
      else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (client) Object.defineProperty(HTMLElement.prototype, 'clientHeight', client);
      else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it('keeps the Chat unread divider across an Office round trip while opening at the latest row', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    let rows = [chat[0]!, chat[1]!];
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows, has_more: false, oldest_id: rows[0]?.id ?? null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    history.replaceState(null, '', '#chat');
    render(<App />);
    await screen.findByText(chat[1]!.text);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    // Away to Office, where a new arrival lands while Chat is unmounted.
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));
    rows = [...rows, { ...chat[1]!, id: 99, text: 'a fresh arrival' }];
    act(() => lastSocket().push({ type: 'chat' }));

    // Back in Chat the arrival is marked unread, though the thread opens at the latest row.
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await screen.findByText('a fresh arrival');
    expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('a fresh arrival');
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('keeps the office desks and characters when another view shows and the office returns', async () => {
    // Frames are driven by hand: the walk-in finishes in a bounded number of them.
    const frame = officeFrames();
    mockApi(officeApi);
    history.replaceState(null, '', '#office');
    render(<App />);
    const s1 = { session_id: 's1', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'working' as const, stalled_since: null };
    lastSocket().push({ type: 'office_snapshot', sessions: [s1] });
    await screen.findByRole('button', { name: 'claude · sonnet · ov-5' });
    await waitFor(() => expect(officeLoop()).toBeTypeOf('function'));
    const char = () => screen.getByRole('button', { name: 'claude · sonnet · ov-5' });
    const atDesk = () => drawnOfficeAtDesk('s1');
    for (let i = 0; i < 4000 && !atDesk(); i++) frame();
    expect(atDesk()).toBe(true);
    const seated = char().getAttribute('style');

    // Away through the rail: the office wrapper is hidden but still mounted, so its scene is intact.
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    expect(location.hash).toBe('#board');
    expect(document.querySelector('.board-layout')).toBeTruthy();
    expect(document.querySelector('.office-hold')?.hasAttribute('hidden')).toBe(true);

    // Back: the same character is at the same desk immediately, and still there a frame later: no walk-in replay, no reshuffled desk.
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));
    expect(location.hash).toBe('#office');
    expect(document.querySelector('.office-hold')?.hasAttribute('hidden')).toBe(false);
    expect(char().getAttribute('style')).toBe(seated);
    frame();
    expect({ style: char().getAttribute('style'), atDesk: atDesk() }).toEqual({ style: seated, atDesk: true });
  });

  it('walks out a session that ended while away and in one that started while away, leaving a seated one untouched', async () => {
    const frame = officeFrames();
    mockApi(officeApi);
    history.replaceState(null, '', '#office');
    render(<App />);
    const s1 = { session_id: 's1', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'working' as const, stalled_since: null };
    const s2 = { ...s1, session_id: 's2', bead_id: 'ov-6', model: 'opus' };
    lastSocket().push({ type: 'office_snapshot', sessions: [s1, s2] });
    await screen.findByRole('button', { name: 'claude · opus · ov-6' });
    await waitFor(() => expect(officeLoop()).toBeTypeOf('function'));
    const char = (name: string) => screen.getByRole('button', { name });
    const agent = (id: string) => document.querySelector<HTMLButtonElement>(`.office-char[data-agent-id="${id}"]`);
    const seated = (id: string) => agent(id) !== null && drawnOfficeAgent(id)?.pose === 'arrived';
    for (let i = 0; i < 4000 && !(seated('s1') && seated('s2')); i++) frame();
    expect(seated('s1') && seated('s2')).toBe(true);
    const seated2 = agent('s2')?.getAttribute('style') ?? null;

    // The view is left, and while it is hidden s1 ends (the feed drops it) and s3 starts.
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    act(() => lastSocket().push({ type: 'office', session: { ...s1, state: 'leaving' } }));
    act(() => lastSocket().push({ type: 'office', session: { ...s1, session_id: 's3', bead_id: 'ov-7', model: 'codex', state: 'walking_in' } }));
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));

    // The seated character never moved; the ended one walks out and the new one walks in.
    expect(char('claude · opus · ov-6').getAttribute('style')).toBe(seated2);
    const gone = () => agent('s1') === null;
    for (let i = 0; i < 4000 && !gone(); i++) frame();
    expect(gone()).toBe(true);
    for (let i = 0; i < 4000 && !seated('s3'); i++) frame();
    expect(seated('s3')).toBe(true);
  });

  it('never shows the empty office note between a socket reconnect and the snapshot that follows', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mockApi(officeApi);
    history.replaceState(null, '', '#office');
    render(<App />);
    // The connect snapshot is empty: a loaded and genuinely empty office says so.
    lastSocket().push({ type: 'office_snapshot', sessions: [] });
    await screen.findByText('No sessions are running, so the office is empty.');

    // The socket drops, then reopens before the new snapshot: the held set is stale, not empty.
    const first = lastSocket();
    vi.useFakeTimers();
    try {
      act(() => first.close());
      await vi.advanceTimersByTimeAsync(1000);
    } finally { vi.useRealTimers(); }
    const second = lastSocket();
    expect(second).not.toBe(first);
    act(() => second.onopen?.());
    expect(screen.queryByText('No sessions are running, so the office is empty.')).toBeNull();
    expect(screen.getByText('Activity unavailable, reconnecting')).toBeTruthy();
    expect(document.querySelector('.office-stage')?.className).toContain('office-offline');

    // The snapshot lands: an empty set is once more called empty.
    act(() => lastSocket().push({ type: 'office_snapshot', sessions: [] }));
    expect(screen.getByText('No sessions are running, so the office is empty.')).toBeTruthy();
  });

  it('keeps the office scene when the phone tab bar leaves it and returns from the rail Office tab', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const frame = officeFrames();
    mockApi(officeApi);
    history.replaceState(null, '', '#office');
    render(<App />);
    const s1 = { session_id: 's1', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-5', bead_title: 'Review task', batch_id: null, repo_id: 'r1', state: 'working' as const, stalled_since: null };
    lastSocket().push({ type: 'office_snapshot', sessions: [s1] });
    await screen.findByRole('button', { name: 'claude · sonnet · task ov-5 · repository r1 (shows details)' });
    await waitFor(() => expect(officeLoop()).toBeTypeOf('function'));
    const char = () => screen.getByRole('button', { name: 'claude · sonnet · task ov-5 · repository r1 (shows details)' });
    const atDesk = () => drawnOfficeAtDesk('s1');
    for (let i = 0; i < 4000 && !atDesk(); i++) frame();
    expect(atDesk()).toBe(true);
    const seated = char().getAttribute('style');

    // Office stays mounted while the tab bar visits Board and Setup; the Office tab returns to it.
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    expect(location.hash).toBe('#board');
    fireEvent.click(screen.getByRole('button', { name: /^Setup/ }));
    expect(location.hash).toBe('#setup');
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));
    expect(location.hash).toBe('#office');
    expect(screen.getByRole('button', { name: /^Office/ }).getAttribute('aria-current')).toBe('page');
    expect({ style: char().getAttribute('style'), atDesk: atDesk() }).toEqual({ style: seated, atDesk: true });
  });

  // Every way into the Usage view: the rail entry (desktop), the Setup → General link (the phone's only one) and a typed #usage.
  it('opens Usage from the rail, from Setup and from the hash', async () => {
    const usage = {
      from: '2026-08-19', to: '2026-09-17', days: [], days_by_model: [],
      totals: { sessions: 1, reported_cost: 2, reported_unknown: 0, estimated_cost: 1, estimated_unknown: 0, codex_sessions: 0, tokens: { input: 5, output: 5, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } },
      groups: {},
    };
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/usage')) return usage;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      if (url.endsWith('/api/daemon')) return { pid: 1, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      if (url.endsWith('/api/push/key')) return { key: null };
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<App />);
    // 1. the rail entry
    fireEvent.click(await screen.findByRole('button', { name: 'Usage' }));
    expect(await screen.findByRole('heading', { name: 'Usage', level: 2 })).toBeTruthy();
    await waitFor(() => expect(location.hash).toBe('#usage'));
    // 2. Setup → General, which is how a phone gets there with no sixth tab
    fireEvent.click(screen.getByRole('button', { name: /^Setup/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open usage' }));
    expect(await screen.findByRole('heading', { name: 'Usage', level: 2 })).toBeTruthy();
    // 3. a typed hash
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(location.hash).toBe('#board'));
    act(() => { location.hash = '#usage'; dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: 'Usage', level: 2 })).toBeTruthy();
  });

  it('opens an Evidence folder from its hash after a reload', async () => {
    mockApp(board, [], [], { repos: [] });
    location.hash = '#evidence/office-pixi-style';
    render(<App />);
    expect({ heading: await screen.findByRole('heading', { name: 'office-pixi-style', level: 2 }).then((el) => el.textContent), empty: await screen.findByText('This folder is empty.').then((el) => el.textContent), hash: location.hash }).toEqual({ heading: 'office-pixi-style', empty: 'This folder is empty.', hash: '#evidence/office-pixi-style' });
  });

  it('opens Discussions from the rail and refetches the list on a discussion ping', async () => {
    let listCalls = 0;
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 1, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      if (method === 'GET' && url.endsWith('/api/discussions')) { listCalls++; return [discussionSummary]; }
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#discussions';
    render(<App />);
    expect(await screen.findByText('Which storage engine?')).toBeTruthy();
    const before = listCalls;
    act(() => { lastSocket().push({ type: 'discussion', id: 'd-1' }); });
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });

  it('opens a discussion thread from its hash', async () => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return discussionDetail;
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#discussions/d-1';
    render(<App />);
    expect(await screen.findByText('Postgres.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('starts a discussion from the form and navigates to its thread', async () => {
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (url.endsWith('/api/repos')) return [repo];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/board')) return board;
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      if (method === 'POST' && url.endsWith('/api/discussions')) { posts.push(body); return discussionDetail; }
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return discussionDetail;
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = '#discussions';
    render(<App />);
    await screen.findByText('No discussions yet. Ask a question above to start one.');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Which storage engine?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(location.hash).toBe('#discussions/d-1'));
    expect(await screen.findByText('Postgres.')).toBeTruthy();
    expect(posts).toHaveLength(1);
  });
  it.each([
    ['#discussions', 'Which storage engine?'],
    ['#discussions/d-1', 'Postgres.'],
  ])('keeps %s open on an install with no repositories', async (hash, text) => {
    mockApi((method, url) => {
      if (url.endsWith('/api/repos')) return [];
      if (url.endsWith('/api/doctor')) return doctorOk;
      if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
      if (url.endsWith('/api/settings/tiers')) return defaultTiers;
      if (url.endsWith('/api/status')) return status;
      if (url.endsWith('/api/daemon')) return { pid: 1, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
      if (url.endsWith('/api/board')) return { ...board, repos: [] };
      if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null };
      if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
      if (url.endsWith('/api/plans')) return [];
      if (url.endsWith('/api/plans/all')) return [];
      if (method === 'GET' && url.endsWith('/api/discussions')) return [discussionSummary];
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return discussionDetail;
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    location.hash = hash;
    render(<App />);
    expect(await screen.findByText(text)).toBeTruthy();
    // The repos and doctor fetches the redirect waits on have answered by now, so a redirect would already have run.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(location.hash).toBe(hash);
    expect(screen.queryByRole('heading', { name: 'Repositories' })).toBeNull();
  });

  it('keeps an Office milestone through a character leave and reconnect snapshot, then expires it once', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mockApp(board);
    history.replaceState(null, '', '#office');
    render(<App />);
    await screen.findByTestId('needs-strip');
    const session = { session_id: 's1', role: 'worker' as const, harness: 'claude', model: 'sonnet', account_label: null, bead_id: 'ov-9', bead_title: 'Milestone task', batch_id: 'r2-b4', repo_id: 'r2', state: 'verifying' as const, stalled_since: null };
    act(() => { lastSocket().push({ type: 'office_snapshot', sessions: [session] }); });
    expect(screen.getByRole('button', { name: 'claude · sonnet · ov-9' })).toBeTruthy();
    await waitFor(() => expect(drawnOfficeAgent('s1')).toBeTruthy());
    // The verification mark is drawn by the Pixi scene (on the QA wall screen), so it is read from the scene's last draw.
    const mark = () => drawnOfficeEffects()?.printer?.kind ?? null;

    vi.useFakeTimers();
    try {
      act(() => { lastSocket().push(officeMilestone('verify_passed')); });
      expect(mark()).toBe('verify_passed');
      act(() => { vi.advanceTimersByTime(1_000); });
      act(() => { lastSocket().push({ type: 'office', session: { ...session, state: 'leaving' as const } }); });
      expect(mark()).toBe('verify_passed');
      act(() => { lastSocket().push({ type: 'office_snapshot', sessions: [] }); });
      expect(mark()).toBe('verify_passed');
      act(() => { vi.advanceTimersByTime(1_999); });
      expect(mark()).toBe('verify_passed');
      act(() => { vi.advanceTimersByTime(1); });
      expect(mark()).toBeNull();
      act(() => { lastSocket().push({ type: 'office_snapshot', sessions: [session] }); });
      expect(mark()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('drops an Office milestone received while another view is active', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mockApp(board);
    history.replaceState(null, '', '#office');
    render(<App />);
    await screen.findByTestId('needs-strip');
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    await waitFor(() => expect(location.hash).toBe('#board'));
    act(() => { lastSocket().push(officeMilestone('verify_failed')); });
    fireEvent.click(screen.getByRole('button', { name: /^Office/ }));
    await waitFor(() => expect(location.hash).toBe('#office'));
    await waitFor(() => expect(drawnOfficeEffects()).toBeTruthy());

    expect(drawnOfficeEffects()?.printer).toBeNull();
  });
});
