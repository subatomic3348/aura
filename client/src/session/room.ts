import type { IceServer, RoomSnapshot, ServerMessage, ShareState } from '@aura/protocol';
import type { LevelSource } from '../audio/level';
import { AudioMixer } from '../audio/mixer';
import { AudioOutput } from '../audio/playback';
import { InboundStatsSampler, rateLink } from '../audio/quality';
import { ReceiverLink, type LinkState } from '../audio/receiver';
import { captureSound, fileSource, type FileSource, type ShareMode } from '../audio/sources';
import { CaptureError, type AudioSource, type SourceKind } from '../audio/sources/types';
import { MeshTransport } from '../audio/transport/mesh';
import type { BroadcastTransport } from '../audio/transport/types';
import { deviceLabel } from '../lib/device';
import { listenUrl } from '../lib/origin';
import { SignalingClient } from '../signaling/client';
import { Store } from './store';
import type { InRoom, Listening, MemberView, PeerLinkState, Quality, RoomState, ShareError } from './types';

const JOIN_TIMEOUT_MS = 8000;
/** Listener: media path down this long → rejoin as a fresh member. */
const LISTEN_RECOVER_MS = 15_000;
const MAX_REJOINS = 4;
const STATS_MS = 2000;

/**
 * One device's membership in a room. Every device runs the same controller;
 * roles follow the server's `sharerId`:
 *
 *   sharerId === me      → SHARING: capture → mixer → MeshTransport → each member
 *   sharerId === other   → LISTENING: ReceiverLink ← sharer, played by AudioOutput
 *   sharerId === null    → idle in the room; anyone may start sharing
 *
 * Who may share is decided by the room's host (see protocol): the host shares
 * freely; others request, and the host's approval hands the role over.
 *
 * The UI calls actions; everything else reacts to room snapshots from the server.
 */
export class RoomController extends Store<RoomState> {
  // connection
  private signaling: SignalingClient | null = null;
  private creds: { memberId: string; memberToken: string } | null = null;
  private iceServers: IceServer[] = [];
  private room: RoomSnapshot | null = null;
  private online = true;
  private rejoins = 0;
  private timers = new Set<number>();

  // listening
  private output: AudioOutput | null;
  private link: ReceiverLink | null = null;
  private linkSharerId: string | null = null;
  private listening: Listening | null = null;
  private sampler = new InboundStatsSampler();
  private statsTimer: number | undefined;
  private recoverTimer: number | undefined;
  private volume = 0.8;

  // sharing
  private mixer: AudioMixer | null = null;
  private source: AudioSource | null = null;
  private transport: BroadcastTransport | null = null;
  private sharing: {
    kind: SourceKind;
    sourceLabel: string;
    startedAt: number;
    muted: boolean;
    paused: boolean;
  } | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  /** Live source track sent directly (no mixer in the send path → lower latency). */
  private directTrack: MediaStreamTrack | null = null;
  private starting = false;
  private claimPending = false;
  private shareError: ShareError | null = null;
  private peerLinks = new Map<string, { link: PeerLinkState; quality: Quality }>();
  private unsubs: Array<() => void> = [];

  /**
   * @param code   room to join, or null to create one
   * @param output an AudioOutput created inside the user's tap (unlocks playback), if available
   */
  constructor(
    private code: string | null,
    output: AudioOutput | null = null,
  ) {
    super({ kind: 'ready', code });
    this.output = output;
    this.watchOutput();
  }

  private unwatchOutput: (() => void) | null = null;

  private watchOutput() {
    this.unwatchOutput?.();
    this.unwatchOutput = this.output?.onStateChange(() => this.publish()) ?? null;
  }

  /** Level of whatever this device is sharing or hearing. */
  get level(): LevelSource | null {
    return this.mixer?.level ?? this.output?.level ?? null;
  }

  /** The music player, while sharing files. */
  get player(): FileSource | null {
    return this.source?.kind === 'file' ? (this.source as FileSource) : null;
  }

  /* ═════════════ actions ═════════════ */

  /** Join (or create) the room. Call from a tap so audio playback is unlocked. */
  enter = (): void => {
    if (this.state.kind === 'joining' || this.state.kind === 'in-room') return;
    if (!this.output) {
      this.output = new AudioOutput();
      this.watchOutput();
    }
    this.output.setVolume(this.volume);
    this.rejoins = 0;
    this.set({ kind: 'joining', code: this.code });
    this.connect();
  };

