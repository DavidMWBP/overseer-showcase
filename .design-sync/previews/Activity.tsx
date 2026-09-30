import { Activity } from '@overseer/web';

// The card page is white; Overseer is dark-only, so every story sits on the app background.
const dark = (children: React.ReactNode) => <div style={{ background: "var(--bg)", color: "var(--text)", padding: 16, borderRadius: 6 }}>{children}</div>;

const running = (id: string, title: string, elapsed_ms: number, cost: number | null, state = 'running') => ({
  bead: { id, title, labels: [] }, column: 'running' as const, state, elapsed_ms, cost,
});

export const FourRunning = () => dark(
  <Activity cards={[
    running('overseer-4fq', 'Add day separators to the chat thread', 1_260_000, 0.84),
    running('overseer-9ht', 'Show the batch pill as a side panel in place', 2_940_000, 1.92),
    running('overseer-2xp', 'Cap vitest workers at four forks', 420_000, null),
    running('overseer-5rk', 'Keep the reading position across a view change', 180_000, 0.11, 'settling'),
  ]} />
);

export const Refreshing = () => dark(
  <Activity refreshing cards={[running('overseer-7cw', 'Refresh the OAuth token before a session starts', 900_000, 0.37)]} />
);

export const NoneRunning = () => dark(<Activity cards={[]} />);
