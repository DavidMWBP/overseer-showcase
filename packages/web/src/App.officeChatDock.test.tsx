import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BoardResponse, Repo } from '@overseer/shared';
import { App } from './App';
import { lastSocket, mockApi } from './test/setup';
import { batchDetail, board, chat, defaultTiers, doctorOk, repo, status } from './test/fixtures';

vi.mock('./office/pixi/scene', () => import('./test/fakeOfficeScene'));

function rect(width: number, height: number): DOMRect {
  return { width, height, x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
}

function measuredOffice(contentWidth: number, stageWidth: number): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('office')) return rect(contentWidth, 900);
    if (this.classList.contains('office-stage')) return rect(stageWidth, stageWidth * 1056 / 1680);
    return original.call(this);
  });
}

function renderOffice(repositories: Repo[] = [repo], boardResponse: BoardResponse = board) {
  const posts: unknown[] = [];
  history.replaceState(null, '', '#office');
  mockApi((method, url, body) => {
    if (method === 'POST' && url.endsWith('/api/chat')) { posts.push(body); return {}; }
    if (url.endsWith('/api/repos')) return repositories;
    if (url.endsWith('/api/doctor')) return doctorOk;
    if (url.endsWith('/api/settings/orchestrator')) return { model: null, effort: null, promptOverride: null };
    if (url.endsWith('/api/settings/tiers')) return defaultTiers;
    if (url.endsWith('/api/status')) return status;
    if (url.endsWith('/api/daemon')) return { pid: 1, started_at: '2026-09-24T00:00:00.000Z', commit: 'abc', source_head: 'abc', restart_needed: false };
    if (url.endsWith('/api/board')) return boardResponse;
    if (url.endsWith('/api/batches/r1-b1')) return batchDetail;
    if (url.startsWith('/api/chat')) return { rows: chat, has_more: false, oldest_id: chat[0]!.id };
    if (url.endsWith('/api/costs')) return { repos: [], batches: [] };
    if (url.endsWith('/api/plans') || url.endsWith('/api/plans/all')) return [];
    throw new Error(`unexpected ${method} ${url}`);
  });
  render(<App />);
  return { posts };
}

afterEach(() => vi.restoreAllMocks());

describe('Office Chat dock in App', () => {
  it('mounts Chat only in Office and carries its draft to the full Chat view', async () => {
    measuredOffice(1580, 1200);
    const { posts } = renderOffice();
    const dock = await waitFor(() => {
      const element = document.querySelector('.office-chat-dock');
      if (!element) throw new Error('Office Chat dock did not mount');
      return element;
    });
    await within(dock as HTMLElement).findByText('Should the endpoint require auth?');
    const draft = 'This question survives the view switch';
    fireEvent.change(within(dock as HTMLElement).getByRole('textbox', { name: 'Message the orchestrator' }), { target: { value: draft } });
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await waitFor(() => {
      if (document.querySelector('.office-chat-dock')) throw new Error('Office Chat dock is still mounted in the Chat view');
    });
    const chatPage = document.querySelector('.chat') as HTMLElement;
    expect({ dock: document.querySelector('.office-chat-dock'), chats: document.querySelectorAll('.chat').length, draft: (within(chatPage).getByRole('textbox', { name: 'Message the orchestrator' }) as HTMLTextAreaElement).value })
      .toEqual({ dock: null, chats: 1, draft });
    fireEvent.click(within(chatPage).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toEqual([{ text: draft, open_question_ids: [3] }]));
  });

  it('blocks a multi-repository first send from the dock until a repository is chosen', async () => {
    const secondRepo = { ...repo, id: 'r2', path: 'E:/Projects/second-demo' };
    measuredOffice(1580, 1200);
    const { posts } = renderOffice([repo, secondRepo]);
    const dock = await waitFor(() => {
      const element = document.querySelector('.office-chat-dock');
      if (!element) throw new Error('Office Chat dock did not mount');
      return element;
    });
    await waitFor(() => {
      const selector = dock.querySelector<HTMLSelectElement>('select[aria-label="Repo"]');
      if (!selector || selector.value !== '?') throw new Error('Chat has not loaded the repository choice yet');
    });
    fireEvent.change(within(dock as HTMLElement).getByRole('textbox', { name: 'Message the orchestrator' }), { target: { value: 'Create a batch for this request' } });
    fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: 'Send' }));
    const blocked = posts.length === 0 && within(dock as HTMLElement).queryByRole('alert') !== null;
    fireEvent.change(within(dock as HTMLElement).getByRole('combobox', { name: 'Repo' }), { target: { value: 'r2' } });
    fireEvent.change(within(dock as HTMLElement).getByRole('textbox', { name: 'Message the orchestrator' }), { target: { value: 'Create a batch for this request' } });
    fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      if (posts.length !== 1) throw new Error(`expected one send after repository selection, got ${posts.length}`);
    });
    expect({ blocked, posts }).toEqual({ blocked: true, posts: [{ text: 'Create a batch for this request', repo: 'r2', open_question_ids: [3] }] });
  });

  it('closes the App batch panel and focuses docked Chat from the orchestrator', async () => {
    measuredOffice(1580, 1200);
    const batch = board.repos[0]!.batches[0]!;
    const linkedBoard = { ...board, repos: board.repos.map((r) => ({ ...r, batches: r.batches.map((item) => item.id === batch.id ? { ...item, origin_chat_id: chat[0]!.id, linked_chat_ids: [chat[0]!.id], status: 'merged' as const } : item) })) };
    renderOffice([repo], linkedBoard);
    const dock = await waitFor(() => {
      const element = document.querySelector('.office-chat-dock');
      if (!element) throw new Error('Office Chat dock did not mount');
      return element;
    });
    fireEvent.click(within(dock as HTMLElement).getByRole('button', { name: '#9310 Trend chart: merged' }));
    await screen.findByRole('complementary', { name: 'Batch details for r1-b1' });
    lastSocket().push({ type: 'office_snapshot', sessions: [{
      session_id: 'orch', role: 'orchestrator', harness: 'claude', model: 'opus', resolved_model: null, account_label: null,
      bead_id: null, bead_title: null, batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null,
    }] });
    const orchestrator = await screen.findByRole('button', { name: 'claude · opus · orchestrator (focus Chat)' });
    const composer = within(dock as HTMLElement).getByRole('textbox', { name: 'Message the orchestrator' });
    fireEvent.click(orchestrator);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Batch details for r1-b1' })).toBeNull());

    expect({ batchPane: screen.queryByRole('complementary', { name: 'Batch details for r1-b1' }), dock: document.querySelector('.office-chat-dock') !== null, activeElement: document.activeElement, hash: location.hash })
      .toEqual({ batchPane: null, dock: true, activeElement: composer, hash: '#office' });
  });
});
