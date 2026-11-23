import type { IceServer, SignalPayload } from '@aura/protocol';
import { Emitter } from '../../lib/emitter';
import { rateLink, sampleOutbound } from '../quality';
import { candidatePayload, toRtcIceServers } from '../rtc';
import { tuneOpus, type OpusProfile } from '../sdp';
import type { BroadcastTransport, PeerConnState, TransportEvents } from './types';

const STATS_MS = 2000;
/** How long `disconnected` may last before we force an ICE restart. */
const DISCONNECT_RESTART_MS = 3000;

/**
 * Sender side of one receiver. The sender always makes the offer (it owns the
 * track), so there is never offer glare.
 */
class HostPeer {
  readonly pc: RTCPeerConnection;
  private sender: RTCRtpSender;
  private queued: RTCIceCandidateInit[] = [];
  private disconnectTimer: number | undefined;
  private negotiating = false;
  private closed = false;

  constructor(
    readonly id: string,
    track: MediaStreamTrack,
    iceServers: IceServer[],
    private active: boolean,
    private readonly profile: OpusProfile,
    private readonly out: {
      signal(p: SignalPayload): void;
      state(s: PeerConnState): void;
    },
  ) {
    this.pc = new RTCPeerConnection({ iceServers: toRtcIceServers(iceServers), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    // Send-only: receivers never send media back.
    const tr = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [new MediaStream([track])] });
    this.sender = tr.sender;

    this.pc.onicecandidate = (e) => this.out.signal(candidatePayload(e.candidate));
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    void this.negotiate(false);
  }

  private onConnectionState() {
    const s = this.pc.connectionState;
    window.clearTimeout(this.disconnectTimer);
    if (s === 'connected') {
      void this.applyEncoding();
      this.out.state('connected');
    } else if (s === 'disconnected') {
      // Often recovers by itself (brief Wi-Fi hiccup). If not, restart ICE.
      this.out.state('reconnecting');
      this.disconnectTimer = window.setTimeout(() => this.restartIce(), DISCONNECT_RESTART_MS);
    } else if (s === 'failed') {
      this.out.state('reconnecting');
      this.restartIce();
    } else if (s === 'new' || s === 'connecting') {
      this.out.state('connecting');
    }
  }

  restartIce() {
    if (this.closed) return;
    void this.negotiate(true);
  }

  private async negotiate(iceRestart: boolean) {
    if (this.negotiating || this.closed) return;
    this.negotiating = true;
    try {
      const offer = await this.pc.createOffer({ iceRestart });
      offer.sdp = tuneOpus(offer.sdp ?? '', this.profile);
      await this.pc.setLocalDescription(offer);
      this.out.signal({ kind: 'description', type: 'offer', sdp: offer.sdp });
    } catch (err) {
      console.warn(`[aura] offer to ${this.id} failed`, err);
    } finally {
      this.negotiating = false;
    }
  }

  async handle(payload: SignalPayload) {
    if (this.closed) return;
    if (payload.kind === 'description') {
      if (payload.type !== 'answer' || this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      for (const c of this.queued.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    } else if (payload.candidate) {
      const c = payload.candidate as RTCIceCandidateInit;
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => {});
      else this.queued.push(c);
    }
  }

  setActive(active: boolean) {
    this.active = active;
    void this.applyEncoding();
  }

  /** Bitrate cap, priority and pause (encoding.active) — no renegotiation needed. */
  private async applyEncoding() {
    const params = this.sender.getParameters();
    if (!params.encodings?.length) return;
    for (const enc of params.encodings) {
      enc.active = this.active;
      enc.maxBitrate = MAX_BITRATE[this.profile];
      enc.priority = 'high';
      enc.networkPriority = 'high';
    }
    await this.sender.setParameters(params).catch((err) => console.warn('[aura] setParameters', err));
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.disconnectTimer);
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}

const MAX_BITRATE: Record<OpusProfile, number> = { music: 128_000, voice: 48_000 };

/**
 * One RTCPeerConnection per receiver. Upload grows linearly with receivers
 * (~128 kbps each for music, ~40 for voice), which is fine for the 10-listener
 * cap on any home uplink.
 */
export class MeshTransport extends Emitter<TransportEvents> implements BroadcastTransport {
  private peers = new Map<string, HostPeer>();
  private active = true;
  private statsTimer: number;

  constructor(
    private readonly track: MediaStreamTrack,
    private iceServers: IceServer[],
    private readonly profile: OpusProfile = 'music',
  ) {
    super();
    this.statsTimer = window.setInterval(() => void this.pollStats(), STATS_MS);
  }

  addPeer(peerId: string): void {
    if (this.peers.has(peerId)) return;
    const peer = new HostPeer(peerId, this.track, this.iceServers, this.active, this.profile, {
      signal: (payload) => this.emit('signal', { peerId, payload }),
      state: (state) => this.emit('state', { peerId, state }),
    });
    this.peers.set(peerId, peer);
  }

  removePeer(peerId: string): void {
    this.peers.get(peerId)?.close();
    this.peers.delete(peerId);
  }

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  handleSignal(peerId: string, payload: SignalPayload): void {
    void this.peers.get(peerId)?.handle(payload).catch((err) => console.warn('[aura] signal', err));
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const p of this.peers.values()) p.setActive(active);
  }

  setIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    for (const p of this.peers.values()) p.pc.setConfiguration({ ...p.pc.getConfiguration(), iceServers: toRtcIceServers(servers) });
  }

  restartAll(): void {
    for (const p of this.peers.values()) p.restartIce();
  }

  private async pollStats() {
    for (const [peerId, p] of this.peers) {
      if (p.pc.connectionState !== 'connected') continue;
      try {
        const stats = await sampleOutbound(p.pc);
        this.emit('quality', { peerId, quality: rateLink(stats) });
      } catch {
        /* peer closed mid-sample */
      }
    }
  }

  close(): void {
    window.clearInterval(this.statsTimer);
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.clearListeners();
  }
}
