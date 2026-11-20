import { Store } from '../../session/store';
import type { AudioSource, LocalPlayback } from './types';

export interface PlayerState {
  tracks: string[];
  index: number;
  playing: boolean;
  /** Playback was blocked (iOS needs a tap on Play). */
  blocked: boolean;
}

/**
 * Music files from this device, played by Aura itself — the way a phone
 * shares sound, since phone browsers can't capture other apps' audio.
 *
 *   <audio> ─► MediaElementSource ─┬─► out ─► mixer ─► listeners
 *                                  └─► local (gain) ─► this device's speakers
 *
 * Because Aura does the playing, "play on this device" is just the `local`
 * gain: turning it off silences this device without touching what listeners hear.
 */
export class FileSource extends Store<PlayerState> implements AudioSource {
  readonly kind = 'file' as const;
  readonly localPlayback: LocalPlayback;
  private readonly el = new Audio();
  private readonly urls: string[];
  private local: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private localOn = true;

  constructor(private readonly files: File[]) {
    super({ tracks: files.map((f) => f.name.replace(/\.[a-z0-9]+$/i, '')), index: 0, playing: false, blocked: false });
    this.urls = files.map((f) => URL.createObjectURL(f));
    this.el.preload = 'auto';
    this.el.setAttribute('playsinline', '');
    this.el.addEventListener('play', () => this.patch({ playing: true, blocked: false }));
    this.el.addEventListener('pause', () => this.patch({ playing: false }));
    this.el.addEventListener('ended', () => {
      if (this.state.index < this.files.length - 1) this.go(this.state.index + 1, true);
    });
    this.el.src = this.urls[0]!;

    const self = this;
    this.localPlayback = {
      get on() {
        return self.localOn;
      },
      async set(on: boolean) {
        self.localOn = on;
        self.local?.gain.setTargetAtTime(on ? 1 : 0, self.local.context.currentTime, 0.02);
        return true;
      },
    };
  }

  get label(): string {
    return this.state.tracks[this.state.index] ?? 'Music';
  }

  get element(): HTMLAudioElement {
    return this.el;
  }

  connect(ctx: AudioContext): AudioNode {
    this.ctx = ctx;
    const src = ctx.createMediaElementSource(this.el);
    const out = ctx.createGain();
    this.local = ctx.createGain();
    this.local.gain.value = this.localOn ? 1 : 0;
    src.connect(out);
    src.connect(this.local).connect(ctx.destination);
    return out;
  }

  play = (): void => {
    // A tap on Play is a user gesture: the moment iOS allows audio to resume.
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    this.el.play().catch(() => this.patch({ blocked: true }));
  };

  pause = (): void => this.el.pause();

  toggle = (): void => (this.el.paused ? this.play() : this.pause());

  next = (): void => {
    if (this.state.index < this.files.length - 1) this.go(this.state.index + 1, true);
  };

  prev = (): void => {
    // Like every player: restart the track unless we're at its very start.
    if (this.el.currentTime > 3 || this.state.index === 0) this.el.currentTime = 0;
    else this.go(this.state.index - 1, true);
  };

  seek(fraction: number): void {
    if (Number.isFinite(this.el.duration)) this.el.currentTime = fraction * this.el.duration;
  }

  private go(index: number, autoplay: boolean) {
    this.el.src = this.urls[index]!;
    this.patch({ index });
    if (autoplay) this.play();
  }

  private patch(p: Partial<PlayerState>) {
    this.set({ ...this.state, ...p });
  }

  onEnded(): void {
    // A playlist doesn't end the share; the sharer stops it.
  }

  stop(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
