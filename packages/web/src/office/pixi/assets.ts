import { Assets, Rectangle, Texture, type Spritesheet } from 'pixi.js';
import { OUTLINE as INK, shade } from './draw';

/**
 * PixelLab textures for the Pixi office. Missing character frames use this module's `charCanvas` art for that character;
 * missing furniture and glass textures leave the corresponding Graphics piece in place. Generated fallback frames and
 * glyphs stay packed into an image atlas because canvas-backed textures could upload blank. Every loaded texture gets
 * `scaleMode: 'nearest'` on its own source; `TextureSource.defaultOptions` is never changed.
 */

export const OFFICE_SPRITE_SHEET = '/office/pixi/characters.json';

const FURNITURE_FILES = [
  'pod-desk-front', 'pod-desk-rear', 'divider', 'monitor-back', 'monitor-back-lit', 'monitor-front',
  'monitor-front-lit', 'monitor-front-off', 'chair-front', 'chair-rear', 'chair-meeting', 'desk-orch', 'keyboard-mouse', 'monitors-orch',
  'monitors-orch-lit', 'chair-orch', 'qa-desk', 'qa-desk-lit', 'qa-desk-off', 'meeting-table', 'wall-screen-on',
  'wall-screen-on-lit', 'wall-screen-running-0', 'wall-screen-running-0-lit', 'wall-screen-running-1',
  'wall-screen-running-1-lit', 'wall-screen-running-2', 'wall-screen-running-2-lit', 'wall-screen-running-3',
  'wall-screen-running-3-lit', 'wall-screen-pass', 'wall-screen-pass-lit', 'wall-screen-fail', 'wall-screen-fail-lit',
  'kitchen-counter', 'fridge', 'sofa', 'coffee-table', 'plant-monstera', 'plant-snake', 'lamp-floor', 'lamp-floor-lit', 'lamp-ceiling', 'lamp-ceiling-lit',
] as const;

const GLASS_FILES = [
  ...Array.from({ length: 6 }, (_, j) => `glass/i12-j${j}`),
  ...Array.from({ length: 6 }, (_, j) => `glass/i12-j${j + 8}`),
  ...Array.from({ length: 6 }, (_, i) => `glass/j7-i${i + 14}`),
  'glass/post-i12-j6', 'glass/post-i12-j8',
] as const;

/** The count objects (`roomProps.ts`): the kanban whiteboard, its notes in the Board's column colours, and the folders. */
const PROP_FILES = [
  'kanban-board', 'folder',
  ...['ready', 'blocked', 'running', 'verifying', 'review', 'done'].map((column) => `note-${column}`),
] as const;

/** The layout 2 room: floor, walls and wall items by day, and the night sky in its window panes. */
export const ROOM_DAY = 'room/layout2-day';
export const ROOM_NIGHT_WINDOWS = 'room/layout2-night-windows';

export const OFFICE_TEXTURE_KEYS = [
  ROOM_DAY, ROOM_NIGHT_WINDOWS,
  ...FURNITURE_FILES.map((file) => `furniture/${file}`),
  ...GLASS_FILES,
  ...PROP_FILES.map((file) => `props/${file}`),
] as const;

export function officeTextureUrl(key: string): string {
  return `/office/pixi/${key}.png`;
}

export async function loadOfficeTextures(load: (url: string) => Promise<Texture> = (url) => Assets.load<Texture>(url)): Promise<Map<string, Texture>> {
  const loaded = await Promise.all(OFFICE_TEXTURE_KEYS.map(async (key) => {
    const url = officeTextureUrl(key);
    try {
      const texture = await load(url);
      texture.source.scaleMode = 'nearest';
      return [key, texture] as const;
    } catch (error) {
      console.warn('office texture', url, error);
      return null;
    }
  }));
  return new Map(loaded.filter((entry): entry is readonly [string, Texture] => entry !== null));
}

export type CharAnim = 'walk' | 'type' | 'idle';
export type CharView = 'front' | 'rear';

export const FRAMES: Record<CharAnim, number> = { walk: 4, type: 2, idle: 1 };
const ANIMS = Object.keys(FRAMES) as CharAnim[];
const VIEWS: CharView[] = ['front', 'rear'];

/** Skin, hair, shirt and pants per character; names match the DOM office's `sprites/characters/*`. */
export const PAL: Record<string, readonly [string, string, string, string]> = {
  'Me-1': ['#f1c7a0', '#3a2a20', '#c9463d', '#2e3440'],
  'dev-1': ['#e8b890', '#5a3a22', '#3f7fc4', '#34384a'],
  'dev-2': ['#c98f64', '#1f1a17', '#2f9a8a', '#3b3f4f'],
  'employee-1': ['#f0cda8', '#b8752e', '#8a5cc2', '#2f3342'],
  'employee-2': ['#8d5a3b', '#1a1412', '#d19a3a', '#3a3d4c'],
  'employee-3': ['#e9bf98', '#6b4a2a', '#4f9a4f', '#34384a'],
  'Frontend-dev-1': ['#f3d0b0', '#2a2220', '#d0628a', '#303446'],
  'Claude-1': ['#e9c29c', '#2b2b2b', '#d97757', '#3a3340'],
  'security-audit-1': ['#e0b590', '#7a7a7a', '#e67e22', '#2e3440'],
};
export const FALLBACK_CHAR = 'dev-1';

