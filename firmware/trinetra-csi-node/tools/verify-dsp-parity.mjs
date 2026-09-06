/**
 * Firmware/server DSP parity check.
 *
 * README states: "main/dsp.c and server/dsp/filters.js implement the same
 * algorithms and must be changed together." Nothing enforced that, and they
 * had in fact drifted — the firmware was missing the absolute significance
 * floor and the edge-band rejection that the server gained later, so on a
 * noisy window the node would confidently report a rate the server would
 * have refused to publish.
 *
 * There is no host C compiler in this toolchain (ESP-IDF ships only
 * cross-compilers), so this transcribes the C control flow of
 * tn_bpm_autocorr line-for-line into JS and compares it against the
 * server's bpmAutocorr on identical inputs. Agreement on the same signals
 * is behavioural evidence of parity; a divergence means the two files have
 * drifted again and says on which input.
 *
 * Run: node firmware/trinetra-csi-node/tools/verify-dsp-parity.mjs
 */

import { bpmAutocorr, Biquad } from '../../../server/dsp/filters.js';

/** Faithful transcription of main/dsp.c: ncc(). */
function ncc(x, n, mean, lag) {
  const count = n - lag;
  if (count < 8) return 0;
  let num = 0, ea = 0, eb = 0;
  for (let i = 0; i < count; i++) {
    const a = x[i] - mean;
    const b = x[i + lag] - mean;
    num += a * b; ea += a * a; eb += b * b;
  }
  const denom = Math.sqrt(ea * eb);
  return denom > 1e-12 ? num / denom : 0;
}

const TN_AUTOCORR_MAX_LAG = 128;

/** Faithful transcription of main/dsp.c: tn_bpm_autocorr(). */
function firmwareAutocorr(x, n, fs, bpmMin, bpmMax, rejectHz = 0, rejectTol = 0.08) {
  if (n < 16 || fs <= 0 || bpmMax <= bpmMin) return { bpm: 0, confidence: 0 };
  const mean = x.reduce((a, b) => a + b, 0) / n;

  let lagMin = Math.floor((fs * 60) / bpmMax);
  let lagMax = Math.ceil((fs * 60) / bpmMin);
  if (lagMin < 1) lagMin = 1;
  if (lagMax > n / 2) lagMax = Math.floor(n / 2);
  if (lagMin >= lagMax) return { bpm: 0, confidence: 0 };

  let energy = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mean; energy += d * d; }
  if (energy < 1e-12) return { bpm: 0, confidence: 0 };

  if (lagMax > TN_AUTOCORR_MAX_LAG) lagMax = TN_AUTOCORR_MAX_LAG;
  if (lagMin >= lagMax) return { bpm: 0, confidence: 0 };

  const blocked = (lag) => {
    if (rejectHz <= 1e-6 || lag <= 0) return false;
    const lagHz = fs / lag;
    for (let k = 1; k <= 4; k++) {
      const harm = rejectHz * k;
      if (harm > 1e-6 && Math.abs(lagHz - harm) / harm < rejectTol) return true;
    }
    return false;
  };

  const rOf = new Float64Array(TN_AUTOCORR_MAX_LAG + 2);
  const okOf = new Array(TN_AUTOCORR_MAX_LAG + 2).fill(false);

  let globalMax = -1e30, sumR = 0, nLags = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (blocked(lag)) { okOf[lag] = false; rOf[lag] = 0; continue; }
    const r = ncc(x, n, mean, lag);
    okOf[lag] = true; rOf[lag] = r;
    sumR += r; nLags++;
    if (r > globalMax) globalMax = r;
  }
  if (nLags === 0 || globalMax <= 0) return { bpm: 0, confidence: 0 };

  const MIN_SIGNIFICANT_R = 0.30;
  if (globalMax < MIN_SIGNIFICANT_R) return { bpm: 0, confidence: 0 };

  const OCTAVE_THRESHOLD = 0.85;
  const floorR = Math.max(globalMax * OCTAVE_THRESHOLD, MIN_SIGNIFICANT_R);
  let bestLag = -1, bestR = -1e30;

  for (let lag = lagMin + 1; lag < lagMax; lag++) {
    if (!okOf[lag] || rOf[lag] < floorR) continue;
    const r = rOf[lag];
    const prev = okOf[lag - 1] ? rOf[lag - 1] : -1e30;
    const next = okOf[lag + 1] ? rOf[lag + 1] : -1e30;
    if (r >= prev && r > next) { bestLag = lag; bestR = r; break; }
  }

  if (bestLag < 0) {
    for (let lag = lagMin; lag <= lagMax; lag++) {
      if (okOf[lag] && rOf[lag] > bestR) { bestR = rOf[lag]; bestLag = lag; }
    }
  }
  if (bestLag < 0) return { bpm: 0, confidence: 0 };

  if (bestLag <= lagMin + 1 || bestLag >= lagMax - 1) return { bpm: 0, confidence: 0 };

  let lag = bestLag;
  {
    const rm = okOf[bestLag - 1] ? rOf[bestLag - 1] : bestR;
    const rp = okOf[bestLag + 1] ? rOf[bestLag + 1] : bestR;
    const denom = rm - 2 * bestR + rp;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (rm - rp)) / denom;
      if (delta > -1 && delta < 1) lag += delta;
    }
  }

  const avg = sumR / nLags;
  const prom = Math.min(1, Math.max(0, bestR - avg));
  return { bpm: lag > 0 ? (60 * fs) / lag : 0, confidence: prom };
}

