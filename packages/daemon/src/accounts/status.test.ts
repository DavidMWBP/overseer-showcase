import { describe, expect, it } from 'vitest';
import { AUTH_HOLD_UNTIL, clearAuthHold } from './status';

describe('clearAuthHold', () => {
  it('lifts an authentication hold and leaves a usage-limit reset in place', () => {
    expect(clearAuthHold({ exhausted_until: AUTH_HOLD_UNTIL })).toEqual({ exhausted_until: null });
    const reset = Date.now() + 60_000;
    expect(clearAuthHold({ exhausted_until: reset })).toEqual({});
    expect(clearAuthHold({ exhausted_until: null })).toEqual({});
    expect(clearAuthHold({})).toEqual({});
  });
});
