# Aura

Real-time audio rooms in the browser. Devices join a room by QR code or link;
one member at a time shares sound and everyone else hears it (WebRTC, peer-to-peer).

## Develop

```sh
npm install
npm run dev          # signaling server (:8787) + Vite (https://localhost:5173)
npm test             # server unit tests
npm run setup:audio  # Linux: "System sound (Aura)" input for sharing all system sound
```

The dev server uses a self-signed certificate (browsers only allow sound capture
on secure pages); accept the warning once per device. `AURA_HTTP=1` turns it off.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo (uses `render.yaml` + `Dockerfile`).
3. Set **one** TURN option when prompted (needed for devices on mobile data):
   - **Cloudflare Realtime TURN** — `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`
   - **Static credentials** (e.g. Metered) — `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`

   Leave the other option's fields empty.

Notes:
- Rooms live in memory: run a **single instance**. Restarts/redeploys close open rooms.
- Render's free plan sleeps after ~15 min without traffic; the first visit after
  that takes a while to wake up and any open rooms are lost.

Run the production image locally: `docker build -t aura . && docker run -p 8787:8787 aura`
