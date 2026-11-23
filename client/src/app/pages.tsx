/**
 * Route-level containers: own a controller for the page's lifetime and feed
 * its state to a screen.
 */
import { useEffect, useState } from 'react';
import { getCapabilities } from '../lib/capabilities';
import { isValidCode, normalizeCode } from '../lib/code';
import { navigate } from '../lib/router';
import { RoomController } from '../session/room';
import { useStore } from '../session/store';
import { Button } from '../ui/components/Button';
import { Shell } from '../ui/components/Shell';
import { RoomScreen } from '../ui/screens/RoomScreen';
import { takeEntry } from './autostart';

const VOLUME_KEY = 'aura.volume';

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8;
  } catch {
    return 0.8;
  }
}

/** `/new` (rawCode null) creates a room; `/r/CODE` joins one. */
export function RoomPage({ rawCode }: { rawCode: string | null }) {
  const caps = getCapabilities();
  const code = rawCode === null ? null : normalizeCode(rawCode);
  const valid = code === null || isValidCode(code);

  // If we arrived via a tap on the landing page, audio is already unlocked
  // and we can enter straight away; a fresh page load needs one tap.
  const [entry] = useState(() => (valid ? takeEntry() : null));
  const [ctrl] = useState(() => new RoomController(code, entry));
  const state = useStore(ctrl);
  const [volume, setVolume] = useState(readVolume);

  useEffect(() => {
    document.title = 'Room · Aura';
    ctrl.retain();
    if (entry) ctrl.enter();
    return () => ctrl.release();
  }, [ctrl, entry]);

  useEffect(() => ctrl.setVolume(volume), [ctrl, volume]);

  const onVolume = (v: number) => {
    setVolume(v);
    try {
      if (v > 0) localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      /* storage unavailable: volume just won't persist */
    }
  };

  const shown = valid ? state : ({ kind: 'closed', code, reason: 'not-found' } as const);
  return <RoomScreen state={shown} actions={ctrl} level={ctrl.level} micLevel={ctrl.micLevel} player={ctrl.player} caps={caps} volume={volume} onVolume={onVolume} />;
}

export function NotFoundPage() {
  return (
    <Shell>
      <div style={{ flex: 1, display: 'grid', placeContent: 'center', gap: 'var(--s-4)', textAlign: 'center' }}>
        <span className="label">404</span>
        <h1 style={{ fontSize: 'var(--t-title)' }}>Nothing here</h1>
        <div>
          <Button variant="secondary" onClick={() => navigate('/')}>
            Back to Aura
          </Button>
        </div>
      </div>
    </Shell>
  );
}
