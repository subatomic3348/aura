import type { ClientMessage, IceServer, RoomSnapshot, SignalPayload } from '@aura/protocol';
import type { LevelSource } from '../audio/level';
import type { AudioOutput } from '../audio/playback';
import { ReceiverLink } from '../audio/receiver';
import { captureMicrophone } from '../audio/sources/mic';
import { CaptureError, type AudioSource } from '../audio/sources/types';
import { MicPip, pipSupported } from '../audio/pip';
import { MeshTransport } from '../audio/transport/mesh';
import { getCapabilities } from '../lib/capabilities';
import { keepScreenOn } from '../lib/wakelock';
import type { VoiceError } from './types';

const SPEAKING_POLL_MS = 100;
/** Level (0..1, see AnalyserLevel) above which someone counts as talking: ≈ -37 dBFS. */
const SPEAKING_LEVEL = 0.32;
/** Keep showing someone as talking this long after they go quiet (gaps between words). */
const SPEAKING_HOLD_MS = 700;
/** After the page hides, wait this long for an automatic PiP window before muting. */
const BACKGROUND_MUTE_MS = 1000;

export interface VoiceHost {
  me(): string | null;
  output(): AudioOutput | null;
  send(msg: ClientMessage): void;
  /** Shown in the floating window, e.g. "Aura · room ABCD". */
  title(): string;
  /** Voice state changed outside a room snapshot: re-render. */
  changed(): void;
}

/** off → starting (permission prompt) → claiming (asked the server) → live */
type MicPhase = 'off' | 'starting' | 'claiming' | 'live';

/**
 * Two-way voice, alongside the room's single shared sound. Any number of
 * members (up to MAX_SPEAKERS) may have their microphone live; everyone hears
 * all of them:
 *
 *   my mic ─► MeshTransport('voice') ─► every other member
 *   each other speaker ─► ReceiverLink('voice') ─► AudioOutput.attachVoice
 *
 * Every link is one send-only RTCPeerConnection owned by the speaker, exactly
 * like sharing, so two speakers have two connections between them (one each
 * way) and never glare. Who is talking is measured locally from the levels of
 * what this device hears (and its own mic).
 */
export class VoiceController {
  private phase: MicPhase = 'off';
  private mic: AudioSource | null = null;
  private meter: { level: LevelSource; close(): void } | null = null;
  private transport: MeshTransport | null = null;
  private muted = false;
  private releaseWake: (() => void) | null = null;
  /** Android only: keeps the mic alive in the background while open. */
  private pip: MicPip | null = null;
  /** The page is in the background without a PiP window: the browser has cut my mic. */
  private backgroundMuted = false;
  private bgTimer: number | undefined;

  private links = new Map<string, { link: ReceiverLink; level: LevelSource | null }>();
  private room: RoomSnapshot | null = null;
  private lastMe: string | null = null;
  private iceServers: IceServer[] = [];

  private loudAt = new Map<string, number>();
  private speaking: string[] = [];
  private pollTimer: number | undefined;

  error: VoiceError | null = null;

  constructor(private readonly host: VoiceHost) {}

  /* ───────────── view ───────────── */

