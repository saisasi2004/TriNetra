/**
 * Wire-contract test.
 *
 * Connects over the real WebSocket and asserts that every field the browser
 * UI reads is actually present. This is the test that catches a renamed
 * server field silently blanking a HUD panel — the kind of break that unit
 * tests never see because both sides pass in isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fields read by public/js/observatory/hud.js and public/js/dashboard/main.js.
const REQUIRED_TOP = [
  'type', 'timestamp', 'tick', 'uptime_s', 'source', 'data_quality',
  'calibrating', 'nodes', 'node_count', 'nodes_online', 'features',
  'classification', 'signal_field', 'vital_signs', 'persons',
  'estimated_persons', 'count_method', 'pose_source', 'posture',
  'fall_detected', 'semantic_states', 'active_states',
  'signal_quality_score', 'quality_verdict',
];

const REQUIRED_NODE = [
  'node_id', 'online', 'room', 'rssi_dbm', 'position', 'amplitude',
  'subcarrier_count', 'sample_rate_hz', 'presence', 'presence_reason',
  'breath_ratio', 'motion_energy', 'motion_level', 'posture',
  'signal_quality', 'calibrating', 'calibration_remaining', 'mock',
  'frames', 'vitals',
];

const REQUIRED_VITALS = [
  'breathing_rate_bpm', 'heart_rate_bpm', 'breathing_confidence',
  'heartbeat_confidence', 'breathing_variability', 'apnea_seconds',
  'signal_quality',
];

const REQUIRED_FEATURES = [
  'mean_rssi', 'variance', 'motion_band_power', 'breathing_band_power',
  'dominant_freq_hz', 'change_points', 'spectral_power',
];

/**
 * Spawn the server as a real child process on ephemeral ports.
 *
 * Importing it in-process would work, but its listeners and interval timers
 * then keep the test runner alive forever. A child is also closer to how the
 * thing actually runs.
 */
async function startServer(t) {
  const port = 18000 + Math.floor(Math.random() * 900);

  const child = spawn(process.execPath, [
    path.join(ROOT, 'server', 'index.js'),
    '--simulate',
    '--http-port', String(port),
    '--udp-port', String(port + 1),
    '--log-level', 'error',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  t.after(() => child.kill());

  // Poll until READY, not merely until the socket answers. /health returns
  // 503 between listen() and the first engine tick, and treating that as
  // "started" makes every subsequent assertion a race.
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not become ready in time');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return port;
}

test('the WebSocket payload satisfies the UI contract', async (t) => {
  const port = await startServer(t);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sensing`);
  t.after(() => ws.close());

  await once(ws, 'open');

  const [raw] = await once(ws, 'message');
  const msg = JSON.parse(raw.toString());

  assert.equal(msg.type, 'sensing_update');

  for (const key of REQUIRED_TOP) {
    assert.ok(key in msg, `payload is missing "${key}" — a UI panel reads it`);
  }
  for (const key of REQUIRED_FEATURES) {
    assert.ok(key in msg.features, `features missing "${key}"`);
  }
  for (const key of REQUIRED_VITALS) {
    assert.ok(key in msg.vital_signs, `vital_signs missing "${key}"`);
  }

  assert.ok(Array.isArray(msg.nodes) && msg.nodes.length > 0, 'no nodes in payload');
  for (const key of REQUIRED_NODE) {
    assert.ok(key in msg.nodes[0], `node object missing "${key}"`);
  }
  for (const key of REQUIRED_VITALS) {
    assert.ok(key in msg.nodes[0].vitals, `node vitals missing "${key}"`);
  }

  // Signal field: the 3D view indexes values[z * gx + x].
  const sf = msg.signal_field;
  assert.ok(Array.isArray(sf.grid_size) && sf.grid_size.length === 3);
  assert.ok(Array.isArray(sf.room) && sf.room.length === 3);
  assert.equal(
    sf.values.length, sf.grid_size[0] * sf.grid_size[1] * sf.grid_size[2],
    'signal_field.values length does not match grid_size',
  );

  // Semantic states must each carry what the panels render.
  for (const [id, s] of Object.entries(msg.semantic_states)) {
    for (const key of ['id', 'label', 'active', 'severity', 'confidence', 'duration_s', 'evidence']) {
      assert.ok(key in s, `semantic state "${id}" missing "${key}"`);
    }
  }

  assert.equal(msg.classification.presence !== undefined, true);
  assert.ok('motion_level' in msg.classification);
  assert.ok('confidence' in msg.classification);
});

test('REST endpoints the UI calls all respond', async (t) => {
  const port = await startServer(t);
  const base = `http://127.0.0.1:${port}/api/v1`;

  for (const path of ['/info', '/health', '/status', '/simulator', '/nodes',
                      '/sensing/current', '/sensing/vitals', '/sensing/presence',
                      '/sensing/persons', '/sensing/semantic', '/events', '/metrics']) {
    const res = await fetch(base + path);
    assert.ok(res.ok, `GET ${path} returned ${res.status}`);
  }

  // The dashboard renders info.limitations verbatim; it must be present and
  // non-empty, or the honest-caveats card silently disappears.
  const info = await (await fetch(`${base}/info`)).json();
  assert.ok(Object.keys(info.limitations).length >= 3,
    'info.limitations must document what the system cannot do');

  // Mutations are loopback-only without a token; this test IS loopback.
  const cal = await fetch(`${base}/calibrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.ok(cal.ok, `POST /calibrate returned ${cal.status}`);
});
