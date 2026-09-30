import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** An 8-bit RGBA, non-interlaced PNG (every Office file is one) as rows of RGBA bytes. */
export function readPng(file: string): { width: number; height: number; rgba: (x: number, y: number) => number[] } {
  const bytes = readFileSync(file);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      const paeth = () => {
        const estimate = a + b - c;
        const [pa, pb, pc] = [Math.abs(estimate - a), Math.abs(estimate - b), Math.abs(estimate - c)];
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      };
      const predictor = filter === 4 ? paeth() : [0, a, b, (a + b) >> 1][filter]!;
      out[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, rgba: (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)] };
}
