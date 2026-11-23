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
 * VOICE runs alongside: up to MAX_SPEAKERS members may have their microphone
 * live at once, and everyone hears all of them. Same permission model — the
 * host talks freely; others send a mic REQUEST the host approves. Turning the
 * mic off uses the approval up (muting keeps the place); the host can turn
 * anyone's mic off.
 *
 * Media flows peer-to-peer (media sender → each other member, one send-only
 * connection per pair and link). The server only keeps room membership and
 * relays SDP/ICE between a media sender (the sharer, or a speaker) and the
 * members receiving them.
 */
import { z } from 'zod';

/** 1 sharer + 10 listeners. */
export const MAX_MEMBERS = 11;
export const MAX_LISTENERS = MAX_MEMBERS - 1;
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
export const CODE_LENGTH = 8;
export const WS_PATH = '/ws';
export const KEEPALIVE_MS = 25_000;

/** How long a disconnected member keeps their place (and sharer role). */
export const MEMBER_GRACE_MS = 20_000;

/**
 * Live microphones at once. Each speaker uploads one voice stream per member
 * (~40 kbps each) and each member decodes one per speaker, so this bounds the
 * mesh for phones.
 */
export const MAX_SPEAKERS = 6;

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

/** Which media a relayed signal belongs to: the shared sound, or a speaker's voice. */
export const signalLink = z.enum(['share', 'voice']);
export type SignalLink = z.infer<typeof signalLink>;

const iceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServer>;

/* ───────────── Client → Server ───────────── */

export const clientMessage = z.discriminatedUnion('type', [
  /** Keepalive: proxies (e.g. Cloudflare) close WebSockets idle for ~100 s. */
  z.object({ type: z.literal('ping') }),
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
  /**
   * Turn my microphone on. Allowed for the host, or a member the host
   * approved (the approval is used up when the mic goes off).
   */
  z.object({ type: z.literal('mic:start'), muted: z.boolean() }),
  z.object({ type: z.literal('mic:state'), muted: z.boolean() }),
  /** Mic off; also gives an unused approval back. */
  z.object({ type: z.literal('mic:stop') }),
  z.object({ type: z.literal('mic:request') }),
  z.object({ type: z.literal('mic:cancel-request') }),
  /** Host only. */
  z.object({ type: z.literal('mic:approve'), memberId: id }),
  z.object({ type: z.literal('mic:deny'), memberId: id }),
  z.object({ type: z.literal('mic:revoke'), memberId: id }),
  /**
   * Relay to another member. `fromSender`: I am the media sender on this link
   * (the sharer for 'share', a speaker for 'voice'); otherwise the recipient
   * must be. Two members can have several links between them at once.
   */
  z.object({ type: z.literal('signal'), to: id, link: signalLink, fromSender: z.boolean(), payload: signalPayload }),
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

export const speaker = z.object({ id, muted: z.boolean() });
export type Speaker = z.infer<typeof speaker>;

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
  /** Members with a live microphone, in the order they turned it on. */
  speakers: z.array(speaker),
  /** Members waiting for the host's approval to talk, oldest first. */
  micRequests: z.array(id),
  /** Members the host approved to talk who haven't turned their mic on yet. */
  micGrants: z.array(id),
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
  z.object({ type: z.literal('signal'), from: id, link: signalLink, fromSender: z.boolean(), payload: signalPayload }),
  z.object({
    type: z.literal('error'),
    code: errorCode,
    message: z.string(),
    /** Set when the error is about the microphone rather than sharing. */
    scope: z.literal('mic').optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessage>;