  leave = (): void => {
    this.signaling?.send({ type: 'room:leave' });
    const code = this.code;
    this.teardown();
    this.set({ kind: 'closed', code, reason: 'left' });
  };

  /** Start sharing a live source (system sound, a tab, the mic). Call from a tap. */
  share = (mode: Exclude<ShareMode, 'file'>): void => {
    if (!this.beginStart()) return;
    void this.startWith(captureSound(mode));
  };

  /**
   * Music files: the tap that opens the file picker calls this first (the
   * AudioContext must start inside the tap); then `shareFiles` or `cancelShare`.
   */
  prepareFiles = (): void => {
    this.beginStart();
  };

  shareFiles = (files: File[]): void => {
    if (!this.starting || !files.length) return this.cancelShare();
    const src = fileSource(files);
    void this.startWith(Promise.resolve(src)).then(() => src.play());
  };

  cancelShare = (): void => {
    if (!this.starting || this.source) return;
    this.releaseShare();
    this.publish();
  };

  requestShare = (): void => {
    this.shareError = null;
    this.signaling?.send({ type: 'share:request' });
  };

  cancelRequest = (): void => {
    this.signaling?.send({ type: 'share:cancel-request' });
  };

  /** Host: let a member share now (stops whoever is sharing). */
  approve = (memberId: string): void => {
    this.signaling?.send({ type: 'share:approve', memberId });
  };

  deny = (memberId: string): void => {
    this.signaling?.send({ type: 'share:deny', memberId });
  };

  /** Host: stop whoever is sharing. */
  revoke = (): void => {
    this.signaling?.send({ type: 'share:revoke' });
  };

  /** Approved member: give the turn back without sharing. */
  declineTurn = (): void => {
    this.signaling?.send({ type: 'share:stop' });
  };

  /** Manually resume audio the device suspended (needs a tap on iOS). */
  /** Listener: resume this device's playback from a tap. */
  unlockPlayback = (): void => {
    this.output?.unlock();
    window.setTimeout(() => this.publish(), 100);
  };

  resumeAudio = (): void => {
    void this.mixer?.resume().then(() => this.publish());
    const p = this.player;
    if (p && !p.getState().playing) p.play();
  };

  /** Play the shared sound on this device too? Listeners are unaffected. */
  setLocalPlayback = async (on: boolean): Promise<void> => {
    const lp = this.source?.localPlayback;
    if (!lp) return;
    await lp.set(on);
    this.publish();
  };

  stopSharing = (): void => {
    if (!this.sharing && !this.starting) return;
    this.signaling?.send({ type: 'share:stop' });
    this.releaseShare();
    this.publish();
  };

  setMuted = (muted: boolean): void => {
    if (!this.sharing) return;
    this.sharing = { ...this.sharing, muted };
    this.applyShareState();
  };

  setPaused = (paused: boolean): void => {
    if (!this.sharing) return;
    this.sharing = { ...this.sharing, paused };
    // Pause stops RTP entirely (listeners show "paused"); mute sends silence.
    this.transport?.setActive(!paused);
    this.applyShareState();
  };

  setVolume(v: number): void {
    this.volume = v;
    this.output?.setVolume(v);
  }

  dismissShareError = (): void => {
    this.shareError = null;
    this.publish();
  };

  override dispose(): void {
    if (this.state.kind === 'in-room' || this.state.kind === 'joining') this.signaling?.send({ type: 'room:leave' });
    this.teardown();
  }

  /* ═════════════ signaling ═════════════ */

  private connect() {
    const sig = new SignalingClient();
    this.signaling = sig;
    sig.on('status', ({ status }) => {
      if (status === 'open') {
        this.online = true;
        if (this.creds && this.code) sig.send({ type: 'room:resume', code: this.code, ...this.creds });
        else if (this.code) sig.send({ type: 'room:join', code: this.code, device: deviceLabel() });
        else sig.send({ type: 'room:create', device: deviceLabel() });
      } else if (status === 'closed' && this.state.kind === 'in-room') {
        this.online = false;
        this.publish();
      }
    });
    sig.on('message', this.onMessage);
    sig.connect();
    window.addEventListener('pagehide', this.onPageHide);
    this.after(JOIN_TIMEOUT_MS, () => {
      if (this.state.kind === 'joining') {
        const code = this.code;
        this.teardown();
        this.set({ kind: 'closed', code, reason: 'unreachable' });
      }
    });
  }

