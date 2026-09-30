import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z, type ZodRawShape } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type McpDeps } from '../mcp/tools';
import { assertNotLivePort, replyFor, type Fixtures, type RecordedCall } from './promptEval';

export interface ToolDef { name: string; description: string; schema: ZodRawShape }

/**
 * Every overseer tool's name, description and input schema, read from the daemon's own `registerTools`, so the mock serves
 * exactly what the live orchestrator sees. The handlers are dropped unrun: `deps` is only reachable from inside them.
 */
export function overseerToolDefs(deps: McpDeps = {} as McpDeps): ToolDef[] {
  const defs: ToolDef[] = [];
  const capture = {
    tool: (...a: unknown[]) => {
      const [name, description, schema, handler] = a;
      if (typeof name !== 'string' || typeof description !== 'string' || typeof schema !== 'object' || schema === null || typeof handler !== 'function' || a.length !== 4) {
        throw new Error(`registerTools used a server.tool overload the mock does not read, for ${String(name)}`);
      }
      defs.push({ name, description, schema: schema as ZodRawShape });
    },
  };
  registerTools(capture as unknown as McpServer, deps);
  return defs;
}

export interface MockMcp { url: string; port: number; calls: RecordedCall[]; close(): Promise<void> }

/**
 * An MCP server named `overseer` on a free 127.0.0.1 port, never the live daemon's: each tool call is answered from `fixtures`
 * (see `replyFor`) and nothing else happens, so a write tool (`bd create`, `spawn_worker`, `merge_batch`, ...) is only recorded.
 * Every `tools/call` is recorded with the raw arguments sent by the model. Accepted calls use schema-parsed arguments,
 * including defaults, only to select their fixture. A call whose arguments the tool's input
 * schema refuses, or that names no tool, is still answered by the SDK's error but recorded with `rejected`, so an attempted
 * call is never mistaken for no call. Like `registerMcp`, every request gets its own stateless server, on `/mcp` or `/mcp/<id>`.
 */
export async function startMockMcp(fixtures: Fixtures, opts: { livePorts: readonly number[]; defs?: ToolDef[] }): Promise<MockMcp> {
  const defs = opts.defs ?? overseerToolDefs();
  const calls: RecordedCall[] = [];
  const record = (message: unknown, replies: ReturnType<typeof replyFor>[]): void => {
    const m = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (m?.method !== 'tools/call') return;
    const tool = String(m.params?.name ?? '');
    const raw = (typeof m.params?.arguments === 'object' && m.params.arguments !== null ? m.params.arguments : {}) as Record<string, unknown>;
    const def = defs.find((d) => d.name === tool);
    const parsed = def ? z.object(def.schema).safeParse(raw) : null;
    if (!parsed?.success) {
      const why = !def ? 'no such tool' : parsed!.error.issues.map((x) => `${x.path.join('.') || 'arguments'}: ${x.message}`).join('; ');
      calls.push({ seq: calls.length + 1, tool, args: raw, fixture: null, rejected: why });
      return;
    }
    // Keep the model's arguments in the transcript; schema defaults affect fixture selection only.
    const parsedArgs = parsed.data as Record<string, unknown>;
    const selected = replyFor(fixtures, tool, parsedArgs, calls);
    calls.push({ seq: calls.length + 1, tool, args: raw, fixture: selected.fixture });
    replies.push(selected);
  };
  const transports = new Set<StreamableHTTPServerTransport>();
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!/^\/mcp(\/[^/?]*)?(\?|$)/.test(req.url ?? '')) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const message: unknown = body ? JSON.parse(body) : undefined;
    const replies: ReturnType<typeof replyFor>[] = [];
    for (const m of Array.isArray(message) ? message : [message]) record(m, replies);
    const server = new McpServer({ name: 'overseer', version: '0.1.0' });
    for (const def of defs) {
      server.tool(def.name, def.description, def.schema, async (args: Record<string, unknown>) => {
        const { reply } = replies.shift() ?? replyFor(fixtures, def.name, args, calls);
        return 'error' in reply
          ? { isError: true, content: [{ type: 'text' as const, text: reply.error }] }
          : { content: [{ type: 'text' as const, text: JSON.stringify(reply.reply, null, 2) }] };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transports.add(transport);
    res.on('close', () => { transports.delete(transport); void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, message);
  };
  const listener = http.createServer((req, res) => {
    handle(req, res).catch((err) => { if (!res.headersSent) res.writeHead(500).end(String(err)); });
  });
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => resolve()); });
  const port = (listener.address() as AddressInfo).port;
  const close = async () => {
    for (const t of [...transports]) { try { await t.close(); } catch { /* the socket already went away */ } }
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  };
  try { assertNotLivePort(port, opts.livePorts); } catch (err) { await close(); throw err; }
  return { url: `http://127.0.0.1:${port}/mcp`, port, calls, close };
}
