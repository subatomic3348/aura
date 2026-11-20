import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LevelSource } from '../../audio/level';
import type { FileSource, ShareMode } from '../../audio/sources';
import type { Capabilities } from '../../lib/capabilities';
import { formatCode } from '../../lib/code';
import { navigate } from '../../lib/router';
import { MAX_MEMBERS, type InRoom, type MemberView, type RoomState, type ShareError } from '../../session/types';
import { Button } from '../components/Button';
import { CopyField } from '../components/CopyField';
import { Elapsed } from '../components/Elapsed';
import { Fader } from '../components/Fader';
import { LevelEnvelope } from '../components/LevelEnvelope';
import { Notice } from '../components/Notice';
import { Player } from '../components/Player';
import { QrCode } from '../components/QrCode';
import { Rings } from '../components/Rings';
import { Shell } from '../components/Shell';
import { QualityBars, StatusDot, qualityLabel } from '../components/Status';
import { Switch } from '../components/Switch';
import { ArrowLeft, Broadcast, Check, Headphones, Pause, Play, Speaker, SpeakerOff, Stop } from '../icons';
import styles from './RoomScreen.module.css';

export interface RoomActions {
  enter(): void;
  leave(): void;
  share(mode: Exclude<ShareMode, 'file'>): void;
  prepareFiles(): void;
  shareFiles(files: File[]): void;
  cancelShare(): void;
  stopSharing(): void;
  setMuted(m: boolean): void;
  setPaused(p: boolean): void;
  setLocalPlayback(on: boolean): void;
  resumeAudio(): void;
  unlockPlayback(): void;
  requestShare(): void;
  cancelRequest(): void;
  approve(id: string): void;
  deny(id: string): void;
  revoke(): void;
  declineTurn(): void;
  dismissShareError(): void;
}

interface Props {
  state: RoomState;
  actions: RoomActions;
  level: LevelSource | null;
  player: FileSource | null;
  caps: Capabilities;
  volume: number;
  onVolume(v: number): void;
}

type RoomProps = Omit<Props, 'state'> & { room: InRoom };

export function RoomScreen(props: Props) {
  const { state, actions } = props;

  switch (state.kind) {
    case 'ready':
    case 'joining': {
      const joining = state.kind === 'joining';
      return (
        <Shell>
          <div className={`${styles.column} ${styles.center} enter`}>
            <Rings mode={joining ? 'connecting' : 'idle'} size={120} />
            {state.code ? (
              <div className={styles.text}>
                <span className="label">Room</span>
                <span className={`mono ${styles.bigCode}`}>{formatCode(state.code)}</span>
              </div>
            ) : (
              <h1 className={styles.title}>{joining ? 'Creating your room…' : 'Start a room'}</h1>
            )}
            {!joining && (
              <>
                <Button variant="primary" size="l" icon={<Headphones />} className={styles.wide} onClick={actions.enter}>
                  {state.code ? 'Join room' : 'Start a room'}
                </Button>
                <p className={styles.hint}>Sound will play on this device. Check your volume is up.</p>
              </>
            )}
            {joining && state.code && <p className={styles.hint}>Joining…</p>}
          </div>
        </Shell>
      );
    }

    case 'closed': {
      const copy = {
        'not-found': ['This room doesn’t exist', 'It may have closed, or the code is mistyped.'],
        full: ['This room is full', `It already has ${MAX_MEMBERS} devices. Try again when someone leaves.`],
        left: ['You left the room', 'Sound has stopped on this device.'],
        unreachable: ['Can’t reach the Aura server', 'Check that the server is running and you’re on the same network.'],
      }[state.reason];
      const retry = state.reason !== 'not-found' && state.code !== null;
      return (
        <Shell>
          <div className={`${styles.column} ${styles.center} enter`}>
            <Rings mode="off" size={96} />
            <div className={styles.text}>
              <h1 className={styles.title}>{copy[0]}</h1>
              <p className={styles.lead}>{copy[1]}</p>
            </div>
            <div className={styles.row}>
              {(retry || state.reason === 'unreachable') && (
                <Button variant="primary" onClick={actions.enter}>
                  {state.reason === 'left' ? 'Rejoin' : 'Try again'}
                </Button>
              )}
              <Button variant={retry ? 'ghost' : 'secondary'} icon={<ArrowLeft />} onClick={() => navigate('/')}>
                Home
              </Button>
            </div>
          </div>
        </Shell>
      );
    }

    case 'in-room':
      return <Room {...props} room={state} />;
  }
}

