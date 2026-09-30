import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OfficeSession } from '@overseer/shared';
import { readPng as readPngFile } from '../../test/png';
import { createAgent, snapAgents } from '../agentManager';
import { deriveScene } from '../officeModel';
import { characterPose } from './characters';
import { depthZ, furnitureSpritePlacements, type FurnitureSpritePlacement } from './furniture';
import { FURN, p, POD_TOP, SPOTS, type Facing, type WorldSpot } from './world';
import { readingFolderArt } from './readingFolders';
import { FOLDER_AT, RoomPropsAnimator } from './roomProps';

/**
 * How close a seated typist's hands come to the keyboard, measured on the real art: the typing frames from the character
 * atlas and the keyboards in the desk files, placed where `characterPose` and `furnitureSpritePlacements` put them.
 */
const ART = path.resolve(__dirname, '../../../public/office/pixi');

function readPng(file: string): ReturnType<typeof readPngFile> {
  return readPngFile(path.join(ART, file));
}

const atlas = readPng('characters.png');
const frames = (JSON.parse(readFileSync(path.join(ART, 'characters.json'), 'utf8')) as { frames: Record<string, { frame: { x: number; y: number } }> }).frames;
const CAST = [...new Set(Object.keys(frames).map((key) => key.split('/')[0]!))];
/** Frames are 48 x 87 with a bottom-centre anchor, and `createCharacter` draws the sprite 4 px below the character's point. */
const FRAME_W = 48;
const FRAME_H = 87;
const SPRITE_Y = 4;

/** A hand's length in the rear typing frames, fingertip to wrist: 5 to 8 px where the hand stands clear of the face. */
const REAR_HAND_W = 8;

/**
 * The hands: the largest 8-connected cluster of pixels that change between the two typing frames, in the forward 25
 * columns of rows 45 to 75. With its back to the camera a typist reaches forward and up to the desk top, rows 30 to 75,
 * and the hand is the forward end of the figure: every changed pixel within `REAR_HAND_W` columns of the forward-most one.
 * The largest cluster does not do there, because a raised forearm's outline can shift along its whole length and a hand
 * that moves a pixel can change fewer pixels than the hair.
 */
function typingHands(char: string, view: 'front' | 'rear'): [number, number][] {
  const [f0, f1] = [0, 1].map((n) => frames[`${char}/type/${view}/${n}`]!.frame);
  const changed = new Set<string>();
  for (let y = view === 'rear' ? 30 : 45; y < 76; y++) {
    for (let x = 0; x < 25; x++) {
      const a = atlas.rgba(f0!.x + x, f0!.y + y);
      const b = atlas.rgba(f1!.x + x, f1!.y + y);
      if ((a[3]! > 0 || b[3]! > 0) && a.some((value, k) => value !== b[k])) changed.add(`${x},${y}`);
    }
  }
  if (view === 'rear') {
    const pixels = [...changed].map((key) => key.split(',').map(Number) as [number, number]);
    const tip = Math.min(...pixels.map(([x]) => x));
    return pixels.filter(([x]) => x < tip + REAR_HAND_W);
  }
  let best: string[] = [];
  const seen = new Set<string>();
  for (const start of changed) {
    if (seen.has(start)) continue;
    const cluster = [start];
    seen.add(start);
    for (let k = 0; k < cluster.length; k++) {
      const [x, y] = cluster[k]!.split(',').map(Number) as [number, number];
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        const next = `${x + dx},${y + dy}`;
        if (changed.has(next) && !seen.has(next)) { seen.add(next); cluster.push(next); }
      }
    }
    if (cluster.length > best.length) best = cluster;
  }
  return best.map((key) => key.split(',').map(Number) as [number, number]);
}

