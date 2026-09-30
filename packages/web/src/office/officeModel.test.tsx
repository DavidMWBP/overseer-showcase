import type { OfficeSession } from '@overseer/shared';
import { describe, expect, it } from 'vitest';
import { board } from '../test/fixtures';
import { deriveScene, lightingAt } from './officeModel';
import { SPOTS } from './pixi/world';

const session = (over: Partial<OfficeSession> = {}): OfficeSession => ({
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-3', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'walking_in', stalled_since: null, ...over,
});

describe('lightingAt', () => {
  it.each([
    { at: '12:00', hour: 12, minute: 0, share: 0 },
    { at: '19:29', hour: 19, minute: 29, share: 0 },
    { at: '19:30', hour: 19, minute: 30, share: 0 },
    { at: '20:00', hour: 20, minute: 0, share: 0.5 },
    { at: '20:30', hour: 20, minute: 30, share: 1 },
    { at: '23:59', hour: 23, minute: 59, share: 1 },
    { at: '00:00', hour: 0, minute: 0, share: 1 },
    { at: '03:00', hour: 3, minute: 0, share: 1 },
    { at: '06:30', hour: 6, minute: 30, share: 1 },
    { at: '07:00', hour: 7, minute: 0, share: 0.5 },
    { at: '07:30', hour: 7, minute: 30, share: 0 },
    { at: '07:31', hour: 7, minute: 31, share: 0 },
  ])('returns the expected share at $at local time', ({ hour, minute, share }) => {
    expect(lightingAt(new Date(2026, 8, 24, hour, minute))).toBe(share);
  });
});

