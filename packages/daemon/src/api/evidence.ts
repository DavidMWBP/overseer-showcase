import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ROUTE = '/api/evidence';
// Angle brackets cannot occur in a Windows folder name, so a real "root" folder never collides with this entry.
const ROOT_ENTRY = '<evidence-root>';

type EvidenceKind = 'image' | 'video' | 'html' | 'text' | 'other';

interface EvidenceFile {
  relative_path: string;
  size: number;
  modified_at: string;
  kind: EvidenceKind;
}

interface EvidenceFolder {
  name: string;
  file_count: number;
  total_size: number;
  modified_at: string | null;
}

const contentTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
};

function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return false;
  if (size === 0) return false;

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end: Math.min(end, size - 1) };
}

function kindOf(file: string): EvidenceKind {
  const extension = path.extname(file).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) return 'image';
  if (['.mp4', '.webm'].includes(extension)) return 'video';
  if (extension === '.html') return 'html';
  if (['.txt', '.md', '.log', '.json', '.csv'].includes(extension)) return 'text';
  return 'other';
}

function contentTypeOf(file: string): string {
  return contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Decode each URL component once, then reject components that could change path boundaries or roots. */
function requestSegments(request: FastifyRequest, minimum: number, exact?: number): string[] | null {
  const pathname = (request.raw.url ?? request.url).split('?', 1)[0] ?? '';
  if (!pathname.startsWith(`${ROUTE}/`)) return null;
  const raw = pathname.slice(ROUTE.length + 1).split('/');
  if (raw.length < minimum || (exact !== undefined && raw.length !== exact)) return null;

  let segments: string[];
  try { segments = raw.map((segment) => decodeURIComponent(segment)); } catch { return null; }
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0') || path.isAbsolute(segment) || /^[a-z]:/i.test(segment))) return null;
  return segments;
}

async function evidenceRoot(dataDir: string): Promise<string | null> {
  const configuredRoot = path.resolve(dataDir, 'evidence');
  try {
    if (!(await fs.promises.stat(configuredRoot)).isDirectory()) return null;
    return await fs.promises.realpath(configuredRoot);
  } catch {
    return null;
  }
}

/** Resolve only regular in-root paths. Symlinks and junctions are not followed. */
async function resolveEntry(root: string, segments: string[], expected: 'directory' | 'file' | 'any'): Promise<{ path: string; stat: fs.Stats } | null> {
  let candidate = root;
  try {
    for (const [index, segment] of segments.entries()) {
      candidate = path.join(candidate, segment);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) return null;
      if (index === segments.length - 1 && expected === 'directory' && !stat.isDirectory()) return null;
      if (index === segments.length - 1 && expected === 'file' && !stat.isFile()) return null;
      if (index === segments.length - 1 && expected === 'any' && !stat.isDirectory() && !stat.isFile()) return null;
    }
    const real = await fs.promises.realpath(candidate);
    if (!isInside(root, real)) return null;
    const stat = await fs.promises.stat(real);
    if (expected === 'directory' && !stat.isDirectory()) return null;
    if (expected === 'file' && !stat.isFile()) return null;
    if (expected === 'any' && !stat.isDirectory() && !stat.isFile()) return null;
    return { path: real, stat };
  } catch {
    return null;
  }
}

interface EvidenceCacheEntry {
  summary: EvidenceFolder;
  files: EvidenceFile[];
}

const evidenceCache = new Map<string, EvidenceCacheEntry>();
const evidenceScans = new Map<string, Promise<EvidenceCacheEntry>>();
const SCAN_CONCURRENCY = 32;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

async function mapConcurrent<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await action(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listFiles(root: string, directory: string, recursive: boolean, prefix = ''): Promise<EvidenceFile[]> {
  let realDirectory: string;
  let names: string[];
  try {
    const directoryStat = await fs.promises.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return [];
    realDirectory = await fs.promises.realpath(directory);
    if (!isInside(root, realDirectory)) return [];
    names = await fs.promises.readdir(realDirectory);
  } catch {
    return [];
  }

  const children = await mapConcurrent(names, async (name): Promise<EvidenceFile[]> => {
    const absolute = path.join(realDirectory, name);
    let stat: fs.Stats;
    let real: string;
    try {
      stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) return [];
      real = await fs.promises.realpath(absolute);
      if (!isInside(root, real)) return [];
    } catch {
      return [];
    }

    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (stat.isDirectory()) return recursive ? listFiles(root, real, true, relativePath) : [];
    if (!stat.isFile()) return [];
    return [{ relative_path: relativePath, size: stat.size, modified_at: stat.mtime.toISOString(), kind: kindOf(name) }];
  });
  return children.flat();
}

function cacheKey(root: string, name: string): string {
  return `${root}\0${name}`;
}

function scanEvidence(root: string, name: string, directory: string, recursive: boolean): Promise<EvidenceCacheEntry> {
  const key = cacheKey(root, name);
  let scan = evidenceScans.get(key);
  if (!scan) {
    scan = (async () => {
      const files = await listFiles(root, directory, recursive);
      files.sort(comparePath);
      const result: EvidenceCacheEntry = { summary: summary(name, files), files };
      evidenceCache.set(key, result);
      return result;
    })().finally(() => evidenceScans.delete(key));
    evidenceScans.set(key, scan);
  }
  return scan;
}

async function getEvidenceCache(root: string, name: string, directory: string, recursive: boolean): Promise<EvidenceCacheEntry> {
  const cached = evidenceCache.get(cacheKey(root, name));
  if (cached) {
    void scanEvidence(root, name, directory, recursive).catch(() => undefined);
    return cached;
  }
  return scanEvidence(root, name, directory, recursive);
}