/* ───────────── In the room ───────────── */

function Room(props: RoomProps) {
  const { room, actions } = props;
  const alone = room.members.length === 1;
  const invite = <Invite room={room} />;

  return (
    <Shell
      confirmLeave={room.sharing ? 'Leaving stops your sound for everyone. Leave?' : undefined}
      meta={
        <span className={styles.meta}>
          {room.signaling !== 'connected' && (
            <span className={styles.metaItem}>
              <StatusDot tone="warn" pulse />
              <span className="label">Reconnecting</span>
            </span>
          )}
          <span className="label">Room</span>
          <span className={`mono ${styles.metaCode}`}>{formatCode(room.code)}</span>
        </span>
      }
    >
      <FilePickerHost actions={actions}>
      <div className={`${styles.column} enter`}>
        {room.isHost && room.requests.length > 0 && <Requests room={room} actions={actions} />}
        {alone && invite}
        <ShareNotice error={room.shareError} onDismiss={actions.dismissShareError} />
        <Stage {...props} />
        <People room={room} actions={actions} />
        {!alone && invite}
        <div className={styles.leaveRow}>
          <Button variant="ghost" icon={<ArrowLeft />} onClick={actions.leave}>
            Leave room
          </Button>
        </div>
      </div>
      </FilePickerHost>
    </Shell>
  );
}

function Stage(props: RoomProps) {
  const { room } = props;
  if (room.sharing) return <SharingPanel {...props} />;
  if (room.listening) return <ListeningPanel {...props} />;
  return <IdlePanel {...props} />;
}

/* ───────────── host: share requests ───────────── */

function Requests({ room, actions }: { room: InRoom; actions: RoomActions }) {
  return (
    <section className={styles.requests} aria-label="Share requests" aria-live="polite">
      {room.requests.map((r) => (
        <div key={r.id} className={styles.request}>
          <span className={styles.requestText}>
            <strong>{r.device}</strong> wants to share
            {room.sharerDevice ? (
              <span className={styles.requestSub}> — approving stops {room.sharing ? 'your' : `${room.sharerDevice}’s`} sound</span>
            ) : null}
          </span>
          <span className={styles.requestActions}>
            <Button variant="ghost" onClick={() => actions.deny(r.id)}>
              Decline
            </Button>
            <Button variant="primary" icon={<Check />} onClick={() => actions.approve(r.id)}>
              Approve
            </Button>
          </span>
        </div>
      ))}
    </section>
  );
}

const SHARE_ERROR: Record<ShareError['code'], { tone: 'warn' | 'danger'; text: string }> = {
  busy: { tone: 'warn', text: 'Someone else started sharing first.' },
  'not-allowed': { tone: 'warn', text: 'Ask the host before sharing.' },
  denied: { tone: 'warn', text: 'The host declined your request to share.' },
  'taken-over': { tone: 'warn', text: 'The host stopped your sharing.' },
  'permission-denied': { tone: 'warn', text: 'Sharing was cancelled or blocked.' },
  'no-audio-track': { tone: 'danger', text: 'No sound was included. Keep “Share tab audio” on.' },
  unsupported: { tone: 'danger', text: 'This browser can’t share that.' },
  'insecure-context': { tone: 'danger', text: 'Sharing needs a secure (https) page.' },
  unknown: { tone: 'danger', text: 'Sharing couldn’t start.' },
};

