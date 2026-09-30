import type { BoardResponse, OfficeState } from '@overseer/shared';
import { badgeFor, badgeKey, HARNESS_NAME, MARK_INK, ORCHESTRATOR_FILL, UNKNOWN_FILL } from './badges';
import { stalledAt } from './config';
import type { Agent } from './types';

const STATE_TEXT: Record<OfficeState, string> = { walking_in: 'arriving', working: 'working', verifying: 'verifying', reviewing: 'reviewing', leaving: 'leaving' };
const ROLE_TEXT: Record<string, string> = { worker: 'worker', critic: 'critic (review)', orchestrator: 'orchestrator' };

/** The batch title the board carries for this batch id, or null. */
export function batchTitle(board: BoardResponse | null | undefined, batchId: string | null): string | null {
  if (!board || !batchId) return null;
  for (const entry of board.repos) {
    const batch = entry.batches.find((candidate) => candidate.id === batchId);
    if (batch) return batch.title;
  }
  return null;
}

/**
 * The phone card for one character, from the bottom of the screen: what the badge abbreviates, plus a link that does
 * what a desktop click on the character does (the Office opener: the task pane for a task, Chat for the orchestrator).
 * Office keeps one open at a time and closes it on an outside tap, Escape, or when the session ends.
 */
export function AgentCard({ agent, board, repoOrder, link, onClose }: {
  agent: Agent;
  board: BoardResponse | null | undefined;
  repoOrder: readonly string[];
  link: { text: string; onOpen: () => void } | null;
  onClose: () => void;
}) {
  const badge = badgeFor(agent, repoOrder);
  const model = agent.resolvedModel ?? agent.model;
  const state = STATE_TEXT[agent.state] + (agent.stalled && agent.stalledSince ? `, stalled since ${stalledAt(agent.stalledSince)}` : '');
  const fields: [string, string][] = [
    ['Harness', HARNESS_NAME[agent.harness] ?? agent.harness],
    ['Model', model ?? 'not reported'],
    ['Task', agent.beadId ?? 'none'],
    ['Batch', batchTitle(board, agent.batchId) ?? 'none'],
    ['Repository', agent.repoId ?? 'none'],
    ['Role', ROLE_TEXT[agent.role] ?? agent.role],
    ['State', state],
  ];
  return (
    <section className="office-card" role="dialog" aria-label={`Details of ${agent.labelText}`}>
      <header className="office-card-head">
        <span className={`office-badge office-badge-${badge.kind} office-card-badge`} aria-hidden="true" style={{ background: badge.fill, color: badge.ink }}>{badge.mark}</span>
        <strong className="office-card-title">{agent.beadTitle ?? ROLE_TEXT[agent.role] ?? agent.role}</strong>
        <button type="button" className="office-card-close" aria-label="Close details" onClick={onClose}>×</button>
      </header>
      <dl className="office-card-fields">
        {fields.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}
      </dl>
      {link && <button type="button" className="office-card-link" onClick={link.onOpen}>{link.text}</button>}
    </section>
  );
}

/**
 * The key under the phone room, wrapping onto more lines as needed: the orchestrator's gold pill when it is shown, each
 * present repository colour and harness mark, and the grey `?` when one is shown; nothing when no character is present.
 */
export function BadgeKey({ agents, repoOrder }: { agents: readonly Agent[]; repoOrder: readonly string[] }) {
  const key = badgeKey(agents, repoOrder);
  if (!key.orchestrator && key.repos.length === 0 && key.harnesses.length === 0 && !key.unknown) return null;
  return (
    <p className="office-badge-key" aria-label="Badge key">
      {key.orchestrator && (
        <span className="office-key-item" data-key-orchestrator=""><span className="office-key-orchestrator" style={{ background: ORCHESTRATOR_FILL }} aria-hidden="true" />orchestrator</span>
      )}
      {key.repos.map((repo) => (
        <span key={repo.id} className="office-key-item" data-key-repo={repo.id}><span className="office-key-swatch" style={{ background: repo.fill }} aria-hidden="true" />{repo.id}</span>
      ))}
      {key.harnesses.map((harness) => (
        <span key={harness.mark} className="office-key-item" data-key-harness={harness.mark}><b>{harness.mark}</b> {harness.name}</span>
      ))}
      {key.unknown && (
        <span className="office-key-item" data-key-unknown=""><span className="office-key-unknown" style={{ background: UNKNOWN_FILL, color: MARK_INK }} aria-hidden="true">?</span>unknown</span>
      )}
    </p>
  );
}
