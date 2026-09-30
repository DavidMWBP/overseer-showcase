import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { Toasts, TOAST_MS } from './Toasts';
import { pushToast } from '../lib/toasts';
import { actionToast, pendingLabel, actionName, refusalToast } from '../lib/actions';

describe('Toasts', () => {
  it('shows a failure with the daemon message and keeps it until dismissed', () => {
    render(<Toasts />);
    act(() => { pushToast('failure', 'Merge failed: merge conflict in src/a.ts'); });
    expect(screen.getByRole('alert').textContent).toContain('Merge failed: merge conflict in src/a.ts');
    vi.useFakeTimers();
    try {
      act(() => { vi.advanceTimersByTime(TOAST_MS * 4); });
      expect(screen.getByRole('alert')).toBeTruthy(); // a failure never dismisses itself
    } finally { vi.useRealTimers(); }
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('auto-dismisses a success after the timeout', () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      act(() => { pushToast('success', 'ov-5 merged.'); });
      expect(screen.getByRole('status').textContent).toContain('ov-5 merged.');
      act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
      expect(screen.getByRole('status')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('stacks the results of two actions on different targets', () => {
    render(<Toasts />);
    act(() => { pushToast('success', 'r1-b1 merged.'); pushToast('failure', 'Merge failed: batch r1-b2 is being merged'); });
    expect(screen.getByRole('status').textContent).toContain('r1-b1 merged.');
    expect(screen.getByRole('alert').textContent).toContain('Merge failed: batch r1-b2 is being merged');
    expect(document.querySelectorAll('.toasts .toast')).toHaveLength(2);
  });

  it('places the message and dismiss control in the same flex row', () => {
    render(<Toasts />);
    act(() => { pushToast('success', 'Discussion sent to chat.'); });
    const toast = screen.getByRole('status');
    expect([...toast.children].map((child) => child.classList.contains('toast-text') ? 'text' : child.classList.contains('toast-dismiss') ? 'dismiss' : 'other')).toEqual(['text', 'dismiss']);
    expect(toast.classList.contains('toast')).toBe(true);
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.toast\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.toast \.toast-text\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.toast \.toast-dismiss\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  });
});

describe('action wording', () => {
  it('names each action and the word its button reads while it runs', () => {
    expect(actionName('merge')).toBe('Merge');
    expect(actionName('close-landed')).toBe('Retry close');
    expect(pendingLabel('merge')).toBe('Merging…');
    expect(pendingLabel('interrupt')).toBe('Stopping…');
    expect(pendingLabel('verify')).toBe('Retrying…');
    expect(pendingLabel('redispatch')).toBe('Re-dispatching…');
    expect(pendingLabel('accept-review')).toBe('Landing…');
  });

  it('turns an action result into its toast text', () => {
    expect(actionToast({ job_id: 'j', action: 'merge', target: 'ov-5', ok: true, message: null, data: null })).toEqual({ kind: 'success', text: 'ov-5 merged.' });
    expect(actionToast({ job_id: 'j', action: 'merge', target: 'r1-b1', ok: false, message: 'merge conflict in src/a.ts', data: null })).toEqual({ kind: 'failure', text: 'Merge failed: merge conflict in src/a.ts' });
    expect(refusalToast('close', 'bead ov-9 is busy: a worker runs on it')).toBe('Could not close the bead: bead ov-9 is busy: a worker runs on it');
  });
});
