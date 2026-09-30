import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mascot, type MascotState } from './Mascot';

const states: MascotState[] = ['idle', 'thinking', 'working', 'asking', 'sleeping', 'offline', 'error'];
const spriteSheet = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/mascot/me-1.json'), 'utf8'));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(spriteSheet) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Mascot', () => {
  it.each([
    ['idle', 'idle/default/0'],
    ['thinking', 'thinking/default/0'],
    ['working', 'working/default/0'],
    ['asking', 'asking/default/0'],
    ['sleeping', 'sleeping/default/0'],
    ['offline', 'idle/default/0'],
    ['error', 'error/default/0'],
  ] as const)('%s renders its sheet pose', async (state, poseKey) => {
    render(<Mascot state={state} size={64} label={`${state} status`} />);
    await screen.findByTestId('mascot-atlas-image');
    const pose = screen.getByRole('img', { name: `${state} status` }).querySelector('[data-pose-key]');
    expect(pose?.getAttribute('data-pose-key')).toBe(poseKey);
  });

  it('greys the idle pose while offline', async () => {
    render(<Mascot state="offline" size={64} />);
    await screen.findByTestId('mascot-atlas-image');
    expect(screen.getByRole('img').getAttribute('style')).toContain('filter: grayscale(1)');
  });

  it.each([
    ['low', 'idle/low/0'],
    ['normal', 'idle/default/0'],
    ['high', 'idle/high/0'],
  ] as const)('uses the %s energy frames', async (energy, poseKey) => {
    render(<Mascot state="idle" energy={energy} size={64} />);
    await screen.findByTestId('mascot-atlas-image');
    const pose = screen.getByRole('img').querySelector('[data-pose-key]');
    expect(pose?.getAttribute('data-pose-key')).toBe(poseKey);
  });

  it('slows the low-energy frames', async () => {
    const { container, rerender } = render(<Mascot state="idle" energy="low" size={64} />);
    await screen.findByTestId('mascot-atlas-image');
    const lowDuration = container.querySelector('.mascot-atlas-image')?.getAttribute('style')?.match(/--frame-duration: ([^;]+)/)?.[1];
    rerender(<Mascot state="idle" energy="normal" size={64} />);
    const normalDuration = container.querySelector('.mascot-atlas-image')?.getAttribute('style')?.match(/--frame-duration: ([^;]+)/)?.[1];
    expect([lowDuration, normalDuration]).toEqual(['4s', '2s']);
  });

  it('uses the head-and-shoulders bust at size 32', async () => {
    render(<Mascot state="working" energy="low" size={32} />);
    await screen.findByTestId('mascot-atlas-image');
    expect(screen.getByRole('img').querySelector('[data-pose-key]')?.getAttribute('data-pose-key')).toBe('working/bust-low/0');
  });

  it('uses an integer pixel scale for other sizes', async () => {
    render(<Mascot state="idle" size={96} />);
    const image = await screen.findByTestId('mascot-atlas-image');
    expect([screen.getByRole('img').style.width, (image as HTMLImageElement).style.imageRendering]).toEqual(['128px', 'pixelated']);
  });

  it.each(states)('keeps the %s accessible name', (state) => {
    const label = `${state} status`;
    render(<Mascot state={state} size={64} label={label} />);
    expect(screen.getByRole('img', { name: label }).getAttribute('aria-label')).toBe(label);
  });

  it('shows one still frame when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<Mascot state="working" size={64} />);
    const image = await screen.findByTestId('mascot-atlas-image');
    expect((image as HTMLImageElement).style.animation).toBe('none');
  });

  it('falls back to the SVG when the sheet image fails', async () => {
    const { container } = render(<Mascot state="idle" size={64} />);
    const image = await screen.findByTestId('mascot-atlas-image');
    fireEvent.error(image);
    expect(container.querySelector('.mascot svg')).not.toBeNull();
  });

  it('falls back to the SVG when the sheet is empty JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
    const { container } = render(<Mascot state="idle" size={64} />);
    await waitFor(() => {
      expect(container.querySelector('.mascot svg')).not.toBeNull();
    });
  });

  it('falls back to the SVG when the sheet has frames but no meta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ frames: {} }) }));
    const { container } = render(<Mascot state="idle" size={64} />);
    await waitFor(() => {
      expect(container.querySelector('.mascot svg')).not.toBeNull();
    });
  });

  it('falls back to the SVG when the sheet response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('Invalid JSON'))
    }));
    const { container } = render(<Mascot state="idle" size={64} />);
    await waitFor(() => {
      expect(container.querySelector('.mascot svg')).not.toBeNull();
    });
  });

  it('falls back to the SVG on a 404 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { container } = render(<Mascot state="idle" size={64} />);
    await waitFor(() => {
      expect(container.querySelector('.mascot svg')).not.toBeNull();
    });
  });

  it('retries the sheet fetch when a second Mascot mounts after a failure', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async (input: string | URL) => {
      callCount++;
      if (callCount === 1) {
        // First call fails with empty JSON
        return { ok: true, json: async () => ({}) };
      }
      // Second call succeeds
      return { ok: true, json: async () => spriteSheet };
    });
    vi.stubGlobal('fetch', mockFetch);

    // First Mascot gets empty JSON, shows SVG
    const { unmount } = render(<Mascot state="idle" size={64} />);
    await waitFor(() => {
      expect(screen.getByRole('img').querySelector('.mascot svg')).not.toBeNull();
    });

    // Unmount and mount a second Mascot - should retry fetch and succeed
    unmount();
    render(<Mascot state="thinking" size={64} />);

    // Second Mascot should successfully render the atlas image, proving the cache was cleared
    await screen.findByTestId('mascot-atlas-image');
    expect(screen.getByRole('img').querySelector('[data-pose-key]')?.getAttribute('data-pose-key')).toBe('thinking/default/0');
  });
});

