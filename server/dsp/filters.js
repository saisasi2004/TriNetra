/**
 * IIR filters and autocorrelation rate estimation.
 *
 * Same designs as the firmware's dsp.c so a signal filtered on the node and
 * one filtered on the server produce comparable numbers.
 */

import { mean, clamp01 } from './stats.js';

/** Direct Form II transposed biquad. */
export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  static bandpass(fs, fLo, fHi) {
    const bq = new Biquad();
    const nyq = fs / 2;
    fHi = Math.min(fHi, nyq * 0.98);
    fLo = Math.max(fLo, 1e-4);
    if (fLo >= fHi) fLo = fHi * 0.5;

    const f0 = Math.sqrt(fLo * fHi);
    const bw = fHi - fLo;
    const q = bw > 1e-9 ? f0 / bw : 1;

    const w0 = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;

    bq.b0 = alpha / a0;
    bq.b1 = 0;
    bq.b2 = -alpha / a0;
    bq.a1 = (-2 * cosw0) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  static lowpass(fs, fc) {
    const bq = new Biquad();
    fc = Math.min(fc, (fs / 2) * 0.98);
    const w0 = (2 * Math.PI * fc) / fs;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;

    bq.b0 = ((1 - cosw0) / 2) / a0;
    bq.b1 = (1 - cosw0) / a0;
    bq.b2 = bq.b0;
    bq.a1 = (-2 * cosw0) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  /** Narrow band-stop at f0. Higher q = narrower notch. */
  static notch(fs, f0, q = 8) {
    const bq = new Biquad();
    const nyq = fs / 2;
    if (f0 <= 0 || f0 >= nyq * 0.98) return bq;   // pass-through

    const w0 = (2 * Math.PI * f0) / fs;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;

    bq.b0 = 1 / a0;
    bq.b1 = (-2 * cosw0) / a0;
    bq.b2 = 1 / a0;
    bq.a1 = (-2 * cosw0) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  static highpass(fs, fc) {
    const bq = new Biquad();
    const w0 = (2 * Math.PI * fc) / fs;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;

    bq.b0 = ((1 + cosw0) / 2) / a0;
    bq.b1 = (-(1 + cosw0)) / a0;
    bq.b2 = bq.b0;
    bq.a1 = (-2 * cosw0) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  reset() { this.z1 = 0; this.z2 = 0; }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /**
   * Filter a whole buffer. The filter is primed with the first sample so it
   * does not spend the first 1/fc seconds decaying from zero — that
   * transient otherwise reads as a large low-frequency oscillation, which
   * is exactly the band we care about.
   */
  run(x) {
    this.reset();
    for (let i = 0; i < 8; i++) this.process(x[0]);
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = this.process(x[i]);
    return out;
  }
}

/**
 * Remove a fundamental and its harmonics from a signal.
 *
 * This is what makes contactless heart rate work at all. Breathing is 5-10x
 * stronger than the cardiac component, and its 3rd harmonic lands squarely
 * in the heart-rate band — 0.25 Hz breathing puts energy at 0.75 Hz = 45 BPM,
 * larger than the heartbeat itself.
 *
 * Merely excluding those lags from the autocorrelation search is not enough:
 * the harmonic still dominates the correlation everywhere, smearing a broad
 * hump across the whole band so no genuine cardiac peak ever forms. The
 * interfering component has to be filtered OUT, not searched around.
 *
 * Notches are narrow (default q = 10, roughly f0/10 wide) so that a real
 * heart rate sitting near a harmonic survives.
 */
export function notchHarmonics(x, fs, f0, harmonics = 4, q = 10) {
  if (!(f0 > 0)) return Float64Array.from(x);

  let out = Float64Array.from(x);
  for (let k = 1; k <= harmonics; k++) {
    const f = f0 * k;
    if (f >= fs / 2 * 0.95) break;
    out = Biquad.notch(fs, f, q).run(out);
  }
  return out;
}

/** Zero-phase filtering: forward then reverse. Doubles the order, no lag. */
export function filtfilt(makeFilter, x) {
  const fwd = makeFilter().run(x);
  const rev = Float64Array.from(fwd).reverse();
  const back = makeFilter().run(rev);
  return Float64Array.from(back).reverse();
}

/**
 * BPM from positive-going zero crossings.
 *
 * Included for completeness and cheap sanity checks. Do NOT use it for
 * heart rate: see bpmAutocorr for why.
 */
export function bpmZeroCrossing(x, fs) {
  let crossings = 0, first = -1, last = -1;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] <= 0 && x[i] > 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  if (crossings < 2 || last <= first) return 0;
  const spanS = (last - first) / fs;
  return spanS > 0 ? (60 * (crossings - 1)) / spanS : 0;
}

/**
 * BPM by autocorrelation peak within [bpmMin, bpmMax].
 *
 * `rejectHz` suppresses lags coinciding with harmonics k*rejectHz (k=1..6)
 * within `rejectTol` fractional tolerance.
 *
 * This rejection is not optional for heart rate. Breathing at 0.25 Hz puts
 * its 3rd harmonic at 0.75 Hz = 45 BPM, indistinguishable from a resting
 * heart rate. Without rejection the estimator locks onto the breathing
 * harmonic and produces a stable, plausible, completely wrong number —
 * the worst kind of failure, because it looks like it is working.
 *
 * Returns { bpm, confidence } with confidence 0 when no estimate is found.
 */
export function bpmAutocorr(x, fs, bpmMin, bpmMax, rejectHz = 0, rejectTol = 0.08) {
  const n = x.length;
  if (n < 16 || fs <= 0 || bpmMax <= bpmMin) return { bpm: 0, confidence: 0 };

  const m = mean(x, n);

  let lagMin = Math.floor((fs * 60) / bpmMax);
  let lagMax = Math.ceil((fs * 60) / bpmMin);
  lagMin = Math.max(1, lagMin);
  lagMax = Math.min(Math.floor(n / 2), lagMax);
  if (lagMin >= lagMax) return { bpm: 0, confidence: 0 };

  let energy = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - m; energy += d * d; }
  if (energy < 1e-15) return { bpm: 0, confidence: 0 };

  /**
   * Normalised cross-correlation over the OVERLAPPING segment only.
   *
   * The naive form — sum the overlap, divide by the full-window energy —
   * is biased toward short lags, because a long lag sums fewer terms
   * against the same denominator. The estimator then reliably rails at
   * `lagMin`, i.e. reports the maximum BPM in the search band regardless
   * of the input. Dividing by the geometric mean of the two overlapping
   * segments' own energies removes the bias completely.
   */
  const corr = (lag) => {
    const count = n - lag;
    if (count < 8) return 0;
    let num = 0, ea = 0, eb = 0;
    for (let i = 0; i < count; i++) {
      const a = x[i] - m;
      const b = x[i + lag] - m;
      num += a * b;
      ea += a * a;
      eb += b * b;
    }
    const denom = Math.sqrt(ea * eb);
    return denom > 1e-15 ? num / denom : 0;
  };

  /**
   * Harmonic rejection, limited to k = 1..4.
   *
   * Going higher is counterproductive. Breathing harmonics above the 4th
   * carry very little energy, but the rejection notch around each one is
   * wide enough to swallow real heart rates: with a 0.25 Hz fundamental,
   * the 5th harmonic sits at 1.25 Hz = 75 BPM, and an 8% notch there
   * blocks every genuine heart rate from 69 to 81 BPM. Rejecting harmonics
   * we do not need costs more than it saves — k <= 4 still kills the 3rd
   * harmonic, which is the failure mode that actually occurs.
   */
  const MAX_HARMONIC = 4;
  const blocked = (lag) => {
    if (rejectHz <= 1e-6) return false;
    const lagHz = fs / lag;
    for (let k = 1; k <= MAX_HARMONIC; k++) {
      const harm = rejectHz * k;
      if (harm > 1e-6 && Math.abs(lagHz - harm) / harm < rejectTol) return true;
    }
    return false;
  };

  // Evaluate every admissible lag once.
  const rs = new Map();
  let globalMax = -Infinity, sum = 0, count = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (blocked(lag)) continue;
    const r = corr(lag);
    rs.set(lag, r);
    sum += r;
    count++;
    if (r > globalMax) globalMax = r;
  }
  if (count === 0 || globalMax <= 0) return { bpm: 0, confidence: 0 };

  /**
   * Pick the FIRST local peak that reaches most of the global maximum —
   * not the global maximum itself.
   *
   * A periodic signal correlates with itself at its period T *and* at 2T,
   * 3T, ... all with near-identical normalised scores. Taking the global
   * max therefore lands on an arbitrary multiple, and 15 BPM comes back as
   * 7.5. This is the octave error that every autocorrelation pitch tracker
   * has to solve; the standard remedy is to walk up from the shortest lag
   * and stop at the first peak that is clearly significant.
   */
  const OCTAVE_THRESHOLD = 0.85;

  // Absolute significance floor. Relative thresholds alone are not enough:
  // on pure noise the "global maximum" is itself noise, 85% of it is
  // trivially reached by the first ripple near lagMin, and the estimator
  // confidently reports bpmMax. A genuine periodicity correlates with
  // itself at r >= 0.3; below that we report nothing, which is far more
  // useful than a plausible fabricated number.
  const MIN_SIGNIFICANT_R = 0.30;
  if (globalMax < MIN_SIGNIFICANT_R) return { bpm: 0, confidence: 0 };

  const floor = Math.max(MIN_SIGNIFICANT_R, globalMax * OCTAVE_THRESHOLD);

  let bestLag = -1, bestR = -Infinity;

  // Require a local maximum over +/-2 samples, not +/-1. Noise routinely
  // produces single-sample peaks; a real period does not.
  for (let lag = lagMin + 2; lag < lagMax - 1; lag++) {
    const r = rs.get(lag);
    if (r === undefined || r < floor) continue;

    let isPeak = true;
    for (let d = -2; d <= 2 && isPeak; d++) {
      if (d === 0) continue;
      const nb = rs.get(lag + d);
      if (nb !== undefined && nb > r) isPeak = false;
    }
    if (isPeak) { bestLag = lag; bestR = r; break; }
  }

  // No qualifying local peak: fall back to the global maximum, which we
  // already know clears the significance floor.
  if (bestLag < 0) {
    for (const [lag, r] of rs) {
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
  }
  if (bestLag < 0) return { bpm: 0, confidence: 0 };

  // Reject estimates pinned to the edge of the search band.
  //
  // A genuine physiological rate almost never lands exactly on 6.0 or 30.0
  // BPM; a peak sitting on the boundary means the true period is outside the
  // band, or there is no periodicity and the correlation is simply sloping.
  // Both are failures, and both produce a stable, plausible-looking number.
  // Reporting nothing is strictly better.
  if (bestLag <= lagMin + 1 || bestLag >= lagMax - 1) {
    return { bpm: 0, confidence: 0 };
  }

  // Parabolic interpolation for sub-sample lag resolution. Without it the
  // BPM output visibly quantises at low sample rates.
  let lag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const rm = rs.get(bestLag - 1) ?? corr(bestLag - 1);
    const rp = rs.get(bestLag + 1) ?? corr(bestLag + 1);
    const denom = rm - 2 * bestR + rp;
    if (Math.abs(denom) > 1e-12) {
      const delta = (0.5 * (rm - rp)) / denom;
      if (delta > -1 && delta < 1) lag += delta;
    }
  }

  // Prominence: how far the peak stands above the mean correlation. A
  // periodic signal gives an isolated sharp peak; noise gives a flat field.
  const confidence = clamp01(bestR - sum / count);

  return { bpm: lag > 0 ? (60 * fs) / lag : 0, confidence };
}

