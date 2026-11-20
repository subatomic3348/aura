import { getCapabilities } from '../lib/capabilities';
import { AnalyserLevel } from './level';

/**
 * Receiver playback. Two paths, chosen for latency vs. platform limits:
 *
 *  element (default, lowest latency)
 *    remote stream ─► <audio> ─► speakers          volume = element.volume
 *                 └─► MediaStreamSource ─► analyser (meter only, not audible)
 *
 *  webaudio (iOS)
 *    remote stream ─► MediaStreamSource ─┬─► gain ─► speakers
 *                                        └─► analyser
 *    iOS ignores HTMLMediaElement.volume, so the slider needs a GainNode there.
 *    Routing playback through Web Audio adds a buffer hop, so it's iOS-only.
 *
 * Chrome only pulls audio from a remote WebRTC stream if it's attached to a
 * media element, so the element is attached in both modes (muted in webaudio).
 *
 * Construct inside a user gesture (the join tap): that unlocks playback under
 * autoplay policies, including iOS.
 */
export class AudioOutput {
  readonly level: AnalyserLevel;
  readonly mode: 'element' | 'webaudio';
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly element: HTMLAudioElement;
  private source: MediaStreamAudioSourceNode | null = null;
  private volume = 1;
  private blocked = false;
  private stateListeners = new Set<() => void>();

  constructor() {
    this.mode = getCapabilities().platform === 'ios' ? 'webaudio' : 'element';
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume();
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    if (this.mode === 'webaudio') this.gain.connect(this.ctx.destination);
    this.level = new AnalyserLevel(this.analyser);

    this.element = new Audio();
    this.element.muted = this.mode === 'webaudio';
    this.element.autoplay = true;
    this.element.setAttribute('playsinline', '');
    // Unlock the element inside the tap (no source yet; the promise may reject harmlessly).
    void this.element.play().catch(() => {});
    this.element.addEventListener('playing', this.notify);
    this.element.addEventListener('pause', this.notify);

    // Mobile browsers suspend audio when backgrounded / on interruptions.
    document.addEventListener('visibilitychange', this.resume);
    this.ctx.addEventListener('statechange', this.resume);
  }

  private notify = () => this.stateListeners.forEach((fn) => fn());

  private resume = () => {
    if (document.visibilityState === 'visible') {
      if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => {});
      if (this.element.srcObject && this.element.paused) this.playElement();
    }
    this.notify();
  };

  private playElement() {
    this.element
      .play()
      .then(() => {
        this.blocked = false;
        this.notify();
      })
      .catch(() => {
        // Autoplay refused (no recent tap): the UI offers "Tap to resume sound".
        this.blocked = true;
        this.notify();
      });
  }

  /** Resume from a tap (iOS only allows resuming audio inside a user gesture). */
  unlock(): void {
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => {});
    this.playElement();
  }

  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  attach(stream: MediaStream): void {
    this.source?.disconnect();
    this.element.srcObject = stream;
    this.playElement();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    if (this.mode === 'webaudio') this.source.connect(this.gain);
    this.resume();
  }

  /** 0..1 slider value, mapped to a perceptual (squared) curve. */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    const g = this.volume * this.volume;
    if (this.mode === 'element') this.element.volume = g;
    else this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
  }

  /** True when sound can actually reach the speakers. */
  get running(): boolean {
    if (this.mode === 'webaudio') return this.ctx.state === 'running';
    return !this.blocked;
  }

  close(): void {
    this.stateListeners.clear();
    document.removeEventListener('visibilitychange', this.resume);
    this.ctx.removeEventListener('statechange', this.resume);
    this.element.removeEventListener('playing', this.notify);
    this.element.removeEventListener('pause', this.notify);
    this.source?.disconnect();
    this.element.pause();
    this.element.srcObject = null;
    void this.ctx.close().catch(() => {});
  }
}
