// Composes the static Office room (layout 1c, or layout 2 with --layout 2) from the PixelLab pieces in
// public/office/pixi/room/:
//   public/office/pixi/room-day.png            floor, walls and wall items at the world size 1680 x 1056
//   public/office/pixi/room-night-windows.png  the night sky, transparent except the window panes
//   public/office/pixi/glass/*.png             one glass partition segment per tile, plus the two door posts
// Every piece is placed through the handoff projection p(i, j, z) (src/office/pixi/world.ts), so the art lines up
// with the tile grid. room/SOURCE.md lists each piece's PixelLab job and how it was cropped.
//
//   node packages/web/scripts/compose-office-room.mjs              compose from the committed pieces
//   node packages/web/scripts/compose-office-room.mjs --raw <dir>  first re-crop the pieces from the PixelLab downloads
//                                                                  (file names as in SOURCE.md), then compose
//   node packages/web/scripts/compose-office-room.mjs --layout 2   the layout 2 room instead: the wood floor under the
//                                                                  kitchen and lounge and no done board on the QA corner's
//                                                                  wall, written to room/layout2-day.png and
//                                                                  room/layout2-night-windows.png (glass as above)
// No dependencies: a small PNG reader and writer on node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/office/pixi');
const ROOM = path.join(OUT, 'room');

// ---- World (copied from src/office/pixi/world.ts and the handoff) ----
const WORLD_W = 1680, WORLD_H = 1056, W = 20, H = 14, OX = 696, OY = 216, TX = 48, TY = 24, UNIT = 48;
const p = (i, j, z = 0) => [OX + (i - j) * TX, OY + (i + j) * TY - z * UNIT];

// ---- PNG ----
function readPng(file) {
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, pal = null, trns = null;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), kind = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (kind === 'PLTE') pal = d;
    else if (kind === 'tRNS') trns = d;
    else if (kind === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`${file}: only 8-bit non-interlaced PNGs are read`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(w * h * 4), cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, up = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const e = a + up - c, pa = Math.abs(e - a), pb = Math.abs(e - up), pc = Math.abs(e - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4, s = x * ch;
      if (type === 6) data.set(cur.subarray(s, s + 4), q);
      else if (type === 2) { data.set(cur.subarray(s, s + 3), q); data[q + 3] = 255; }
      else if (type === 0 || type === 4) { data[q] = data[q + 1] = data[q + 2] = cur[s]; data[q + 3] = type === 4 ? cur[s + 1] : 255; }
      else { const k = cur[s]; data.set(pal.subarray(k * 3, k * 3 + 3), q); data[q + 3] = trns && k < trns.length ? trns[k] : 255; }
    }
    prev.set(cur);
  }
  return { w, h, data };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const v of buf) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(kind, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(kind, 'ascii'), data]);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Writes RGBA with no row filter, which deflates this art smaller than any of the PNG filters. */
function writePng(file, img) {
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h), ihdr = Buffer.alloc(13);
  for (let y = 0; y < img.h; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * img.w * 4, img.w * 4).copy(raw, y * (img.w * 4 + 1) + 1);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

// ---- Image helpers ----
const blank = (w, h) => ({ w, h, data: new Uint8Array(w * h * 4) });
const get = (img, x, y) => { const q = (y * img.w + x) * 4; return [img.data[q], img.data[q + 1], img.data[q + 2], img.data[q + 3]]; };
const hex = (s) => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function crop(img, [x0, y0, w, h]) {
  const out = blank(w, h);
  for (let y = 0; y < h; y++) out.data.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return out;
}

/** Source-over one RGBA pixel (colour c, alpha a in 0..1) onto img at (x, y). */
function blend(img, x, y, c, a) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h || a <= 0) return;
  const q = (y * img.w + x) * 4, da = img.data[q + 3] / 255, oa = a + da * (1 - a);
  for (let k = 0; k < 3; k++) img.data[q + k] = clamp((c[k] * a + img.data[q + k] * da * (1 - a)) / oa);
  img.data[q + 3] = clamp(oa * 255);
}