  get micState(): 'off' | 'starting' | 'live' {
    return this.phase === 'live' ? 'live' : this.phase === 'off' ? 'off' : 'starting';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get pipState(): 'unavailable' | 'closed' | 'open' {
    if (!this.pip) return 'unavailable';
    return this.pip.isOpen ? 'open' : 'closed';
  }

  /** Open the floating window that keeps my mic on in the background. Call from a tap. */
  openPip(): void {
    void this.pip?.open().then(() => this.host.changed());
  }

  /** My microphone's level while it is on. */
  get level(): LevelSource | null {
    return this.meter?.level ?? null;
  }

  /** Members audibly talking right now (me included), in the order they went live. */
  get speakingIds(): readonly string[] {
    return this.speaking;
  }

  /* ───────────── my microphone ───────────── */

  /** Turn my mic on. Call from a tap: the permission prompt may need one. */
  start(): void {
    if (this.phase !== 'off' || !this.mayTalk()) return;
    this.phase = 'starting';
    this.error = null;
    this.host.changed();
    void this.capture();
  }

  private mayTalk(): boolean {
    const me = this.host.me();
    return !!me && !!this.room && (this.room.hostId === me || this.room.micGrants.includes(me));
  }

  private async capture() {
    let src: AudioSource;
    try {
      src = await captureMicrophone();
    } catch (err) {
      if (this.phase !== 'starting') return;
      console.warn('[aura] microphone failed', err);
      this.phase = 'off';
      const code = err instanceof CaptureError ? err.code : 'unknown';
      const detail = (err as Error)?.message;
      this.error = detail && code !== 'permission-denied' ? { code, detail } : { code };
      this.host.changed();
      return;
    }
    if (this.phase !== 'starting') {
      src.stop(); // cancelled, or left the room, meanwhile
      return;
    }
    this.mic = src;
    this.muted = false;
    this.meter = src.track ? (this.host.output()?.analyse(src.track) ?? null) : null;
    src.onEnded(() => this.stop());
    this.phase = 'claiming';
    this.host.send({ type: 'mic:start', muted: false });
    this.host.changed();
  }

  /** Mic off (or cancel turning it on). Uses up the host's approval. */
  stop(): void {
    if (this.phase === 'off') return;
    const claimed = this.phase !== 'starting';
    this.release();
    if (claimed) this.host.send({ type: 'mic:stop' });
    this.host.changed();
  }

  setMuted(muted: boolean): void {
    if (this.phase !== 'live' || !this.mic?.track) return;
    this.muted = muted;
    // A disabled track sends silence without renegotiating.
    this.mic.track.enabled = !muted;
    this.sendMuted();
    this.pip?.update(this.host.title(), muted);
    this.host.changed();
  }

  /** Others see me muted while the browser has cut my mic in the background. */
  private sendMuted() {
    this.host.send({ type: 'mic:state', muted: this.muted || this.backgroundMuted });
  }

  private onVisibility = () => {
    window.clearTimeout(this.bgTimer);
    if (document.visibilityState === 'visible') this.setBackgroundMuted(false);
    // Give an automatic PiP window a moment to open first.
    else this.bgTimer = window.setTimeout(this.checkBackground, BACKGROUND_MUTE_MS);
  };

  private checkBackground = () => {
    if (this.phase !== 'live') return;
    this.setBackgroundMuted(document.visibilityState === 'hidden' && !this.pip?.isOpen);
  };

  private setBackgroundMuted(on: boolean) {
    if (on === this.backgroundMuted || this.phase !== 'live') return;
    this.backgroundMuted = on;
    this.sendMuted();
  }

  private beginTransport() {
    const track = this.mic?.track;
    if (!track || this.transport) return;
    const t = new MeshTransport(track, this.iceServers, 'voice');
    t.on('signal', ({ peerId, payload }) =>
      this.host.send({ type: 'signal', to: peerId, link: 'voice', fromSender: true, payload }),
    );
    this.transport = t;
    // Android Chrome cuts the mic of a page in the background; a PiP window keeps it.
    if (getCapabilities().platform === 'android') {
      document.addEventListener('visibilitychange', this.onVisibility);
      if (pipSupported()) {
        this.pip = new MicPip();
        this.pip.update(this.host.title(), this.muted);
        this.pip.onChange(() => {
          this.checkBackground();
          this.host.changed();
        });
      }
    }
    // Phones stop the microphone when the screen locks.
    void keepScreenOn().then((release) => {
      if (this.transport === t) this.releaseWake = release;
      else release();
    });
  }

  private release() {
    this.transport?.close();
    this.transport = null;
    this.meter?.close();
    this.meter = null;
    this.mic?.stop();
    this.mic = null;
    this.releaseWake?.();
    this.releaseWake = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearTimeout(this.bgTimer);
    this.pip?.close();
    this.pip = null;
    this.backgroundMuted = false;
    this.phase = 'off';
    this.muted = false;
    this.loudAt.delete(this.lastMe ?? '');
  }

  /* ───────────── room reconciliation ───────────── */

  sync(room: RoomSnapshot): void {
    this.room = room;
    const me = this.host.me();
    if (me !== this.lastMe) {
      // Rejoined as a new member: every speaker builds fresh connections to us.
      for (const id of [...this.links.keys()]) this.closeLink(id);
      if (this.lastMe !== null && this.phase !== 'off') this.release();
      this.lastMe = me;
    }
    const live = new Set(room.speakers.map((s) => s.id));
    const amLive = !!me && live.has(me);

    if (this.phase === 'claiming' && amLive) {
      this.phase = 'live';
      this.beginTransport();
    } else if (this.phase === 'live' && !amLive) {
      this.release();
      if (room.hostId !== me) this.error = { code: 'taken-over' };
    } else if (this.phase === 'off' && amLive) {
      // The server still has our mic on but this page doesn't: correct it.
      this.host.send({ type: 'mic:stop' });
    }

    if (this.transport) {
      const ids = new Set(room.members.map((x) => x.id));
      for (const id of this.transport.peerIds()) if (!ids.has(id)) this.transport.removePeer(id);
      for (const x of room.members) {
        if (x.id !== me && x.online && !this.transport.hasPeer(x.id)) this.transport.addPeer(x.id);
      }
    }

    for (const id of [...this.links.keys()]) if (!live.has(id)) this.closeLink(id);
    for (const s of room.speakers) if (s.id !== me && !this.links.has(s.id)) this.openLink(s.id);

    this.updatePolling();
  }

  handleSignal(from: string, fromSender: boolean, payload: SignalPayload): void {
    if (fromSender) this.links.get(from)?.link.handle(payload);
    else this.transport?.handleSignal(from, payload);
  }

  onError(code: string, detail: string): void {
    if (code === 'denied') {
      this.error = { code: 'denied' };
    } else if (code === 'busy' || code === 'not-allowed') {
      if (this.phase === 'claiming') this.release();
      this.error = { code, detail };
    } else {
      console.warn('[aura] mic error', code, detail);
      return;
    }
    this.host.changed();
  }

  setIceServers(servers: IceServer[]): void {
    this.iceServers = servers;
    this.transport?.setIceServers(servers);
  }

  /** After a network change: the sending side drives ICE restarts. */
  restartAll(): void {
    this.transport?.restartAll();
  }

  /* ───────────── hearing others ───────────── */

  private openLink(id: string) {
    const link = new ReceiverLink(this.iceServers, 'voice');
    const entry: { link: ReceiverLink; level: LevelSource | null } = { link, level: null };
    this.links.set(id, entry);
    link.on('signal', (payload) => this.host.send({ type: 'signal', to: id, link: 'voice', fromSender: false, payload }));
    link.on('stream', (stream) => {
      entry.level = this.host.output()?.attachVoice(id, stream) ?? null;
    });
  }

  private closeLink(id: string) {
    const e = this.links.get(id);
    if (!e) return;
    this.links.delete(id);
    e.link.close();
    this.host.output()?.detachVoice(id);
    this.loudAt.delete(id);
  }

  /* ───────────── who is talking ───────────── */

  private updatePolling() {
    const needed = this.links.size > 0 || this.phase === 'live';
    if (needed && this.pollTimer === undefined) {
      this.pollTimer = window.setInterval(this.poll, SPEAKING_POLL_MS);
    } else if (!needed && this.pollTimer !== undefined) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.loudAt.clear();
      if (this.speaking.length) {
        this.speaking = [];
        this.host.changed();
      }
    }
  }

  private poll = () => {
    const now = performance.now();
    const me = this.host.me();
    const speakers = this.room?.speakers ?? [];
    const loud = (id: string, level: LevelSource | null, muted: boolean) => {
      if (!muted && level && level.getLevel() >= SPEAKING_LEVEL) this.loudAt.set(id, now);
    };
    if (me && this.phase === 'live') loud(me, this.meter?.level ?? null, this.muted);
    for (const s of speakers) {
      const e = this.links.get(s.id);
      if (e) loud(s.id, e.level, s.muted);
    }
    const next = speakers
      .map((s) => s.id)
      .filter((id) => {
        const t = this.loudAt.get(id);
        return t !== undefined && now - t < SPEAKING_HOLD_MS;
      });
    if (next.join() !== this.speaking.join()) {
      this.speaking = next;
      this.host.changed();
    }
  };

  /** Leaving the room. The AudioOutput is closed by the caller afterwards. */
  close(): void {
    this.release();
    for (const id of [...this.links.keys()]) this.closeLink(id);
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.loudAt.clear();
    this.speaking = [];
    this.room = null;
    this.lastMe = null;
    this.error = null;
  }
}
