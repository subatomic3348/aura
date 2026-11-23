import type { IceServer, SignalPayload } from '@aura/protocol';
import { Emitter } from '../lib/emitter';
import { candidatePayload, toRtcIceServers } from './rtc';
import { tuneOpus, type OpusProfile } from './sdp';

export type LinkState = 'connecting' | 'connected' | 'disconnected' | 'failed';

interface LinkEvents extends Record<string, unknown> {
  signal: SignalPayload;
  state: LinkState;
  stream: MediaStream;
}

/**
 * Receiver side of the WebRTC link. Purely reactive: it answers whatever
 * offers the broadcaster sends, including ICE-restart offers, so recovery
 * is driven from one side only.
 */
export class ReceiverLink extends Emitter<LinkEvents> {
  readonly pc: RTCPeerConnection;
  private queued: RTCIceCandidateInit[] = [];
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    iceServers: IceServer[],
    private readonly profile: OpusProfile = 'music',
  ) {
    super();
    this.pc = new RTCPeerConnection({ iceServers: toRtcIceServers(iceServers), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc.onicecandidate = (e) => this.emit('signal', candidatePayload(e.candidate));
    this.pc.ontrack = (e) => {
      // Keep jitter buffer adaptive at its minimum; explicit low targets can
      // starve on Wi-Fi. (jitterBufferTarget is a floor, not a ceiling.)
      this.emit('stream', e.streams[0] ?? new MediaStream([e.track]));
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected' || s === 'disconnected' || s === 'failed') this.emit('state', s);
      else if (s === 'new' || s === 'connecting') this.emit('state', 'connecting');
    };
  }

  /** Signals are processed strictly in order (an answer must not race its candidates). */
  handle(payload: SignalPayload): void {
    this.chain = this.chain.then(() => this.process(payload)).catch((err) => console.warn('[aura] signal', err));
  }

  private async process(payload: SignalPayload) {
    if (this.closed) return;
    if (payload.kind === 'description') {
      if (payload.type !== 'offer') return;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      for (const c of this.queued.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      const answer = await this.pc.createAnswer();
      // Receiver's answer is what tells the sender's encoder to go stereo / high bitrate.
      answer.sdp = tuneOpus(answer.sdp ?? '', this.profile);
      await this.pc.setLocalDescription(answer);
      this.emit('signal', { kind: 'description', type: 'answer', sdp: answer.sdp });
    } else if (payload.candidate) {
      const c = payload.candidate as RTCIceCandidateInit;
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => {});
      else this.queued.push(c);
    }
  }

  close(): void {
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    this.clearListeners();
  }
}
