import { AnalyserLevel } from './level';
import type { AudioSource } from './sources/types';

/**
 * Sender-side audio graph:
 *
 *   source(s) ─► per-source gain ─► master gain ─┬─► MediaStreamDestination ─► WebRTC
 *                                                └─► analyser (meter)
 *
 * The graph costs a few ms over sending the raw track, and buys:
 *  - a single outgoing track regardless of how many sources are mixed (mic later)
 *  - click-free mute via gain ramps
 *  - a meter that shows exactly what listeners receive
 *
 * Construct inside a user gesture so the AudioContext may start.
 */
export class AudioMixer {
  readonly ctx: AudioContext;
  readonly level: AnalyserLevel;
  private readonly master: GainNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly inputs = new Map<AudioSource, { node: AudioNode; gain: GainNode }>();

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume();
    this.master = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    const analyser = this.ctx.createAnalyser();
    this.master.connect(this.dest);
    this.master.connect(analyser);
    this.level = new AnalyserLevel(analyser);
  }

  /** The mixed output: one stereo track to hand to the transport. */
  get track(): MediaStreamTrack {
    const t = this.dest.stream.getAudioTracks()[0];
    if (!t) throw new Error('Mixer has no output track');
    return t;
  }

  add(source: AudioSource): void {
    const node = source.connect(this.ctx);
    const gain = this.ctx.createGain();
    node.connect(gain).connect(this.master);
    this.inputs.set(source, { node, gain });
  }

  remove(source: AudioSource): void {
    const input = this.inputs.get(source);
    if (!input) return;
    input.node.disconnect();
    input.gain.disconnect();
    this.inputs.delete(source);
  }

  setMuted(muted: boolean): void {
    // 10ms time-constant ramp avoids an audible click.
    this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
  }

  close(): void {
    for (const s of [...this.inputs.keys()]) this.remove(s);
    this.dest.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => {});
  }
}
