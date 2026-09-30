import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Graphics, Sprite, Texture } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { chairAt, chairPoint, depthZ, footprintDepth, furnitureDisplay, GLASS_H, furniturePieces, furnitureSpritePlacements, positionFurnitureSprite, QA_SCREEN } from './furniture';
import { floorColors, roomShapes, WINDOWS } from './room';
import { DIVIDER_D, FURN, p, POD_D, POD_TOP, POD_W, SPOTS } from './world';
import { loadOfficeTextures, OFFICE_TEXTURE_KEYS, officeTextureUrl } from './assets';
import type { Shape } from './draw';

const pieces = furniturePieces();
const piece = (id: string) => pieces.find((candidate) => candidate.id === id)!;
const placements = new Map(furnitureSpritePlacements().map((placement) => [placement.id, placement]));
const fills = (shapes: Shape[]) => shapes.flatMap((shape) => shape.kind === 'poly' ? [shape.fill] : []);
const furnId = (kind: string, nth = 0) => `${kind}-${FURN.map((furniture, index) => [furniture.kind, index] as const).filter(([candidate]) => candidate === kind)[nth]![1]}`;
const seats = SPOTS.filter((spot) => spot.atDesk);

describe('Pixi room', () => {
  it('colours the floor regions, with the wood under the kitchen and lounge and carpet at the old break area', () => {
    expect([floorColors(3.5, 3.5), floorColors(15.5, 3.5), floorColors(15.5, 10.5), floorColors(2.5, 12.5), floorColors(8.5, 12.5)]).toEqual([
      ['#646d80', '#5f687b'], ['#c7ced6', '#bcc4cd'], ['#857696', '#7d6f8f'], ['#a67c52', '#9b724a'], ['#646d80', '#5f687b'],
    ]);
  });

  it('draws a 20 x 14 checkered floor before the walls', () => {
    expect(roomShapes().slice(0, 280).every((shape) => shape.kind === 'poly' && shape.strokeAlpha === 0.12)).toBe(true);
  });

  it('puts the right-wall window at i 2–6, z 1.3–3.3', () => {
    expect(WINDOWS[2]).toEqual([p(2, 0, 1.3), p(6, 0, 1.3), p(6, 0, 3.3), p(2, 0, 3.3)]);
  });

  it('leaves the QA corner wall plain but for its sconce, since the kanban whiteboard is the room\'s one board', () => {
    const labWall = roomShapes().slice(280).filter((shape) => shape.kind === 'poly' && shape.pts.every(([x]) => x >= p(12, 0)[0]));
    expect(fills(labWall)).toEqual(['#d3d8dc', '#e9d9a8']);
  });
});

