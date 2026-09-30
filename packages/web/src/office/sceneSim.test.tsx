import type { OfficeSession } from '@overseer/shared';
import { describe, expect, it } from 'vitest';
import { deriveScene } from './officeModel';
import { SceneSim } from './sceneSim';

const session: OfficeSession = {
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-3', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'walking_in', stalled_since: null,
};

describe('SceneSim.step', () => {
  it('uses the supplied clock and produces deterministic positions from the same frame', () => {
    const frame = deriveScene([session], null);
    let first = SceneSim.step(frame, 0, 0);
    let second = SceneSim.step(frame, 0, 0);
    for (let index = 1; index <= 20; index++) {
      first = SceneSim.step(first, 1, index * 16.67);
      second = SceneSim.step(second, 1, index * 16.67);
    }

    expect(first.agents[0]?.position).toEqual(second.agents[0]?.position);
    expect(first.agents[0]?.position).not.toEqual(frame.agents[0]?.position);
    expect(first.now).toBeCloseTo(333.4);
  });

  it.each([0, -1])('keeps positions finite and still for dt %s', (dt) => {
    const frame = deriveScene([session], null);
    const stepped = SceneSim.step(frame, dt, 100);

    expect(stepped.agents[0]?.position).toEqual(frame.agents[0]?.position);
    expect(Number.isFinite(stepped.agents[0]!.position.x)).toBe(true);
    expect(Number.isFinite(stepped.agents[0]!.position.y)).toBe(true);
  });

  it('snaps agents to their desks and completes departures under reduced motion', () => {
    const moving = deriveScene([session], null, { reducedMotion: true });
    const snapped = SceneSim.step(moving, 1, 500);

    expect(snapped.agents[0]).toMatchObject({ pose: 'arrived', pathQueue: [] });
    expect(snapped.agents[0]?.position).toEqual(snapped.agents[0]?.deskPosition);

    const leaving = deriveScene([], null, { previous: snapped, reducedMotion: true });
    expect(leaving.agents[0]?.pose).toBe('leaving');
    expect(SceneSim.step(leaving, 1, 1000).agents).toHaveLength(0);
  });

  it('sets the arrival pose without rewriting the reported feed state', () => {
    const frame = deriveScene([session], null);
    const agent = frame.agents[0]!;
    const atDesk = {
      ...frame,
      agents: [{ ...agent, position: agent.deskPosition, targetPosition: agent.deskPosition, pathQueue: [] }],
    };
    const arrived = SceneSim.step(atDesk, 0, 42);

    expect(arrived.agents[0]).toMatchObject({ state: 'walking_in', pose: 'arrived' });
    expect(arrived.now).toBe(42);
  });

  it('does not mutate the frame it advances', () => {
    const frame = deriveScene([session], null);
    const before = structuredClone(frame);

    SceneSim.step(frame, 2, 123);

    expect(frame).toEqual(before);
  });

  it('runs the office state sequence to each character’s assigned spot', () => {
    const crew: OfficeSession[] = [
      session,
      { ...session, session_id: 'orchestrator', role: 'orchestrator', bead_id: null },
    ];
    const states: OfficeSession['state'][] = ['walking_in', 'working', 'verifying', 'reviewing', 'working'];
    let frame = deriveScene(crew.map((agent) => ({ ...agent, state: states[0]! })), null);
    for (const state of states.slice(1)) {
      frame = deriveScene(crew.map((agent) => ({ ...agent, state })), null, { previous: frame });
    }
    for (let index = 0; index < 1200; index++) frame = SceneSim.step(frame, 3, index * 50);

    expect(frame.agents.map(({ id, assignedSpotId, position, deskPosition }) => ({ id, assignedSpotId, position, deskPosition }))).toEqual([
      { id: 's1', assignedSpotId: 'desk-1', position: { x: 3.2 + 0.72, y: 3.0 - 0.42 }, deskPosition: { x: 3.2 + 0.72, y: 3.0 - 0.42 } },
      { id: 'orchestrator', assignedSpotId: 'orch', position: { x: 7.4 + 1.3, y: 10.9 - 0.45 }, deskPosition: { x: 7.4 + 1.3, y: 10.9 - 0.45 } },
    ]);
  });
});