export const GRID_W = 16;
export const GRID_H = 29;
/** Screen pixels per grid cell: a frame is 48x87. */
export const CELL = 3;

/** Bubble glyphs, as [text, fill, size]; the next renderer step draws them. */
export const GLYPHS: readonly (readonly [string, string, number])[] = [
  ['.  ', INK, 17], ['.. ', INK, 17], ['...', INK, 17], ['test', INK, 17], ['✎', INK, 17], ['z z', INK, 17], ['★', INK, 17],
  ['?', INK, 17], ['!', '#ffffff', 17], ['✓', '#ffffff', 17],
];

/** Rasterize glyphs at their displayed size so the sprites stay at 1x for every device-pixel scale. */
export const GLYPH_RASTER_SCALE = 1;

export function frameKey(char: string, anim: CharAnim, view: CharView, n: number): string {
  return `${char}/${anim}/${view}/${n}`;
}

/** True when the atlas holds every frame of the character `characterFrameTextures` draws for `char`. */
export function atlasHasCharacter(char: string, sheetTextures: Readonly<Record<string, Texture | undefined>>): boolean {
  const selected = PAL[char] ? char : FALLBACK_CHAR;
  return ANIMS.every((candidateAnim) => VIEWS.every((candidateView) =>
    Array.from({ length: FRAMES[candidateAnim] }, (_, n) => frameKey(selected, candidateAnim, candidateView, n))
      .every((key) => sheetTextures[key] !== undefined)));
}

/** Use a complete atlas character, or that character's generated frames if any of its keys are missing. */
export function characterFrameTextures(
  char: string,
  anim: CharAnim,
  view: CharView,
  sheetTextures: Readonly<Record<string, Texture | undefined>>,
  fallback: (key: string) => Texture,
): Texture[] {
  const selected = PAL[char] ? char : FALLBACK_CHAR;
  const complete = atlasHasCharacter(char, sheetTextures);
  return Array.from({ length: FRAMES[anim] }, (_, n) => {
    const key = frameKey(selected, anim, view, n);
    return complete ? sheetTextures[key]! : fallback(`c:${key}`);
  });
}

/** One placeholder frame as a 16x29 grid of colours (null is transparent), outlined in ink; the prototype's `charCanvas`. */
export function charGrid(pal: readonly [string, string, string, string], view: CharView, anim: CharAnim, f: number): (string | null)[][] {
  const [skin, hair, shirt, pants] = pal;
  const g: (string | null)[][] = Array.from({ length: GRID_H }, () => Array<string | null>(GRID_W).fill(null));
  const R = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) g[y]![x] = c;
  };
  const front = view === 'front';
  const lL = anim === 'walk' && f === 1 ? 1 : 0;
  const rL = anim === 'walk' && f === 3 ? 1 : 0;
  const sp = anim === 'walk' && f === 0 ? 1 : 0;
  R(5 - sp, 21, 7 - sp, 26 - lL, pants); R(5 - sp, 27 - lL, 7 - sp, 27 - lL, '#2a2a2e');
  R(8 + sp, 21, 10 + sp, 26 - rL, shade(pants, 0.85)); R(8 + sp, 27 - rL, 10 + sp, 27 - rL, '#2a2a2e');
  R(4, 12, 11, 20, shirt); R(10, 13, 11, 19, shade(shirt, 0.85)); R(4, 20, 11, 20, '#3a3340');
  if (anim === 'type') {
    R(3, 12, 3, 15, shade(shirt)); R(12, 12, 12, 15, shade(shirt));
    if (front) { const a = f % 2; R(4, 15 + a, 5, 16 + a, skin); R(10, 16 - a, 11, 17 - a, skin); }
  } else {
    const la = anim === 'walk' ? [0, -1, 0, 1][f]! : 0;
    R(3, 12, 3, 18 + la, shade(shirt)); R(3, 19 + la, 3, 19 + la, skin); R(12, 12, 12, 18 - la, shade(shirt)); R(12, 19 - la, 12, 19 - la, skin);
  }
  R(6, 11, 9, 11, shade(skin, 0.88));
  R(4, 3, 11, 10, skin);
  if (front) {
    R(4, 2, 11, 4, hair); R(5, 1, 10, 1, hair); R(9, 5, 11, 7, hair); R(4, 5, 4, 5, hair);
    R(5, 7, 5, 7, INK); R(8, 7, 8, 7, INK); R(6, 9, 7, 9, '#b8746a'); R(11, 8, 11, 9, shade(skin, 0.85));
  } else {
    R(4, 1, 11, 9, hair); R(5, 1, 10, 1, hair); R(4, 9, 11, 9, shade(hair, 0.8)); R(5, 10, 10, 10, shade(skin, 0.9));
  }
  return g.map((row, y) => row.map((c, x) => c ?? ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy!]?.[x + dx!]) ? INK : null)));
}