describe('Pixi furniture', () => {
  it('sorts a pod desk by its footprint centre', () => {
    expect(piece(furnId('pod-desk-front')).depth).toBe(3.2 + POD_W / 2 + 3.0 + POD_D / 2);
  });

  it('sorts the kitchen counter by its back corner, before anyone in the kitchen', () => {
    const counter = piece(furnId('kitchen-counter'));
    const kitchen = SPOTS.filter((spot) => spot.id === 'coffee' || spot.id === 'fridge');
    expect([counter.depth, kitchen.every((spot) => counter.depth < spot.x + spot.y)]).toEqual([0.05 + 9.3, true]);
  });

  it('keys an i=12 glass segment at 12 + j + 0.5 and a j=7 segment at i + 7.5', () => {
    expect([piece('glass-i12-j3').depth, piece('glass-j7-i15').depth]).toEqual([15.5, 22.5]);
  });

  it('leaves the i=12 door gap at j 6–7 open', () => {
    expect(pieces.filter(({ id }) => id === 'glass-i12-j6' || id === 'glass-i12-j7')).toEqual([]);
  });

  // Lowered from 3.2 so the glass no longer streaks over the QA corner and the pod desks behind it; the baked art in
  // public/office/pixi/glass/ (compose-office-room.mjs) has to start at the same height, or the sprite floats.
  it('stands the glass and its door posts GLASS_H = 2.3 tall, matching the baked art', () => {
    const png = (key: string) => { const b = readFileSync(path.resolve(process.cwd(), `public${officeTextureUrl(key)}`)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    const at = (id: string) => [placements.get(id)!.x, placements.get(id)!.y];
    expect({
      height: GLASS_H,
      segment: [at('glass-i12-j0'), png('glass/i12-j0')],
      front: [at('glass-j7-i19'), png('glass/j7-i19')],
      post: [at('glass-post-6'), png('glass/post-i12-j6')],
    }).toEqual({ height: 2.3, segment: [[1224, 393], [48, 135]], front: [[1272, 729], [48, 135]], post: [[976, 533], [16, 119]] });
  });

  it('paints the orchestrator desk red-brown and the pod desks white', () => {
    expect([fills(piece(furnId('desk-orch')).shapes).includes('#a0584a'), fills(piece(furnId('pod-desk-rear')).shapes).includes('#eee9e0')]).toEqual([true, true]);
  });

  it('puts a chair at every desk seat and meeting seat', () => {
    expect(pieces.filter(({ id }) => id.startsWith('chair-')).map(({ spotId }) => spotId)).toEqual(seats.map((spot) => spot.id));
  });

  it('places each art chair 0.15 tile behind its seat, facing the seat’s way and mirrored for a right-facing seat', () => {
    const behind = { 'front-left': [0, -0.15], 'front-right': [-0.15, 0], 'rear-left': [0.15, 0], 'rear-right': [0, 0.15] } as const;
    expect(seats.map((spot) => {
      const chair = placements.get(`chair-${spot.id}`)!;
      return [chair.id, chair.asset, chair.flip ?? false, chair.x, chair.y];
    })).toEqual(seats.map((spot) => {
      const [x, y] = p(spot.x + behind[spot.f][0], spot.y + behind[spot.f][1]);
      const asset = spot.zone === 'orch' ? 'chair-orch' : spot.zone === 'review' && spot.f === 'front-right' ? 'chair-meeting' : spot.f.startsWith('front') ? 'chair-front' : 'chair-rear';
      return [`chair-${spot.id}`, `furniture/${asset}`, spot.f.endsWith('right'), x, y];
    }));
  });

  it('turns the meeting chairs on the camera-facing side of the table to face it, mirrored to face +i', () => {
    expect(['review-1', 'review-3'].map((id) => [placements.get(`chair-${id}`)!.asset, placements.get(`chair-${id}`)!.flip])).toEqual([
      ['furniture/chair-meeting', true], ['furniture/chair-meeting', true],
    ]);
    expect(['review-2', 'review-4', 'desk-1'].map((id) => placements.get(`chair-${id}`)!.asset)).toEqual(['furniture/chair-rear', 'furniture/chair-rear', 'furniture/chair-front']);
  });

  it('sorts a chair behind a sitter who faces the camera and in front of one whose back is to it', () => {
    const order = ['desk-1', 'desk-2', 'qa-1', 'review-1', 'review-2'].map((id) => {
      const spot = SPOTS.find((candidate) => candidate.id === id)!;
      return [id, depthZ(chairAt(spot).depth) < Math.round((spot.x + spot.y) * 100) ? 'behind' : 'in front'];
    });
    expect(order).toEqual([['desk-1', 'behind'], ['desk-2', 'in front'], ['qa-1', 'in front'], ['review-1', 'behind'], ['review-2', 'in front']]);
  });

  it('keeps each chair point and its fallback on the same depth', () => {
    expect(seats.every((spot) => chairAt(spot).depth === chairPoint(spot).x + chairPoint(spot).y && placements.get(`chair-${spot.id}`)!.depth === chairAt(spot).depth)).toBe(true);
  });

  it('draws a back-row sitter before its desk and a front-row sitter after its desk', () => {
    const [back, front] = [SPOTS.find((spot) => spot.id === 'desk-1')!, SPOTS.find((spot) => spot.id === 'desk-2')!];
    expect([back.x + back.y < piece(furnId('pod-desk-front')).depth, front.x + front.y > piece(furnId('pod-desk-rear')).depth]).toEqual([true, true]);
  });

  it('ties each pod desk and QA desk to its seat, so a stalled occupant dims it', () => {
    expect([piece(furnId('pod-desk-front')).spotId, piece(furnId('pod-desk-rear')).spotId, piece(furnId('qa-desk', 1)).spotId]).toEqual(['desk-1', 'desk-2', 'qa-2']);
  });

  it('places every FURN sprite anchor at its documented footprint point', () => {
    const actual = FURN.map((furniture, index) => {
      const placement = placements.get(`${furniture.kind}-${index}`)!;
      const anchor: [number, number] = [0, 0];
      const position: [number, number] = [0, 0];
      const textureWidth = Math.max(1, placement.anchorX * 2);
      const textureHeight = Math.max(1, placement.anchorY * 2);
      const sprite = {
        texture: { width: textureWidth, height: textureHeight },
        anchor: { set: (x: number, y: number) => { anchor[0] = x; anchor[1] = y; } },
        position: { set: (x: number, y: number) => { position[0] = x; position[1] = y; } },
      } as unknown as Sprite;
      positionFurnitureSprite(sprite, placement);
      const topLeft = [position[0] - anchor[0] * textureWidth, position[1] - anchor[1] * textureHeight];
      return [placement.id, topLeft[0]! + placement.anchorX, topLeft[1]! + placement.anchorY];
    });
    const expected = FURN.map((furniture, index) => {
      const centred = ['plant-monstera', 'plant-snake', 'lamp-floor'].includes(furniture.kind);
      const point = centred
        ? p(furniture.i + furniture.w / 2, furniture.j + furniture.d / 2)
        : p(furniture.i + furniture.w, furniture.j + furniture.d);
      return [`${furniture.kind}-${index}`, point[0], point[1]];
    });
    expect(actual).toEqual(expected);
  });

  it('stands a divider on each pod row joint at desk height, between the back and front desks', () => {
    const back = FURN.findIndex((furniture) => furniture.kind === 'pod-desk-front');
    const desk = FURN[back]!;
    const divider = placements.get(`divider-${back}`)!;
    expect({
      point: [divider.x, divider.y],
      between: piece(`pod-desk-front-${back}`).depth < divider.depth && divider.depth < piece(`pod-desk-rear-${back + 1}`).depth,
      count: [...placements.keys()].filter((id) => id.startsWith('divider-')).length,
    }).toEqual({ point: p(desk.i + POD_W, desk.j + POD_D + DIVIDER_D, POD_TOP), between: true, count: 6 });
  });

  it('leaves the j = 7 glass clear in the meeting room', () => {
    expect(pieces.some((candidate) => candidate.id === 'meeting-screen')).toBe(false);
    expect(placements.has('meeting-screen')).toBe(false);
    expect(placements.has('glass-j7-i15')).toBe(true);
    expect(placements.has('glass-j7-i16')).toBe(true);
  });

  it('hangs the QA wall screen on the right wall at i 12.9, z 1.3, sorted before every floor piece', () => {
    const screen = placements.get('qa-screen')!;
    const floor = pieces.filter((candidate) => candidate.id !== 'qa-screen');
    expect({
      at: [QA_SCREEN.i, QA_SCREEN.j, QA_SCREEN.z],
      point: [screen.x, screen.y],
      anchor: [screen.anchorX, screen.anchorY],
      states: screen.states,
      beforeFloor: floor.every((candidate) => depthZ(screen.depth) + 0.5 < depthZ(candidate.depth)),
      pieceDepth: piece('qa-screen').depth,
    }).toEqual({
      at: [12.9, 0, 1.3],
      point: p(12.9, 0, 1.3),
      anchor: [2, 57],
      states: ['on', 'running-0', 'running-1', 'running-2', 'running-3', 'pass', 'fail'].map((state) => `furniture/wall-screen-${state}`),
      beforeFloor: true,
      pieceDepth: screen.depth,
    });
  });

  it('places no printer piece or printer art', () => {
    const assets = [...placements.values()].flatMap((placement) => [placement.asset, ...(placement.states ?? []), ...(placement.overlays ?? []).map((overlay) => overlay.asset)]);
    expect([...pieces.map((candidate) => candidate.id), ...placements.keys(), ...assets, ...OFFICE_TEXTURE_KEYS].filter((name) => name.includes('printer'))).toEqual([]);
  });

  it('places no lab bench, coffee counter or water cooler art, and loads every placed file', () => {
    const assets = [...placements.values()].flatMap((placement) => [placement.asset, ...(placement.states ?? []), ...(placement.overlays ?? []).map((overlay) => overlay.asset)]);
    expect({
      removed: assets.filter((asset) => /lab-bench|furniture\/counter|water-cooler/.test(asset)),
      unloaded: [...new Set(assets)].filter((asset) => !(OFFICE_TEXTURE_KEYS as readonly string[]).includes(asset)),
    }).toEqual({ removed: [], unloaded: [] });
  });

  it('has a file on disk for every office texture key', () => {
    expect(OFFICE_TEXTURE_KEYS.filter((key) => !existsSync(path.resolve(process.cwd(), `public${officeTextureUrl(key)}`)))).toEqual([]);
  });

  it('uses Graphics only for a furniture piece whose texture load failed', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const textures = await loadOfficeTextures(async (url) => {
      if (url === officeTextureUrl('furniture/pod-desk-front')) throw new Error('missing pod-desk-front');
      return Texture.EMPTY;
    });
    warning.mockRestore();
    const pod = furnitureDisplay(piece(furnId('pod-desk-front')), textures.get('furniture/pod-desk-front'), placements.get(furnId('pod-desk-front')));
    const orchestrator = furnitureDisplay(piece(furnId('desk-orch')), textures.get('furniture/desk-orch'), placements.get(furnId('desk-orch')));
    expect([
      textures.has('furniture/pod-desk-front'), pod instanceof Graphics,
      textures.has('furniture/desk-orch'), orchestrator instanceof Sprite,
      [...textures.values()].every((texture) => texture.source.scaleMode === 'nearest'),
    ]).toEqual([false, true, true, true, true]);
  });

  it('keys furniture depth on the footprint centre', () => {
    expect(footprintDepth({ i: 1, j: 2, w: 2, d: 1 })).toBe(1 + 1 + 2 + 0.5);
  });
});
