/**
 * Transport-agnostic per-connection logic shared by the Node (`ws`) server and
 * the Cloudflare Worker: origin check, rate limiting and schema validation.
 */
import { clientMessage, type ServerMessage } from '@aura/protocol';
import type { Client, Registry } from './sessions.ts';

export const MAX_PAYLOAD = 64 * 1024;
// Token bucket: ICE gathering sends bursts of candidates, so allow a burst.
const RATE_PER_SEC = 40;
const BURST = 160;

/**
 * The check exists to stop *other websites* from opening sockets from a
 * visitor's browser (which always sends Origin). Non-browser clients send none.
 */
export function originAllowed(origin: string | null | undefined, host: string | null | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface Connection {
  client: Client;
  /** Feed one raw text frame from the socket. */
  receive(data: string): void;
  /** The socket closed. */
  close(): void;
}

export function createConnection(registry: Registry, send: (json: string) => void, log: (m: string) => void): Connection {
  let tokens = BURST;
  let last = Date.now();
  let warned = 0;

  const client: Client = {
    role: { kind: 'none' },
    send(msg: ServerMessage) {
      send(JSON.stringify(msg));
    },
  };

  return {
    client,
    receive(data: string) {
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

      if (data.length > MAX_PAYLOAD) {
        return client.send({ type: 'error', code: 'bad-message', message: 'Message too large.' });
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
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
    },
    close() {
      registry.disconnect(client);
    },
  };
}