/** The keyboard in each desk file: its dark pixels inside this box (QA desk: the keyboard on the wing its seat faces). */
const KEYBOARDS: Record<string, readonly [number, number, number, number]> = {
  'furniture/pod-desk-front': [42, 12, 80, 32],
  'furniture/pod-desk-rear': [27, 21, 65, 39],
  'furniture/qa-desk': [41, 42, 59, 51],
  'furniture/keyboard-mouse': [0, 1, 49, 25],
};
const placements = furnitureSpritePlacements();

function keyboardPixels(placement: FurnitureSpritePlacement): [number, number][] {
  const art = readPng(`${placement.asset}.png`);
  const [x0, y0, x1, y1] = KEYBOARDS[placement.asset]!;
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [r, g, b, a] = art.rgba(x, y);
      if (a! > 0 && (r! + g! + b!) / 3 < 120) out.push([Math.round(placement.x) - placement.anchorX + x, Math.round(placement.y) - placement.anchorY + y]);
    }
  }
  return out;
}

/** The step a seat's sitter faces along: the opposite of the chair's offset. */
const FORWARD: Record<Facing, readonly [number, number]> = { 'front-left': [0, 1], 'front-right': [1, 0], 'rear-left': [-1, 0], 'rear-right': [0, -1] };

const session = (id: string): OfficeSession => ({
  session_id: id, role: 'worker', harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
  bead_id: 'ov-1', bead_title: 'Typing', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null,
});
const seatedPose = (spot: WorldSpot) => {
  const [agent] = snapAgents([createAgent(session(`seat-${spot.id}`), { id: spot.id, type: 'desk', x: spot.x, y: spot.y, spriteFacing: spot.f })]);
  return characterPose(agent!, spot.f, 10_000, false);
};

/**
 * The vertical screen distance, in world pixels, from the typing hands' lowest pixels up (camera-facing) or down
 * (back to the camera) to the near edge of the keyboard, or of the meeting table's top, measured at the hands' column.
 * Positive: the hands stop short of it; 0 or less: they reach it. The worst of the nine characters.
 */
function handGap(spot: WorldSpot, edge?: (c: (point: readonly [number, number]) => number, forward: number) => number): number {
  const pose = seatedPose(spot);
  expect(pose.anim).toBe('type');
  const [fi, fj] = FORWARD[spot.f];
  // Along a constant-j edge y - x/2 is constant, along a constant-i edge y + x/2; at one column either changes as y does.
  const c = ([x, y]: readonly [number, number]) => fj !== 0 ? y - x / 2 : y + x / 2;
  const forward = fj !== 0 ? fj : fi;
  let near: number;
  if (edge) {
    near = edge(c, forward);
  } else if (spot.zone === 'review') {
    const table = FURN.find((furniture) => furniture.kind === 'meeting-table')!;
    near = c(p(fi > 0 ? table.i : table.i + table.w, 0, POD_TOP));
  } else {
    const board = placements.find((placement) => placement.spotId === spot.id && KEYBOARDS[placement.asset])!;
    const cs = keyboardPixels(board).map(c);
    near = forward > 0 ? Math.min(...cs) : Math.max(...cs);
  }
  const rootX = Math.round(pose.x);
  const rootY = Math.round(pose.y);
  return Math.max(...CAST.map((char) => {
    const hands = typingHands(char, pose.view).map(([x, y]): [number, number] => [
      pose.flip ? rootX + FRAME_W / 2 - 1 - x : rootX - FRAME_W / 2 + x,
      rootY + SPRITE_Y - FRAME_H + y,
    ]);
    const lowest = Math.max(...hands.map(([, y]) => y));
    const bottom = hands.filter(([, y]) => y === lowest);
    const handC = bottom.reduce((sum, [x, y]) => sum + c([x + 0.5, y + 0.5]), 0) / bottom.length;
    return (near - handC) * forward;
  }));
}

/**
 * The seat's typing hands against its keyboard, per character and type frame: the hands are the opaque pixels of that
 * frame inside the box around `typingHands`. `overlap` counts those on a keyboard pixel; `past` is how far, in world
 * pixels along the facing, the furthest one reaches beyond the keyboard's far edge (0 or less: not past it).
 */
