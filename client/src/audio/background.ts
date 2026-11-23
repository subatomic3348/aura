/**
 * Keeps a phone playing the room's sound while Aura is in the background
 * (another app in front, or the screen locked).
 *
 * Phones only keep a backgrounded page's audio going when they recognise it as
 * a media player. A WebRTC stream alone doesn't count: Chrome on Android shows
 * no media notification for it (so nothing keeps the page in the foreground
 * service), and iOS files the page under the default "ambient" audio session.
 * So, while there is something to hear or say:
 *
 *  - a looping, practically silent clip plays in an ordinary <audio> element.
 *    That is "real" media: the browser creates a media session for it, with a
 *    notification / lock-screen controls, and keeps the page alive;
 *  - the Media Session API names it ("Aura · room ABCD") and wires the
 *    notification's play/pause buttons to "hold" (mute) the room locally;
 *  - iOS 17+ gets `navigator.audioSession.type` = playback (or play-and-record
 *    while the microphone is live), which allows background audio.
 *
 * The element is unlocked inside the user's tap (see AudioOutput), so it may
 * start and stop later without one.
 */

export interface BackgroundInfo {
  /** Notification title, e.g. "Aura · room ABCD". */
  title: string;
  /** Second line, e.g. "Listening to Pixel 8" or "Voice chat". */
  subtitle: string;
  /** My microphone is live (iOS must keep recording in the background too). */
  recording: boolean;
}

type AudioSessionType = 'auto' | 'playback' | 'play-and-record';
type NavigatorWithAudioSession = Navigator & { audioSession?: { type: AudioSessionType } };

/** The clip must be ≥ 5 s for Chrome to give it a media notification. */
const CLIP_SECONDS = 6;
const CLIP_RATE = 8000;
/**
 * ±16 of 32768 ≈ -66 dBFS: far below anything audible, but above Chrome's
 * silence threshold (≈ -72 dBFS), so the tab still counts as "playing audio"
 * and isn't frozen.
 */
const CLIP_AMPLITUDE = 16;

let clipUrl: string | null = null;

/** A mono 16-bit WAV of faint noise, built once in memory. */
function quietClip(): string {
  if (clipUrl) return clipUrl;
  const samples = CLIP_SECONDS * CLIP_RATE;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, CLIP_RATE, true);
  v.setUint32(28, CLIP_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * CLIP_AMPLITUDE), true);
  clipUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return clipUrl;
}

export class BackgroundAudio {
  private readonly el: HTMLAudioElement;
  private info: BackgroundInfo | null = null;
  private held = false;

  /** @param onHold the notification's pause (true) / play (false) buttons */
  constructor(private readonly onHold: (held: boolean) => void) {
    this.el = new Audio(quietClip());
    this.el.loop = true;
    this.el.setAttribute('playsinline', '');
    // Unlock inside the tap that constructed us, then wait until needed.
    // (If `set()` already asked for playback meanwhile, keep playing.)
    void this.el
      .play()
      .then(() => {
        if (!this.info) this.el.pause();
      })
      .catch(() => {});
    // Something else (a call, another player) took the audio: try again on return.
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /** Describe what is going on, or null when there's nothing to keep alive. */
  set(info: BackgroundInfo | null): void {
    const prev = this.info;
    this.info = info;
    setAudioSession(info ? (info.recording ? 'play-and-record' : 'playback') : 'auto');
    if (!info) {
      if (prev) {
        this.el.pause();
        clearMediaSession();
        if (this.held) this.setHeld(false);
      }
      return;
    }
    if (this.el.paused) this.play();
    if (!prev || prev.title !== info.title || prev.subtitle !== info.subtitle) this.describe(info);
  }

  private play() {
    void this.el.play().catch(() => {
      /* blocked until the next tap; the room's "tap to resume" covers it */
    });
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.info && this.el.paused) this.play();
  };

  private describe(info: BackgroundInfo) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({ title: info.title, artist: info.subtitle, album: 'Aura' });
      ms.playbackState = this.held ? 'paused' : 'playing';
      ms.setActionHandler('play', () => this.setHeld(false));
      ms.setActionHandler('pause', () => this.setHeld(true));
      ms.setActionHandler('stop', () => this.setHeld(true));
    } catch {
      /* older browsers: metadata only, or nothing */
    }
  }

  private setHeld(held: boolean) {
    this.held = held;
    if (navigator.mediaSession) navigator.mediaSession.playbackState = held ? 'paused' : 'playing';
    // Keep the clip running while held so the notification (and the room) stay.
    if (this.info && this.el.paused) this.play();
    this.onHold(held);
  }

  close(): void {
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.info) clearMediaSession();
    this.info = null;
    setAudioSession('auto');
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }
}

function setAudioSession(type: AudioSessionType) {
  const s = (navigator as NavigatorWithAudioSession).audioSession;
  if (!s || s.type === type) return;
  try {
    s.type = type;
  } catch {
    /* unsupported value */
  }
}

function clearMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = null;
    ms.playbackState = 'none';
    for (const a of ['play', 'pause', 'stop'] as const) ms.setActionHandler(a, null);
  } catch {
    /* ignore */
  }
}
