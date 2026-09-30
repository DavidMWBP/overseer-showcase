import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { useRef, useState, type ComponentProps } from 'react';
import { render, screen, waitFor, fireEvent, cleanup, act, within } from '@testing-library/react';
import type { ChatRow, RepoCommand } from '@overseer/shared';
import { Chat, orderThread, groupThread, formatTime, dayLabel, OUTAGE_LOAD, OUTAGE_LOAD_NONE, OUTAGE_SEND, PICK_REPO } from './Chat';
import type { AttachmentHost, PendingAttachment } from '../components/AttachmentPicker';
import { mockApi } from '../test/setup';
import { board, chat, repo } from '../test/fixtures';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The shell owns the draft and the pending attachments so they outlive the composer's unmount; these tests stand in for it
 * with the same lift in a wrapper, so a render of <Chat> here behaves like the app's Chat and a rerender keeps what was typed.
 */
function TestChat({ initialText = '', draftQuestionIds: initialQuestionIds = null, onDraftQuestionIds: _onDraftQuestionIds, attachmentQuestionIds: initialAttachmentQuestionIds = null, onAttachmentQuestionIds: _onAttachmentQuestionIds, ...props }: Omit<ComponentProps<typeof Chat>, 'text' | 'draftRev' | 'onText' | 'onClearText' | 'attachments' | 'draftQuestionIds' | 'onDraftQuestionIds' | 'attachmentQuestionIds' | 'onAttachmentQuestionIds'> & { initialText?: string; draftQuestionIds?: number[] | null; onDraftQuestionIds?: (ids: number[] | null) => void; attachmentQuestionIds?: number[] | null; onAttachmentQuestionIds?: (ids: number[] | null) => void }) {
  const [text, setText] = useState(initialText);
  const [draftRev, setDraftRev] = useState(0);
  const [questionIds, setQuestionIds] = useState<number[] | null>(initialQuestionIds);
  const [attachmentQuestionIds, setAttachmentQuestionIds] = useState<number[] | null>(initialAttachmentQuestionIds);
  const rev = useRef(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const owned: AttachmentHost = { attachments, setAttachments, hint, setHint };
  return <Chat {...props} text={text} draftRev={draftRev} draftQuestionIds={questionIds} onDraftQuestionIds={setQuestionIds} attachmentQuestionIds={attachmentQuestionIds} onAttachmentQuestionIds={setAttachmentQuestionIds} onText={(next) => { setText(next); setDraftRev(++rev.current); }}
    onClearText={(_repo, sentRev) => { if (rev.current === sentRev) { setText(''); setQuestionIds(null); setDraftRev(++rev.current); } }} attachments={owned} />;
}

const commandEntry = (name: string, description = '', source: RepoCommand['source'] = 'repo'): RepoCommand => ({ name, description, kind: 'command', source });
const pendingQuestion = (id: number, text: string): ChatRow => ({ ...chat[2]!, id, text, answer: null, answered_at: null, superseded_at: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function renderCommandChat(commands: RepoCommand[] | Error, repoId = 'r1', repos = [repo], initialText = '') {
  const commandRequests: string[] = [];
  const sent: unknown[] = [];
  mockApi((method, url, body) => {
    if (url.endsWith('/commands')) {
      commandRequests.push(url);
      if (commands instanceof Error) throw commands;
      return commands;
    }
    if (method === 'POST' && url === '/api/chat') { sent.push(body); return { ok: true }; }
    return { rows: [], has_more: false, oldest_id: null };
  });
  const props = { repos, repo: repoId, onRepo: () => {} };
  const view = render(<TestChat version={0} {...props} initialText={initialText} />);
  return { ...view, input: screen.getByLabelText('Message the orchestrator') as HTMLTextAreaElement, commandRequests, sent };
}

describe('Chat', () => {
  it('does not focus the next answer box when a requested question is answered', async () => {
    let rows: ChatRow[] = [101, 102].map((id) => ({ ...chat[2]!, id, text: `Question ${id}?` }));
    mockApi((method, url, body) => {
      if (method === 'POST' && url.endsWith('/chat/answer')) {
        const questionId = (body as { question_id: number }).question_id;
        rows = rows.map((row) => row.id === questionId ? { ...row, answered_at: '2026-09-25T10:00:00.000Z' } : row);
        return { ok: true };
      }
      return rows;
    });
    const view = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} questionRequest={{ id: 101, sequence: 1 }} />);
    await screen.findByText('Question 101?');
    const answer = view.container.querySelector('.question-page-active textarea[aria-label="Your answer"]')!;
    await waitFor(() => expect(document.activeElement).toBe(answer));
    fireEvent.change(answer, { target: { value: 'Handled' } });
    fireEvent.click(view.container.querySelector('.question-page-active .question-actions button')!);
    await screen.findByText('Question 102?');
    expect(document.activeElement).not.toBe(view.container.querySelector('.question-page-active textarea[aria-label="Your answer"]'));
  });

  it('pages open questions by id, keeps drafts, and follows answered, superseded, and arriving questions', async () => {
    const questions: ChatRow[] = [1, 2, 3, 4].map((id) => ({ ...chat[2]!, id: 100 + id, text: `Question ${id}?`, answer: null, answered_at: null, superseded_at: null }));
    let rows: ChatRow[] = questions.slice(0, 3);
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'POST' && url.includes('/chat/answer')) {
        posts.push(body);
        rows = rows.map((q) => q.id === (body as { question_id: number }).question_id
          ? { ...q, answer: 'First answer', answered_at: '2026-09-16T12:01:00.000Z' } : q);
        return { ok: true };
      }
      if (method === 'POST' && url.endsWith('/chat')) {
        rows = rows.map((q) => q.id === 102 ? { ...q, superseded_at: '2026-09-16T12:02:00.000Z' } : q);
        return { ok: true };
      }
      return rows;
    });
    const props = { repos: [repo], repo: 'r1', onRepo: () => {} };
    const view = render(<TestChat version={0} {...props} />);
    await screen.findByText('Question 1?');
    const pinned = view.container.querySelector('.pinned')!;
    const visible = () => pinned.querySelector('.question-page-active .question-text')?.textContent;
    expect(pinned.querySelectorAll('.question-page-active')).toHaveLength(1);
    expect(visible()).toBe('Question 1?');
    expect(screen.getByText('Question 1 of 3')).toBeTruthy();
    fireEvent.change(pinned.querySelector('.question-page-active textarea')!, { target: { value: 'draft one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(visible()).toBe('Question 2?');
    expect(screen.getByText('Question 2 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(visible()).toBe('Question 1?');
    expect((pinned.querySelector('.question-page-active textarea') as HTMLTextAreaElement).value).toBe('draft one');
    fireEvent.click(within(pinned.querySelector('.question-page-active') as HTMLElement).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(posts).toEqual([{ question_id: 101, text: 'draft one' }]));
    await waitFor(() => expect(visible()).toBe('Question 2?'));
    expect(screen.getByText('Question 1 of 2')).toBeTruthy();
    // Sending in the composer supersedes the question; the next thread response carries the daemon's flag.
    fireEvent.change(screen.getByLabelText('Message the orchestrator'), { target: { value: 'I will handle that' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(visible()).toBe('Question 3?'));
    expect(screen.queryByText(/of 2/)).toBeNull();
    expect(pinned.querySelectorAll('.question')).toHaveLength(1);
    rows = [...rows, questions[3]!];
    view.rerender(<TestChat version={2} {...props} />);
    await waitFor(() => expect(screen.getByText('Question 1 of 2')).toBeTruthy());
    expect(visible()).toBe('Question 3?');
    rows = rows.map((q) => q.id >= 103 ? { ...q, answered_at: '2026-09-16T12:03:00.000Z' } : q);
    view.rerender(<TestChat version={3} {...props} />);
    await waitFor(() => expect(view.container.querySelector('.pinned')).toBeNull());
  });

  it('keeps the selected question when a new one arrives and hides the counter for one', async () => {
    const questions: ChatRow[] = [1, 2, 3, 4].map((id) => ({ ...chat[2]!, id: 100 + id, text: `Question ${id}?`, answer: null, answered_at: null, superseded_at: null }));
    let rows: ChatRow[] = questions.slice(0, 3);
    mockApi(() => rows);
    const props = { repos: [repo], repo: 'r1', onRepo: () => {} };
    const view = render(<TestChat version={0} {...props} />);
    await screen.findByText('Question 1?');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    rows = questions;
    view.rerender(<TestChat version={1} {...props} />);
    await waitFor(() => expect(screen.getByText('Question 2 of 4')).toBeTruthy());
    expect(view.container.querySelector('.question-page-active .question-text')?.textContent).toBe('Question 2?');
    rows = questions.map((q) => q.id === 102 ? q : { ...q, superseded_at: '2026-09-16T12:02:00.000Z' });
    view.rerender(<TestChat version={2} {...props} />);
    await waitFor(() => expect(view.container.querySelectorAll('.question')).toHaveLength(1));
    expect(view.container.querySelector('.question-pager')).toBeNull();
  });

  it('resets the pager to the oldest when every open question closes and new ones arrive', async () => {
    const first: ChatRow[] = [1, 2, 3].map((id) => ({ ...chat[2]!, id: 100 + id, text: `Question ${id}?`, answer: null, answered_at: null, superseded_at: null }));
    const next: ChatRow[] = [1, 2, 3].map((id) => ({ ...chat[2]!, id: 200 + id, text: `New question ${id}?`, answer: null, answered_at: null, superseded_at: null }));
    let rows: ChatRow[] = first;
    mockApi(() => rows);
    const props = { repos: [repo], repo: 'r1', onRepo: () => {} };
    const view = render(<TestChat version={0} {...props} />);
    await screen.findByText('Question 1?');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Question 3 of 3')).toBeTruthy();
    expect(view.container.querySelector('.question-page-active .question-text')?.textContent).toBe('Question 3?');
    rows = first.map((q) => ({ ...q, answered_at: '2026-09-16T12:03:00.000Z' }));
    view.rerender(<TestChat version={1} {...props} />);
    await waitFor(() => expect(view.container.querySelector('.pinned')).toBeNull());
    rows = next;
    view.rerender(<TestChat version={2} {...props} />);
    await waitFor(() => expect(screen.getByText('Question 1 of 3')).toBeTruthy());
    expect(view.container.querySelector('.question-page-active .question-text')?.textContent).toBe('New question 1?');
  });

  it('shows only the selected question card with the pager at every width, desktop included', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    // Top-level rules (at the start of a line, outside any media query), so a desktop width pages the same way a phone does.
    expect(css).toMatch(/\n\.question-pager \{ display: flex;/);
    expect(css).toMatch(/\n\.question-page-inactive \{ display: none; \}/);
    expect(css).not.toMatch(/\.question-pager\s*\{\s*display:\s*none/);
  });

  // Geometry (the measured cap, overflow and positions) is checked in a real browser by test:chat-layout; these pair the DOM with
  // the stylesheet rules that produce it, so deleting a rule fails here too.
  describe('pinned question card', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';
    const longQuestion = ['Which option?', '- Option A: split the question.', '- Option B: cap the card.', 'Pick one.'].join('\n');
    const renderQuestions = async (...texts: string[]) => {
      mockApi(() => texts.map((text, i) => ({ ...chat[2]!, id: 101 + i, text })));
      const view = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
      await waitFor(() => expect(view.container.querySelector('.pinned .question-text')).not.toBeNull());
      return view.container.querySelector('.pinned') as HTMLElement;
    };

    it('caps the pinned card at 40% of the visible height', async () => {
      const pinned = await renderQuestions('Short question?');
      expect(pinned.querySelector('.question-text')).not.toBeNull();
      expect(rule('.pinned')).toMatch(/display: flex; flex-direction: column;[^]*max-height: 40dvh; overflow-y: auto;/);
      expect(rule('.chat-visual-viewport .pinned')).toBe(' max-height: calc(var(--visual-viewport-height) * 0.4); ');
    });

    it('sizes a short question by its content, with no fixed height to leave space or a scrollbar', async () => {
      const pinned = await renderQuestions('Short question?');
      expect(pinned.querySelector('.question-text')?.textContent).toBe('Short question?');
      expect(rule('.question-text')).toMatch(/min-height: 1\.5em; flex: 0 1 auto;/);
      expect(rule('.question-text')).not.toMatch(/(^|[ ;])(max-)?height:/);
    });

    it('scrolls a long question inside .question-text while the answer box and buttons stay outside it', async () => {
      const pinned = await renderQuestions(longQuestion);
      const text = pinned.querySelector('.question-text') as HTMLElement;
      const controls = [screen.getByRole('textbox', { name: 'Your answer' }), screen.getByRole('button', { name: 'Answer' }), screen.getByRole('button', { name: 'Dismiss' })];
      expect(controls.map((control) => pinned.contains(control) && !text.contains(control))).toEqual([true, true, true]);
      expect(rule('.question-text')).toContain('overflow-y: auto;');
      expect(rule('.pinned > .question-pager, .question textarea, .question-actions')).toBe(' flex: none; ');
      expect(rule('.question-page-active, .question')).toBe(' display: contents; ');
    });

    it('keeps the pager in the card, unshrunk, with two or more questions', async () => {
      const pinned = await renderQuestions(longQuestion, 'Second question?');
      expect(within(pinned).getByText('Question 1 of 2').closest('.question-pager')?.parentElement).toBe(pinned);
      expect(rule('.pinned > .question-pager, .question textarea, .question-actions')).toContain('flex: none;');
    });

    it('keeps newlines and "- " lines as separate lines', async () => {
      const pinned = await renderQuestions(longQuestion);
      expect(pinned.querySelector('.question-text')?.textContent).toBe(longQuestion);
      expect(rule('.question-text')).toContain('white-space: pre-wrap;');
    });

    it('makes the question text a named tab stop so it scrolls from the keyboard', async () => {
      await renderQuestions(longQuestion);
      const region = screen.getByRole('region', { name: 'Question text' });
      expect([region.tabIndex, region.classList.contains('question-text')]).toEqual([0, true]);
    });
  });

  it('shows one chip for one linked batch and none for a message without a linked batch', async () => {
    mockApi(() => [chat[0], { ...chat[0]!, id: 2, text: 'unlinked request' }]);
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [{ ...board.repos[0]!.batches[0]!, origin_chat_id: chat[0]!.id, linked_chat_ids: [chat[0]!.id] }] }] }} />);
    expect(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Trend chart/ })).toHaveLength(1);
    expect(screen.getByText('unlinked request').parentElement?.querySelector('.chat-outcomes')).toBeNull();
  });

  it('passes clicked outcome batches to the host for every status', async () => {
    mockApi(() => chat);
    const onOpenBatch = vi.fn();
    const first = { ...board.repos[0]!.batches[0]!, origin_chat_id: chat[0]!.id, linked_chat_ids: [chat[0]!.id] };
    const second = { ...first, id: 'r1-b2', title: 'Second request' };
    const withBatches = (batches: typeof first[]) => ({ ...board, repos: [{ ...board.repos[0]!, batches }] });
    const view = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={withBatches([first, second])} onOpenBatch={onOpenBatch} />);
    expect(await screen.findByRole('button', { name: '#9310 Trend chart: in progress' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Second request: in progress' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '#9310 Trend chart: in progress' }));
    expect(onOpenBatch).toHaveBeenCalledWith(first);
    view.rerender(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={withBatches([{ ...first, status: 'review' }, second])} onOpenBatch={onOpenBatch} />);
    fireEvent.click(screen.getByRole('button', { name: '#9310 Trend chart: in review' }));
    expect(onOpenBatch).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'review' }));
    view.rerender(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={withBatches([{ ...first, status: 'merged' }, { ...second, status: 'abandoned' }])} onOpenBatch={onOpenBatch} />);
    fireEvent.click(screen.getByRole('button', { name: '#9310 Trend chart: merged' }));
    expect(onOpenBatch).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'merged' }));
    fireEvent.click(screen.getByRole('button', { name: 'Second request: abandoned' }));
    expect(onOpenBatch).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'abandoned' }));
    view.rerender(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={withBatches([])} onOpenBatch={onOpenBatch} />);
    expect(screen.queryByRole('button', { name: /Trend chart/ })).toBeNull();
  });

  it('shows an existing batch chip under a linked follow-up', async () => {
    mockApi(() => [chat[0], { ...chat[0]!, id: 2, text: 'follow-up' }]);
    const batch = { ...board.repos[0]!.batches[0]!, origin_chat_id: chat[0]!.id, linked_chat_ids: [chat[0]!.id, 2] };
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [batch] }] }} />);
    await screen.findByText('follow-up');
    expect(container.querySelectorAll('.msg-user')[1]?.querySelectorAll('.chat-outcome')).toHaveLength(1);
  });

  it('keeps the origin chip when a follow-up is linked', async () => {
    mockApi(() => [chat[0], { ...chat[0]!, id: 2, text: 'follow-up' }]);
    const batch = { ...board.repos[0]!.batches[0]!, origin_chat_id: chat[0]!.id, linked_chat_ids: [chat[0]!.id, 2] };
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [batch] }] }} />);
    await screen.findByText('follow-up');
    expect(container.querySelectorAll('.msg-user')[0]?.querySelectorAll('.chat-outcome')).toHaveLength(1);
  });

  it('shows two chips for two batches linked to one follow-up', async () => {
    mockApi(() => [{ ...chat[0]!, id: 2, text: 'follow-up' }]);
    const first = { ...board.repos[0]!.batches[0]!, linked_chat_ids: [2] };
    const second = { ...first, id: 'r1-b2', title: 'Another batch' };
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [first, second] }] }} />);
    await screen.findByText('follow-up');
    expect(container.querySelectorAll('.chat-outcome')).toHaveLength(2);
  });

  it('shows no chip when linked ids are empty', async () => {
    mockApi(() => [chat[0]]);
    const batch = { ...board.repos[0]!.batches[0]!, origin_chat_id: chat[0]!.id, linked_chat_ids: [] };
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [batch] }] }} />);
    await screen.findByText('add a greeting endpoint');
    expect(container.querySelectorAll('.chat-outcome')).toHaveLength(0);
  });

  it('deduplicates a message id within one batch', async () => {
    mockApi(() => [chat[0]]);
    const batch = { ...board.repos[0]!.batches[0]!, linked_chat_ids: [chat[0]!.id, chat[0]!.id] };
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [batch] }] }} />);
    await screen.findByText('add a greeting endpoint');
    expect(container.querySelectorAll('.chat-outcome')).toHaveLength(1);
  });

  it('falls back to the origin id for older board rows', async () => {
    mockApi(() => [chat[0]]);
    const batch = { ...board.repos[0]!.batches[0]!, origin_chat_id: chat[0]!.id, linked_chat_ids: undefined as unknown as number[] };
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} board={{ ...board, repos: [{ ...board.repos[0]!, batches: [batch] }] }} />);
    await screen.findByText('add a greeting endpoint');
    expect(container.querySelectorAll('.chat-outcome')).toHaveLength(1);
  });
  async function arrivalFixture(readThrough?: { current: number | null }) {
    let rows = [{ ...chat[0]!, id: 100, text: 'starting row' }];
    mockApi(() => ({ rows, has_more: false, oldest_id: 100 }));
    const props = { repos: [repo], repo: 'r1', onRepo: () => {}, readThrough };
    const view = render(<TestChat version={0} {...props} />);
    await screen.findByText('starting row');
    const thread = screen.getByRole('log') as HTMLDivElement;
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    let version = 0;
    const arrive = async (next: ChatRow[]) => {
      rows = [...rows, ...next];
      view.rerender(<TestChat version={++version} {...props} />);
      await screen.findByText(next.at(-1)!.text);
    };
    return { ...view, thread, arrive, props };
  }

  // A returned Chat mounts a new thread element; the prototype sizes give it a 100 px scroll range, as the fixture's own thread has.
  function sizeThreads() {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });
    onTestFinished(() => {
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height); else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (client) Object.defineProperty(HTMLElement.prototype, 'clientHeight', client); else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    });
  }
  const log = () => screen.getByRole('log') as HTMLDivElement;

  /**
   * Chat re-scrolls the thread on the next animation frame (a late layout such as an image or the chips otherwise leaves a
   * gap). A real frame fires when the browser decides, so a test that sizes the thread or reads scrollTop races it. Capture
   * the callbacks and run them on demand. `settle` first lets React's passive effects run: the frame is queued by the effect
   * that commits the rows, so pumping the queue before that effect runs would miss the frame and leave it to fire later.
   */
  function controlledFrames() {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    onTestFinished(() => { raf.mockRestore(); cancel.mockRestore(); });
    return async () => {
      await act(async () => {});
      const pending = frames.splice(0);
      act(() => { for (const callback of pending) callback(0); });
    };
  }

  it('auto-scrolls a pinned thread without marking an arriving row unread', async () => {
    const { arrive, thread } = await arrivalFixture();
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    expect(thread.scrollTop).toBe(200);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    expect(screen.queryByText('Unread')).toBeNull();
  });

  it('counts two arrivals while scrolled up and keeps the divider above the first', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    expect(screen.getByRole('button', { name: 'Jump to latest · 1 new' })).toBeTruthy();
    expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('first arrival');
    await arrive([{ ...chat[1]!, id: 102, text: 'second arrival' }]);
    expect(screen.getByRole('button', { name: 'Jump to latest · 2 new' })).toBeTruthy();
    expect(screen.getAllByText('Unread')).toHaveLength(1);
    expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('first arrival');
  });

  it('jumps to the bottom and hides the control', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
    expect(thread.scrollTop).toBe(thread.scrollHeight);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('does not show Jump to latest again after reading its rows and scrolling up', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest · 1 new' }));
    thread.scrollTop = 0; fireEvent.scroll(thread);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('counts only one row arriving after Jump to latest read earlier arrivals', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }, { ...chat[1]!, id: 102, text: 'second arrival' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest · 2 new' }));
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 103, text: 'arrival after read' }]);
    expect(screen.getByRole('button', { name: 'Jump to latest · 1 new' })).toBeTruthy();
  });

  it('records reading when a scroll reports the bottom, before Chat is left', async () => {
    const readThrough = { current: null as number | null };
    const { arrive, thread } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    expect(readThrough.current).toBe(100);
    thread.scrollTop = 100; fireEvent.scroll(thread);
    expect(readThrough.current).toBe(101);
  });

  it('counts a thread 3 px short of the end as at the bottom', async () => {
    const readThrough = { current: null as number | null };
    const { arrive, thread } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    thread.scrollTop = 97; fireEvent.scroll(thread);
    expect(readThrough.current).toBe(101);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('does not count a thread 30 px short of the end as at the bottom', async () => {
    const readThrough = { current: null as number | null };
    const { arrive, thread } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    thread.scrollTop = 70; fireEvent.scroll(thread);
    expect(readThrough.current).toBe(100);
    expect(screen.getByRole('button', { name: 'Jump to latest · 1 new' })).toBeTruthy();
  });

  it('records reading when Jump to latest is pressed', async () => {
    const readThrough = { current: null as number | null };
    const { arrive, thread } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
    expect(readThrough.current).toBe(101);
  });

  it('does not show Jump to latest again after scrolling to the bottom by hand and back up', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    thread.scrollTop = 100; fireEvent.scroll(thread);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('counts only one row arriving after scrolling to the bottom read earlier arrivals', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }, { ...chat[1]!, id: 102, text: 'second arrival' }]);
    thread.scrollTop = 100; fireEvent.scroll(thread);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 103, text: 'arrival after read' }]);
    expect(screen.getByRole('button', { name: 'Jump to latest · 1 new' })).toBeTruthy();
  });

  it('counts three rows arriving while scrolled up', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([101, 102, 103].map((id) => ({ ...chat[1]!, id, text: `arrival ${id}` })));
    expect(screen.getByRole('button', { name: 'Jump to latest · 3 new' })).toBeTruthy();
  });

  it('keeps the Unread divider above its first row after Jump to latest and scrolling up', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }, { ...chat[1]!, id: 102, text: 'second arrival' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest · 2 new' }));
    thread.scrollTop = 0; fireEvent.scroll(thread);
    expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('first arrival');
  });

  it('shows no Jump to latest button when a loaded thread starts with zero unread rows', async () => {
    const { thread } = await arrivalFixture({ current: null });
    thread.scrollTop = 0; fireEvent.scroll(thread);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('does not count the user’s own new row', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[0]!, id: 101, text: 'my new row' }]);
    expect({ jump: screen.queryByRole('button', { name: /Jump to latest/ }), divider: screen.queryByText('Unread') }).toEqual({ jump: null, divider: null });
  });

  it('does not count a pending question arriving while scrolled up', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    const question = { ...chat[2]!, id: 101, kind: 'question' as const, text: 'pending question', answer: null, answered_at: null, superseded_at: null };
    await arrive([question]);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('does not count an earlier page as new rows', async () => {
    const latest = { rows: [{ ...chat[0]!, id: 100, text: 'starting row' }], has_more: true, oldest_id: 100 };
    const earlier = { rows: [{ ...chat[1]!, id: 99, text: 'older row' }], has_more: false, oldest_id: 99 };
    mockApi((_method, url) => url.includes('before=100') ? earlier : latest);
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText('starting row');
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    await screen.findByText('older row');
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    expect(screen.queryByText('Unread')).toBeNull();
  });

  it('clears the divider after reaching the bottom and leaving Chat', async () => {
    const readThrough = { current: null as number | null };
    const { arrive, thread, unmount, props } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    thread.scrollTop = 100; fireEvent.scroll(thread);
    expect(screen.getByText('Unread')).toBeTruthy();
    unmount();
    expect(readThrough.current).toBe(101);
    mockApi(() => ({ rows: [{ ...chat[0]!, id: 100, text: 'starting row' }, { ...chat[1]!, id: 101, text: 'first arrival' }], has_more: false, oldest_id: 100 }));
    render(<TestChat version={2} {...props} />);
    await screen.findByText('first arrival');
    expect(screen.queryByText('Unread')).toBeNull();
  });

  describe('Retry on an undelivered message', () => {
    const user: ChatRow = { ...chat[0]!, id: 10, text: '[repo: r1] ship it' };
    const failure = (id: number, retried_at: string | null = null): ChatRow => ({ ...chat[3]!, id, text: 'Message saved but not delivered: pipe closed', failed_for: 10, retried_at });
    /** The daemon's thread plus the retry route, which the test holds (the slow boundary) until it answers. */
    function retryServer(initial: ChatRow[]) {
      let rows = initial;
      const posts: string[] = [];
      const pending: { id: number; answer: (response?: Error & { status?: number }) => void }[] = [];
      mockApi(async (method, url) => {
        if (method === 'POST') {
          posts.push(url);
          const match = /\/api\/chat\/(\d+)\/retry$/.exec(url);
          if (!match) return { ok: true };
          const id = Number(match[1]);
          const held = deferred<(Error & { status?: number }) | undefined>();
          pending.push({ id, answer: (response) => held.resolve(response) });
          const failed = await held.promise;
          if (failed) throw failed;
          return { ok: true };
        }
        return { rows, has_more: false, oldest_id: rows[0]?.id ?? null };
      });
      return { posts, pending, setRows: (next: ChatRow[]) => { rows = next; } };
    }
    const props = { repos: [repo], repo: 'r1', onRepo: () => {} };

    it('shows no Retry in a thread without failure rows, including on a system notice', async () => {
      retryServer([...chat, { ...chat[3]!, id: 5, text: '[Overseer] ov-1 landed' }]);
      render(<TestChat version={0} {...props} />);
      await screen.findByText('[Overseer] ov-1 landed');
      expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    });

    it('disables Retry while the request is in flight, sends one request on a double click, then hides it for good', async () => {
      const server = retryServer([user, failure(11)]);
      const view = render(<TestChat version={0} {...props} />);
      const button = await screen.findByRole('button', { name: 'Retry' });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveProperty('disabled', true));
      expect(server.posts).toEqual(['/api/chat/11/retry']);
      // Accepted and delivered: the refetched row carries retried_at, and a later refresh keeps the button gone.
      server.setRows([{ ...user, seen_at: '2026-09-12T10:03:00.000Z' }, failure(11, '2026-09-12T10:03:00.000Z')]);
      server.pending[0]!.answer();
      await waitFor(() => expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull());
      view.rerender(<TestChat version={1} {...props} />);
      await screen.findByText('Seen');
      expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
      expect(server.posts).toEqual(['/api/chat/11/retry']);
    });

    it('offers Retry on the new failure row when the retry fails again', async () => {
      const server = retryServer([user, failure(11)]);
      const view = render(<TestChat version={0} {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(server.pending).toHaveLength(1));
      server.setRows([user, failure(11, '2026-09-12T10:03:00.000Z'), { ...failure(12), text: 'Account Primary is not logged in, so the orchestrator was not started. Log in the account from Setup and try again.' }]);
      server.pending[0]!.answer();
      view.rerender(<TestChat version={1} {...props} />);
      await screen.findByText(/Account Primary is not logged in/);
      const buttons = screen.getAllByRole('button', { name: 'Retry' });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.closest('.msg')!.textContent).toContain('Account Primary is not logged in');
      fireEvent.click(buttons[0]!);
      await waitFor(() => expect(server.posts).toEqual(['/api/chat/11/retry', '/api/chat/12/retry']));
    });

    it('keeps Retry available when the request itself fails', async () => {
      const server = retryServer([user, failure(11)]);
      render(<TestChat version={0} {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(server.pending).toHaveLength(1));
      server.pending[0]!.answer(Object.assign(new Error('boom'), { status: 500 }));
      expect(await screen.findByText(/Could not retry/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false);
    });

    it('after a reload while the retry was pending, shows Retry only when the daemon has not accepted it', async () => {
      const server = retryServer([user, failure(11)]);
      const first = render(<TestChat version={0} {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(server.pending).toHaveLength(1));
      first.unmount();
      // Not yet accepted: the reloaded page offers the Retry again, enabled.
      const notYet = render(<TestChat version={0} {...props} />);
      expect(await screen.findByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false);
      notYet.unmount();
      // Accepted meanwhile: the row carries retried_at, so the reloaded page shows no Retry.
      server.setRows([user, failure(11, '2026-09-12T10:03:00.000Z')]);
      server.pending[0]!.answer();
      render(<TestChat version={0} {...props} />);
      await screen.findByText('Message saved but not delivered: pipe closed');
      expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    });

    it('posts a Retry and a Send made right after it in click order', async () => {
      const server = retryServer([user, failure(11)]);
      render(<TestChat version={0} {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      fireEvent.change(screen.getByLabelText('Message the orchestrator'), { target: { value: 'and this too' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(server.posts).toEqual(['/api/chat/11/retry', '/api/chat']));
      server.pending[0]!.answer();
    });
  });

  it('clears the divider when the user sends a message', async () => {
    const readThrough = { current: null as number | null };
    const { arrive, thread } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    const before = {
      button: screen.getByRole('button', { name: 'Jump to latest · 1 new' }).textContent,
      divider: screen.getByText('Unread').nextElementSibling?.textContent?.includes('first arrival'),
    };
    fireEvent.change(screen.getByLabelText('Message the orchestrator'), { target: { value: 'reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect({
      before,
      button: screen.queryByRole('button', { name: /Jump to latest/ }),
      divider: screen.queryByText('Unread'),
      readThrough: readThrough.current,
    }).toEqual({ before: { button: 'Jump to latest · 1 new', divider: true }, button: null, divider: null, readThrough: 101 }));
  });

  it('returns with 2 arrivals at the bottom, the divider above the first and no jump button', async () => {
    const readThrough = { current: null as number | null };
    const { unmount, props, thread } = await arrivalFixture(readThrough);
    unmount();
    expect(readThrough.current).toBe(100);
    sizeThreads();
    mockApi(() => ({ rows: [{ ...chat[0]!, id: 100, text: 'starting row' }, { ...chat[1]!, id: 101, text: 'away arrival' }, { ...chat[1]!, id: 102, text: 'second away arrival' }], has_more: false, oldest_id: 100 }));
    render(<TestChat version={1} {...props} />);
    await screen.findByText('second away arrival');
    expect(thread.isConnected).toBe(false);
    expect(log().scrollTop).toBe(200);
    expect(screen.getAllByText('Unread')).toHaveLength(1);
    expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('away arrival');
    expect(screen.getByText('Unread').nextElementSibling?.textContent).not.toContain('second away arrival');
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('returns with no arrivals at the bottom without an unread marker', async () => {
    const readThrough = { current: null as number | null };
    const { unmount, props } = await arrivalFixture(readThrough);
    unmount();
    sizeThreads();
    render(<TestChat version={1} {...props} />);
    await screen.findByText('starting row');
    await waitFor(() => expect(log().scrollTop).toBe(200));
    expect(screen.queryByText('Unread')).toBeNull();
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('returns to the latest row after 120 arrivals without showing a jump button', async () => {
    const settle = controlledFrames();
    const readThrough = { current: null as number | null };
    const { unmount, props } = await arrivalFixture(readThrough);
    unmount();
    sizeThreads();
    const rows = [{ ...chat[0]!, id: 100, text: 'starting row' }, ...Array.from({ length: 120 }, (_, i) => ({ ...chat[1]!, id: 101 + i, text: `away arrival ${i + 1}` }))];
    mockApi(() => ({ rows, has_more: false, oldest_id: 100 }));
    render(<TestChat version={1} {...props} />);
    await screen.findByText('away arrival 120');
    await settle();
    expect(log().scrollTop).toBe(200);
    expect(screen.getByText('Unread').nextElementSibling?.textContent).toContain('away arrival 1');
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('returns at the bottom after leaving scrolled up, then clears the divider on the next trip', async () => {
    const readThrough = { current: null as number | null };
    const { unmount, props, thread } = await arrivalFixture(readThrough);
    thread.scrollTop = 0; fireEvent.scroll(thread);
    unmount();
    expect(readThrough.current).toBe(100);
    sizeThreads();
    mockApi(() => ({ rows: [{ ...chat[0]!, id: 100, text: 'starting row' }, { ...chat[1]!, id: 101, text: 'away arrival' }], has_more: false, oldest_id: 100 }));
    const returned = render(<TestChat version={1} {...props} />);
    await screen.findByText('away arrival');
    expect(log().scrollTop).toBe(200);
    expect(screen.getByText('Unread')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    // Opening at the bottom is reading: the shell records it before Chat is left again.
    expect(readThrough.current).toBe(101);
    returned.unmount();
    render(<TestChat version={2} {...props} />);
    await screen.findByText('away arrival');
    expect(screen.queryByText('Unread')).toBeNull();
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('shows no divider after leaving and returning twice with nothing new', async () => {
    const readThrough = { current: null as number | null };
    const { unmount, props } = await arrivalFixture(readThrough);
    unmount();
    sizeThreads();
    const first = render(<TestChat version={1} {...props} />);
    await screen.findByText('starting row');
    expect(screen.queryByText('Unread')).toBeNull();
    first.unmount();
    render(<TestChat version={2} {...props} />);
    await screen.findByText('starting row');
    expect(log().scrollTop).toBe(200);
    expect(screen.queryByText('Unread')).toBeNull();
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    expect(readThrough.current).toBe(100);
  });

  it('does not count a user row sent while away', async () => {
    const readThrough = { current: null as number | null };
    const { unmount, props } = await arrivalFixture(readThrough);
    unmount();
    mockApi(() => ({ rows: [{ ...chat[0]!, id: 100, text: 'starting row' }, { ...chat[0]!, id: 101, text: 'my away row' }], has_more: false, oldest_id: 100 }));
    render(<TestChat version={1} {...props} />);
    await screen.findByText('my away row');
    expect(screen.queryByText('Unread')).toBeNull();
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('still shows a pending question after a return', async () => {
    const readThrough = { current: null as number | null };
    const { unmount, props } = await arrivalFixture(readThrough);
    unmount();
    sizeThreads();
    const question = { ...chat[2]!, id: 101, kind: 'question' as const, text: 'Still needed after return?', answer: null, answered_at: null, superseded_at: null };
    mockApi(() => ({ rows: [{ ...chat[0]!, id: 100, text: 'starting row' }, question], has_more: false, oldest_id: 100 }));
    render(<TestChat version={1} {...props} />);
    const card = await screen.findByText('Still needed after return?');
    expect(card.closest('.question-page-inactive')).toBeNull();
    expect(log().scrollTop).toBe(200);
  });

  it('caps the displayed count at 99+', async () => {
    const { arrive, thread } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive(Array.from({ length: 100 }, (_, i) => ({ ...chat[1]!, id: 101 + i, text: `arrival ${i}` })));
    expect(screen.getByRole('button', { name: 'Jump to latest · 99+ new' })).toBeTruthy();
  });

  it('keeps the jump control in flow above the composer', async () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const { arrive, thread, container } = await arrivalFixture();
    thread.scrollTop = 0; fireEvent.scroll(thread);
    await arrive([{ ...chat[1]!, id: 101, text: 'first arrival' }]);
    expect(container.querySelector('.chat-jump')?.nextElementSibling?.classList.contains('composer')).toBe(true);
    expect(css).toMatch(/\.chat-jump \{[^}]*flex: none;[^}]*\}/);
  });
  it('keeps the thread scroll area and gives Chat the space below either shell outage banner', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toContain('main:has(> .banner-warn):has(> .chat) { display: flex; flex-direction: column; }');
    expect(css).toContain('main:has(> .banner-warn) > .chat { flex: 1; height: auto; min-height: 0; }');
    expect(css).toMatch(/\.thread \{[^}]*min-height: 0; overflow: auto;/);
    expect(css).toContain('.chat.chat-visual-viewport, main:has(> .banner-warn) > .chat.chat-visual-viewport { flex: none; height: var(--chat-viewport-height); }');
  });

  it('sizes Chat to a shorter visual viewport, follows its scroll, restores the layout, and removes listeners', () => {
    mockApi(() => []);
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.scale = 1;
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const flush = () => { const next = frames.shift(); expect(next).toBeDefined(); act(() => next!(0)); };
    const remove = vi.spyOn(viewport, 'removeEventListener');
    const { container, unmount } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const chatElement = container.querySelector('.chat') as HTMLDivElement;
    const thread = screen.getByRole('log') as HTMLDivElement;
    vi.spyOn(chatElement, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, get: () => chatElement.classList.contains('chat-visual-viewport') ? 300 : 500 },
      scrollTop: { configurable: true, writable: true, value: 500 },
    });
    try {
      flush();
      expect(chatElement.style.getPropertyValue('--chat-viewport-height')).toBe('');
      viewport.height = 500;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
      expect(frames).toHaveLength(1); // resize and scroll share one animation frame
      flush();
      expect(chatElement.style.getPropertyValue('--chat-viewport-height')).toBe('400px');
      expect(chatElement.style.getPropertyValue('--visual-viewport-height')).toBe('500px');
      expect(thread.scrollTop + thread.clientHeight).toBe(thread.scrollHeight);
      viewport.offsetTop = 35;
      viewport.dispatchEvent(new Event('scroll'));
      flush();
      expect(chatElement.style.getPropertyValue('--chat-viewport-height')).toBe('435px');
      viewport.offsetTop = 344;
      viewport.height = 500;
      viewport.dispatchEvent(new Event('scroll'));
      flush();
      expect(chatElement.classList.contains('chat-visual-viewport')).toBe(true);
      viewport.scale = 2;
      viewport.dispatchEvent(new Event('resize'));
      flush();
      expect(chatElement.classList.contains('chat-visual-viewport')).toBe(false);
      viewport.scale = 1;
      viewport.height = 844;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event('resize'));
      flush();
      expect(chatElement.classList.contains('chat-visual-viewport')).toBe(false);
      expect(chatElement.style.getPropertyValue('--chat-viewport-height')).toBe('');
      expect(chatElement.style.getPropertyValue('--visual-viewport-height')).toBe('');
      unmount();
      expect(remove.mock.calls.map(([event]) => event)).toEqual(['resize', 'scroll']);
      viewport.dispatchEvent(new Event('resize'));
      expect(frames).toHaveLength(0);
    } finally {
      raf.mockRestore(); cancel.mockRestore(); vi.unstubAllGlobals();
    }
  });

  it('hides the phone tab bar and its reserve only while the keyboard class is on Chat, and tightens the card then', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const phoneChat = css.slice(css.indexOf('.chat { height: 100%; max-width: none; gap: 8px; }'));
    const phoneBlock = phoneChat.slice(0, phoneChat.indexOf('\n}\n'));
    expect(phoneBlock).toContain('.app:has(.chat-visual-viewport) .rail-views { display: none; }');
    expect(phoneBlock).toContain('.app:has(.chat-visual-viewport) main { padding-bottom: 0; }');
    expect(phoneBlock).toContain('.chat-visual-viewport .pinned { padding-block: 6px; gap: 4px; }');
    // Outside the keyboard state the shell keeps its fixed bar and main keeps padding for it.
    expect(css).toContain('main { overflow-x: hidden; padding: 12px 12px calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 12px); }');
    expect(css.match(/(^|\n) *\.rail-views \{[^}]*display: none/g) ?? []).toHaveLength(0);
  });

  it.each([
    ['no resize', 'visibilitychange', 844, 844, false],
    ['resize while hidden', 'visibilitychange', 844, 844, false],
    ['suspended frame', 'visibilitychange', 844, 844, false],
    ['queued frame before hiding', 'visibilitychange', 844, 844, false],
    ['page show', 'pageshow', 844, 844, false],
    ['window resize', 'resize', 844, 844, false],
    ['composer focusout', 'focusout', 844, 844, false],
    ['keyboard still open', 'visibilitychange', 500, 844, true],
    ['layout viewport resize on Android', 'resize', 500, 500, false],
  ] as const)('restores the keyboard layout on return after %s', (order, event, height, layoutHeight, keyboardOpen) => {
    mockApi(() => []);
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++nextId, callback); return nextId; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    const flush = () => act(() => {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((callback) => callback(0));
    });
    const { container, unmount } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const element = container.querySelector('.chat') as HTMLElement;
    try {
      flush();
      viewport.height = 500;
      viewport.dispatchEvent(new Event('resize'));
      flush();
      expect(element.classList.contains('chat-visual-viewport')).toBe(true);
      if (order === 'queued frame before hiding') viewport.dispatchEvent(new Event('scroll'));
      hidden = true;
      fireEvent(document, new Event('visibilitychange'));
      viewport.height = height;
      if (order === 'resize while hidden' || order === 'suspended frame') viewport.dispatchEvent(new Event('resize'));
      if (order === 'resize while hidden') flush();
      // A suspended callback is never run; only the return event can recover it.
      if (order === 'suspended frame') frames.clear();
      hidden = false;
      vi.stubGlobal('innerHeight', layoutHeight);
      if (event === 'visibilitychange') fireEvent(document, new Event(event));
      else if (event === 'focusout') fireEvent.focusOut(screen.getByLabelText('Message the orchestrator'));
      else fireEvent(window, new Event(event));
      flush();
      expect(element.classList.contains('chat-visual-viewport')).toBe(keyboardOpen);
      expect(element.style.getPropertyValue('--chat-viewport-height')).toBe(keyboardOpen ? '500px' : '');
      expect(element.style.getPropertyValue('--visual-viewport-height')).toBe(keyboardOpen ? '500px' : '');
      // Subsequent keyboard events must still work after recovering the frame.
      vi.stubGlobal('innerHeight', 844);
      viewport.height = 500;
      viewport.dispatchEvent(new Event('resize'));
      flush();
      expect(element.classList.contains('chat-visual-viewport')).toBe(true);
    } finally { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it('keeps the normal layout without visualViewport', () => {
    mockApi(() => []);
    vi.stubGlobal('visualViewport', undefined);
    try {
      const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
      fireEvent(document, new Event('visibilitychange'));
      fireEvent(window, new Event('pageshow'));
      fireEvent(window, new Event('resize'));
      fireEvent.focusOut(screen.getByLabelText('Message the orchestrator'));
      expect(container.querySelector('.chat')?.classList.contains('chat-visual-viewport')).toBe(false);
      expect((container.querySelector('.chat') as HTMLElement).style.getPropertyValue('--chat-viewport-height')).toBe('');
    } finally { vi.unstubAllGlobals(); }
  });

  it('places the labelled repository target beside Send and hides only the keyboard hint on touch', () => {
    mockApi(() => []);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const bar = container.querySelector('.composer-bar')!;
    const select = screen.getByLabelText('Repo') as HTMLSelectElement;
    const send = screen.getByRole('button', { name: 'Send' });
    expect(select.value).toBe('r1');
    expect(bar.contains(select)).toBe(true);
    expect(select.closest('label')?.textContent).toContain('To');
    expect(select.closest('label')?.nextElementSibling).toBe(send);
    expect(send.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const hint = bar.querySelector('.composer-key-hint');
    expect(hint?.textContent).toContain('Enter to send');
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toContain('@media (hover: none) and (pointer: coarse) { .composer-key-hint { display: none; } }');
  });

  it('loads the latest page, prepends an earlier page, and anchors the scroll position', async () => {
    const latest = { rows: [{ ...chat[0]!, id: 101, text: 'latest row' }], has_more: true, oldest_id: 101 };
    const earlier = { rows: [{ ...chat[0]!, id: 100, text: 'earlier row' }], has_more: false, oldest_id: 100 };
    mockApi((_method, url) => url.includes('before=101') ? earlier : latest);
    render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('latest row');
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe('/api/chat?limit=100');
    const thread = screen.getByRole('log') as HTMLDivElement;
    Object.defineProperties(thread, { scrollHeight: { configurable: true, get: () => screen.queryByText('earlier row') ? 300 : 200 }, scrollTop: { configurable: true, writable: true, value: 40 } });
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    await screen.findByText('earlier row');
    await waitFor(() => expect(thread.scrollTop).toBe(140));
    expect(screen.queryByRole('button', { name: /earlier messages/i })).toBeNull();
  });

  it('merges the latest page on a chat version bump: answered and queued changes land, earlier pages survive', async () => {
    const question = { ...chat[2]!, id: 101, kind: 'question' as const, text: 'Still needed?', answer: null, answered_at: null, superseded_at: null };
    const queued = { ...chat[0]!, id: 102, role: 'system' as const, text: 'queued notice', queued_at: '2026-09-16T12:00:00.000Z' };
    const earlier = { rows: [{ ...chat[0]!, id: 100, text: 'earlier row' }], has_more: false, oldest_id: 100 };
    let changed = false;
    mockApi((_method, url) => {
      if (url.includes('before=101')) return earlier;
      return changed
        ? { rows: [{ ...question, answer: 'No', answered_at: '2026-09-16T12:01:00.000Z' }, { ...queued, queued_at: null }, { ...chat[1]!, id: 103, text: 'new row' }], has_more: true, oldest_id: 101 }
        : { rows: [question, queued], has_more: true, oldest_id: 101 };
    });
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByLabelText('Your answer');
    expect(screen.getByText(/queued for the orchestrator/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    await screen.findByText('earlier row');
    changed = true;
    rerender(<TestChat version={1} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('new row');
    await waitFor(() => expect(screen.queryByLabelText('Your answer')).toBeNull());
    expect(screen.getByText('↳ No')).toBeTruthy();
    expect(screen.queryByText(/queued for the orchestrator/)).toBeNull();
    expect(screen.getByText('earlier row')).toBeTruthy();
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.includes('since='))).toEqual([]);
    expect(urls.at(-1)).toBe('/api/chat?limit=100');
  });

  it('does not duplicate a referenced older row when the earlier page repeats it', async () => {
    const ref = { ...chat[0]!, id: 5, text: 'old question row' };
    const latest = { rows: [ref, { ...chat[1]!, id: 150, text: 'reply row', reply_to: 5 }], has_more: true, oldest_id: 150 };
    const earlier = { rows: [ref, { ...chat[0]!, id: 149, text: 'earlier row' }], has_more: false, oldest_id: 5 };
    mockApi((_method, url) => url.includes('before=150') ? earlier : latest);
    render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('reply row');
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    await screen.findByText('earlier row');
    expect(screen.getAllByText('old question row')).toHaveLength(1);
  });

  it('leaves scrollTop alone after a failed earlier load followed by an appended row', async () => {
    const settle = controlledFrames();
    const latest = { rows: [{ ...chat[0]!, id: 101, text: 'latest row' }], has_more: true, oldest_id: 101 };
    let fail = true;
    mockApi((_method, url) => {
      if (url.includes('before=101')) { if (fail) throw new Error('boom'); return { rows: [], has_more: false, oldest_id: 101 }; }
      return fail ? latest : { ...latest, rows: [...latest.rows, { ...chat[1]!, id: 102, text: 'appended row' }] };
    });
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('latest row');
    // Settle the first load's effect and its next-frame re-scroll before the thread is put at the user's own 40 px position,
    // so a frame left over from the first load can no longer stand in for the user having scrolled.
    await settle();
    const thread = screen.getByRole('log') as HTMLDivElement;
    Object.defineProperties(thread, { scrollHeight: { configurable: true, get: () => screen.queryByText('appended row') ? 300 : 200 }, scrollTop: { configurable: true, writable: true, value: 40 } });
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    await screen.findByText(/Could not load the thread: boom/);
    expect(screen.getByRole('button', { name: 'Show earlier messages' })).toBeTruthy();
    fail = false;
    rerender(<TestChat version={1} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('appended row');
    await settle();
    expect(thread.scrollTop).toBe(40);
  });

  it('pins an open question the page carries from below oldest_id', async () => {
    const question = { ...chat[2]!, id: 3, text: 'Old but open?' };
    mockApi((_method, url) => url.includes('/api/chat') ? { rows: [question, { ...chat[0]!, id: 101, text: 'latest row' }], has_more: true, oldest_id: 101 } : []);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('latest row');
    expect(container.querySelector('.pinned')!.textContent).toContain('Old but open?');
    expect(screen.getByRole('button', { name: 'Show earlier messages' })).toBeTruthy();
  });

  it('refreshes a loaded pending question when a chat version changes', async () => {
    const question = { ...chat[2]!, id: 101, kind: 'question' as const, text: 'Still needed?', answer: null, answered_at: null, superseded_at: null };
    const resolved = { ...question, answer: 'No', answered_at: '2026-09-16T12:01:00.000Z' };
    let changed = false;
    mockApi((_method, url) => url.includes('/api/chat') ? { rows: [changed ? resolved : question], has_more: false, oldest_id: 101 } : []);
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByLabelText('Your answer');
    changed = true;
    rerender(<TestChat version={1} repos={[repo]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.queryByLabelText('Your answer')).toBeNull());
    expect(screen.getByText('↳ No')).toBeTruthy();
  });

  it('removes an old carried question after it is answered and omitted from the latest page', async () => {
    const question = { ...chat[2]!, id: 3, kind: 'question' as const, text: 'Old but open?', answer: null, answered_at: null, superseded_at: null };
    const latest = { ...chat[0]!, id: 101, text: 'latest row' };
    let changed = false;
    mockApi((_method, url) => url.includes('/api/chat') ? {
      rows: changed ? [latest] : [question, latest], has_more: true, oldest_id: 101,
    } : []);
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByLabelText('Your answer');
    changed = true;
    rerender(<TestChat version={1} repos={[repo]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.queryByLabelText('Your answer')).toBeNull());
    expect(screen.queryByText('Old but open?')).toBeNull();
  });
  it('keeps the composer busy when a socket refresh arrives before the POST response', async () => {
    const post = deferred<unknown>();
    const socketRefresh = deferred<unknown>();
    const earlier = chat.slice(0, 2);
    const sent = { ...chat[0]!, id: 5, text: 'first message', ts: '2026-09-12T10:03:00.000Z' };
    const latest = [...earlier, sent];
    const readThrough = { current: 0 as number | null };
    let gets = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) {
        gets += 1;
        if (gets === 1) return earlier;
        if (gets === 2) return socketRefresh.promise;
        return latest;
      }
      if (method === 'POST') return post.promise;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const props = { repos: [repo], repo: 'r1', onRepo: () => {}, readThrough };
    const view = render(<TestChat version={0} {...props} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    expect(input.disabled).toBe(true);
    view.rerender(<TestChat version={1} {...props} />);
    await waitFor(() => expect(gets).toBe(2));
    await act(async () => { socketRefresh.resolve(latest); });
    await waitFor(() => expect(within(screen.getByRole('log', { name: 'Conversation' })).getByText('first message')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy();
    expect(input.disabled).toBe(true);
    await act(async () => { post.resolve({ ok: true }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    await waitFor(() => expect(readThrough.current).toBe(5));
  });

  it('enables the composer on the POST response while its thread refresh is pending', async () => {
    const post = deferred<unknown>();
    const refetch = deferred<unknown>();
    const earlier = chat.slice(0, 2);
    const sent = { ...chat[0]!, id: 5, text: 'first message', ts: '2026-09-12T10:03:00.000Z' };
    const readThrough = { current: 0 as number | null };
    let gets = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) {
        gets += 1;
        return gets === 1 ? earlier : refetch.promise;
      }
      if (method === 'POST') return post.promise;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} readThrough={readThrough} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    await act(async () => { post.resolve({ ok: true }); });
    await waitFor(() => expect(gets).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    expect(screen.queryByText('first message')).toBeNull();
    expect(readThrough.current).not.toBe(5);
    await act(async () => { refetch.resolve([...earlier, sent]); });
    await screen.findByText('first message');
    await waitFor(() => expect(readThrough.current).toBe(5));
  });

  it('keeps a successful send cleared when its refresh fails, then shows the row on the next refresh', async () => {
    const earlier = chat.slice(0, 2);
    const sent = { ...chat[0]!, id: 5, text: 'first message', ts: '2026-09-12T10:03:00.000Z' };
    const latest = [...earlier, sent];
    const readThrough = { current: 0 as number | null };
    let gets = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) {
        gets += 1;
        if (gets === 1) return earlier;
        if (gets === 2) throw Object.assign(new Error('refresh failed'), { status: 500 });
        return latest;
      }
      if (method === 'POST') return { ok: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const props = { repos: [repo], repo: 'r1', onRepo: () => {}, readThrough };
    const view = render(<TestChat version={0} {...props} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    await screen.findByText(/could not load the thread: refresh failed/i);
    view.rerender(<TestChat version={1} {...props} />);
    await screen.findByText('first message');
    await waitFor(() => expect(readThrough.current).toBe(5));
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
  });

  it('allows a second send while the first send refresh is still pending', async () => {
    const firstRefetch = deferred<unknown>();
    const earlier = chat.slice(0, 2);
    const first = { ...chat[0]!, id: 5, text: 'first send', ts: '2026-09-12T10:03:00.000Z' };
    const second = { ...chat[0]!, id: 6, text: 'second send', ts: '2026-09-12T10:04:00.000Z' };
    const latest = [...earlier, first, second];
    const posts: { text: string }[] = [];
    let gets = 0;
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) {
        gets += 1;
        if (gets === 1) return earlier;
        if (gets === 2) return firstRefetch.promise;
        return latest;
      }
      if (method === 'POST') { posts.push(body as { text: string }); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    fireEvent.change(input, { target: { value: 'first send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(gets).toBe(2));
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'second send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts.map(({ text }) => text)).toEqual(['first send', 'second send']));
    await waitFor(() => expect(input.value).toBe(''));
    expect(input.disabled).toBe(false);
    expect(gets).toBe(2); // the second refresh shares the still-pending request
    await act(async () => { firstRefetch.resolve(latest); });
    await screen.findByText('second send');
  });

  it('leaves a newer draft alone when its revision changes before the POST response', async () => {
    const post = deferred<unknown>();
    const revision = { current: 7 };
    let updateDraft = () => {};
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return chat;
      if (method === 'POST') return post.promise;
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() {
      const [text, setText] = useState('first draft');
      const [draftRev, setDraftRev] = useState(7);
      const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
      const [hint, setHint] = useState<string | null>(null);
      const host: AttachmentHost = { attachments, setAttachments, hint, setHint };
      updateDraft = () => { revision.current += 1; setDraftRev(revision.current); setText('new draft'); };
      return <Chat version={0} repos={[repo]} repo="r1" onRepo={() => {}} text={text} draftRev={draftRev}
        onText={(next) => { revision.current += 1; setDraftRev(revision.current); setText(next); }}
        onClearText={(_repo, sentRev) => {
          if (revision.current === sentRev) { revision.current += 1; setDraftRev(revision.current); setText(''); }
        }} attachments={host} />;
    }
    render(<Harness />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    act(() => updateDraft());
    expect(input.value).toBe('new draft');
    expect(input.disabled).toBe(true);
    await act(async () => { post.resolve({ ok: true }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('new draft');
  });

  it('enables the composer on the POST response while the first load continues for an empty thread', async () => {
    const firstLoad = deferred<unknown>();
    const sent = { ...chat[0]!, id: 5, text: 'first message', ts: '2026-09-12T10:03:00.000Z' };
    const readThrough = { current: 0 as number | null };
    let gets = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) {
        gets += 1;
        return gets === 1 ? [] : firstLoad.promise;
      }
      if (method === 'POST') return { ok: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} readThrough={readThrough} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    await screen.findByText(/pick a repository and describe what you want done/i);
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(gets).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    expect(screen.queryByText('first message')).toBeNull();
    await act(async () => { firstLoad.resolve([sent]); });
    await screen.findByText('first message');
    await waitFor(() => expect(readThrough.current).toBe(5));
  });

  it('keeps the draft and attachment when the POST fails', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:failed-send'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('FileReader', class { result: string | null = null; error: DOMException | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.(); } });
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return chat;
      if (method === 'POST') throw Object.assign(new Error('post failed'), { status: 500 });
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    await screen.findByText('Created ov-1 and dispatched a claude worker.');
    const file = new File(['image'], 'keep.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
    fireEvent.change(input, { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('post failed');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('keep this draft');
    expect(screen.getByAltText('keep.png')).toBeTruthy();
  });

  it('refuses to send while no repository is registered and points at Setup (round 14)', async () => {
    const posts: unknown[] = [];
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return [];
      if (method === 'POST') { posts.push(url); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const onSetup = vi.fn();
    render(<TestChat version={0} repos={[]} repo="" onRepo={() => {}} onSetup={onSetup} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    expect(screen.getByText(/Register a repository in Setup first/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Repo' })).toBeNull(); // nothing to pick, so no "all repos" to send to
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(posts).toEqual([]);
    expect(input.value).toBe('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Open Setup' }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it('sends the IDs open when the first keystroke started the draft', async () => {
    const rows = [pendingQuestion(101, 'Which database?')];
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return rows;
      if (method === 'POST' && url === '/api/chat') { posts.push(body); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(input, { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ open_question_ids: [101] }));
  });

  it('re-records open question IDs after the text draft is cleared', async () => {
    let rows = [pendingQuestion(101, 'Question before clearing?')];
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return rows;
      if (method === 'POST' && url === '/api/chat') { posts.push(body); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const view = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(input, { target: { value: 'first draft' } });
    fireEvent.change(input, { target: { value: '' } });
    rows = [...rows, pendingQuestion(102, 'Question after clearing?')];
    view.rerender(<TestChat version={1} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText('Question after clearing?');
    fireEvent.change(input, { target: { value: 'second draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ open_question_ids: [101, 102] }));
  });

  it('captures the snapshot when an attachment-only draft gets its first image', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:first'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('FileReader', class { result: string | null = null; error: DOMException | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.(); } });
    let rows = [pendingQuestion(101, 'Question before image?')];
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return rows;
      if (method === 'POST' && url === '/api/chat') { posts.push(body); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const view = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    rows = [...rows, pendingQuestion(102, 'Question after image?')];
    view.rerender(<TestChat version={1} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText('Question after image?');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ open_question_ids: [101] }));
  });

  it('keeps a question that arrives during typing pinned with its answer box after send', async () => {
    const before = pendingQuestion(101, 'Question open at draft start?');
    const during = pendingQuestion(102, 'Question arriving while typing?');
    let rows = [before];
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return rows;
      if (method === 'POST' && url === '/api/chat') {
        posts.push(body);
        const ids = (body as { open_question_ids: number[] }).open_question_ids;
        rows = rows.map((question) => ids.includes(question.id) ? { ...question, superseded_at: '2026-09-26T10:00:00.000Z' } : question);
        return { ok: true };
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const view = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(input, { target: { value: 'reply from composer' } });
    rows = [before, during];
    view.rerender(<TestChat version={1} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText(during.text);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const answer = await screen.findByLabelText('Your answer');
    await waitFor(() => expect({ body: posts.at(-1), pinned: answer.closest('.question')?.textContent }).toEqual({
      body: { text: 'reply from composer', repo: 'r1', open_question_ids: [101] },
      pinned: expect.stringContaining(during.text),
    }));
  });

  it('renders the thread, pins questions, answers and sends with repo scope', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return chat;
      if (method === 'POST') { posts.push({ url, body }); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    function Harness() { const [r, setR] = useState(''); return <TestChat version={0} repos={[repo]} repo={r} onRepo={setR} />; }
    render(<Harness />);
    await waitFor(() => expect(screen.getByText('Created ov-1 and dispatched a claude worker.')).toBeTruthy());
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy(); // the scroll container is a Tab stop in Chrome; it has a name
    const sys = screen.getByText(/conflicted in: src\/a\.ts/).closest('.msg')!;
    expect(sys.textContent).toContain('Overseer');
    const user = screen.getByText('add a greeting endpoint').closest('.msg')!;
    expect(user.textContent).not.toContain('[repo:');
    expect(user.querySelector('.repo-tag')!.textContent).toBe('r1');
    const pinned = screen.getByText('Should the endpoint require auth?').closest('.question')!;
    fireEvent.change(pinned.querySelector('textarea')!, { target: { value: 'No auth' } });
    fireEvent.keyDown(pinned.querySelector('textarea')!, { key: 'Enter' });
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/chat/answer', body: { question_id: 3, text: 'No auth' } }));
    const input = screen.getByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    const select = screen.getByLabelText('Repo');
    expect(input.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // text first, target and Send in the bar below
    expect(screen.queryByText('Repo', { selector: 'span' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'r1' } });
    fireEvent.change(input, { target: { value: 'ship it' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/chat', body: { text: 'ship it', repo: 'r1', open_question_ids: [3] } }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()); // no longer 'Sending…'
    expect(input.value).toBe('');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: '' } });
    fireEvent.change(input, { target: { value: 'status?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/chat', body: { text: 'status?', open_question_ids: [3] } }));
  });
  it('asks for the repository before the first send when more than one is registered, and names the target next to the composer (round 12)', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return [];
      if (method === 'POST') { posts.push({ url, body }); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const repo2 = { ...repo, id: 'r2', path: 'E:/Projects/other' };
    function Harness() { const [r, setR] = useState('r2'); return <TestChat version={0} repos={[repo, repo2]} repo={r} onRepo={setR} />; } // r2 is the stored default from an earlier session
    render(<Harness />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    const select = screen.getByLabelText('Repo') as HTMLSelectElement;
    expect(select.value).toBe('?');
    expect(screen.getByText(/pick the repository this message is for/i).textContent).toContain('last used: r2');
    fireEvent.change(input, { target: { value: 'stop that worker' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(PICK_REPO)).toBeTruthy());
    expect(posts).toEqual([]);
    expect(input.value).toBe('stop that worker');
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: 'r1' } });
    expect(screen.queryByText(/pick the repository/i)).toBeNull();
    expect(select.value).toBe('r1'); // the labelled select in the composer bar is the target cue
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/chat', body: { text: 'stop that worker', repo: 'r1', open_question_ids: [] } }));
    // Chosen once in this browser session: a remount does not ask again, and "all repos" is a choice too.
    cleanup();
    render(<Harness />);
    expect(((await screen.findByLabelText('Repo')) as HTMLSelectElement).value).toBe('r2');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: '' } });
    expect((screen.getByLabelText('Repo') as HTMLSelectElement).value).toBe('');
  });

  it('returns focus to the composer after a send and after an answer', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return chat;
      if (method === 'POST') return { ok: true };
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    const input = await screen.findByPlaceholderText(/message the orchestrator/i) as HTMLTextAreaElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'go' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
    await waitFor(() => expect(document.activeElement).toBe(input));
    const answer = screen.getByLabelText('Your answer');
    answer.focus();
    fireEvent.change(answer, { target: { value: 'No auth' } });
    fireEvent.keyDown(answer, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('reports a thread that cannot be loaded instead of staying blank, and clears the report once a load succeeds', async () => {
    let down = true;
    mockApi(() => { if (down) throw Object.assign(new Error('daemon down'), { status: 500 }); return chat; });
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.getByText(/could not load the thread: daemon down/i)).toBeTruthy());
    expect(screen.queryByText(/pick a repository/i)).toBeNull();
    down = false;
    rerender(<TestChat version={1} repos={[repo]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.getByText('Created ov-1 and dispatched a claude worker.')).toBeTruthy());
    expect(screen.queryByText(/could not load the thread/i)).toBeNull();
  });

  it('names the outage instead of the proxy status code and keeps the draft while the daemon is unreachable (round 11)', async () => {
    // The dev proxy answers a bare 500 (no JSON body) while the daemon is down; the shell knows the outage and passes it down.
    mockApi(() => new Response('', { status: 500 }));
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.getByText(OUTAGE_LOAD_NONE)).toBeTruthy()); // nothing was loaded before the outage (round 15)
    expect(screen.queryByText(/failed with 500/)).toBeNull();
    const input = screen.getByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'add bye.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(OUTAGE_SEND)).toBeTruthy());
    expect(document.querySelector('.msg-status')).toBeNull();
    expect(input.value).toBe('add bye.txt');
    expect(input.disabled).toBe(false);
    // Once the shell knows, Send is disabled and Enter says so without a request.
    rerender(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} offline />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(OUTAGE_SEND)).toBeTruthy();
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
    expect(input.value).toBe('add bye.txt');
  });

  it('shows a superseded question in the thread without an answer box, labels queued notices, and dismisses a pending one', async () => {
    const t = (s: number) => `2026-09-13T05:31:${String(s).padStart(2, '0')}.000Z`;
    const rows: ChatRow[] = [
      { id: 1, role: 'assistant', kind: 'question', text: 'Fix the verify command first?', ts: t(1), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: t(9) },
      { id: 2, role: 'user', kind: 'message', text: 'I will fix it myself', ts: t(2), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 3, role: 'assistant', kind: 'message', text: 'Understood. **Leaving** repo2-10w as is.', ts: t(3), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 4, role: 'system', kind: 'message', text: 'Batch r1-b1 rejected: no', ts: t(4), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: t(4), superseded_at: null },
      { id: 5, role: 'assistant', kind: 'question', text: 'Anything else?', ts: t(5), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
    ];
    const posts: { url: string; body: unknown }[] = [];
    mockApi((method, url, body) => { if (method === 'POST') { posts.push({ url, body }); return { ok: true }; } return rows; });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('Fix the verify command first?');
    // The superseded question sits in the thread at the time it was asked, marked, with no answer box of its own.
    const stale = screen.getByText('Fix the verify command first?').closest('.msg')!;
    expect(stale.textContent).toContain('No longer waiting for an answer');
    expect(stale.querySelector('textarea')).toBeNull();
    expect(screen.getAllByLabelText('Your answer')).toHaveLength(1); // only "Anything else?" is pinned
    expect(container.querySelector('.pinned')!.textContent).toContain('Anything else?');
    // Assistant markdown is stripped like the notices; a queued notice says it waits for the orchestrator's next turn.
    expect(screen.getByText('Understood. Leaving repo2-10w as is.')).toBeTruthy();
    expect(screen.getByText(/rejected: no/).closest('.msg')!.textContent).toContain("queued for the orchestrator's next turn");
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/chat/dismiss', body: { question_id: 5 } }]));
  });

  it('says the thread cannot be loaded when Chat opens during an outage, instead of claiming a last known thread (round 15)', async () => {
    let down = true;
    mockApi(() => { if (down) throw new TypeError('Failed to fetch'); return chat; });
    const { rerender } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} offline />);
    await waitFor(() => expect(screen.getByText(OUTAGE_LOAD_NONE)).toBeTruthy());
    down = false;
    rerender(<TestChat version={1} repos={[repo]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.getByText('Created ov-1 and dispatched a claude worker.')).toBeTruthy());
    // Once a thread was shown, a later outage keeps it and says so.
    down = true;
    rerender(<TestChat version={2} repos={[repo]} repo="" onRepo={() => {}} offline />);
    await waitFor(() => expect(screen.getByText(OUTAGE_LOAD)).toBeTruthy());
    expect(screen.getByText('Created ov-1 and dispatched a claude worker.')).toBeTruthy();
  });
  it('shows no "pick a repository" hint while no repository is registered, and no "register one" line while the list is still unknown (round 15, fix round 14 review)', async () => {
    mockApi((_m, url) => { if (url.startsWith('/api/chat')) return []; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const { rerender } = render(<TestChat version={0} repos={[]} repo="" onRepo={() => {}} />);
    await waitFor(() => expect(screen.getByText(/register a repository in setup first/i)).toBeTruthy());
    expect(screen.queryByText(/pick a repository/i)).toBeNull();
    rerender(<TestChat version={0} repos={[]} reposLoaded={false} repo="" onRepo={() => {}} />);
    expect(screen.queryByText(/register a repository in setup first/i)).toBeNull();
    expect(screen.queryByText(/pick a repository and describe/i)).toBeNull(); // not this one either: the list is unknown, not empty (fix round 15 review)
    fireEvent.change(screen.getByLabelText('Message the orchestrator'), { target: { value: 'anything' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('renders an unloaded repo list exactly as the empty one', async () => {
    mockApi((_m, url) => { if (url.startsWith('/api/chat')) return { rows: [], has_more: false, oldest_id: null }; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const { container, rerender } = render(<TestChat version={0} repos={null} reposLoaded={false} repo="" onRepo={() => {}} />);
    await act(async () => {});
    const unloaded = container.innerHTML;
    rerender(<TestChat version={0} repos={[]} reposLoaded={false} repo="" onRepo={() => {}} />);
    await act(async () => {});
    expect(container.innerHTML).toBe(unloaded);
  });
  it('marks a reply that answers an earlier message when a newer user message sits above it (round 16)', async () => {
    const rows: ChatRow[] = [
      { ...chat[0]!, id: 1, text: '[repo: r1] Dispatch ov-2 to a claude worker now.\nUse the batch branch.' },
      { ...chat[0]!, id: 2, text: 'Stop the worker you just dispatched.', ts: '2026-09-12T10:00:09.000Z' },
      { ...chat[1]!, id: 3, text: 'Dispatched ov-2 to a claude worker.', ts: '2026-09-12T10:00:15.000Z', reply_to: 1 },
      { ...chat[1]!, id: 4, text: 'Stopped it.', ts: '2026-09-12T10:00:30.000Z', reply_to: 2 },
    ];
    mockApi(() => rows);
    render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    const late = (await screen.findByText('Dispatched ov-2 to a claude worker.')).closest('.msg') as HTMLElement;
    expect(within(late).getByText('↳ to your earlier message “Dispatch ov-2 to a claude worker now.”')).toBeTruthy();
    expect(screen.getByText('Stopped it.').closest('.msg')!.textContent).not.toContain('earlier message');
  });
  it('shows a hint in an empty thread, and only once the thread has loaded', async () => {
    let release: (rows: unknown[]) => void = () => {};
    mockApi(() => new Promise<unknown>((r) => { release = r; }));
    render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    expect(screen.queryByText(/pick a repository/i)).toBeNull();
    release([]);
    await waitFor(() => expect(screen.getByText(/pick a repository and describe what you want done/i)).toBeTruthy());
  });

  it('keeps the thread chronological: a question sits at its answer, later replies come after it', () => {
    const t = (s: number) => `2026-09-13T05:31:${String(s).padStart(2, '0')}.000Z`;
    // Two questions in one turn, answered one after the other, each followed by a reply (round-5 shape).
    const two: ChatRow[] = [
      { id: 1, role: 'user', kind: 'message', text: 'Ask me two questions', ts: t(0), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 2, role: 'assistant', kind: 'question', text: 'Which filename?', ts: t(1), answer: 'r5-note.txt', answered_at: t(10), seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 3, role: 'assistant', kind: 'question', text: 'Which word?', ts: t(1), answer: 'banana', answered_at: t(20), seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 4, role: 'assistant', kind: 'message', text: 'Both questions are posted.', ts: t(2), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 5, role: 'assistant', kind: 'message', text: 'Got the filename. Still waiting on the word.', ts: t(12), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 6, role: 'assistant', kind: 'message', text: 'r5-note.txt with banana inside.', ts: t(22), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
    ];
    expect(orderThread(two).map((r) => r.id)).toEqual([1, 4, 2, 5, 3, 6]);
    // One question answered, then the orchestrator's reply and a notice: the reply ends the thread, not the question.
    const one: ChatRow[] = [
      { id: 1, role: 'user', kind: 'message', text: 'add a note file', ts: t(0), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 2, role: 'assistant', kind: 'question', text: 'Which filename?', ts: t(1), answer: 'note.txt', answered_at: t(5), seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 3, role: 'assistant', kind: 'message', text: 'Waiting on your answer before I create the batch.', ts: t(2), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 4, role: 'assistant', kind: 'message', text: 'Creating the batch now.', ts: t(6), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 5, role: 'system', kind: 'message', text: 'Batch r1-b1 dispatched', ts: t(7), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
    ];
    expect(orderThread(one).map((r) => r.id)).toEqual([1, 3, 2, 4, 5]);
    // Same instant: id order.
    expect(orderThread([one[2]!, one[0]!, { ...one[3]!, ts: t(0) }]).map((r) => r.id)).toEqual([1, 4, 3]);
    // Two questions in one turn, one answered and the other superseded by a composer message: both count from the moment they
    // were resolved, so they cannot cross and the turn's closing line cannot sit between them (round 20 R20-3).
    const mixed: ChatRow[] = [
      { id: 11, role: 'user', kind: 'message', text: 'add a note file', ts: t(0), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 12, role: 'assistant', kind: 'question', text: 'Which filename?', ts: t(1), answer: 'r20-note.txt', answered_at: t(10), seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 13, role: 'assistant', kind: 'question', text: 'Which word?', ts: t(1), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: t(30) },
      { id: 14, role: 'assistant', kind: 'message', text: "I'll wait for both answers.", ts: t(2), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 15, role: 'assistant', kind: 'message', text: 'Got the filename. Still waiting on the word.', ts: t(12), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 16, role: 'user', kind: 'message', text: 'put banana in it', ts: t(25), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
    ];
    expect(orderThread(mixed).map((r) => r.id)).toEqual([11, 14, 12, 15, 16, 13]);
    // New session closes the open question of the session it ends. The daemon supersedes it before it writes the notice, so the
    // question keeps its place above the notice that closed it even when both land in the same millisecond: the tie goes to the
    // lower id, which is the question's (round 23 R23-2: the question sorted below the notice and still read as "Orchestrator",
    // so the fresh session appeared to ask something it immediately disowned).
    const reset: ChatRow[] = [
      { id: 21, role: 'user', kind: 'message', text: 'Ask me which word to put in the file', ts: t(0), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 22, role: 'assistant', kind: 'question', text: 'Which single word?', ts: t(1), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: t(5) },
      { id: 23, role: 'assistant', kind: 'message', text: 'Asked — waiting on the word before I create anything.', ts: t(2), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 24, role: 'system', kind: 'message', text: 'New orchestrator session: the next message starts a fresh orchestrator with no memory of this thread.', ts: t(5), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
    ];
    expect(orderThread(reset).map((r) => r.id)).toEqual([21, 23, 22, 24]);
  });

  it('shows a question after the narration of its turn, pins a pending one under the thread, and strips markdown from notices', async () => {
    const t = (s: number) => `2026-09-13T05:31:${String(s).padStart(2, '0')}.000Z`;
    const rows: ChatRow[] = [
      { id: 1, role: 'user', kind: 'message', text: 'add a note file', ts: t(0), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 2, role: 'assistant', kind: 'question', text: 'Which filename?', ts: t(1), answer: 'note.txt', answered_at: t(5), seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 3, role: 'assistant', kind: 'message', text: 'Waiting on your answer before I create the batch.', ts: t(2), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 4, role: 'system', kind: 'message', text: 'r1-2 reopened: worker ended without commits: - **r2.txt exists** ``` $ cat r2.txt ```', ts: t(6), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
      { id: 5, role: 'assistant', kind: 'question', text: 'Anything else?', ts: t(7), answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null },
    ];
    mockApi(() => rows);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('Which filename?');
    const shown = [...container.querySelectorAll('.thread .msg .pre')].map((el) => el.textContent);
    expect(shown).toEqual(['add a note file', 'Waiting on your answer before I create the batch.', 'Which filename?', 'r1-2 reopened: worker ended without commits: - r2.txt exists  $ cat r2.txt ']);
    const pinned = container.querySelector('.pinned')!;
    const thread = container.querySelector('.thread')!;
    const composer = container.querySelector('.composer')!;
    expect(thread.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pinned.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves a pending question unqualified and marks only the ones the daemon superseded (round 19 R19-1)', async () => {
    const t = (s: number) => `2026-09-13T05:31:${String(s).padStart(2, '0')}.000Z`;
    const base = { role: 'assistant' as const, answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null };
    const rows: ChatRow[] = [
      { ...base, id: 1, kind: 'question', text: 'Which filename should the new note file use?', ts: t(0) },
      // The turn's closing line, and a notice-driven turn after it: the orchestrator writes after asking and is still blocked.
      { ...base, id: 2, kind: 'message', text: 'Waiting on your answer before I create the batch.', ts: t(1) },
      { ...base, id: 3, kind: 'message', text: 'ov-7 landed on feature/x; still waiting on your answer.', ts: t(9) },
    ];
    mockApi(() => rows);
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const asked = await screen.findByText('Which filename should the new note file use?');
    const card = within(asked.closest('.question') as HTMLElement);
    // Nothing qualifies a live question: the caveat and its advice are gone, the buttons are not.
    expect((asked.closest('.question') as HTMLElement).querySelector('.muted')).toBeNull();
    expect(card.getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(card.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    // A question the daemon superseded says so, in the thread, with no answer box.
    const superseded: ChatRow[] = [{ ...base, id: 1, kind: 'question', text: 'Which filename should the new note file use?', ts: t(0), superseded_at: t(9) }];
    cleanup();
    mockApi(() => superseded);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText('No longer waiting for an answer. Reply in the composer if it still matters.');
    expect(container.querySelector('.question')).toBeNull();
  });

  it('disables Send while the message is blank or whitespace only, and Enter sends nothing (round 18 R18-2)', async () => {
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.startsWith('/api/chat')) return chat;
      if (method === 'POST') { posts.push(body); return { ok: true }; }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    const send = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send().disabled).toBe(true); // empty
    fireEvent.change(input, { target: { value: '   ' } });
    expect(send().disabled).toBe(true); // three spaces are not a message
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {}); // flushes the pending effects and promises; nothing may have happened by then
    expect(posts).toEqual([]);
    expect(input.value).toBe('   ');
    fireEvent.change(input, { target: { value: ' ship it ' } });
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(posts).toEqual([{ text: 'ship it', repo: 'r1', open_question_ids: [3] }]));
  });

  it('adds a selected image, enables Send, and removes it again, revoking the preview', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:one'), revokeObjectURL: vi.fn() });
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; throw new Error('unexpected'); });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:one');
  });

  it('shows the draft and pending attachments the shell owns, and reports edits to it', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:host'), revokeObjectURL: vi.fn() });
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; throw new Error('unexpected'); });
    const onText = vi.fn();
    const owned: AttachmentHost = { attachments: [{ file: new File(['png'], 'host.png', { type: 'image/png' }), url: 'blob:host' }], setAttachments: () => {}, hint: null, setHint: () => {} };
    render(<Chat version={0} repos={[repo]} repo="r1" onRepo={() => {}} text="half typed" draftRev={0} onText={onText} onClearText={() => {}} attachments={owned} />);
    const input = await screen.findByLabelText('Message the orchestrator') as HTMLTextAreaElement;
    expect(input.value).toBe('half typed');
    expect(screen.getByAltText('host.png')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'half typed more' } });
    expect(onText).toHaveBeenCalledWith('half typed more');
  });

  it('keys a send completion to the draft revision it started with, not the text', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    let release: () => void = () => {};
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/chat')) return [];
      if (method === 'POST') return new Promise<unknown>((resolve) => { release = () => resolve({ ok: true }); });
      throw new Error('unexpected');
    });
    const onClearText = vi.fn();
    const owned: AttachmentHost = { attachments: [], setAttachments: () => {}, hint: null, setHint: () => {} };
    render(<Chat version={0} repos={[repo]} repo="r1" onRepo={() => {}} text="same" draftRev={7} onText={() => {}} onClearText={onClearText} attachments={owned} />);
    await screen.findByLabelText('Message the orchestrator');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    act(() => release());
    await waitFor(() => expect(onClearText).toHaveBeenCalledWith('r1', 7));
  });

  it('sends raw base64 image attachments', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:one'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('FileReader', class { result: string | null = null; error: DOMException | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.(); } });
    const posts: unknown[] = [];
    mockApi((method, url, body) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; if (method === 'POST') { posts.push(body); return { ok: true }; } throw new Error('unexpected'); });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toEqual([{ text: '', repo: 'r1', attachments: [{ name: 'shot.png', mime: 'image/png', data: 'AQID' }], open_question_ids: [] }]));
  });

  it('ignores attachment changes while a message is in flight', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    vi.stubGlobal('FileReader', class { result: string | null = null; error: DOMException | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.(); } });
    let release: () => void = () => {};
    const posts: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.endsWith('/api/chat')) return [];
      if (method === 'POST') { posts.push(body); return new Promise<unknown>((resolve) => { release = () => resolve({ ok: true }); }); }
      throw new Error('unexpected');
    });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [first] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
    const remove = screen.getByRole('button', { name: 'Remove first.png' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const second = new File(['second'], 'second.png', { type: 'image/png' });
    fireEvent.drop(container.querySelector('.composer')!, { dataTransfer: { files: [second], types: ['Files'] } });
    expect(screen.queryByAltText('second.png')).toBeNull();
    expect(posts).toEqual([{ text: '', repo: 'r1', attachments: [{ name: 'first.png', mime: 'image/png', data: 'AQID' }], open_question_ids: [] }]);
    release();
    await waitFor(() => expect(screen.queryByAltText('first.png')).toBeNull());
  });

  it('adds pasted images and refuses a fifth image', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; throw new Error('unexpected'); });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const input = await screen.findByLabelText('Message the orchestrator');
    const pasted = new File(['png'], 'paste.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }] } });
    expect(screen.getByAltText('paste.png')).toBeTruthy();
    const images = Array.from({ length: 4 }, (_, i) => new File(['png'], `image-${i}.png`, { type: 'image/png' }));
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: images } });
    expect(screen.getByText('At most 4 images can be attached')).toBeTruthy();
    expect(container.querySelectorAll('.attachment-pending')).toHaveLength(4);
  });

  it('refuses an unsupported file type', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; throw new Error('unexpected'); });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    const bad = new File(['text'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [bad] } });
    expect(screen.getByText('notes.txt is not a supported image')).toBeTruthy();
    expect(container.querySelectorAll('.attachment-pending')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an oversized image', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; throw new Error('unexpected'); });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    const huge = new File(['png'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 9 * 1024 * 1024 });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [huge] } });
    expect(screen.getByText('huge.png exceeds 8 MB')).toBeTruthy();
    expect(container.querySelectorAll('.attachment-pending')).toHaveLength(0);
  });

  it('adds a dropped image', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/chat')) return []; throw new Error('unexpected'); });
    const { container } = render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByLabelText('Message the orchestrator');
    const dropped = new File(['png'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(container.querySelector('.composer')!, { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect(screen.getByAltText('dropped.png')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders attachments in a user thread row', async () => {
    mockApi(() => [{ ...chat[0]!, id: 42, attachments: [{ name: 'feedback.png', mime: 'image/png', size: 3 }] }]);
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const image = await screen.findByAltText('feedback.png');
    expect(image.getAttribute('src')).toBe('/api/chat/42/attachments/0');
  });

  it('shimmers a thread-shaped placeholder while the first page is in flight, then the messages', async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { release = r; });
    mockApi(async () => { await pending; return [{ ...chat[0]!, id: 7, text: 'arrived row' }]; });
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const shimmer = await screen.findByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(within(shimmer).getAllByText(/You|Orchestrator/).length).toBeGreaterThan(0);
    // The placeholder prose must not reach a screen reader as thread content: .thread is a live region.
    expect(shimmer.querySelector('.thread-placeholder')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText(/Pick a repository and describe/)).toBeNull();
    release(null);
    await screen.findByText('arrived row');
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('stops the shimmer once the first load has failed, rather than shimmering for the whole outage', async () => {
    mockApi(() => new Response('', { status: 500 }));
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText(OUTAGE_LOAD_NONE);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.queryByText(/Add a greeting endpoint/)).toBeNull(); // no fabricated thread left behind
  });

  it('shows the empty-state line, not the shimmer, for a genuinely empty thread', async () => {
    mockApi(() => []);
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    await screen.findByText(/Pick a repository and describe/);
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('renders attachments on a system notice row', async () => {
    mockApi(() => [{ ...chat[0]!, id: 43, role: 'system', text: 'Batch b1 rejected: wrong colour', attachments: [{ name: 'proof.png', mime: 'image/png', size: 3 }] }]);
    render(<TestChat version={0} repos={[repo]} repo="r1" onRepo={() => {}} />);
    const image = await screen.findByAltText('proof.png');
    expect(image.getAttribute('src')).toBe('/api/chat/43/attachments/0');
  });

  // Day separators, local times and role grouping.
  const msgRow = (id: number, role: ChatRow['role'], ts: string, extra: Partial<ChatRow> = {}): ChatRow => ({
    id, role, kind: 'message', text: `row ${id}`, ts, answer: null, answered_at: null, seen_at: null, replied_at: null, queued_at: null, superseded_at: null, ...extra,
  });
  const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
  /** Run `body` under a fixed offset so a UTC instant's local day and time are predictable wherever the suite runs. */
  const withNyZone = async <T,>(body: () => Promise<T>): Promise<T> => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = 'America/New_York';
    try { return await body(); } finally { process.env.TZ = zone; }
  };

  it('labels a past day with its weekday, day and month', () => {
    expect(dayLabel(new Date(2020, 0, 1, 12, 0).toISOString(), new Date(2026, 8, 23, 12, 0))).toBe('Wed 1 Jan');
  });

  it('formats a stored UTC timestamp as local HH:MM', () => {
    expect(formatTime(new Date(2026, 0, 15, 9, 5).toISOString())).toBe('09:05');
  });

  it('puts a day separator before the first row of each local day, across local midnight', async () => {
    mockApi(() => [
      msgRow(1, 'assistant', new Date(2020, 0, 1, 23, 59).toISOString()),
      msgRow(2, 'assistant', new Date(2020, 0, 2, 0, 1).toISOString()),
    ]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 1');
    expect([...container.querySelectorAll('.chat-day')].map((el) => el.textContent)).toEqual(['Wed 1 Jan', 'Thu 2 Jan']);
  });

  it('labels the current and previous local day Today and Yesterday', async () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0).toISOString();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0).toISOString();
    mockApi(() => [msgRow(1, 'assistant', yesterday), msgRow(2, 'assistant', today)]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 1');
    expect([...container.querySelectorAll('.chat-day')].map((el) => el.textContent)).toEqual(['Yesterday', 'Today']);
  });

  it('does not separate two rows in one local day that straddle midnight UTC', async () => {
    await withNyZone(async () => {
      mockApi(() => [msgRow(1, 'assistant', '2026-09-21T23:30:00.000Z'), msgRow(2, 'assistant', '2026-09-22T00:30:00.000Z')]);
      const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
      await screen.findByText('row 1');
      // The two instants are in different UTC days (a separator keyed on the UTC date would print two) but one New York day.
      expect(new Date('2026-09-21T23:30:00.000Z').getUTCDate()).toBe(21);
      expect(new Date('2026-09-22T00:30:00.000Z').getUTCDate()).toBe(22);
      expect(container.querySelectorAll('.chat-day')).toHaveLength(1);
    });
  });

  it('shows each row time in local time', async () => {
    await withNyZone(async () => {
      mockApi(() => [msgRow(1, 'assistant', '2026-09-21T13:05:00.000Z')]);
      const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
      await screen.findByText('row 1');
      const time = container.querySelector('.msg-time')!;
      expect(time.textContent).toBe('09:05'); // 13:05 UTC is 09:05 in New York; a UTC slice would read 13:05
      expect(time.getAttribute('datetime')).toBe('2026-09-21T13:05:00.000Z');
    });
  });

  it('groups three rows of one role within five minutes', () => {
    const rows = [msgRow(1, 'assistant', local(21, 12, 0)), msgRow(2, 'assistant', local(21, 12, 1)), msgRow(3, 'assistant', local(21, 12, 2))];
    expect(groupThread(rows).map((i) => i.groupStart)).toEqual([true, false, false]);
  });

  it('keeps a five-minute gap inside the group and splits a six-minute one', () => {
    expect(groupThread([msgRow(1, 'assistant', local(21, 12, 0)), msgRow(2, 'assistant', local(21, 12, 5))]).map((i) => i.groupStart)).toEqual([true, false]);
    expect(groupThread([msgRow(1, 'assistant', local(21, 12, 0)), msgRow(2, 'assistant', local(21, 12, 6))]).map((i) => i.groupStart)).toEqual([true, true]);
  });

  it('splits a group when the role changes', () => {
    const rows = [msgRow(1, 'assistant', local(21, 12, 0)), msgRow(2, 'user', local(21, 12, 1))];
    expect(groupThread(rows).map((i) => i.groupStart)).toEqual([true, true]);
  });

  it('keeps a question and a system notice standing alone', () => {
    const rows = [
      msgRow(1, 'assistant', local(21, 12, 0), { kind: 'question' }),
      msgRow(2, 'assistant', local(21, 12, 1)),
      msgRow(3, 'system', local(21, 12, 2)),
      msgRow(4, 'system', local(21, 12, 3)),
    ];
    expect(groupThread(rows).map((i) => i.groupStart)).toEqual([true, true, true, true]);
  });

  it('prints the role label once per group and tightens the rows it continues', async () => {
    mockApi(() => [msgRow(1, 'assistant', local(21, 12, 0)), msgRow(2, 'assistant', local(21, 12, 1)), msgRow(3, 'assistant', local(21, 12, 2))]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 1');
    expect(container.querySelectorAll('.msg-group-start')).toHaveLength(1);
    expect(container.querySelectorAll('.msg-role')).toHaveLength(1);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.msg \+ \.msg:not\(\.msg-group-start\) \{[^}]*margin-top: -6px;/);
  });

  it('carries the time on a group\'s first row without a hover, and hides it on touch where a group continues', async () => {
    mockApi(() => [msgRow(1, 'assistant', local(21, 12, 0)), msgRow(2, 'assistant', local(21, 12, 1))]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 1');
    const [start, cont] = [...container.querySelectorAll('.msg')] as HTMLElement[];
    expect(start!.querySelector('.msg-role .msg-time')).toBeTruthy(); // visible without hover
    expect(start!.querySelector('.msg-time-hover')).toBeNull();
    expect(cont!.querySelector('.msg-time-hover')).toBeTruthy(); // revealed on hover on a pointer device
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toContain('@media (hover: none) and (pointer: coarse) { .msg-time-hover { display: none; } }');
  });

  it('shows no day separator for an empty thread', async () => {
    mockApi(() => ({ rows: [], has_more: false, oldest_id: null }));
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText(/Pick a repository and describe/);
    expect(container.querySelector('.chat-day')).toBeNull();
    expect(container.querySelector('.msg-status')).toBeNull();
  });

  it.each([
    ['Answered', { replied_at: local(21, 12, 2), seen_at: local(21, 12, 1) }],
    ['Seen', { seen_at: local(21, 12, 1) }],
    ['Waiting', { queued_at: local(21, 12, 1) }],
  ] as const)('shows %s from its matching field', async (label, fields) => {
    mockApi(() => [msgRow(1, 'user', local(21, 12, 0), fields)]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 1');
    expect(container.querySelector('.msg-status')?.textContent).toBe(label);
  });

  it('updates Waiting to Seen to Answered from refreshed rows', async () => {
    let rows = [msgRow(1, 'user', local(21, 12, 0), { seen_at: local(21, 12, 1) }), msgRow(2, 'user', local(21, 12, 2))];
    mockApi(() => rows);
    const props = { repos: [repo], repo: '', onRepo: () => {} };
    const { container, rerender } = render(<TestChat version={0} {...props} />);
    await waitFor(() => expect(container.querySelectorAll('.msg-status')[1]?.textContent).toBe('Waiting'));
    rows = [rows[0]!, { ...rows[1]!, seen_at: local(21, 12, 3) }];
    rerender(<TestChat version={1} {...props} />);
    await waitFor(() => expect(container.querySelectorAll('.msg-status')[1]?.textContent).toBe('Seen'));
    rows = [rows[0]!, { ...rows[1]!, replied_at: local(21, 12, 4) }];
    rerender(<TestChat version={2} {...props} />);
    await waitFor(() => expect(container.querySelectorAll('.msg-status')[1]?.textContent).toBe('Answered'));
  });

  it('floats a continuation status ahead of the first text line and reserves nothing on rows without one', async () => {
    mockApi(() => [msgRow(1, 'user', local(21, 12, 0)), msgRow(2, 'user', local(21, 12, 1)), msgRow(3, 'user', local(21, 12, 2), { seen_at: local(21, 12, 3), replied_at: local(21, 12, 4) })]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 3');
    const rows = container.querySelectorAll('.msg-user');
    const stamp = rows[2]!.querySelector('.pre > .msg-continuation-stamp');
    expect(stamp?.querySelector('.msg-status')?.textContent).toBe('Answered');
    expect(stamp).toBe(rows[2]!.querySelector('.pre')!.firstChild); // before the text, so the float sits on its first line
    expect(rows[1]!.querySelector('.msg-continuation-stamp')).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.msg-continuation-stamp\s*\{[^}]*float:\s*right;/);
    expect(css).not.toContain('padding-right: 112px');
  });

  it('leaves an old untracked row without a status', async () => {
    mockApi(() => [msgRow(1, 'user', local(21, 12, 0)), msgRow(2, 'user', local(21, 12, 1), { seen_at: local(21, 12, 2) })]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 2');
    expect(container.querySelectorAll('.msg')[0]?.querySelector('.msg-status')).toBeNull();
  });

  it('never labels assistant or system rows with a message status', async () => {
    mockApi(() => [msgRow(1, 'assistant', local(21, 12, 0), { seen_at: local(21, 12, 1), replied_at: local(21, 12, 2) }), msgRow(2, 'system', local(21, 12, 3), { queued_at: local(21, 12, 4) })]);
    const { container } = render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} />);
    await screen.findByText('row 2');
    expect(container.querySelectorAll('.msg-status')).toHaveLength(0);
  });

  it('keeps the unread divider directly above the first arrival when a new day starts there', async () => {
    const rows = [msgRow(1, 'assistant', new Date(2020, 0, 1, 12, 0).toISOString()), msgRow(2, 'assistant', new Date(2020, 0, 2, 12, 0).toISOString())];
    mockApi(() => ({ rows, has_more: false, oldest_id: 1 }));
    render(<TestChat version={0} repos={[repo]} repo="" onRepo={() => {}} readThrough={{ current: 1 }} />);
    await screen.findByText('row 2');
    const divider = screen.getByText('Unread');
    expect(divider.previousElementSibling?.classList.contains('chat-day')).toBe(true);
    expect(divider.nextElementSibling?.classList.contains('msg')).toBe(true);
    expect(divider.nextElementSibling?.textContent).toContain('row 2');
  });

  it('opens command suggestions for a slash at the start of the draft', async () => {
    renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(screen.getByLabelText('Message the orchestrator'), { target: { value: '/' } });
    const list = await screen.findByRole('listbox');
    expect(list.querySelector('.chat-command-name')?.textContent).toBe('/deploy');
  });

  it('opens command suggestions for a slash after whitespace', async () => {
    renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(screen.getByLabelText('Message the orchestrator'), { target: { value: 'please /' } });
    expect(await screen.findByRole('option', { name: /\/deploy/ })).toBeTruthy();
  });

  it('does not open command suggestions for a slash inside a word', () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: 'a/b' } });
    expect([chat.container.querySelector('.chat-command-list'), chat.commandRequests]).toEqual([null, []]);
  });

  it('filters command names without regard to case and highlights the matching letters', async () => {
    const chat = renderCommandChat([commandEntry('parity-loop', 'Check parity'), commandEntry('release', 'Publish a build')]);
    fireEvent.change(chat.input, { target: { value: '/PARIT' } });
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect([options.map((option) => option.querySelector('.chat-command-name')?.textContent), [...options[0]!.querySelectorAll('mark')].map((mark) => mark.textContent)])
      .toEqual([['/parity-loop'], ['parit', 'parit']]);
  });

  it('ranks description-only matches after name matches', async () => {
    const chat = renderCommandChat([commandEntry('z-description', 'Deploy related work'), commandEntry('b-deploy'), commandEntry('a-deploy')]);
    fireEvent.change(chat.input, { target: { value: '/deploy' } });
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.querySelector('.chat-command-name')?.textContent)).toEqual(['/a-deploy', '/b-deploy', '/z-description']);
  });

  it('inserts the highlighted command on Enter without sending the message', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/dep' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(chat.input, { key: 'Enter' });
    expect([chat.input.value, chat.sent.length]).toEqual(['/deploy ', 0]);
  });

  it('inserts the highlighted command on Tab', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/dep' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(chat.input, { key: 'Tab' });
    expect(chat.input.value).toBe('/deploy ');
  });

  it('closes command suggestions on Escape and keeps the typed text', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/dep' } });
    await screen.findByRole('listbox');
    const documentKeyDown = vi.fn();
    document.addEventListener('keydown', documentKeyDown);
    fireEvent.keyDown(chat.input, { key: 'Escape' });
    document.removeEventListener('keydown', documentKeyDown);
    expect([chat.container.querySelector('.chat-command-list'), chat.input.value, documentKeyDown.mock.calls.length]).toEqual([null, '/dep', 0]);
  });

  it('derives suggestions from a restored draft only after the textarea is focused', async () => {
    const chat = renderCommandChat([commandEntry('foo')], 'r1', [repo], '/foo');
    expect([chat.container.querySelector('.chat-command-list'), chat.commandRequests]).toEqual([null, []]);
    chat.input.setSelectionRange(chat.input.value.length, chat.input.value.length);
    chat.input.focus();
    await screen.findByRole('listbox');
    expect(chat.commandRequests).toEqual(['/api/repos/r1/commands']);
  });

  it('sends on Enter when command suggestions are closed', async () => {
    const chat = renderCommandChat([]);
    fireEvent.change(chat.input, { target: { value: 'hello' } });
    fireEvent.keyDown(chat.input, { key: 'Enter' });
    await waitFor(() => { if (!chat.sent.length) throw new Error('message was not sent'); });
    expect(chat.sent).toEqual([{ text: 'hello', repo: 'r1', open_question_ids: [] }]);
  });

  it('shows no command suggestions when the repository picker has no repo value', () => {
    const chat = renderCommandChat([commandEntry('deploy')], '');
    fireEvent.change(chat.input, { target: { value: '/' } });
    expect([chat.container.querySelector('.chat-command-list'), chat.commandRequests]).toEqual([null, []]);
  });

  it('shows no command suggestions before a repository is picked', () => {
    sessionStorage.removeItem('overseer.chatRepoChosen');
    const repos = [repo, { ...repo, id: 'r2' }];
    const chat = renderCommandChat([commandEntry('deploy')], 'r1', repos);
    fireEvent.change(chat.input, { target: { value: '/' } });
    expect([chat.container.querySelector('.chat-command-list'), chat.commandRequests]).toEqual([null, []]);
  });

  it('closes command suggestions when the filter has no matches', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/nomatch' } });
    await waitFor(() => { if (!chat.commandRequests.length) throw new Error('command list was not fetched'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(chat.container.querySelector('.chat-command-list')).toBeNull();
  });

  it('hides command fetch failures without showing an error', async () => {
    const chat = renderCommandChat(new Error('request failed'));
    fireEvent.change(chat.input, { target: { value: '/' } });
    await waitFor(() => { if (!chat.commandRequests.length) throw new Error('command list was not fetched'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect([chat.container.querySelector('.chat-command-list'), chat.container.querySelector('[role="alert"]')]).toEqual([null, null]);
  });

  it('labels repo and global command suggestions', async () => {
    const chat = renderCommandChat([commandEntry('local', 'Local command', 'repo'), commandEntry('shared', 'Global command', 'global')]);
    fireEvent.change(chat.input, { target: { value: '/' } });
    await screen.findByRole('listbox');
    expect([...chat.container.querySelectorAll('.chat-command-source')].map((tag) => tag.textContent)).toEqual(['repo', 'global']);
  });

  it('moves the highlighted command with Up and Down', async () => {
    const chat = renderCommandChat([commandEntry('alpha'), commandEntry('beta')]);
    fireEvent.change(chat.input, { target: { value: '/' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(chat.input, { key: 'ArrowDown' });
    const down = [...chat.container.querySelectorAll('[role="option"]')].map((option) => option.getAttribute('aria-selected'));
    fireEvent.keyDown(chat.input, { key: 'ArrowUp' });
    const up = [...chat.container.querySelectorAll('[role="option"]')].map((option) => option.getAttribute('aria-selected'));
    expect([down, up]).toEqual([['false', 'true'], ['true', 'false']]);
  });

  it('inserts a command when its row is clicked', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/dep' } });
    fireEvent.click(await screen.findByRole('option', { name: /\/deploy/ }));
    expect(chat.input.value).toBe('/deploy ');
  });

  it('fetches the commands once per repo while the filter changes', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/d' } });
    await screen.findByRole('option', { name: /\/deploy/ });
    fireEvent.change(chat.input, { target: { value: '/de' } });
    await screen.findByRole('option', { name: /\/deploy/ });
    expect(chat.commandRequests).toEqual(['/api/repos/r1/commands']);
  });

  it('fetches and caches each selected repository separately', async () => {
    sessionStorage.setItem('overseer.chatRepoChosen', '1');
    const repos = [repo, { ...repo, id: 'r2' }];
    const chat = renderCommandChat([commandEntry('deploy')], 'r1', repos);
    fireEvent.change(chat.input, { target: { value: '/' } });
    await screen.findByRole('listbox');
    chat.rerender(<TestChat version={0} repos={repos} repo="r2" onRepo={() => {}} />);
    await waitFor(() => { if (chat.commandRequests.length !== 2) throw new Error('second repo was not fetched'); });
    chat.rerender(<TestChat version={0} repos={repos} repo="r1" onRepo={() => {}} />);
    expect(chat.commandRequests).toEqual(['/api/repos/r1/commands', '/api/repos/r2/commands']);
  });

  it('opens suggestions when the caret is at the end of a token', async () => {
    const chat = renderCommandChat([commandEntry('deploy')]);
    fireEvent.change(chat.input, { target: { value: '/deploy after' } });
    chat.input.setSelectionRange(chat.input.value.length, chat.input.value.length);
    fireEvent.select(chat.input);
    const closedAfterTrailingText = chat.container.querySelector('.chat-command-list') === null;
    chat.input.setSelectionRange('/deploy'.length, '/deploy'.length);
    fireEvent.select(chat.input);
    await screen.findByRole('listbox');
    expect([closedAfterTrailingText, chat.container.querySelector('.chat-command-list') !== null]).toEqual([true, true]);
  });

  it('keeps command rows scrollable, two-line, full width, and touch sized', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect([
      /\.chat-command-list\s*\{[^}]*width:\s*100%[^}]*overflow-y:\s*auto/.test(css),
      /\.chat-command-option\s*\{[^}]*min-height:\s*44px/.test(css),
      /\.chat-command-description\s*\{[^}]*-webkit-line-clamp:\s*2/.test(css),
    ]).toEqual([true, true, true]);
  });
});