describe('deriveScene', () => {
  it('reports no verification when there are no sessions or the feed has not arrived', () => {
    expect([deriveScene([], null).props.verifying, deriveScene(null, null).props.verifying]).toEqual([false, false]);
  });

  it('reports verification for one verifying session', () => {
    expect(deriveScene([session({ state: 'verifying' })], null).props.verifying).toBe(true);
  });

  it('stops reporting verification when verifying becomes working', () => {
    const verifying = deriveScene([session({ state: 'verifying' })], null);
    const working = deriveScene([session({ state: 'working' })], null, { previous: verifying });

    expect(working.props.verifying).toBe(false);
  });

  it('reports verification when one of two sessions is verifying', () => {
    const frame = deriveScene([
      session({ state: 'working' }),
      session({ session_id: 's2', state: 'verifying', bead_id: 'ov-4' }),
    ], null);

    expect(frame.props.verifying).toBe(true);
  });

  it('keeps the held verification flag while the snapshot is stale', () => {
    const verifying = deriveScene([session({ state: 'verifying' })], null);
    const stale = deriveScene([session({ state: 'working' })], null, { previous: verifying, stale: true });

    expect(stale.props.verifying).toBe(true);
  });

  it('distinguishes an empty snapshot from an unloaded feed and returns renderer props', () => {
    const empty = deriveScene([], board);
    const unloaded = deriveScene(null, null);

    expect({ agents: empty.agents, hasSnapshot: empty.props.hasSnapshot, board: empty.props.board })
      .toEqual({ agents: [], hasSnapshot: true, board });
    expect({ agents: unloaded.agents, hasSnapshot: unloaded.props.hasSnapshot }).toEqual({ agents: [], hasSnapshot: false });
  });

  it('derives one character with its role, desk, reported state, label and stall flag', () => {
    const frame = deriveScene([session({ state: 'working', stalled_since: '2026-09-23T14:03:00.000Z' })], null);
    const [agent] = frame.agents;

    expect(frame.agents).toHaveLength(1);
    expect(agent).toMatchObject({
      id: 's1', role: 'worker', state: 'working', assignedSpotId: 'desk-1', labelText: 'claude · sonnet · ov-3',
      stalled: true, stalledSince: '2026-09-23T14:03:00.000Z',
    });
    expect(agent?.deskPosition).toEqual({ x: 3.2 + 0.72, y: 3.0 - 0.42 });
  });

  it('uses the role label when a session has no task or model', () => {
    const [agent] = deriveScene([session({ role: 'orchestrator', bead_id: null, model: null })], null).agents;
    expect(agent?.labelText).toBe('claude · orchestrator');
  });

  it('stacks a session past the last overflow spot on the last back-wall row spot', () => {
    const capacity = SPOTS.filter((spot) => ['run', 'lab', 'row'].includes(spot.zone)).length + 3;
    const feed = [
      session({ session_id: 'orchestrator', role: 'orchestrator', bead_id: null }),
      ...Array.from({ length: capacity + 1 }, (_, index) => session({ session_id: `worker-${index}` })),
    ];
    const frame = deriveScene(feed, null);
    const assigned = frame.agents.map((agent) => agent.assignedSpotId);

    expect(frame.agents).toHaveLength(capacity + 2);
    expect(new Set(assigned).size).toBe(capacity + 1);
    expect(frame.agents.at(-1)?.assignedSpotId).toBe('row-20');
  });

  it('ignores duplicate session ids after the first feed entry', () => {
    const frame = deriveScene([
      session({ state: 'working' }),
      session({ state: 'verifying', bead_id: 'ov-4' }),
    ], null);

    expect(frame.agents).toHaveLength(1);
    expect(frame.agents[0]).toMatchObject({ id: 's1', state: 'working', labelText: 'claude · sonnet · ov-3' });
  });

  it('marks a session that left the snapshot as leaving while retaining its local pose', () => {
    const initial = deriveScene([session({ state: 'working' })], null);
    const next = deriveScene([], null, { previous: initial });

    expect(next.agents).toHaveLength(1);
    expect(next.agents[0]).toMatchObject({ id: 's1', state: 'working', pose: 'leaving', assignedSpotId: 'desk-1' });
  });

  it('freezes the last frame while the held snapshot is stale', () => {
    const initial = deriveScene([session({ state: 'working' })], null);
    const previousPosition = initial.agents[0]!.position;
    const stale = deriveScene([session({ session_id: 's2', state: 'verifying' })], null, { previous: initial, stale: true });

    expect(stale.agents.map(({ id }) => id)).toEqual(['s1']);
    expect(stale.agents[0]).toMatchObject({ state: 'working', pose: 'walking' });
    expect(stale.agents[0]?.position).toBe(previousPosition);
    expect(stale.props.hasSnapshot).toBe(true);
  });

  it('reconciles departures and arrivals from the replacement reconnect snapshot', () => {
    const initial = deriveScene([session({ state: 'working' })], null);
    const stale = deriveScene([session()], null, { previous: initial, stale: true });
    const reconnected = deriveScene([session({ session_id: 's2', bead_id: 'ov-4' })], null, { previous: stale });
    const departing = reconnected.agents.find((agent) => agent.id === 's1');
    const arriving = reconnected.agents.find((agent) => agent.id === 's2');

    expect(departing?.pose).toBe('leaving');
    expect(arriving).toMatchObject({ state: 'walking_in', pose: 'walking', labelText: 'claude · sonnet · ov-4' });
  });

  it('clears a stall mark when the feed clears stalled_since', () => {
    const stalled = deriveScene([session({ stalled_since: '2026-09-23T14:03:00.000Z' })], null);
    const cleared = deriveScene([session()], null, { previous: stalled });

    expect(stalled.agents[0]).toMatchObject({ stalled: true, stalledSince: '2026-09-23T14:03:00.000Z' });
    expect(cleared.agents[0]).toMatchObject({ stalled: false, stalledSince: null });
  });

  it.each(['walking_in', 'working', 'verifying', 'reviewing'] as const)('preserves the reported %s state', (state) => {
    expect(deriveScene([session({ state })], null).agents[0]?.state).toBe(state);
  });

  it('keeps a reported leaving state on an existing character', () => {
    const initial = deriveScene([session({ state: 'working' })], null);
    const leaving = deriveScene([session({ state: 'leaving' })], null, { previous: initial });
    expect(leaving.agents[0]).toMatchObject({ state: 'leaving', pose: 'leaving' });
  });
});
