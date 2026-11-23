import { getCapabilities } from '../lib/capabilities';
import { AnalyserLevel, type LevelSource } from './level';

interface Voice {
  element: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
}

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
 * Other members' VOICES (live microphones) play through the same paths, one
 * element (+ analyser, for "who's speaking") per speaker, alongside the shared
 * sound and at the same volume.
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
  private voices = new Map<string, Voice>();
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

    this.element = this.newElement();
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
      for (const v of this.voices.values()) if (v.element.paused) this.playElement(v.element);
    }
    this.notify();
  };

  private newElement(): HTMLAudioElement {
    const el = new Audio();
    el.muted = this.mode === 'webaudio';
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    return el;
  }

  private playElement(el: HTMLAudioElement = this.element) {
    el
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
    // An element with nothing to play rejects, which would read as "blocked".
    if (this.element.srcObject) this.playElement();
    for (const v of this.voices.values()) this.playElement(v.element);
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

  /** Play a member's live microphone. Returns its level, for "who's speaking". */
  attachVoice(id: string, stream: MediaStream): LevelSource {
    this.detachVoice(id);
    const element = this.newElement();
    if (this.mode === 'element') element.volume = this.volume * this.volume;
    element.srcObject = stream;
    this.playElement(element);
    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    source.connect(analyser);
    if (this.mode === 'webaudio') source.connect(this.gain);
    this.voices.set(id, { element, source });
    this.resume();
    return new AnalyserLevel(analyser);
  }

  detachVoice(id: string): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    v.source.disconnect();
    v.element.pause();
    v.element.srcObject = null;
  }

  /** Meter a local track (my own microphone) without playing it. */
  analyse(track: MediaStreamTrack): { level: LevelSource; close(): void } {
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = this.ctx.createAnalyser();
    source.connect(analyser);
    return { level: new AnalyserLevel(analyser), close: () => source.disconnect() };
  }

  /** 0..1 slider value, mapped to a perceptual (squared) curve. */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    const g = this.volume * this.volume;
    if (this.mode === 'element') {
      this.element.volume = g;
      for (const voice of this.voices.values()) voice.element.volume = g;
    } else this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
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
    for (const id of [...this.voices.keys()]) this.detachVoice(id);
    this.source?.disconnect();
    this.element.pause();
    this.element.srcObject = null;
    void this.ctx.close().catch(() => {});
  }
}
