import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type McpDeps } from './tools';

export async function registerMcp(app: FastifyInstance, deps: McpDeps): Promise<void> {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body.length ? JSON.parse(body as string) : undefined); } catch (e) { done(e as Error); }
  });
  // `/mcp/:sessionId` is the same server with a caller identity. The daemon writes a per-session MCP config for every
  // harness anyway (claude's --mcp-config file, opencode's OPENCODE_CONFIG, codex's -c override), so the session id
  // travels in the URL rather than in a header no harness lets us set. `/mcp` stays for callers that need no identity.
  // One transport per request, including a GET SSE stream that keeps its socket open until the client leaves. Closing
  // the app must end them, or the hijacked socket outlives `app.close()` and the shutdown times out.
  const transports = new Set<StreamableHTTPServerTransport>();
  const handler = (sessionId?: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      const server = new McpServer({ name: 'overseer', version: '0.1.0' });
      registerTools(server, deps, sessionId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transports.add(transport);
      reply.hijack();
      reply.raw.on('close', () => { transports.delete(transport); void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: handler() });
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp/:sessionId', handler: async (req, reply) => handler((req.params as { sessionId: string }).sessionId)(req, reply) });
  // Fastify waits for upgraded and hijacked connections during close. End the open MCP streams before the server closes.
  app.addHook('preClose', async () => {
    const open = [...transports];
    transports.clear();
    for (const transport of open) { try { await transport.close(); } catch { /* the socket already went away */ } }
  });
}
