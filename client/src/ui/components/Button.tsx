import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'm' | 'l';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** Keyboard shortcut hint rendered as a keycap, e.g. "M". */
  shortcut?: string;
}

export function Button({
  variant = 'secondary',
  size = 'm',
  icon,
  shortcut,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = [styles.button, styles[variant], styles[size], className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children && <span className={styles.text}>{children}</span>}
      {shortcut && (
        <kbd className={styles.kbd} aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}