  private onMessage = (m: ServerMessage) => {
    switch (m.type) {
      case 'room:joined':
        this.creds = { memberId: m.memberId, memberToken: m.memberToken };
        this.iceServers = m.iceServers;
        this.transport?.setIceServers(m.iceServers);
        if (this.code !== m.room.code) {
          this.code = m.room.code;
          // A created room gets its real URL so reload/share works.
          history.replaceState(null, '', `/r/${m.room.code}`);
        }
        this.online = true;
        this.applySnapshot(m.room);
        // We may have changed networks (often why the socket dropped).
        this.transport?.restartAll();
        break;
      case 'room:update':
        this.applySnapshot(m.room);
        break;
      case 'signal':
        if (this.transport && this.room?.sharerId === this.creds?.memberId) this.transport.handleSignal(m.from, m.payload);
        else if (m.from === this.linkSharerId) this.link?.handle(m.payload);
        break;
      case 'error':
        this.onError(m.code, m.message);
        break;
    }
  };

  private onError(code: string, message: string) {
    switch (code) {
      case 'busy':
      case 'not-allowed':
        // Lost the right to share between our tap and our claim.
        this.claimPending = false;
        this.releaseShare();
        this.shareError = { code: code === 'busy' ? 'busy' : 'not-allowed', detail: message };
        this.publish();
        break;
      case 'denied':
        this.shareError = { code: 'denied' };
        this.publish();
        break;
      case 'unauthorized':
        // Our place expired while we were away: join again as a new member.
        this.creds = null;
        if (this.code) this.signaling?.send({ type: 'room:join', code: this.code, device: deviceLabel() });
        break;
      case 'not-found':
      case 'full': {
        const c = this.code;
        this.teardown();
        this.set({ kind: 'closed', code: c, reason: code });
        break;
      }
      default:
        console.warn('[aura] server error', code, message);
    }
  }

  /* ═════════════ role reconciliation ═════════════ */

  private applySnapshot(room: RoomSnapshot) {
    this.room = room;
    const me = this.creds?.memberId;
    const sharerId = room.sharerId;

    // ── sharing ──
    if (sharerId === me && this.claimPending) {
      this.claimPending = false;
      this.beginTransport();
    }
    if (this.sharing && sharerId !== me && !this.claimPending) {
      // Lost the role. If we're the host, we handed it over ourselves (approved
      // someone); otherwise the host stopped us — say so.
      this.releaseShare();
      if (room.hostId !== me) this.shareError = { code: 'taken-over' };
    }
    if (this.transport) {
      const ids = new Set(room.members.map((x) => x.id));
      for (const id of this.transport.peerIds()) {
        if (!ids.has(id)) {
          this.transport.removePeer(id);
          this.peerLinks.delete(id);
        }
      }
      for (const x of room.members) {
        if (x.id !== me && x.online && !this.transport.hasPeer(x.id)) {
          this.transport.addPeer(x.id);
          this.peerLinks.set(x.id, { link: 'connecting', quality: 'unknown' });
        }
      }
    }

    // ── listening ──
    if (sharerId && sharerId !== me) {
      if (this.linkSharerId !== sharerId) this.openLink(sharerId);
      const sharer = room.members.find((x) => x.id === sharerId);
      if (this.listening) {
        this.listening = {
          ...this.listening,
          sharerDevice: sharer?.device ?? this.listening.sharerDevice,
          muted: room.shareState?.muted ?? false,
          paused: room.shareState?.paused ?? false,
        };
      }
    } else if (this.link) {
      this.closeLink();
    }

    if (this.state.kind === 'joining') this.clearTimers();
    this.publish();
  }

  /* ═════════════ sharing ═════════════ */

  /** Common start: validates, creates the mixer inside the tap. */
  private beginStart(): boolean {
    const s = this.inRoom();
    if (!s || this.starting || this.sharing || !this.mayStart()) return false;
    this.starting = true;
    this.shareError = null;
    this.mixer = new AudioMixer();
    this.publish();
    return true;
  }

  private mayStart(): boolean {
    const me = this.creds?.memberId;
    return !!me && (this.room?.hostId === me || this.room?.grantId === me);
  }

