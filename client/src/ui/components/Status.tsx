import type { Quality } from '../../session/types';
import styles from './Status.module.css';

export type DotTone = 'live' | 'ok' | 'warn' | 'danger' | 'idle';

/** A status dot. `pulse` adds a slow outward ring for active states. */
export function StatusDot({ tone, pulse = false }: { tone: DotTone; pulse?: boolean }) {
  return <span className={styles.dot} data-tone={tone} data-pulse={pulse} aria-hidden="true" />;
}

const QUALITY_LEVEL: Record<Quality, number> = {
  unknown: 0,
  poor: 1,
  fair: 2,
  good: 3,
  excellent: 4,
};

const QUALITY_LABEL: Record<Quality, string> = {
  unknown: 'Measuring',
  poor: 'Poor',
  fair: 'Fair',
  good: 'Good',
  excellent: 'Excellent',
};

export function qualityLabel(q: Quality) {
  return QUALITY_LABEL[q];
}

/** Four ascending bars, like a signal meter. */
export function QualityBars({ quality, showLabel = false }: { quality: Quality; showLabel?: boolean }) {
  const level = QUALITY_LEVEL[quality];
  return (
    <span className={styles.quality} data-quality={quality}>
      <span className={styles.bars} role="img" aria-label={`Connection quality: ${QUALITY_LABEL[quality]}`}>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={styles.bar} data-on={i <= level} style={{ height: `${25 * i}%` }} />
        ))}
      </span>
      {showLabel && <span className={styles.qualityText}>{QUALITY_LABEL[quality]}</span>}
    </span>
  );
}
