import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Plan as PlanT } from '@overseer/shared';
import { Plan } from './Plan';
import { mockApi } from '../test/setup';

const LONG = 'Accounts: multiple claude and codex accounts, selectable per tier and for the orchestrator, with login from Setup';
const draft = (o: Partial<PlanT> = {}): PlanT => ({
  id: 'r1-p1', repo_id: 'overseer', title: LONG, status: 'draft', batch_id: null, revision: 3, created_at: 't', updated_at: 't',
  steps: [{ title: 'Accounts table', description: 'Add the table', dependsOn: [] }, { title: 'Login flow', description: 'OAuth', dependsOn: [0] }],
  ...o,
});
const props = { id: 'r1-p1', version: 0, offline: false, onBack: () => {}, onOpenBoard: () => {} };

describe('Plan', () => {
  it('shows the plan with its steps', async () => {
    mockApi(() => draft());
    render(<Plan {...props} />);
    const title = await screen.findByTestId('read-Plan title');
    expect(title.tagName).toBe('DIV');
    expect(title.textContent).toBe(LONG);
    expect(title.getAttribute('role')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Plan title' })).toBeTruthy();
    expect((screen.getByLabelText('Step 2 title') as HTMLTextAreaElement).value).toBe('Login flow');
    expect(screen.getByLabelText('Step 2 title').tagName).toBe('TEXTAREA');
    expect((screen.getByLabelText('Step 1 depends on nothing') as HTMLElement)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /1\. Accounts table/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('saves an edited field on blur with the current revision and adopts the returned one', async () => {
    const puts: unknown[] = [];
    mockApi((method, _url, body) => {
      if (method === 'PUT') { puts.push(body); return draft({ ...(body as object), revision: (body as { revision: number }).revision + 1 }); }
      return draft();
    });
    render(<Plan {...props} />);
    const title = await screen.findByLabelText('Step 1 title');
    fireEvent.change(title, { target: { value: 'Accounts table v2' } });
    fireEvent.blur(title);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ revision: 3, steps: [{ title: 'Accounts table v2' }, { title: 'Login flow' }] });
    fireEvent.mouseUp(screen.getByTestId('read-Step 2 description'));
    const desc = screen.getByLabelText('Step 2 description');
    fireEvent.change(desc, { target: { value: 'OAuth with PKCE' } });
    fireEvent.blur(desc);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ revision: 4 });
  });

  it('does not send a draft that fails validation, and says why Approve is off', async () => {
    const puts: unknown[] = [];
    mockApi((method, _url, body) => { if (method === 'PUT') puts.push(body); return draft(); });
    render(<Plan {...props} />);
    const title = await screen.findByLabelText('Step 2 title');
    fireEvent.change(title, { target: { value: ' ' } });
    fireEvent.blur(title);
    expect(screen.getByText('Step 2 needs a title.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve plan' }) as HTMLButtonElement).disabled).toBe(true);
    expect(puts).toEqual([]);
  });

  it('keeps the typed text and stops offering Approve when the plan changed elsewhere', async () => {
    mockApi((method) => {
      if (method === 'PUT') throw Object.assign(new Error('plan r1-p1 changed elsewhere'), { status: 409 });
      return draft();
    });
    render(<Plan {...props} />);
    const title = await screen.findByLabelText('Step 1 title');
    fireEvent.change(title, { target: { value: 'My unsaved words' } });
    fireEvent.blur(title);
    await screen.findByText(/This plan changed elsewhere/);
    expect((screen.getByLabelText('Step 1 title') as HTMLInputElement).value).toBe('My unsaved words');
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();
  });

  it('saves a removal at once, and explains a refused move without sending anything', async () => {
    const puts: { steps: unknown[] }[] = [];
    mockApi((method, _url, body) => { if (method === 'PUT') { puts.push(body as { steps: unknown[] }); return draft({ ...(body as object), revision: 4 }); } return draft(); });
    render(<Plan {...props} />);
    await screen.findByLabelText('Step 1 title');
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]!);
    expect(screen.getByText('Step 2 depends on step 1, so it stays below it.')).toBeTruthy();
    expect(puts).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.steps).toEqual([{ title: 'Login flow', description: 'OAuth', dependsOn: [] }]);
  });

  it('approves with the revision and becomes read-only with a Board link', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const onOpenBoard = vi.fn();
    mockApi((method, url, body) => {
      if (method === 'POST') { posts.push({ url, body }); return draft({ status: 'approved', batch_id: 'overseer-b9-abcd', revision: 3 }); }
      return draft();
    });
    render(<Plan {...props} onOpenBoard={onOpenBoard} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve plan' }));
    await screen.findByText(/Approved/);
    expect(posts).toEqual([{ url: '/api/plans/r1-p1/approve', body: { revision: 3 } }]);
    expect((screen.getByLabelText('Step 1 title') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /overseer-b9-abcd/ }));
    expect(onOpenBoard).toHaveBeenCalledWith('overseer');
  });

  it('discards after confirmation and says nothing was created', async () => {
    vi.stubGlobal('confirm', () => true);
    mockApi((method) => (method === 'POST' ? draft({ status: 'discarded' }) : draft()));
    render(<Plan {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await screen.findByText('Discarded. Nothing was created for this plan.');
  });

  it('puts long editable prose in the plan scroll region below a separate footer', async () => {
    mockApi(() => draft({ title: 'Long title\nthat wraps', steps: [{ title: 'Accounts table', description: Array.from({ length: 40 }, (_, i) => `packages/web/src/components/ModelsSettings.tsx:${i + 1}`).join('\n'), dependsOn: [] }] }));
    render(<Plan {...props} />);
    const title = await screen.findByTestId('read-Plan title');
    const description = screen.getByTestId('read-Step 1 description');
    expect(title.tagName).toBe('DIV');
    expect(description.tagName).toBe('DIV');
    expect(description.getAttribute('aria-label')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Step 1 description' })).toBeTruthy();
    expect(description.querySelectorAll('wbr')).toHaveLength(40 * 4);
    expect(title.closest('.plan-content')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve plan' }).closest('.plan-content')).toBeNull();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.plan\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(css).toMatch(/\.plan-content\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.plan-content\s*>\s*\*\s*\{[^}]*flex:\s*none/);
    const pathText = 'packages/web/src/components/ModelsSettings.tsx:26-30';
    fireEvent.mouseUp(description);
    const editor = screen.getByLabelText('Step 1 description') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: pathText } });
    expect(editor.value).toBe(pathText);
    expect(css).toMatch(/\.plan-step-desc\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.plan-prose-editor\s*\{[^}]*overflow-y:\s*hidden/);
    expect(css).not.toContain('plan-footer::after');
  });

  it('renders the plan title as wrapping text, then edits the exact value in an auto-sized textarea', async () => {
    mockApi(() => draft({ title: 'A title' }));
    render(<Plan {...props} />);
    const display = await screen.findByTestId('read-Plan title');
    expect(display.tagName).toBe('DIV');
    expect(display.textContent).toBe('A title');
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(88);
    fireEvent.mouseUp(display);
    const title = screen.getByLabelText('Plan title') as HTMLTextAreaElement;
    expect(title.tagName).toBe('TEXTAREA');
    expect(title.value).toBe('A title');
    expect(title.style.height).toBe('88px');
    expect(title.closest('.plan-content')).toBeTruthy();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    // A fixed three-row title clipped its fourth wrapped line on phones, while a grid auto-row once collapsed it on desktop.
    expect(css).toMatch(/\.plan-content\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.plan-title\s*\{[^}]*resize:\s*none;[^}]*overflow-y:\s*hidden/);
    expect(css).toMatch(/\.plan-step-title\s*\{[^}]*resize:\s*none;[^}]*overflow-y:\s*hidden/);
    // The sizing hook resets before measuring, so fields can shrink after a deletion or wider resize.
    scrollHeight.mockReturnValue(40);
    fireEvent.change(title, { target: { value: 'A title that wraps after the available width changes' } });
    expect(title.value).toBe('A title that wraps after the available width changes');
    expect(title.style.height).toBe('40px');
    scrollHeight.mockRestore();
  });

  it('keeps a mid-field slash edit and copied description value unchanged', async () => {
    mockApi(() => draft({ steps: [{ title: 'Accounts table', description: 'packages/web/file.ts', dependsOn: [] }] }));
    render(<Plan {...props} />);
    const display = await screen.findByTestId('read-Step 1 description');
    expect(display.querySelectorAll('wbr')).toHaveLength(2);
    fireEvent.mouseUp(display);
    const description = screen.getByLabelText('Step 1 description') as HTMLTextAreaElement;
    description.setSelectionRange(7, 7);
    fireEvent.change(description, { target: { value: 'packages//web/file.ts', selectionStart: 9, selectionEnd: 9 } });
    expect(description.value).toBe('packages//web/file.ts');
    expect(description.value.includes('\u200B')).toBe(false);
    expect(description.selectionStart).toBe(9);
  });

  it('opens long prose at its mouseup caret offset and keeps both scroll positions', async () => {
    mockApi(() => draft({ steps: [{ title: 'Accounts table', description: Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n'), dependsOn: [] }] }));
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    render(<Plan {...props} />);
    const display = await screen.findByTestId('read-Step 1 description');
    const content = display.closest('.plan-content') as HTMLElement;
    content.scrollTop = 120;
    display.scrollTop = 24;
    const textNode = display.firstChild!;
    const caret = vi.fn(() => ({ offsetNode: textNode, offset: 8 }));
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: caret });
    fireEvent.mouseUp(display, { clientX: 40, clientY: 300 });
    const editor = screen.getByLabelText('Step 1 description') as HTMLTextAreaElement;
    expect(caret).toHaveBeenCalledWith(40, 300);
    expect(editor.selectionStart).toBe(8);
    expect(editor.selectionEnd).toBe(8);
    expect(content.scrollTop).toBe(120);
    expect(editor.scrollTop).toBe(24);
    content.scrollTop = 300;
    fireEvent.change(editor, { target: { value: 'changed line 0\nline 1' } });
    expect(content.scrollTop).toBe(300);
    scrollHeight.mockRestore();
  });

  it('keeps a drag selection in the read view on mouseup', async () => {
    mockApi(() => draft({ steps: [{ title: 'Accounts table', description: 'first line\nsecond line\nthird line', dependsOn: [] }] }));
    render(<Plan {...props} />);
    const display = await screen.findByTestId('read-Step 1 description');
    const dragRange = document.createRange();
    dragRange.setStart(display.firstChild!, 0);
    dragRange.setEnd(display.firstChild!, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(dragRange);
    fireEvent.mouseUp(display, { clientX: 40, clientY: 300 });
    expect(screen.getByTestId('read-Step 1 description').tagName).toBe('DIV');
    expect(window.getSelection()!.toString()).toBe('first');
  });

  it('renders a completed plan read-only and sends Back to the caller', async () => {
    const onBack = vi.fn();
    mockApi(() => draft({ status: 'discarded' }));
    render(<Plan {...props} onBack={onBack} />);
    await screen.findByText('Discarded. Nothing was created for this plan.');
    const title = screen.getByTestId('read-Plan title');
    expect(title.tagName).toBe('DIV');
    expect(title.getAttribute('role')).toBeNull();
    fireEvent.focus(title);
    expect(screen.getByTestId('read-Plan title').tagName).toBe('DIV');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shimmers the plan shape while it is being fetched, then shows the plan', async () => {
    let release!: (p: PlanT) => void;
    mockApi(() => new Promise<PlanT>((r) => { release = r; }));
    render(<Plan {...props} />);
    const shimmer = await screen.findByTestId('shimmer');
    expect(shimmer.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Loading plan…')).toBeNull(); // the one line the shimmer replaces
    // The placeholder reserves what arrives: the head, the title field, two steps and the footer.
    expect(shimmer.querySelectorAll('.plan-step')).toHaveLength(2);
    expect(shimmer.querySelector('.plan-footer')).toBeTruthy();
    // The sizing class stays above the shimmer, so the page keeps the plan's own full-height grid while it loads.
    expect(shimmer.closest('.plan')).toBeTruthy();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.plan > \.shimmer\s*\{[^}]*overflow:\s*hidden/);
    release(draft());
    await screen.findByTestId('read-Plan title');
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('shows the error, not a shimmer, when the plan fetch failed', async () => {
    mockApi(() => { throw new Error('not found'); });
    render(<Plan {...props} />);
    await screen.findByText(/Could not load this plan/);
    expect(screen.queryByTestId('shimmer')).toBeNull();
  });

  it('uses a compact normal-flow state when the plan cannot load', async () => {
    mockApi(() => { throw new Error('not found'); });
    render(<Plan {...props} />);
    await screen.findByText(/Could not load this plan/);
    expect(screen.getByRole('button', { name: 'Back' }).closest('.plan-load')).toBeTruthy();
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.plan-load\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/main:has\(> \.banner-warn\) \.plan\s*\{[^}]*height:\s*auto/);
  });

  it('adopts the daemon-cleaned plan after a save, so an untouched field sends nothing more and a version bump can reload', async () => {
    type SavedStep = { title: string; description: string; dependsOn: number[] };
    const puts: { revision: number; steps: SavedStep[] }[] = [];
    let getCount = 0;
    const base = draft({
      steps: [
        { title: 'a', description: '', dependsOn: [] },
        { title: 'b', description: '', dependsOn: [] },
        { title: 'c', description: '', dependsOn: [0, 1] },
      ],
    });
    mockApi((method, _url, body) => {
      if (method === 'GET') { getCount++; return base; }
      if (method === 'PUT') {
        const b = body as { revision: number; steps: SavedStep[] };
        puts.push(b);
        // The daemon's clean() sorts dependsOn; moveStep no longer does, so the swap below arrives unsorted.
        return draft({ steps: b.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn].sort((x, y) => x - y) })), revision: b.revision + 1 });
      }
      return base;
    });
    const { rerender } = render(<Plan {...props} />);
    await screen.findByLabelText('Step 1 title');
    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]!); // swaps a and b; step 3's dependsOn becomes [1, 0]
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.steps[2]!.dependsOn).toEqual([1, 0]);
    fireEvent.blur(screen.getByLabelText('Step 3 title')); // untouched: nothing to save once the draft matches what came back
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toHaveLength(1);
    rerender(<Plan {...props} version={1} />);
    await waitFor(() => expect(getCount).toBeGreaterThanOrEqual(2));
  });

  it('runs a blur-then-Approve without a race: one revision chain, and no "changed elsewhere" for the user\'s own edit', async () => {
    const puts: { revision: number }[] = [];
    const posts: { revision: number }[] = [];
    let resolvePut: ((v: PlanT) => void) | null = null;
    mockApi((method, _url, body) => {
      if (method === 'PUT') {
        puts.push(body as { revision: number });
        return new Promise<PlanT>((resolve) => { resolvePut = resolve; });
      }
      if (method === 'POST') {
        posts.push(body as { revision: number });
        return draft({ status: 'approved', batch_id: 'overseer-b9-abcd', revision: (body as { revision: number }).revision });
      }
      return draft();
    });
    render(<Plan {...props} />);
    const title = await screen.findByLabelText('Step 1 title');
    fireEvent.change(title, { target: { value: 'Accounts table v2' } });
    fireEvent.blur(title);
    await waitFor(() => expect(puts).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    resolvePut!(draft({
      steps: [{ title: 'Accounts table v2', description: 'Add the table', dependsOn: [] }, { title: 'Login flow', description: 'OAuth', dependsOn: [0] }],
      revision: 4,
    }));
    await screen.findByText(/Approved/);
    expect(puts.length === 1 || puts.length === 2).toBe(true);
    expect(posts).toEqual([{ revision: 4 }]);
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
  });
});
