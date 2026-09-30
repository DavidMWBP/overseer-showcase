import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFaviconBadge } from './useFaviconBadge';

function Badge({ count }: { count: number }) {
  useFaviconBadge(count);
  return null;
}

const favicon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;

describe('useFaviconBadge', () => {
  afterEach(() => {
    document.head.innerHTML = '<link rel="icon" href="/icon.svg" type="image/svg+xml">';
    document.title = 'Overseer';
    vi.restoreAllMocks();
  });

  it('updates the title for the needs-you item count even without canvas support', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { rerender } = render(<Badge count={3} />);
    expect(document.title).toBe('(3) Overseer');
    rerender(<Badge count={0} />);
    expect(document.title).toBe('Overseer');
  });

  it('restores the original icon when the count returns to zero', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { rerender } = render(<Badge count={3} />);
    rerender(<Badge count={0} />);
    expect(favicon().getAttribute('href')).toBe('/icon.svg');
  });

  it('draws the count into a data-url favicon', async () => {
    const fillText = vi.fn();
    const context = { drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText, fillStyle: '', font: '', textAlign: '', textBaseline: '' } as unknown as CanvasRenderingContext2D;
    // pixi.js brings the WebGPU DOM types, whose `getContext('webgpu')` overload is the one `spyOn` infers.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,badge');
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) { queueMicrotask(() => this.onload?.()); }
    });

    const { rerender } = render(<Badge count={3} />);
    await waitFor(() => expect(favicon().href).toBe('data:image/png;base64,badge'));
    expect(fillText).toHaveBeenCalledWith('3', 49, 50);
    rerender(<Badge count={12} />);
    await waitFor(() => expect(fillText).toHaveBeenCalledWith('9+', 49, 50));
  });
});
