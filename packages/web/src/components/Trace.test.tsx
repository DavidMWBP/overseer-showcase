import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import type { EventRow } from '@overseer/shared';
import { Trace, summarize } from './Trace';
import { mockApi } from '../test/setup';

const ev = (id: number, type: string, payload: unknown): EventRow => ({ id, session_id: 'sess-3', seq: id, type, payload, ts: `2026-09-12T10:00:0${id}.000Z` });
const events: EventRow[] = [
  ev(1, 'process_start', { type: 'process_start', pid: 4242, pidStartedAt: null }),
  ev(2, 'assistant_text', { type: 'assistant_text', text: 'Adding the file now.\nSecond line that is not shown in the summary.' }),
  ev(3, 'tool_call', { type: 'tool_call', id: 't1', name: 'Write', input: { path: 'hello.txt', content: 'hi' } }),
  ev(4, 'turn_end', { type: 'turn_end', nativeSessionId: 'n1', cost: 0.42 }),
];

describe('Trace', () => {
  it('summarises each event kind on one line', () => {
    expect(events.map(summarize)).toEqual(['pid 4242', 'Adding the file now. Second line that is not shown in the summary.', 'Write {"path":"hello.txt","content":"hi"}', 'cost $0.42']);
    expect(summarize(ev(5, 'assistant_text', { text: 'x'.repeat(300) }))).toHaveLength(120);
    expect(summarize(ev(6, 'something_else', { a: 1 }))).toBe('{"a":1}');
    // A cut inside an inline code span closes it, so the truncated summary renders no stray backtick (round 13).
    const cut = summarize(ev(7, 'assistant_text', { text: `Done, committed on \`bead/${'x'.repeat(200)}\`` }));
    expect(cut).toBe('Done, committed on …'); // the opened span is dropped rather than closed: total, whatever character the cut lands on (fix round 13 review)
    // The cut landing exactly on the opening backtick left it dangling in round 13's version.
    const edge = summarize(ev(7, 'assistant_text', { text: `${'y'.repeat(118)}\`code\`` }));
    expect(edge).toBe(`${'y'.repeat(118)}…`);
    expect(summarize(ev(8, 'interrupt', { by: 'orchestrator', reason: 'The user changed their mind.' }))).toBe('stopped by the orchestrator: The user changed their mind.');
  });
  it('renders one row per event with the raw event behind a disclosure, and keeps the JSON link', async () => {
    mockApi((_m, url) => { if (url.endsWith('/api/sessions/sess-3/events')) return events; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Trace sessionId="sess-3" />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    expect(within(trace).getByText(/loading the trace/i)).toBeTruthy();
    const rows = await within(trace).findAllByRole('group'); // <details>
    expect(rows).toHaveLength(4);
    expect(rows[1]!.querySelector('summary')!.textContent).toContain('assistant_text');
    expect(rows[1]!.querySelector('summary')!.textContent).toContain('Adding the file now.');
    expect(rows[1]!.querySelector('pre')!.textContent).toContain('"text": "Adding the file now.\\nSecond line');
    expect((within(trace).getByRole('link', { name: 'raw JSON' }) as HTMLAnchorElement).getAttribute('href')).toBe('/api/sessions/sess-3/events');
  });
  it('shimmers rows in the shape of the event list while it loads, and replaces them with the real rows', async () => {
    let release: (rows: unknown) => void = () => {};
    mockApi((_m, url) => { if (url.endsWith('/api/sessions/sess-3/events')) return new Promise<unknown>((r) => { release = r; }); throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    render(<Trace sessionId="sess-3" />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    const shimmer = within(trace).getByTestId('shimmer');
    // The measured structure is the arrived one: four collapsed rows, so the block reserves their height instead of one line of text.
    expect(shimmer.querySelectorAll('.shimmer-measure-container details')).toHaveLength(4);
    expect(within(trace).queryByRole('group')).toBeNull();
    release(events);
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(4));
    expect(within(trace).queryByTestId('shimmer')).toBeNull();
  });
  it('keeps the rows it has when a refetch fails, showing the warning above them (fix round 15 review)', async () => {
    let fail = false;
    mockApi((_m, url) => {
      if (!url.includes('/api/sessions/sess-3/events')) throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      if (fail) throw Object.assign(new Error('the daemon is unreachable'), { status: 500 });
      return events;
    });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(4));
    fail = true;
    rerender(<Trace sessionId="sess-3" status="running" refresh={1} />);
    await waitFor(() => expect(within(trace).getByText(/could not load the trace/i)).toBeTruthy());
    // The failed refetch leaves `events` in state: the list stays under the warning instead of being blanked.
    expect(within(trace).getAllByRole('group')).toHaveLength(4);
    expect(within(trace).queryByTestId('shimmer')).toBeNull();
  });
  it('renders inline code in a summary as code, and closes an ended session with a row from its end time (round 12)', async () => {
    const withCode = [ev(1, 'assistant_text', { type: 'assistant_text', text: 'I will create `bye.txt` now.' })];
    mockApi((_m, url) => { if (url.includes('/api/sessions/sess-3/events?after=')) return []; if (url.endsWith('/api/sessions/sess-3/events')) return withCode; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" endedAt={null} refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    const summary = (await within(trace).findByText('assistant_text')).closest('summary')!;
    expect(summary.querySelector('code')!.textContent).toBe('bye.txt');
    expect(summary.textContent).not.toContain('`');
    expect(within(trace).queryByText('session_end')).toBeNull(); // still running: no closing row
    rerender(<Trace sessionId="sess-3" status="ended" endedAt="2026-09-12T10:00:09.000Z" refresh={0} />);
    const end = await within(trace).findByText('session_end');
    expect(end.parentElement!.textContent).toContain(new Date('2026-09-12T10:00:09.000Z').toLocaleTimeString());
    expect(end.parentElement!.textContent).toContain('the process exited');
    rerender(<Trace sessionId="sess-3" status="failed" endedAt="2026-09-12T10:00:09.000Z" refresh={0} />);
    expect(within(trace).getByText('session_end').parentElement!.textContent).toContain('the session failed');
  });
  it('drops a response for a session no longer shown, starts a new session in full, then appends the deltas (fix round 11 review)', async () => {
    const calls: string[] = [];
    let releaseOld: () => void = () => {};
    mockApi((_m, url) => {
      calls.push(url);
      if (url.includes('/api/sessions/sess-old/events')) return new Promise<unknown>((r) => { releaseOld = () => r([ev(9, 'assistant_text', { text: 'from the old session' })]); });
      if (url.includes('/api/sessions/sess-3/events?after=')) return [events[Number(url.split('after=')[1])]!];
      if (url.endsWith('/api/sessions/sess-3/events')) return [events[0]!];
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Trace sessionId="sess-old" status="running" refresh={0} />);
    rerender(<Trace sessionId="sess-3" status="running" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    await within(trace).findByText('process_start');
    await act(async () => { releaseOld(); }); // the old session's response lands after the switch: it must not paint
    expect(within(trace).queryByText('from the old session')).toBeNull();
    expect(within(trace).getAllByRole('group')).toHaveLength(1);
    // The switch fetched the new session in full: the request carries no `after`.
    expect(calls.filter((u) => u.includes('/sess-3/events'))).toEqual(['/api/sessions/sess-3/events']);
    // A change while the session runs fetches only what is newer and appends it; the list stays until the delta lands.
    rerender(<Trace sessionId="sess-3" status="running" refresh={1} />);
    expect(within(trace).queryByText(/loading the trace/i)).toBeNull();
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(2));
    // Once ended, the last change fetches the final rows and later changes do not.
    rerender(<Trace sessionId="sess-3" status="ended" endedAt="2026-09-12T10:00:09.000Z" refresh={2} />);
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(3));
    expect(calls.filter((u) => u.includes('after='))).toEqual(['/api/sessions/sess-3/events?after=1', '/api/sessions/sess-3/events?after=2']);
    const before = calls.length;
    rerender(<Trace sessionId="sess-3" status="ended" endedAt="2026-09-12T10:00:09.000Z" refresh={3} />); // the effect runs within the render's act
    expect(calls.length).toBe(before);
  });
  it('closes a stopped session with who stopped it, a failed one without an end time with a row, and an empty one without the "no events" line (round 13)', async () => {
    const stopped = [...events.slice(0, 2), ev(9, 'interrupt', { type: 'interrupt', by: 'user' })];
    mockApi((_m, url) => { if (url.endsWith('/api/sessions/sess-3/events')) return stopped; if (url.endsWith('/api/sessions/sess-empty/events')) return []; throw Object.assign(new Error('unexpected ' + url), { status: 500 }); });
    const { rerender } = render(<Trace sessionId="sess-3" status="ended" endedAt="2026-09-12T10:00:09.000Z" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    expect((await within(trace).findByText('interrupt')).closest('summary')!.textContent).toContain('stopped by the user');
    expect(within(trace).getByText('session_end').parentElement!.textContent).toContain('stopped by the user');
    expect(within(trace).getByText('session_end').parentElement!.textContent).not.toContain('the process exited');
    rerender(<Trace sessionId="sess-empty" status="failed" endedAt={null} refresh={0} />);
    await waitFor(() => expect(within(trace).getByText('session_end').parentElement!.textContent).toBe('session_end the session failed'));
    expect(within(trace).queryByText(/no events recorded/i)).toBeNull();
  });

  it('fetches the session once, then only the events after its last one, appending them instead of refetching the old rows', async () => {
    const calls: string[] = [];
    mockApi((_m, url) => {
      if (!url.includes('/api/sessions/sess-3/events')) throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      calls.push(url);
      if (url.includes('?after=2')) return [ev(3, 'tool_call', { type: 'tool_call', id: 't1', name: 'Write', input: {} })];
      if (url.includes('?after=3')) return [];
      if (url.includes('?after=')) throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      return events.slice(0, 2); // the full fetch: seq 1 and 2
    });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(2));
    rerender(<Trace sessionId="sess-3" status="running" refresh={1} />);
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(3));
    // The appended row is the new one; the two old rows are still there once, not refetched and duplicated.
    expect(within(trace).getAllByText('process_start')).toHaveLength(1);
    expect(within(trace).getAllByText('assistant_text')).toHaveLength(1);
    expect(calls).toEqual(['/api/sessions/sess-3/events', '/api/sessions/sess-3/events?after=2']);
    // An empty delta (nothing newer) leaves the list unchanged.
    rerender(<Trace sessionId="sess-3" status="running" refresh={2} />);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(within(trace).getAllByRole('group')).toHaveLength(3);
  });
  it('keeps at most one events request in flight when a burst of events arrives', async () => {
    const calls: string[] = [];
    const release: ((rows: EventRow[]) => void)[] = [];
    let active = 0;
    let maxActive = 0;
    mockApi((_m, url) => {
      if (!url.includes('/api/sessions/sess-3/events')) throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      calls.push(url);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<EventRow[]>((resolve) => release.push((rows) => { active -= 1; resolve(rows); }));
    });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" refresh={0} />);
    expect(calls).toHaveLength(1); // the full fetch is in flight
    rerender(<Trace sessionId="sess-3" status="running" refresh={1} />);
    rerender(<Trace sessionId="sess-3" status="running" refresh={2} />);
    rerender(<Trace sessionId="sess-3" status="running" refresh={3} />);
    expect(calls).toHaveLength(1); // the burst did not stack a request per tick
    await act(async () => { release[0]!(events.slice(0, 2)); });
    // The ticks fold into one delta for the latest cursor, still one request at a time.
    expect(calls).toEqual(['/api/sessions/sess-3/events', '/api/sessions/sess-3/events?after=2']);
    await act(async () => { release[1]!([]); });
    expect(maxActive).toBe(1);
  });
  it('falls back to a full fetch when a delta fails, keeping the rows it has', async () => {
    let fail = false;
    const calls: string[] = [];
    mockApi((_m, url) => {
      if (!url.includes('/api/sessions/sess-3/events')) throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      calls.push(url);
      if (fail) throw Object.assign(new Error('the daemon is unreachable'), { status: 500 });
      if (url.includes('after=')) return [ev(3, 'tool_call', { type: 'tool_call', id: 't1', name: 'Write', input: {} })];
      return events.slice(0, 2);
    });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(2));
    fail = true; // the delta fails, and so does the full fallback it starts at once
    rerender(<Trace sessionId="sess-3" status="running" refresh={1} />);
    await waitFor(() => expect(within(trace).getByText('Could not load the trace: the daemon is unreachable')).toBeTruthy());
    expect(calls).toEqual(['/api/sessions/sess-3/events', '/api/sessions/sess-3/events?after=2', '/api/sessions/sess-3/events']); // one fallback, no retry loop
    expect(within(trace).getAllByRole('group')).toHaveLength(2); // the failed delta kept the rows on screen
    // The next change takes the whole session again rather than the delta that failed.
    fail = false;
    rerender(<Trace sessionId="sess-3" status="running" refresh={2} />);
    await waitFor(() => expect(within(trace).queryByText(/could not load the trace/i)).toBeNull());
    expect(calls.at(-1)).toBe('/api/sessions/sess-3/events');
    expect(within(trace).getAllByRole('group')).toHaveLength(2);
  });
  it('runs the full fallback at once when the last delta of an ended session fails, with no later change to trigger it', async () => {
    const calls: string[] = [];
    let full = 0;
    mockApi((_m, url) => {
      if (!url.includes('/api/sessions/sess-3/events')) throw Object.assign(new Error('unexpected ' + url), { status: 500 });
      calls.push(url);
      if (url.includes('after=')) throw Object.assign(new Error('the daemon is unreachable'), { status: 500 });
      full += 1;
      return full === 1 ? events.slice(0, 2) : events; // the fallback carries the final rows the failed delta would have
    });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(2));
    rerender(<Trace sessionId="sess-3" status="ended" endedAt="2026-09-12T10:00:09.000Z" refresh={1} />); // the session's last change
    await waitFor(() => expect(within(trace).getAllByRole('group')).toHaveLength(4));
    expect(calls).toEqual(['/api/sessions/sess-3/events', '/api/sessions/sess-3/events?after=2', '/api/sessions/sess-3/events']);
    expect(within(trace).queryByText(/could not load the trace/i)).toBeNull();
    expect(within(trace).getAllByText('process_start')).toHaveLength(1); // replaced, not appended to the rows it had
  });
  it('drops the first load of a session switched away from and back to, with one request for it in flight at a time', async () => {
    const calls: string[] = [];
    let releaseFirstA: () => void = () => {};
    let releaseSecondA: () => void = () => {};
    let aCalls = 0;
    mockApi((_m, url) => {
      calls.push(url);
      if (url.endsWith('/api/sessions/sess-b/events')) return [ev(8, 'error', { message: 'from session b' })];
      if (url.endsWith('/api/sessions/sess-3/events')) {
        aCalls += 1;
        if (aCalls === 1) return new Promise<unknown>((r) => { releaseFirstA = () => r([ev(9, 'assistant_text', { text: 'from the first load of a' })]); });
        return new Promise<unknown>((r) => { releaseSecondA = () => r(events); });
      }
      throw Object.assign(new Error('unexpected ' + url), { status: 500 });
    });
    const { rerender } = render(<Trace sessionId="sess-3" status="running" refresh={0} />);
    rerender(<Trace sessionId="sess-b" status="running" refresh={0} />);
    const trace = screen.getByRole('region', { name: 'Trace' });
    await within(trace).findByText('from session b');
    rerender(<Trace sessionId="sess-3" status="running" refresh={0} />);
    // Back on the first session while its first load is pending: no second request for it yet.
    expect(calls.filter((u) => u.includes('/sess-3/'))).toEqual(['/api/sessions/sess-3/events']);
    expect(within(trace).queryByText('from session b')).toBeNull();
    await act(async () => { releaseFirstA(); }); // the first load's response lands last, into the new view of the same session
    expect(within(trace).queryByText('from the first load of a')).toBeNull(); // dropped: it belongs to the earlier view
    expect(within(trace).getByText(/loading the trace/i)).toBeTruthy();
    expect(calls.filter((u) => u.includes('/sess-3/'))).toEqual(['/api/sessions/sess-3/events', '/api/sessions/sess-3/events']); // only now the new view's own full fetch
    await act(async () => { releaseSecondA(); });
    expect(within(trace).getAllByRole('group')).toHaveLength(4);
    expect(within(trace).queryByText('from the first load of a')).toBeNull();
  });
  it('says so when the trace cannot be loaded', async () => {
    mockApi(() => { throw Object.assign(new Error('session sess-9 not found'), { status: 404 }); });
    render(<Trace sessionId="sess-9" />);
    expect(await screen.findByText('Could not load the trace: session sess-9 not found')).toBeTruthy();
  });
});
