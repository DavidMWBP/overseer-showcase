import fs from 'node:fs';
import path from 'node:path';
import type { Bead, BeadsMode } from '@overseer/shared';
import { PHASE_PREFIX, PHASES, type BeadPatch, type TaskStore } from './store';

export class MemoryTaskStore implements TaskStore {
  private repos = new Map<string, Map<string, Bead & { deps: string[] }>>();
  unavailable = false;
  inits: { repoPath: string; prefix: string; mode: BeadsMode }[] = [];
  failInit: string | null = null;
  /** A test sets this to make the create of the bead with this title fail, as a refused bd write would. */
  failCreate: string | null = null;
  private created = 0;

  add(repoPath: string, bead: Partial<Bead> & { id: string }, deps: string[] = []): Bead {
    const full = { title: bead.id, description: '', status: 'open' as const, priority: 2, labels: [], notes: '', assignee: null, closed_at: null, dependency_count: deps.length, ...bead, deps };
    this.repo(repoPath).set(bead.id, full);
    return full;
  }
  async available() { return !this.unavailable; }
  async init(repoPath: string, prefix: string, mode: BeadsMode): Promise<void> {
    if (this.failInit) throw new Error(`bd init failed: ${this.failInit}`);
    this.inits.push({ repoPath, prefix, mode });
    fs.mkdirSync(path.join(repoPath, '.beads'), { recursive: true });
  }
  async list(repoPath: string) { return [...this.repo(repoPath).values()].map(strip); }
  async ready(repoPath: string) {
    const all = this.repo(repoPath);
    return [...all.values()].filter((b) => b.status === 'open' && b.deps.every((d) => all.get(d)?.status === 'closed')).map((b) => b.id);
  }
  async blocked(repoPath: string) {
    const all = this.repo(repoPath);
    return [...all.values()].filter((b) => b.status !== 'closed')
      .map((b) => ({ id: b.id, blocked_by: b.deps.filter((d) => all.get(d)?.status !== 'closed') }))
      .filter((b) => b.blocked_by.length > 0); // `bd blocked` lists the blocked beads only
  }
  async show(repoPath: string, id: string) { const b = this.repo(repoPath).get(id); return b ? strip(b) : null; }
  async update(repoPath: string, id: string, patch: BeadPatch) {
    const b = this.must(repoPath, id);
    if (patch.status) b.status = patch.status;
    if (patch.phase !== undefined) {
      b.labels = b.labels.filter((l) => !PHASES.some((p) => l === `${PHASE_PREFIX}${p}`)); // the batch label shares the prefix and stays
      if (patch.phase) b.labels.push(`${PHASE_PREFIX}${patch.phase}`);
    }
    if (patch.note) b.notes = b.notes ? `${b.notes}\n${patch.note}` : patch.note;
  }
  async close(repoPath: string, id: string, reason: string, opts?: { force?: boolean }) {
    const all = this.repo(repoPath);
    const b = this.must(repoPath, id);
    // bd 1.2.2 refuses this: `cannot close <id>: blocked by open issues [<ids>] (use --force to override)`.
    const open = b.deps.filter((d) => all.get(d)?.status !== 'closed');
    if (open.length > 0 && !opts?.force) throw new Error(`cannot close ${id}: blocked by open issues [${open.join(' ')}] (use --force to override)`);
    b.status = 'closed'; b.closed_at = new Date().toISOString(); b.notes += `\nclosed: ${reason}`;
  }
  async create(repoPath: string, b: { title: string; description: string; labels: string[]; blockedBy: string[] }): Promise<string> {
    if (this.failCreate === b.title) throw new Error(`bd create failed for "${b.title}"`);
    const id = `ov-n${++this.created}`;
    this.add(repoPath, { id, title: b.title, description: b.description, labels: [...b.labels] }, [...b.blockedBy]);
    return id;
  }
  async raw(repoPath: string, args: string[]): Promise<unknown> {
    if (args[0] === 'show') {
      const b = this.repo(repoPath).get(args[1] as string);
      if (!b) throw new Error(`bead ${args[1]} not found`);
      return strip(b);
    }
    if (args[0] === 'list') return [...this.repo(repoPath).values()].map(strip);
    throw new Error(`raw bd "${args[0]}" is not supported by MemoryTaskStore`);
  }

  private repo(p: string) { let r = this.repos.get(p); if (!r) { r = new Map(); this.repos.set(p, r); } return r; }
  private must(p: string, id: string) { const b = this.repo(p).get(id); if (!b) throw new Error(`bead ${id} not found`); return b; }
}

function strip(b: Bead & { deps: string[] }): Bead { const { deps: _d, ...rest } = b; return { ...rest, labels: [...rest.labels] }; }
