import { describe, it, expect } from 'vitest';
import { isQuietNotice, sinceLastTurn } from './quietNotices';

describe('isQuietNotice', () => {
  it('is quiet for an account-exhaustion re-dispatch that found another account', () => {
    expect(isQuietNotice('ov-1 re-dispatched: account Work exhausted until 14:00 UTC, now on Home.')).toBe(true);
  });
  it('is not quiet for an account-exhaustion re-dispatch that found nothing usable', () => {
    expect(isQuietNotice('ov-1 re-dispatched: account Work exhausted until 14:00 UTC, no usable account left; waiting.')).toBe(false);
    expect(isQuietNotice('ov-1 re-dispatched: account Work exhausted until 14:00 UTC, and no harness left is usable: x.')).toBe(false);
  });
  it('is quiet for a re-dispatch after a transient stream failure', () => {
    expect(isQuietNotice('ov-1 re-dispatched after a transient stream failure on claude (event stream failed: reset).')).toBe(true);
  });
  it('is quiet when the evidence gate automatically re-dispatches a worker', () => {
    expect(isQuietNotice('ov-1 evidence gate found 1 problem(s); re-dispatched to codex terra:\n1. The report contains no Parity line.')).toBe(true);
  });
  it('is quiet for a session resumed after its login token rolled over', () => {
    expect(isQuietNotice('ov-1 resumed after its login token rolled over on claude account Work.')).toBe(true);
  });
  it('is quiet for a batch released from its overlap hold', () => {
    expect(isQuietNotice('Batch r1-b1 no longer waits: r1-b0 left review, so its Merge is available.')).toBe(true);
  });
  it('is quiet for a stacked batch retargeted after its parent merged', () => {
    expect(isQuietNotice('Batch r1-b2 now uses base dev (was feature/parent); MR https://gitlab.example.com/group/proj/-/merge_requests/12.')).toBe(true);
  });
  it('queues GitLab merge records and polling health changes for the next turn', () => {
    expect(isQuietNotice('Batch r1-b2 merged on GitLab (!12); recorded.')).toBe(true);
    expect(isQuietNotice('GitLab MR polling failed: "connection refused"')).toBe(true);
    expect(isQuietNotice('GitLab MR polling recovered.')).toBe(true);
  });
  it('is quiet for leftover processes stopped in a worktree', () => {
    expect(isQuietNotice('Stopped 2 process(es) left running in C:/wt/r1/ov-1: 11 (node dev); 12 (chrome)')).toBe(true);
  });
  it('is quiet for a review round prompt that did not fit the critic harness', () => {
    expect(isQuietNotice("ov-1: its review round prompt did not fit the critic's harness: the diff.")).toBe(true);
  });
  it('is not quiet for an unknown kind, an empty text or a quiet phrase that does not start the notice', () => {
    expect(isQuietNotice('ov-1 reopened: verification failed')).toBe(false);
    expect(isQuietNotice('')).toBe(false);
    expect(isQuietNotice('Note: Batch r1-b1 no longer waits: x')).toBe(false);
  });
});

describe('sinceLastTurn', () => {
  it('writes one line per notice with its hint', () => {
    expect(sinceLastTurn([{ text: 'a', hint: 'Do nothing.' }, { text: 'b', hint: null }])).toBe('[Overseer] Since your last turn:\n- a Do nothing.\n- b');
  });
});
