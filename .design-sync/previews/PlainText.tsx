import { PlainText } from '@overseer/web';

export const ReviewNote = () => (
  <p style={{ whiteSpace: 'pre-wrap', maxWidth: 560, margin: 0, padding: 16, background: 'var(--bg)', borderRadius: 6 }}>
    <PlainText text={'**Summary**: all three beads landed. The chart reads `GET /api/usage` and folds a seventh model into "Other".\n\nVerified with `pnpm --filter @overseer/web test`.'} />
  </p>
);

export const WithTable = () => (
  <div style={{ whiteSpace: 'pre-wrap', maxWidth: 560, padding: 16, background: 'var(--bg)', borderRadius: 6 }}>
    <PlainText tables text={'Critic findings, round 1:\n\n| Severity | File | Finding |\n|---|---|---|\n| must | `src/accounts.ts` | Expiry check ignores the two-hour window |\n| should | `src/routing/tiers.ts` | Log the skipped candidate with its reason |\n\nRe-dispatched with both findings.'} />
  </div>
);
