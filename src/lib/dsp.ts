export type PidState = {
  integral: number;
  prevError: number;
  output: number;
};

export type PidGains = { Kp: number; Ki: number; Kd: number };

export function emptyPid(): PidState {
  return { integral: 0, prevError: 0, output: 0 };
}

/** Discrete PID step (firmware-style). dt in seconds. */
export function pidStep(
  state: PidState,
  gains: PidGains,
  error: number,
  dt: number,
): PidState {
  if (dt <= 0 || !isFinite(dt)) dt = 0.01;
  const integral = state.integral + error * dt;
  const derivative = (error - state.prevError) / dt;
  const output = gains.Kp * error + gains.Ki * integral + gains.Kd * derivative;
  return { integral, prevError: error, output };
}

/** Naive DFT magnitude spectrum. Returns one-sided bins. */
export function dftMagnitude(
  signal: number[],
  sampleRate: number,
): { freq: number; mag: number }[] {
  const N = signal.length;
  if (N < 4 || sampleRate <= 0) return [];
  // De-mean to drop the DC component before the transform.
  let mean = 0;
  for (let i = 0; i < N; i++) mean += signal[i];
  mean /= N;
  const bins: { freq: number; mag: number }[] = [];
  const half = Math.floor(N / 2);
  for (let k = 0; k < half; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / N;
    for (let n = 0; n < N; n++) {
      const v = signal[n] - mean;
      const phi = w * n;
      re += v * Math.cos(phi);
      im -= v * Math.sin(phi);
    }
    bins.push({ freq: (k * sampleRate) / N, mag: (2 * Math.hypot(re, im)) / N });
  }
  return bins;
}

/** Peak frequency (Hz) in a magnitude spectrum, restricted to [fMin, fMax]. */
export function peakFrequency(
  bins: { freq: number; mag: number }[],
  fMin: number,
  fMax: number,
): { freq: number; mag: number } {
  let peakMag = 0;
  let peakFreq = 0;
  for (const b of bins) {
    if (b.freq < fMin || b.freq > fMax) continue;
    if (b.mag > peakMag) {
      peakMag = b.mag;
      peakFreq = b.freq;
    }
  }
  return { freq: peakFreq, mag: peakMag };
}

/** Mean absolute second-difference (a proxy for jerk) over a path. */
export function jerkMetric(path: { x: number; y: number }[]): number {
  if (path.length < 3) return 0;
  let sum = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const ax = path[i - 1].x - 2 * path[i].x + path[i + 1].x;
    const ay = path[i - 1].y - 2 * path[i].y + path[i + 1].y;
    sum += Math.hypot(ax, ay);
  }
  return sum / (path.length - 2);
}

/** Mean discrete curvature magnitude over a path. */
export function curvatureMetric(path: { x: number; y: number }[]): number {
  if (path.length < 3) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const dx1 = path[i].x - path[i - 1].x;
    const dy1 = path[i].y - path[i - 1].y;
    const dx2 = path[i + 1].x - path[i].x;
    const dy2 = path[i + 1].y - path[i].y;
    const cross = dx1 * dy2 - dy1 * dx2;
    const speed = Math.hypot(dx1, dy1) + Math.hypot(dx2, dy2);
    if (speed > 0.01) {
      sum += Math.abs(cross) / (speed * speed * speed + 1e-6);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** RMS perpendicular deviation of a path from a horizontal line y = yRef. */
export function rmsDeviationFromLine(
  path: { x: number; y: number }[],
  yRef: number,
): number {
  if (path.length === 0) return 0;
  let sumSq = 0;
  for (const p of path) sumSq += (p.y - yRef) * (p.y - yRef);
  return Math.sqrt(sumSq / path.length);
}
