import type { Bead, BeadsMode } from '@overseer/shared';
import fs from 'node:fs';
import path from 'node:path';
import { runCapture } from '../util/procs';
import { PHASE_PREFIX, PHASES, type BeadPatch, type BlockedBead, type TaskStore } from './store';

export type BdRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** How long a `list` is served from memory when nothing in the repo's `.beads` moved. */
export const LIST_TTL_MS = 2000;
/**
 * The `.beads` files bd rewrites on a mutation: `last-touched` (the last bead it touched) and `interactions.jsonl` (the audit
 * trail of field changes and closes). Between them they cover create, update, note, label and close; `bd show` (a read) also
 * bumps `last-touched`, which only costs a refetch, and `bd dep add` writes no file of its own, so the TTL backstops it.
 */
const TOUCH_FILES = ['last-touched', 'interactions.jsonl'];

export class BdError extends Error {
  constructor(args: string[], detail: string) { super(`bd ${args.join(' ')} failed: ${detail.trim()}`); }
}

export function bdRunner(bin: string): BdRunner {
  return (cwd, args) => runCapture(bin, args, { cwd });
}

/** bd answers labels as strings, or as objects with a `label`/`name` key. */
export function labelNames(raw: unknown): string[] {
  const labelsRaw = Array.isArray(raw) ? raw : [];
  return labelsRaw.map((l) => (typeof l === 'string' ? l : String((l as { label?: string; name?: string }).label ?? (l as { name?: string }).name ?? ''))).filter(Boolean);
}

export function parseBead(raw: Record<string, unknown>): Bead {
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    status: (raw.status as Bead['status']) ?? 'open',
    priority: Number(raw.priority ?? 2),
    labels: labelNames(raw.labels),
    notes: String(raw.notes ?? ''),
    assignee: raw.assignee ? String(raw.assignee) : null,
    closed_at: raw.closed_at ? String(raw.closed_at) : null,
    dependency_count: Number(raw.dependency_count ?? 0),
  };
}

/**
 * bd commands that only read the database: they may run alongside each other, and none of them changes what the Board shows.
 * The `bd` MCP tool refreshes the Board after every command that is not one of these (fix round 22 review M-2: two lists).
 */
export const BD_READS = new Set(['list', 'show', 'ready', 'blocked', 'stats', 'search', 'export', 'version']);
const settled = (p: Promise<unknown>) => p.catch(() => undefined);

export class Beads implements TaskStore {
  // Per repo, reads run alongside each other and writes run alone, each after every earlier call. The board's `list` then
  // waits only behind writes (about half a second each), not behind the orchestrator's list_tasks or show calls.
  private writeTail = new Map<string, Promise<unknown>>();
  private reads = new Map<string, Set<Promise<unknown>>>();
  private availableUntil = 0;
  // A board build's `bd list` is the expensive read (1.35 MB for this repo) and a websocket message re-runs it; the last
  // result is kept per repo until a write or a change on disk says it is stale (the board's own `coalesced` shares one
  // build between concurrent callers, so a burst of messages costs one bd read).
  private listCache = new Map<string, { beads: Bead[]; at: number; signal: number }>();
  constructor(private run: BdRunner) {}

  /** Newest mtime among the `.beads` files bd rewrites on a mutation; 0 when neither exists (no-db or not initialised yet). */
  private signal(repoPath: string): number {
    let newest = 0;
    for (const f of TOUCH_FILES) {
      try { newest = Math.max(newest, fs.statSync(path.join(repoPath, '.beads', f)).mtimeMs); } catch { /* absent */ }
    }
    return newest;
  }

  async available(): Promise<boolean> {
    if (Date.now() < this.availableUntil) return true;
    try {
      const ok = (await this.run('.', ['--version'])).code === 0;
      if (ok) this.availableUntil = Date.now() + 60_000;
      return ok;
    } catch { return false; }
  }

  async init(repoPath: string, prefix: string, mode: BeadsMode): Promise<void> {
    const args = ['init', '--prefix', prefix, '--non-interactive', ...(mode === 'stealth' ? ['--stealth'] : [])];
    const r = await this.run(repoPath, args);
    if (r.code !== 0) throw new Error(`bd init failed: ${(r.stderr || r.stdout).trim()}`);
    this.listCache.delete(repoPath);
  }

