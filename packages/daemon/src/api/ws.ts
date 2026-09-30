import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { OrchestratorActivity, WsMessage } from '@overseer/shared';
import type { Bus } from '../bus';
import type { Office } from '../office/office';

export async function registerWs(app: FastifyInstance, bus: Bus, office: Office): Promise<void> {
  await app.register(websocket);
  const clients = new Set<{ send(data: string): void; readyState: number; terminate(): void }>();
  const broadcast = (m: WsMessage) => {
    const data = JSON.stringify(m);
    for (const c of clients) if (c.readyState === 1) c.send(data);
  };
  // Only the session id: an open Trace refetches its own session's events on it; payloads would otherwise stream to every tab.
  bus.on('event', (event) => broadcast({ type: 'event', session_id: event.session_id }));
  // Emitted by the session manager before its `board` notice: the web flips the card to settling from this, a board build can take seconds (round 12).
  bus.on('session:ended', (e) => broadcast({ type: 'session_ended', session_id: e.session.id }));
  bus.on('board', () => broadcast({ type: 'board' }));
  bus.on('chat', () => broadcast({ type: 'chat' }));
  bus.on('status', () => broadcast({ type: 'status' }));
  bus.on('repos', () => broadcast({ type: 'repos' }));
  bus.on('plans', () => broadcast({ type: 'plans' }));
  bus.on('discussion', (d) => broadcast({ type: 'discussion', id: d.id }));
  // The latest activity is kept so a socket that (re)connects mid-turn gets the current state at once, not on the next tool call.
  let activity: OrchestratorActivity | null = null;
  bus.on('orchestrator:activity', (a) => { activity = a; broadcast({ type: 'orchestrator_activity', activity: a }); });
  bus.on('office', (session) => broadcast({ type: 'office', session }));
  bus.on('office_milestone', (milestone) => broadcast({ type: 'office_milestone', ...milestone }));
  bus.on('action_result', (result) => broadcast({ type: 'action_result', ...result }));
  app.get('/api/events', { websocket: true }, (socket) => {
    clients.add(socket);
    if (activity) socket.send(JSON.stringify({ type: 'orchestrator_activity', activity } satisfies WsMessage));
    // The office's whole set, sent as one message on every connect (empty included), so a socket can tell an empty office
    // from one whose set has not loaded yet; the live changes arrive as the per-session `office` messages below.
    socket.send(JSON.stringify({ type: 'office_snapshot', sessions: office.snapshot() } satisfies WsMessage));
    socket.on('close', () => clients.delete(socket));
  });
  // Fastify waits for upgraded connections during close. End them first so a restart can release the listening port while boards are open.
  app.addHook('preClose', () => {
    for (const socket of clients) socket.terminate();
    clients.clear();
  });
}
