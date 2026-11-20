import type { MouseEvent, ReactNode } from 'react';
import { navigate } from '../../lib/router';
import styles from './Shell.module.css';

interface ShellProps {
  /** Right side of the top bar (status, actions). */
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Confirm before leaving via the wordmark (e.g. while broadcasting). */
  confirmLeave?: string | undefined;
}

export function Shell({ meta, footer, children, confirmLeave }: ShellProps) {
  const home = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (confirmLeave && !window.confirm(confirmLeave)) return;
    navigate('/');
  };

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <a href="/" className={styles.mark} onClick={home} aria-label="Aura home">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="2" fill="var(--signal)" />
            <circle cx="9" cy="9" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".5" />
            <circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".22" />
          </svg>
          <span className={styles.word}>Aura</span>
        </a>
        {meta && <div className={styles.meta}>{meta}</div>}
      </header>
      <main className={styles.main}>{children}</main>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </div>
  );
}
