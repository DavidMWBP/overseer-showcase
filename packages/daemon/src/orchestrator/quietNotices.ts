/**
 * The notice kinds the orchestrator prompt says need no action. They are written to the chat like any notice but start no
 * turn: they wait in the queue and travel with the next turn, under `Since your last turn`. A kind not listed here is a turn.
 */
const QUIET: RegExp[] = [
  /^\S+ re-dispatched: .+ exhausted until .+, now on .+\.$/,
  /^\S+ evidence gate found \d+ problem\(s\); re-dispatched to /,
  /^\S+ re-dispatched after a transient stream failure on /,
  /^\S+ resumed after its login token rolled over on /,
  /^Batch \S+ no longer waits: /,
  /^Batch \S+ now uses base \S+ \(was \S+\); MR .+\.$/,
  /^Batch \S+ merged on GitLab \(!\d+\); recorded\.$/,
  /^GitLab MR polling failed: ".+"$/,
  /^GitLab MR polling recovered\.$/,
  /^Stopped \d+ process\(es\) left running in /,
  /^\S+: its review round prompt did not fit the critic's harness: /,
];

export function isQuietNotice(text: string): boolean {
  return QUIET.some((re) => re.test(text));
}

/** The block a turn's message opens with for the quiet notices since the previous turn. */
export function sinceLastTurn(rows: { text: string; hint?: string | null }[]): string {
  return `[Overseer] Since your last turn:\n${rows.map((q) => `- ${q.text}${q.hint ? ` ${q.hint}` : ''}`).join('\n')}`;
}
