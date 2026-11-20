import type { ReactNode } from 'react';
import { Warning } from '../icons';
import styles from './Notice.module.css';

interface NoticeProps {
  tone?: 'info' | 'warn' | 'danger';
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Notice({ tone = 'info', title, children, actions }: NoticeProps) {
  return (
    <div className={styles.notice} data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      {tone !== 'info' && (
        <span className={styles.icon}>
          <Warning />
        </span>
      )}
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        {children && <div className={styles.text}>{children}</div>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  );
}