/**
 * Kalman filter for a 1-D value with velocity. Used to smooth person
 * positions across ticks, where raw field peaks jitter by tens of cm.
 */
export class Kalman1D {
  constructor(processNoise = 0.01, measurementNoise = 0.35) {
    this.q = processNoise;
    this.r = measurementNoise;
    this.x = 0; this.v = 0;
    this.p = [[1, 0], [0, 1]];
    this.primed = false;
  }

  update(z, dt = 0.1) {
    if (!this.primed) { this.x = z; this.v = 0; this.primed = true; return this.x; }

    // Predict
    this.x += this.v * dt;
    const [[p00, p01], [p10, p11]] = this.p;
    this.p = [
      [p00 + dt * (p10 + p01) + dt * dt * p11 + this.q, p01 + dt * p11],
      [p10 + dt * p11, p11 + this.q],
    ];

    // Update
    const k0 = this.p[0][0] / (this.p[0][0] + this.r);
    const k1 = this.p[1][0] / (this.p[0][0] + this.r);
    const y = z - this.x;
    this.x += k0 * y;
    this.v += k1 * y;
    this.p = [
      [(1 - k0) * this.p[0][0], (1 - k0) * this.p[0][1]],
      [this.p[1][0] - k1 * this.p[0][0], this.p[1][1] - k1 * this.p[0][1]],
    ];
    return this.x;
  }
}
