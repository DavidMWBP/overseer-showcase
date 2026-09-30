import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BoardCard } from '@overseer/shared';
import { Activity } from './Activity';
import { board } from '../test/fixtures';

const running = (id: string, title: string, elapsed_ms: number): BoardCard => ({
  ...board.repos[0]!.cards[2]!,
  bead: { ...board.repos[0]!.cards[2]!.bead, id, title },
  elapsed_ms,
});

describe('Activity', () => {
  it('shows the three longest-running workers first and counts the rest', () => {
    render(<Activity cards={[
      running('one', 'One', 60_000),
      running('two', 'Two', 300_000),
      running('three', 'Three', 120_000),
      running('four', 'Four', 240_000),
      running('five', 'Five', 180_000),
    ]} />);

    const rows = document.querySelectorAll('.activity-row');
    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => row.textContent)).toEqual([
      expect.stringContaining('Two'),
      expect.stringContaining('Four'),
      expect.stringContaining('Five'),
    ]);
    expect(screen.getByText('and 2 more running')).toBeTruthy();
    expect(screen.getByText('Two').getAttribute('title')).toBe('Two');
  });

  it('does not show a remaining count when every worker fits', () => {
    render(<Activity cards={[running('one', 'One', 60_000), running('two', 'Two', 120_000)]} />);
    expect(document.querySelectorAll('.activity-row')).toHaveLength(2);
    expect(screen.queryByText(/more running/)).toBeNull();
  });

  it('gives the desktop strip fixed-width elapsed and cost columns so bars align', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    const rule = css.match(/\.activity-row \{[^}]*grid-template-columns:\s*([^;]+);/);
    expect(rule?.[1]).toBe('minmax(0, 1fr) 220px 64px 56px');
  });
});
