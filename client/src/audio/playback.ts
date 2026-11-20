import { AnalyserLevel } from './level';

/**
 * Receiver playback.
 *
 *   remote stream ─► MediaStreamSource ─┬─► gain (volume) ─► speakers
 *                                       └─► analyser (meter: shows what arrives,
 *                                           independent of local volume)
 *
 * Why Web Audio rather than just <audio>.volume:
 *  - iOS ignores HTMLMediaElement.volume (it is read-only there), so a volume
 *    slider would silently do nothing on iPhones.
 *  - The analyser gives the meter real received audio.
 *
 * Chrome only pulls audio from a remote WebRTC stream if the stream is also
 * attached to a media element, so a *muted* <audio> element is kept attached.
 *
 * Construct inside a user gesture (the "Start listening" tap): that is what
 * unlocks audio output under autoplay policies, including iOS.
 */
export class AudioOutput {
  readonly level: AnalyserLevel;
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly element: HTMLAudioElement;
  private source: MediaStreamAudioSourceNode | null = null;
  private volume = 1;
  private stateListeners = new Set<() => void>();

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume();
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.gain.connect(this.ctx.destination);
    this.level = new AnalyserLevel(this.analyser);

    this.element = new Audio();
    this.element.muted = true;
    this.element.autoplay = true;
    this.element.setAttribute('playsinline', '');

    // Mobile browsers suspend audio when backgrounded / on interruptions.
    document.addEventListener('visibilitychange', this.resume);
    this.ctx.addEventListener('statechange', this.resume);
  }

  private resume = () => {
    if (document.visibilityState === 'visible' && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      void this.ctx.resume().catch(() => {});
    }
    this.stateListeners.forEach((fn) => fn());
  };

  /** Resume from a tap (iOS only allows resuming audio inside a user gesture). */
  unlock(): void {
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => {});
    void this.element.play().catch(() => {});
  }

  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  attach(stream: MediaStream): void {
    this.source?.disconnect();
    this.element.srcObject = stream;
    void this.element.play().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.gain);
    this.source.connect(this.analyser);
    this.resume();
  }

  /** 0..1 slider value, mapped to a perceptual (squared) gain curve. */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.gain.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.015);
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  close(): void {
    this.stateListeners.clear();
    document.removeEventListener('visibilitychange', this.resume);
    this.ctx.removeEventListener('statechange', this.resume);
    this.source?.disconnect();
    this.element.srcObject = null;
    void this.ctx.close().catch(() => {});
  }
}
