import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DESKTOP_QUERY, PHONE_QUERY, isPhoneLayout, usePhoneLayout } from './phoneLayout';
import { mediaMatches, stubViewport, type Viewport } from '../test/viewportMedia';

const coarse = (width: number, height: number): Viewport => ({ width, height, pointer: 'coarse' });
const fine = (width: number, height: number): Viewport => ({ width, height, pointer: 'fine' });

function Probe() {
  return <p>{usePhoneLayout() ? 'phone' : 'desktop'}</p>;
}

describe('the phone layout query', () => {
  it.each([
    ['844x390 coarse', coarse(844, 390), true],
    ['932x430 coarse', coarse(932, 430), true],
    ['900x500 coarse', coarse(900, 500), true],
    ['900x501 coarse', coarse(900, 501), false],
    ['1024x768 coarse', coarse(1024, 768), false],
    ['390x844 coarse', coarse(390, 844), true],
    ['900x480 fine', fine(900, 480), false],
    ['767x1024 fine', fine(767, 1024), true],
    ['768x1024 fine', fine(768, 1024), false],
    ['1440x900 fine', fine(1440, 900), false],
  ])('at %s the phone layout is %s', (_name, viewport, phone) => {
    expect(mediaMatches(PHONE_QUERY, viewport)).toBe(phone);
    expect(mediaMatches(DESKTOP_QUERY, viewport)).toBe(!phone);
    stubViewport(viewport);
    expect(isPhoneLayout()).toBe(phone);
  });

  it('has the desktop query as its exact complement at every size and pointer', () => {
    for (const pointer of ['fine', 'coarse', 'none'] as const) {
      for (let width = 300; width <= 1600; width += 1) {
        for (const height of [300, 499, 500, 501, 502, 600, 767, 768, 1100]) {
          const v = { width, height, pointer };
          expect(mediaMatches(PHONE_QUERY, v) !== mediaMatches(DESKTOP_QUERY, v), `${width}x${height} ${pointer}`).toBe(true);
        }
      }
    }
  });

  it('keeps mouse and trackpad layouts on width alone', () => {
    for (const height of [300, 390, 480, 500, 900]) {
      expect(mediaMatches(PHONE_QUERY, fine(767, height))).toBe(true);
      expect(mediaMatches(PHONE_QUERY, fine(768, height))).toBe(false);
    }
  });

  it('spells the desktop query without `not`, which Safari 16 does not read', () => {
    expect(DESKTOP_QUERY).not.toMatch(/\bnot\b/);
  });

  it('switches layout on a live resize or rotation without a reload', () => {
    const viewport = stubViewport(coarse(390, 844));
    render(<Probe />);
    expect(screen.getByText('phone')).toBeTruthy();
    // Rotating the phone to landscape keeps the phone layout: it is a touch screen 390 px tall.
    act(() => viewport.set(coarse(844, 390)));
    expect(screen.getByText('phone')).toBeTruthy();
    act(() => viewport.set(coarse(1024, 768)));
    expect(screen.getByText('desktop')).toBeTruthy();
    act(() => viewport.set(coarse(844, 390)));
    expect(screen.getByText('phone')).toBeTruthy();
  });
});

describe('the stylesheets', () => {
  const sheets = ['../styles.css', '../office/office.css', '../views/MascotSheet.css'];
  const conditions = sheets.flatMap((sheet) => [...fs.readFileSync(path.resolve(__dirname, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@media ([^{]+?)\s*\{/g)].map((m) => m[1] ?? ''));
  const layoutConditions = conditions.filter((c) => /76[78]px/.test(c));
  const grid: Viewport[] = [];
  for (const pointer of ['fine', 'coarse', 'none'] as const) for (const reducedMotion of [false, true]) {
    for (let width = 300; width <= 1600; width += 7) for (const height of [300, 480, 500, 501, 600, 601, 900]) grid.push({ width, height, pointer, reducedMotion });
  }

  it('uses the phone query or its complement for every phone and desktop block', () => {
    expect(layoutConditions.length).toBeGreaterThan(10);
    expect(layoutConditions.filter((c) => c === PHONE_QUERY).length).toBeGreaterThan(10);
    expect(layoutConditions).toContain(DESKTOP_QUERY);
    for (const condition of layoutConditions) {
      if (condition === PHONE_QUERY || condition === DESKTOP_QUERY) continue;
      // A block narrowed further (a short phone, a desktop with reduced motion) still applies only inside its layout.
      const phoneSide = condition.includes('max-width: 767px');
      // Each of its comma terms extends the matching term of the layout query, so a bare `(max-width: 767px)` block fails here.
      const base = (phoneSide ? PHONE_QUERY : DESKTOP_QUERY).split(', ');
      const terms = condition.split(', ');
      expect(terms.length, condition).toBe(base.length);
      terms.forEach((term, i) => expect(term.startsWith(base[i] ?? ''), condition).toBe(true));
      for (const v of grid) {
        if (mediaMatches(condition, v)) expect(mediaMatches(phoneSide ? PHONE_QUERY : DESKTOP_QUERY, v), `${condition} at ${JSON.stringify(v)}`).toBe(true);
      }
    }
  });

  it('keeps the short-phone question box and the desktop reduced-motion pane inside their layouts', () => {
    const short = layoutConditions.find((c) => c.includes('max-height: 600px'))!;
    const reduced = layoutConditions.find((c) => c.includes('prefers-reduced-motion'))!;
    for (const v of grid) {
      expect(mediaMatches(short, v)).toBe(mediaMatches(PHONE_QUERY, v) && v.height <= 600);
      expect(mediaMatches(reduced, v)).toBe(mediaMatches(DESKTOP_QUERY, v) && Boolean(v.reducedMotion));
    }
  });
});
