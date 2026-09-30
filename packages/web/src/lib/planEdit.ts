import type { PlanStep } from '@overseer/shared';

/** Pure edits on a plan's steps. Every one keeps `dependsOn` pointing at the same steps after the list changes shape. */
export const addStep = (steps: PlanStep[]): PlanStep[] => [...steps, { title: '', description: '', dependsOn: [] }];

export const removeStep = (steps: PlanStep[], i: number): PlanStep[] =>
  steps.filter((_, j) => j !== i).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== i).map((d) => (d > i ? d - 1 : d)) }));

/**
 * Swaps step `i` with the neighbour in `dir`. Refused, with the reason, when one of the two depends on the other: the list
 * reads top to bottom with every step below the ones it waits on. Out of range, the same list comes back.
 */
export function moveStep(steps: PlanStep[], i: number, dir: -1 | 1): PlanStep[] | string {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return steps;
  const [upper, lower] = dir === -1 ? [j, i] : [i, j];
  if (steps[lower]!.dependsOn.includes(upper)) return `Step ${lower + 1} depends on step ${upper + 1}, so it stays below it.`;
  const swap = (d: number) => (d === i ? j : d === j ? i : d);
  const next = steps.map((s) => ({ ...s, dependsOn: s.dependsOn.map(swap) }));
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export const toggleDep = (steps: PlanStep[], i: number, j: number): PlanStep[] =>
  steps.map((s, k) => (k !== i ? s : {
    ...s,
    dependsOn: s.dependsOn.includes(j) ? s.dependsOn.filter((d) => d !== j) : [...s.dependsOn, j].sort((a, b) => a - b),
  }));