function handsOnKeyboard(spot: WorldSpot): { char: string; frame: number; overlap: number; past: number }[] {
  const pose = seatedPose(spot);
  expect(pose.anim).toBe('type');
  const [fi, fj] = FORWARD[spot.f];
  const c = ([x, y]: readonly [number, number]) => fj !== 0 ? y - x / 2 : y + x / 2;
  const forward = fj !== 0 ? fj : fi;
  const board = placements.find((placement) => placement.spotId === spot.id && KEYBOARDS[placement.asset])!;
  const keys = keyboardPixels(board);
  const keySet = new Set(keys.map(([x, y]) => `${x},${y}`));
  const cs = keys.map(c);
  const far = forward > 0 ? Math.max(...cs) : Math.min(...cs);
  const rootX = Math.round(pose.x);
  const rootY = Math.round(pose.y);
  return CAST.flatMap((char) => {
    const hand = typingHands(char, pose.view);
    const [x0, x1, y0, y1] = [Math.min(...hand.map(([x]) => x)), Math.max(...hand.map(([x]) => x)), Math.min(...hand.map(([, y]) => y)), Math.max(...hand.map(([, y]) => y))];
    return [0, 1].map((frame) => {
      const at = frames[`${char}/type/${pose.view}/${frame}`]!.frame;
      const pixels: [number, number][] = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (atlas.rgba(at.x + x, at.y + y)[3]! > 0) pixels.push([pose.flip ? rootX + FRAME_W / 2 - 1 - x : rootX - FRAME_W / 2 + x, rootY + SPRITE_Y - FRAME_H + y]);
      }
      return {
        char, frame,
        overlap: pixels.filter(([x, y]) => keySet.has(`${x},${y}`)).length,
        past: Math.max(...pixels.map((pixel) => (c(pixel) - far) * forward)),
      };
    });
  });
}

/** Natural at the meeting table, which has no keyboard: every character's hands end within 6 px of the table's or the folder's near edge. */
const NATURAL_GAP = 6;
const seatsOf = (test: (spot: WorldSpot) => boolean) => SPOTS.filter((spot) => spot.atDesk && test(spot));
const deskKind = (spot: WorldSpot) => FURN.find((furniture) => furniture.i === spot.desk?.[0] && furniture.j === spot.desk[1])?.kind;
const KEYBOARD_KINDS = {
  'pod back row, facing the camera': seatsOf((spot) => deskKind(spot) === 'pod-desk-front'),
  'orchestrator desk, facing the camera': seatsOf((spot) => spot.zone === 'orch'),
  'pod front row, back to the camera': seatsOf((spot) => deskKind(spot) === 'pod-desk-rear'),
  'QA desk, back to the camera': seatsOf((spot) => spot.zone === 'lab'),
};
const TABLE_KINDS = {
  'meeting table left side, facing the camera': seatsOf((spot) => spot.zone === 'review' && spot.f === 'front-right'),
  'meeting table right side, back to the camera': seatsOf((spot) => spot.zone === 'review' && spot.f === 'rear-left'),
};
const worstGap = (spots: WorldSpot[]) => Math.max(...spots.map((spot) => handGap(spot)));