/** Mean colour of the opaque pixels of img inside rows y0..y1 (exclusive). */
function mean(img, y0 = 0, y1 = img.h) {
  const s = [0, 0, 0]; let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < img.w; x++) { const c = get(img, x, y); if (c[3] < 128) continue; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++; }
  return s.map((v) => v / n);
}

/** Recolour: the base colour scaled by the pixel's luminance over the texture's mean luminance (outlines stay black). */
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const retint = (c, m, base) => base.map((v) => clamp((v * luma(c)) / luma(m)));

/**
 * Resize pixel art without scaling it: duplicate (or drop) the columns, then the rows, that differ least from their
 * neighbour, so outlines keep their width and only flat runs grow or shrink. A column already changed is not picked
 * again until every other candidate has been, which spreads the change.
 */
function fit(img, w, h) {
  const cols = (im) => ({ n: im.w, diff: (k) => { let d = 0; for (let y = 0; y < im.h; y++) { const a = get(im, k, y), b = get(im, k + 1, y); d += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]); } return d; } });
  const transpose = (im) => { const o = blank(im.h, im.w); for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) o.data.set(im.data.subarray((y * im.w + x) * 4, (y * im.w + x) * 4 + 4), (x * im.h + y) * 4); return o; };
  const resizeCols = (im, target) => {
    let cur = im; const used = new Set();
    while (cur.w !== target) {
      const { n, diff } = cols(cur); let best = -1, bestCost = Infinity;
      for (let k = 1; k < n - 2; k++) { const cost = diff(k) + (used.has(k) ? 1e9 : 0); if (cost < bestCost) { bestCost = cost; best = k; } }
      if (bestCost >= 1e9) used.clear();
      const grow = cur.w < target, out = blank(cur.w + (grow ? 1 : -1), cur.h);
      for (let y = 0; y < cur.h; y++) {
        let ox = 0;
        for (let x = 0; x < cur.w; x++) {
          if (!grow && x === best) continue;
          out.data.set(cur.data.subarray((y * cur.w + x) * 4, (y * cur.w + x) * 4 + 4), (y * out.w + ox++) * 4);
          if (grow && x === best) out.data.set(cur.data.subarray((y * cur.w + x) * 4, (y * cur.w + x) * 4 + 4), (y * out.w + ox++) * 4);
        }
      }
      const shifted = new Set();
      for (const k of used) shifted.add(k > best ? k + (grow ? 1 : -1) : k);
      shifted.add(best); if (grow) shifted.add(best + 1);
      used.clear(); for (const k of shifted) used.add(k);
      cur = out;
    }
    return cur;
  };
  return transpose(resizeCols(transpose(resizeCols(img, w)), h));
}

// ---- Pieces: file name -> [raw download name, crop x, y, w, h] (see SOURCE.md) ----
const PIECES = {
  'floor-carpet-a.png': ['floor2/tile_1.png', 0, 24, 96, 48],
  'floor-carpet-b.png': ['floor2/tile_9.png', 0, 24, 96, 48],
  'floor-lab-a.png': ['floor2/tile_3.png', 0, 24, 96, 48],
  'floor-lab-b.png': ['floor2/tile_11.png', 0, 24, 96, 48],
  'floor-wood-a.png': ['floor2/tile_6.png', 0, 24, 96, 48],
  'floor-wood-b.png': ['floor2/tile_7.png', 0, 24, 96, 48],
  'wall.png': ['items/wall-1.png', 6, 3, 84, 181],
  'window-left.png': ['items/window-left-1.png', 0, 0, 136, 96],
  'window-right.png': ['items/window-1.png', 0, 0, 192, 95],
  'sky-day.png': ['items/sky-day-1.png', 0, 0, 192, 96],
  'sky-night.png': ['items/sky-night-1.png', 0, 0, 192, 96],
  'door.png': ['items/door-1.png', 14, 8, 67, 135],
  'board.png': ['items/board-2.png', 21, 13, 122, 67],
  'glass.png': ['items/glass-1.png', 3, 5, 42, 147],
  'sconce.png': ['items/sconce-2.png', 12, 6, 8, 20],
};

