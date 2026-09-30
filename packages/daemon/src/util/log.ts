import fs from 'node:fs';
import path from 'node:path';

let file: string | null = null;
export function initLog(f: string | null): void { file = f; if (f) fs.mkdirSync(path.dirname(f), { recursive: true }); }

type Level = 'debug' | 'info' | 'warn' | 'error';
function write(level: Level, msg: string, data?: Record<string, unknown> | unknown): void {
  const extra = data instanceof Error ? { error: data.message, stack: data.stack } : (data as Record<string, unknown> | undefined) ?? {};
  let line: string;
  try { line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }); }
  catch { line = JSON.stringify({ ts: new Date().toISOString(), level, msg, error: 'unserialisable log data' }); }
  if (file) { try { fs.appendFileSync(file, line + '\n'); } catch { /* disk problems must not take the daemon down */ } }
  if (level === 'debug') return; // debug lines go to the file only
  (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(msg, data ?? '');
}
export const log = {
  debug: (msg: string, data?: unknown) => write('debug', msg, data),
  info: (msg: string, data?: unknown) => write('info', msg, data),
  warn: (msg: string, data?: unknown) => write('warn', msg, data),
  error: (msg: string, data?: unknown) => write('error', msg, data),
};
