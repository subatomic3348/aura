/**
 * WebSocket transport for the registry: origin check, size limits, rate
 * limiting, schema validation and liveness pings.
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { clientMessage, WS_PATH, type ServerMessage } from '@aura/protocol';
import type { Client, Registry } from './sessions.ts';

const MAX_PAYLOAD = 64 * 1024;
const PING_MS = 15_000;
// Token bucket: ICE gathering sends bursts of candidates, so allow a burst.
const RATE_PER_SEC = 40;
const BURST = 160;

interface Options {
  allowedOrigins: string[];
  log?: (msg: string) => void;
}

function originAllowed(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  // Non-browser clients send no Origin. The check exists to stop *other
  // websites* from opening sockets from a visitor's browser, which always
  // sends one.
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachSignaling(server: Server, registry: Registry, opts: Options) {
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) return socket.destroy();
    if (!originAllowed(req, opts.allowedOrigins)) {
      log(`rejected origin ${req.headers.origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    let alive = true;
    let tokens = BURST;
    let last = Date.now();
    let warned = 0;

    const client: Client = {
      role: { kind: 'none' },
      send(msg: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };

    ws.on('pong', () => (alive = true));

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RATE_PER_SEC);
      last = now;
      if (tokens < 1) {
        if (now - warned > 1000) {
          warned = now;
          client.send({ type: 'error', code: 'rate-limited', message: 'Too many messages.' });
        }
        return;
      }
      tokens -= 1;

      if (isBinary) return client.send({ type: 'error', code: 'bad-message', message: 'Binary frames are not supported.' });
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return client.send({ type: 'error', code: 'bad-message', message: 'Invalid JSON.' });
      }
      const parsed = clientMessage.safeParse(json);
      if (!parsed.success) {
        return client.send({ type: 'error', code: 'bad-message', message: 'Unrecognised message.' });
      }
      try {
        registry.handle(client, parsed.data);
      } catch (err) {
        log(`handler error: ${(err as Error).stack ?? err}`);
      }
    });

    ws.on('close', () => registry.disconnect(client));
    ws.on('error', () => ws.terminate());

    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on('close', () => clearInterval(ping));
  });

  return wss;
}
