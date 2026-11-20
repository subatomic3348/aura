import type { CSSProperties } from 'react';
import styles from './Rings.module.css';

export type RingsMode = 'idle' | 'connecting' | 'live' | 'off';

/**
 * Aura's mark: a point with concentric rings. It is also the connection
 * indicator: rings travel outward while connecting and breathe slowly while live.
 */
export function Rings({ mode, size = 160 }: { mode: RingsMode; size?: number }) {
  return (
    <svg className={styles.rings} data-mode={mode} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle className={styles.ring} cx="50" cy="50" r="22" style={{ '--i': 0 } as CSSProperties} />
      <circle className={styles.ring} cx="50" cy="50" r="34" style={{ '--i': 1 } as CSSProperties} />
      <circle className={styles.ring} cx="50" cy="50" r="46" style={{ '--i': 2 } as CSSProperties} />
      <circle className={styles.core} cx="50" cy="50" r="5" />
    </svg>
  );
}
