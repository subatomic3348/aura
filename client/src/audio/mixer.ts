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
 *
 * Phones suspend a page's AudioContext whenever it goes to the background —
 * including while the file picker or a permission prompt is open — and do
 * not resume it on return. A suspended mixer sends pure silence while
 * everything *looks* fine, so the mixer resumes itself on every return to the
 * foreground and reports its state so the UI can offer a manual resume.
 */
export class AudioMixer {
  readonly ctx: AudioContext;
  readonly level: AnalyserLevel;
  private readonly master: GainNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly inputs = new Map<AudioSource, { node: AudioNode; gain: GainNode }>();
  private stateListeners = new Set<() => void>();

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

    this.ctx.addEventListener('statechange', this.onState);
    document.addEventListener('visibilitychange', this.onForeground);
    window.addEventListener('pageshow', this.onForeground);
    window.addEventListener('focus', this.onForeground);
  }

  /** True while audio is actually flowing to listeners. */
  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Try to resume; succeeds without a tap on most browsers, iOS may need one. */
  resume(): Promise<void> {
    if (this.ctx.state === 'running' || this.ctx.state === 'closed') return Promise.resolve();
    return this.ctx.resume().catch(() => {});
  }

  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private onState = () => {
    // Some browsers report 'interrupted' (calls, Siri); try to come back.
    if (this.ctx.state !== 'running' && document.visibilityState === 'visible') void this.resume();
    this.stateListeners.forEach((fn) => fn());
  };

  private onForeground = () => {
    if (document.visibilityState === 'visible') void this.resume();
  };

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
    this.ctx.removeEventListener('statechange', this.onState);
    document.removeEventListener('visibilitychange', this.onForeground);
    window.removeEventListener('pageshow', this.onForeground);
    window.removeEventListener('focus', this.onForeground);
    this.stateListeners.clear();
    for (const s of [...this.inputs.keys()]) this.remove(s);
    this.dest.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => {});
  }
}
