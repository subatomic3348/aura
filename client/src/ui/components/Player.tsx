import { useEffect, useRef } from 'react';
import type { FileSource } from '../../audio/sources';
import { formatDuration } from '../../lib/format';
import { useStore } from '../../session/store';
import { Pause, Play } from '../icons';
import styles from './Player.module.css';

/** Minimal player for shared music files. Progress is painted outside React. */
export function Player({ player }: { player: FileSource }) {
  const { tracks, index, playing, blocked } = useStore(player);
  const barRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const el = player.element;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = el.duration;
      const frac = Number.isFinite(d) && d > 0 ? el.currentTime / d : 0;
      barRef.current?.style.setProperty('--progress', String(frac));
      if (timeRef.current) {
        timeRef.current.textContent = `${formatDuration(el.currentTime * 1000)} / ${Number.isFinite(d) ? formatDuration(d * 1000) : '--:--'}`;
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [player]);

  return (
    <div className={styles.player}>
      <div className={styles.head}>
        <span className={styles.title} title={tracks[index]}>
          {tracks[index]}
        </span>
        <span className={`mono ${styles.count}`}>
          {index + 1}/{tracks.length}
        </span>
      </div>
      <div
        ref={barRef}
        className={styles.bar}
        role="slider"
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          player.seek((e.clientX - r.left) / r.width);
        }}
      />
      <div className={styles.controls}>
        <span ref={timeRef} className={`mono ${styles.time}`} />
        <span className={styles.buttons}>
          <button type="button" className={styles.btn} onClick={player.prev} aria-label="Previous">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 3v10M13 3.5v9L6 8z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className={`${styles.btn} ${styles.main}`} onClick={player.toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={player.next}
            disabled={index >= tracks.length - 1}
            aria-label="Next"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M12 3v10M3 3.5v9L10 8z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
        </span>
      </div>
      {blocked && <p className={styles.blocked}>Tap play to start the music.</p>}
    </div>
  );
}
