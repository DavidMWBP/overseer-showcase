import { describe, it, expect } from 'vitest';
import type { PlanStep } from '@overseer/shared';
import { addStep, moveStep, removeStep, toggleDep } from './planEdit';

const s = (title: string, dependsOn: number[] = []): PlanStep => ({ title, description: '', dependsOn });

describe('planEdit', () => {
  it('adds an empty step at the end', () => {
    expect(addStep([s('a')])).toEqual([s('a'), s('')]);
  });
  it('removes a step, drops references to it and shifts later ones down', () => {
    expect(removeStep([s('a'), s('b', [0]), s('c', [0, 1])], 0)).toEqual([s('b'), s('c', [0])]);
  });
  it('swaps neighbours and remaps every reference', () => {
    expect(moveStep([s('a'), s('b'), s('c', [0, 1])], 1, -1)).toEqual([s('b'), s('a'), s('c', [1, 0])]);
  });
  it('refuses to move a step above one it depends on, or below one that depends on it', () => {
    expect(moveStep([s('a'), s('b', [0])], 1, -1)).toBe('Step 2 depends on step 1, so it stays below it.');
    expect(moveStep([s('a'), s('b', [0])], 0, 1)).toBe('Step 2 depends on step 1, so it stays below it.');
  });
  it('leaves the list alone at either end', () => {
    const steps = [s('a'), s('b')];
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 1, 1)).toBe(steps);
  });
  it('toggles a dependency and keeps the list sorted', () => {
    expect(toggleDep([s('a'), s('b'), s('c', [1])], 2, 0)).toEqual([s('a'), s('b'), s('c', [0, 1])]);
    expect(toggleDep([s('a'), s('b'), s('c', [0, 1])], 2, 0)).toEqual([s('a'), s('b'), s('c', [1])]);
  });
});
