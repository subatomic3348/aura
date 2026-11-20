import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config, iceServers } from './config.ts';
import { Registry } from './sessions.ts';
import { attachSignaling } from './signaling.ts';
import { staticHandler } from './static.ts';

const log = (msg: string) => console.log(`[aura] ${msg}`);

const registry = new Registry({ iceServers });

// In development Vite serves the client and proxies /ws here.
const serveClient = config.production
  ? staticHandler(fileURLToPath(new URL('../../client/dist', import.meta.url)))
  : null;

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`ok ${registry.rooms.size}`);
    return;
  }
  if (serveClient) return void serveClient(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Aura signaling server. Open the Vite dev server.');
});

attachSignaling(server, registry, { allowedOrigins: config.allowedOrigins, log });

server.listen(config.port, config.host, () => {
  log(`signaling on ${config.host}:${config.port}${config.production ? ' (serving client/dist)' : ''}`);
  if (!config.turnUrls.length) log('no TURN configured — listeners behind strict NATs may fail to connect');
});

const shutdown = () => {
  registry.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
