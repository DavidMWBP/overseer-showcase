import { describe, expect, it } from 'vitest';
import type { OfficeSession } from '@overseer/shared';
import type { Agent } from './types';
import { assignSpot, createAgent, leaveAgent, stepAgents } from './agentManager';
import { deriveScene } from './officeModel';
import { SPOTS } from './pixi/world';

const session: OfficeSession = {
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null,
  account_label: null, bead_id: 'ov-3', bead_title: 'Running task', batch_id: null, repo_id: 'r1',
  state: 'walking_in', stalled_since: null,
};

describe('stepAgents', () => {
  it('records a walking_in arrival as a pose without changing the reported state', () => {
    const created = createAgent(session, assignSpot(session.role, new Set())!);
    const atDesk: Agent = { ...created, position: created.deskPosition, targetPosition: created.deskPosition, pathQueue: [] };

    const arrived = stepAgents([atDesk], 1)[0]!;

    expect({ state: arrived.state, pose: arrived.pose }).toEqual({ state: 'walking_in', pose: 'arrived' });
  });

  it('starts a local departure without changing the reported state', () => {
    const created = createAgent({ ...session, state: 'working' }, assignSpot(session.role, new Set())!);
    const leaving = leaveAgent(created);

    expect({ state: leaving.state, pose: leaving.pose }).toEqual({ state: 'working', pose: 'leaving' });
  });
});

describe('assignSpot', () => {
  const meeting = SPOTS.filter((spot) => spot.zone === 'review').map((spot) => spot.id);
  const runDesks = SPOTS.filter((spot) => spot.zone === 'run').map((spot) => spot.id);
  const rowSpots = SPOTS.filter((spot) => spot.zone === 'row').map((spot) => spot.id);
  /** The overflow order the user approved: pod desks, QA desks, errand spots, then the back-wall row. */
  const path = [...runDesks, 'qa-1', 'qa-2', 'coffee', 'fridge', 'sofa', ...rowSpots];
  /** Assign `n` sessions of one role in turn, each taking its spot before the next arrives. */
  const fill = (role: string, n: number) => {
    const taken = new Set<string>();
    return Array.from({ length: n }, () => { const spot = assignSpot(role, taken)!; taken.add(spot.id); return spot.id; });
  };

  it('seats a critic at the first free meeting-table seat', () => {
    expect([assignSpot('critic', new Set())!.id, assignSpot('critic', new Set(['review-1']))!.id]).toEqual(['review-1', 'review-2']);
  });

  it('seats a fifth critic at a free run desk once the four meeting seats are taken', () => {
    expect(assignSpot('critic', new Set(meeting))!.id).toBe(runDesks[0]);
  });

  it('never seats a worker at a meeting-table seat', () => {
    expect(fill('worker', path.length + 1).filter((id) => meeting.includes(id))).toEqual([]);
  });

  it('seats 12 workers at the 12 pod desks only', () => {
    expect(fill('worker', 12)).toEqual(runDesks);
  });

  it('seats the 13th and 14th workers at the QA desks', () => {
    expect(fill('worker', 14).slice(12)).toEqual(['qa-1', 'qa-2']);
  });

  it('sends the 15th to 17th workers to the coffee machine, the fridge and the sofa', () => {
    expect(fill('worker', 17).slice(14)).toEqual(['coffee', 'fridge', 'sofa']);
  });

  it('stands the 18th worker at the first back-wall row spot', () => {
    expect(fill('worker', 18)[17]).toBe('row-1');
  });

  it('gives each of 12 + 2 + 3 + 20 workers its own spot, along the whole path in order', () => {
    const seats = fill('worker', 12 + 2 + 3 + 20);
    expect([seats, new Set(seats).size, rowSpots.length]).toEqual([path, 37, 20]);
  });

  it('puts one worker past the last row spot on that last row spot', () => {
    const seats = fill('worker', 12 + 2 + 3 + 20 + 1);
    expect([seats.at(-1), seats.filter((id) => id === 'row-20').length, new Set(seats).size]).toEqual(['row-20', 2, 37]);
  });

  it('never puts two characters on one spot below the stacking limit, whatever the mix of roles', () => {
    const taken = new Set<string>(['orch']);
    const roles = Array.from({ length: path.length + meeting.length }, (_, k) => (k % 3 === 0 ? 'critic' : 'worker'));
    const seats = roles.map((role) => { const spot = assignSpot(role, taken)!; taken.add(spot.id); return spot.id; });
    expect([new Set(seats).size, seats.length, seats.includes('orch')]).toEqual([seats.length, path.length + meeting.length, false]);
  });

  it('sends a fifth critic to the first free pod desk', () => {
    expect(fill('critic', 5)).toEqual([...meeting, 'desk-1']);
  });

  it('sends a fifth critic to qa-1 when every pod desk is taken, and on along the path', () => {
    const taken = new Set([...meeting, ...runDesks]);
    expect([assignSpot('critic', taken)!.id, assignSpot('critic', new Set([...taken, 'qa-1', 'qa-2']))!.id]).toEqual(['qa-1', 'coffee']);
  });

  it('gives a freed spot to the next arrival and moves nobody else', () => {
    const feed = Array.from({ length: 16 }, (_, k) => ({ ...session, session_id: `w${k}`, bead_id: `ov-${k}` }));
    const before = deriveScene(feed, null);
    const spotOf = (frame: typeof before) => Object.fromEntries(frame.agents.filter((agent) => agent.pose !== 'leaving').map((agent) => [agent.id, agent.assignedSpotId]));
    const rest = feed.filter((s) => s.session_id !== 'w13');
    const gone = deriveScene(rest, null, { previous: before });
    const arrived = deriveScene([...rest, { ...session, session_id: 'new', bead_id: 'ov-99' }], null, { previous: gone });
    const { w13: freed, ...stayed } = spotOf(before);
    const { new: taken, ...after } = spotOf(arrived);
    expect([freed, taken, after]).toEqual(['qa-2', 'qa-2', stayed]);
  });

  it('keeps the orchestrator at its own desk, even with every meeting seat taken', () => {
    expect([assignSpot('orchestrator', new Set())!.id, assignSpot('orchestrator', new Set(meeting))!.id]).toEqual(['orch', 'orch']);
  });

  it('seats a critic from the office feed at a meeting-table seat', () => {
    const frame = deriveScene([{ ...session, session_id: 'c1', role: 'critic' }, session], null);
    expect(frame.agents.map((agent) => [agent.id, agent.assignedSpotId])).toEqual([['c1', 'review-1'], ['s1', runDesks[0]]]);
  });
});
