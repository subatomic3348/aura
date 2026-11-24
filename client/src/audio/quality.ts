import type { LinkStats, Quality } from '../session/types';

/**
 * Collapse link metrics into a 4-step rating. Thresholds are tuned for
 * one-way streamed audio (not conversation): loss matters most, then jitter
 * (it forces a deeper jitter buffer = more delay), then RTT.
 */
export function rateLink({ rttMs, jitterMs, lossPct }: LinkStats): Quality {
  if (rttMs === null && jitterMs === null && lossPct === null) return 'unknown';
  const loss = lossPct ?? 0;
  const jitter = jitterMs ?? 0;
  const rtt = rttMs ?? 0;
  if (loss > 5 || jitter > 60 || rtt > 400) return 'poor';
  if (loss > 2 || jitter > 30 || rtt > 200) return 'fair';
  if (loss > 0.5 || jitter > 15 || rtt > 80) return 'good';
  return 'excellent';
}

export interface ReceiverStats extends LinkStats {
  relayed: boolean;
  /** Average time audio waited in the jitter buffer over the last interval. */
  bufferMs: number | null;
}

/** Tracks packet counters between calls so loss is measured per interval, not cumulatively. */
export class InboundStatsSampler {
  private lastLost = 0;
  private lastReceived = 0;
  private lastBufferDelay = 0;
  private lastEmitted = 0;

  async sample(pc: RTCPeerConnection): Promise<ReceiverStats> {
    const report = await pc.getStats();
    let rttMs: number | null = null;
    let jitterMs: number | null = null;
    let lossPct: number | null = null;
    let bufferMs: number | null = null;
    let relayed = false;
    let pairLocal: string | undefined;
    let pairRemote: string | undefined;

    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        if (typeof s.jitter === 'number') jitterMs = s.jitter * 1000;
        const lost = Math.max(0, s.packetsLost ?? 0);
        const received = s.packetsReceived ?? 0;
        const dLost = lost - this.lastLost;
        const dRecv = received - this.lastReceived;
        if (dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
        this.lastLost = lost;
        this.lastReceived = received;
        // jitterBufferDelay is the sum, over every sample played, of its wait in the buffer.
        if (typeof s.jitterBufferDelay === 'number' && typeof s.jitterBufferEmittedCount === 'number') {
          const dDelay = s.jitterBufferDelay - this.lastBufferDelay;
          const dEmitted = s.jitterBufferEmittedCount - this.lastEmitted;
          if (dEmitted > 0) bufferMs = (dDelay / dEmitted) * 1000;
          this.lastBufferDelay = s.jitterBufferDelay;
          this.lastEmitted = s.jitterBufferEmittedCount;
        }
      }
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        if (typeof s.currentRoundTripTime === 'number') rttMs = s.currentRoundTripTime * 1000;
        pairLocal = s.localCandidateId;
        pairRemote = s.remoteCandidateId;
      }
    });
    for (const id of [pairLocal, pairRemote]) {
      if (id && report.get(id)?.candidateType === 'relay') relayed = true;
    }
    return { rttMs, jitterMs, lossPct, relayed, bufferMs };
  }
}

/** Sharer side before the network: capture buffer (~5 ms) + one 10 ms Opus packet. */
const SEND_MS = 15;

/**
 * How far behind the sharer's own speakers this device plays, roughly:
 * send side + one-way network + jitter buffer + this device's audio output.
 */
export function estimateDelay(st: { rttMs: number | null; bufferMs: number | null }, outputMs: number): number | null {
  if (st.bufferMs === null) return null;
  return Math.round(SEND_MS + (st.rttMs ?? 0) / 2 + st.bufferMs + outputMs);
}

/** Sender's view of one receiver, from RTCP receiver reports. */
export async function sampleOutbound(pc: RTCPeerConnection): Promise<LinkStats> {
  const report = await pc.getStats();
  let rttMs: number | null = null;
  let jitterMs: number | null = null;
  let lossPct: number | null = null;
  report.forEach((s) => {
    if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') {
      if (typeof s.roundTripTime === 'number') rttMs = s.roundTripTime * 1000;
      if (typeof s.jitter === 'number') jitterMs = s.jitter * 1000;
      if (typeof s.fractionLost === 'number') lossPct = s.fractionLost * 100;
    }
    if (rttMs === null && s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') {
      rttMs = s.currentRoundTripTime * 1000;
    }
  });
  return { rttMs, jitterMs, lossPct };
}
