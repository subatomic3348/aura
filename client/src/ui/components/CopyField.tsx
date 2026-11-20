import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Share } from '../icons';
import styles from './CopyField.module.css';

interface CopyFieldProps {
  value: string;
  /** Shown instead of `value` (e.g. URL without protocol). */
  display?: string;
  label: string;
}

export function CopyField({ value, display, label }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const canShare = typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (permissions, insecure context). Fall back to selection.
      const sel = window.getSelection();
      const node = document.getElementById(fieldId);
      if (sel && node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  const share = () => {
    navigator.share({ title: 'Listen on Aura', url: value }).catch(() => {
      /* user dismissed the share sheet */
    });
  };

  const fieldId = `copy-${label.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <div className={styles.field}>
      <span id={fieldId} className={`mono ${styles.value}`} title={value}>
        {display ?? value}
      </span>
      {canShare && (
        <button type="button" className={styles.action} onClick={share} aria-label={`Share ${label}`}>
          <Share />
        </button>
      )}
      <button
        type="button"
        className={styles.action}
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        data-copied={copied}
      >
        <span className={styles.swap}>
          <Copy />
          <Check />
        </span>
      </button>
      <span className="visually-hidden" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </div>
  );
}
