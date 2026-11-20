/**
 * Aura signaling protocol. Single source of truth for every WebSocket message.
 *
 * Model: a ROOM of up to MAX_MEMBERS devices. At most one member at a time is
 * the SHARER; everyone else listens to them.
 *
 * The HOST (the room's creator; passed on if they leave) decides who shares:
 *  - the host may share at any time (taking over from a current sharer)
 *  - other members send a share REQUEST; when the host approves it, any
 *    current sharer is stopped and the requester is GRANTED the right to share
 *  - the host can stop whoever is sharing (revoke)
 *
 * Media flows peer-to-peer (sharer → each listener). The server only keeps
 * room membership and relays SDP/ICE between the sharer and each listener.
 */
import { z } from 'zod';

/** 1 sharer + 10 listeners. */
export const MAX_MEMBERS = 11;
export const MAX_LISTENERS = MAX_MEMBERS - 1;
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
export const CODE_LENGTH = 8;
export const WS_PATH = '/ws';

/** How long a disconnected member keeps their place (and sharer role). */
export const MEMBER_GRACE_MS = 20_000;

const code = z.string().length(CODE_LENGTH).regex(/^[0-9A-HJKMNP-TV-Z]+$/);
const id = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const token = z.string().min(16).max(128);
const device = z.string().max(64);

/* ───────────── WebRTC payloads (relayed opaquely) ───────────── */

const sdp = z.object({
  kind: z.literal('description'),
  type: z.enum(['offer', 'answer']),
  sdp: z.string().max(32_000),
});

const candidate = z.object({
  kind: z.literal('candidate'),
  candidate: z
    .object({
      candidate: z.string().max(2_000),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    })
    // `null` signals end-of-candidates.
    .nullable(),
});

export const signalPayload = z.discriminatedUnion('kind', [sdp, candidate]);
export type SignalPayload = z.infer<typeof signalPayload>;

export const shareState = z.object({ muted: z.boolean(), paused: z.boolean() });
export type ShareState = z.infer<typeof shareState>;

const iceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServer>;

/* ───────────── Client → Server ───────────── */

export const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room:create'), device }),
  z.object({ type: z.literal('room:join'), code, device }),
  z.object({ type: z.literal('room:resume'), code, memberId: id, memberToken: token }),
  z.object({ type: z.literal('room:leave') }),
  /**
   * Claim the sharer role. Allowed for the host, or for the member the host
   * granted; either takes over from a current sharer. Otherwise `not-allowed`.
   */
  z.object({ type: z.literal('share:start'), state: shareState }),
  z.object({ type: z.literal('share:request') }),
  z.object({ type: z.literal('share:cancel-request') }),
  /** Host only. */
  z.object({ type: z.literal('share:approve'), memberId: id }),
  z.object({ type: z.literal('share:deny'), memberId: id }),
  z.object({ type: z.literal('share:revoke') }),
  z.object({ type: z.literal('share:state'), state: shareState }),
  z.object({ type: z.literal('share:stop') }),
  /** Relay to another member. One side of every signal must be the sharer. */
  z.object({ type: z.literal('signal'), to: id, payload: signalPayload }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

/* ───────────── Server → Client ───────────── */

export const errorCode = z.enum([
  'bad-message',
  'not-found',
  'full',
  'busy',
  'not-allowed',
  'denied',
  'unauthorized',
  'rate-limited',
  'wrong-state',
  'server-full',
]);
export type ErrorCode = z.infer<typeof errorCode>;

export const member = z.object({
  id,
  device: z.string(),
  /** False while the member's socket is down (within the grace period). */
  online: z.boolean(),
});
export type Member = z.infer<typeof member>;

export const roomSnapshot = z.object({
  code,
  members: z.array(member),
  hostId: id.nullable(),
  sharerId: id.nullable(),
  shareState: shareState.nullable(),
  /** Members waiting for the host's approval, oldest first. */
  requests: z.array(id),
  /** Member the host approved to share next (cleared once they stop). */
  grantId: id.nullable(),
});
export type RoomSnapshot = z.infer<typeof roomSnapshot>;

export const serverMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('room:joined'),
    memberId: id,
    memberToken: token,
    iceServers: z.array(iceServer),
    room: roomSnapshot,
  }),
  z.object({ type: z.literal('room:update'), room: roomSnapshot }),
  z.object({ type: z.literal('signal'), from: id, payload: signalPayload }),
  z.object({ type: z.literal('error'), code: errorCode, message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessage>;