const rawAt = process.argv.indexOf('--raw');
if (rawAt > 0) {
  const dir = process.argv[rawAt + 1];
  for (const [name, [src, ...rect]] of Object.entries(PIECES)) writePng(path.join(ROOM, name), crop(readPng(path.join(dir, src)), rect));
}
const piece = Object.fromEntries(Object.keys(PIECES).map((name) => [name.replace('.png', ''), readPng(path.join(ROOM, name))]));

// ---- Floor ----
// Two-tone checker per region, as the handoff's table: the tile at (i, j) takes colour (i + j) % 2 of its region.
const TONES = {
  carpet: ['#646d80', '#5f687b'], lab: ['#c7ced6', '#bcc4cd'], review: ['#857696', '#7d6f8f'], wood: ['#a67c52', '#9b724a'],
};
// The review floor is carpet too: it reuses the carpet textures under its own colours.
const TEXTURES = { carpet: ['floor-carpet-a', 'floor-carpet-b'], lab: ['floor-lab-a', 'floor-lab-b'], review: ['floor-carpet-b', 'floor-carpet-a'], wood: ['floor-wood-a', 'floor-wood-b'] };
// Layout 1c has the break wood at i > 6.5, j > 11; layout 2 moves it under the kitchen and lounge (i < 5.5, j > 9).
const LAYOUT2 = process.argv[process.argv.indexOf('--layout') + 1] === '2';
const wood = LAYOUT2 ? (ci, cj) => ci < 5.5 && cj > 9 : (ci, cj) => ci > 6.5 && cj > 11;
const region = (ci, cj) => (ci > 12 && cj < 7 ? 'lab' : ci > 12 ? 'review' : wood(ci, cj) ? 'wood' : 'carpet');

/** A floor texture with every pixel outside its diamond filled from the nearest diamond pixel in the same row. */
function fillRows(img) {
  const out = blank(img.w, img.h); out.data.set(img.data);
  for (let y = 0; y < img.h; y++) {
    const xs = []; for (let x = 0; x < img.w; x++) if (get(img, x, y)[3] >= 128) xs.push(x);
    if (!xs.length) continue;
    for (let x = 0; x < img.w; x++) {
      if (get(img, x, y)[3] >= 128) continue;
      const nx = xs.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
      out.data.set(img.data.subarray((y * img.w + nx) * 4, (y * img.w + nx) * 4 + 4), (y * img.w + x) * 4);
      out.data[(y * img.w + x) * 4 + 3] = 255;
    }
  }
  return out;
}
const floorTex = Object.fromEntries(Object.values(TEXTURES).flat().map((n) => [n, fillRows(piece[n])]));
const floorMean = Object.fromEntries(Object.keys(floorTex).map((n) => [n, mean(piece[n])]));

/** The floor tile under world pixel (x, y), or null outside the floor. */
function tileAt(x, y) {
  const a = (x + 0.5 - OX) / TX, b = (y + 0.5 - OY) / TY, i = (a + b) / 2, j = (b - a) / 2;
  return i >= 0 && j >= 0 && i < W && j < H ? [Math.floor(i), Math.floor(j)] : null;
}
const tileId = (x, y) => { const t = tileAt(x, y); return t ? t[0] * H + t[1] : -1; };

const day = blank(WORLD_W, WORLD_H), night = blank(WORLD_W, WORLD_H);
const GRID = 0.12; // grid lines: black at 12% opacity
for (let y = 0; y < WORLD_H; y++) for (let x = 0; x < WORLD_W; x++) {
  const t = tileAt(x, y); if (!t) continue;
  const [ti, tj] = t, reg = region(ti + 0.5, tj + 0.5), names = TEXTURES[reg];
  const name = names[(ti * 7 + tj * 3 + ((ti * tj) % 5)) % 2], [X0, Y0] = p(ti, tj);
  const c = get(floorTex[name], x - X0 + TX, y - Y0);
  let rgb = retint(c, floorMean[name], hex(TONES[reg][(ti + tj) % 2]));
  const id = ti * H + tj;
  if (tileId(x + 1, y) !== id || tileId(x, y + 1) !== id) rgb = rgb.map((v) => v * (1 - GRID));
  blend(day, x, y, rgb, 1);
}

