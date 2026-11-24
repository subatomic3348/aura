/**
 * View-state contract between the room controller and the UI.
 * Screens are pure functions of these types.
 */
import type { CaptureErrorCode, SourceKind } from '../audio/sources/types';

export { MAX_LISTENERS, MAX_MEMBERS, MAX_SPEAKERS } from '@aura/protocol';

/** Derived from RTCPeerConnection stats (RTT, jitter, packet loss). */
export type Quality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface LinkStats {
  rttMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
}

export type SignalingStatus = 'connected' | 'reconnecting';

export type ShareErrorCode =
  | CaptureErrorCode
  | 'busy'
  | 'not-allowed'
  | 'denied' // host declined the request
  | 'taken-over'; // host stopped me / handed over to someone else

export interface ShareError {
  code: ShareErrorCode;
  detail?: string;
}

export type VoiceErrorCode =
  | CaptureErrorCode
  | 'busy' // all microphone places are taken
  | 'not-allowed'
  | 'denied' // host declined the request to talk
  | 'taken-over'; // host turned my mic off

export interface VoiceError {
  code: VoiceErrorCode;
  detail?: string;
}

export type PeerLinkState = 'connecting' | 'connected' | 'reconnecting';

export interface MemberView {
  id: string;
  device: string;
  online: boolean;
  isMe: boolean;
  isSharer: boolean;
  isHost: boolean;
  /** Waiting for the host's approval to share. */
  requested: boolean;
  /** Approved by the host to share next. */
  granted: boolean;
  /** Microphone: live, live but muted, or off. */
  mic: 'live' | 'muted' | null;
  /** Audibly talking right now. */
  speaking: boolean;
  /** Waiting for the host's approval to talk. */
  micRequested: boolean;
  /** Approved by the host to talk, mic not on yet. */
  micGranted: boolean;
  /** Only known while *I* am sharing: my audio link to this member. */
  link: PeerLinkState | null;
  quality: Quality | null;
}

/** I am the sharer. */
export interface Sharing {
  kind: SourceKind;
  sourceLabel: string;
  /** Does this device itself play the shared sound? null = not controllable here. */
  localPlayback: boolean | null;
  startedAt: number;
  muted: boolean;
  paused: boolean;
  /** The device suspended audio (phones do this in the background): listeners hear silence. */
  audioSuspended: boolean;
}

/** Someone else is sharing; I'm listening. */
export interface Listening {
  sharerDevice: string;
  phase: 'connecting' | 'live' | 'reconnecting';
  muted: boolean;
  paused: boolean;
  quality: Quality;
  stats: LinkStats;
  relayed: boolean;
  /** Roughly how far (ms) this device plays behind the sharer's own speakers. */
  delayMs: number | null;
  /** This device suspended its audio output: a tap is needed to hear anything. */
  audioSuspended: boolean;
}

/** Two-way voice: any number of live microphones, alongside the shared sound. */
export interface Voice {
  /** My microphone. 'starting' = permission prompt open, or waiting for the server. */
  mic: 'off' | 'starting' | 'live';
  muted: boolean;
  /** I may turn my mic on now (host, or approved by the host). */
  canTalk: boolean;
  myRequest: 'none' | 'pending' | 'granted';
  /** Live microphones in the room (mine included). */
  speakerCount: number;
  /** Every microphone place is taken (and mine isn't one of them). */
  full: boolean;
  /** Who is audibly talking right now, in the order their mics went live. */
  speaking: { id: string; device: string; isMe: boolean }[];
  /** Someone's voice is coming in but this device's sound is suspended. */
  audioSuspended: boolean;
  /**
   * Floating window that keeps my mic working with Aura in the background
   * (Android Chrome cuts the mic otherwise). 'unavailable' when not needed/supported.
   */
  pip: 'unavailable' | 'closed' | 'open';
  error: VoiceError | null;
}

export interface InRoom {
  kind: 'in-room';
  code: string;
  shareUrl: string;
  meId: string;
  isHost: boolean;
  hostDevice: string | null;
  members: MemberView[];
  /** Pending share requests (host acts on these). */
  requests: { id: string; device: string }[];
  /** Pending requests to talk (host acts on these). */
  micRequests: { id: string; device: string }[];
  voice: Voice;
  /** My own request status. */
  myRequest: 'none' | 'pending' | 'granted';
  /** I may start sharing right now (host, or approved by the host). */
  canStart: boolean;
  signaling: SignalingStatus;
  /** The capture picker/permission prompt is open. */
  starting: boolean;
  sharing: Sharing | null;
  listening: Listening | null;
  /** Device name of whoever is sharing (me or someone else), if anyone. */
  sharerDevice: string | null;
  shareError: ShareError | null;
}

export type CloseReason = 'not-found' | 'full' | 'left' | 'unreachable';

export type RoomState =
  /** Waiting for a tap: joining needs one to unlock audio playback. */
  | { kind: 'ready'; code: string | null }
  | { kind: 'joining'; code: string | null }
  | InRoom
  | { kind: 'closed'; code: string | null; reason: CloseReason };