/** The placeholder frame drawn on a 48x87 canvas: the dev fallback when no sprite atlas is configured. */
export function charCanvas(pal: readonly [string, string, string, string], view: CharView, anim: CharAnim, f: number): HTMLCanvasElement {
  const grid = charGrid(pal, view, anim, f);
  const canvas = document.createElement('canvas');
  canvas.width = GRID_W * CELL;
  canvas.height = GRID_H * CELL;
  const ctx = canvas.getContext('2d')!;
  grid.forEach((row, y) => row.forEach((c, x) => { if (c) { ctx.fillStyle = c; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); } }));
  return canvas;
}

export interface OfficeArt {
  /** The frames of one animation from the atlas, or that character's placeholder frames if its atlas is incomplete. */
  frames(char: string, anim: CharAnim, view: CharView): Texture[];
  /** False when `frames` draws this character from the `charCanvas` placeholder. */
  fromAtlas(char: string): boolean;
  glyph(text: string, fill: string, size: number): { texture: Texture; width: number } | undefined;
  texture(key: string): Texture | undefined;
  /** Free the generated atlas; the configured sprite atlas stays in the Assets cache for the next scene. */
  destroy(): void;
}

/** Shelf-pack sources into rows of a fixed-width atlas; returns each key's [x, y, w, h] and the used height. */
export function packAtlas(sizes: readonly (readonly [string, number, number])[], width: number, gap = 2): { rects: Map<string, [number, number, number, number]>; height: number } {
  const rects = new Map<string, [number, number, number, number]>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const [key, w, h] of sizes) {
    if (x + w > width) { x = 0; y += rowH + gap; rowH = 0; }
    rects.set(key, [x, y, w, h]);
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  return { rects, height: y + rowH };
}

function glyphCanvas(text: string, fill: string, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const font = `700 ${size * GLYPH_RASTER_SCALE}px "IBM Plex Mono", ui-monospace, monospace`;
  const measure = canvas.getContext('2d')!;
  measure.font = font;
  canvas.width = Math.max(4, Math.ceil(measure.measureText(text).width) + 4 * GLYPH_RASTER_SCALE);
  canvas.height = size * GLYPH_RASTER_SCALE + 8 * GLYPH_RASTER_SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = fill;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  return canvas;
}

const ATLAS_SIZE = 1024;

/** Build the fallback atlas, then load the PixelLab character and room textures. */
export async function loadOfficeArt(sheetUrl: string | null = OFFICE_SPRITE_SHEET): Promise<OfficeArt> {
  const sources: [string, HTMLCanvasElement][] = [];
  for (const char of Object.keys(PAL)) {
    for (const anim of ANIMS) for (const view of VIEWS) for (let n = 0; n < FRAMES[anim]; n++) sources.push([`c:${frameKey(char, anim, view, n)}`, charCanvas(PAL[char]!, view, anim, n)]);
  }
  for (const [text, fill, size] of GLYPHS) sources.push([`g:${text}|${fill}|${size}`, glyphCanvas(text, fill, size)]);
  const { rects } = packAtlas(sources.map(([key, canvas]) => [key, canvas.width, canvas.height] as const), ATLAS_SIZE);
  const atlas = document.createElement('canvas');
  atlas.width = atlas.height = ATLAS_SIZE;
  const ctx = atlas.getContext('2d')!;
  for (const [key, canvas] of sources) { const [x, y] = rects.get(key)!; ctx.drawImage(canvas, x, y); }
  const image = new Image();
  image.src = atlas.toDataURL();
  await image.decode();
  const base = Texture.from(image);
  base.source.scaleMode = 'nearest';
  const sub = (key: string) => { const [x, y, w, h] = rects.get(key)!; return new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) }); };

  let sheet: Spritesheet | null = null;
  if (sheetUrl) {
    try {
      sheet = await Assets.load<Spritesheet>(sheetUrl);
      for (const texture of Object.values(sheet.textures)) texture.source.scaleMode = 'nearest';
    } catch (error) { console.warn('office sprite atlas', error); }
  }

  const textures = await loadOfficeTextures();

  const cache = new Map<string, Texture[]>();
  return {
    frames(char, anim, view) {
      const key = `${char}/${anim}/${view}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const selected = characterFrameTextures(char, anim, view, sheet?.textures ?? {}, (fallbackKey) => sub(fallbackKey));
      cache.set(key, selected);
      return selected;
    },
    fromAtlas(char) { return atlasHasCharacter(char, sheet?.textures ?? {}); },
    glyph(text, fill, size) {
      const key = `g:${text}|${fill}|${size}`;
      const rect = rects.get(key);
      return rect ? { texture: sub(key), width: rect[2] / GLYPH_RASTER_SCALE } : undefined;
    },
    texture(key) { return textures.get(key); },
    destroy() {
      cache.clear();
      base.destroy(true);
    },
  };
}
