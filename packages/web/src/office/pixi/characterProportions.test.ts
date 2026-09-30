import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPng } from '../../test/png';

/**
 * A seated typist sits as tall with its back to the camera (`type/rear`) as facing it (`type/front`): measured on the
 * atlas, the rear typing frame's torso (shoulder row to hip row), head-top-to-hip height and hip row are each within
 * `TOLERANCE` px of the front typing frame's. The rear pair was once drawn hunched, 6 to 11 px shorter than the front.
 */
const ART = path.resolve(__dirname, '../../../public/office/pixi');
const atlas = readPng(path.join(ART, 'characters.png'));
const frames = (JSON.parse(readFileSync(path.join(ART, 'characters.json'), 'utf8')) as { frames: Record<string, { frame: { x: number; y: number } }> }).frames;
const CAST = [...new Set(Object.keys(frames).map((key) => key.split('/')[0]!))];
const FRAME_W = 48;
const FRAME_H = 87;
const TOLERANCE = 2;

/**
 * Each character's top garment and trousers, lit and shaded tones from its frames. The shoulder row is the first row of
 * the top garment behind the figure's middle, the hip row the first of three rows below the head each holding five trouser pixels (employee-2's white collar is its chinos' cream). Me-1's black tank
 * top is the hair's colour (`#050302`), so its shoulder row is the nape instead: the row, 26 to 41 rows below the head
 * top, where the back outline comes in furthest.
 */
const GARMENTS: Record<string, { top: string[]; trousers: string[] }> = {
  'Claude-1': { top: ['bd6c08', '8c480b', 'a0560a'], trousers: ['23242b', '2e3035'] },
  'Frontend-dev-1': { top: ['e4508c', '96255a', 'b32867'], trousers: ['051127', '091e47'] },
  'Me-1': { top: [], trousers: ['223450', '122036'] },
  'dev-1': { top: ['1c9fcf', '136c8c'], trousers: ['71622a', '40381b'] },
  'dev-2': { top: ['17cfad', '12a187', '14b496'], trousers: ['040302'] },
  'employee-1': { top: ['562e78', '36144f'], trousers: ['542f2c'] },
  'employee-2': { top: ['e7c82f', 'bfa328', 'a98d31'], trousers: ['ebe3c9', 'bcb2a2'] },
  'employee-3': { top: ['179d17', '179a17', '0f610f'], trousers: ['081326', '0f2338', '13293e'] },
  'security-audit-1': { top: ['dd8522', 'a25d0f'], trousers: ['333034', '2c292d', '231e1e'] },
};

const rgb = (hex: string) => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
/** Within 8 of one of the tones (RGB distance): tight enough that the outline ink `#1b1f27` never counts. */
const isTone = (pixel: number[], tones: number[][]) => pixel[3]! > 0 && tones.some((tone) => Math.hypot(...tone.map((value, k) => value - pixel[k]!)) <= 8);

function measure(key: string): { top: number; shoulder: number; hip: number; torso: number; headToHip: number } {
  const char = key.split('/')[0]!;
  const { frame } = frames[key]!;
  const at = (x: number, y: number) => atlas.rgba(frame.x + x, frame.y + y);
  const opaque = (x: number, y: number) => at(x, y)[3]! > 0;
  const rows = [...Array(FRAME_H).keys()].filter((y) => [...Array(FRAME_W).keys()].some((x) => opaque(x, y)));
  const top = rows[0]!;
  const feet = rows.at(-1)!;
  const count = (y: number, tones: number[][], from = 0) => [...Array(FRAME_W - from).keys()].filter((k) => isTone(at(from + k, y), tones)).length;
  const trousers = GARMENTS[char]!.trousers.map(rgb);
  const hip = rows.find((y) => y >= top + 36 && y + 2 < feet && [0, 1, 2].every((k) => count(y + k, trousers) >= 5));
  if (hip === undefined) throw new Error(`${key}: no trouser row`);
  const middle = [...Array(FRAME_W).keys()].filter((x) => opaque(x, hip - 2));
  const back = middle[middle.length >> 1]!;
  const topTones = GARMENTS[char]!.top.map(rgb);
  const shoulder = topTones.length
    ? rows.find((y) => y >= top + 20 && y < hip && count(y, topTones, back) >= 2)
    : [...Array(16).keys()].map((k) => top + 26 + k).reduce((best, y) => {
      const edge = (row: number) => Math.max(...[...Array(FRAME_W).keys()].filter((x) => opaque(x, row)));
      return edge(y) < edge(best) ? y : best;
    });
  if (shoulder === undefined) throw new Error(`${key}: no shoulder row`);
  return { top, shoulder, hip, torso: hip - shoulder, headToHip: hip - top };
}

describe('Pixi character proportions', () => {
  it('measures all nine characters', () => {
    expect(CAST.sort()).toEqual(Object.keys(GARMENTS).sort());
  });

  it.each(Object.keys(GARMENTS))('seats %s as tall with its back to the camera as facing it', (char) => {
    const front = measure(`${char}/type/front/0`);
    const rear = measure(`${char}/type/rear/0`);
    const off = { torso: rear.torso - front.torso, headToHip: rear.headToHip - front.headToHip, hip: rear.hip - front.hip };
    expect(Object.values(off).every((value) => Math.abs(value) <= TOLERANCE), JSON.stringify({ front, rear })).toBe(true);
  });
});
