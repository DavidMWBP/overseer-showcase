import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpDeps } from '../mcp/tools';
import { overseerToolDefs, startMockMcp, type MockMcp } from './mockMcp';
import { checkExact, type Fixtures } from './promptEval';

const fixtures: Fixtures = {
  default: { reply: { note: 'default reply' } },
  calls: [
    { tool: 'list_tasks', args: { repo: 'web' }, reply: [{ id: 'web-1', title: 'Add a button', column: 'ready' }] },
    { tool: 'spawn_worker', args: { bead_id: 'web-1' }, reply: { session_id: 's-1', bead_id: 'web-1', harness: 'claude' } },
    { tool: 'merge_batch', error: 'batch web-b1 is not in review' },
  ],
};

const defaultedFilterFixtures: Fixtures = {
  default: { reply: { note: 'default reply' } },
  calls: [{ tool: 'list_tasks', args: { filter: 'all' }, reply: { note: 'all filter fixture' } }],
};

let mock: MockMcp | null = null;
let client: Client | null = null;
afterEach(async () => {
  await client?.close(); client = null;
  await mock?.close(); mock = null;
});

async function connect(m: MockMcp): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${m.url}/session-1`)));
  return c;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { type: string; text: string }[])[0]!.text;

describe('mock overseer MCP server', () => {
  it('answers a listed call from its fixture, an unlisted call with the default, and records both with their arguments', async () => {
    mock = await startMockMcp(fixtures, { livePorts: [4400] });
    client = await connect(mock);
    const listed = await client.callTool({ name: 'list_tasks', arguments: { repo: 'web', filter: 'ready' } });
    const unlisted = await client.callTool({ name: 'worker_status', arguments: { repo: 'web', bead_id: 'web-9' } });
    expect(JSON.parse(text(listed))).toEqual([{ id: 'web-1', title: 'Add a button', column: 'ready' }]);
    expect(JSON.parse(text(unlisted))).toEqual({ note: 'default reply' });
    expect(mock.calls).toEqual([
      { seq: 1, tool: 'list_tasks', args: { repo: 'web', filter: 'ready' }, fixture: 0 },
      { seq: 2, tool: 'worker_status', args: { repo: 'web', bead_id: 'web-9' }, fixture: 'default' },
    ]);
  });

  it('uses successive fixtures for repeated calls with matching arguments', async () => {
    const sequence: Fixtures = {
      default: { reply: { note: 'default reply' } },
      calls: [
        { tool: 'list_tasks', args: { repo: 'web' }, reply: [] },
        { tool: 'list_tasks', args: { repo: 'web' }, reply: [{ id: 'web-2', title: 'New bead', column: 'ready' }] },
      ],
    };
    mock = await startMockMcp(sequence, { livePorts: [4400] });
    client = await connect(mock);
    const first = await client.callTool({ name: 'list_tasks', arguments: { repo: 'web' } });
    const second = await client.callTool({ name: 'list_tasks', arguments: { repo: 'web' } });
    expect(JSON.parse(text(first))).toEqual([]);
    expect(JSON.parse(text(second))).toEqual([{ id: 'web-2', title: 'New bead', column: 'ready' }]);
    expect(mock.calls.map((call) => call.fixture)).toEqual([0, 1]);
  });

  it('records raw arguments while defaults still select fixtures', async () => {
    mock = await startMockMcp(defaultedFilterFixtures, { livePorts: [4400] });
    client = await connect(mock);

    // list_tasks defaults filter to all: the fixture matches the parsed value, but the transcript must keep the omission.
    const omitted = await client.callTool({ name: 'list_tasks', arguments: { repo: 'web' } });
    expect(JSON.parse(text(omitted))).toEqual({ note: 'all filter fixture' });
    expect(mock.calls[0]).toEqual({ seq: 1, tool: 'list_tasks', args: { repo: 'web' }, fixture: 0 });
    expect(checkExact(
      { kind: 'called', tool: 'list_tasks', args: { filter: 'all' } },
      { calls: [mock.calls[0]!], messages: [] },
    )).toEqual({ pass: false, detail: 'list_tasks called 1 time(s), none with {"filter":"all"}' });

    const explicit = await client.callTool({ name: 'list_tasks', arguments: { repo: 'web', filter: 'all' } });
    expect(JSON.parse(text(explicit))).toEqual({ note: 'all filter fixture' });
    expect(mock.calls[1]).toEqual({ seq: 2, tool: 'list_tasks', args: { repo: 'web', filter: 'all' }, fixture: 0 });
  });

  it('records a write tool and never runs the daemon handler behind it', async () => {
    const touched: string[] = [];
    const tripwire = new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); return undefined; } }) as McpDeps;
    mock = await startMockMcp(fixtures, { livePorts: [4400], defs: overseerToolDefs(tripwire) });
    client = await connect(mock);
    const spawned = await client.callTool({ name: 'spawn_worker', arguments: { repo: 'web', bead_id: 'web-1', tier: 'standard', needs_server: true } });
    const merged = await client.callTool({ name: 'merge_batch', arguments: { repo: 'web', batch_id: 'web-b1' } });
    expect(JSON.parse(text(spawned))).toEqual({ session_id: 's-1', bead_id: 'web-1', harness: 'claude' });
    expect(merged.isError).toBe(true);
    expect(text(merged)).toBe('batch web-b1 is not in review');
    expect(mock.calls.map((c) => [c.tool, c.args])).toEqual([
      ['spawn_worker', { repo: 'web', bead_id: 'web-1', tier: 'standard', needs_server: true }],
      ['merge_batch', { repo: 'web', batch_id: 'web-b1' }],
    ]);
    // The real handlers reach the database, the lifecycle or the task store through deps; none of them ran.
    expect(touched).toEqual([]);
  });

  it('records a call its input schema refuses, and one naming no tool, with the arguments sent and the reason', async () => {
    mock = await startMockMcp(fixtures, { livePorts: [4400] });
    client = await connect(mock);
    // spawn_worker requires `repo`; the SDK answers with its validation error and never reaches a handler.
    const refused = await client.callTool({ name: 'spawn_worker', arguments: { bead_id: 'web-1' } }).catch((err: Error) => ({ isError: true, thrown: err.message }));
    const unknown = await client.callTool({ name: 'deploy_everything', arguments: { now: true } }).catch((err: Error) => ({ isError: true, thrown: err.message }));
    expect(refused.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(mock.calls).toEqual([
      { seq: 1, tool: 'spawn_worker', args: { bead_id: 'web-1' }, fixture: null, rejected: expect.stringContaining('repo: Required') },
      { seq: 2, tool: 'deploy_everything', args: { now: true }, fixture: null, rejected: 'no such tool' },
    ]);
  });

  it('serves every tool the daemon registers, with its input schema', async () => {
    mock = await startMockMcp(fixtures, { livePorts: [4400] });
    client = await connect(mock);
    const { tools } = await client.listTools();
    const source = fs.readFileSync(new URL('../mcp/tools.ts', import.meta.url), 'utf8');
    const registered = [...source.matchAll(/server\.tool\('(\w+)'/g)].map((m) => m[1]);
    expect(tools.map((t) => t.name).sort()).toEqual([...registered].sort());
    const spawn = tools.find((t) => t.name === 'spawn_worker')!;
    expect(Object.keys(spawn.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['repo', 'bead_id', 'tier', 'harness', 'needs_server']));
    expect(spawn.inputSchema.required).toEqual(['repo', 'bead_id']);
  });

  it('refuses to serve on a port the live daemon uses', async () => {
    // Every port counts as live here, so whichever free port the OS hands out is refused.
    const every = Array.from({ length: 65536 }, (_, i) => i);
    await expect(startMockMcp(fixtures, { livePorts: every })).rejects.toThrow(/the live daemon's/);
  });
});
