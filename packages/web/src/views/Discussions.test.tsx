import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DiscussionDetail } from '@overseer/shared';
import { DISCUSSIONS_EMPTY, DiscussionList, DiscussionThread, TURN_COLLAPSE_CHARS } from './Discussions';
import { mockApi } from '../test/setup';
import { discussionDetail, discussionSummary, discussionTurn, doctorOk } from '../test/fixtures';
import { Toasts } from '../components/Toasts';
import { Setup } from './Setup';
import { PHONE_QUERY } from '../lib/phoneLayout';

const noop = () => {};
const detail = (over: Partial<DiscussionDetail> = {}): DiscussionDetail => ({ ...discussionDetail, ...over });
let attachmentUrl = 0;
function stubAttachmentGlobals() {
  attachmentUrl = 0;
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:discussion-${++attachmentUrl}`), revokeObjectURL: vi.fn() });
  vi.stubGlobal('FileReader', class {
    result: string | null = null;
    error: DOMException | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: File) { this.result = `data:${file.type};base64,AQID`; this.onload?.(); }
  });
}
const imageFile = (name: string, type = 'image/png') => new File([`bytes:${name}`], name, { type });
const selectFiles = (container: HTMLElement, files: File[]) => fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } });
const setQuestion = () => fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Review these images?' } });
/** The API answers one discussion's detail with this body; any other call throws, so a test never passes on an unintended route. */
const serveDetail = (body: unknown, extra?: (method: string, url: string, payload?: unknown) => unknown) =>
  mockApi((method, url, payload) => {
    if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return body;
    const other = extra?.(method, url, payload);
    if (other !== undefined) return other;
    throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
  });

describe('Discussions list', () => {
  it('labels the page experimental and explains when it is useful', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    expect(screen.getByRole('heading', { name: 'Discussions Experimental' })).toBeTruthy();
    expect(screen.getByText('Experimental: best for a wide list of ideas; for a single decision, one model plus a critic did as well for less.')).toBeTruthy();
    expect(await screen.findByText(DISCUSSIONS_EMPTY)).toBeTruthy();
  });
  it('keeps loaded rows under a warning after a failed refetch and clears the warning on recovery', async () => {
    let fail = false;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) {
        if (fail) throw Object.assign(new Error('server error'), { status: 500 });
        return [discussionSummary];
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { rerender } = render(<DiscussionList repos={[]} version={0} onOpen={noop} />);
    await screen.findByRole('button', { name: /Which storage engine\?/ });
    fail = true;
    rerender(<DiscussionList repos={[]} version={1} onOpen={noop} />);
    expect(await screen.findByText(/Showing the last known discussions; they could not be refreshed \(server error\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Which storage engine\?/ })).toBeTruthy();
    fail = false;
    rerender(<DiscussionList repos={[]} version={2} onOpen={noop} />);
    await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
  });

  it('shows the error block when the first list fetch fails', async () => {
    mockApi(() => { throw Object.assign(new Error('server error'), { status: 500 }); });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not load discussions: server error');
    expect(screen.queryByText(DISCUSSIONS_EMPTY)).toBeNull();
  });

  it('shows an empty state when there are no discussions', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    expect(await screen.findByText(DISCUSSIONS_EMPTY)).toBeTruthy();
  });

  it.each([
    ['round 1 finished by all three participants', { turns: 3, rounds: 1, round_in_progress: false }, 'round 1 of 3'],
    ['a partial round 2', { turns: 4, rounds: 2, round_in_progress: true }, 'round 2 of 3 (in progress)'],
    ['round 2 finished after a participant failed', { turns: 5, rounds: 2, round_in_progress: false }, 'round 2 of 3'],
    ['no answer yet', { turns: 0, rounds: 0, round_in_progress: false }, 'no answers yet'],
  ])('shows rounds so far, not turns, for %s', async (_name, over, label) => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [{ ...discussionSummary, ...over }];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    const row = await screen.findByRole('button', { name: /Which storage engine\?/ });
    expect(within(row).getByText(label)).toBeTruthy();
    expect(row.textContent).not.toMatch(/turns?/);
  });

  it('disables Start with a reason while the question is empty', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    expect(await screen.findByText('Enter a question.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Start with a reason when no participant is chosen', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Which storage?' } });
    for (const harness of ['claude', 'codex', 'opencode']) fireEvent.click(screen.getByLabelText(harness));
    expect(screen.getByText('Choose at least one participant.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Start with a reason when the cost cap is zero', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[]} onOpen={noop} />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Which storage?' } });
    fireEvent.change(screen.getByLabelText('Cost cap ($)'), { target: { value: '0' } });
    expect(screen.getByText('The cost cap must be greater than 0.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('defaults to three participants, a $5.00 cap and no repository', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[{ id: 'r1', path: 'E:/x', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0, model_filter: null }]} onOpen={noop} />);
    for (const harness of ['claude', 'codex', 'opencode']) expect((screen.getByLabelText(harness) as HTMLInputElement).checked).toBe(true);
    expect(Number((screen.getByLabelText('Cost cap ($)') as HTMLInputElement).value)).toBe(5);
    expect((screen.getByLabelText('Repository') as HTMLSelectElement).value).toBe('');
  });

  it('posts the form payload on Start and opens the created thread', async () => {
    const onOpen = vi.fn();
    const bodies: unknown[] = [];
    let release: (v: unknown) => void = () => {};
    mockApi((method, url, body) => {
      if (method === 'POST' && url.endsWith('/api/discussions')) { bodies.push(body); return new Promise((r) => { release = r; }); }
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    render(<DiscussionList repos={[]} onOpen={onOpen} />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Which storage?' } });
    fireEvent.change(screen.getByLabelText('Cost cap ($)'), { target: { value: '2.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Starting…' })).toBeTruthy());
    expect(onOpen).not.toHaveBeenCalled();
    act(() => release(discussionDetail));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('d-1'));
    expect(bodies).toEqual([{ question: 'Which storage?', repo_id: null, participants: ['claude', 'codex', 'opencode'], cost_cap: 2.5 }]);
  });

  it.each([1, 4])('sends %i images in selection order', async (count) => {
    stubAttachmentGlobals();
    const files = Array.from({ length: count }, (_, i) => imageFile(`image-${i + 1}.png`));
    const bodies: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      if (method === 'POST' && url.endsWith('/api/discussions')) { bodies.push(body); return discussionDetail; }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { container } = render(<DiscussionList repos={[]} onOpen={noop} />);
    setQuestion();
    selectFiles(container, files);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { attachments?: unknown[] }).attachments).toEqual(files.map((file) => ({ name: file.name, mime: file.type, data: 'AQID' })));
  });

  it('refuses a fifth image with the attachment limit hint', async () => {
    stubAttachmentGlobals();
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/discussions')) return []; throw new Error(`unexpected ${method} ${url}`); });
    const { container } = render(<DiscussionList repos={[]} onOpen={noop} />);
    selectFiles(container, Array.from({ length: 4 }, (_, i) => imageFile(`image-${i + 1}.png`)));
    selectFiles(container, [imageFile('fifth.png')]);
    expect(screen.getByRole('alert').textContent).toBe('At most 4 images can be attached');
    expect(container.querySelectorAll('.attachment-pending')).toHaveLength(4);
  });

  it('shows the shared hint for an unsupported file', async () => {
    stubAttachmentGlobals();
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/discussions')) return []; throw new Error(`unexpected ${method} ${url}`); });
    const { container } = render(<DiscussionList repos={[]} onOpen={noop} />);
    selectFiles(container, [imageFile('notes.txt', 'text/plain')]);
    expect(screen.getByRole('alert').textContent).toBe('notes.txt is not a supported image');
    expect(container.querySelectorAll('.attachment-pending')).toHaveLength(0);
  });

  it('accepts pasted and dropped images on the question', async () => {
    stubAttachmentGlobals();
    mockApi((method, url) => { if (method === 'GET' && url.endsWith('/api/discussions')) return []; throw new Error(`unexpected ${method} ${url}`); });
    const { container } = render(<DiscussionList repos={[]} onOpen={noop} />);
    const question = screen.getByLabelText('Question');
    const pasted = imageFile('pasted.png');
    const dropped = imageFile('dropped.png');
    fireEvent.paste(question, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }] } });
    fireEvent.drop(question, { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect([...container.querySelectorAll('.attachment-pending img')].map((img) => img.getAttribute('alt'))).toEqual(['pasted.png', 'dropped.png']);
  });

  it('removes an image from the request when its preview is removed', async () => {
    stubAttachmentGlobals();
    const bodies: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      if (method === 'POST' && url.endsWith('/api/discussions')) { bodies.push(body); return discussionDetail; }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { container } = render(<DiscussionList repos={[]} onOpen={noop} />);
    setQuestion();
    selectFiles(container, [imageFile('remove.png'), imageFile('keep.png')]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove remove.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { attachments?: unknown[] }).attachments).toEqual([{ name: 'keep.png', mime: 'image/png', data: 'AQID' }]);
  });

  it('keeps the question and images and shows the server error when start fails', async () => {
    stubAttachmentGlobals();
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      if (method === 'POST' && url.endsWith('/api/discussions')) throw new Error('server rejected the image');
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { container } = render(<><DiscussionList repos={[]} onOpen={noop} /><Toasts /></>);
    setQuestion();
    selectFiles(container, [imageFile('retained.png')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not start the discussion: server rejected the image');
    expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('Review these images?');
    expect(screen.getByAltText('retained.png')).toBeTruthy();
  });

  it('clears the question and images after a successful start', async () => {
    stubAttachmentGlobals();
    const onOpen = vi.fn();
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      if (method === 'POST' && url.endsWith('/api/discussions')) return discussionDetail;
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { container } = render(<DiscussionList repos={[]} onOpen={onOpen} />);
    setQuestion();
    selectFiles(container, [imageFile('sent.png')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('d-1'));
    expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('');
    expect(container.querySelectorAll('.attachment-pending')).toHaveLength(0);
  });

  it('sends two attachments with the same filename', async () => {
    stubAttachmentGlobals();
    const bodies: unknown[] = [];
    mockApi((method, url, body) => {
      if (method === 'GET' && url.endsWith('/api/discussions')) return [];
      if (method === 'POST' && url.endsWith('/api/discussions')) { bodies.push(body); return discussionDetail; }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { container } = render(<DiscussionList repos={[]} onOpen={noop} />);
    setQuestion();
    selectFiles(container, [imageFile('same.png'), imageFile('same.png')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { attachments?: unknown[] }).attachments).toEqual([
      { name: 'same.png', mime: 'image/png', data: 'AQID' },
      { name: 'same.png', mime: 'image/png', data: 'AQID' },
    ]);
  });
});

describe('Discussion thread', () => {
  it('renders one linked thumbnail per question attachment from its route', async () => {
    const attachments = [
      { name: 'first.png', mime: 'image/png', size: 3 },
      { name: 'second.png', mime: 'image/png', size: 4 },
    ];
    serveDetail(detail({ attachments }));
    const { container } = render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    const images = [...container.querySelectorAll('.discussion-question-attachments img')];
    expect(images.map((img) => [img.getAttribute('alt'), img.getAttribute('src')])).toEqual([
      ['first.png', '/api/discussions/d-1/attachments/0'],
      ['second.png', '/api/discussions/d-1/attachments/1'],
    ]);
    expect([...container.querySelectorAll('.discussion-question-attachments a')].map((a) => [a.getAttribute('href'), a.getAttribute('target')])).toEqual([
      ['/api/discussions/d-1/attachments/0', '_blank'],
      ['/api/discussions/d-1/attachments/1', '_blank'],
    ]);
  });

  it('renders no question thumbnails when attachments are absent', async () => {
    serveDetail(detail());
    const { container } = render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    expect(container.querySelectorAll('.discussion-question-attachments img')).toHaveLength(0);
  });

  it('keeps the thread, Stop, and an expanded answer after a failed refetch', async () => {
    const long = `${'A'.repeat(TURN_COLLAPSE_CHARS + 50)}THE-END`;
    let fail = false;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) {
        if (fail) throw Object.assign(new Error('server error'), { status: 500 });
        return detail({ turns: [discussionTurn({ id: 1, round: 1, text: long })] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { rerender } = render(<DiscussionThread id="d-1" version={0} onBack={noop} />);
    await screen.findByRole('button', { name: 'Show more' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    fail = true;
    rerender(<DiscussionThread id="d-1" version={1} onBack={noop} />);
    expect(await screen.findByText(/Showing the last known discussion; it could not be refreshed \(server error\)/)).toBeTruthy();
    expect(screen.getByText('Which storage engine?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(screen.getByText(/THE-END$/)).toBeTruthy();
  });

  it('keeps Stopping visible after a failed refetch', async () => {
    let fail = false;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) {
        if (fail) throw Object.assign(new Error('server error'), { status: 500 });
        return detail();
      }
      if (method === 'POST' && url.endsWith('/api/discussions/d-1/stop')) return new Promise(() => {});
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { rerender } = render(<DiscussionThread id="d-1" version={0} onBack={noop} />);
    await screen.findByText('Postgres.');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fail = true;
    rerender(<DiscussionThread id="d-1" version={1} onBack={noop} />);
    await screen.findByText(/Showing the last known discussion/);
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error block when the first thread fetch fails', async () => {
    mockApi(() => { throw Object.assign(new Error('server error'), { status: 500 }); });
    render(<DiscussionThread id="d-1" onBack={noop} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not load the discussion: server error');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('renders the rounds in order, each turn labelled by harness with its cost', async () => {
    serveDetail(detail({
      turns: [
        discussionTurn({ id: 1, round: 1, harness: 'claude', text: 'Postgres.', cost: 0.25 }),
        discussionTurn({ id: 2, round: 1, harness: 'codex', text: 'SQLite.', cost: 0.5 }),
        discussionTurn({ id: 3, round: 2, harness: 'claude', text: 'Still Postgres.', cost: 0.75 }),
      ],
    }));
    const { container } = render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    const rounds = [...container.querySelectorAll('.discussion-round h4')].map((h) => h.textContent);
    expect(rounds).toEqual(['Round 1', 'Round 2']);
    const first = container.querySelectorAll('.discussion-round')[0]!;
    const second = container.querySelectorAll('.discussion-round')[1]!;
    expect([...first.querySelectorAll('.discussion-harness')].map((h) => h.textContent)).toEqual(['claude', 'codex']);
    expect(within(first as HTMLElement).getByText('$0.25')).toBeTruthy();
    expect([...second.querySelectorAll('.discussion-harness')].map((h) => h.textContent)).toEqual(['claude']);
    expect(within(second as HTMLElement).getByText('$0.75')).toBeTruthy();
  });

  it('labels a failed participant and keeps its turns out of later rounds', async () => {
    serveDetail(detail({
      turns: [
        discussionTurn({ id: 1, round: 1, harness: 'claude', text: 'Postgres.' }),
        discussionTurn({ id: 2, round: 1, harness: 'codex', text: 'SQLite.' }),
        discussionTurn({ id: 3, round: 2, harness: 'claude', text: 'Still Postgres.' }),
      ],
      participants: [
        { harness: 'claude', session_id: 's-c', status: 'running', cost: 0.25 },
        { harness: 'codex', session_id: 's-x', status: 'failed', cost: 0.25 },
      ],
    }));
    const { container } = render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    const codex = [...container.querySelectorAll('.discussion-cost li')].find((li) => li.textContent?.includes('codex'))!;
    expect(codex.textContent).toContain('failed');
    const later = container.querySelectorAll('.discussion-round')[1]!;
    expect([...later.querySelectorAll('.discussion-harness')].map((h) => h.textContent)).toEqual(['claude']);
  });

  it('shows a cap stop with its reason and no synthesis', async () => {
    serveDetail(detail({ status: 'stopped', stop_reason: 'cost cap $5 reached after round 1', synthesis: null }));
    render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    expect(screen.getByText('stopped: cost cap $5 reached after round 1')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Synthesis' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send to chat' })).toBeNull();
  });

  it('shows a failed discussion with its reason', async () => {
    serveDetail(detail({ status: 'failed', stop_reason: 'all participants failed after round 1', synthesis: null }));
    render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    expect(screen.getByText('failed: all participants failed after round 1')).toBeTruthy();
  });

  it('offers Stop only while the discussion is running', async () => {
    let stopped = false;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return stopped ? detail({ status: 'stopped' as const, stop_reason: 'stopped by the user' }) : detail();
      throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    });
    const { rerender } = render(<DiscussionThread id="d-1" version={0} onBack={noop} />);
    await screen.findByText('Postgres.');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    stopped = true;
    rerender(<DiscussionThread id="d-1" version={1} onBack={noop} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  });

  it('keeps Stopping visible through a ping until the stop request resolves', async () => {
    let resolveStop!: (value: DiscussionDetail) => void;
    let stopped = false;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return stopped ? detail({ status: 'stopped', stop_reason: 'stopped by the user' }) : detail();
      if (method === 'POST' && url.endsWith('/api/discussions/d-1/stop')) return new Promise<DiscussionDetail>((resolve) => { resolveStop = resolve; });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { rerender } = render(<DiscussionThread id="d-1" version={0} onBack={noop} />);
    await screen.findByText('Postgres.');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
    stopped = true;
    rerender(<DiscussionThread id="d-1" version={1} onBack={noop} />);
    await screen.findByText('stopped: stopped by the user');
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveStop(detail({ status: 'stopped', stop_reason: 'stopped by the user' })));
    expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull();
  });

  it('keeps an expanded answer open after a ping', async () => {
    const long = `${'A'.repeat(TURN_COLLAPSE_CHARS + 50)}THE-END`;
    let gets = 0;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) { gets++; return detail({ turns: [discussionTurn({ id: 1, round: 1, text: gets === 1 ? long : `${long}UPDATED` })] }); }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { rerender } = render(<DiscussionThread id="d-1" version={0} onBack={noop} />);
    await screen.findByRole('button', { name: 'Show more' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    rerender(<DiscussionThread id="d-1" version={1} onBack={noop} />);
    await screen.findByText(/THE-ENDUPDATED$/);
    expect(gets).toBe(2);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(screen.getByText(/THE-ENDUPDATED$/).textContent).toContain('THE-ENDUPDATED');
  });

  it('does not show the previous thread while another id loads', async () => {
    let resolveNext!: (value: DiscussionDetail) => void;
    mockApi((method, url) => {
      if (method === 'GET' && url.endsWith('/api/discussions/d-1')) return detail();
      if (method === 'GET' && url.endsWith('/api/discussions/d-2')) return new Promise<DiscussionDetail>((resolve) => { resolveNext = resolve; });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { rerender } = render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Which storage engine?');
    rerender(<DiscussionThread id="d-2" onBack={noop} />);
    expect(screen.queryByText('Which storage engine?')).toBeNull();
    expect(screen.getByText('loading…')).toBeTruthy();
    await act(async () => resolveNext(detail({ id: 'd-2', question: 'Which cache?' })));
    expect(screen.getByText('Which cache?')).toBeTruthy();
  });

  it('keeps Send to chat disabled while no synthesis exists', async () => {
    serveDetail(detail({ status: 'done', synthesis: null }));
    render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    expect((screen.getByRole('button', { name: 'Send to chat' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the question and the synthesis to chat', async () => {
    const sent: { text?: string }[] = [];
    serveDetail(detail({ status: 'done', synthesis: 'Use Postgres.' }), (method, url, payload) => {
      if (method === 'POST' && url.endsWith('/api/chat')) { sent.push(payload as { text?: string }); return { ok: true }; }
      return undefined;
    });
    render(<DiscussionThread id="d-1" onBack={noop} />);
    await screen.findByText('Postgres.');
    fireEvent.click(screen.getByRole('button', { name: 'Send to chat' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.text).toContain('Which storage engine?');
    expect(sent[0]!.text).toContain('Use Postgres.');
  });

  it('collapses a long answer behind Show more and expands it again', async () => {
    const long = `${'A'.repeat(TURN_COLLAPSE_CHARS + 50)}THE-END`;
    serveDetail(detail({ turns: [discussionTurn({ id: 1, round: 1, text: long })] }));
    render(<DiscussionThread id="d-1" onBack={noop} />);
    const collapsed = await screen.findByText(/A+…$/);
    expect(collapsed.textContent).not.toContain('THE-END');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText(/THE-END$/).textContent).toContain('THE-END');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByText(/A+…$/).textContent).not.toContain('THE-END');
  });
});

describe('Discussions phone layout', () => {
  it('is reachable from Setup, the phone’s way in', () => {
    mockApi((method, url) => { throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 }); });
    const onOpenDiscussions = vi.fn();
    render(<Setup repos={[]} doctor={doctorOk} onOpenDiscussions={onOpenDiscussions} onRefreshDoctor={() => {}} onReposChanged={() => {}} />);
    expect(document.querySelector('.setup-office-link')?.textContent).toBe('Put one question to several models on the Discussions Experimental page. Worker screenshots and captures are on the Evidence page.');
    expect(screen.queryByRole('button', { name: 'Office' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discussions' }));
    expect(onOpenDiscussions).toHaveBeenCalledOnce();
  });

  // jsdom lays nothing out, so the 360 px no-sideways-scroll measurement runs in a browser; these rules are what it depends on.
  it('hides the rail entry on the phone and keeps the page from scrolling sideways', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const phone = css.slice(css.indexOf(`@media ${PHONE_QUERY}`, css.indexOf('.rail-status')));
    // Discussions and Usage stay desktop-only, so Office remains first and the phone tab bar stays at five tabs.
    expect(phone).toContain('.rail-views [data-view="discussions"] { display: none; }');
    // The page's own blocks wrap and refuse to grow, so nothing pushes main past 360 px.
    expect(css).toMatch(/\.discussions-view \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.discussions-view h2 \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.discussion-turn header \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.discussion-turn-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.discussion-row \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.discussion-participants \{[^}]*min-inline-size: 0;/);
    expect(css).toMatch(/\.attachments-pending, \.msg-attachments \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.msg-attachments img \{[^}]*box-sizing: border-box;[^}]*max-width: 240px;/);
    expect(phone).toContain('.msg-attachments img { max-width: 100%; max-height: 160px; }');
  });
});