describe('Pixi seated typists', () => {
  // A rear hand moves a pixel between the frames and changes 6 to 52 pixels; the camera-facing clusters are larger.
  it('finds a keyboard and a hand cluster to measure for every character', () => {
    expect([CAST.length, CAST.every((char) => typingHands(char, 'front').length > 20 && typingHands(char, 'rear').length >= 5)]).toEqual([9, true]);
  });

  // Every character, every seat of the kind, both type frames: some hand pixel on a keyboard pixel, none past its far edge.
  for (const kind of Object.keys(KEYBOARD_KINDS) as (keyof typeof KEYBOARD_KINDS)[]) {
    it(`rests the typing hands on the keyboard at the ${kind}`, () => {
      const misses = KEYBOARD_KINDS[kind].flatMap((spot) => handsOnKeyboard(spot)
        .filter((hands) => hands.overlap === 0 || hands.past > 0)
        .map(({ char, frame, overlap, past }) => `${spot.id} ${char}/${frame} overlap=${overlap} past=${past.toFixed(1)}`));
      expect(misses).toEqual([]);
    });
  }

  for (const kind of Object.keys(TABLE_KINDS) as (keyof typeof TABLE_KINDS)[]) {
    it(`rests the typing hands at the table's near edge at the ${kind}`, () => {
      expect(worstGap(TABLE_KINDS[kind])).toBeLessThanOrEqual(NATURAL_GAP);
    });
  }

  // The reviewer's open folder lies where the typing hands land: measured to the near edge of its pages (either
  // sheet colour) in the drawn frame at rest.
  const PAGES = new Set([0xfbfdfc, 0xc6c5c7]);
  const pageEdge = (spot: WorldSpot) => (c: (point: readonly [number, number]) => number, forward: number) => {
    const art = readingFolderArt(spot.id, 0);
    const cs = art.rects.filter(([, , , , color]) => PAGES.has(color))
      .flatMap(([x, y, w]) => Array.from({ length: w }, (_, k) => c([art.x + x + k + 0.5, art.y + y + 0.5])));
    return forward > 0 ? Math.min(...cs) : Math.max(...cs);
  };
  for (const [side, facing] of [['left side, facing the camera', 'front-right'], ['right side, back to the camera', 'rear-left']] as const) {
    it(`rests a reviewer's typing hands on its open folder's pages at the meeting table ${side}`, () => {
      const seats = SPOTS.filter((spot) => spot.zone === 'review' && spot.f === facing);
      expect(Math.max(...seats.map((spot) => handGap(spot, pageEdge(spot))))).toBeLessThanOrEqual(NATURAL_GAP);
    });
  }

  it("keeps four In review folders, and the stack past four, apart from four reviewers' open folders on the meeting table", () => {
    const folder = readPng('props/folder.png');
    const taken = new Map<string, string>();
    const clashes: string[] = [];
    const mark = (owner: string, x: number, y: number) => {
      const key = `${x},${y}`;
      // The In review folders may touch one another; a reviewer's folder touches nothing else.
      const other = taken.get(key);
      if (other && other !== owner && [other, owner].some((name) => name.startsWith('reading-'))) clashes.push(`${other} ${owner} at ${key}`);
      taken.set(key, owner);
    };
    const animator = new RoomPropsAnimator();
    animator.update({ questions: 0, reviewBatches: ['r/a', 'r/b', 'r/c', 'r/d'], columns: null, reviewReady: null }, 0);
    const inReview = animator.items(0, true).filter((entry) => entry.key.startsWith('folder-'));
    // Past four the stack joins them on the centre line, its numbered note on top: it stays clear too.
    animator.update({ questions: 0, reviewBatches: ['r/a', 'r/b', 'r/c', 'r/d', 'r/e', 'r/f', 'r/g', 'r/h'], columns: null, reviewReady: null }, 1);
    const stack = animator.items(1, true).filter((entry) => entry.key.startsWith('stack-'));
    for (const entry of [...inReview, ...stack]) {
      const owner = entry.key.startsWith('folder-') ? entry.key : 'stack';
      if ('note' in entry.paint) {
        for (let y = 0; y < entry.h; y++) for (let x = 0; x < entry.w; x++) mark(owner, entry.x + x, entry.y + y);
        continue;
      }
      for (let y = 0; y < folder.height; y++) for (let x = 0; x < folder.width; x++) {
        if (folder.rgba(x, y)[3]! > 0) mark(owner, entry.x + x, entry.y + y);
      }
    }
    // The folder lying open. A page standing up mid-flip rises in front of the centre line at the right-hand seats, as a
    // page nearer the camera does; the scene draws the reviewers' folders after the In review ones at the same depth.
    for (const spot of SPOTS.filter((seat) => seat.zone === 'review')) {
      const art = readingFolderArt(spot.id, 0);
      for (const [x, y, w] of art.rects) for (let k = 0; k < w; k++) mark(`reading-${spot.id}`, art.x + x + k, art.y + y);
    }
    expect([inReview.map((entry) => [entry.x, entry.y]), clashes]).toEqual([FOLDER_AT.map(([x, y]) => [x, y]), []]);
  });

  it('draws each sitter after its chair and before its desk when facing the camera, and after its desk and before its chair with its back to it', () => {
    const depth = (id: string) => depthZ(placements.find((placement) => placement.id === id)!.depth);
    const deskOf = (spot: WorldSpot) => spot.zone === 'review'
      ? placements.find((placement) => placement.asset === 'furniture/meeting-table')!.id
      : placements.find((placement) => placement.spotId === spot.id && FURN.some((furniture) => `furniture/${furniture.kind}` === placement.asset))!.id;
    const orders = SPOTS.filter((spot) => spot.atDesk).map((spot) => {
      const sitter = seatedPose(spot).zIndex;
      const [chair, desk] = [depth(`chair-${spot.id}`), depth(deskOf(spot))];
      return [spot.id, spot.f.startsWith('front') ? chair < sitter && sitter < desk : desk < sitter && sitter < chair];
    });
    expect(orders).toEqual(SPOTS.filter((spot) => spot.atDesk).map((spot) => [spot.id, true]));
  });
});

