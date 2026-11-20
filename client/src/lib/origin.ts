/** Injected by vite.config.ts: this machine's LAN IPv4 in dev, null in production. */
declare const __DEV_LAN_HOST__: string | null;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The origin other devices should use to reach this app.
 *
 * In dev, a page opened on localhost would produce share links that only work
 * on this computer, so the LAN address is substituted (same protocol and port).
 * In production the page's own origin is already public.
 */
export function publicOrigin(): string {
  const { protocol, hostname, port } = window.location;
  if (import.meta.env.DEV && __DEV_LAN_HOST__ && LOOPBACK.has(hostname)) {
    return `${protocol}//${__DEV_LAN_HOST__}${port ? `:${port}` : ''}`;
  }
  return window.location.origin;
}

export function listenUrl(code: string): string {
  return `${publicOrigin()}/r/${code}`;
}
