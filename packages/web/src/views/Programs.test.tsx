import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Program, ProgramBatchSummary, ProgramDetail } from '@overseer/shared';
import { Programs } from './Programs';
import { mockApi } from '../test/setup';

const program: Program = { id: 'pg1', repo_id: 'r1', title: 'Accounts rework', status: 'open', created_at: '2026-09-28T08:00:00.000Z', origin_chat_id: null };
const batch = (id: string, over: Partial<ProgramBatchSummary> = {}): ProgramBatchSummary => ({ program_id: 'pg1', batch_id: id, lane: 'api', position: 0, title: `Batch ${id}`, status: 'open', beads_total: 4, beads_done: 2, beads_closed: 0, ...over });
const detail = (over: Partial<ProgramDetail> = {}): ProgramDetail => ({ ...program, batches: [batch('b1')], waits: [], entries: [], merge_order: ['b1'], ...over });

function serve(details: ProgramDetail[], list: Program[] = details) {
  const urls: string[] = [];
  mockApi((_method, url) => {
    urls.push(url);
    if (url === '/api/programs') return list;
    const found = details.find((d) => url === `/api/programs/${d.id}`);
    if (found) return found;
    throw Object.assign(new Error(`unexpected ${url}`), { status: 404 });
  });
  return urls;
}

