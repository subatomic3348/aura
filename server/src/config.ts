import { createHmac } from 'node:crypto';
import type { IceServer } from '@aura/protocol';

const env = process.env;
const list = (v: string | undefined, fallback = '') =>
  (v ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  production: env.NODE_ENV === 'production',
  /** Extra allowed WebSocket origins (comma-separated). Same-origin is always allowed. */
  allowedOrigins: list(env.ALLOWED_ORIGINS),
  /** Sites allowed to embed the app in an iframe (space-separated CSP sources). */
  frameAncestors: env.FRAME_ANCESTORS ?? 'https://huggingface.co',
  /**
   * STUN lets peers discover their public address. Set STUN_URLS="" to disable.
   */
  stunUrls: list(env.STUN_URLS, 'stun:stun.l.google.com:19302'),

  /*
   * TURN relay — needed when two devices can't reach each other directly
   * (mobile data, strict NATs). Configure ONE of:
   *
   *  A. Static credentials (e.g. Metered):
   *       TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
   *  B. Cloudflare Realtime TURN (short-lived credentials, fetched by the server):
   *       CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
   *  C. Self-hosted coturn with `use-auth-secret` (TURN REST API):
   *       TURN_URLS, TURN_SECRET
   */
  turnUrls: list(env.TURN_URLS),
  turnUsername: env.TURN_USERNAME ?? '',
  turnCredential: env.TURN_CREDENTIAL ?? '',
  turnSecret: env.TURN_SECRET ?? '',
  turnTtlSec: Number(env.TURN_TTL ?? 6 * 3600),
  cloudflareKeyId: env.CLOUDFLARE_TURN_KEY_ID ?? '',
  cloudflareToken: env.CLOUDFLARE_TURN_API_TOKEN ?? '',
};

export type TurnMode = 'static' | 'cloudflare' | 'coturn' | 'none';

export const turnMode: TurnMode =
  config.cloudflareKeyId && config.cloudflareToken
    ? 'cloudflare'
    : config.turnUrls.length && config.turnSecret
      ? 'coturn'
      : config.turnUrls.length && config.turnUsername && config.turnCredential
        ? 'static'
        : 'none';

/* ───────────── Cloudflare: refreshed in the background ───────────── */

const CF_TTL_SEC = 24 * 3600;
let cloudflareServers: IceServer[] = [];

/** Fetch fresh Cloudflare TURN credentials. The API token never leaves the server. */
async function refreshCloudflare(log: (m: string) => void): Promise<void> {
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.cloudflareKeyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.cloudflareToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: CF_TTL_SEC }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { iceServers?: IceServer | IceServer[] };
    const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    // Browsers time out on port 53 TURN URLs; Cloudflare recommends dropping them.
    cloudflareServers = servers
      .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length > 0);
    log(`TURN: Cloudflare credentials refreshed (${cloudflareServers.length} server entries)`);
  } catch (err) {
    log(`TURN: Cloudflare credential refresh failed: ${(err as Error).message}`);
  }
}

export function startTurn(log: (m: string) => void): void {
  if (turnMode === 'cloudflare') {
    void refreshCloudflare(log);
    // Refresh well before expiry.
    setInterval(() => void refreshCloudflare(log), (CF_TTL_SEC / 2) * 1000).unref();
  }
  log(turnMode === 'none' ? 'TURN: not configured — some mobile-data devices may fail to connect' : `TURN: ${turnMode}`);
}

/** ICE servers handed to each client when it joins a room. */
export function iceServers(): IceServer[] {
  const servers: IceServer[] = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  switch (turnMode) {
    case 'static':
      servers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnCredential });
      break;
    case 'coturn': {
      const username = `${Math.floor(Date.now() / 1000) + config.turnTtlSec}:aura`;
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      servers.push({ urls: config.turnUrls, username, credential });
      break;
    }
    case 'cloudflare':
      servers.push(...cloudflareServers);
      break;
  }
  return servers;
}
