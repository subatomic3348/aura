/**
 * A Picture-in-Picture window that keeps the microphone working in the
 * background on Android.
 *
 * Chrome on Android cuts a page's microphone off a few seconds after the page
 * leaves the screen (another app in front, screen locked), even though incoming
 * audio keeps playing; the page gets silence and no event. While the page owns
 * a Picture-in-Picture window, Chrome is still on screen (as that floating
 * window), so capture continues. The window shows a small "mic on" card drawn
 * on a canvas.
 *
 * Opening it needs a tap (`open()`). Browsers that support automatic PiP for
 * calls use the Media Session `enterpictureinpicture` action when the user
 * leaves the page; elsewhere registering it is a harmless no-op.
 */

type PipVideo = HTMLVideoElement & { autoPictureInPicture?: boolean };

const W = 320;
const H = 180;

export function pipSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    !!document.pictureInPictureEnabled &&
    typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

export class MicPip {
  private readonly canvas = document.createElement('canvas');
  private readonly video = document.createElement('video') as PipVideo;
  private timer: number | undefined;
  private title = 'Aura';
  private muted = false;
  private listeners = new Set<() => void>();

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.draw();
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoPictureInPicture = true;
    this.video.srcObject = this.canvas.captureStream(2);
    // Off-screen but attached: some browsers only open PiP for videos in the page.
    Object.assign(this.video.style, { position: 'fixed', left: '-10px', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    this.video.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.video);
    // The window shows nothing until the stream has frames: keep redrawing.
    this.timer = window.setInterval(() => this.draw(), 1000);
    this.video.addEventListener('enterpictureinpicture', this.notify);
    this.video.addEventListener('leavepictureinpicture', this.notify);
    void this.video.play().catch(() => {});
    try {
      navigator.mediaSession?.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => void this.open());
    } catch {
      /* not supported */
    }
  }

  get isOpen(): boolean {
    return document.pictureInPictureElement === this.video;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify = () => this.listeners.forEach((fn) => fn());

  update(title: string, muted: boolean): void {
    if (title === this.title && muted === this.muted) return;
    this.title = title;
    this.muted = muted;
    this.draw();
  }

  /** Call from a tap. Resolves false if the browser refused. */
  async open(): Promise<boolean> {
    if (this.isOpen) return true;
    try {
      if (this.video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve) => this.video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
      }
      await this.video.play().catch(() => {});
      await this.video.requestPictureInPicture();
      return true;
    } catch (err) {
      console.warn('[aura] picture-in-picture', err);
      return false;
    }
  }

  private draw() {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.fillStyle = '#0d0f12';
    g.fillRect(0, 0, W, H);
    // Mic dot: red when live, grey when muted; pulses so frames keep changing.
    const pulse = 0.75 + 0.25 * Math.sin(Date.now() / 500);
    g.beginPath();
    g.arc(W / 2, 66, 22 * (this.muted ? 1 : pulse), 0, Math.PI * 2);
    g.fillStyle = this.muted ? '#6b7280' : '#ef4444';
    g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#f3f4f6';
    g.font = '600 22px system-ui, sans-serif';
    g.fillText(this.muted ? 'Mic muted' : 'Mic on', W / 2, 124);
    g.fillStyle = '#9ca3af';
    g.font = '15px system-ui, sans-serif';
    g.fillText(this.title, W / 2, 152);
  }

  close(): void {
    window.clearInterval(this.timer);
    try {
      navigator.mediaSession?.setActionHandler('enterpictureinpicture' as MediaSessionAction, null);
    } catch {
      /* ignore */
    }
    if (this.isOpen) void document.exitPictureInPicture().catch(() => {});
    this.video.removeEventListener('enterpictureinpicture', this.notify);
    this.video.removeEventListener('leavepictureinpicture', this.notify);
    this.listeners.clear();
    this.video.pause();
    (this.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.video.remove();
  }
}
