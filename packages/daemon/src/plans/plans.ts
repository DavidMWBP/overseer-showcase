import type { Plan, PlanStep } from '@overseer/shared';
import { planOrder, planProblem } from '@overseer/shared';
import type { Db } from '../db/db';
import type { Bus } from '../bus';
import type { TaskStore } from '../beads/store';
import { BATCH_PREFIX } from '../beads/store';
import type { Lifecycle, LifecycleDeps } from '../lifecycle/lifecycle';
import type { Push } from '../push/push';
import { log } from '../util/log';

/** A request the plan cannot satisfy as asked (unknown plan or repo, invalid steps): answered with 400. */
export class PlanError extends Error {}
/** The plan moved on (another save, approved, discarded, an approval already running): answered with 409. */
export class PlanConflictError extends Error {}

export interface PlansDeps { db: Db; store: TaskStore; lifecycle: Lifecycle; bus: Bus; notify: LifecycleDeps['notify']; push?: Push }

const clean = (steps: PlanStep[]): PlanStep[] => steps.map((s) => ({ title: s.title.trim(), description: s.description, dependsOn: [...new Set(s.dependsOn)].sort((a, b) => a - b) }));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Plans are drafts the user edits before any work exists. Until approval they touch no git and no bd state, which is why this
 * lives outside Lifecycle; approval hands them to it (createBatch) and to bd, and from then on the batch rules apply.
 */
export class Plans {
  private approving = new Set<string>();
  constructor(private d: PlansDeps) {}

  drafts(): Plan[] { return this.d.db.plans.drafts(); }

  /** Every plan of every status, newest first — the Office strip's Plans entry list, so an approved or discarded plan stays reachable. */
  all(): Plan[] { return this.d.db.plans.all(); }

  get(id: string): Plan {
    const p = this.d.db.plans.get(id);
    if (!p) throw new PlanError(`plan ${id} not found`);
    return p;
  }

  async propose(repoId: string, title: string, steps: PlanStep[]): Promise<Plan> {
    const { db, bus, notify, push } = this.d;
    if (!db.repos.get(repoId)) throw new PlanError(`repo ${repoId} not found`);
    const problem = planProblem({ title, steps });
    if (problem) throw new PlanError(problem);
    const at = new Date().toISOString();
    const plan: Plan = { id: db.plans.nextId(repoId), repo_id: repoId, title: title.trim(), steps: clean(steps), status: 'draft', batch_id: null, revision: 1, created_at: at, updated_at: at };
    db.plans.insert(plan);
    bus.emit('plans');
    void push?.notify({ title: `${repoId}: plan ready for review`, body: plan.title, url: `#plan/${plan.id}` });
    await notify(`${plan.title}: plan ready for review (${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'})`, {
      hint: 'The plan waits on its own page for the user to edit and approve. Stop here: do not create a batch or beads for it. Approval arrives as its own notice naming the batch and the bead ids.',
    }).catch((err) => log.error('plans: propose notify failed', err));
    return plan;
  }

  save(id: string, body: { title: string; steps: PlanStep[]; revision: number }): Plan {
    if (this.approving.has(id)) throw new PlanConflictError(`plan ${id} is being approved`);
    this.draftAt(id, body.revision);
    const problem = planProblem(body);
    if (problem) throw new PlanError(problem);
    this.d.db.plans.update(id, { title: body.title.trim(), steps: clean(body.steps), revision: body.revision + 1 });
    this.d.bus.emit('plans');
    return this.get(id);
  }

  async approve(id: string, revision: number): Promise<Plan> {
    const { db, store, lifecycle, bus, notify } = this.d;
    if (this.approving.has(id)) throw new PlanConflictError(`plan ${id} is already being approved`);
    const plan = this.draftAt(id, revision);
    const problem = planProblem(plan);
    if (problem) throw new PlanError(problem);
    this.approving.add(id);
    try {
      const repo = db.repos.get(plan.repo_id);
      if (!repo) throw new PlanError(`repo ${plan.repo_id} not found`);
      const batch = await lifecycle.createBatch(repo.id, plan.title);
      const ids: string[] = [];
      try {
        // planProblem already refused a cycle, so the order exists; every dependency's id is set before its dependent is created.
        for (const i of planOrder(plan.steps)!) {
          const s = plan.steps[i]!;
          ids[i] = await store.create(repo.path, { title: s.title, description: s.description, labels: [`${BATCH_PREFIX}${batch.id}`], blockedBy: s.dependsOn.map((d) => ids[d]!) });
        }
      } catch (err) {
        const rollbackErr = await lifecycle.rollbackBatch(batch.id).then(
          () => null,
          (e: unknown) => { log.error(`plans: rollback of ${batch.id} failed`, e); return e; },
        );
        throw new PlanError(
          rollbackErr === null
            ? `approving the plan failed and nothing was kept: ${message(err)}`
            : `approving the plan failed: ${message(err)}; removing batch ${batch.id} also failed, so it may still exist: ${message(rollbackErr)}`,
        );
      }
      db.plans.update(id, { status: 'approved', batch_id: batch.id });
      bus.emit('plans');
      bus.emit('board');
      await notify(`${plan.title}: plan approved by the user; batch ${batch.id} created with beads ${plan.steps.map((_, i) => ids[i]).join(', ')}${batch.warning ? `\n${batch.warning}` : ''}`, {
        wake: true,
        hint: 'The beads and their blocked-by dependencies are already in bd with the batch label: do not create them again. Dispatch the ready ones with spawn_worker(..., batch_id) under the How to work rules.',
      }).catch((err) => log.error('plans: approve notify failed', err));
      return this.get(id);
    } finally {
      this.approving.delete(id);
    }
  }

  discard(id: string): Plan {
    if (this.approving.has(id)) throw new PlanConflictError(`plan ${id} is being approved`);
    const p = this.get(id);
    if (p.status !== 'draft') throw new PlanConflictError(`plan ${id} is ${p.status}`);
    this.d.db.plans.update(id, { status: 'discarded' });
    this.d.bus.emit('plans');
    return this.get(id);
  }

  private draftAt(id: string, revision: number): Plan {
    const p = this.get(id);
    if (p.status !== 'draft') throw new PlanConflictError(`plan ${id} is ${p.status}`);
    if (p.revision !== revision) throw new PlanConflictError(`plan ${id} changed elsewhere (now at revision ${p.revision})`);
    return p;
  }
}