  private async startWith(pending: Promise<AudioSource>) {
    let source: AudioSource;
    try {
      source = await pending;
    } catch (err) {
      console.warn('[aura] capture failed', err);
      this.releaseShare();
      const code = err instanceof CaptureError ? err.code : 'unknown';
      const detail = (err as Error)?.message;
      this.shareError = detail && code !== 'permission-denied' ? { code, detail } : { code };
      this.publish();
      return;
    }
    if (!this.starting || !this.mixer || this.state.kind !== 'in-room') {
      source.stop(); // left or cancelled meanwhile
      return;
    }
    this.source = source;
    // One live source: send its track as-is. The mixer then only feeds the meter.
    // Music files must go through the mixer (that's where they are played).
    this.directTrack = source.kind !== 'file' && source.track ? source.track : null;
    this.mixer.add(source);
    // The picker/permission prompt may have backgrounded the page and
    // suspended audio (phones). Bring it back before going live.
    await this.mixer.resume();
    if (!this.starting || !this.mixer) {
      source.stop();
      return;
    }
    this.unsubs.push(this.mixer.onStateChange(() => this.publish()));
    source.onEnded(() => this.stopSharing()); // e.g. "Stop sharing" in the browser bar
    this.sharing = { kind: source.kind, sourceLabel: source.label, startedAt: Date.now(), muted: false, paused: false };
    this.claimPending = true;
    this.signaling?.send({ type: 'share:start', state: { muted: false, paused: false } });
    if (source.kind === 'file' || source.kind === 'mic') void this.keepAwake();
  }