// ---- Walls ----
// A vertical plane: 'j' runs along j at i = c (the left wall, and glass at i = 12); 'i' runs along i at j = c.
// Returns the running coordinate t and the height z (both in units) of the world point (fx, fy).
function onPlane(axis, c, fx, fy) {
  const t = axis === 'j' ? c - (fx - OX) / TX : c + (fx - OX) / TX;
  const [, y0] = axis === 'j' ? p(c, t) : p(t, c);
  return { t, z: (y0 - fy) / UNIT };
}
const LEFT = ['j', 0], RIGHT = ['i', 0];

// wall.png rows: cap 0..13, plaster 14..162, baseboard 163..180. The wall is 4 units = 192 px: an 8 px cap, an 11 px
// baseboard (0.22 units) and plaster between; the cap and baseboard keep their outline rows and drop wood rows.
const CAP_ROWS = [0, 1, 3, 6, 8, 10, 12, 13];
const BASE_ROWS = [163, 164, 165, 167, 169, 170, 172, 175, 177, 179, 180];
const wallRow = (v) => (v < 8 ? CAP_ROWS[v] : v >= 181 ? BASE_ROWS[v - 181] : 14 + Math.floor(((v - 8) * 149) / 173));
const wallMeans = { cap: mean(piece.wall, 0, 14), plaster: mean(piece.wall, 14, 163), base: mean(piece.wall, 163, 181) };
const WALL_COLOURS = { left: '#cdbb9c', right: '#dccba9', lab: '#d3d8dc', cap: '#5b4a39', base: '#8e7a60' };
const INK = hex('#1b1f27');

for (let y = 0; y < WORLD_H; y++) for (let x = 0; x < WORLD_W; x++) {
  if (tileAt(x, y)) continue;
  const left = x + 0.5 < OX, [axis, c] = left ? LEFT : RIGHT, { t, z } = onPlane(axis, c, x + 0.5, y + 0.5);
  if (t < 0 || t > (left ? H : W) || z < 0 || z > 4) continue;
  const v = Math.min(191, Math.floor((4 - z) * UNIT)), row = wallRow(v);
  // The texture reads left to right on screen on both walls.
  const u = Math.floor(left ? (H - t) * UNIT : t * UNIT) % piece.wall.w;
  const part = v < 8 ? 'cap' : v >= 181 ? 'base' : 'plaster';
  const base = part === 'plaster' ? WALL_COLOURS[left ? 'left' : t >= 12 ? 'lab' : 'right'] : WALL_COLOURS[part];
  // The outer end of each wall gets a 2 px outline, as the cap and the baseboard carry theirs.
  const end = ((left ? H : W) - t) * UNIT < 2;
  blend(day, x, y, end ? INK : retint(get(piece.wall, u, row), wallMeans[part], hex(base)), 1);
}

// ---- Wall items ----
/**
 * Paint img onto a plane between t0..t1 and z0..z1, one screen column per image column (the plane's 2:1 shear);
 * paint(x, y, c, s, r) receives each covered world pixel, the image pixel under it and its position in the image
 * as fractions (s across, r down).
 */
function onWall([axis, c], t0, t1, z0, z1, img, paint) {
  const [xa] = axis === 'j' ? p(c, t0) : p(t0, c), [xb] = axis === 'j' ? p(c, t1) : p(t1, c);
  const [, ya] = axis === 'j' ? p(c, t0, z1) : p(t0, c, z1), [, yb] = axis === 'j' ? p(c, t1, z0) : p(t1, c, z0);
  for (let x = Math.floor(Math.min(xa, xb)); x < Math.ceil(Math.max(xa, xb)); x++) for (let y = Math.floor(Math.min(ya, yb)) - 1; y < Math.ceil(Math.max(ya, yb)) + 1; y++) {
    const { t, z } = onPlane(axis, c, x + 0.5, y + 0.5);
    if (t < t0 || t >= t1 || z < z0 || z >= z1) continue;
    const s = axis === 'j' ? (t1 - t) / (t1 - t0) : (t - t0) / (t1 - t0), r = (z1 - z) / (z1 - z0);
    paint(x, y, sample(img, s, r), s, r);
  }
}
const sample = (img, s, r) => get(img, Math.min(img.w - 1, Math.floor(s * img.w)), Math.min(img.h - 1, Math.floor(r * img.h)));

