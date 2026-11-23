/**
 * An audio input to the sharing mixer.
 *
 *  system  everything the computer plays (virtual device, or screen share on Windows)
 *  tab     one browser tab (share picker)
 *  file    music files from this device, played by Aura itself (works on phones)
 *  mic     the device's microphone (two-way voice; not mixed with the others)
 *
 * Sources plug into the mixer's AudioContext, so the transport never knows
 * which kind it is sending.
 */
export type SourceKind = 'system' | 'tab' | 'file' | 'mic';

/** Whether this device itself plays the sound it shares. Listeners are unaffected. */
export interface LocalPlayback {
  readonly on: boolean;
  set(on: boolean): Promise<boolean>;
}

export interface AudioSource {
  readonly kind: SourceKind;
  /** Human description of what is being shared. */
  readonly label: string;
  /**
   * The raw track, for live sources. When it is the only source it is sent to
   * listeners directly (skipping the mixer's extra buffering, ~20 ms).
   */
  readonly track?: MediaStreamTrack;
  /** Wire this source into `ctx`; returns the node that carries its audio. */
  connect(ctx: AudioContext): AudioNode;
  /** null when this device can't control local playback for this source. */
  readonly localPlayback: LocalPlayback | null;
  /** Fires once when the source stops on its own (e.g. "Stop sharing" in the browser UI). */
  onEnded(cb: () => void): void;
  stop(): void;
}

export type CaptureErrorCode = 'unsupported' | 'insecure-context' | 'permission-denied' | 'no-audio-track' | 'unknown';

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

/** Shared helper for sources backed by a MediaStreamTrack. */
export function trackSource(
  kind: SourceKind,
  label: string,
  track: MediaStreamTrack,
  localPlayback: LocalPlayback | null,
): AudioSource {
  let ended = false;
  const cbs: Array<() => void> = [];
  track.addEventListener('ended', () => {
    if (ended) return;
    ended = true;
    cbs.forEach((cb) => cb());
  });
  return {
    kind,
    label,
    track,
    localPlayback,
    connect: (ctx) => ctx.createMediaStreamSource(new MediaStream([track])),
    onEnded: (cb) => cbs.push(cb),
    stop: () => {
      ended = true;
      track.stop();
    },
  };
}
