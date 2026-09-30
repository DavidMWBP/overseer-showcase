import { vi } from 'vitest';

/** A viewport as a media query sees it: CSS px size, primary pointer and the reduced-motion preference. */
export interface Viewport { width: number; height: number; pointer: 'fine' | 'coarse' | 'none'; reducedMotion?: boolean }

/**
 * Evaluates a media query list against a viewport, since jsdom evaluates none: a comma list of `and`-joined features, each
 * a width, height, pointer, hover or reduced-motion feature. Anything else throws, so a query this cannot read never
 * passes by accident.
 */
export function mediaMatches(query: string, v: Viewport): boolean {
  return query.split(',').some((part) => part.trim().split(/\s+and\s+/).every((feature) => {
    const m = /^\(([a-z-]+):\s*([a-z0-9-]+?)(px)?\)$/.exec(feature.trim());
    if (!m) throw new Error(`unsupported media feature: ${feature}`);
    const [, name, value] = m;
    const n = Number(value);
    switch (name) {
      case 'max-width': return v.width <= n;
      case 'min-width': return v.width >= n;
      case 'max-height': return v.height <= n;
      case 'min-height': return v.height >= n;
      case 'pointer': return v.pointer === value;
      case 'hover': return (value === 'hover') === (v.pointer === 'fine');
      case 'prefers-reduced-motion': return (value === 'reduce') === Boolean(v.reducedMotion);
      default: throw new Error(`unsupported media feature: ${feature}`);
    }
  }));
}

/**
 * Stubs `matchMedia` with lists that answer for a settable viewport and notify their listeners when `set` changes it,
 * as a resize or a rotation does in a browser.
 */
export function stubViewport(initial: Viewport): { set: (next: Viewport) => void } {
  let viewport = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return mediaMatches(query, viewport); },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return { set: (next) => { viewport = next; for (const listener of [...listeners]) listener(); } };
}