// Windows: the frame is PixelLab art whose panes came back see-through. A pane pixel (see-through, or the art's own
// light cloud and glint pixels) shows the day sky in room-day.png, and the night sky in room-night-windows.png, which
// holds nothing else. Both skies are PixelLab images tinted to the handoff's sky colours.
const skyDay = piece['sky-day'], skyNight = piece['sky-night'];
const skyDayMean = mean(skyDay), skyNightMean = mean(skyNight);
const isPane = (c) => c[3] < 128 || (c[0] + c[1] + c[2] > 450 && c[2] >= c[0] - 10);
const WINDOWS = [[LEFT, 3, 5.8, 'window-left'], [LEFT, 6.2, 9, 'window-left'], [RIGHT, 2, 6, 'window-right']];
for (const [plane, t0, t1, name] of WINDOWS) {
  onWall(plane, t0, t1, 1.3, 3.3, fit(piece[name], Math.round((t1 - t0) * UNIT), 96), (x, y, c, s, r) => {
    if (!isPane(c)) { blend(day, x, y, c, 1); return; }
    blend(day, x, y, retint(sample(skyDay, s, r), skyDayMean, hex('#a9d4ef')), 1);
    blend(night, x, y, retint(sample(skyNight, s, r), skyNightMean, hex('#1c2745')), 1);
  });
}

const opaque = (x, y, c) => { if (c[3] >= 128) blend(day, x, y, c, 1); };
// Layout 2's door sits 44 px (0.92 tile) further along, i 9.92..11.92, against the i = 12 glass, so the kanban whiteboard
// can hang lower on the wall to its left and still show whole in a 1280 x 800 first view (BOARD_AT in roomProps.ts).
const DOOR_I = LAYOUT2 ? 9 + 44 / 48 : 9;
onWall(RIGHT, DOOR_I, DOOR_I + 2, 0, 3, fit(piece.door, 96, 144), opaque);
// The done board is empty (the engine draws the notes); the painted wall around its corners and tray is dropped.
// Layout 2 has no done board: the kanban whiteboard by the door is the room's one board, so that wall stays plain.
if (!LAYOUT2) onWall(RIGHT, 16, 19.4, 1.4, 3.4, fit(piece.board, Math.round(3.4 * UNIT), 96), (x, y, c) => { if (c[0] - c[2] <= 40) opaque(x, y, c); });

// Sconces: a small front-view sprite, unsheared, centred on the handoff's sconce square (z 2.8..3.2).
for (const [side, at] of [['l', 1.8], ['l', 11], ['r', 7.5], ['r', 14.5]]) {
  const [cx, cy] = side === 'l' ? p(0, at, 3) : p(at, 0, 3), img = piece.sconce;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) opaque(Math.round(cx - img.w / 2) + x, Math.round(cy - img.h / 2) + y, get(img, x, y));
}

const [dayFile, nightFile] = LAYOUT2 ? ['room/layout2-day.png', 'room/layout2-night-windows.png'] : ['room-day.png', 'room-night-windows.png'];
writePng(path.join(OUT, dayFile), day);
writePng(path.join(OUT, nightFile), night);
console.log(`${dayFile}, ${nightFile}`);

// ---- Glass ----
// Partitions at i = 12 (j 0..6 and 8..14, a door gap at j 6..8) and j = 7 (i 14..20), 2.3 units tall. One image per
// tile, so the engine can depth-sort each segment on its own with the handoff's keys (12 + j + 0.5 and i + 7.5). The
// pane keeps the art's colour at 10% alpha, the reflections 30%, and the aluminium frame stays opaque. The handoff had
// 3.2 units, 20% and 55%, which streaked over the QA corner and the pod desks behind the glass (GLASS_H in furniture.ts).
const GLASS_H = 2.3;
const glassArt = fit(piece.glass, UNIT, Math.round(GLASS_H * UNIT));
const near = (c, [r, g, b], d) => Math.abs(c[0] - r) < d && Math.abs(c[1] - g) < d && Math.abs(c[2] - b) < d;
const glassAlpha = (c) => (c[3] < 128 ? 0 : c[0] > 240 && c[1] > 240 && c[2] > 240 ? 0.3 : near(c, [196, 229, 251], 14) ? 0.1 : 1);