// ── Cases ──────────────────────────────────────────────────────────────
const fs = 20;
const N = 256;

function synth(fn) {
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = fn(i / fs);
  return x;
}

let rnd = 12345;
const noise = () => {
  rnd = (rnd * 1664525 + 1013904223) >>> 0;
  return ((rnd >>> 16) & 0xffff) / 32768 - 1;
};

const cases = [
  ['clean 15 BPM', synth((t) => Math.sin(2 * Math.PI * 0.25 * t)), 6, 30, 0],
  ['clean 12 BPM', synth((t) => Math.sin(2 * Math.PI * 0.20 * t)), 6, 30, 0],
  ['clean 20 BPM', synth((t) => Math.sin(2 * Math.PI * 0.333 * t)), 6, 30, 0],
  ['noisy 15 BPM', synth((t) => Math.sin(2 * Math.PI * 0.25 * t) + 0.6 * noise()), 6, 30, 0],
  ['pure noise', synth(() => noise()), 6, 30, 0],
  ['DC only', synth(() => 1.0), 6, 30, 0],
  ['out-of-band 40 BPM', synth((t) => Math.sin(2 * Math.PI * 0.667 * t)), 6, 30, 0],
  ['heart w/ breathing harmonics',
    synth((t) => 1.0 * Math.sin(2 * Math.PI * 0.25 * t)
               + 0.30 * Math.sin(2 * Math.PI * 0.75 * t)
               + 0.12 * Math.sin(2 * Math.PI * 1.15 * t)), 40, 120, 0.25],
];

/**
 * Compare the two implementations across every case.
 * @returns [{ name, firmware, server, agree }]
 */
export function runParity() {
  return cases.map(([name, raw, bpmMin, bpmMax, reject]) => {
    // Both sides see the same band-limited signal the real chain produces.
    const band = bpmMin > 30
      ? Biquad.bandpass(fs, 0.67, 2.0).run(raw)
      : Biquad.bandpass(fs, 0.1, 0.5).run(raw);

    const f = firmwareAutocorr(band, band.length, fs, bpmMin, bpmMax, reject, 0.06);
    const s = bpmAutocorr(band, fs, bpmMin, bpmMax, reject, 0.06);

    const agree = (f.bpm === 0 && s.bpm === 0) ||
                  (f.bpm > 0 && s.bpm > 0 && Math.abs(f.bpm - s.bpm) < 0.5);
    return { name, firmware: f.bpm, server: s.bpm, agree };
  });
}

// CLI use.
if (process.argv[1]?.endsWith('verify-dsp-parity.mjs')) {
  const results = runParity();
  console.log('case                            firmware(dsp.c)   server(filters.js)   verdict');
  for (const r of results) {
    const fb = r.firmware ? r.firmware.toFixed(2) : 'none';
    const sb = r.server ? r.server.toFixed(2) : 'none';
    console.log(`${r.name.padEnd(30)} ${fb.padStart(9)}        ${sb.padStart(9)}        ${r.agree ? 'match' : 'DIVERGED'}`);
  }
  const fail = results.filter((r) => !r.agree).length;
  console.log(fail === 0
    ? '\nPARITY OK — dsp.c and filters.js agree on every case.'
    : `\nPARITY BROKEN — ${fail} case(s) diverged.`);
  process.exit(fail === 0 ? 0 : 1);
}
