import { useId, type CSSProperties } from 'react';
import styles from './Fader.module.css';

interface FaderProps {
  label: string;
  /** 0..1 */
  value: number;
  onChange(value: number): void;
  disabled?: boolean;
}

/**
 * Horizontal fader built on a native range input, so keyboard, screen-reader
 * and touch behaviour come for free. The fill is driven by a CSS variable.
 */
export function Fader({ label, value, onChange, disabled }: FaderProps) {
  const id = useId();
  const pct = Math.round(value * 100);
  return (
    <div className={styles.fader} style={{ '--value': value } as CSSProperties} data-disabled={disabled}>
      <div className={styles.head}>
        <label htmlFor={id} className="label">
          {label}
        </label>
        <output htmlFor={id} className={`mono ${styles.readout}`}>
          {pct === 0 ? 'OFF' : String(pct).padStart(3, '0')}
        </output>
      </div>
      <div className={styles.track}>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={disabled}
          aria-valuetext={`${pct} percent`}
          onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
          className={styles.input}
        />
      </div>
      <div className={styles.ticks} aria-hidden="true">
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} data-major={i % 5 === 0} />
        ))}
      </div>
    </div>
  );
}
