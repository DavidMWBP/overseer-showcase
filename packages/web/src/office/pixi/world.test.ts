import { describe, expect, it } from 'vitest';
import {
  BLOCK, BOARD_SPOT, CELL, CELLS_I, cellOf, dirFromDelta, DIVIDER_D, edgeOpen, ENTRY, footprints, FURN, GLASS_CLEARANCE,
  GLASS_POSTS, H, pathBetween, p, POD_D, SPOTS, stepOK, stepToward, W, WORLD_HEIGHT, WORLD_WIDTH,
  type Footprint, type WorldPosition,
} from './world';
import { WINDOWS } from './room';
import { BOARD_AT, BOARD_W } from './roomProps';
import { HIT_AREA } from './characters';
import { initialOfficeViewport } from './viewport';

/** Walk a route at the sim's 0.05 tiles per frame and return every walk cell the feet pass through, in order. */
function walkCells(from: WorldPosition, to: WorldPosition): [number, number][] {
  let position = { ...from };
  const cells = [cellOf(position)];
  for (const waypoint of pathBetween(from, to)) {
    for (let frame = 0; frame < 10_000; frame++) {
      const step = stepToward(position, waypoint, 0.05);
      position = step.position;
      const cell = cellOf(position);
      const last = cells.at(-1)!;
      if (cell[0] !== last[0] || cell[1] !== last[1]) cells.push(cell);
      if (step.arrived) break;
    }
  }
  return cells;
}

/** True when every move between consecutive cells is one legal grid step and the walk ends in the target's cell. */
function walkable(from: WorldPosition, to: WorldPosition): boolean {
  const cells = walkCells(from, to);
  const [ti, tj] = cellOf(to);
  return cells.at(-1)![0] === ti && cells.at(-1)![1] === tj && cells.every((cell, k) => {
    if (k === 0) return true;
    const [a, b] = cells[k - 1]!;
    return Math.abs(cell[0] - a) <= 1 && Math.abs(cell[1] - b) <= 1 && stepOK(a, b, cell[0], cell[1]);
  });
}

const inside = (spot: WorldPosition, { i, j, w, d }: Footprint) => spot.x > i && spot.x < i + w && spot.y > j && spot.y < j + d;
const seatZones = ['run', 'orch', 'lab', 'review'] as const;
const round2 = (value: number) => Math.round(value * 100) / 100;

