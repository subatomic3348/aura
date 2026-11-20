/**
 * Minimal history router. The app has four routes; a routing library would be
 * more code than the problem.
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'room'; code: string }
  | { name: 'not-found' };

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' };
  if (pathname === '/new') return { name: 'new' };
  const listen = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (listen?.[1]) return { name: 'room', code: decodeURIComponent(listen[1]) };
  return { name: 'not-found' };
}

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('popstate', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('popstate', cb);
  };
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((cb) => cb());
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}
