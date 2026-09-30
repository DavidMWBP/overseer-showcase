import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { UsageResponse, UsageTotals } from '@overseer/shared';
import { Usage } from './Usage';
import { CODEX_EST_TITLE, EST_TITLE } from '../lib/usage';
import { mockApi } from '../test/setup';
import { PHONE_QUERY } from '../lib/phoneLayout';

const css = () => readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
const phoneCss = () => css().slice(css().indexOf(`@media ${PHONE_QUERY}`, css().indexOf('.usage-view')));

const totals = (o: Partial<UsageTotals> = {}): UsageTotals => ({
  sessions: 1, reported_cost: 0, reported_unknown: 0, estimated_cost: 0, estimated_unknown: 0, codex_sessions: 0,
  tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 },
  ...o,
});

const LONG_MODEL = 'openai/gpt-5.6-terra-2026-09-01-preview-long-identifier';
const response = (o: Partial<UsageResponse> = {}): UsageResponse => ({
  from: '2026-08-19',
  to: '2026-09-17',
  totals: totals({ sessions: 4, reported_cost: 12.5, reported_unknown: 1, estimated_cost: 9.75, estimated_unknown: 0, codex_sessions: 1, tokens: { input: 1_200_000, output: 40_000, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } }),
  days: [],
  groups: {
    model: [
      { key: 'claude-sonnet-5', label: null, ...totals({ sessions: 2, reported_cost: 12.5, estimated_cost: 8.5 }) },
      { key: LONG_MODEL, label: null, ...totals({ sessions: 1, reported_cost: 0, reported_unknown: 1, estimated_cost: 1.25, codex_sessions: 1 }) },
    ],
    account: [{ key: 'a1', label: 'work laptop', ...totals({ sessions: 3, reported_cost: 12.5 }) }],
    harness: [
      { key: 'claude', label: null, ...totals({ sessions: 3, reported_cost: 12.5, estimated_cost: 8.5 }) },
      { key: 'codex', label: null, ...totals({ sessions: 1, reported_cost: 0, reported_unknown: 1, estimated_cost: 1.25, codex_sessions: 1 }) },
    ],
    repo: [{ key: 'r1', label: '/repos/one', ...totals({ sessions: 4, reported_cost: 12.5 }) }],
  },
  days_by_model: [
    { day: '2026-09-16', key: 'claude-sonnet-5', label: null, ...totals({ sessions: 1, reported_cost: 8, estimated_cost: 6, tokens: { input: 900_000, output: 10_000, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } }) },
    { day: '2026-09-17', key: LONG_MODEL, label: null, ...totals({ sessions: 1, reported_cost: 0, estimated_cost: 1.25, codex_sessions: 1, tokens: { input: 300_000, output: 30_000, cache_read: 0, cache_write: 0, cache_write_1h: 0, reasoning: 0 } }) },
  ],
  ...o,
});

const serve = (r: UsageResponse = response()) => {
  const urls: string[] = [];
  mockApi((_m, url) => { urls.push(url); return r; });
  return urls;
};

