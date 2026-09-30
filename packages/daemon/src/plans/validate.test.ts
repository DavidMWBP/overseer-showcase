import { describe, it, expect } from 'vitest';
import { planOrder, planProblem, type PlanStep } from '@overseer/shared';

const step = (title: string, dependsOn: number[] = []): PlanStep => ({ title, description: '', dependsOn });

describe('planProblem', () => {
  it('accepts a plan with a title and titled steps', () => {
    expect(planProblem({ title: 'Accounts', steps: [step('Table'), step('Login', [0])] })).toBeNull();
  });
  it('needs a plan title', () => {
    expect(planProblem({ title: '  ', steps: [step('Table')] })).toBe('The plan needs a title.');
  });
  it('needs at least one step', () => {
    expect(planProblem({ title: 'Accounts', steps: [] })).toBe('The plan needs at least one step.');
  });
  it('names a step without a title, counting from 1', () => {
    expect(planProblem({ title: 'Accounts', steps: [step('Table'), step(' ')] })).toBe('Step 2 needs a title.');
  });
  it('refuses a dependency on a step that does not exist, including a fractional one', () => {
    expect(planProblem({ title: 'A', steps: [step('Table', [3])] })).toBe('Step 1 depends on a step that does not exist.');
    expect(planProblem({ title: 'A', steps: [step('Table'), step('Login', [0.5])] })).toBe('Step 2 depends on a step that does not exist.');
  });
  it('refuses a step that depends on itself', () => {
    expect(planProblem({ title: 'A', steps: [step('Table', [0])] })).toBe('Step 1 cannot depend on itself.');
  });
  it('refuses a cycle', () => {
    expect(planProblem({ title: 'A', steps: [step('Table', [1]), step('Login', [0])] })).toBe('The steps depend on each other in a circle.');
  });
});

describe('planOrder', () => {
  it('keeps the listed order when every dependency is earlier', () => {
    expect(planOrder([step('a'), step('b', [0]), step('c', [1])])).toEqual([0, 1, 2]);
  });
  it('puts a step after one listed below it that it depends on', () => {
    expect(planOrder([step('a', [1]), step('b'), step('c')])).toEqual([1, 0, 2]);
  });
});
