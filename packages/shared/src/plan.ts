/** One step of a plan: exactly the fields a bead is created from. `dependsOn` holds indexes into the same steps array, since no bead exists yet. */
export interface PlanStep { title: string; description: string; dependsOn: number[] }
export type PlanStatus = 'draft' | 'approved' | 'discarded';
export interface Plan {
  id: string;
  repo_id: string;
  title: string;
  steps: PlanStep[];
  status: PlanStatus;
  /** Set when approval created the batch. */
  batch_id: string | null;
  /** Bumped on every save; a save or approval carrying an older one is refused, so a stale tab cannot overwrite a newer save. */
  revision: number;
  created_at: string;
  updated_at: string;
}

/**
 * Step indexes in an order where every step comes after the ones it depends on, preferring the lowest index among the steps
 * that are ready, so a plan whose dependencies all point upwards keeps its listed order. Null when the steps form a cycle
 * (or name a step that does not exist).
 */
export function planOrder(steps: PlanStep[]): number[] | null {
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < steps.length) {
    const next = steps.findIndex((s, i) => !done.has(i) && s.dependsOn.every((d) => done.has(d)));
    if (next === -1) return null;
    done.add(next);
    order.push(next);
  }
  return order;
}

/** Why a plan cannot be stored or approved, naming the step as the page numbers it (from 1); null when it can. */
export function planProblem(p: { title: string; steps: PlanStep[] }): string | null {
  if (!p.title.trim()) return 'The plan needs a title.';
  if (p.steps.length === 0) return 'The plan needs at least one step.';
  for (const [i, s] of p.steps.entries()) {
    const n = i + 1;
    if (!s.title.trim()) return `Step ${n} needs a title.`;
    for (const d of s.dependsOn) {
      if (!Number.isInteger(d) || d < 0 || d >= p.steps.length) return `Step ${n} depends on a step that does not exist.`;
      if (d === i) return `Step ${n} cannot depend on itself.`;
    }
  }
  return planOrder(p.steps) ? null : 'The steps depend on each other in a circle.';
}
