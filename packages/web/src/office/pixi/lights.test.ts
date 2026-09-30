import { describe, expect, it } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import {
  buildFloorGrade,
  buildLights,
  FLOOR_GRADE,
  lightAlpha,
  lightFalloff,
  LIGHT_PROFILES,
  RADIAL_LIGHT_TEXTURE_SIZE,
  radialTextureAlpha,
  sceneColorMatrix,
  screenGlow,
  updateFloorGrade,
  updateLights,
} from './lights';
import { CEILING_LIGHTS, furnitureSpritePlacements, SCREEN_GLOW_OFFSETS } from './furniture';
import { overlayAlpha, SCREEN_OVERLAY_ALPHA } from './scene';
import { QUESTION_NOTE_AT } from './roomProps';
import { floorRegion } from './room';
import { FURN, p, POD_TOP, SPOTS } from './world';
import type { Agent } from '../types';
import type { LightKind } from './lights';

const seatedAt = (spotId: string, state: Agent['state'], pose: Agent['pose'] = 'arrived'): Agent => ({
  assignedSpotId: spotId, pose, state, stalled: false, position: { x: 0, y: 0 }, deskPosition: { x: 0, y: 0 },
} as Agent);
/** The first QA desk's seat: empty, idle, working, verifying, or the other QA seat working instead. */
const qaCases: [string, Agent[]][] = [
  ['empty', []],
  ['idle', [seatedAt('qa-1', 'walking_in')]],
  ['working', [seatedAt('qa-1', 'working')]],
  ['verifying', [seatedAt('qa-1', 'verifying')]],
  ['other seat', [seatedAt('qa-2', 'verifying')]],
];
const spot = (id: string) => SPOTS.find((candidate) => candidate.id === id)!;
const deskOf = (id: string) => FURN.find((furniture) => furniture.i === spot(id).desk![0] && furniture.j === spot(id).desk![1])!;

