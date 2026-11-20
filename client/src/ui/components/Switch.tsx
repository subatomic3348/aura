import styles from './Switch.module.css';

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: string | undefined;
}

export function Switch({ label, checked, onChange, hint }: SwitchProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={styles.row} onClick={() => onChange(!checked)}>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}