/** Tests can await the stale-while-revalidate work without adding a timing delay. */
export async function waitForEvidenceRefreshForTests(root: string, name?: string): Promise<void> {
  let canonicalRoot: string;
  try { canonicalRoot = await fs.promises.realpath(root); } catch { return; }
  const prefix = `${canonicalRoot}\0`;
  const pending = [...evidenceScans.entries()]
    .filter(([key]) => key.startsWith(prefix) && (name === undefined || key === cacheKey(canonicalRoot, name)))
    .map(([, promise]) => promise);
  await Promise.all(pending);
}

function pageOptions(request: FastifyRequest): { offset: number; limit: number } | null {
  const query = request.query as { offset?: string; limit?: string };
  if (query.offset === undefined && query.limit === undefined) return null;
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  const limit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return null;
  return { offset, limit: Math.min(limit, MAX_PAGE_SIZE) };
}

function hasPageOptions(request: FastifyRequest): boolean {
  const query = request.query as { offset?: string; limit?: string };
  return query.offset !== undefined || query.limit !== undefined;
}

function pruneCache(root: string, keep: Set<string>): void {
  const prefix = `${root}\0`;
  for (const key of evidenceCache.keys()) {
    if (key.startsWith(prefix) && !keep.has(key)) evidenceCache.delete(key);
  }
}

function comparePath(a: EvidenceFile, b: EvidenceFile): number {
  return a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0;
}

function summary(name: string, files: EvidenceFile[]): EvidenceFolder {
  const latest = files.reduce<string | null>((value, file) => value === null || file.modified_at > value ? file.modified_at : value, null);
  return { name, file_count: files.length, total_size: files.reduce((size, file) => size + file.size, 0), modified_at: latest };
}

export function registerEvidenceRoutes(app: FastifyInstance, dataDir: string): void {
  app.get(ROUTE, async () => {
    const root = await evidenceRoot(dataDir);
    if (!root) return [];
    let names: string[];
    try { names = await fs.promises.readdir(root); } catch { return []; }

    const keep = new Set<string>();
    let hasRootFiles = false;
    const folders = (await mapConcurrent(names, async (name): Promise<EvidenceFolder | null> => {
      const entry = await resolveEntry(root, [name], 'any');
      if (!entry) return null;
      if (entry.stat.isDirectory()) {
        keep.add(cacheKey(root, name));
        return (await getEvidenceCache(root, name, entry.path, true)).summary;
      }
      if (entry.stat.isFile()) hasRootFiles = true;
      return null;
    })).filter((folder): folder is EvidenceFolder => folder !== null);

    if (hasRootFiles) {
      keep.add(cacheKey(root, ROOT_ENTRY));
      folders.push((await getEvidenceCache(root, ROOT_ENTRY, root, false)).summary);
    }
    pruneCache(root, keep);
    return folders.sort((a, b) => (b.modified_at ?? '').localeCompare(a.modified_at ?? '') || a.name.localeCompare(b.name));
  });

  app.get<{ Params: { folder: string } }>(`${ROUTE}/:folder`, async (request, reply) => {
    const segments = requestSegments(request, 1, 1);
    const root = await evidenceRoot(dataDir);
    if (!segments || !root) return reply.code(404).send();
    const directory = segments[0] === ROOT_ENTRY ? { path: root } : await resolveEntry(root, segments, 'directory');
    if (!directory) return reply.code(404).send();
    const paged = hasPageOptions(request);
    const page = pageOptions(request);
    if (paged && !page) return reply.code(400).send({ error: 'Invalid evidence page' });
    const listing = await getEvidenceCache(root, segments[0]!, directory.path, segments[0] !== ROOT_ENTRY);
    if (!page) return listing.files;
    const files = listing.files.slice(page.offset, page.offset + page.limit);
    const nextOffset = page.offset + files.length;
    return { files, total: listing.files.length, next_offset: nextOffset < listing.files.length ? nextOffset : null };
  });

  app.get<{ Params: { folder: string; '*': string } }>(`${ROUTE}/:folder/*`, async (request, reply) => {
    const segments = requestSegments(request, 2);
    const root = await evidenceRoot(dataDir);
    if (!segments || !root) return reply.code(404).send();
    const folder = segments[0] === ROOT_ENTRY ? { path: root } : await resolveEntry(root, [segments[0]!], 'directory');
    if (!folder) return reply.code(404).send();
    const fileSegments = segments[0] === ROOT_ENTRY ? segments.slice(1) : segments;
    const file = await resolveEntry(root, fileSegments, 'file');
    if (!file) return reply.code(404).send();

    let handle: FileHandle | undefined;
    try {
      const canonical = await fs.promises.realpath(file.path);
      if (!isInside(root, canonical)) return reply.code(404).send();
      handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile()) {
        await handle.close();
        handle = undefined;
        return reply.code(404).send();
      }
    } catch {
      await handle?.close().catch(() => undefined);
      return reply.code(404).send();
    }
    if (!handle) return reply.code(404).send();

    const fileStat = await handle.stat();
    const kind = kindOf(file.path);
    reply.type(contentTypeOf(file.path));
    reply.header('Accept-Ranges', 'bytes');
    if (kind === 'html' || path.extname(file.path).toLowerCase() === '.svg') reply.header('Content-Security-Policy', 'sandbox allow-scripts');
    if (kind === 'other') reply.header('Content-Disposition', 'attachment');
    const range = byteRange(request.headers.range, fileStat.size);
    if (range === false) {
      await handle.close();
      handle = undefined;
      return reply.code(416).header('Content-Range', `bytes */${fileStat.size}`).send();
    }
    if (range) {
      const length = range.end - range.start + 1;
      return reply.code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`)
        .header('Content-Length', String(length))
        .send(handle.createReadStream({ start: range.start, end: range.end }));
    }
    return reply.send(handle.createReadStream());
  });
}
