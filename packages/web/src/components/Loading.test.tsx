import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { Loading } from './Loading';

function stubMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduced && q === '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

/** The library constructs a ResizeObserver on mount; jsdom has none. */
function stubObserver() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
}

/** jsdom lays nothing out: as a browser does, give an element a box only when it holds text. */
function stubLayout() {
  stubObserver();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const size = this.textContent ? 16 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: size * 5, bottom: size, width: size * 5, height: size, toJSON: () => ({}) } as DOMRect;
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const animated = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('div')].filter((d) => d.style.animation.startsWith('shimmer'));

/** The shape every view holds while its data is in flight: the real list, still empty. */
const rowsWhileLoading = (): string[] | null => null;

describe('Loading', () => {
  it('renders the placeholder and keeps the real content out of reach while loading', () => {
    stubMotion(false); stubLayout();
    render(
      <Loading loading placeholder={<ul><li>First row</li><li>Second row</li></ul>}>
        <ul>{rowsWhileLoading()?.map((r) => <li key={r}>{r}</li>)}</ul>
      </Loading>,
    );
    const shimmer = screen.getByTestId('shimmer');
    expect(animated(shimmer)).toHaveLength(2);
    expect(shimmer.querySelector('.shimmer-measure-container')?.getAttribute('aria-hidden')).toBe('true');
    expect(shimmer.querySelector('.shimmer-measure-container')?.textContent).toBe('First rowSecond row');
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('keeps real, non-empty children out of the page while a placeholder stands in', () => {
    stubMotion(false); stubLayout();
    render(
      <Loading loading placeholder={<p>Placeholder row</p>}><p>Real content</p></Loading>,
    );
    expect(screen.queryByText('Real content')).toBeNull();
    expect(screen.getByTestId('shimmer').textContent).toContain('Placeholder row');
  });

  it('announces the loading state to assistive technology', () => {
    stubMotion(false); stubLayout();
    const { rerender } = render(<Loading loading placeholder={<p>Row</p>}><p>Row</p></Loading>);
    expect(screen.getByTestId('shimmer').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    rerender(<Loading loading label="Loading board…" placeholder={<p>Row</p>}><p>Row</p></Loading>);
    expect(screen.getByRole('status').textContent).toBe('Loading board…');
    rerender(<Loading loading={false} label="Loading board…"><p>Row</p></Loading>);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not paint a shimmer for empty real content, so callers must pass placeholder structure', () => {
    // The exact shape the follow-up tasks hold while `/api/board` and friends are in flight: an empty list.
    // The library skips zero-sized elements, and an empty list has no box, so this measures nothing.
    stubMotion(false); stubLayout();
    render(<Loading loading><ul>{rowsWhileLoading()?.map((r) => <li key={r}>{r}</li>)}</ul></Loading>);
    expect(animated(screen.getByTestId('shimmer'))).toHaveLength(0);
  });

  it('uses the theme tokens for the block and the wave', () => {
    stubMotion(false); stubLayout();
    render(<Loading loading placeholder={<p>Row</p>}><p>Row</p></Loading>);
    const block = animated(screen.getByTestId('shimmer'))[0]!;
    expect(block.parentElement?.style.backgroundColor).toContain('var(--line)');
    expect(block.style.background).toContain('var(--muted)');
  });

  it('renders only the content once loaded', () => {
    stubMotion(false);
    const { container } = render(<Loading loading={false} placeholder={<p>Placeholder</p>}><p>Loaded</p></Loading>);
    expect(container.innerHTML).toBe('<p>Loaded</p>');
  });

  it('hides the measuring copy, whose borders and backgrounds would show through', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.shimmer-measure-container\s*\{\s*visibility:\s*hidden;/);
  });

  it('stops the animation under prefers-reduced-motion', () => {
    stubMotion(true); stubLayout();
    render(<Loading loading placeholder={<p>Row</p>}><p>Row</p></Loading>);
    const shimmer = screen.getByTestId('shimmer');
    expect(shimmer.className).toBe('shimmer shimmer-still');
    expect(animated(shimmer)).toHaveLength(1);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.shimmer-still \*\s*\{\s*animation:\s*none !important;/);
  });

  it('keeps the animation without reduced motion', () => {
    stubMotion(false); stubLayout();
    render(<Loading loading placeholder={<p>Row</p>}><p>Row</p></Loading>);
    expect(screen.getByTestId('shimmer').className).toBe('shimmer');
  });
});
