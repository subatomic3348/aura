# Aura: one container serving the built web app and the signaling server.

# ── build ──
FROM node:20-slim AS build
WORKDIR /app
# Install deps first (cached unless a package.json / lockfile changes).
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ── run ──
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/client/dist ./client/dist
USER node
# Render (and most hosts) set PORT; 8787 when run locally.
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
