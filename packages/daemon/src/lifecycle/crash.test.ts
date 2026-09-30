import { describe, expect, it } from 'vitest';
import { classifyExit, isAuthFailure } from './crash';

const CLAP = "error: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS] <COMMAND> [ARGS]\n\nFor more information, try '--help'.\n";

describe('classifyExit', () => {
  it.each([
    ['codex exited with code 2', CLAP, 'harness_bug'],
    ['codex exited with code 2', "       codex exec [OPTIONS] <COMMAND> [ARGS]\nFor more information, try '--help'.\n", 'harness_bug'],
    ['event stream failed: codex session 5ba969b9 closed', 'Reading additional input from stdin...', 'transient'],
    ['event stream failed: socket hang up', null, 'transient'],
    ['codex exited with code 1', 'ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines', 'task'],
    ['codex exited with code 1', 'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected', 'task'],
    ['codex exited with code 1', null, 'task'],
    ['no output', null, 'task'],
    ['Failed to authenticate. API Error: 401 OAuth access token has been revoked.', null, 'auth'],
    ['claude exited with code 1', 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', 'auth'],
    ['HTTP 401 from the proxy', null, 'task'],
    ['OAuth access token expired', null, 'task'],
  ])('%s → %s', (reason, stderr, expected) => {
    expect(classifyExit(reason, stderr)).toBe(expected);
  });

  it('does not classify auth from text when authFromText is false (an account session trusts only the structured signal)', () => {
    expect(classifyExit('Failed to authenticate. API Error: 401 OAuth access token has been revoked.', null, false)).toBe('task');
    expect(classifyExit('claude exited with code 1', 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', false)).toBe('task');
  });
});

describe('isAuthFailure', () => {
  it('needs both a 401 and an OAuth or authentication word, case-insensitively', () => {
    expect(isAuthFailure('Failed to authenticate. API Error: 401 OAuth access token has been revoked.')).toBe(true);
    expect(isAuthFailure('HTTP 401: oauth token rejected')).toBe(true);
    expect(isAuthFailure('401 from the proxy')).toBe(false);
    expect(isAuthFailure('OAuth access token has been revoked.')).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
    expect(isAuthFailure('')).toBe(false);
  });
});
