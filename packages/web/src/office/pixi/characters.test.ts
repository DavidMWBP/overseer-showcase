import { describe, expect, it } from 'vitest';
import type { OfficeSession } from '@overseer/shared';
import { assignSpot, createAgent, snapAgents } from '../agentManager';
import type { Agent } from '../types';
import { characterHitArea, characterName, characterTarget, nearestCharacter, characterPose, frameIndex, HIT_AREA, isClickable, TYPING_LEAN, updateCharacter, type CharacterView } from './characters';
import { fitInside } from '../touchTarget';
import { furnitureSpritePlacements } from './furniture';
import { ENTRY, p, SPOTS, stepToward, type Facing } from './world';

const session = (over: Partial<OfficeSession> = {}): OfficeSession => ({
  session_id: 's1', role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-5', bead_title: 'Running task', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null, ...over,
});
const desk = SPOTS.find((spot) => spot.id === 'desk-1')!;
const deskSpot = { id: desk.id, type: 'desk' as const, x: desk.x, y: desk.y, spriteFacing: desk.f };
/** An agent seated at desk-1, the back-row seat facing the camera, as the sim leaves it once the walk ends. */
const seated = (over: Partial<Agent> = {}, s: Partial<OfficeSession> = {}): Agent => {
  const agent = createAgent(session(s), deskSpot);
  return { ...agent, pose: 'arrived', position: { x: desk.x, y: desk.y }, pathQueue: [], ...over };
};