describe('me-1 sheet contract', () => {
  // Taken from the sheet on main before the poses were redrawn facing south: [sequence, frame count, frame size].
  const MAIN_SEQUENCES: [string, number, number][] = [
    ['idle/default', 4, 64], ['idle/bust', 4, 32], ['idle/low', 4, 64], ['idle/bust-low', 4, 32],
    ['idle/high', 2, 64], ['idle/bust-high', 2, 32],
    ['thinking/default', 2, 64], ['thinking/bust', 2, 32], ['thinking/low', 2, 64], ['thinking/bust-low', 2, 32],
    ['working/default', 6, 64], ['working/bust', 6, 32], ['working/low', 6, 64], ['working/bust-low', 6, 32],
    ['asking/default', 2, 64], ['asking/bust', 2, 32],
    ['sleeping/default', 2, 64], ['sleeping/bust', 2, 32],
    ['error/default', 2, 64], ['error/bust', 2, 32],
  ];
  const range = (seq: string, n: number) => Array.from({ length: n }, (_, i) => `${seq}/${i}`);
  const MAIN_ANIMATIONS: Record<string, string[]> = Object.fromEntries(MAIN_SEQUENCES.map(([seq, n]) => [seq, range(seq, n)]));
  MAIN_ANIMATIONS['idle/high'] = [...range('idle/default', 4), 'idle/high/0', 'idle/high/1', 'idle/high/0'];
  MAIN_ANIMATIONS['idle/bust-high'] = [...range('idle/bust', 4), 'idle/bust-high/0', 'idle/bust-high/1', 'idle/bust-high/0'];

  it('keeps the frame keys, frame sizes and animations of the sheet on main', () => {
    const expected = Object.fromEntries(MAIN_SEQUENCES.flatMap(([seq, n, size]) => range(seq, n).map((k) => [k, `${size}x${size}`])));
    const actual = Object.fromEntries(
      Object.entries(spriteSheet.frames as Record<string, { frame: { w: number; h: number } }>).map(([k, f]) => [k, `${f.frame.w}x${f.frame.h}`]),
    );
    expect(actual).toEqual(expected);
    expect(spriteSheet.animations).toEqual(MAIN_ANIMATIONS);
  });
});
