/**
 * Cloudflare Worker entry.
 *
 *   /ws      → the RoomHub Durable Object (WebSocket signaling)
 *   /healthz → liveness
 *   else     → the built web app (static assets, SPA fallback)
 *
 * All rooms live in ONE Durable Object instance ("global"), which runs the
 * same Registry as the Node server. A single instance gives the same
 * in-memory semantics as the Node deployment (rooms are lost if it restarts).
 */
import { DurableObject } from 'cloudflare:workers';
import { WS_PATH } from '@aura/protocol';
import { config, iceServers, startTurn } from '../../server/src/config.ts';
import { createConnection, originAllowed } from '../../server/src/connection.ts';
import { Registry } from '../../server/src/sessions.ts';

interface Env {
  ROOMS: DurableObjectNamespace<RoomHub>;
  ASSETS: Fetcher;
}

const log = (m: string) => console.log(`[aura] ${m}`);

export class RoomHub extends DurableObject<Env> {
  private readonly registry = new Registry({ iceServers });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    startTurn(log);
  }

  override async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const conn = createConnection(
      this.registry,
      (json) => {
        try {
          server.send(json);
        } catch {
          /* socket already closed */
        }
      },
      log,
    );
    server.addEventListener('message', (e) => {
      if (typeof e.data === 'string') conn.receive(e.data);
      else conn.client.send({ type: 'error', code: 'bad-message', message: 'Binary frames are not supported.' });
    });
    server.addEventListener('close', () => conn.close());
    server.addEventListener('error', () => conn.close());
    return new Response(null, { status: 101, webSocket: client });
  }
}

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${config.frameAncestors}`);
  out.headers.set('Permissions-Policy', 'camera=(), geolocation=(), display-capture=(self), microphone=(self)');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });

    if (url.pathname === WS_PATH) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      if (!originAllowed(req.headers.get('Origin'), url.host, config.allowedOrigins)) {
        return new Response('Forbidden', { status: 403 });
      }
      const hub = env.ROOMS.get(env.ROOMS.idFromName('global'));
      return hub.fetch(req);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(req));
  },
} satisfies ExportedHandler<Env>;
