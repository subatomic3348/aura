# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Aura: real-time audio rooms in the browser. Devices join a room by QR code/link; one member at a time shares sound, everyone else hears it over peer-to-peer WebRTC. The server only does signaling.

## Commands

npm workspaces monorepo (`packages/protocol`, `server`, `client`, `worker`), Node >= 20.19. No linter is configured.

```sh
npm install
npm run dev            # signaling server (:8787, tsx watch) + Vite (https://<LAN-IP>:5173, proxies /ws → :8787)
npm test               # server unit tests (vitest) — the only tests in the repo
npm test -w server -- -t "<test name>"   # single test by name
npm run typecheck      # tsc --noEmit for server, client, worker
npm run build          # client → client/dist (tsc + vite)
npm run setup:audio    # Linux: creates the "System sound (Aura)" virtual input
npm run setup:audio -- --sync 120   # …and delays this laptop's own speakers 120 ms to stay in step with listeners (--remove undoes)
npm run dev -w worker  # Cloudflare Worker locally (wrangler dev, :8795); secrets in worker/.dev.vars
npm run deploy:cf      # PRODUCTION: build client + wrangler deploy (needs `npx wrangler login` once)
```

Dev uses a self-signed cert (sound capture requires a secure context, and plain-HTTP LAN addresses aren't secure); each device accepts the warning once. `AURA_HTTP=1` disables it; `AURA_LAN_HOST` overrides the LAN address used in share links/QR codes.

## Workflow

The user wants changes made and tested in dev (`npm run dev`, tried on real devices over the LAN, including phones) before deploying to prod (`npm run deploy:cf`). Don't deploy to production without that testing step and the user's go-ahead.

## Architecture

**`packages/protocol`** — single source of truth for every WebSocket message (zod schemas + types), plus room constants (`MAX_MEMBERS` = 1 sharer + 10 listeners, code alphabet, grace periods). Change messages here first; server and client both import `@aura/protocol`.

**Room model** (enforced in `server/src/sessions.ts`, documented at the top of it and of the protocol file): a room has a HOST (creator, passed to the longest-standing member on leave) and at most one SHARER. The host shares freely; others send a share request the host approves. Independently, up to `MAX_SPEAKERS` members can have their microphone live at once (two-way VOICE), with the same host-approval model (`mic:*` messages; turning the mic off uses the approval up, mute keeps it). Every relayed signal names its `link` (`share` | `voice`) and has that link's media sender (the sharer, or a speaker) on one end. Disconnected members keep their place (and sharer role) for `MEMBER_GRACE_MS`. Rooms live in memory only — a single instance is required, and restarts drop rooms.

**Server** (`server/src`): `sessions.ts` is the transport-agnostic `Registry` (a `Client` is anything with `send()`, which is how it's unit-tested without sockets). `connection.ts` parses/validates messages per socket; `signaling.ts` attaches it to `ws`; `config.ts` reads env (`PORT`, `ALLOWED_ORIGINS`, `FRAME_ANCESTORS`, `STUN_URLS`, TURN vars). In production (`NODE_ENV=production`) it also serves `client/dist`.

**Worker** (`worker/src/index.ts`): the Cloudflare deployment reuses the server's `Registry`, `config` and `connection` directly (imports `../../server/src/*.ts`). All rooms live in one Durable Object (`idFromName('global')`) to keep the same single-instance semantics. Security headers are set in both `server/src/index.ts` and the worker — keep them in sync.

**Client** (`client/src`, React 19 + Vite, CSS modules):
- `session/room.ts` — `RoomController`, the core state machine. Every device runs the same controller; its role follows the server's `sharerId` (me → sharing, other → listening, null → idle). UI calls actions; everything else reacts to server snapshots. Exposed to React via `session/store.ts`.
- Sending path: `audio/sources/*` (`system` | `tab` | `file`) → `audio/mixer.ts` (AudioContext graph: per-source gain → master → MediaStreamDestination + level meter) → `audio/transport/mesh.ts` (one sendonly `RTCPeerConnection` per listener; sender always offers, so no glare; Opus tuned in `audio/sdp.ts`). A single live source's raw track bypasses the mixer to save latency.
- Receiving path: `audio/receiver.ts` (`ReceiverLink`) → `audio/playback.ts` (`AudioOutput`).
- Voice: `session/voice.ts` (`VoiceController`, owned by `RoomController`). My mic's raw track → its own `MeshTransport` (Opus `voice` profile: mono, ~40 kbps) to every other member; one `ReceiverLink` per other speaker → `AudioOutput.attachVoice`. So two members can have up to three peer connections between them (share + a voice link each way), all send-only. "Who's talking" is measured locally from those levels.
- `lib/capabilities.ts` decides which share modes a device gets. System/tab capture is desktop Chromium only (`getDisplayMedia`); phones get `file` (plus voice) because mobile browsers have no API to capture other apps' audio. On Linux, `system` prefers the virtual input device from `setup:audio` over the share picker (`audio/sources/index.ts`).

**Mobile audio gotchas** (repeated sources of bugs): audio must be unlocked inside a user gesture (iOS strictly) — `app/autostart.ts` creates the `AudioOutput` on the landing-page tap and hands it to the room page. Phones suspend the AudioContext when the page backgrounds (including while a file picker/permission prompt is open) and don't resume it, which sends silence while the UI looks fine; the mixer resumes itself on return to the foreground. To keep listening/voice going with the screen locked or another app in front, `audio/background.ts` (owned by `AudioOutput`) plays a looping near-silent clip plus Media Session metadata and iOS `audioSession` — a bare WebRTC stream isn't treated as media by phones. `pagehide` only sends `room:leave` when `!persisted`.

## Deployment targets

Cloudflare Workers (`npm run deploy:cf`) is the recommended production target. Also supported: Docker (`Dockerfile`, port 8787) used by Hugging Face Spaces (README front-matter configures the Space) and Render (`render.yaml`). TURN is optional but needed for devices on mobile data: either `CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_API_TOKEN` or `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` (worker: `npx wrangler secret put ...`).
