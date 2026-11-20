/**
 * A pull-based audio level source. Visualisations poll it from
 * requestAnimationFrame, so audio activity never flows through React state.
 */
export interface LevelSource {
  /** Current level, 0..1, perceptually scaled. Cheap to call every frame. */
  getLevel(): number;
}

const FLOOR_DB = -54;

/**
 * Level meter over an AnalyserNode: RMS → dBFS → 0..1, with fast attack and
 * slow release so it reads like a hardware meter rather than jittering.
 */
export class AnalyserLevel implements LevelSource {
  private readonly buf: Float32Array<ArrayBuffer>;
  private current = 0;

  constructor(private readonly analyser: AnalyserNode) {
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    this.buf = new Float32Array(analyser.fftSize);
  }

  getLevel(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const s = this.buf[i]!;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / this.buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const v = Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
    this.current = v > this.current ? v : this.current * 0.86 + v * 0.14;
    return this.current;
  }
}
