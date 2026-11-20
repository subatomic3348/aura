import { useEffect, useRef } from 'react';
import type { LevelSource } from '../../audio/level';
import styles from './LevelEnvelope.module.css';

interface LevelEnvelopeProps {
  source: LevelSource | null;
  /** When false the history freezes and dims (paused / muted). */
  active: boolean;
  height?: number;
  label?: string;
}

const BAR = 2; // css px
const GAP = 3; // css px
const STEP_MS = 45; // one new column every 45ms ≈ 22 columns/sec
const PEAK = 0.86;

/**
 * Scrolling envelope of recent audio level, mirrored around a centre line.
 *
 * Rendering is entirely outside React: a rAF loop pulls from `source` and
 * paints to a canvas. Props changes only restart the loop.
 */
export function LevelEnvelope({ source, active, height = 120, label = 'Audio activity' }: LevelEnvelopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cols = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let colors = { ink: '#000', dim: '#888', line: '#ccc', signal: '#f50' };

    const readColors = () => {
      const cs = getComputedStyle(canvas);
      colors = {
        ink: cs.getPropertyValue('--ink').trim(),
        dim: cs.getPropertyValue('--ink-3').trim(),
        line: cs.getPropertyValue('--line-strong').trim(),
        signal: cs.getPropertyValue('--signal').trim(),
      };
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const nextCols = Math.max(1, Math.floor((w + GAP) / (BAR + GAP)));
      if (nextCols !== cols) {
        // Keep the most recent history when the width changes.
        const prev = historyRef.current;
        const next = new Float32Array(nextCols);
        const n = Math.min(prev.length, nextCols);
        next.set(prev.subarray(prev.length - n), nextCols - n);
        historyRef.current = next;
        cols = nextCols;
      }
      readColors();
      draw();
    };

    const draw = () => {
      const hist = historyRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;
      const maxHalf = mid - 1;

      ctx.fillStyle = colors.line;
      ctx.fillRect(0, Math.round(mid) - 0.5, w, 1);

      const offset = w - (cols * (BAR + GAP) - GAP);
      for (let i = 0; i < cols; i++) {
        const v = hist[i] ?? 0;
        if (v <= 0.002) continue;
        const half = Math.max(1, v * maxHalf);
        const x = offset + i * (BAR + GAP);
        // Newest ~third in full ink, older columns fade toward muted.
        const age = (cols - 1 - i) / cols;
        ctx.globalAlpha = active ? 1 - age * 0.75 : 0.35;
        ctx.fillStyle = active && v >= PEAK ? colors.signal : active && age < 0.33 ? colors.ink : colors.dim;
        ctx.fillRect(x, mid - half, BAR, half * 2);
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let pending = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(now - last, 250);
      last = now;
      if (!source) return;
      // Track the max level between columns so short transients are not lost.
      pending = Math.max(pending, source.getLevel());
      acc += dt;
      if (acc < STEP_MS) return;
      acc %= STEP_MS;
      const hist = historyRef.current;
      hist.copyWithin(0, 1);
      hist[hist.length - 1] = pending;
      pending = 0;
      draw();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      readColors();
      draw();
    };
    scheme.addEventListener('change', onScheme);
    resize();

    if (active && source) raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scheme.removeEventListener('change', onScheme);
    };
  }, [source, active]);

  return (
    <div className={styles.wrap} data-active={active && !!source}>
      <canvas ref={canvasRef} className={styles.canvas} style={{ height }} role="img" aria-label={label} />
    </div>
  );
}
