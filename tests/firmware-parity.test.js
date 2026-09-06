/**
 * Firmware/server DSP parity.
 *
 * The README asserts that `main/dsp.c` and `server/dsp/filters.js` implement
 * the same algorithms and must be changed together. Nothing enforced it, and
 * they had drifted: the firmware was missing the absolute significance floor
 * and the edge-band rejection the server gained later, so on a marginal
 * window the node published a rate the server would have refused.
 *
 * A shared claim with no test is a comment, not a contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runParity } from '../firmware/trinetra-csi-node/tools/verify-dsp-parity.mjs';

test('firmware dsp.c and server filters.js agree on every case', () => {
  const results = runParity();
  assert.ok(results.length >= 8, 'parity suite lost its cases');

  const diverged = results.filter((r) => !r.agree);
  assert.equal(diverged.length, 0,
    'firmware and server DSP have drifted apart on: ' +
    diverged.map((r) => `${r.name} (fw ${r.firmware.toFixed(2)} vs srv ${r.server.toFixed(2)})`)
      .join('; '));
});

test('both implementations refuse a signal with no periodicity', () => {
  // DC has no period at all; neither side may invent one. Note this is a
  // weaker guarantee than it looks: bandpassed NOISE is narrowband and does
  // self-correlate above the 0.3 significance floor, so both correctly agree
  // on a number there. Rejecting that case is not the autocorrelator's job —
  // it is what the breathing-band evidence gate in vitals.js exists for.
  const dc = runParity().find((r) => r.name === 'DC only');
  assert.ok(dc, 'DC case missing');
  assert.equal(dc.firmware, 0, 'firmware invented a rate for a constant');
  assert.equal(dc.server, 0, 'server invented a rate for a constant');
});
