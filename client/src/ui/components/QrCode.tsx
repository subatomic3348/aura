import { useMemo } from 'react';
import QR from 'qrcode';
import styles from './QrCode.module.css';

interface QrCodeProps {
  value: string;
  /** Rendered size in CSS px. */
  size?: number;
  label?: string;
}

/**
 * QR code rendered as a single SVG path (one DOM node regardless of density).
 * Always dark-on-light, even in dark mode: many phone scanners fail on
 * inverted codes.
 */
export function QrCode({ value, size = 224, label = 'QR code to join this broadcast' }: QrCodeProps) {
  const { path, dim } = useMemo(() => {
    const qr = QR.create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { path: d, dim: n };
  }, [value]);

  const quiet = 3;
  return (
    <div className={styles.frame} style={{ width: size, height: size }}>
      {/* key forces the reveal animation to replay when the code changes */}
      <svg
        key={value}
        className={styles.svg}
        viewBox={`${-quiet} ${-quiet} ${dim + quiet * 2} ${dim + quiet * 2}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label={label}
      >
        <path d={path} />
      </svg>
    </div>
  );
}
