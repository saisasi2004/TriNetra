/**
 * Robust statistics and spectral primitives.
 *
 * Everything here is allocation-light and works on plain arrays or typed
 * arrays. No dependencies — the maths is small enough that pulling in a DSP
 * library would cost more than it saves.
 */

export function mean(x, n = x.length) {
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  return s / n;
}

export function variance(x, n = x.length) {
  if (n < 2) return 0;
  const m = mean(x, n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    s += d * d;
  }
  return s / (n - 1);
}

export const stddev = (x, n) => Math.sqrt(variance(x, n));

export function median(x, n = x.length) {
  if (n === 0) return 0;
  const a = Array.prototype.slice.call(x, 0, n).sort((p, q) => p - q);
  const mid = n >> 1;
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function percentile(x, p, n = x.length) {
  if (n === 0) return 0;
  const a = Array.prototype.slice.call(x, 0, n).sort((q, r) => q - r);
  const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
  return a[idx];
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export const clamp01 = (v) => clamp(v, 0, 1);

/**
 * Hampel filter: replace points more than nSigma robust-sigmas from the
 * local median. Returns a new array.
 *
 * This is the single most valuable preprocessing step for ESP32 CSI. The
 * radio emits occasional wild amplitude spikes on AGC changes, and a single
 * one will dominate any variance metric computed over the window.
 */
export function hampel(x, half = 3, nSigma = 3) {
  const n = x.length;
  const out = Float64Array.from(x);
  if (n <= half * 2) return out;

  const win = new Float64Array(half * 2 + 1);
  const dev = new Float64Array(half * 2 + 1);

  for (let i = half; i < n - half; i++) {
    for (let j = 0; j < win.length; j++) win[j] = x[i - half + j];
    const med = median(win);
    for (let j = 0; j < win.length; j++) dev[j] = Math.abs(win[j] - med);
    const sigma = 1.4826 * median(dev);
    if (sigma > 1e-12 && Math.abs(x[i] - med) > nSigma * sigma) out[i] = med;
  }
  return out;
}

/**
 * Unwrap a phase series in place, removing the ±pi discontinuities.
 * Mandatory before any temporal filtering: every wrap otherwise looks
 * like a 2pi impulse and swamps the signal.
 */
export function unwrapPhase(phase) {
  const out = Float64Array.from(phase);
  let offset = 0;
  for (let i = 1; i < out.length; i++) {
    const d = out[i] + offset - out[i - 1];
    if (d > Math.PI) offset -= 2 * Math.PI;
    else if (d < -Math.PI) offset += 2 * Math.PI;
    out[i] += offset;
  }
  return out;
}

/**
 * Remove the linear Sampling-Time-Offset / Carrier-Frequency-Offset ramp
 * across the subcarrier axis.
 *
 * These are receiver artefacts. The ramp is orders of magnitude larger than
 * the millimetre-scale body motion underneath it, so without this step the
 * phase signal is unusable.
 */
export function sanitizePhase(phase) {
  const n = phase.length;
  if (n < 3) return Float64Array.from(phase);

  const p = unwrapPhase(phase);

  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += p[i]; sxx += i * i; sxy += i * p[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return p;

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) p[i] -= slope * i + intercept;
  return p;
}

/** Circular variance of wrapped phases: 0 = perfectly coherent, 1 = uniform. */
export function circularVariance(phase) {
  const n = phase.length;
  if (n === 0) return 1;
  let c = 0, s = 0;
  for (let i = 0; i < n; i++) { c += Math.cos(phase[i]); s += Math.sin(phase[i]); }
  return 1 - Math.hypot(c, s) / n;
}

/**
 * Iterative in-place radix-2 FFT. `re`/`im` must be power-of-two length.
 * Written out rather than imported because it is 30 lines and the whole
 * spectral path depends on it.
 */
export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;  im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** One-sided power spectrum of a real signal, Hann-windowed and zero-padded. */
export function powerSpectrum(x, fs) {
  const n = x.length;
  if (n < 4) return { freqs: [], power: [], df: 0 };

  let size = 1;
  while (size < n) size <<= 1;
  size <<= 1;                      // zero-pad 2x for finer bin spacing

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const m = mean(x, n);

  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));  // Hann
    re[i] = (x[i] - m) * w;
  }

  fft(re, im);

  const half = size >> 1;
  const power = new Float64Array(half);
  for (let i = 0; i < half; i++) power[i] = (re[i] * re[i] + im[i] * im[i]) / (n * n);

  const df = fs / size;
  const freqs = new Float64Array(half);
  for (let i = 0; i < half; i++) freqs[i] = i * df;

  return { freqs, power, df };
}

