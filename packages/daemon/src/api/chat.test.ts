import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Bus } from '../bus';
import { loadConfig } from '../config';
import { openDb, type Db } from '../db/db';
import { MemoryTaskStore } from '../beads/memory';
import type { AppDeps } from '../app';
import { ActionJobs } from './jobs';
import { registerRest } from './rest';

describe('Chat send REST API', () => {
  let app: FastifyInstance;
  let db: Db;
  type SendUserArgs = [text: string, attachments: unknown[], openQuestionIds?: number[]];
  let sendUser: (...args: SendUserArgs) => Promise<void>;
  let calls: SendUserArgs[];
  let dataDir: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-chat-api-'));
    const liveDataDir = path.resolve(os.homedir(), '.overseer');
    if (path.resolve(dataDir) === liveDataDir) throw new Error('chat API fixture resolved to a live data directory');
    db = openDb(':memory:');
    const bus = new Bus();
    calls = [];
    sendUser = vi.fn(async (...args: SendUserArgs) => { calls.push(args); });
    app = Fastify({ logger: false });
    registerRest(app, {
      db,
      bus,
      config: loadConfig({ OVERSEER_DATA_DIR: dataDir }),
      store: new MemoryTaskStore(),
      jobs: new ActionJobs(bus),
      orchestrator: { sendUser },
    } as unknown as AppDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.sql.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('keeps an omitted question list absent for an older page', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'hello' } });
    expect({ status: response.statusCode, args: calls[0] }).toEqual({ status: 200, args: ['hello', [], undefined] });
  });

  it('forwards an explicit empty list as none open', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'hello', open_question_ids: [] } });
    expect({ status: response.statusCode, ids: calls[0]?.[2] }).toEqual({ status: 200, ids: [] });
  });

  it('forwards the captured IDs with a repository scoped message', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'hello', repo: 'r1', open_question_ids: [11, 12] } });
    expect({ status: response.statusCode, args: calls[0] }).toEqual({ status: 200, args: ['[repo: r1] hello', [], [11, 12]] });
  });
});