describe('Pixi seating past the 12 pod desks', () => {
  const feedSession = (id: string, role: OfficeSession['role']): OfficeSession => ({
    session_id: id, role, harness: 'claude', model: 'sonnet', resolved_model: null, account_label: null,
    bead_id: role === 'orchestrator' ? null : `ov-${id}`, bead_title: 'Task', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null,
  });
  /** The orchestrator, 32 workers (two repositories at the worker limit of 16) and 8 critics, as the office feed names them. */
  const crowd = [
    feedSession('orch', 'orchestrator'),
    ...Array.from({ length: 32 }, (_, k) => feedSession(`w${k + 1}`, 'worker')),
    ...Array.from({ length: 8 }, (_, k) => feedSession(`c${k + 1}`, 'critic')),
  ];

  it('puts each of the orchestrator, 32 workers and 8 critics on its own spot, the fifth critic onward on the overflow path', () => {
    const agents = snapAgents(deriveScene(crowd, null).agents);
    const spotOf = new Map(agents.map((agent) => [agent.id, agent.assignedSpotId]));
    expect({
      distinct: new Set(agents.map((agent) => agent.assignedSpotId)).size,
      orch: spotOf.get('orch'),
      critics: Array.from({ length: 8 }, (_, k) => spotOf.get(`c${k + 1}`)),
      atSpot: agents.every((agent) => { const spot = SPOTS.find((s) => s.id === agent.assignedSpotId)!; return agent.position.x === spot.x && agent.position.y === spot.y; }),
    }).toEqual({
      distinct: 41,
      orch: 'orch',
      critics: ['review-1', 'review-2', 'review-3', 'review-4', 'row-16', 'row-17', 'row-18', 'row-19'],
      atSpot: true,
    });
  });

  it('types at a QA desk, and stands while working at an errand or row spot', () => {
    const agents = snapAgents(deriveScene(crowd.slice(0, 1 + 18), null).agents);
    const anims = agents.filter((agent) => ['qa-1', 'coffee', 'sofa', 'row-1'].includes(agent.assignedSpotId))
      .map((agent) => [agent.assignedSpotId, characterPose(agent, agent.spriteFacing, 1000, false).anim]);
    expect(anims).toEqual([['qa-1', 'type'], ['coffee', 'idle'], ['sofa', 'idle'], ['row-1', 'idle']]);
  });
});