  async exec(repoPath: string, args: string[]): Promise<unknown> {
    const job = async () => {
      const r = await this.run(repoPath, [...args, '--json']);
      if (r.code !== 0) throw new BdError(args, r.stderr || r.stdout);
      const text = r.stdout.trim();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    };
    const afterWrites = settled(this.writeTail.get(repoPath) ?? Promise.resolve());
    if (BD_READS.has(args[0]!)) {
      const p = afterWrites.then(job);
      let set = this.reads.get(repoPath);
      if (!set) { set = new Set(); this.reads.set(repoPath, set); }
      set.add(p);
      void settled(p).then(() => set.delete(p));
      return p;
    }
    const next = Promise.all([afterWrites, ...[...(this.reads.get(repoPath) ?? [])].map(settled)]).then(job);
    this.writeTail.set(repoPath, next);
    // A write changes what a cached `list` would return: drop it now, and again once the write has run, because a `list`
    // that started before it can store its own result while the write waits for that read.
    this.listCache.delete(repoPath);
    void settled(next).then(() => this.listCache.delete(repoPath));
    return next;
  }

  async list(repoPath: string): Promise<Bead[]> {
    const cached = this.listCache.get(repoPath);
    if (cached && Date.now() - cached.at < LIST_TTL_MS && this.signal(repoPath) === cached.signal) return cached.beads;
    const rows = (await this.exec(repoPath, ['list', '--all', '-n', '0'])) as unknown[] | null;
    const beads = (rows ?? []).map((r) => parseBead(r as Record<string, unknown>));
    this.listCache.set(repoPath, { beads, at: Date.now(), signal: this.signal(repoPath) });
    return beads;
  }

  async ready(repoPath: string): Promise<string[]> {
    const rows = (await this.exec(repoPath, ['ready'])) as { id: string }[] | null;
    return (rows ?? []).map((r) => r.id);
  }

  /**
   * `bd show` reports only a dependent count and `bd list` only how many beads one waits on, not which (round 25 R25-4); `bd blocked`
   * lists every blocked bead with its blockers, so this one read carries both directions (`dependentsOf`, `blockersOf`).
   */
  async blocked(repoPath: string): Promise<BlockedBead[]> {
    const rows = (await this.exec(repoPath, ['blocked'])) as { id: string; blocked_by?: string[] }[] | null;
    return (rows ?? []).map((r) => ({ id: r.id, blocked_by: r.blocked_by ?? [] }));
  }

  async show(repoPath: string, id: string): Promise<Bead | null> {
    try {
      const r = (await this.exec(repoPath, ['show', id])) as Record<string, unknown> | Record<string, unknown>[] | null;
      const one = Array.isArray(r) ? r[0] : r;
      return one ? parseBead(one) : null;
    } catch (e) {
      // bd 1.2.2 answers an unknown id with exit 1 and `no issue found matching "<id>"` (older builds said "not found"): not-found, not a failure (round 15).
      if (e instanceof BdError && /not found|no issues? found/i.test(e.message)) return null;
      throw e;
    }
  }

  async update(repoPath: string, id: string, patch: BeadPatch): Promise<void> {
    const args = ['update', id];
    if (patch.status) args.push('--status', patch.status);
    if (patch.phase !== undefined) {
      // The daemon is the only writer of overseer:* labels and bd 1.2.2 treats removing an absent label as a no-op, so the
      // other phases are removed blindly instead of reading the bead first.
      for (const p of PHASES) if (p !== patch.phase) args.push('--remove-label', `${PHASE_PREFIX}${p}`);
      if (patch.phase) args.push('--add-label', `${PHASE_PREFIX}${patch.phase}`);
    }
    if (patch.note) args.push('--append-notes', patch.note);
    await this.exec(repoPath, args);
  }

  async close(repoPath: string, id: string, reason: string, opts?: { force?: boolean }): Promise<void> {
    await this.exec(repoPath, ['close', id, '--reason', reason, ...(opts?.force ? ['--force'] : [])]);
  }

  async create(repoPath: string, b: { title: string; description: string; labels: string[]; blockedBy: string[] }): Promise<string> {
    // --title and --description= keep a title or description starting with '-' (e.g. "--help") from being read as a flag.
    const args = ['create', '--title', b.title, `--description=${b.description}`];
    if (b.labels.length) args.push('--labels', b.labels.join(','));
    if (b.blockedBy.length) args.push('--deps', b.blockedBy.map((id) => `blocked-by:${id}`).join(','));
    const out = (await this.exec(repoPath, args)) as { id?: unknown } | null;
    if (typeof out?.id !== 'string' || !out.id) throw new Error(`bd create "${b.title}" answered without an id`);
    return out.id;
  }

  raw(repoPath: string, args: string[]): Promise<unknown> {
    return this.exec(repoPath, args.filter((a) => a !== '--json'));
  }
}
