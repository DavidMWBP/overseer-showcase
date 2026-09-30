import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLog, log } from './log';

describe('log', () => {
  it('appends JSON lines once a file is set', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-log-')), 'daemon.log');
    initLog(file);
    const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try { log.error('boom', { a: 1 }); log.warn('careful'); } finally { spies.forEach((sp) => sp.mockRestore()); }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', a: 1 });
    expect(lines[1]).toMatchObject({ level: 'warn', msg: 'careful' });
    expect(typeof lines[0].ts).toBe('string');
    initLog(null);
  });

  it('does not throw on unserialisable data', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-log-')), 'daemon.log');
    initLog(file);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(() => log.info('loop', circular)).not.toThrow(); } finally { spy.mockRestore(); }
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(line).toMatchObject({ level: 'info', msg: 'loop', error: 'unserialisable log data' });
    initLog(null);
  });
});