describe('Pixi character pose', () => {
  it('types while seated and working', () => {
    expect(characterPose(seated(), 'front-left', 1000, false).anim).toBe('type');
  });

  it('stands idle while seated and stalled', () => {
    expect(characterPose(seated({}, { stalled_since: '2026-09-25T10:00:00.000Z' }), 'front-left', 1000, false).anim).toBe('idle');
  });

  it('walks while a path remains', () => {
    const agent = createAgent(session(), deskSpot);
    expect(characterPose(agent, 'rear-right', 1000, false).anim).toBe('walk');
  });

  it("leans a typist in along its seat's facing by seat, and no one at the meeting table or not typing", () => {
    const at = (id: string, s: Partial<OfficeSession> = {}) => {
      const spot = SPOTS.find((candidate) => candidate.id === id)!;
      const agent = createAgent(session(s), { id, type: 'desk', x: spot.x, y: spot.y, spriteFacing: spot.f });
      const pose = characterPose({ ...agent, pose: 'arrived', position: { x: spot.x, y: spot.y }, pathQueue: [] }, spot.f, 1000, false);
      const [x, y] = p(spot.x, spot.y);
      return [pose.anim, pose.x - x, pose.y - y, pose.zIndex === Math.round((spot.x + spot.y) * 100)];
    };
    expect([at('desk-1'), at('desk-2'), at('orch'), at('qa-1'), at('qa-2'), at('qa-1', { stalled_since: '2026-09-25T10:00:00.000Z' }), at('review-1'), at('review-2')]).toEqual([
      ['type', -6, 3, true],
      ['type', 6, -3, true],
      ['type', -6, 3, true],
      ['type', -2, -1, true],
      ['type', -2, -1, true],
      ['idle', 0, 0, true],
      ['type', 0, 0, true],
      ['type', 0, 0, true],
    ]);
  });

  it('faces its spot when seated, whatever the last step was', () => {
    const pose = characterPose(seated(), 'rear-right', 1000, false);
    expect([pose.view, pose.flip]).toEqual(['front', false]);
  });

  it('assigns all 12 worker seats in turn, the back-to-camera ones included', () => {
    const taken = new Set<string>();
    const assigned = Array.from({ length: 12 }, () => {
      const spot = assignSpot('worker', taken)!;
      taken.add(spot.id);
      return [spot.id, spot.spriteFacing];
    });
    expect(assigned).toEqual(SPOTS.filter((spot) => spot.zone === 'run').map((spot) => [spot.id, spot.f]));
  });

  it('types with rear frames at a monitor front in the front row, and with front frames at a monitor back in the back row', () => {
    const taken = new Set<string>();
    const monitors = new Map(furnitureSpritePlacements().filter((placement) => placement.id.startsWith('monitor-')).map((placement) => [placement.spotId, placement]));
    const rows = ['s1', 's2'].map((id) => {
      const spot = assignSpot('worker', taken)!;
      taken.add(spot.id);
      const [agent] = snapAgents([createAgent(session({ session_id: id }), spot)]);
      const requested: string[] = [];
      const view = {
        root: { position: { set: () => {} } },
        sprite: { totalFrames: 2, gotoAndStop: () => {}, scale: { x: 1 }, tint: 0xffffff, rotation: 0, y: 4 },
        key: '', facing: agent!.spriteFacing, last: { ...agent!.position }, born: 0,
      } as unknown as CharacterView;
      updateCharacter(view, agent!, { frames: (_char: string, anim: string, sheetView: string) => { requested.push(`${anim}/${sheetView}`); return [{}]; } } as never, 1000, false, false);
      const monitor = monitors.get(spot.id)!;
      return [spot.id, requested.at(-1), view.sprite.scale.x, monitor.asset, monitor.overlays!.map((overlay) => overlay.asset)];
    });
    expect(rows).toEqual([
      ['desk-1', 'type/front', 1, 'furniture/monitor-back', ['furniture/monitor-back-lit']],
      ['desk-2', 'type/rear', -1, 'furniture/monitor-front', ['furniture/monitor-front-lit']],
    ]);
  });

  it('faces the board when a milestone supplies an override', () => {
    expect(characterPose(seated(), 'front-left', 1000, false, 'rear-right')).toMatchObject({ view: 'rear', flip: true });
  });

  it('flips a right-facing walker, since frames face left', () => {
    const agent = createAgent(session(), deskSpot);
    expect(characterPose(agent, 'rear-right', 1000, false)).toMatchObject({ view: 'rear', flip: true });
  });

  it('sorts by its feet', () => {
    expect(characterPose(seated(), 'front-left', 1000, false).zIndex).toBe(Math.round((desk.x + desk.y) * 100));
  });

  it('is half transparent while stalled', () => {
    expect(characterPose(seated({}, { stalled_since: '2026-09-25T10:00:00.000Z' }), 'front-left', 1000, false).alpha).toBe(0.5);
  });

  it('keeps a departing character opaque at 1.2 tiles from the door', () => {
    const agent = seated({ pose: 'leaving', position: { x: ENTRY.x + 1.2, y: ENTRY.y }, targetPosition: { ...ENTRY } });
    expect(characterPose(agent, 'front-left', 1000, false).alpha).toBeCloseTo(1, 12);
  });

  it('fades a departing character out at the door', () => {
    const agent = seated({ pose: 'leaving', position: { ...ENTRY }, targetPosition: { ...ENTRY } });
    expect(characterPose(agent, 'front-left', 1000, false).alpha).toBe(0);
  });

  it('tints and tilts a failed character', () => {
    const agent = seated();
    const view = {
      root: { position: { set: () => {} } },
      sprite: { totalFrames: 1, gotoAndStop: () => {}, scale: { x: 1 }, tint: 0xffffff, rotation: 0, y: 4 },
      key: `${agent.charBase}/type/front`, facing: agent.spriteFacing, last: { ...agent.position }, born: 0,
    } as unknown as CharacterView;
    updateCharacter(view, agent, { frames: () => [{}] } as never, 1000, false, false, { failed: true });
    expect([view.sprite.tint, view.sprite.rotation]).toEqual([0x9a9a9a, -0.12]);
  });

  /** Walk a character through `waypoints` at the sim's 0.05 tiles per frame, calling `updateCharacter` each frame; returns the facing after each frame. */
  const walkFacings = (start: { x: number; y: number }, waypoints: { x: number; y: number }[], frames: number, facing: Facing): Facing[] => {
    let agent = seated({ pose: 'walking', position: { ...start }, pathQueue: [] });
    const view = {
      root: { position: { set: () => {} } },
      sprite: { totalFrames: 1, gotoAndStop: () => {}, scale: { x: 1 }, tint: 0xffffff, rotation: 0, y: 4 },
      key: '', facing, last: { ...start }, born: 0,
    } as unknown as CharacterView;
    const queue = [...waypoints];
    const facings: Facing[] = [];
    for (let frame = 0; frame < frames && queue.length; frame += 1) {
      const step = stepToward(agent.position, queue[0]!, 0.05);
      if (step.arrived) queue.shift();
      agent = { ...agent, position: step.position };
      updateCharacter(view, agent, { frames: () => [{}] } as never, 1000 + frame * 16, false, false);
      facings.push(view.facing);
    }
    return facings;
  };

  it('keeps one facing along a straight (+i, −j) segment for 30 steps', () => {
    // 3 − 3 tiles across the screen: di + dj is 0 or ±4e-16 noise on each step.
    expect(new Set(walkFacings({ x: 3.1, y: 7.3 }, [{ x: 6.1, y: 4.3 }], 30, 'front-right'))).toEqual(new Set(['front-right']));
  });

  it('changes facing once when a walk turns a corner', () => {
    const facings = walkFacings({ x: 3.1, y: 7.3 }, [{ x: 3.8, y: 6.6 }, { x: 3.1, y: 5.9 }], 30, 'front-right');
    const changes = facings.filter((facing, index) => index > 0 && facing !== facings[index - 1]);
    expect([facings[0], changes]).toEqual(['front-right', ['rear-right']]);
  });

  it('fades in over its first 400 ms unless motion is reduced', () => {
    expect([characterPose(seated(), 'front-left', 200, false).alpha, characterPose(seated(), 'front-left', 200, true).alpha]).toEqual([0.5, 1]);
  });

  it('holds the first frame while frozen', () => {
    expect(frameIndex('walk', 4, 12_345, true)).toBe(0);
  });

  it('steps the walk at 0.16 frames per tick', () => {
    expect([0, 1, 2, 3, 4].map((tick) => frameIndex('walk', 4, (tick * 1000) / 60 / 0.16 + 1, false))).toEqual([0, 1, 2, 3, 0]);
  });

  it('uses the handoff hit area around the feet', () => {
    expect(HIT_AREA).toEqual({ x: -26, y: -90, width: 52, height: 96 });
  });

  describe('touch targets', () => {
    // The review's phone scale at 390 x 844: 0.327 CSS px per world px, where HIT_AREA is 17 x 31 CSS px.
    const PHONE_SCALE = 0.327;

    it('keeps HIT_AREA on a fine pointer at the phone scale, and at 768 px', () => {
      expect([characterHitArea(PHONE_SCALE), characterHitArea(PHONE_SCALE, 0), characterHitArea(0.45, 0)]).toEqual([HIT_AREA, HIT_AREA, HIT_AREA]);
    });

    it('grows to at least 44 x 44 CSS px about the same centre on a coarse pointer at the phone scale', () => {
      const area = characterHitArea(PHONE_SCALE, 44);
      expect({
        width: area.width * PHONE_SCALE, height: area.height * PHONE_SCALE,
        centre: [area.x + area.width / 2, area.y + area.height / 2],
      }).toEqual({ width: expect.closeTo(44, 6), height: expect.closeTo(44, 6), centre: [HIT_AREA.x + HIT_AREA.width / 2, HIT_AREA.y + HIT_AREA.height / 2] });
    });

    it('keeps the larger HIT_AREA side where it is already over 44 CSS px (1440 px desktop scale on a touch screen)', () => {
      expect(characterHitArea(1, 44)).toEqual({ x: -26, y: -90, width: 52, height: 96 });
    });

    it('opens the character whose centre is nearest when a tap lands in two overlapping targets', () => {
      // Feet 60 world px apart: their 134 px targets overlap. The target centres sit 42 px above the feet.
      const first = { id: 'first', x: 100, y: 200 };
      const second = { id: 'second', x: 160, y: 200 };
      expect({
        nearSecond: nearestCharacter({ x: 140, y: 158 }, [first, second], PHONE_SCALE, 44),
        nearFirst: nearestCharacter({ x: 120, y: 158 }, [first, second], PHONE_SCALE, 44),
        orderIgnored: nearestCharacter({ x: 140, y: 158 }, [second, first], PHONE_SCALE, 44),
      }).toEqual({ nearSecond: 'second', nearFirst: 'first', orderIgnored: 'second' });
    });

    it('opens nothing for a tap outside every target (empty floor) or with no characters', () => {
      expect([nearestCharacter({ x: 400, y: 400 }, [{ id: 'a', x: 100, y: 200 }], PHONE_SCALE, 44), nearestCharacter({ x: 100, y: 158 }, [], PHONE_SCALE, 44)]).toEqual([null, null]);
    });

    describe('at the stage edge', () => {
      const min = 44 / PHONE_SCALE;
      // The stage shows world x 50 to 600 and y 120 to 500; a character's feet at (60, 200) put its centred 134 px target
      // 57 px past the left edge and 29 px past the top.
      const visible = { left: 50, top: 120, right: 600, bottom: 500 };
      const edge = { id: 'edge', x: 60, y: 200 };

      it('cuts a coarse target to the visible box and grows it back inward to 44 CSS px, keeping its centre for distance', () => {
        const target = characterTarget(edge, PHONE_SCALE, 44, visible);
        expect({
          box: [target.left, target.top, target.width * PHONE_SCALE, target.height * PHONE_SCALE].map((value) => Math.round(value * 1000) / 1000),
          inside: target.left >= visible.left && target.top >= visible.top && target.left + target.width <= visible.right && target.top + target.height <= visible.bottom,
          centre: [target.cx, target.cy],
        }).toEqual({ box: [50, 120, 44, 44], inside: true, centre: [60, 158] });
      });

      it('reaches a tap inside the fitted target and nothing past the stage edge', () => {
        expect([
          nearestCharacter({ x: 50 + min - 1, y: 158 }, [edge], PHONE_SCALE, 44, visible),
          nearestCharacter({ x: 45, y: 158 }, [edge], PHONE_SCALE, 44, visible),
        ]).toEqual(['edge', null]);
      });

      it('keeps HIT_AREA on a fine pointer, even at the edge', () => {
        const target = characterTarget({ id: 'edge', x: 40, y: 200 }, PHONE_SCALE, 0, visible);
        expect([target.left, target.top, target.width, target.height]).toEqual([40 + HIT_AREA.x, 200 + HIT_AREA.y, HIT_AREA.width, HIT_AREA.height]);
      });
    });
  });

  describe('fitInside', () => {
    const visible = { left: 0, top: 0, right: 100, bottom: 60 };
    it.each([
      { name: 'leaves a target inside the box alone', rect: { left: 10, top: 10, width: 44, height: 44 }, fitted: { left: 10, top: 10, width: 44, height: 44 } },
      { name: 'moves a target cut at the low edges back in whole', rect: { left: -20, top: -10, width: 44, height: 44 }, fitted: { left: 0, top: 0, width: 44, height: 44 } },
      { name: 'moves a target cut at the high edges back in whole', rect: { left: 80, top: 30, width: 44, height: 44 }, fitted: { left: 56, top: 16, width: 44, height: 44 } },
      { name: 'keeps the visible part of a side already over the minimum', rect: { left: 10, top: -40, width: 44, height: 96 }, fitted: { left: 10, top: 0, width: 44, height: 56 } },
      { name: 'covers the whole box where it is smaller than the minimum', rect: { left: 10, top: 10, width: 44, height: 44 }, box: { left: 0, top: 0, right: 100, bottom: 30 }, fitted: { left: 10, top: 0, width: 44, height: 30 } },
      { name: 'leaves a target wholly outside the box as it is', rect: { left: 200, top: 10, width: 44, height: 44 }, fitted: { left: 200, top: 10, width: 44, height: 44 } },
    ])('$name', ({ rect, box, fitted }) => {
      expect(fitInside(rect, box ?? visible, 44)).toEqual(fitted);
    });
  });

  it('is clickable with a bead or as the orchestrator, and not otherwise', () => {
    expect([seated(), seated({ beadId: null, role: 'orchestrator' }), seated({ beadId: null, role: 'critic' })].map(isClickable)).toEqual([true, true, false]);
  });

  it('carries the label and where a click goes in its accessible name', () => {
    expect(characterName(seated({ beadId: null, role: 'orchestrator', labelText: 'claude · sonnet · orchestrator' }), 'focus Chat')).toBe('claude · sonnet · orchestrator (focus Chat)');
  });
});
