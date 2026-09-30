import { describe, expect, it } from 'vitest';
import type { OfficeSession } from '@overseer/shared';
import { createAgent, leaveAgent, snapAgents, stepAgents } from '../agentManager';
import type { Agent } from '../types';
import { FLIP_FRAME_MS, FLIP_FRAMES, FLIP_SLOT_MS, flipFrame, readingFolderItems } from './readingFolders';
import { SPOTS } from './world';

const session = (id: string): OfficeSession => ({
  session_id: id, role: 'critic', harness: 'claude', model: 'fable', resolved_model: null, account_label: null,
  bead_id: 'ov-1', bead_title: 'Review', batch_id: null, repo_id: 'r1', state: 'working', stalled_since: null,
});
const MEETING = SPOTS.filter((spot) => spot.zone === 'review');
/** A reviewer walking in from the door to meeting seat `spotId`. */
const walking = (id: string, spotId: string): Agent => {
  const spot = SPOTS.find((seat) => seat.id === spotId)!;
  return createAgent(session(id), { id: spot.id, type: 'desk', x: spot.x, y: spot.y, spriteFacing: spot.f });
};
const seated = (id: string, spotId: string): Agent => snapAgents([walking(id, spotId)])[0]!;
const keys = (agents: readonly Agent[], now = 0, still = false) => readingFolderItems(agents, now, still, 0).map((entry) => entry.key);
/** The frame shown every 50 ms over `ms`. */
const frames = (id: string, ms: number, still = false) => Array.from({ length: ms / 50 }, (_, k) => flipFrame(id, k * 50, still));

describe('reviewers\' open folders', () => {
  it('lays one folder on the table per reviewer seated and arrived at a meeting seat', () => {
    const agents = MEETING.map((spot, k) => seated(`s${k}`, spot.id));
    expect(readingFolderItems(agents, 0, true, 0).map((entry) => [entry.key, 'reading' in entry.paint && entry.paint.reading]))
      .toEqual(MEETING.map((spot, k) => [`reading-s${k}`, `${spot.id}/0`]));
  });

  it('lays no folder while the reviewer walks to its seat, nor for someone seated at a pod desk', () => {
    const pod = SPOTS.find((spot) => spot.zone === 'run')!;
    const atPod = snapAgents([createAgent(session('p'), { id: pod.id, type: 'desk', x: pod.x, y: pod.y, spriteFacing: pod.f })]);
    expect([keys([walking('w', 'review-1')]), keys(stepAgents([walking('w', 'review-1')], 20)), keys(atPod)]).toEqual([[], [], []]);
  });

  it('takes the folder away as the reviewer leaves, and once it has gone', () => {
    const leaving = leaveAgent(seated('s', 'review-2'));
    expect([keys([seated('s', 'review-2')]), keys([leaving]), keys(stepAgents([leaving], 20)), keys([])]).toEqual([['reading-s'], [], [], []]);
  });

  it('turns a page through each of its three frames over time', () => {
    const seen = frames('reviewer-a', 3 * FLIP_SLOT_MS);
    expect([...new Set(seen)].sort()).toEqual([0, 1, 2, 3]);
  });

  it('turns each page in three frames of FLIP_FRAME_MS, then rests', () => {
    const seen = Array.from({ length: 3 * FLIP_SLOT_MS }, (_, ms) => flipFrame('reviewer-a', ms, false));
    const start = seen.indexOf(1);
    expect(seen.slice(start, start + FLIP_FRAMES * FLIP_FRAME_MS + 1)).toEqual([
      ...Array(FLIP_FRAME_MS).fill(1), ...Array(FLIP_FRAME_MS).fill(2), ...Array(FLIP_FRAME_MS).fill(3), 0,
    ]);
  });

  it('keeps the folder open and still under reduced motion and on frozen frames', () => {
    // The scene passes `frozen || reduced` as `still`.
    expect(new Set(frames('reviewer-a', 3 * FLIP_SLOT_MS, true))).toEqual(new Set([0]));
  });

  it('does not turn two readers\' pages in sync', () => {
    const starts = (id: string) => frames(id, 10 * FLIP_SLOT_MS).flatMap((frame, k, all) => (frame === 1 && all[k - 1] !== 1 ? [k * 50] : []));
    const [a, b, c, d] = ['s0', 's1', 's2', 's3'].map(starts);
    // Every reader turns about once per slot; no two share a start, and a reader's gaps vary.
    const gaps = a!.slice(1).map((at, k) => at - a![k]!);
    expect([
      [a, b, c, d].every((list) => list!.length >= 9),
      [a, b, c, d].some((list, k) => [a, b, c, d].some((other, m) => m !== k && list!.some((at) => other!.includes(at)))),
      new Set(gaps).size > 1,
    ]).toEqual([true, false, true]);
  });
});
