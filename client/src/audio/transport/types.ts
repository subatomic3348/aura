import type { IceServer, SignalPayload } from '@aura/protocol';
import type { Quality } from '../../session/types';

export type PeerConnState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface TransportEvents extends Record<string, unknown> {
  /** Outgoing signaling message for a peer; the controller relays it. */
  signal: { peerId: string; payload: SignalPayload };
  state: { peerId: string; state: PeerConnState };
  quality: { peerId: string; quality: Quality };
}

/**
 * Delivers one audio track from the broadcaster to many receivers.
 *
 * MeshTransport implements this with one RTCPeerConnection per receiver.
 * An SFU transport would implement the same interface with a single upstream
 * connection; nothing above this layer would change.
 */
export interface BroadcastTransport {
  addPeer(peerId: string): void;
  removePeer(peerId: string): void;
  hasPeer(peerId: string): boolean;
  peerIds(): string[];
  handleSignal(peerId: string, payload: SignalPayload): void;
  /** Stop/start sending RTP to everyone without renegotiating (pause). */
  setActive(active: boolean): void;
  setIceServers(servers: IceServer[]): void;
  /** ICE-restart every peer, e.g. after the sender's network changed. */
  restartAll(): void;
  on<K extends keyof TransportEvents>(event: K, fn: (p: TransportEvents[K]) => void): () => void;
  close(): void;
}
