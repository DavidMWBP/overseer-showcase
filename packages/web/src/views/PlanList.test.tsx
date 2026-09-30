import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Plan as PlanT } from '@overseer/shared';
import { PlanList } from './PlanList';

const plan: PlanT = { id: 'r1-p1', repo_id: 'r1', title: 'Accounts plan', status: 'draft', batch_id: null, revision: 1, created_at: 't', updated_at: 't', steps: [{ title: 'a', description: '', dependsOn: [] }] };

describe('PlanList', () => {
  it('renders the unloaded list exactly as the empty one', () => {
    const { container, rerender } = render(<PlanList plans={null} onOpen={() => {}} />);
    expect(screen.getByText('No plans yet.')).toBeTruthy();
    const unloaded = container.innerHTML;
    rerender(<PlanList plans={[]} onOpen={() => {}} />);
    expect(container.innerHTML).toBe(unloaded);
  });

  it('shimmers the list while it is being fetched, instead of answering "No plans yet."', () => {
    const { rerender } = render(<PlanList plans={null} loading onOpen={() => {}} />);
    const shimmer = screen.getByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    // Two rows: the height this list arrives at; a row is a fixed two-line box, so the count is what reserves the height.
    expect(shimmer.querySelectorAll('.needs-row')).toHaveLength(2);
    expect(screen.queryByText('No plans yet.')).toBeNull();
    rerender(<PlanList plans={[plan]} onOpen={() => {}} />);
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Accounts plan, draft, 1 step' })).toBeTruthy();
  });

  it('still says the list is empty once an empty one has arrived', () => {
    render(<PlanList plans={[]} onOpen={() => {}} />);
    expect(screen.getByText('No plans yet.')).toBeTruthy();
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('lists a plan and reports a row click', () => {
    const onOpen = vi.fn();
    render(<PlanList plans={[plan]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accounts plan, draft, 1 step' }));
    expect(onOpen).toHaveBeenCalledWith('r1-p1');
  });
});
