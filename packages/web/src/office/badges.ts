import type { BoardResponse } from '@overseer/shared';
import type { Agent } from './types';

/**
 * The phone Office draws one small badge above each character instead of the full `harness · model · bead id` label.
 * The fill is the repository, the two-letter mark is the harness, a critic wears a ring, and the orchestrator (which
 * has no repository) is gold. Every mark is at least 4.5:1 on its fill (WCAG AA for small text):
 * white on #1d4ed8 6.70, #15803d 5.02, #7e22ce 6.98, #b91c1c 6.47, #0f766e 5.47, #c2410c 5.18, #be185d 6.04,
 * white on the unknown grey #4b5563 7.56, and #111827 on the orchestrator gold #fbbf24 10.63.
 */

/** Repository fills in the order the API lists the repositories: the first blue, the second green, then the rest; a ninth repository reuses the first colour. */
export const REPO_PALETTE = ['#1d4ed8', '#15803d', '#7e22ce', '#b91c1c', '#0f766e', '#c2410c', '#be185d'] as const;
export const MARK_INK = '#ffffff';
export const UNKNOWN_FILL = '#4b5563';
export const ORCHESTRATOR_FILL = '#fbbf24';
export const ORCHESTRATOR_INK = '#111827';

/** Two letters, because one would not tell Claude from Codex. */
export const HARNESS_MARK: Record<string, string> = { claude: 'CL', codex: 'CX', opencode: 'OC' };
export const HARNESS_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

export interface Badge {
  mark: string;
  fill: string;
  ink: string;
  kind: 'worker' | 'critic' | 'orchestrator' | 'unknown';
}

/** The repository ids in the order the board lists them. */
export function repoOrder(board: BoardResponse | null | undefined): string[] {
  return board?.repos.map((entry) => entry.repo.id) ?? [];
}

export function repoColor(repoId: string | null, order: readonly string[]): string | null {
  const index = repoId === null ? -1 : order.indexOf(repoId);
  return index < 0 ? null : REPO_PALETTE[index % REPO_PALETTE.length]!;
}

/** The badge for one character: an unknown harness, or a worker or critic whose repository the board does not list, is a grey `?`. */
export function badgeFor(agent: Pick<Agent, 'role' | 'harness' | 'repoId'>, order: readonly string[]): Badge {
  const mark = HARNESS_MARK[agent.harness];
  if (mark && agent.role === 'orchestrator') return { mark, fill: ORCHESTRATOR_FILL, ink: ORCHESTRATOR_INK, kind: 'orchestrator' };
  const fill = repoColor(agent.repoId, order);
  if (!mark || !fill) return { mark: '?', fill: UNKNOWN_FILL, ink: MARK_INK, kind: 'unknown' };
  return { mark, fill, ink: MARK_INK, kind: agent.role === 'critic' ? 'critic' : 'worker' };
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * What the key under the phone room lists: `orchestrator` when the orchestrator's gold pill is present, only the
 * repositories and harnesses of the characters present, in palette and harness order, and `unknown` when a grey `?`
 * badge (an unknown harness or unlisted repository, an orchestrator with an unknown harness too) is present.
 */
export function badgeKey(agents: readonly Pick<Agent, 'role' | 'harness' | 'repoId' | 'pose'>[], order: readonly string[]): {
  repos: { id: string; fill: string }[];
  harnesses: { mark: string; name: string }[];
  unknown: boolean;
  orchestrator: boolean;
} {
  const present = agents.filter((agent) => agent.pose !== 'leaving');
  const badges = present.map((agent) => badgeFor(agent, order));
  const repoIds = new Set(present.filter((agent, i) => badges[i]!.kind === 'worker' || badges[i]!.kind === 'critic').map((agent) => agent.repoId!));
  const harnesses = new Set(present.filter((_, i) => badges[i]!.kind !== 'unknown').map((agent) => agent.harness));
  return {
    repos: order.filter((id) => repoIds.has(id)).map((id) => ({ id, fill: repoColor(id, order)! })),
    harnesses: Object.keys(HARNESS_MARK).filter((harness) => harnesses.has(harness)).map((harness) => ({ mark: HARNESS_MARK[harness]!, name: HARNESS_NAME[harness]! })),
    unknown: badges.some((badge) => badge.kind === 'unknown'),
    orchestrator: badges.some((badge) => badge.kind === 'orchestrator'),
  };
}
