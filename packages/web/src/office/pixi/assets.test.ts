import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atlasHasCharacter, characterFrameTextures, charGrid, FRAMES, frameKey, GRID_H, GRID_W, packAtlas, PAL } from './assets';
import { OUTLINE } from './draw';
import type { Texture } from 'pixi.js';
import { charFor } from '../config';

const pal = PAL['dev-1']!;

function placeableCharacters(): string[] {
  const characters = new Set([charFor('orchestrator', 'orch'), charFor('critic', 'critic')]);
  for (let index = 0; index < 500; index++) characters.add(charFor('worker', `office-${index}`));
  return [...characters].sort();
}

describe('Pixi character art', () => {
  it('draws a 16 x 29 grid per frame', () => {
    const grid = charGrid(pal, 'front', 'idle', 0);
    expect([grid.length, grid[0]!.length]).toEqual([GRID_H, GRID_W]);
  });

  it('has 4 walk, 2 type and 1 idle frames', () => {
    expect(FRAMES).toEqual({ walk: 4, type: 2, idle: 1 });
  });

  it('outlines the figure in ink', () => {
    expect(charGrid(pal, 'front', 'idle', 0)[0]![5]).toBe(OUTLINE);
  });

  it('moves the legs between walk frames', () => {
    expect(charGrid(pal, 'front', 'walk', 1)).not.toEqual(charGrid(pal, 'front', 'walk', 3));
  });

  it('shows the face only from the front', () => {
    expect([charGrid(pal, 'front', 'idle', 0)[7]![5], charGrid(pal, 'rear', 'idle', 0)[7]![5]]).toEqual([OUTLINE, pal[1]]);
  });

  it('names sprite-atlas frames <char>/<anim>/<view>/<n>', () => {
    expect(frameKey('dev-1', 'walk', 'rear', 3)).toBe('dev-1/walk/rear/3');
  });

  it('has every frame key for every placeable character in the PixelLab atlas manifest', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(process.cwd(), 'public/office/pixi/characters.json'), 'utf8')) as { frames: Record<string, unknown> };
    const characters = placeableCharacters();
    const keys = characters.flatMap((char) => Object.entries(FRAMES).flatMap(([anim, count]) =>
      (['front', 'rear'] as const).flatMap((view) => Array.from({ length: count }, (_, n) => frameKey(char, anim as keyof typeof FRAMES, view, n))),
    ));
    expect({ characters, missing: keys.filter((key) => !(key in manifest.frames)) }).toEqual({
      characters: Object.keys(PAL).sort(),
      missing: [],
    });
  });

  it('uses charCanvas frames for only a character with an incomplete atlas set', () => {
    const keys = Object.keys(PAL).flatMap((char) => Object.entries(FRAMES).flatMap(([anim, count]) =>
      (['front', 'rear'] as const).flatMap((view) => Array.from({ length: count }, (_, n) => frameKey(char, anim as keyof typeof FRAMES, view, n))),
    ));
    const sheet = Object.fromEntries(keys.map((key) => [key, { token: `sheet:${key}` } as unknown as Texture]));
    delete sheet[frameKey('Claude-1', 'walk', 'front', 2)];
    const fallbackCalls: string[] = [];
    const fallback = (key: string) => { fallbackCalls.push(key); return { token: `fallback:${key}` } as unknown as Texture; };
    const claude = characterFrameTextures('Claude-1', 'walk', 'front', sheet, fallback);
    const dev = characterFrameTextures('dev-1', 'walk', 'front', sheet, fallback);
    const tokens = (frames: Texture[]) => frames.map((texture) => (texture as unknown as { token: string }).token);
    expect({
      claude: tokens(claude),
      dev: tokens(dev),
      fallbackCharacters: [...new Set(fallbackCalls.map((key) => key.split('/')[0]?.slice(2)))],
    }).toEqual({
      claude: Array.from({ length: FRAMES.walk }, (_, n) => `fallback:c:${frameKey('Claude-1', 'walk', 'front', n)}`),
      dev: Array.from({ length: FRAMES.walk }, (_, n) => `sheet:${frameKey('dev-1', 'walk', 'front', n)}`),
      fallbackCharacters: ['Claude-1'],
    });
  });

  it('reports which characters the atlas holds, an unknown name reading as the fallback character', () => {
    const keys = Object.keys(PAL).flatMap((char) => Object.entries(FRAMES).flatMap(([anim, count]) =>
      (['front', 'rear'] as const).flatMap((view) => Array.from({ length: count }, (_, n) => frameKey(char, anim as keyof typeof FRAMES, view, n))),
    ));
    const sheet = Object.fromEntries(keys.map((key) => [key, {} as Texture]));
    delete sheet[frameKey('Claude-1', 'idle', 'rear', 0)];
    expect({
      claude: atlasHasCharacter('Claude-1', sheet),
      dev: atlasHasCharacter('dev-1', sheet),
      unknown: atlasHasCharacter('no-such-char', sheet),
      empty: atlasHasCharacter('dev-1', {}),
    }).toEqual({ claude: false, dev: true, unknown: true, empty: false });
  });

  it('packs frames into rows without overlap', () => {
    const { rects } = packAtlas([['a', 600, 10], ['b', 600, 20], ['c', 100, 5]], 1024);
    expect([...rects.values()]).toEqual([[0, 0, 600, 10], [0, 12, 600, 20], [602, 12, 100, 5]]);
  });
});