function ShareNotice({ error, onDismiss }: { error: ShareError | null; onDismiss(): void }) {
  if (!error) return null;
  const c = SHARE_ERROR[error.code];
  return (
    <Notice
      tone={c.tone}
      title={c.text}
      actions={
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      {error.detail}
    </Notice>
  );
}

/* ───────────── choosing what to share ───────────── */

const ALT_LABEL: Record<ShareMode, string> = {
  system: 'All sound',
  tab: 'A tab',
  file: 'Music file',
  mic: 'Microphone',
};

const PRIMARY_LABEL: Record<ShareMode, string> = {
  system: 'Share all my sound',
  tab: 'Share a tab',
  file: 'Share music from this device',
  mic: 'Share my microphone',
};

/**
 * The hidden file input lives at room level (not inside the picker): tapping
 * "Music" swaps the panel to "Starting…", which would otherwise unmount the
 * input before the user's file selection arrives.
 */
const FilePickerContext = createContext<() => void>(() => {});

function FilePickerHost({ actions, children }: { actions: RoomActions; children: ReactNode }) {
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = fileRef.current;
    if (!input) return;
    const onCancel = () => actions.cancelShare();
    input.addEventListener('cancel', onCancel);
    return () => input.removeEventListener('cancel', onCancel);
  }, [actions]);
  const open = useCallback(() => fileRef.current?.click(), []);
  return (
    <FilePickerContext.Provider value={open}>
      {children}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = '';
          if (files.length) actions.shareFiles(files);
          else actions.cancelShare();
        }}
      />
    </FilePickerContext.Provider>
  );
}

