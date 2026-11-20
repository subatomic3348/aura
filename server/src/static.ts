/**
 * Production static file serving for the built client (client/dist), with an
 * SPA fallback so deep links like /r/K7QXM2PA load index.html.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function staticHandler(rootDir: string) {
  const root = resolve(rootDir);

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const file = resolve(join(root, normalize(pathname)));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }

    let target = file;
    try {
      const st = await stat(target);
      if (st.isDirectory()) target = join(root, 'index.html');
    } catch {
      // Unknown path without an extension → client-side route.
      if (extname(pathname)) {
        res.writeHead(404).end();
        return;
      }
      target = join(root, 'index.html');
    }

    const hashed = target.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  };
}