describe('Pixi office lighting', () => {
  it('uses the full day matrix at zero darkness', () => {
    expect(sceneColorMatrix(0)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
  });

  it('uses the midpoint colour matrix at half darkness', () => {
    expect(sceneColorMatrix(0.5)).toEqual([0.66, 0, 0, 0, 0, 0, 0.665, 0, 0, 0, 0, 0, 0.69, 0, 0.005, 0, 0, 0, 1, 0]);
  });

  it('uses one dark, near-neutral night matrix at full darkness', () => {
    expect(sceneColorMatrix(1)).toEqual([0.32, 0, 0, 0, 0, 0, 0.33, 0, 0, 0, 0, 0, 0.38, 0, 0.01, 0, 0, 0, 1, 0]);
  });

  it('keeps the shared radial falloff monotone with no neighbouring step above 1/32 peak', () => {
    const samples = Array.from({ length: RADIAL_LIGHT_TEXTURE_SIZE / 2 + 1 }, (_, index) => radialTextureAlpha(index / (RADIAL_LIGHT_TEXTURE_SIZE / 2)));
    const drops = samples.slice(1).map((sample, index) => samples[index]! - sample);
    expect({
      centre: samples[0],
      edge: samples.at(-1),
      monotone: samples.every((sample, index) => index === 0 || sample <= samples[index - 1]!),
      maxStepWithinLimit: Math.max(...drops) / 255 <= 1 / 32,
      analytic: [lightFalloff(0), lightFalloff(0.5), lightFalloff(1)],
    }).toEqual({ centre: 255, edge: 0, monotone: true, maxStepWithinLimit: true, analytic: [1, 0.5, 0] });
  });

  it('uses the selected centre alphas and night sizes for every light kind', () => {
    const kinds = Object.keys(LIGHT_PROFILES) as LightKind[];
    expect(kinds.map((kind) => [kind, [lightAlpha(kind, 0), lightAlpha(kind, 1)], LIGHT_PROFILES[kind].nightSize])).toEqual([
      ['sconce-halo', [0, 0.22], [50, 40]],
      ['sconce-pool', [0, 0.13], [100, 54]],
      ['floor-lamp-halo', [0, 0.22], [54, 44]],
      ['floor-lamp-pool', [0, 0.38], [240, 122]],
      ['ceiling-lamp', [0, 0.22], [54, 44]],
      ['ceiling-pool', [0, 0.36], [280, 144]],
      ['glass-pool', [0, 0.11], [140, 72]],
      ['desk-screen', [0, 0.42], [88, 60]],
      ['lab-screen', [0, 0.36], [70, 50]],
    ]);
  });

  it('shares one radial texture and one room mask per floor region', () => {
    const root = new Container();
    const lights = buildLights(root);
    const masks = root.children.filter((child) => child.label?.startsWith('office-light-mask-')) as Graphics[];
    const byLabel = new Map(masks.map((mask) => [mask.label, mask]));
    expect({
      textures: new Set(lights.map((light) => light.graphic.texture)).size,
      maskLabels: masks.map((mask) => mask.label),
      kitchenIsMain: floorRegion(2.5, 12.5),
      kitchenClipped: byLabel.get('office-light-mask-main')?.containsPoint({ x: p(2.5, 12.5)[0], y: p(2.5, 12.5)[1] }),
      mainWallClipped: byLabel.get('office-light-mask-main')?.containsPoint({ x: p(0, 7, 2)[0], y: p(0, 7, 2)[1] }),
      labWallClipped: byLabel.get('office-light-mask-lab')?.containsPoint({ x: p(16, 0, 2)[0], y: p(16, 0, 2)[1] }),
    }).toEqual({
      textures: 1,
      maskLabels: ['office-light-mask-main', 'office-light-mask-lab', 'office-light-mask-review'],
      kitchenIsMain: 'main',
      kitchenClipped: true,
      mainWallClipped: true,
      labWallClipped: true,
    });
  });

  it('clips a room-edge pool at the next room and the background', () => {
    const lights = buildLights(new Container());
    const pool = lights.find((light) => light.kind === 'floor-lamp-pool' && light.room === 'review')!;
    const mask = (pool.graphic.parent as Container).mask as Graphics;
    const centre = p(19.75, 7.25);
    const intoLab = p(19.75, 6.75);
    const intoBackground = p(20.25, 7.25);
    pool.graphic.position.set(...centre);
    updateLights([pool], [], 1, 0, true);
    const rawAlphaAt = (point: readonly [number, number]) => {
      const radius = Math.hypot(
        (point[0] - centre[0]) / (pool.graphic.width / 2),
        (point[1] - centre[1]) / (pool.graphic.height / 2),
      );
      return pool.graphic.alpha * lightFalloff(radius);
    };
    const clippedAlphaAt = (point: readonly [number, number]) => mask.containsPoint({ x: point[0], y: point[1] }) ? rawAlphaAt(point) : 0;
    expect({
      centreInsideReview: mask.containsPoint({ x: centre[0], y: centre[1] }),
      rawPoolReachesBothSamples: rawAlphaAt(intoLab) > 0 && rawAlphaAt(intoBackground) > 0,
      otherRoomAlpha: clippedAlphaAt(intoLab),
      backgroundAlpha: clippedAlphaAt(intoBackground),
    }).toEqual({ centreInsideReview: true, rawPoolReachesBothSamples: true, otherRoomAlpha: 0, backgroundAlpha: 0 });
  });

  it('keeps every floor-lamp and ceiling-lamp pool inside the mask of the room it lights', () => {
    const pools = buildLights(new Container()).filter((light) => light.kind === 'floor-lamp-pool' || light.kind === 'ceiling-pool');
    expect(pools.map((light) => {
      const mask = (light.graphic.parent as Container).mask as Graphics;
      const { x, y } = light.graphic.position;
      return [light.kind, light.room, mask.label === `office-light-mask-${light.room}`, mask.containsPoint({ x, y })];
    })).toEqual([
      ['floor-lamp-pool', 'main', true, true], ['floor-lamp-pool', 'review', true, true], ['floor-lamp-pool', 'review', true, true],
      ['ceiling-pool', 'main', true, true], ['ceiling-pool', 'main', true, true], ['ceiling-pool', 'main', true, true],
      ['ceiling-pool', 'main', true, true], ['ceiling-pool', 'lab', true, true], ['ceiling-pool', 'review', true, true],
    ]);
  });

  it('clips the moved review-room lamp pool at the review mask', () => {
    const lights = buildLights(new Container());
    const reviewPoolCount = lights.filter((light) => light.kind === 'floor-lamp-pool' && light.room === 'review').length;
    expect(reviewPoolCount).toBe(2);
    const movedLampPool = lights.filter((light) => light.kind === 'floor-lamp-pool' && light.room === 'review')[1]!;
    const mask = (movedLampPool.graphic.parent as Container).mask as Graphics;
    const centre = p(19.75, 12.25);
    movedLampPool.graphic.position.set(...centre);
    expect(mask.containsPoint({ x: centre[0], y: centre[1] })).toBe(true);
  });

  it('keeps most of the meeting lamp and table pendant pools on their own room floor, off the table, and every other pool in place', () => {
    const lights = buildLights(new Container());
    updateLights(lights, [], 1, 0, true);
    const pools = lights.filter((light) => light.kind === 'floor-lamp-pool' || light.kind === 'ceiling-pool');
    const table = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
    const onTable = (x: number, y: number) => {
      const a = (x - 696) / 48;
      const b = (y - 216) / 24;
      const i = (a + b) / 2;
      const j = (b - a) / 2;
      return i >= table.i && i <= table.i + table.w && j >= table.j && j <= table.j + table.d;
    };
    // The light-weighted share of a pool, sampled on a grid over its ellipse, that its room mask keeps and that falls on the table.
    const shares = (light: (typeof pools)[number]) => {
      const mask = (light.graphic.parent as Container).mask as Graphics;
      const { x, y } = light.graphic.position;
      let total = 0; let kept = 0; let table = 0;
      for (let a = 0; a < 60; a++) for (let b = 0; b < 60; b++) {
        const u = (a + 0.5) / 30 - 1; const v = (b + 0.5) / 30 - 1;
        const weight = lightFalloff(Math.hypot(u, v));
        if (weight === 0) continue;
        const point = { x: x + (u * light.graphic.width) / 2, y: y + (v * light.graphic.height) / 2 };
        total += weight;
        if (!mask.containsPoint(point)) continue;
        kept += weight;
        if (onTable(point.x, point.y)) table += weight;
      }
      return { kept: kept / total, table: table / total };
    };
    const at = (i: number, j: number) => p(i, j).map(Math.round);
    const centre = (light: (typeof pools)[number]) => [Math.round(light.graphic.position.x), Math.round(light.graphic.position.y)];
    const meetingLamp = pools.find((light) => light.kind === 'floor-lamp-pool' && light.room === 'review')!;
    const pendant = pools.find((light) => light.kind === 'ceiling-pool' && light.room === 'review')!;
    const lamp = shares(meetingLamp);
    const pendantShares = shares(pendant);
    expect({
      meetingLampKept: lamp.kept > 0.97,
      pendantKept: pendantShares.kept > 0.97,
      pendantOffTable: pendantShares.table < 0.25,
      centres: pools.map(centre),
    }).toEqual({
      meetingLampKept: true,
      pendantKept: true,
      pendantOffTable: true,
      // The kitchen lamp and the meeting room's corner lamp, and every pendant but the table's, are unchanged.
      centres: [
        at(1.8, 10.8), at(18.2, 8.4), at(19.1, 13.1),
        ...CEILING_LIGHTS.map((fixture) => fixture.i === 16.0 ? at(table.i - 0.7, fixture.j) : at(fixture.i, fixture.j)),
      ],
    });
  });

  it('lights a seated desk screen while working or verifying', () => {
    expect([
      screenGlow('desk-screen', 'working', true, false, 0, 0, true),
      screenGlow('desk-screen', 'verifying', true, false, 1, 0, true),
    ]).toEqual([{ color: 0x8fc4ff, alpha: 0 }, { color: 0x8fc4ff, alpha: 0.42 }]);
  });

  it('draws no light of any kind at night share 0 (day)', () => {
    const kinds = Object.keys(LIGHT_PROFILES) as LightKind[];
    expect(kinds.filter((kind) => lightAlpha(kind, 0) !== 0)).toEqual([]);
  });

  it("reaches each kind's unchanged night alpha at night share 1", () => {
    const kinds = Object.keys(LIGHT_PROFILES) as LightKind[];
    expect(kinds.filter((kind) => lightAlpha(kind, 1) !== LIGHT_PROFILES[kind].nightAlpha)).toEqual([]);
  });

  it('fades every kind in between off and its night alpha at night share 0.5', () => {
    const kinds = Object.keys(LIGHT_PROFILES) as LightKind[];
    expect(kinds.filter((kind) => !(lightAlpha(kind, 0.5) > 0 && lightAlpha(kind, 0.5) < LIGHT_PROFILES[kind].nightAlpha))).toEqual([]);
  });

  it('gives a working seated desk screen alpha 0 (not null) by day and its night glow at night share 1', () => {
    expect([screenGlow('desk-screen', 'working', true, false, 0, 0, true)?.alpha, screenGlow('desk-screen', 'working', true, false, 1, 0, true)?.alpha])
      .toEqual([0, 0.42]);
  });

  it('keeps an empty desk screen null by day and at night', () => {
    expect([screenGlow('desk-screen', null, false, false, 0, 0, true), screenGlow('desk-screen', null, false, false, 1, 0, true)]).toEqual([null, null]);
  });

  it('leaves every built light at alpha 0 by day while three seated agents work', () => {
    const lights = buildLights(new Container());
    updateLights(lights, [seatedAt('desk-1', 'working'), seatedAt('desk-2', 'working'), seatedAt('qa-1', 'verifying')], 0, 0, false);
    expect(lights.filter((light) => light.graphic.alpha !== 0).map((light) => light.kind)).toEqual([]);
  });

  it('keeps a desk screen dark for an idle agent', () => {
    expect(screenGlow('desk-screen', 'walking_in', true, false, 0, 0, true)).toBeNull();
  });

  it('keeps an unoccupied desk screen dark', () => {
    expect(screenGlow('desk-screen', null, false, false, 1, 0, true)).toBeNull();
  });

  it('keeps a QA desk screen dark when no agent is seated there', () => {
    expect(screenGlow('lab-screen', null, false, false, 1, 0, true)).toBeNull();
  });

  it.each([
    ['desk-1', 'desk-screen', 'furniture/monitor-back-lit'],
    ['desk-2', 'desk-screen', 'furniture/monitor-front-lit'],
    ['qa-1', 'lab-screen', 'furniture/qa-desk-lit'],
  ] as const)('turns the %s screen overlay and glow on only after its working agent arrives', (spotId, kind, asset) => {
    const lights = buildLights(new Container());
    const light = lights.find((candidate) => candidate.kind === kind && candidate.spotIds?.includes(spotId))!;
    const overlay = furnitureSpritePlacements().flatMap((candidate) => candidate.overlays ?? []).find((candidate) => candidate.spotIds?.includes(spotId))!;
    const read = (pose: Agent['pose']) => {
      const agent = seatedAt(spotId, 'working', pose);
      updateLights(lights, [agent], 1, 0, true);
      return { overlay: overlayAlpha(overlay.mode, overlay.spotIds, [agent], 1), glow: light.graphic.alpha };
    };
    expect({ asset: overlay.asset, walkingIn: read('walking'), arrived: read('arrived') }).toEqual({
      asset,
      walkingIn: { overlay: 0, glow: 0 },
      arrived: { overlay: SCREEN_OVERLAY_ALPHA, glow: LIGHT_PROFILES[kind].nightAlpha },
    });
  });

  it('keeps a front-row screen glow off while its seat is empty, its sitter walks there or leaves, or stands elsewhere', () => {
    const lights = buildLights(new Container());
    const light = lights.find((candidate) => candidate.kind === 'desk-screen' && candidate.spotIds?.includes('desk-2'))!;
    const read = (agents: Agent[]) => { updateLights(lights, agents, 1, 0, true); return light.graphic.alpha; };
    const elsewhere = { ...seatedAt('desk-2', 'working'), position: { x: 9, y: 9 } };
    expect([read([]), read([seatedAt('desk-2', 'working', 'walking')]), read([seatedAt('desk-2', 'working', 'leaving')]), read([elsewhere])])
      .toEqual([0, 0, 0, 0]);
  });

  it('builds one lab-screen light per QA desk, for its own seat', () => {
    expect(buildLights(new Container()).filter((light) => light.kind === 'lab-screen').map((light) => light.spotIds)).toEqual([['qa-1'], ['qa-2']]);
  });

  it('lights a QA desk screen while its own seat works or verifies, and not otherwise', () => {
    const lights = buildLights(new Container());
    const qa = lights.find((light) => light.kind === 'lab-screen' && light.spotIds?.includes('qa-1'))!;
    const alphas = qaCases.map(([name, agents]) => {
      updateLights(lights, agents, 1, 0, true);
      return [name, qa.graphic.alpha];
    });
    expect(alphas).toEqual([['empty', 0], ['idle', 0], ['working', 0.36], ['verifying', 0.36], ['other seat', 0]]);
  });

  it('shows the QA desk screen overlay while its own seat works or verifies, and not otherwise', () => {
    const desk = furnitureSpritePlacements().find((placement) => placement.asset === 'furniture/qa-desk' && placement.spotId === 'qa-1')!;
    const screen = desk.overlays!.find((overlay) => overlay.asset === 'furniture/qa-desk-lit')!;
    expect(qaCases.map(([name, agents]) => [name, overlayAlpha(screen.mode, screen.spotIds, agents, 1)]))
      .toEqual([['empty', 0], ['idle', 0], ['working', SCREEN_OVERLAY_ALPHA], ['verifying', SCREEN_OVERLAY_ALPHA], ['other seat', 0]]);
  });

  it('aligns screen glows and ceiling lamps to their PixelLab sprite anchors', () => {
    const lights = buildLights(new Container());
    const glowAt = (spotId: string) => {
      const { x, y } = lights.find((light) => light.spotIds?.includes(spotId))!.graphic.position;
      return [x, y];
    };
    const plus = ([x, y]: readonly [number, number], [dx, dy]: readonly [number, number]) => [x + dx, y + dy];
    const [back, front, qa] = [deskOf('desk-1'), deskOf('desk-2'), deskOf('qa-1')];
    expect({
      back: glowAt('desk-1'),
      front: glowAt('desk-2'),
      orch: glowAt('orch'),
      qa: glowAt('qa-1'),
      ceiling: lights.filter((light) => light.kind === 'ceiling-lamp').map(({ graphic }) => [graphic.position.x, graphic.position.y]),
    }).toEqual({
      back: plus(p(spot('desk-1').x, back.j + 0.5, POD_TOP), SCREEN_GLOW_OFFSETS['monitor-back']),
      front: plus(p(spot('desk-2').x, front.j + 0.3, POD_TOP), SCREEN_GLOW_OFFSETS['monitor-front']),
      orch: plus(p(spot('orch').x, deskOf('orch').j + 0.5, 0.81), SCREEN_GLOW_OFFSETS['monitors-orch']),
      qa: plus(p(qa.i + qa.w, qa.j + qa.d), SCREEN_GLOW_OFFSETS['qa-desk']),
      ceiling: CEILING_LIGHTS.map(({ i, j }) => p(i, j, 2.9)),
    });
  });

  // Mean floor colours of the baked background (`room/layout2-day.png`), sampled at the tile centres of each region.
  const BAKED_FLOOR = { main: [102, 111, 131], lab: [196, 204, 212], review: [135, 120, 153] } as const;
  const channels = (color: number) => [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  const atNight = (rgb: readonly number[], grade = 0xffffff) => {
    const m = sceneColorMatrix(1);
    const g = channels(grade);
    return [rgb[0]! * g[0]! / 255 * m[0]!, rgb[1]! * g[1]! / 255 * m[6]!, rgb[2]! * g[2]! / 255 * m[12]! + m[14]! * 255];
  };

  it('grades the QA corner and meeting room floors to the main carpet at night, within 12% per channel', () => {
    const main = atNight(BAKED_FLOOR.main);
    const off = (room: 'lab' | 'review') => atNight(BAKED_FLOOR[room], FLOOR_GRADE[room]).map((value, k) => Math.abs(value / main[k]! - 1) <= 0.12);
    expect({ lab: off('lab'), review: off('review'), ungradedLabMatches: atNight(BAKED_FLOOR.lab).every((value, k) => Math.abs(value / main[k]! - 1) <= 0.12) })
      .toEqual({ lab: [true, true, true], review: [true, true, true], ungradedLabMatches: false });
  });

  it('keeps the floor grade off by day, half on at dusk and full at night, as a multiply over its own room only', () => {
    const grades = buildFloorGrade();
    const read = (n: number) => {
      updateFloorGrade(grades, n);
      return grades.map(({ room, graphic }) => [room, graphic.visible, graphic.alpha]);
    };
    const lab = grades.find((grade) => grade.room === 'lab')!.graphic;
    const review = grades.find((grade) => grade.room === 'review')!.graphic;
    const at = (i: number, j: number) => ({ x: p(i, j)[0], y: p(i, j)[1] });
    expect({
      day: read(0),
      dusk: read(0.5),
      night: read(1),
      blend: grades.map(({ graphic }) => graphic.blendMode),
      labCoversLab: lab.containsPoint(at(15.5, 3.5)),
      labCoversMain: lab.containsPoint(at(6.5, 3.5)),
      reviewCoversReview: review.containsPoint(at(15.5, 10.5)),
      reviewCoversLab: review.containsPoint(at(15.5, 3.5)),
    }).toEqual({
      day: [['lab', false, 0], ['review', false, 0]],
      dusk: [['lab', true, 0.5], ['review', true, 0.5]],
      night: [['lab', true, 1], ['review', true, 1]],
      blend: ['multiply', 'multiply'],
      labCoversLab: true,
      labCoversMain: false,
      reviewCoversReview: true,
      reviewCoversLab: false,
    });
  });

  it('gives every ceiling lamp and floor lamp one warm floor pool that lifts the night base visibly, and none by day', () => {
    const lights = buildLights(new Container());
    const pools = lights.filter((light) => light.kind === 'ceiling-pool' || light.kind === 'floor-lamp-pool');
    const warm = (color: number) => { const [r, g, b] = channels(color); return r! > g! && g! > b!; };
    updateLights(lights, [], 0, 0, true);
    const day = pools.map((light) => light.graphic.alpha);
    updateLights(lights, [], 0.5, 0, true);
    const dusk = pools.every((light) => light.graphic.alpha > 0 && light.graphic.alpha < LIGHT_PROFILES[light.kind].nightAlpha);
    updateLights(lights, [], 1, 0, true);
    // The pool's centre adds at least as much red as the whole dark base carpet holds, so it at least doubles the floor's red there.
    const lift = pools.map((light) => channels(light.graphic.tint as number)[0]! * light.graphic.alpha >= atNight(BAKED_FLOOR.main)[0]!);
    expect({
      ceiling: pools.filter((light) => light.kind === 'ceiling-pool').length,
      floor: pools.filter((light) => light.kind === 'floor-lamp-pool').length,
      warm: pools.every((light) => warm(light.graphic.tint as number)),
      day,
      dusk,
      lift: lift.every(Boolean),
    }).toEqual({
      ceiling: CEILING_LIGHTS.length,
      floor: FURN.filter((furniture) => furniture.kind === 'lamp-floor').length,
      warm: true,
      day: pools.map(() => 0),
      dusk: true,
      lift: true,
    });
  });

  it('lights no screen in an empty room at night, and only the occupied seat when one agent works', () => {
    const lights = buildLights(new Container());
    const litScreens = (agents: Agent[]) => {
      updateLights(lights, agents, 1, 0, true);
      return lights.filter((light) => (light.kind === 'desk-screen' || light.kind === 'lab-screen') && light.graphic.alpha > 0).map((light) => light.spotIds);
    };
    expect({ empty: litScreens([]), one: litScreens([seatedAt('desk-1', 'working')]) }).toEqual({ empty: [], one: [['desk-1']] });
  });

  it("keeps the orchestrator's screen glow off the question note on its screens' top edge", () => {
    const light = buildLights(new Container()).find((candidate) => candidate.spotIds?.includes('orch'))!;
    updateLights([light], [seatedAt('orch', 'working')], 1, 0, true);
    const [noteX, noteY] = QUESTION_NOTE_AT;
    // The note's centre (it is about 16 x 14 px), in the glow's normalised radius.
    const radius = Math.hypot((noteX + 8 - light.graphic.x) / (light.graphic.width / 2), (noteY + 7 - light.graphic.y) / (light.graphic.height / 2));
    expect({ lit: light.graphic.alpha > 0, onNote: light.graphic.alpha * lightFalloff(radius) < 0.05 }).toEqual({ lit: true, onNote: true });
  });
});