/** Source buttons. The first available mode is the big primary action. */
function SourcePicker({ caps, actions }: { caps: Capabilities; actions: RoomActions }) {
  const openFiles = useContext(FilePickerContext);
  const [primary, ...rest] = caps.shareModes;

  const pick = (mode: ShareMode) => {
    if (mode === 'file') {
      actions.prepareFiles(); // starts audio inside this tap
      openFiles();
    } else {
      actions.share(mode);
    }
  };

  if (!primary) return null;

  return (
    <div className={styles.picker}>
      <Button variant="primary" size="l" icon={<Broadcast />} className={styles.wide} onClick={() => pick(primary)}>
        {PRIMARY_LABEL[primary]}
      </Button>
      {rest.length > 0 && (
        <div className={styles.altModes}>
          <span className="label">or</span>
          {rest.map((m) => (
            <button key={m} type="button" className={styles.altBtn} onClick={() => pick(m)}>
              {ALT_LABEL[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IdlePanel({ room, actions, caps }: RoomProps) {
  const granted = room.myRequest === 'granted';

  if (room.starting) {
    return (
      <section className={`${styles.stage} ${styles.center}`} aria-label="Starting">
        <Rings mode="connecting" size={72} />
        <div className={styles.text}>
          <h1 className={styles.title}>Starting…</h1>
          <p className={styles.lead}>
            {caps.platform === 'linux' && !caps.mobile
              ? 'If the browser asks, allow microphone access — that’s how Aura hears “System sound”.'
              : 'Choose what to share when your device asks.'}
          </p>
        </div>
        <Button variant="ghost" onClick={actions.cancelShare}>
          Cancel
        </Button>
      </section>
    );
  }

  return (
    <section className={`${styles.stage} ${styles.center}`} aria-label="Sound">
      <Rings mode="idle" size={72} />
      <div className={styles.text}>
        <h1 className={styles.title}>{granted ? 'Your turn to share' : 'Nobody is sharing'}</h1>
        <p className={styles.lead}>
          {granted
            ? `${room.hostDevice ?? 'The host'} approved you. Pick what to share.`
            : room.canStart
              ? 'Everyone in the room will hear what you share.'
              : `Ask ${room.hostDevice ?? 'the host'} (host) to let you share.`}
        </p>
      </div>
      {room.canStart ? (
        <>
          <SourcePicker caps={caps} actions={actions} />
          {granted && (
            <button type="button" className={styles.linkBtn} onClick={actions.declineTurn}>
              Not now
            </button>
          )}
        </>
      ) : (
        <AskToShare room={room} actions={actions} />
      )}
    </section>
  );
}

function AskToShare({ room, actions }: { room: InRoom; actions: RoomActions }) {
  if (room.myRequest === 'pending') {
    return (
      <div className={styles.pendingAsk}>
        <span className={styles.pendingText}>
          <StatusDot tone="warn" pulse /> Waiting for {room.hostDevice ?? 'the host'} to approve…
        </span>
        <button type="button" className={styles.linkBtn} onClick={actions.cancelRequest}>
          Cancel request
        </button>
      </div>
    );
  }
  return (
    <Button variant="primary" size="l" icon={<Broadcast />} className={styles.wide} onClick={actions.requestShare}>
      Ask to share
    </Button>
  );
}

/* ───────────── sharing ───────────── */

function SharingPanel({ room, actions, level, player, caps }: RoomProps) {
  const s = room.sharing!;
  const silent = s.muted || s.paused;
  const listeners = room.members.filter((m) => !m.isMe).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'm' && !s.paused) actions.setMuted(!s.muted);
      else if (k === 'p') actions.setPaused(!s.paused);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, s.muted, s.paused]);

  return (
    <section className={styles.stage} aria-label="You are sharing">
      <div className={styles.stageHead}>
        <StatusDot tone={silent ? 'idle' : 'live'} pulse={!silent} />
        <span className={styles.stageTitle}>{s.paused ? 'Paused' : s.muted ? 'Muted' : 'You’re sharing'}</span>
        <Elapsed since={s.startedAt} className={`mono ${styles.clock}`} />
      </div>
      <p className={styles.sub}>
        {s.kind === 'file' ? 'Music' : s.sourceLabel} ·{' '}
        {listeners === 0 ? 'no one listening yet' : `${listeners} ${listeners === 1 ? 'device' : 'devices'} listening`}
      </p>

      {s.audioSuspended && (
        <Notice
          tone="warn"
          title={`Your ${caps.mobile ? 'phone' : 'browser'} paused the sound`}
          actions={
            <Button variant="primary" icon={<Play />} onClick={actions.resumeAudio}>
              Resume sound
            </Button>
          }
        >
          Listeners hear silence until you resume. Keep Aura open on screen while sharing.
        </Notice>
      )}

      {player && <Player player={player} />}

      <div className={styles.meter}>
        <LevelEnvelope source={level} active={!silent} height={56} label="Sound you are sharing" />
        {silent && <p className={styles.overlay}>{s.paused ? 'Paused' : 'Muted — everyone hears silence'}</p>}
      </div>

      <div className={styles.controls}>
        <Button
          aria-pressed={s.muted}
          icon={s.muted ? <SpeakerOff /> : <Speaker />}
          shortcut="M"
          onClick={() => actions.setMuted(!s.muted)}
          disabled={s.paused}
        >
          {s.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button aria-pressed={s.paused} icon={s.paused ? <Play /> : <Pause />} shortcut="P" onClick={() => actions.setPaused(!s.paused)}>
          {s.paused ? 'Resume' : 'Pause'}
        </Button>
        <span className={styles.spacer} />
        <Button variant="danger" icon={<Stop />} onClick={actions.stopSharing}>
          Stop
        </Button>
      </div>

      {s.localPlayback !== null ? (
        <div className={styles.localRow}>
          <Switch
            label="Play on this device"
            hint="Turn off to silence this device. Listeners keep hearing everything."
            checked={s.localPlayback}
            onChange={actions.setLocalPlayback}
          />
        </div>
      ) : s.kind === 'system' ? (
        <p className={styles.tip}>
          Tip: mute this {caps.mobile ? 'device' : 'computer'} anytime with its volume keys — listeners keep hearing
          everything.
        </p>
      ) : null}
    </section>
  );
}

/* ───────────── listening ───────────── */

function ListeningPanel({ room, actions, level, volume, onVolume, caps }: RoomProps) {
  const l = room.listening!;
  const live = l.phase === 'live';
  const silent = l.paused || l.muted;
  const [choosing, setChoosing] = useState(false);

  return (
    <section className={styles.stage} aria-label="Listening">
      <div className={styles.stageHead}>
        <StatusDot tone={live ? (silent ? 'idle' : 'live') : 'warn'} pulse={!live || !silent} />
        <span className={styles.stageTitle}>
          {l.phase === 'connecting' ? 'Connecting…' : l.phase === 'reconnecting' ? 'Reconnecting…' : 'Listening'}
        </span>
        {live && (
          <span className={styles.quality}>
            <QualityBars quality={l.quality} />
            <span>{qualityLabel(l.quality)}</span>
          </span>
        )}
      </div>
      {l.audioSuspended && (
        <Notice
          tone="warn"
          title="Sound is paused on this device"
          actions={
            <Button variant="primary" icon={<Play />} onClick={actions.unlockPlayback}>
              Tap to resume sound
            </Button>
          }
        />
      )}
      <p className={styles.sub}>
        to <strong>{l.sharerDevice}</strong>
        {live && l.relayed ? ' · via relay' : ''}
      </p>
      <div className={styles.meter}>
        <LevelEnvelope source={live ? level : null} active={live && !silent} height={56} label="Sound you are hearing" />
        {live && silent && <p className={styles.overlay}>{l.paused ? 'Paused by the sharer' : 'Muted by the sharer'}</p>}
      </div>
      <div className={styles.volume}>
        <button
          type="button"
          className={styles.muteBtn}
          onClick={() => onVolume(volume > 0 ? 0 : 0.8)}
          aria-label={volume > 0 ? 'Mute this device' : 'Unmute this device'}
        >
          {volume > 0 ? <Speaker size={18} /> : <SpeakerOff size={18} />}
        </button>
        <Fader label="Volume" value={volume} onChange={onVolume} />
      </div>

      <div className={styles.listenFooter}>
        {room.isHost ? (
          choosing ? (
            <SourcePicker caps={caps} actions={actions} />
          ) : (
            <button type="button" className={styles.linkBtn} onClick={() => setChoosing(true)}>
              Share my sound instead
            </button>
          )
        ) : (
          <AskToShare room={room} actions={actions} />
        )}
      </div>
    </section>
  );
}

/* ───────────── people ───────────── */

function People({ room, actions }: { room: InRoom; actions: RoomActions }) {
  return (
    <section className={styles.panel} aria-labelledby="people-title">
      <div className={styles.panelHead}>
        <h2 id="people-title" className="label">
          In this room
        </h2>
        <span className={`mono ${styles.count}`}>
          {room.members.length}/{MAX_MEMBERS}
        </span>
      </div>
      <ul className={styles.list}>
        {room.members.map((m) => (
          <Person key={m.id} m={m} canStop={room.isHost && m.isSharer && !m.isMe} onStop={actions.revoke} />
        ))}
      </ul>
    </section>
  );
}

function Person({ m, canStop, onStop }: { m: MemberView; canStop: boolean; onStop(): void }) {
  const status = !m.online
    ? 'Reconnecting…'
    : m.link === 'connecting'
      ? 'Connecting…'
      : m.link === 'reconnecting'
        ? 'Reconnecting…'
        : null;
  return (
    <li className={styles.person} data-online={m.online}>
      <StatusDot tone={!m.online ? 'warn' : m.isSharer ? 'live' : 'ok'} pulse={m.isSharer} />
      <span className={styles.device}>
        {m.device}
        {m.isMe && <span className={styles.you}> (you)</span>}
      </span>
      {m.isHost && <span className={styles.tagHost}>Host</span>}
      {m.isSharer && <span className={styles.tag}>Sharing</span>}
      {m.requested && <span className={styles.tagMuted}>Asking</span>}
      {m.granted && !m.isSharer && <span className={styles.tagMuted}>Approved</span>}
      {status ? (
        <span className={styles.pending}>{status}</span>
      ) : (
        m.link === 'connected' && m.quality && <QualityBars quality={m.quality} />
      )}
      {canStop && (
        <button type="button" className={styles.stopBtn} onClick={onStop} aria-label={`Stop ${m.device} sharing`}>
          Stop
        </button>
      )}
    </li>
  );
}

function Invite({ room }: { room: InRoom }) {
  return (
    <section className={styles.invite} aria-label="Invite devices">
      <QrCode value={room.shareUrl} size={184} />
      <div className={styles.text}>
        <span className="label">Scan to join, or enter the code</span>
        <span className={`mono ${styles.bigCode}`}>{formatCode(room.code)}</span>
      </div>
      <CopyField value={room.shareUrl} display={room.shareUrl.replace(/^https?:\/\//, '')} label="link" />
    </section>
  );
}
