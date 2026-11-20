/**
 * Node WebSocket transport (`ws`) for the registry. Connection logic shared
 * with the Cloudflare Worker lives in connection.ts.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WS_PATH } from '@aura/protocol';
import { createConnection, MAX_PAYLOAD, originAllowed } from './connection.ts';
import type { Registry } from './sessions.ts';

const PING_MS = 15_000;

interface Options {
  allowedOrigins: string[];
  log?: (msg: string) => void;
}

export function attachSignaling(server: Server, registry: Registry, opts: Options) {
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) return socket.destroy();
    if (!originAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins)) {
      log(`rejected origin ${req.headers.origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    let alive = true;
    const conn = createConnection(
      registry,
      (json) => {
        if (ws.readyState === ws.OPEN) ws.send(json);
      },
      log,
    );

    ws.on('pong', () => (alive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return conn.client.send({ type: 'error', code: 'bad-message', message: 'Binary frames are not supported.' });
      conn.receive(data.toString());
    });
    ws.on('close', () => conn.close());
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
