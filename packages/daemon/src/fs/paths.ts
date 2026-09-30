import path from 'node:path';

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function suggestId(p: string): string {
  const id = path.basename(path.resolve(p)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'repo';
}
