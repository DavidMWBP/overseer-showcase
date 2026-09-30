import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig, promptsDirFrom } from './config';

describe('loadConfig', () => {
  it('uses defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(4400);
    expect(c.dataDir.endsWith('.overseer')).toBe(true);
    expect(c.bdBin).toBe('bd');
    expect(c.orchestratorIdleMs).toBe(1_800_000);
    expect(c.usageThresholdPercent).toBe(95);
    expect(c.usageReservePerSessionPercent).toBe(2);
  });
  it('decodes %20 in the module URL to a real space in promptsDir', () => {
    const dir = promptsDirFrom(process.platform === 'win32' ? 'file:///C:/my%20apps/overseer/src/config.ts' : 'file:///opt/my%20apps/overseer/src/config.ts');
    expect(dir).toContain(`my apps${path.sep}overseer${path.sep}prompts`);
    expect(dir).not.toContain('%20');
  });
  it('reads overrides from env', () => {
    const c = loadConfig({ OVERSEER_PORT: '5000', OVERSEER_DATA_DIR: '/tmp/ov', OVERSEER_BD: '/x/bd', OVERSEER_USAGE_RESERVE_PER_SESSION: '3' });
    expect(c.port).toBe(5000);
    expect(c.dataDir).toBe('/tmp/ov');
    expect(c.bdBin).toBe('/x/bd');
    expect(c.usageReservePerSessionPercent).toBe(3);
  });
  it.each(['', ' ', 'NaN', 'Infinity', '-1'])('defaults invalid per-session usage reserves to 2 for %j', (value) => {
    expect(loadConfig({ OVERSEER_USAGE_RESERVE_PER_SESSION: value }).usageReservePerSessionPercent).toBe(2);
  });
  it('allows a zero per-session usage reserve', () => {
    expect(loadConfig({ OVERSEER_USAGE_RESERVE_PER_SESSION: '0' }).usageReservePerSessionPercent).toBe(0);
  });
  it('reads the orchestrator idle window in minutes', () => {
    expect(loadConfig({ OVERSEER_ORCHESTRATOR_IDLE_MIN: '5' }).orchestratorIdleMs).toBe(300_000);
  });
  it('reads the stall threshold in minutes, defaulting to 15, and takes 0 as off', () => {
    expect(loadConfig({}).stallMs).toBe(900_000);
    expect(loadConfig({ OVERSEER_STALL_MIN: '5' }).stallMs).toBe(300_000);
    expect(loadConfig({ OVERSEER_STALL_MIN: '0' }).stallMs).toBe(0);
  });
  it('reads the idle-end threshold in minutes, defaulting to 3, and takes 0 as off', () => {
    expect(loadConfig({}).idleEndMs).toBe(180_000);
    expect(loadConfig({ OVERSEER_IDLE_END_MIN: '5' }).idleEndMs).toBe(300_000);
    expect(loadConfig({ OVERSEER_IDLE_END_MIN: '0' }).idleEndMs).toBe(0);
  });
  it('reads the retention window in days, defaulting to 14 and refusing a blank, zero, negative or nonnumeric value', () => {
    expect(loadConfig({}).retentionDays).toBe(14);
    expect(loadConfig({ OVERSEER_RETENTION_DAYS: '7' }).retentionDays).toBe(7);
    // A blank or mistyped value becomes 0 (blank) or NaN (text), and a negative one a cutoff later than now, any of which
    // would delete recent ended sessions irreversibly; each falls back to the safe default instead.
    expect(loadConfig({ OVERSEER_RETENTION_DAYS: '' }).retentionDays).toBe(14);
    expect(loadConfig({ OVERSEER_RETENTION_DAYS: '0' }).retentionDays).toBe(14);
    expect(loadConfig({ OVERSEER_RETENTION_DAYS: '-3' }).retentionDays).toBe(14);
    expect(loadConfig({ OVERSEER_RETENTION_DAYS: 'soon' }).retentionDays).toBe(14);
  });
});
