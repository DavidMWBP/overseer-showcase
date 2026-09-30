import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Bus } from '../bus';
import { loadConfig, type Config } from '../config';
import { openDb, type Db } from '../db/db';
import { MemoryTaskStore } from '../beads/memory';
import type { AppDeps } from '../app';
import { ActionJobs } from './jobs';
import { registerRest } from './rest';
import { waitForEvidenceRefreshForTests } from './evidence';

export interface Context {
  app: FastifyInstance;
  config: Config;
  dataDir: string;
  evidenceDir: string;
  db: Db;
}

export async function setup(): Promise<Context> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-evidence-rest-'));
  const config = loadConfig({ OVERSEER_DATA_DIR: dataDir });
  const evidenceDir = path.resolve(config.dataDir, 'evidence');
  const liveEvidenceDir = path.resolve(os.homedir(), '.overseer', 'evidence');
  if (evidenceDir === liveEvidenceDir) throw new Error('evidence test fixture resolved to a live evidence directory');

  const db = openDb(':memory:');
  const bus = new Bus();
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 255 } });
  registerRest(app, { db, bus, config, store: new MemoryTaskStore(), jobs: new ActionJobs(bus) } as unknown as AppDeps);
  app.get('/__evidence-test/trivial', async () => ({ ok: true }));
  await app.ready();
  return { app, config, dataDir, evidenceDir, db };
}

export async function cleanup(context: Context): Promise<void> {
  await waitForEvidenceRefreshForTests(context.evidenceDir);
  await context.app.close();
  context.db.sql.close();
  fs.rmSync(context.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export function writeFile(root: string, relative: string, contents: string | Buffer): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

export const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url });