  /** Phones stop audio when the screen locks; keep it on while sharing. */
  private async keepAwake() {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      this.wakeLock = (await wl?.request('screen')) ?? null;
    } catch {
      /* not supported / denied: fine */
    }
  }

  private beginTransport() {
    if (!this.mixer || this.transport) return;
    this.starting = false;
    this.transport = new MeshTransport(this.directTrack ?? this.mixer.track, this.iceServers);
    const t = this.transport;
    this.unsubs.push(
      t.on('signal', ({ peerId, payload }) => this.signaling?.send({ type: 'signal', to: peerId, payload })),
      t.on('state', ({ peerId, state }) => {
        const prev = this.peerLinks.get(peerId);
        if (!prev || state === 'failed') return;
        this.peerLinks.set(peerId, { ...prev, link: state });
        this.publish();
      }),
      t.on('quality', ({ peerId, quality }) => {
        const prev = this.peerLinks.get(peerId);
        if (!prev || prev.quality === quality) return;
        this.peerLinks.set(peerId, { ...prev, quality });
        this.publish();
      }),
    );
    if (this.sharing?.paused) t.setActive(false);
  }

  private applyShareState() {
    if (!this.sharing) return;
    const state: ShareState = { muted: this.sharing.muted, paused: this.sharing.paused };
    const silent = state.muted || state.paused;
    // A disabled track sends silence; the mixer gain covers the mixed path.
    if (this.directTrack) this.directTrack.enabled = !silent;
    this.mixer?.setMuted(silent);
    this.signaling?.send({ type: 'share:state', state });
    this.publish();
  }

  private releaseShare() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.transport?.close();
    this.transport = null;
    this.directTrack = null;
    this.source?.stop();
    this.source = null;
    this.mixer?.close();
    this.mixer = null;
    this.sharing = null;
    this.starting = false;
    this.claimPending = false;
    this.peerLinks.clear();
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  /* ═════════════ listening ═════════════ */

  private openLink(sharerId: string) {
    this.closeLink();
    const sharer = this.room?.members.find((x) => x.id === sharerId);
    this.linkSharerId = sharerId;
    this.listening = {
      sharerDevice: sharer?.device ?? 'Someone',
      phase: 'connecting',
      muted: this.room?.shareState?.muted ?? false,
      paused: this.room?.shareState?.paused ?? false,
      quality: 'unknown',
      stats: { rttMs: null, jitterMs: null, lossPct: null },
      relayed: false,
      audioSuspended: false,
    };
    this.sampler = new InboundStatsSampler();
    const link = new ReceiverLink(this.iceServers);
    this.link = link;
    link.on('signal', (payload) => this.signaling?.send({ type: 'signal', to: sharerId, payload }));
    link.on('stream', (stream) => this.output?.attach(stream));
    link.on('state', (s) => this.onLinkState(s));
    this.armRecovery();
  }

  private onLinkState(s: LinkState) {
    if (!this.listening) return;
    if (s === 'connected') {
      window.clearTimeout(this.recoverTimer);
      this.rejoins = 0;
      this.listening = { ...this.listening, phase: 'live' };
      this.startStats();
    } else if (s === 'disconnected' || s === 'failed') {
      this.listening = { ...this.listening, phase: this.listening.phase === 'connecting' ? 'connecting' : 'reconnecting' };
      this.armRecovery();
    }
    this.publish();
  }

  /**
   * The sharer drives ICE restarts. If the link still isn't up after a while,
   * rejoin as a fresh member so the sharer builds a brand-new connection.
   */
  private armRecovery() {
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = window.setTimeout(() => {
      if (!this.listening || this.listening.phase === 'live' || !this.code) return;
      if (this.rejoins >= MAX_REJOINS) return; // stays "reconnecting"; UI offers Leave
      this.rejoins++;
      this.closeLink();
      this.creds = null;
      this.signaling?.send({ type: 'room:leave' });
      this.signaling?.send({ type: 'room:join', code: this.code, device: deviceLabel() });
    }, LISTEN_RECOVER_MS);
  }

  private startStats() {
    if (this.statsTimer) return;
    this.statsTimer = window.setInterval(async () => {
      const pc = this.link?.pc;
      if (!pc || !this.listening || this.listening.phase !== 'live') return;
      try {
        const st = await this.sampler.sample(pc);
        if (!this.listening) return;
        const stats = { rttMs: st.rttMs, jitterMs: st.jitterMs, lossPct: st.lossPct };
        // While paused no packets arrive, so loss/jitter are meaningless.
        this.listening = this.listening.paused
          ? { ...this.listening, relayed: st.relayed }
          : { ...this.listening, stats, relayed: st.relayed, quality: rateLink(stats) };
        this.publish();
      } catch {
        /* closed */
      }
    }, STATS_MS);
  }

  private closeLink() {
    window.clearTimeout(this.recoverTimer);
    window.clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.link?.close();
    this.link = null;
    this.linkSharerId = null;
    this.listening = null;
  }

  /* ═════════════ state ═════════════ */

  private publish() {
    const room = this.room;
    const me = this.creds?.memberId;
    if (!room || !me || !this.code) return;
    if (this.state.kind !== 'in-room' && this.state.kind !== 'joining') return;

    const members: MemberView[] = room.members.map((x) => {
      const pl = this.sharing ? this.peerLinks.get(x.id) : undefined;
      return {
        id: x.id,
        device: x.device,
        online: x.online,
        isMe: x.id === me,
        isSharer: x.id === room.sharerId,
        isHost: x.id === room.hostId,
        requested: room.requests.includes(x.id),
        granted: x.id === room.grantId,
        link: pl?.link ?? null,
        quality: pl?.quality ?? null,
      };
    });
    // Me first, then the sharer, then join order.
    members.sort((a, b) => Number(b.isMe) - Number(a.isMe) || Number(b.isSharer) - Number(a.isSharer));
    const deviceOf = (id: string | null) => room.members.find((x) => x.id === id)?.device ?? null;

    const next: InRoom = {
      kind: 'in-room',
      code: this.code,
      shareUrl: listenUrl(this.code),
      meId: me,
      isHost: room.hostId === me,
      hostDevice: deviceOf(room.hostId),
      members,
      requests: room.requests.map((id) => ({ id, device: deviceOf(id) ?? 'Someone' })),
      myRequest: room.grantId === me ? 'granted' : room.requests.includes(me) ? 'pending' : 'none',
      canStart: this.mayStart(),
      signaling: this.online ? 'connected' : 'reconnecting',
      starting: this.starting,
      sharing:
        this.sharing && !this.claimPending
          ? {
              ...this.sharing,
              sourceLabel: this.source?.label ?? this.sharing.sourceLabel,
              localPlayback: this.source?.localPlayback?.on ?? null,
              // With a direct track the mixer only drives the meter, so a suspended
              // mixer doesn't silence listeners.
              audioSuspended: this.mixer && !this.directTrack ? !this.mixer.running : false,
            }
          : null,
      listening: this.listening ? { ...this.listening, audioSuspended: this.output ? !this.output.running : false } : null,
      sharerDevice: deviceOf(room.sharerId),
      shareError: this.shareError,
    };
    this.set(next);
  }

  private inRoom(): InRoom | null {
    return this.state.kind === 'in-room' ? this.state : null;
  }

  /* ═════════════ utils / cleanup ═════════════ */

  private onPageHide = () => {
    // Tell the room right away instead of after the grace period.
    this.signaling?.send({ type: 'room:leave' });
  };

  private after(ms: number, fn: () => void) {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers.clear();
  }

  private teardown() {
    window.removeEventListener('pagehide', this.onPageHide);
    this.clearTimers();
    this.releaseShare();
    this.closeLink();
    this.signaling?.close();
    this.signaling = null;
    this.creds = null;
    this.room = null;
    this.shareError = null;
    this.unwatchOutput?.();
    this.unwatchOutput = null;
    this.output?.close();
    this.output = null;
  }
}