describe('Pixi office world', () => {
  it('projects the four floor corners', () => {
    expect({
      size: [WORLD_WIDTH, WORLD_HEIGHT],
      corners: [[0, 0], [W, 0], [W, H], [0, H]].map(([i, j]) => p(i!, j!)),
    }).toEqual({ size: [1680, 1056], corners: [[696, 216], [1656, 696], [984, 1032], [24, 552]] });
  });

  it('has 12 worker seats, the orchestrator seat, 2 QA seats and 4 meeting seats', () => {
    expect(Object.fromEntries(seatZones.map((zone) => [zone, SPOTS.filter((spot) => spot.zone === zone).length])))
      .toEqual({ run: 12, orch: 1, lab: 2, review: 4 });
  });

  it('places and faces every seat as the layout 2 board does', () => {
    expect(SPOTS.filter((spot) => seatZones.some((zone) => zone === spot.zone)).map(({ id, x, y, f }) => [id, round2(x), round2(y), f])).toEqual([
      ['desk-1', 3.92, 2.58, 'front-left'], ['desk-2', 3.92, 4.86, 'rear-right'],
      ['desk-3', 5.42, 2.58, 'front-left'], ['desk-4', 5.42, 4.86, 'rear-right'],
      ['desk-5', 7.42, 2.58, 'front-left'], ['desk-6', 7.42, 4.86, 'rear-right'],
      ['desk-7', 8.92, 2.58, 'front-left'], ['desk-8', 8.92, 4.86, 'rear-right'],
      ['desk-9', 4.72, 6.98, 'front-left'], ['desk-10', 4.72, 9.26, 'rear-right'],
      ['desk-11', 6.22, 6.98, 'front-left'], ['desk-12', 6.22, 9.26, 'rear-right'],
      ['orch', 8.7, 10.45, 'front-left'],
      ['qa-1', 13.61, 2.95, 'rear-left'], ['qa-2', 17.01, 2.95, 'rear-left'],
      ['review-1', 14.85, 8.85, 'front-right'], ['review-2', 16.82, 8.85, 'rear-left'],
      ['review-3', 14.85, 10.4, 'front-right'], ['review-4', 16.82, 10.4, 'rear-left'],
    ]);
  });

  it('sits every pod sitter at the middle of its desk, facing it across the desk edge', () => {
    const pods = SPOTS.filter((spot) => spot.zone === 'run').map((spot) => {
      const desk = FURN.find((furniture) => furniture.i === spot.desk?.[0] && furniture.j === spot.desk[1])!;
      const facesDesk = desk.kind === 'pod-desk-front' ? spot.f === 'front-left' && spot.y < desk.j : spot.f === 'rear-right' && spot.y > desk.j + desk.d;
      return [spot.id, desk.kind, round2(spot.x - desk.i), facesDesk];
    });
    expect(pods).toEqual(SPOTS.filter((spot) => spot.zone === 'run').map((spot, k) => [spot.id, k % 2 ? 'pod-desk-rear' : 'pod-desk-front', 0.72, true]));
  });

  it('puts the front row behind the back row across a divider joint', () => {
    const back = FURN.filter((furniture) => furniture.kind === 'pod-desk-front');
    const front = FURN.filter((furniture) => furniture.kind === 'pod-desk-rear');
    expect(front.map(({ i, j }) => [i, round2(j)])).toEqual(back.map(({ i, j }) => [i, round2(j + POD_D + DIVIDER_D)]));
  });

  it('keeps every spot out of every furniture footprint and the glass', () => {
    const obstacles = [...FURN.flatMap(footprints), ...GLASS_POSTS, ...GLASS_CLEARANCE];
    expect([...SPOTS, BOARD_SPOT, { id: 'entry', ...ENTRY }].filter((spot) => obstacles.some((obstacle) => inside(spot, obstacle))).map(({ id }) => id)).toEqual([]);
  });

  it('places every spot on a walkable cell', () => {
    expect([...SPOTS, BOARD_SPOT].filter((spot) => BLOCK.has(cellOf(spot).join(','))).map(({ id }) => id)).toEqual([]);
  });

  it('walks from the entry to every seat and standing spot and back through free cells only', () => {
    expect([...SPOTS, BOARD_SPOT].filter((spot) => !walkable(ENTRY, spot) || !walkable(spot, ENTRY)).map(({ id }) => id)).toEqual([]);
  });

  it('walks from every seat to the board for a passed verification', () => {
    expect(SPOTS.filter((spot) => spot.atDesk && !walkable(spot, BOARD_SPOT)).map(({ id }) => id)).toEqual([]);
  });

  it('routes QA traffic through the i = 12 glass door at j 6–8', () => {
    const qa = SPOTS.find(({ id }) => id === 'qa-1')!;
    const cells = walkCells(ENTRY, qa);
    const crossings = cells.slice(1).flatMap((cell, k) => {
      const [a, b] = cells[k]!;
      return Math.min(a, cell[0]) === 12 / CELL - 1 && Math.max(a, cell[0]) === 12 / CELL ? [b * CELL, cell[1] * CELL] : [];
    });
    expect({ crosses: crossings.length > 0, withinDoor: crossings.every((j) => j >= 6 && j < 8) }).toEqual({ crosses: true, withinDoor: true });
  });

  it('refuses a step across the i = 12 glass beside the door and allows one inside it', () => {
    const a = 12 / CELL - 1;
    expect([edgeOpen(a, 8 / CELL, a + 1, 8 / CELL), edgeOpen(a, 6 / CELL - 1, a + 1, 6 / CELL - 1), edgeOpen(a, 7 / CELL, a + 1, 7 / CELL)]).toEqual([false, false, true]);
  });

  it('opens the j = 7 line only between the i = 12 glass and the meeting-room glass at i = 14', () => {
    const open = Array.from({ length: CELLS_I }, (_, a) => a).filter((a) => a >= 12 / CELL && edgeOpen(a, 7 / CELL - 1, a, 7 / CELL));
    expect([open[0]! * CELL, (open.at(-1)! + 1) * CELL, open.length]).toEqual([12, 14, 2 / CELL]);
  });

  it('does not allow a diagonal through a blocked corner', () => {
    // Cell (12, 12) is the first pod desk's back corner; (11, 12) and (12, 11) are free floor beside it.
    expect([BLOCK.has('12,12'), BLOCK.has('11,12'), BLOCK.has('12,11'), stepOK(11, 12, 12, 11)]).toEqual([true, false, false, false]);
  });

  it('lets a start inside blocked furniture leave its cell', () => {
    expect(pathBetween({ x: 3.9, y: 3.1 }, { x: 2.6, y: 2.6 })).toEqual([{ x: 3.875, y: 2.875 }, { x: 2.875, y: 2.875 }, { x: 2.6, y: 2.6 }]);
  });

  it('returns the exact target when no route can reach it', () => {
    const target = { x: 3.9, y: 3.4 };
    expect(pathBetween(ENTRY, target)).toEqual([target]);
  });

  it('keeps only the turning points of a straight run', () => {
    expect(pathBetween({ x: 10.1, y: 5.9 }, { x: 10.1, y: 1.9 })).toEqual([{ x: 10.1, y: 1.9 }]);
  });

  it('keeps the blocked spots by the left windows, facing them', () => {
    const windowJ = WINDOWS.slice(0, 2).flatMap((pane) => pane.map(([x]) => (p(0, 0)[0] - x) / 48));
    const [from, to] = [Math.min(...windowJ), Math.max(...windowJ)];
    expect(SPOTS.filter((spot) => spot.zone === 'blocked').map(({ id, x, y, f }) => [id, x <= 1, y > from && y < to, f])).toEqual([
      ['blocked-1', true, true, 'rear-left'], ['blocked-2', true, true, 'rear-left'],
    ]);
  });

  it('makes coffee, fridge and sofa the errand spots, each beside its piece', () => {
    const gap = (spot: WorldPosition, { i, j, w, d }: Footprint) => Math.hypot(Math.max(i - spot.x, 0, spot.x - i - w), Math.max(j - spot.y, 0, spot.y - j - d));
    expect(SPOTS.filter((spot) => spot.zone === 'errand').map((spot) => {
      const nearest = [...FURN].sort((a, b) => gap(spot, a) - gap(spot, b))[0]!;
      return [spot.id, nearest.kind, gap(spot, nearest) < 0.75];
    })).toEqual([['coffee', 'kitchen-counter', true], ['fridge', 'fridge', true], ['sofa', 'sofa', true]]);
  });

  it('keeps no lab bench, coffee counter, printer or water cooler in FURN', () => {
    expect([...new Set(FURN.map((furniture) => furniture.kind))].sort()).toEqual([
      'coffee-table', 'desk-orch', 'fridge', 'kitchen-counter', 'lamp-floor', 'meeting-table', 'plant-monstera', 'plant-snake',
      'pod-desk-front', 'pod-desk-rear', 'qa-desk', 'sofa',
    ]);
  });

  it('blocks only the two wings of an L-shaped QA desk, leaving its seat the notch', () => {
    const qa = FURN.find((furniture) => furniture.kind === 'qa-desk')!;
    const seat = SPOTS.find((spot) => spot.id === 'qa-1')!;
    expect({ wings: footprints(qa).length, seatInBox: inside(seat, qa), seatInWing: footprints(qa).some((wing) => inside(seat, wing)) })
      .toEqual({ wings: 2, seatInBox: true, seatInWing: false });
  });

  it('steps at 0.05 tiles per frame', () => {
    const step = stepToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 0.05);
    expect([Number(step.position.x.toFixed(4)), Number(step.position.y.toFixed(4)), step.arrived]).toEqual([0.03, 0.04, false]);
  });

  it('faces each of the four screen quadrants', () => {
    expect([[0, 1], [1, 0], [-1, 0], [0, -1]].map(([di, dj]) => dirFromDelta(di!, dj!))).toEqual([
      'front-left', 'front-right', 'rear-left', 'rear-right',
    ]);
  });

  it('keeps the current front or rear when the front/rear component is zero or float noise', () => {
    // (+i, −j) straight across the screen: di + dj is 0 or ±4.44e-16, di − dj is clearly positive (right).
    const deltas: [number, number][] = [[0.035, -0.035], [0.035 + 4.44e-16, -0.035], [0.035 - 4.44e-16, -0.035]];
    expect((['front-left', 'rear-left'] as const).map((current) => deltas.map(([di, dj]) => dirFromDelta(di, dj, current)))).toEqual([
      ['front-right', 'front-right', 'front-right'],
      ['rear-right', 'rear-right', 'rear-right'],
    ]);
  });

  it('keeps the current left or right when the left/right component is zero or float noise', () => {
    // (+i, +j) straight down the screen: di − dj is 0 or ±4.44e-16, di + dj is clearly positive (front).
    const deltas: [number, number][] = [[0.035, 0.035], [0.035 + 4.44e-16, 0.035], [0.035 - 4.44e-16, 0.035]];
    expect((['rear-left', 'rear-right'] as const).map((current) => deltas.map(([di, dj]) => dirFromDelta(di, dj, current)))).toEqual([
      ['front-left', 'front-left', 'front-left'],
      ['front-right', 'front-right', 'front-right'],
    ]);
  });

  it('turns on a clear component whatever the current facing, and keeps the old rule without one', () => {
    expect([dirFromDelta(0, 1, 'rear-right'), dirFromDelta(-1, 0, 'front-right'), dirFromDelta(0.035, -0.035)]).toEqual([
      'front-left', 'rear-left', 'rear-right',
    ]);
  });

  it('places the meeting-room corner lamp inside the review floor region', () => {
    // The lamp at (19.2, 12.2) stands in the meeting room's far corner, clear of its seats and the walk round the table.
    const cornerLamp = FURN.find((f) => f.kind === 'lamp-floor' && f.j > 11)!;
    expect([cornerLamp.i, cornerLamp.j, cornerLamp.i > 12 && cornerLamp.j >= 7]).toEqual([19.2, 12.2, true]);
  });

  it('keeps no spot inside the meeting-room corner lamp footprint', () => {
    const cornerLamp = FURN.find((f) => f.kind === 'lamp-floor' && f.j > 11)!;
    expect(SPOTS.filter((spot) => inside(spot, cornerLamp))).toEqual([]);
  });

  it('walks from the meeting-room opening at i 13, j 7.5 to every meeting seat', () => {
    const opening = { x: 13, y: 7.5 };
    expect(SPOTS.filter((spot) => spot.zone === 'review').map((spot) => [spot.id, walkable(opening, spot)])).toEqual([
      ['review-1', true], ['review-2', true], ['review-3', true], ['review-4', true],
    ]);
  });
  describe('the standing overflow row along the back walls', () => {
    const row = SPOTS.filter((spot) => spot.zone === 'row');
    const dist = (a: WorldPosition, b: WorldPosition) => Math.hypot(a.x - b.x, a.y - b.y);

    it('has 20 spots in the back corner, in rows 0.7 and 1.4 off the j = 0 wall facing +j or 0.7 to 2.1 off the i = 0 wall facing +i', () => {
      expect([row.length, row.map(({ id }) => id), row.every((spot) => ([0.7, 1.4].includes(round2(spot.y)) && spot.x > 3 && spot.f === 'front-left')
        || ([0.7, 1.4, 2.1].includes(round2(spot.x)) && spot.y > 2.5 && spot.f === 'front-right'))])
        .toEqual([20, Array.from({ length: 20 }, (_, k) => `row-${k + 1}`), true]);
    });

    it('fills each row from its far end towards the corner, outer rows first', () => {
      const at = (id: string) => { const spot = row.find((s) => s.id === id)!; return [round2(spot.x), round2(spot.y)]; };
      expect(['row-1', 'row-3', 'row-4', 'row-6', 'row-7', 'row-10', 'row-11', 'row-14', 'row-15', 'row-20'].map(at)).toEqual([
        [5.3, 0.7], [3.9, 0.7], [0.7, 5.6], [0.7, 4.2], [1.4, 5.6], [1.4, 3.5], [5.3, 1.4], [3.2, 1.4], [2.1, 6.3], [2.1, 2.8],
      ]);
    });

    it('shows every row character whole, head included, in the initial view of a 1440 x 900 and a 1920 x 1080 screen', () => {
      // The stage boxes Office measured at 1440 x 900 (1060 x 666) and 1920 x 1080 (1347 x 846), at device pixel ratio 1 and 2.
      const cut = ([[1060, 666, 1], [1060, 666, 2], [1347, 846, 1]] as const).flatMap(([width, height, dpr]) => {
        const view = initialOfficeViewport(width, height, dpr);
        return row.filter((spot) => {
          const [x, y] = p(spot.x, spot.y);
          const left = view.x + (x + HIT_AREA.x) * view.scale;
          const top = view.y + (y + HIT_AREA.y) * view.scale;
          return left < 0 || top < 0 || left + HIT_AREA.width * view.scale > width || top + HIT_AREA.height * view.scale > height;
        }).map(({ id }) => `${width}x${height}@${dpr} ${id}`);
      });
      expect(cut).toEqual([]);
    });

    it('stands no two row spots closer than 0.7 tiles', () => {
      const closest = Math.min(...row.flatMap((a, k) => row.slice(k + 1).map((b) => dist(a, b))));
      expect(round2(closest)).toBe(0.7);
    });

    it('keeps every row spot walkable, outside every furniture footprint and reachable from the entry and back', () => {
      const obstacles = [...FURN.flatMap(footprints), ...GLASS_POSTS, ...GLASS_CLEARANCE];
      expect(row.filter((spot) => BLOCK.has(cellOf(spot).join(',')) || obstacles.some((obstacle) => inside(spot, obstacle))
        || !walkable(ENTRY, spot) || !walkable(spot, ENTRY)).map(({ id }) => id)).toEqual([]);
    });

    it('keeps the row clear of the door, the whiteboard and the blocked spots', () => {
      const boardFrom = (BOARD_AT[0] - p(0, 0)[0]) / 48;
      const blockedSpots = SPOTS.filter((spot) => spot.zone === 'blocked');
      expect({
        door: round2(Math.min(...row.map((spot) => dist(spot, ENTRY)))) >= 4,
        board: row.filter((spot) => spot.y < 1 && spot.x > boardFrom - 0.5 && spot.x < boardFrom + BOARD_W / 48 + 0.5).map(({ id }) => id),
        blocked: round2(Math.min(...row.flatMap((spot) => blockedSpots.map((other) => dist(spot, other))))) >= 0.7,
      }).toEqual({ door: true, board: [], blocked: true });
    });

    it('keeps the row off every walk from the entry to a seat and to the board', () => {
      const rowCells = new Set(row.map((spot) => cellOf(spot).join(',')));
      const crossed = [...SPOTS.filter((spot) => spot.atDesk), BOARD_SPOT]
        .filter((spot) => walkCells(ENTRY, spot).some((cell) => rowCells.has(cell.join(','))))
        .map(({ id }) => id);
      expect(crossed).toEqual([]);
    });
  });
});
