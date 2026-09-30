import { describe, it, expect } from 'vitest';
import { runVerify } from './verify';

describe('runVerify', () => {
  it('passes with no command', async () => {
    expect(await runVerify(null, '.')).toMatchObject({ status: 'pass' });
  });
  it('captures output and exit code', async () => {
    const ok = await runVerify(`node -e "console.log('fine')"`, '.');
    expect(ok.status).toBe('pass');
    expect(ok.output).toContain('fine');
    const bad = await runVerify(`node -e "console.error('boom');process.exit(2)"`, '.');
    expect(bad.status).toBe('fail');
    expect(bad.output).toContain('boom');
    expect(bad.output).toContain('exit 2');
  });
  it('times out', async () => {
    const r = await runVerify(`node -e "setTimeout(()=>{},5000)"`, '.', 200);
    expect(r.status).toBe('fail');
    expect(r.output).toContain('timed out');
  });
});
