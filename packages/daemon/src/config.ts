import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_TOKEN_URL } from './accounts/login';

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  worktreesDir: string;
  orchestratorDir: string;
  /** One stdio log per harness session, tailed by the daemon; a restarted daemon adopts running workers from it. */
  sessionsDir: string;
  /** The nightly count's plain-text rendering, one file per day. */
  reportsDir: string;
  orchestratorIdleMs: number;
  /** Milliseconds of silence after which a running worker or critic is reported as stalled; 0 turns the sweep off. */
  stallMs: number;
  /** Milliseconds of silence after a worker's turn end (with a non-empty final message) before the session is ended as a clean end; 0 turns the sweep off. */
  idleEndMs: number;
  /** Milliseconds between passes that kill processes left in worktrees with no running session; 0 turns the reaper off. */
  reapMs: number;
  /** Days after a session ends before the nightly job deletes its events and session log; its row, cost and token counts stay. */
  retentionDays: number;
  promptsDir: string;
  bdBin: string;
  claudeBin: string;
  codexBin: string;
  opencodeBin: string;
  glabBin: string;
  anthropicTokenUrl: string;
  anthropicTokenTimeoutMs: number;
  usageThresholdPercent: number;
  usageReservePerSessionPercent: number;
}

export function promptsDirFrom(importMetaUrl: string): string {
  return fileURLToPath(new URL('../prompts/', importMetaUrl));
}

/** 14 days: the default before a session's events and log are deleted once it ended. */
export const DEFAULT_RETENTION_DAYS = 14;

const DEFAULT_USAGE_RESERVE_PER_SESSION_PERCENT = 2;

function parseUsageReservePerSessionPercent(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) return DEFAULT_USAGE_RESERVE_PER_SESSION_PERCENT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_USAGE_RESERVE_PER_SESSION_PERCENT;
}

/**
 * A positive finite day count for the retention window, else the default. A blank value reads as 0 and text as NaN, and a
 * zero or negative value puts the cutoff at or after now, so a mistyped setting could delete a recent ended session's
 * events and log irreversibly; refusing those keeps the window at the safe default rather than trusting the value.
 */
function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.OVERSEER_DATA_DIR ?? path.join(os.homedir(), '.overseer');
  return {
    port: Number(env.OVERSEER_PORT ?? 4400),
    dataDir,
    dbPath: path.join(dataDir, 'overseer.db'),
    worktreesDir: path.join(dataDir, 'worktrees'),
    orchestratorDir: path.join(dataDir, 'orchestrator'),
    sessionsDir: path.join(dataDir, 'sessions'),
    reportsDir: path.join(dataDir, 'reports'),
    orchestratorIdleMs: Number(env.OVERSEER_ORCHESTRATOR_IDLE_MIN ?? 30) * 60_000,
    stallMs: Number(env.OVERSEER_STALL_MIN ?? 15) * 60_000,
    idleEndMs: Number(env.OVERSEER_IDLE_END_MIN ?? 3) * 60_000,
    reapMs: Number(env.OVERSEER_REAP_MIN ?? 5) * 60_000,
    retentionDays: parseRetentionDays(env.OVERSEER_RETENTION_DAYS),
    promptsDir: env.OVERSEER_PROMPTS_DIR ?? promptsDirFrom(import.meta.url),
    bdBin: env.OVERSEER_BD ?? 'bd',
    claudeBin: env.OVERSEER_CLAUDE ?? 'claude',
    codexBin: env.OVERSEER_CODEX ?? 'codex',
    opencodeBin: env.OVERSEER_OPENCODE ?? 'opencode',
    glabBin: env.OVERSEER_GLAB ?? 'glab',
    anthropicTokenUrl: ANTHROPIC_TOKEN_URL,
    anthropicTokenTimeoutMs: 10_000,
    usageThresholdPercent: Number(env.OVERSEER_USAGE_THRESHOLD ?? 95),
    usageReservePerSessionPercent: parseUsageReservePerSessionPercent(env.OVERSEER_USAGE_RESERVE_PER_SESSION),
  };
}