describe('Usage', () => {
  it('shows the two cost sums apart, a floor with its count, tokens and sessions', async () => {
    serve();
    render(<Usage />);
    const cards = await screen.findByText('Reported cost').then((el) => el.closest('.usage-cards')!);
    const value = (label: string) => within([...cards.querySelectorAll<HTMLElement>('.usage-card')].find((c) => c.textContent?.startsWith(label))!).getByText(/./, { selector: '.usage-card-value' });
    // 12.50 reported and 9.75 estimated are never summed into one number anywhere on the page.
    expect(value('Reported cost').textContent).toBe('≥ $12.50');
    expect(value('Reported cost').getAttribute('title')).toContain('1 session of 4');
    expect(value('Estimated cost').textContent).toBe('$9.75');
    expect(value('Tokens').textContent).toBe('1.2M');
    expect(value('Sessions').textContent).toBe('4');
    expect(cards.textContent).not.toContain('22.25');
  });

  it('states the restart gap and the codex base-tier caveat next to the cards', async () => {
    serve();
    render(<Usage />);
    await screen.findByText('By model');
    const limits = document.querySelector('.usage-limits')!;
    expect(limits.textContent).toContain('opencode or codex turn');
    expect(limits.textContent).toContain('daemon restarted');
    expect(limits.textContent).toContain('base context tier');
  });

  it('leaves the codex caveat out when the range holds no codex session', async () => {
    const r = response();
    serve(response({ totals: totals({ sessions: 1, reported_cost: 1 }), groups: { model: r.groups.model!.slice(0, 1), harness: [r.groups.harness![0]!] }, days_by_model: [] }));
    render(<Usage />);
    await waitFor(() => expect(document.querySelector('.usage-limits')).toBeTruthy());
    expect(document.querySelector('.usage-limits')!.textContent).toContain('daemon restarted');
    expect(document.querySelector('.usage-limits')!.textContent).not.toContain('base context tier');
    // And no row's `est.` marker claims the caveat either.
    for (const est of document.querySelectorAll('.usage-est')) expect(est.getAttribute('title')).toBe(EST_TITLE);
  });

  it('marks every estimate with est., and only a codex row explains the base context tier', async () => {
    serve();
    render(<Usage />);
    const byHarness = (await screen.findByText('By harness')).closest('section')!;
    const rowFor = (name: string) => [...byHarness.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.startsWith(name))!;
    const estOf = (name: string) => rowFor(name).querySelector('.usage-est')!;
    expect(estOf('codex').getAttribute('title')).toBe(CODEX_EST_TITLE);
    expect(estOf('claude').getAttribute('title')).toBe(EST_TITLE);
    // The codex row never shows a bare dollar figure as a bill: its reported cell is the unknown word, and its estimate wears est.
    expect(rowFor('codex').querySelector('td[data-label="cost"]')!.textContent).toBe('unknown');
    expect(rowFor('codex').querySelector('td[data-label="estimate"]')!.textContent).toBe('$1.25 est.');
  });

  it('refetches the range the picker asks for', async () => {
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
    const urls = serve();
    render(<Usage />);
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain('from=2026-08-19&to=2026-09-17'); // 30 days is the default
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain('from=2026-09-11&to=2026-09-17');
    expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('true');
    vi.useRealTimers();
  });

  it('draws one stacked bar per model per day and redraws it for the estimate and for tokens', async () => {
    serve();
    render(<Usage />);
    const chart = await screen.findByRole('img', { name: /Reported cost per day, stacked by model/ });
    const bars = () => [...document.querySelectorAll('.usage-chart svg rect:not(.usage-hit)')];
    // Reported: only the claude day has a reported figure, so the codex day draws no bar.
    expect(bars()).toHaveLength(1);
    expect(chart.querySelectorAll('.usage-hit').length).toBe(30); // one hit target per calendar day in range
    fireEvent.click(screen.getByRole('button', { name: 'Estimated' }));
    await screen.findByRole('img', { name: /Estimated cost per day/ });
    expect(bars()).toHaveLength(2);
    expect(screen.getByText(/Every figure in this chart is an estimate/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tokens' }));
    await screen.findByRole('img', { name: /Tokens per day/ });
    expect(bars()).toHaveLength(2);
    // Identity is never colour alone: the legend names every series drawn.
    expect([...document.querySelectorAll('.usage-legend li')].map((li) => li.textContent)).toEqual(['claude-sonnet-5', LONG_MODEL]);
  });

  it('names the day and its models on hover', async () => {
    serve();
    render(<Usage />);
    await screen.findByRole('img', { name: /stacked by model/ });
    fireEvent.mouseEnter(document.querySelector('.usage-hit[data-day="2026-09-16"]')!);
    const tip = await screen.findByRole('status');
    expect(tip.textContent).toContain('2026-09-16');
    expect(tip.textContent).toContain('claude-sonnet-5');
    expect(tip.textContent).toContain('$8.00');
  });

  it('opens and closes a day on tap, where there is no hover', async () => {
    serve();
    render(<Usage />);
    await screen.findByRole('img', { name: /stacked by model/ });
    const hit = document.querySelector('.usage-hit[data-day="2026-09-16"]')!;
    // A tap on a phone fires a synthesized mouse enter first; the tooltip must stay open through it and close on the next tap.
    fireEvent.mouseEnter(hit);
    fireEvent.click(hit);
    expect((await screen.findByRole('status')).textContent).toContain('2026-09-16');
    fireEvent.mouseEnter(hit);
    fireEvent.click(hit);
    expect(screen.queryByRole('status')).toBeNull();
    // The bar is a target a finger can find: the stylesheet says so, the handler makes it one.
    expect(css()).toContain('.usage-hit { fill: transparent; cursor: pointer; }');
  });

  it('sorts a breakdown by the column pressed and says which way it points', async () => {
    serve();
    render(<Usage />);
    const byModel = (await screen.findByText('By model')).closest('section')!;
    const names = () => [...byModel.querySelectorAll('tbody td[data-label="name"]')].map((td) => td.textContent);
    expect(names()).toEqual(['claude-sonnet-5', LONG_MODEL]); // cost, descending, by default
    fireEvent.click(within(byModel).getByRole('button', { name: /^sessions/ }));
    expect(names()).toEqual(['claude-sonnet-5', LONG_MODEL]);
    fireEvent.click(within(byModel).getByRole('button', { name: /^sessions/ }));
    expect(names()).toEqual([LONG_MODEL, 'claude-sonnet-5']);
    expect(within(byModel).getByRole('button', { name: /^sessions/ }).closest('th')!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('breaks down by model, account, harness and repository, naming a labelled account by its label', async () => {
    serve();
    render(<Usage />);
    expect((await screen.findByText('By account')).closest('section')!.textContent).toContain('work laptop');
    for (const title of ['By model', 'By account', 'By harness', 'By repository']) expect(screen.getByText(title)).toBeTruthy();
  });

  it('keeps the phone layout in the stylesheet: cards two by two, a chart that scrolls, tables as lists', async () => {
    serve();
    render(<Usage />);
    await screen.findByText('By model');
    const phone = phoneCss();
    expect(css()).toContain('.usage-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(phone).toContain('.usage-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(css()).toMatch(/\.usage-chart-scroll \{[^}]*overflow-x: auto/);
    expect(phone).toContain('.usage-table thead { display: none; }');
    expect(phone).toMatch(/\.usage-table tr \{[^}]*display: block/);
    // The rule only works if the cells carry the labels it prints.
    expect(phone).toContain('.usage-table td[data-label]:not(:first-child)::before { content: attr(data-label) \': \'; color: var(--muted); }');
    expect(document.querySelector('.usage-table td[data-label="tokens"]')).toBeTruthy();
    expect(document.querySelector('.usage-chart-scroll')).toBeTruthy();
  });

  it('paints the series from the fixed chart tokens, one per slot', async () => {
    serve();
    render(<Usage />);
    await screen.findByRole('img', { name: /stacked by model/ });
    // A validated categorical set: every pair clears the CVD and normal-vision floors, so a stacked bar can put any two together.
    for (const n of [1, 2, 3, 4, 5, 6]) expect(css()).toMatch(new RegExp(`--chart-${n}: #[0-9a-f]{6}`));
    const fills = [...document.querySelectorAll('.usage-chart svg rect:not(.usage-hit)')].map((r) => r.getAttribute('fill'));
    expect(fills.every((f) => /^var\(--chart-[1-6]\)$/.test(f ?? ''))).toBe(true);
    expect(new Set(fills).size).toBe(fills.length); // one slot per series, never cycled within a day
  });

  it('keeps the middle band in the stylesheet: at 1000 px and below the cards halve and a table scrolls', async () => {
    serve();
    render(<Usage />);
    await screen.findByText('By model');
    // Measured at a 768 px viewport: the rail leaves the view 496 px of content box and the four-card row wanted 524 px.
    const band = css().slice(css().indexOf('@media (max-width: 1000px)', css().indexOf('.usage-view')));
    expect(band).toContain('.usage-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(band).toContain('.usage-breakdown { overflow-x: auto; }');
    expect(document.querySelector('.usage-breakdown')).toBeTruthy();
  });
});