/** Summed power in [fLo, fHi]. */
export function bandPower(x, fs, fLo, fHi) {
  return bandStats(x, fs, fLo, fHi).power;
}

/**
 * Power in [fLo, fHi] together with how CONCENTRATED that power is.
 *
 * Band power alone cannot tell a rhythm from a noise excursion, and that
 * distinction is what presence detection for a still person rests on.
 * Filtered noise still has band power, and because the power of noise in a
 * narrow band is itself violently variable, an empty room routinely produces
 * ratios of 10-20x against its own learned mean — far above any fixed
 * threshold. Measured on the simulator's empty room, the breathing-band
 * ratio reached 23x against a trigger of 4x, and presence fired on 30% of
 * ticks with nobody in the room.
 *
 * `peakRatio` is the strongest bin divided by the band's median bin. A real
 * breathing signal is one narrow line and scores high; noise is spread
 * across the band and scores near 1 however energetic it happens to be. It
 * is the shape of the spectrum, not its size, so it does not inherit the
 * variance that makes raw power unusable as a gate.
 *
 * Both come from a single FFT — this is on the per-frame path.
 */
export function bandStats(x, fs, fLo, fHi) {
  const { freqs, power } = powerSpectrum(x, fs);

  let sum = 0, best = 0, bestP = 0;
  const inBand = [];
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < fLo || freqs[i] > fHi) continue;
    const p = power[i];
    sum += p;
    inBand.push(p);
    if (p > bestP) { bestP = p; best = freqs[i]; }
  }
  if (inBand.length === 0) return { power: 0, peakFreq: 0, peakRatio: 0 };

  const med = median(inBand, inBand.length);
  return {
    power: sum,
    peakFreq: best,
    peakRatio: med > 1e-18 ? bestP / med : 0,
  };
}

/** Frequency of the strongest bin within [fLo, fHi], with its prominence. */
export function dominantFrequency(x, fs, fLo = 0, fHi = Infinity) {
  const { freqs, power } = powerSpectrum(x, fs);
  let best = 0, bestP = -1, sum = 0, count = 0;

  for (let i = 1; i < freqs.length; i++) {
    if (freqs[i] < fLo || freqs[i] > fHi) continue;
    sum += power[i];
    count++;
    if (power[i] > bestP) { bestP = power[i]; best = freqs[i]; }
  }
  if (count === 0 || bestP <= 0) return { freq: 0, power: 0, prominence: 0 };

  const avg = sum / count;
  return {
    freq: best,
    power: bestP,
    prominence: avg > 1e-15 ? clamp01((bestP / avg - 1) / 8) : 0,
  };
}

/**
 * Count change points via a CUSUM-style detector.
 * Used as a coarse "how eventful was this window" feature.
 */
export function changePoints(x, threshold = 3) {
  const n = x.length;
  if (n < 8) return 0;

  const m = mean(x, n);
  const sd = stddev(x, n) || 1e-9;
  let cusum = 0, count = 0, cooldown = 0;

  for (let i = 0; i < n; i++) {
    cusum += (x[i] - m) / sd;
    if (cooldown > 0) { cooldown--; continue; }
    if (Math.abs(cusum) > threshold) { count++; cusum = 0; cooldown = 4; }
  }
  return count;
}

/** Exponential moving average with lazy priming. */
export class Ema {
  constructor(alpha) { this.alpha = alpha; this.value = 0; this.primed = false; }
  update(x) {
    if (!Number.isFinite(x)) return this.value;
    if (!this.primed) { this.value = x; this.primed = true; }
    else this.value += this.alpha * (x - this.value);
    return this.value;
  }
  reset() { this.primed = false; this.value = 0; }
}

/** Fixed-size ring buffer with chronological read-out. */
export class Ring {
  constructor(capacity) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.head = 0;
    this.count = 0;
  }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  /** Oldest-to-newest copy. */
  toArray() {
    const out = new Float64Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }
  last() { return this.count ? this.buf[(this.head - 1 + this.capacity) % this.capacity] : 0; }
  get length() { return this.count; }
  clear() { this.head = 0; this.count = 0; }
}

/** Median over a small sliding window — kills isolated BPM outliers. */
export class MedianRing {
  constructor(n) { this.n = n; this.buf = []; }
  push(v) {
    this.buf.push(v);
    if (this.buf.length > this.n) this.buf.shift();
    return median(this.buf, this.buf.length);
  }
  clear() { this.buf.length = 0; }
}