/** A transparent image covering the world-space bounding box of pts, with its world offset. */
function canvasFor(pts) {
  const x0 = Math.floor(Math.min(...pts.map((q) => q[0]))), y0 = Math.floor(Math.min(...pts.map((q) => q[1])));
  const x1 = Math.ceil(Math.max(...pts.map((q) => q[0]))), y1 = Math.ceil(Math.max(...pts.map((q) => q[1])));
  return { x0, y0, img: blank(x1 - x0, y1 - y0) };
}
const glass = [];
function saveGlass(name, { x0, y0, img }, depth) {
  writePng(path.join(OUT, 'glass', `${name}.png`), img);
  glass.push(`${name}.png x ${x0} y ${y0} ${img.w}x${img.h} depth ${depth}`);
}

function segment(name, [axis, c], t0, depth) {
  const at = (t, z) => (axis === 'j' ? p(c, t, z) : p(t, c, z)), cv = canvasFor([at(t0, 0), at(t0 + 1, 0), at(t0, GLASS_H), at(t0 + 1, GLASS_H)]);
  onWall([axis, c], t0, t0 + 1, 0, GLASS_H, glassArt, (x, y, px) => blend(cv.img, x - cv.x0, y - cv.y0, px, glassAlpha(px)));
  saveGlass(name, cv, depth);
}
for (let j = 0; j < H; j++) if (j !== 6 && j !== 7) segment(`i12-j${j}`, ['j', 12], j, 12 + j + 0.5);
for (let i = 14; i < W; i++) segment(`j7-i${i}`, ['i', 7], i, i + 7.5);

// The two posts at the door gap: 0.16 x 0.16 boxes as tall as the glass, in the glass frame's colour, lit like the
// furniture (top lightest, the +i face darkest), with a 1 px outline.
const frameRgb = (() => {
  const s = [0, 0, 0]; let n = 0;
  for (let y = 0; y < glassArt.h; y++) for (let x = 0; x < glassArt.w; x++) {
    const c = get(glassArt, x, y);
    if (glassAlpha(c) === 1 && c[0] + c[1] + c[2] > 150) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++; }
  }
  return s.map((v) => v / n);
})();
function post(name, bi, bj, depth) {
  const d = 0.16, cv = canvasFor([p(bi, bj, GLASS_H), p(bi + d, bj, GLASS_H), p(bi, bj + d, GLASS_H), p(bi + d, bj + d, 0), p(bi, bj + d, 0), p(bi + d, bj, 0)]);
  const face = (fx, fy) => {
    const a = (fx - OX) / TX, b = (fy + GLASS_H * UNIT - OY) / TY, ti = (a + b) / 2, tj = (b - a) / 2;
    if (ti >= bi && ti < bi + d && tj >= bj && tj < bj + d) return 1.15; // top
    const l = onPlane('i', bj + d, fx, fy);
    if (l.t >= bi && l.t < bi + d && l.z >= 0 && l.z < GLASS_H) return 1; // the face towards +j
    const r = onPlane('j', bi + d, fx, fy);
    if (r.t >= bj && r.t < bj + d && r.z >= 0 && r.z < GLASS_H) return 0.8; // the face towards +i
    return 0;
  };
  const shade = (x, y) => face(cv.x0 + x + 0.5, cv.y0 + y + 0.5);
  for (let y = 0; y < cv.img.h; y++) for (let x = 0; x < cv.img.w; x++) {
    const k = shade(x, y); if (!k) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !shade(x + dx, y + dy));
    blend(cv.img, x, y, edge ? INK : frameRgb.map((v) => clamp(v * k)), 1);
  }
  saveGlass(name, cv, depth);
}
post('post-i12-j6', 11.92, 5.92, 12 + 6);
post('post-i12-j8', 11.92, 7.92, 12 + 8);
console.log(glass.join('\n'));
