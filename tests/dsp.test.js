/**
 * DSP unit tests.  Run with:  npm test
 *
 * These test the numerical core against signals whose answer we know
 * exactly. Every one of them corresponds to a bug that actually occurred
 * during development — they are regression tests, not decoration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Biquad, bpmAutocorr, bpmZeroCrossing, notchHarmonics,
} from '../server/dsp/filters.js';
import {
  hampel, sanitizePhase, unwrapPhase, dominantFrequency, mean, variance,
  circularVariance, Ring,
} from '../server/dsp/stats.js';
import { decodePacket, encodeCsi, MAGIC } from '../server/net/protocol.js';

const sine = (freqHz, fs, seconds, amp = 1, noise = 0) => {
  const n = Math.round(fs * seconds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / fs)
           + (Math.random() - 0.5) * noise;
  }
  return out;
};

test('bpmAutocorr recovers a clean breathing rate', () => {
  // 15 BPM = 0.25 Hz, 20 s at 20 Hz.
  const x = sine(0.25, 20, 20);
  const { bpm, confidence } = bpmAutocorr(x, 20, 6, 30);
  assert.ok(Math.abs(bpm - 15) < 0.5, `expected ~15 BPM, got ${bpm.toFixed(2)}`);
  assert.ok(confidence > 0.5, `expected high confidence, got ${confidence}`);
});

test('bpmAutocorr does NOT rail at the top of the search band', () => {
  // Regression: normalising every lag by the full-window energy biases the
  // estimator toward short lags, because a long lag sums fewer overlapping
  // terms. The symptom was every estimate coming back as bpmMax.
  for (const trueBpm of [8, 12, 15, 20, 26]) {
    const x = sine(trueBpm / 60, 20, 25);
    const { bpm } = bpmAutocorr(x, 20, 6, 30);
    assert.ok(
      Math.abs(bpm - trueBpm) < 1.2,
      `${trueBpm} BPM misread as ${bpm.toFixed(2)} (railing at band edge?)`,
    );
    assert.ok(bpm < 29.5, `estimator railed at band maximum for ${trueBpm} BPM`);
  }
});

test('bpmAutocorr survives realistic noise', () => {
  const x = sine(0.24, 20, 25, 1, 1.2);   // SNR well under 1 per sample
  const { bpm } = bpmAutocorr(x, 20, 6, 30);
  assert.ok(Math.abs(bpm - 14.4) < 2.0, `got ${bpm.toFixed(2)} BPM`);
});

test('heart rate rejects breathing harmonics', () => {
  // The trap: 0.25 Hz breathing puts its 3rd harmonic at 0.75 Hz = 45 BPM,
  // a perfectly plausible resting heart rate. A strong breathing signal
  // with a weak cardiac component must NOT report the harmonic.
  const fs = 20, secs = 30;
  const n = fs * secs;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    x[i] = 1.0 * Math.sin(2 * Math.PI * 0.25 * t)          // breathing
         + 0.30 * Math.sin(2 * Math.PI * 0.75 * t)         // its 3rd harmonic
         + 0.12 * Math.sin(2 * Math.PI * 1.15 * t);        // real heartbeat, 69 BPM
  }
  // Bandpass alone is NOT enough: the 3rd harmonic is 2.5x stronger than
  // the heartbeat and sits inside the cardiac band, so it dominates the
  // correlation and no genuine cardiac peak forms.
  const bandOnly = Biquad.bandpass(fs, 0.67, 2.0).run(x);
  const naive = bpmAutocorr(bandOnly, fs, 40, 120);
  assert.ok(
    Math.abs(naive.bpm - 69) > 8,
    'baseline unexpectedly succeeded — the test signal no longer poses the problem',
  );

  // The working chain: notch out breathing and its harmonics FIRST.
  const notched = notchHarmonics(x, fs, 0.25, 4, 10);
  const band = Biquad.bandpass(fs, 0.67, 2.0).run(notched);
  const result = bpmAutocorr(band, fs, 40, 120, 0.25, 0.06);

  assert.ok(
    Math.abs(result.bpm - 69) < 6,
    `expected ~69 BPM after harmonic removal, got ${result.bpm.toFixed(1)}`,
  );
  assert.ok(
    Math.abs(result.bpm - 45) > 5,
    'estimator locked onto the breathing 3rd harmonic (45 BPM)',
  );
});

test('notchHarmonics removes a fundamental and leaves nearby content', () => {
  const fs = 20;
  const n = fs * 30;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    x[i] = 1.0 * Math.sin(2 * Math.PI * 0.75 * t)     // to be removed
         + 1.0 * Math.sin(2 * Math.PI * 1.15 * t);    // must survive
  }
  const out = notchHarmonics(x, fs, 0.75, 1, 10).slice(100);

  const { power: p075 } = dominantFrequency(out, fs, 0.70, 0.80);
  const { power: p115 } = dominantFrequency(out, fs, 1.10, 1.20);
  assert.ok(p115 > p075 * 10, `notch failed: 0.75Hz=${p075} 1.15Hz=${p115}`);
});

test('bandpass filter attenuates out-of-band energy', () => {
  const fs = 20;
  const inBand = sine(0.25, fs, 20);
  const outBand = sine(3.0, fs, 20);

  const f = () => Biquad.bandpass(fs, 0.1, 0.5);
  const passed = f().run(inBand);
  const blocked = f().run(outBand);

  const pv = variance(passed.slice(50));
  const bv = variance(blocked.slice(50));
  assert.ok(pv > bv * 20, `passband ${pv.toFixed(4)} vs stopband ${bv.toFixed(4)}`);
});

test('hampel removes spikes without eating the signal', () => {
  const x = Float64Array.from(sine(0.25, 20, 10));
  const clean = Float64Array.from(x);
  x[50] = 40;    // AGC spike
  x[120] = -35;

  const filtered = hampel(x, 3, 3);
  assert.ok(Math.abs(filtered[50]) < 2, `spike survived: ${filtered[50]}`);
  assert.ok(Math.abs(filtered[120]) < 2, `spike survived: ${filtered[120]}`);

  // Untouched samples must stay untouched.
  assert.ok(Math.abs(filtered[80] - clean[80]) < 1e-9);
});

test('phase unwrapping removes 2pi discontinuities', () => {
  const wrapped = [3.0, 3.1, -3.1, -3.0, -2.9];
  const un = unwrapPhase(wrapped);
  for (let i = 1; i < un.length; i++) {
    assert.ok(Math.abs(un[i] - un[i - 1]) < 1, `jump at ${i}: ${un[i - 1]} -> ${un[i]}`);
  }
});

test('sanitizePhase removes the linear STO ramp', () => {
  // A hardware phase ramp plus a small body-motion perturbation.
  const n = 56;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = 0.11 * i + 0.4 + 0.05 * Math.sin(i * 0.7);
    raw[i] = Math.atan2(Math.sin(p), Math.cos(p));
  }
  const clean = sanitizePhase(raw);

  // The ramp is gone: the result has near-zero mean and no net slope.
  assert.ok(Math.abs(mean(clean)) < 1e-6, `residual offset ${mean(clean)}`);
  const firstHalf = mean(clean.slice(0, n / 2));
  const secondHalf = mean(clean.slice(n / 2));
  assert.ok(Math.abs(firstHalf - secondHalf) < 0.2, 'residual slope remains');

  // The perturbation survives.
  assert.ok(variance(clean) > 1e-4, 'sanitisation destroyed the signal');
});

test('dominantFrequency finds the right peak', () => {
  const x = sine(0.3, 20, 30);
  const { freq } = dominantFrequency(x, 20, 0.05, 2);
  assert.ok(Math.abs(freq - 0.3) < 0.03, `got ${freq}`);
});

test('circularVariance: coherent is 0, uniform approaches 1', () => {
  const coherent = new Float64Array(32).fill(1.2);
  assert.ok(circularVariance(coherent) < 1e-9);

  const uniform = new Float64Array(360);
  for (let i = 0; i < 360; i++) uniform[i] = (i / 360) * 2 * Math.PI;
  assert.ok(circularVariance(uniform) > 0.99);
});

test('Ring returns samples oldest-to-newest after wrapping', () => {
  const r = new Ring(4);
  for (const v of [1, 2, 3, 4, 5, 6]) r.push(v);
  assert.deepEqual(Array.from(r.toArray()), [3, 4, 5, 6]);
  assert.equal(r.last(), 6);
});

test('zero-crossing BPM works on a clean signal but is not used for HR', () => {
  const x = sine(0.25, 20, 40);
  const bpm = bpmZeroCrossing(x, 20);
  assert.ok(Math.abs(bpm - 15) < 1, `got ${bpm}`);
});

test('CSI packet round-trips through encode/decode', () => {
  const n = 56;
  const amplitude = new Float64Array(n);
  const phase = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    amplitude[i] = 20 + 5 * Math.sin(i * 0.2);
    phase[i] = Math.sin(i * 0.3);
  }

  const buf = encodeCsi({
    nodeId: 3, nSubcarriers: n, amplitude, phase,
    rssi: -57, sequence: 42, rateHz: 20, timestampMs: 1234, flags: 1 << 5,
  });

  assert.equal(buf.readUInt32LE(0), MAGIC.CSI);

  const decoded = decodePacket(buf);
  assert.equal(decoded.kind, 'csi');
  assert.equal(decoded.nodeId, 3);
  assert.equal(decoded.nSubcarriers, n);
  assert.equal(decoded.rssi, -57);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.flags.mock, true);

  // int8 quantisation means we check closeness, not equality.
  assert.ok(Math.abs(decoded.amplitude[10] - amplitude[10]) < 2);
});

test('decodePacket rejects garbage without throwing', () => {
  assert.equal(decodePacket(Buffer.alloc(0)), null);
  assert.equal(decodePacket(Buffer.from([1, 2, 3])), null);
  assert.equal(decodePacket(Buffer.alloc(64)), null);          // zero magic
  assert.equal(decodePacket(Buffer.from('random udp junk')), null);
});