describe('Programs', () => {
  it('says in one line that there are no open programs', async () => {
    serve([]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    expect(await screen.findByText('No open programs. A request with several stories starts one.')).toBeTruthy();
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shimmers instead of claiming there are none while the first fetch runs', () => {
    mockApi(() => new Promise(() => {}));
    render(<Programs version={0} onOpenBatch={() => {}} />);
    expect(screen.getByTestId('shimmer').getAttribute('aria-busy')).toBe('true');
  });

  it('reports a failed fetch and stops shimmering', async () => {
    mockApi(() => { throw Object.assign(new Error('db locked'), { status: 500 }); });
    render(<Programs version={0} onOpenBatch={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the programs: db locked');
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('lists only open programs', async () => {
    const urls = serve([detail()], [program, { ...program, id: 'pg0', title: 'Old program', status: 'done' }]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Accounts rework' })).toBeTruthy();
    expect(screen.queryByText('Old program')).toBeNull();
    expect(urls).not.toContain('/api/programs/pg0');
  });

  it('shows a program with one batch: lane, card, bead count, merge order', async () => {
    serve([detail()]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    const view = await screen.findByRole('region', { name: 'Accounts rework' });
    expect(within(view).getByRole('heading', { level: 3 }).textContent).toBe('Accounts rework open');
    const lane = within(view).getByRole('region', { name: 'Lane api' });
    const card = within(lane).getByRole('button');
    expect(card.textContent).toBe('Batch b1open2/4 beads done');
    expect(within(view).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Batch b1']);
    expect(view.querySelector('.program-merge-order s')).toBeNull();
    expect(within(view).getByText('No entries yet.')).toBeTruthy();
  });

  it('groups batches by lane in lane order and counts closed beads apart', async () => {
    serve([detail({
      batches: [batch('b1', { lane: 'api' }), batch('b2', { lane: 'api', position: 1, beads_closed: 1, beads_done: 1 }), batch('b3', { lane: 'web' })],
      merge_order: [],
    })]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    const api = await screen.findByRole('region', { name: 'Lane api' });
    expect(within(api).getAllByRole('button').map((b) => b.querySelector('.program-batch-title')!.textContent)).toEqual(['Batch b1', 'Batch b2']);
    expect(within(api).getByText('1 landed, 1 closed of 4 beads')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Lane web' })).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('No merge order yet.')).toBeTruthy();
  });

  it('badges a waiting batch with its prerequisite and drops the badge once released', async () => {
    const waiting = detail({ batches: [batch('b1'), batch('b2', { lane: 'web', title: 'Web login' })], waits: [{ batch_id: 'b2', prerequisite_batch_id: 'b1', released: false }], merge_order: ['b1', 'b2'] });
    serve([waiting]);
    const { rerender } = render(<Programs version={0} onOpenBatch={() => {}} />);
    const web = await screen.findByRole('region', { name: 'Lane web' });
    expect(within(web).getByText('waits for Batch b1').className).toBe('chip awaiting');
    expect(within(screen.getByRole('region', { name: 'Lane api' })).queryByText(/waits for/)).toBeNull();

    serve([{ ...waiting, waits: [{ batch_id: 'b2', prerequisite_batch_id: 'b1', released: true }], batches: [batch('b1', { status: 'merged' }), batch('b2', { lane: 'web', title: 'Web login' })] }]);
    rerender(<Programs version={1} onOpenBatch={() => {}} />);
    await vi.waitFor(() => expect(screen.queryByText(/waits for/)).toBeNull());
  });

  it('shows a program whose batches are all merged as done, each merge-order entry struck through', async () => {
    serve([detail({ batches: [batch('b1', { status: 'merged' }), batch('b2', { lane: 'web', status: 'merged' })], merge_order: ['b1', 'b2'] })]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    const view = await screen.findByRole('region', { name: 'Accounts rework' });
    expect(view.querySelector('.program-title .chip')!.textContent).toBe('done');
    const order = view.querySelector('.program-merge-order')!;
    expect([...order.querySelectorAll('li')].map((li) => li.querySelector('s')?.textContent)).toEqual(['Batch b1', 'Batch b2']);
  });

  it('strikes through only the merged entries of a partly merged order', async () => {
    serve([detail({ batches: [batch('b1', { status: 'merged' }), batch('b2', { lane: 'web' })], merge_order: ['b1', 'b2'] })]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    const view = await screen.findByRole('region', { name: 'Accounts rework' });
    expect(view.querySelector('.program-title .chip')!.textContent).toBe('open');
    expect([...view.querySelectorAll('.program-merge-order li')].map((li) => li.querySelector('s') !== null)).toEqual([true, false]);
  });

  it('lists entries newest first in local time with the decision text verbatim', async () => {
    const long = `Keep the old endpoint alive until every client moved:  ${'no-breaking-changes-'.repeat(60)}\nsecond line`;
    const entries = [
      { program_id: 'pg1', kind: 'decision' as const, text: long, created_at: '2026-09-28T08:00:00.000Z', source_chat_id: 4 },
      { program_id: 'pg1', kind: 'ownership' as const, text: 'web lane owns src/views', created_at: '2026-09-28T09:00:00.000Z', source_chat_id: null },
      { program_id: 'pg1', kind: 'note' as const, text: 'api lane first', created_at: '2026-09-28T10:00:00.000Z', source_chat_id: null },
    ];
    serve([detail({ entries })]);
    render(<Programs version={0} onOpenBatch={() => {}} />);
    await screen.findByRole('region', { name: 'Accounts rework' });
    const items = [...document.querySelectorAll('.program-entries > li')];
    expect(items.map((li) => li.querySelector('.muted')!.textContent)).toEqual([
      `${new Date('2026-09-28T10:00:00.000Z').toLocaleString()} · note`,
      `${new Date('2026-09-28T09:00:00.000Z').toLocaleString()} · ownership`,
      `${new Date('2026-09-28T08:00:00.000Z').toLocaleString()} · decision`,
    ]);
    expect(items[2]!.querySelector('.program-entry-text')!.textContent).toBe(long);
  });

  it('opens the batch panel for a clicked card', async () => {
    serve([detail()]);
    const onOpenBatch = vi.fn();
    render(<Programs version={0} onOpenBatch={onOpenBatch} />);
    fireEvent.click(await screen.findByRole('button', { name: /Batch b1/ }));
    expect(onOpenBatch).toHaveBeenCalledWith('b1');
  });

  it('refetches only when the socket version moves', async () => {
    const urls = serve([detail()]);
    const { rerender } = render(<Programs version={0} onOpenBatch={() => {}} />);
    await screen.findByRole('region', { name: 'Accounts rework' });
    const first = urls.length;
    rerender(<Programs version={0} onOpenBatch={() => {}} />);
    expect(urls.length).toBe(first);
    serve([detail({ title: 'Accounts rework v2' })], [{ ...program, title: 'Accounts rework v2' }]);
    rerender(<Programs version={1} onOpenBatch={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Accounts rework v2' })).toBeTruthy();
  });

  it('keeps long text wrapping and lanes collapsing to one column on a phone', () => {
    const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    expect(css).toMatch(/\.program-lanes \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 220px\), 1fr\)\)/);
    expect(css).toMatch(/\.program-entry-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.program-batch \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  });
});
