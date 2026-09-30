import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type { OrchestratorActivity, StatusResponse } from '@overseer/shared';
import { Rail } from './Rail';
import { fmtCostTotal } from '../api';
import { repo, status } from '../test/fixtures';
import { PHONE_QUERY } from '../lib/phoneLayout';
import { stubViewport } from '../test/viewportMedia';
const phoneStyles = (css: string) => css.slice(css.indexOf(`@media ${PHONE_QUERY}`, css.indexOf('.rail-status')));

const base = { repos: [], status, costs: null, counts: { running: 0, questions: 0, failed: 0, review: 0, reviewWaiting: 0 }, view: 'board' as const, onView: () => {}, onRepo: () => {}, setupAlert: false, onNewSession: () => {} };

describe('Rail', () => {
  it('renders the eight views as a labelled nav with aria-current on the active one, and reports a tab press', () => {
    const onView = vi.fn();
    const { rerender } = render(<Rail {...base} view="chat" onView={onView} />);
    const nav = screen.getByRole('navigation', { name: 'Views' });
    const tabs = [...nav.querySelectorAll('button')];
    expect(tabs.map((b) => b.textContent)).toEqual(['Office', 'Board', 'Chat', 'Review', 'Usage', 'DiscussionsExperimental', 'Evidence', 'Setup']);
    expect(tabs.map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'page', null, null, null, null, null]);
    fireEvent.click(screen.getByRole('button', { name: 'Office' }));
    expect(onView).toHaveBeenCalledWith('office');
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(onView).toHaveBeenCalledWith('usage');
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(onView).toHaveBeenCalledWith('evidence');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onView).toHaveBeenCalledWith('review');
    rerender(<Rail {...base} view="setup" onView={onView} setupAlert />);
    expect(screen.getByRole('button', { name: /^Setup/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBeNull();
    // The repo list and the status block are not inside the view nav: on phones they move above main while the nav becomes the tab bar.
    expect(nav.querySelector('.rail-repo, .rail-status')).toBeNull();
  });
  it('keeps five phone tabs with Office first and without Needs, Usage, Discussions or Evidence', () => {
    render(<Rail {...base} counts={{ running: 1, questions: 1, failed: 1, review: 1, reviewWaiting: 0 }} setupAlert />);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const phone = phoneStyles(css);
    const nav = screen.getByRole('navigation', { name: 'Views' });
    expect(nav.querySelectorAll('button')).toHaveLength(8);
    expect(nav.querySelector('button[data-view="needs"]')).toBeNull();
    const phoneTabs = [...nav.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !['usage', 'discussions', 'evidence'].includes(button.dataset.view ?? ''));
    expect(phoneTabs.map((button) => button.textContent?.replace(/\d+$/, ''))).toEqual(['Office', 'Board', 'Chat', 'Review', 'Setup']);
    expect(phone).toContain('.rail-views button { flex: 1; justify-content: center; gap: 6px; min-height: 44px; min-width: 44px; border-radius: 0; padding: 0 4px; }');
    expect(phone).not.toContain('.rail-views [data-view="office"] { display: none; }');
    expect(phone).toContain('.rail-views [data-view="usage"] { display: none; }');
    expect(phone).toContain('.rail-views [data-view="discussions"] { display: none; }');
    expect(phone).toContain('.rail-views [data-view="evidence"] { display: none; }');
  });
  it('opens Setup at the daemon when restart is needed', () => {
    const onView = vi.fn();
    render(<Rail {...base} daemon={{ pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true }} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart needed' }));
    expect(onView).toHaveBeenCalledWith('setup', { section: 'daemon' });
  });
  it('puts desktop metadata before Restart needed in the centred status column', () => {
    const statusWithMetadata: StatusResponse = { ...status, orchestrator: { ...status.orchestrator, context: { tokens: 100, window: 100 }, last_activity_at: new Date().toISOString() } };
    render(<Rail {...base} status={statusWithMetadata} daemon={{ pid: 123, started_at: '2026-09-15T09:00:00.000Z', commit: 'abc', source_head: 'def', restart_needed: true }} />);
    const children = Array.from(document.querySelector('.rail-status')!.children);
    expect(children.findIndex((el) => el.classList.contains('rail-status-metadata'))).toBeLessThan(children.findIndex((el) => el.classList.contains('daemon-restart-needed')));
  });
  it('keeps "last active" moving without a status refetch', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-12T10:00:30.000Z'));
      render(<Rail {...base} />);
      expect(screen.getByText('last active just now')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(screen.getByText('last active 5 min ago')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
  it('gives count badges classes that no view root rule can match, and explains them in a tooltip', () => {
    const { container } = render(<Rail {...base} counts={{ running: 2, questions: 1, failed: 0, review: 0, reviewWaiting: 0 }} />);
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    // Selectors made of exactly one class (".chat {", ".board {") style whole views; a badge class must never be one of them unless it is the badge's own.
    const singleClassRules = new Set([...css.matchAll(/^\.([\w-]+)\s*\{/gm)].map((m) => m[1]!));
    const badges = [...container.querySelectorAll('.count')];
    expect(badges.map((b) => b.textContent)).toEqual(['2', '1']);
    for (const badge of badges) {
      for (const cls of badge.classList) {
        if (cls.startsWith('count')) continue;
        expect(singleClassRules.has(cls), `badge class "${cls}" collides with a view rule`).toBe(false);
      }
    }
    // The count reaches screen readers through the accessible name; the visible text is still the label plus the badge.
    expect(screen.getByRole('button', { name: 'Board, 2 workers running' }).title).toBe('2 workers running');
    expect(screen.getByRole('button', { name: 'Chat, 1 question waiting for your answer' }).title).toBe('1 question waiting for your answer');
    expect(screen.queryByRole('button', { name: /^Needs/ })).toBeNull();
    // Review 0: no badge, a plain name and no tooltip.
    expect(screen.getByRole('button', { name: 'Review' }).title).toBe('');
    expect(screen.getByRole('button', { name: 'Discussions Experimental' }).querySelector('.experimental-tag')?.textContent).toBe('Experimental');
    expect(screen.getByRole('button', { name: 'Review' }).querySelector('.count')).toBeNull();
    expect(screen.getByRole('button', { name: 'Setup' }).title).toBe('');
    expect(screen.getByRole('button', { name: 'Board, 2 workers running' }).textContent).toBe('Board2');
    expect(screen.getByRole('button', { name: 'New session' }).title).toMatch(/fresh one/);
  });
  it('labels ready and waiting review counts while showing only ready batches in the badge', () => {
    const { rerender } = render(<Rail {...base} counts={{ ...base.counts, review: 1, reviewWaiting: 1 }} />);
    const readyAndWaiting = screen.getByRole('button', { name: 'Review, 1 ready for review, 1 waiting' });
    expect(readyAndWaiting.title).toBe('1 ready for review, 1 waiting');
    expect(readyAndWaiting.textContent).toBe('Review1');
    expect(readyAndWaiting.querySelector('.count-review')?.textContent).toBe('1');

    rerender(<Rail {...base} counts={{ ...base.counts, review: 1 }} />);
    const readyOnly = screen.getByRole('button', { name: 'Review, 1 ready for review' });
    expect(readyOnly.title).toBe('1 ready for review');
    expect(readyOnly.querySelector('.count-review')?.textContent).toBe('1');

    rerender(<Rail {...base} counts={{ ...base.counts, reviewWaiting: 1 }} />);
    const waitingOnly = screen.getByRole('button', { name: 'Review, 0 ready for review, 1 waiting' });
    expect(waitingOnly.title).toBe('0 ready for review, 1 waiting');
    expect(waitingOnly.querySelector('.count')).toBeNull();

    rerender(<Rail {...base} />);
    const empty = screen.getByRole('button', { name: 'Review' });
    expect(empty.title).toBe('');
    expect(empty.querySelector('.count')).toBeNull();
  });
  it('pins a phone badge to its label corner out of flow, and keeps it at the row end on desktop', () => {
    render(<Rail {...base} counts={{ ...base.counts, running: 2, failed: 1 }} />);
    // The badge and the dot live inside the label span, which the phone rules make the positioning box for both.
    const label = screen.getByRole('button', { name: /^Board/ }).querySelector('.rail-label')!;
    expect(label.querySelector('.count-board')).toBeTruthy();
    expect(label.querySelector('.dot-warn')).toBeTruthy();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const phone = phoneStyles(css);
    expect(phone).toContain('.rail-label { flex: none; display: block; position: relative; }');
    expect(phone).toMatch(/\.rail-label \.count \{ position: absolute; right: -6px; top: -9px;/);
    expect(phone).toMatch(/\.rail-label \.dot-warn \{ position: absolute; left: 100%; bottom: -3px;/);
    expect(css.slice(0, css.indexOf(`@media ${PHONE_QUERY}`, css.indexOf('.rail-status')))).toContain('.rail-label .count { margin-left: auto; }');
  });
  it('names the buttons plainly when nothing is counted and shows an idle orchestrator', () => {
    render(<Rail {...base} status={{ ...status, orchestrator: { status: 'idle', native_session_id: null, last_activity_at: status.orchestrator.last_activity_at, busy: false, model: null, context: null } }} />);
    expect(screen.getByRole('button', { name: 'Board' })).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('orchestrator: sleeping');
  });
  it('shows the mascot and elapsed activity in the sole rail live region', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date(Date.now() - 65_000).toISOString();
      const tool: OrchestratorActivity = { state: 'tool', tool: 'Bash', summary: 'Run the unit suite', started_at: startedAt };
      const withContext: StatusResponse = { ...status, orchestrator: { ...status.orchestrator, context: { tokens: 380_000, window: 1_000_000 } } };
      const { rerender } = render(<Rail {...base} status={withContext} activity={tool} />);
      const line = screen.getByRole('status');
      expect(screen.getByRole('img').classList.contains('mascot-working')).toBe(true);
      expect(screen.getByRole('img').getAttribute('aria-label')).toBe('orchestrator: Run the unit suite, context 38%');
       expect(screen.getByRole('img').getAttribute('style')).toContain('width: 64px');
       expect(line.querySelector('.rail-status-text')).toBeNull();
       expect(line.querySelector('.rail-status-state')).toBeNull();
       expect(document.querySelector('.rail-status-model')).toBeNull();
      expect(line.textContent).toContain('01:05');
      expect(line.querySelector('button')).toBeNull();
      expect(screen.getByText('context 38%').closest('[role="status"]')).toBeNull();
      expect(screen.getByRole('button', { name: 'New session' }).closest('[role="status"]')).toBeNull();
      // The counter ticks every second inside a live region the Rail mounts on every view, so it is announced to no one.
      expect(line.querySelector('.rail-status-elapsed')?.getAttribute('aria-hidden')).toBe('true');
       await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
       expect(screen.getByRole('status').textContent).toContain('01:07');
       rerender(<Rail {...base} status={withContext} activity={{ ...tool, state: 'idle' }} />);
       expect(document.querySelector('.rail-status-elapsed')).toBeNull();
       // Offline the status is "unknown" and every elapsed time stops, the timer included; activity alone can be stale.
      rerender(<Rail {...base} status={withContext} activity={tool} offline />);
      expect(document.querySelector('.rail-status-elapsed')).toBeNull();
      rerender(<Rail {...base} activity={{ state: 'thinking', tool: null, summary: null, started_at: new Date().toISOString() }} />);
      expect(screen.getByRole('img').classList.contains('mascot-thinking')).toBe(true);
      rerender(<Rail {...base} activity={null} pendingQuestion />);
      expect(screen.getByRole('img').classList.contains('mascot-asking')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('uses the full-body and bust frames at the desktop and phone rail sizes', async () => {
    const sheet = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/mascot/me-1.json'), 'utf8'));
    let updatePhone: (() => void) | undefined;
    const phoneMedia = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => { updatePhone = listener; },
      removeEventListener: vi.fn(),
    };
    const motionMedia = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn((query: string) => (query.includes('max-width') ? phoneMedia : motionMedia) as unknown as MediaQueryList));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(sheet) }));
    const idleStatus: StatusResponse = { ...status, orchestrator: { ...status.orchestrator, status: 'idle', last_activity_at: new Date().toISOString(), busy: false } };
    const { rerender } = render(<Rail {...base} status={idleStatus} />);
    await screen.findByTestId('mascot-atlas-image');
    expect(screen.getByRole('img').querySelector('[data-crop]')?.getAttribute('data-crop')).toBe('full-body');
    phoneMedia.matches = true;
    act(() => updatePhone?.());
    rerender(<Rail {...base} status={idleStatus} />);
    expect(screen.getByRole('img').querySelector('[data-crop]')?.getAttribute('data-crop')).toBe('bust');
  });
  it('keeps the phone rail when a touch phone rotates to landscape and returns to the desktop rail on a taller touch screen', async () => {
    const sheet = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/mascot/me-1.json'), 'utf8'));
    const viewport = stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(sheet) }));
    const idleStatus: StatusResponse = { ...status, orchestrator: { ...status.orchestrator, status: 'idle', last_activity_at: new Date().toISOString(), busy: false } };
    render(<Rail {...base} status={idleStatus} />);
    await screen.findByTestId('mascot-atlas-image');
    const crop = () => screen.getByRole('img').querySelector('[data-crop]')?.getAttribute('data-crop');
    expect(crop()).toBe('bust');
    act(() => viewport.set({ width: 844, height: 390, pointer: 'coarse' }));
    expect(crop()).toBe('bust');
    act(() => viewport.set({ width: 1024, height: 768, pointer: 'coarse' }));
    expect(crop()).toBe('full-body');
    // A mouse keeps the desktop rail however short the window is.
    act(() => viewport.set({ width: 900, height: 480, pointer: 'fine' }));
    expect(crop()).toBe('full-body');
  });
  it('ages an idle session into sleeping and renders the phone mascot at 32px', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-15T12:00:00.000Z');
      vi.setSystemTime(now);
      vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      const idleStatus: StatusResponse = { bd_ok: true, orchestrator: { status: 'idle', native_session_id: 'session', last_activity_at: new Date(now).toISOString(), busy: false, model: null, context: null } };
      const { rerender } = render(<Rail {...base} status={idleStatus} activity={{ state: 'thinking', tool: null, summary: null, started_at: new Date(now - 65_000).toISOString() }} />);
      const mascot = screen.getByRole('img');
      expect(mascot.classList.contains('mascot-thinking')).toBe(true);
      expect(mascot.getAttribute('style')).toContain('width: 32px');
      expect(document.querySelector('.rail-status-elapsed')).toBeNull();
      rerender(<Rail {...base} status={idleStatus} />);
      expect(screen.getByRole('img').classList.contains('mascot-idle')).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60_000); });
      expect(screen.getByRole('img').classList.contains('mascot-sleeping')).toBe(true);
      // The phone strip has no room for a timer next to Restart needed, so it does not mount one.
      expect(document.querySelector('.rail-status-elapsed')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('removes visible status and model text and gives phone metadata way to Restart needed', () => {
    const withModel: StatusResponse = { ...status, orchestrator: { ...status.orchestrator, model: 'claude-opus-4-1' } };
    render(<Rail {...base} status={withModel} />);
    expect(document.querySelector('.rail-status-state')).toBeNull();
    expect(document.querySelector('.rail-status-model')).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const phoneCss = phoneStyles(css);
    expect(phoneCss).toMatch(/\.rail-status \{[^}]*flex-direction: row/);
    expect(phoneCss).toMatch(/\.rail-status-live \{[^}]*flex: none/);
    expect(phoneCss).toMatch(/\.rail-status:has\(\.daemon-restart-needed\) \.rail-status-metadata \{ display: none; \}/);
    expect(phoneCss).toMatch(/\.rail-status \.daemon-restart-needed \{[^}]*flex: none/);
  });
  it('shows the offline mascot while the daemon is unreachable and marks the Board when a verification failed', () => {
    const { rerender } = render(<Rail {...base} offline />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('offline');
    expect(screen.getByRole('img').classList.contains('mascot-offline')).toBe(true);
    expect(screen.queryByText(/last active/)).toBeNull(); // the age of an unknown status is not claimed either
    rerender(<Rail {...base} counts={{ ...base.counts, failed: 2 }} />);
    expect(screen.getByRole('img').classList.contains('mascot-sleeping')).toBe(true); // activity and last activity, not the status summary, drive the mascot pose
    expect(screen.getByText(/last active/)).toBeTruthy();
    rerender(<Rail {...base} status={{ ...status, orchestrator: { ...status.orchestrator, busy: false, context: { tokens: 380_000, window: 1_000_000 } } }} />);
    expect(screen.getByText('context 38%').title).toMatch(/380.000 of 1.000.000 tokens/);
    expect(screen.getByRole('img').classList.contains('mascot-sleeping')).toBe(true);
    rerender(<Rail {...base} counts={{ ...base.counts, failed: 2 }} />);
    // The dot is decoration; the count is in the button's own accessible name, next to the running count when there is one.
    expect(screen.getByRole('button', { name: 'Board, 2 verifications failed' }).title).toBe('2 verifications failed');
    rerender(<Rail {...base} counts={{ ...base.counts, running: 1, failed: 1 }} />);
    expect(screen.getByRole('button', { name: 'Board, 1 worker running, 1 verification failed' })).toBeTruthy();
  });

  it('shows a repo total as a floor when a worker session ended without reporting a cost (round 14)', () => {
    render(<Rail {...base} repos={[repo]} costs={{ repos: [{ repo_id: 'r1', total: 3.1, today: 0, unknown: 2 }], batches: [] }} />);
    expect(screen.getByRole('button', { name: 'r1 ≥ $3.10' })).toBeTruthy();
    expect(screen.getByText('≥ $3.10').title).toBe('At least: 2 worker sessions ended without a reported cost (stopped or crashed mid-turn, or a harness that reports none).');
  });

  it('keeps the arrived repo chip and reserves the widest cost while /costs is in flight, and stops when that read fails', () => {
    const { rerender } = render(<Rail {...base} repos={[repo]} costs={null} />);
    // The chip and its repo name are there as soon as the repo list answers; only the cost value shimmers.
    const row = screen.getByRole('button', { name: /r1/ });
    const reserved = within(row).getByTestId('shimmer').querySelector('.shimmer-measure-container .mono')!.textContent!;
    // The reserve must not be shorter than any value the chip can render: the six-figure total with the '≥' marker and the `unknown` wording.
    for (const widest of [fmtCostTotal(999999.99, 0).text, fmtCostTotal(0, 1).text, fmtCostTotal(999999.99, 1).text]) {
      expect(reserved.length, `"${reserved}" must be at least as wide as "${widest}"`).toBeGreaterThanOrEqual(widest.length);
    }
    expect(screen.getByText('r1')).toBeTruthy();

    rerender(<Rail {...base} repos={[repo]} costs={{ repos: [{ repo_id: 'r1', total: 3.1, today: 0, unknown: 0 }], batches: [] }} />);
    expect(within(row).queryByTestId('shimmer')).toBeNull();
    expect(screen.getByRole('button', { name: 'r1 $3.10' })).toBeTruthy();

    // A failed /costs read is not loading: the chip reserves nothing through the outage rather than shimmering invented cost.
    rerender(<Rail {...base} repos={[repo]} costs={null} loadFailed={(paths) => paths.includes('/costs')} />);
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('lists repos as buttons that report a click, named by id with the path as tooltip', () => {
    const onRepo = vi.fn();
    render(<Rail {...base} repos={[repo]} costs={{ repos: [{ repo_id: 'r1', total: 3.1, today: 0, unknown: 0 }], batches: [] }} onRepo={onRepo} />);
    const row = screen.getByRole('button', { name: 'r1 $3.10' });
    expect(row.title).toBe('E:/Projects/demo');
    fireEvent.click(row);
    expect(onRepo).toHaveBeenCalledWith('r1');
  });

  it('draws the unloaded repo list exactly as the empty one', () => {
    const { container, rerender } = render(<Rail {...base} repos={null} />);
    const unloaded = container.querySelector('.rail-context ul')!.innerHTML;
    rerender(<Rail {...base} repos={[]} />);
    expect(container.querySelector('.rail-context ul')!.innerHTML).toBe(unloaded);
    expect(screen.queryByRole('button', { name: 'r1' })).toBeNull();
  });
});
