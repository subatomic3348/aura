import { createHmac } from 'node:crypto';
import type { IceServer } from '@aura/protocol';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  production: env.NODE_ENV === 'production',
  /** Extra allowed WebSocket origins (comma-separated). Same-origin is always allowed. */
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /**
   * STUN lets peers discover their public address. On a single LAN it is not
   * needed, but it helps when a phone can't resolve the sender's mDNS
   * (.local) host candidates. Set STUN_URLS="" to disable.
   */
  stunUrls: (env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
  /** TURN relay, e.g. coturn with `use-auth-secret`. Needed for strict NATs / mobile networks. */
  turnUrls: (env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  turnSecret: env.TURN_SECRET ?? '',
  turnTtlSec: Number(env.TURN_TTL ?? 6 * 3600),
};

/**
 * ICE servers handed to each client. TURN credentials are short-lived and
 * derived with the TURN REST API scheme (HMAC-SHA1 over "expiry:user"), so the
 * shared secret never leaves the server.
 */
export function iceServers(): IceServer[] {
  const list: IceServer[] = [];
  if (config.stunUrls.length) list.push({ urls: config.stunUrls });
  if (config.turnUrls.length && config.turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + config.turnTtlSec}:aura`;
    const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
    list.push({ urls: config.turnUrls, username, credential });
  }
  return list;
}
