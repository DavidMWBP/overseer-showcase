import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NeedsStrip, STRIP_ROWS_KEY } from './NeedsStrip';
import type { NeedsYouItem } from '../lib/needsYou';
import { PHONE_QUERY } from '../lib/phoneLayout';

/** A real batch title from the user's own board: sentence-length, and the one that overflowed the first attempt. */
const LONG = 'Lessons from overseer overseer-b33-e4d5: a fallback that degrades the user\'s stated flow is a decision for the user, not a review finding to implement';

const items: NeedsYouItem[] = [
  { kind: 'question', id: '3', repoId: null, label: 'Question', detail: 'Which base branch should the refactor batch use?' },
  { kind: 'decision', id: 'ov-14', repoId: 'r1', label: 'ov-14', detail: 'Add greeting — awaiting your decision' },
  { kind: 'batch', id: 'r1-b33', repoId: 'overseer', label: LONG, detail: 'in review — Merge or Reject' },
];

const itemRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="needs-strip"] .needs-row')];

describe('NeedsStrip', () => {
  it('omits the item strip when the list is empty while keeping the Plans row', () => {
    const { container, rerender } = render(<NeedsStrip items={[]} onOpen={() => {}} />);
    expect(screen.queryByTestId('needs-strip')).toBeNull();
    expect(screen.queryByText('Nothing needs you.')).toBeNull();
    expect(screen.getByRole('button', { name: 'plans' }).textContent).toContain('No draft plans');
    expect(itemRows(container)).toHaveLength(0);
    rerender(<NeedsStrip items={items} onOpen={() => {}} />);
    expect(screen.getByTestId('needs-strip')).toBeTruthy();
    rerender(<NeedsStrip items={[]} onOpen={() => {}} />);
    expect(screen.queryByTestId('needs-strip')).toBeNull();
  });

  it('shimmers the strip while its fetches are in flight, then shows the arrived rows', () => {
    const { rerender } = render(<NeedsStrip items={[]} loading onOpen={() => {}} />);
    const shimmer = screen.getByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(within(shimmer).getAllByText(/Plans|Question/).length).toBeGreaterThan(0);
    expect(within(shimmer).queryByText('Nothing needs you.')).toBeNull();
    // Nothing stored: the Plans row plus the default one item row.
    expect(shimmer.querySelectorAll('.needs-row')).toHaveLength(2);
    rerender(<NeedsStrip items={items} draftPlans={1} onOpen={() => {}} />);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByText('1 draft plan')).toBeTruthy();
    expect(itemRows(document.body as HTMLElement)).toHaveLength(3);
  });

  describe('placeholder rows', () => {
    // One Plans-shaped row (a walked span, not a button the library would paint as one bar) and N item-shaped rows.
    const shape = () => {
      const shimmer = screen.getByTestId('shimmer');
      const plans = shimmer.querySelectorAll('.office-plans-row');
      const item = [...shimmer.querySelectorAll('.office-needs-strip .needs-row')];
      return {
        plans: plans.length,
        plansShape: [...plans].map((row) => `${row.tagName}:${row.querySelector('.needs-mark') ? 'mark' : ''}:${row.querySelector('.needs-title')?.textContent}:${row.querySelector('.needs-detail')?.textContent}`),
        items: item.length,
        itemShape: [...new Set(item.map((row) => `${row.querySelector('.needs-mark') ? 'mark' : ''}:${row.querySelector('.needs-title') ? 'title' : ''}:${row.querySelector('.needs-context') ? 'meta' : ''}`))],
      };
    };
    const plansShape = ['SPAN:mark:Plans:Draft plans'];

    it.each([['0', 0], ['1', 1], ['3', 3]])('reserves the stored %s item rows below one Plans row', (stored, n) => {
      localStorage.setItem(STRIP_ROWS_KEY, stored);
      render(<NeedsStrip items={[]} loading onOpen={() => {}} />);
      expect(shape()).toEqual({ plans: 1, plansShape, items: n, itemShape: n === 0 ? [] : ['mark:title:meta'] });
    });

    it.each([['nothing stored', null], ['a non-number stored', 'many'], ['a negative number stored', '-2'], ['a fraction stored', '1.5'], ['a blank stored', '']])('reserves one item row with %s', (_name, stored) => {
      if (stored !== null) localStorage.setItem(STRIP_ROWS_KEY, stored);
      render(<NeedsStrip items={[]} loading onOpen={() => {}} />);
      expect(shape()).toEqual({ plans: 1, plansShape, items: 1, itemShape: ['mark:title:meta'] });
    });

    // jsdom lays nothing out, so the box match is measured by test:office-strip-layout; this pins the rules it measures.
    it('gives the span rows the button rows\' box, card and a text-length title bar', () => {
      localStorage.setItem(STRIP_ROWS_KEY, '1');
      render(<NeedsStrip items={[]} loading onOpen={() => {}} />);
      const row = screen.getByTestId('shimmer').querySelector('.office-needs-strip .needs-row')!;
      expect(row.tagName).toBe('SPAN');
      expect(row.querySelector('.needs-title > span')?.textContent).toBe('Trend chart on the usage page');
      const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
      expect(css).toMatch(/\.needs-row \{[^}]*width: 100%; box-sizing: border-box;/);
      expect(css).toContain('.office-needs .shimmer-measure-container .needs-row { visibility: visible; }');
      expect(css).toContain('.office-needs .shimmer-measure-container .needs-title > span { display: inline-block; max-width: 100%; overflow: hidden; vertical-align: top; }');
    });
  });

  it('lists each item with its title and context', () => {
    const { container } = render(<NeedsStrip items={items} onOpen={() => {}} />);
    expect(itemRows(container)).toHaveLength(3);
    expect(screen.getByText('ov-14')).toBeTruthy();
    expect(screen.getByText('Add greeting — awaiting your decision')).toBeTruthy();
  });

  it('opens the item that was pressed', () => {
    const onOpen = vi.fn();
    const { container } = render(<NeedsStrip items={items} onOpen={onOpen} />);
    fireEvent.click(itemRows(container)[2]!);
    expect(onOpen).toHaveBeenCalledWith(items[2]);
  });

  it('passes a failed bead item to the shell when its row is pressed', () => {
    const failed: NeedsYouItem = { kind: 'failed', id: 'ov-6', repoId: 'r1', label: 'Failed task', detail: 'ov-6 verification failed' };
    const onOpen = vi.fn();
    render(<NeedsStrip items={[failed]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'verification: Failed task' }));
    expect(onOpen).toHaveBeenCalledWith(failed);
  });

  it('gives the longest title its own clipped, single-line element', () => {
    const { container } = render(<NeedsStrip items={items} onOpen={() => {}} />);
    const title = screen.getByText(LONG);
    expect(title.className).toBe('needs-title');
    expect(title.textContent).toBe(LONG);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toContain('.needs-title, .needs-context { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
    expect(itemRows(container)).toHaveLength(3);
  });

  it('names the repo an item belongs to, and says nothing where there is none', () => {
    render(<NeedsStrip items={items} onOpen={() => {}} />);
    expect(screen.getByText('overseer')).toBeTruthy();
    expect(screen.queryByText('null')).toBeNull();
  });

  it('marks each item row with its kind', () => {
    const { container } = render(<NeedsStrip items={items} onOpen={() => {}} />);
    expect(itemRows(container).map((row) => row.getAttribute('data-kind'))).toEqual(['question', 'decision', 'batch']);
  });

  it('puts Plans first, shows the draft count and opens the plan list', () => {
    const onOpenPlans = vi.fn();
    render(<NeedsStrip items={items} draftPlans={2} onOpen={() => {}} onOpenPlans={onOpenPlans} />);
    const plans = screen.getByRole('button', { name: 'plans' });
    expect(plans.textContent).toContain('2 draft plans');
    expect(plans.compareDocumentPosition(screen.getByTestId('needs-strip')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(plans);
    expect(onOpenPlans).toHaveBeenCalledOnce();
  });

  it('does not cap the Plans row below the Needs content width', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).not.toMatch(/\.office-plans-row\s*\{[^}]*max-width\s*:/);
  });

  describe('the cap and its +N more control', () => {
    // A matchMedia whose PHONE_QUERY answer follows a settable width and notifies its listeners, as a resize would.
    let width = 1280;
    const listeners = new Set<() => void>();
    const setWidth = (w: number) => { width = w; act(() => { for (const l of listeners) l(); }); };
    const stubWidth = (w: number) => {
      width = w;
      listeners.clear();
      vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() { return query === PHONE_QUERY && width <= 767; },
        media: query,
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      }));
    };
    afterEach(() => { vi.unstubAllGlobals(); });

    const many = (n: number): NeedsYouItem[] => Array.from({ length: n }, (_, i) => ({ kind: 'question', id: String(i + 1), repoId: null, label: `Question ${i + 1}`, detail: `Detail ${i + 1}` }));
    const labels = (container: HTMLElement) => itemRows(container).map((row) => row.querySelector('.needs-title')?.textContent);
    const control = () => screen.queryByRole('button', { name: /more$|^Show fewer$/ });

    it('shows no control and no item rows at 0 items', () => {
      stubWidth(1280);
      const { container } = render(<NeedsStrip items={[]} onOpen={() => {}} />);
      expect(itemRows(container)).toHaveLength(0);
      expect(control()).toBeNull();
      expect(container.querySelector('.needs-more')).toBeNull();
    });

    it.each([[390, 3], [1280, 6]])('at %i px shows exactly %i items with no control', (w, n) => {
      stubWidth(w);
      const { container } = render(<NeedsStrip items={many(n)} onOpen={() => {}} />);
      expect(labels(container)).toEqual(many(n).map((item) => item.label));
      expect(container.querySelector('.needs-more')).toBeNull();
    });

    it.each([[390, 4, 3, '+1 more'], [1280, 7, 6, '+1 more'], [390, 24, 3, '+21 more'], [1280, 24, 6, '+18 more']])('at %i px with %i items shows the first %i, then %s', (w, n, shown, text) => {
      stubWidth(w);
      const { container } = render(<NeedsStrip items={many(n)} onOpen={() => {}} />);
      expect(labels(container)).toEqual(many(shown).map((item) => item.label));
      const more = screen.getByRole('button', { name: text });
      expect(more.textContent).toBe(text);
      expect(more.getAttribute('aria-expanded')).toBe('false');
      // One control, after the list, and not counted as an item row.
      expect(container.querySelectorAll('.needs-more')).toHaveLength(1);
      expect(container.querySelector('.needs-list')!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('expands in place to every item in order, then collapses back to the capped list', () => {
      stubWidth(1280);
      const onOpen = vi.fn();
      const { container } = render(<NeedsStrip items={many(24)} onOpen={onOpen} />);
      fireEvent.click(screen.getByRole('button', { name: '+18 more' }));
      expect(labels(container)).toEqual(many(24).map((item) => item.label));
      const fewer = screen.getByRole('button', { name: 'Show fewer' });
      expect(fewer.getAttribute('aria-expanded')).toBe('true');
      // The collapse control is at the end of the list, after the last item.
      expect(itemRows(container)[23]!.compareDocumentPosition(fewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // A row the expansion revealed still does what a row does.
      fireEvent.click(itemRows(container)[20]!);
      expect(onOpen).toHaveBeenCalledWith(many(24)[20]);
      fireEvent.click(fewer);
      expect(labels(container)).toEqual(many(6).map((item) => item.label));
      expect(screen.getByRole('button', { name: '+18 more' })).toBeTruthy();
    });

    // jsdom does not turn a key on a button into its click, as a browser does for a native <button>; the key is sent and the
    // click it causes follows. The live browser run presses the real keys.
    it.each([['Enter', 'Enter'], ['Space', ' ']])('toggles with %s on the focused native button and keeps focus on it', (_name, key) => {
      stubWidth(1280);
      const { container } = render(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      const more = screen.getByRole('button', { name: '+1 more' });
      expect(more.tagName).toBe('BUTTON');
      more.focus();
      const press = () => { fireEvent.keyDown(more, { key }); fireEvent.keyUp(more, { key }); fireEvent.click(more); };
      press();
      expect(itemRows(container)).toHaveLength(7);
      expect(document.activeElement).toBe(more);
      expect(more.textContent).toBe('Show fewer');
      press();
      expect(itemRows(container)).toHaveLength(6);
      expect(document.activeElement).toBe(more);
      expect(more.textContent).toBe('+1 more');
    });

    it('updates N live while capped when an item arrives or leaves', () => {
      stubWidth(1280);
      const { container, rerender } = render(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      expect(control()!.textContent).toBe('+1 more');
      rerender(<NeedsStrip items={many(8)} onOpen={() => {}} />);
      expect(control()!.textContent).toBe('+2 more');
      expect(itemRows(container)).toHaveLength(6);
      rerender(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      expect(control()!.textContent).toBe('+1 more');
      rerender(<NeedsStrip items={many(6)} onOpen={() => {}} />);
      expect(container.querySelector('.needs-more')).toBeNull();
      expect(itemRows(container)).toHaveLength(6);
    });

    it('stays expanded while items arrive or leave, and drops the control once the count reaches the cap', () => {
      stubWidth(1280);
      const { container, rerender } = render(<NeedsStrip items={many(8)} onOpen={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
      rerender(<NeedsStrip items={many(9)} onOpen={() => {}} />);
      expect(itemRows(container)).toHaveLength(9);
      expect(control()!.textContent).toBe('Show fewer');
      rerender(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      expect(itemRows(container)).toHaveLength(7);
      expect(control()!.textContent).toBe('Show fewer');
      rerender(<NeedsStrip items={many(6)} onOpen={() => {}} />);
      expect(itemRows(container)).toHaveLength(6);
      expect(container.querySelector('.needs-more')).toBeNull();
    });

    it('switches the cap at the 767/768 px boundary', () => {
      stubWidth(768);
      const { container } = render(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      expect(itemRows(container)).toHaveLength(6);
      expect(control()!.textContent).toBe('+1 more');
      setWidth(767);
      expect(itemRows(container)).toHaveLength(3);
      expect(control()!.textContent).toBe('+4 more');
      setWidth(768);
      expect(itemRows(container)).toHaveLength(6);
      expect(control()!.textContent).toBe('+1 more');
    });

    it('collapses while the strip is hidden behind another view, and starts capped on a fresh mount', () => {
      stubWidth(1280);
      const { container, rerender, unmount } = render(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '+1 more' }));
      expect(itemRows(container)).toHaveLength(7);
      rerender(<NeedsStrip items={many(7)} active={false} onOpen={() => {}} />);
      rerender(<NeedsStrip items={many(7)} active onOpen={() => {}} />);
      expect(itemRows(container)).toHaveLength(6);
      expect(control()!.textContent).toBe('+1 more');
      fireEvent.click(control()!);
      unmount();
      const again = render(<NeedsStrip items={many(7)} onOpen={() => {}} />);
      expect(itemRows(again.container)).toHaveLength(6);
    });

    it.each([[390, '4', 3], [1280, '7', 6], [1280, '24', 6], [1280, '6', 6]])('reserves the capped rows and the control shape at %i px with %s stored', (w, stored, n) => {
      stubWidth(w);
      localStorage.setItem(STRIP_ROWS_KEY, stored);
      render(<NeedsStrip items={[]} loading onOpen={() => {}} />);
      const shimmer = screen.getByTestId('shimmer');
      expect(shimmer.querySelectorAll('.office-needs-strip .needs-row')).toHaveLength(n);
      expect(shimmer.querySelectorAll('.needs-more')).toHaveLength(Number(stored) > n ? 1 : 0);
      const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
      expect(css).toContain('.office-needs .shimmer-measure-container .needs-more { visibility: visible; }');
    });
  });
});
