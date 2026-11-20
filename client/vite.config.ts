import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * First non-internal IPv4 address of this machine, e.g. "192.168.1.77".
 * Used in dev so share links/QR codes point at the LAN, not localhost.
 * Virtual interfaces (Docker, VPN bridges) are skipped where recognisable.
 */
function lanAddress(): string | null {
  const skip = /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|lo)/i;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    // HTTPS in dev: browsers only allow sound capture on secure pages, and
    // plain-HTTP LAN addresses are not secure. Without this, only the
    // computer running the server could share. Self-signed: each device
    // accepts the certificate warning once. Set AURA_HTTP=1 to turn off.
    ...(process.env.AURA_HTTP ? [] : [basicSsl({ name: 'aura-dev' })]),
  ],
  define: {
    // Only meaningful for the dev server; production uses the page's own origin.
    __DEV_LAN_HOST__: JSON.stringify(command === 'serve' ? (process.env.AURA_LAN_HOST ?? lanAddress()) : null),
  },
  server: {
    // Listen on the LAN so other devices can reach the dev server.
    host: true,
    port: 5173,
    // Signaling server (npm run dev starts both).
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
  },
}));
