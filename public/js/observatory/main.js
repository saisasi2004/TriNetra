/**
 * Observatory entry point — wires the client, the 3D scene, the HUD and
 * the settings drawer together.
 */

import { TriNetraClient } from '../lib/client.js';
import { ObservatoryScene } from './scene.js';
import { Hud } from './hud.js';

const $ = (id) => document.getElementById(id);

// Bump this whenever the scene defaults change meaningfully. Without it,
// settings saved against the old renderer silently override the new
// defaults and the room comes back looking like the version you replaced.
const SETTINGS_VERSION = 6;
const SETTINGS_KEY = `trinetra.observatory.settings.v${SETTINGS_VERSION}`;

function loadSettings() {
  try {
    // Drop stale versions rather than leaving them to accumulate.
    for (let v = 1; v < SETTINGS_VERSION; v++) {
      localStorage.removeItem(`trinetra.observatory.settings.v${v}`);
    }
    localStorage.removeItem('trinetra.observatory.settings');
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveSettings(opts) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(opts)); } catch { /* private mode */ }
}

const scene = new ObservatoryScene($('scene-canvas'), loadSettings());
const hud = new Hud();
const client = new TriNetraClient();

let lastWaveAt = 0;
let activePlanId = null;

/**
 * Load whichever plan the server currently has active.
 *
 * The scene falls back to the built-in flat so the view is never blank, but
 * the server is the authority: it is the one that scaled the sensing field
 * and placed the zones, and a browser drawing a different layout than the
 * one the field was built for is the single most misleading state this UI
 * can be in.
 */
async function loadActivePlan() {
  try {
    const res = await fetch('/api/v1/floorplan');
    if (!res.ok) return;
    const { plan } = await res.json();
    if (plan) {
      activePlanId = plan.id;
      scene.setPlan(plan);
    }
  } catch {
    // Offline or an older server: keep the built-in default rather than
    // showing nothing.
  }
}

loadActivePlan();

// ── Client wiring ─────────────────────────────────────────────────────

client.addEventListener('open', () => {
  hud.setConnection('connected', client.latencyMs);
  $('loading')?.classList.add('hidden');
});

client.addEventListener('close', () => hud.setConnection('reconnecting', null));
client.addEventListener('error', () => hud.setConnection('error', null));

client.addEventListener('update', (e) => {
  const payload = e.detail;

  // Someone may have activated a different plan in the planner while this
  // page was open. The payload names the active plan every tick, so a change
  // is picked up without a reload.
  if (payload.floorplan?.id && payload.floorplan.id !== activePlanId) {
    activePlanId = payload.floorplan.id;
    loadActivePlan();
  }

  scene.update(payload);
  hud.update(payload);
  hud.setConnection('connected', client.latencyMs);

  // Pulse a wave ring from each present node, at a rate the eye can follow
  // rather than once per 10 Hz tick.
  const now = performance.now();
  if (now - lastWaveAt > 900) {
    lastWaveAt = now;
    for (const n of payload.nodes) {
      if (n.online && n.presence) {
        scene.emitWave(n.position[0], n.position[2], 0x00d878);
      }
    }
  }
});

client.addEventListener('sensing-event', (e) => {
  const ev = e.detail;
  const labels = {
    fall: 'FALL DETECTED',
    apnea: 'APNEA SUSPECTED',
    presence_on: 'PRESENCE DETECTED',
    presence_off: 'ROOM CLEAR',
    intrusion: 'INTRUSION',
    calibration_done: 'CALIBRATION COMPLETE',
  };
  if (ev.severity >= 1 || ev.type === 'fall') {
    hud.showAlert(labels[ev.type] ?? ev.type.toUpperCase());
  }
});

client.connect();

// ── Scenario catalogue ────────────────────────────────────────────────

async function refreshScenarios() {
  try {
    const sim = await client.simulator();
    if (!sim.running) {
      $('scenario-pill').style.display = 'none';
      return;
    }
    hud.setScenarios(sim.scenarios ?? [], sim.auto_cycle ? 'auto' : sim.scenario);
  } catch {
    $('scenario-pill').style.display = 'none';
  }
}
refreshScenarios();

// Keep the picker in step when the server auto-cycles.
setInterval(async () => {
  try {
    const sim = await client.simulator();
    if (sim.running && !sim.auto_cycle) hud.setScenarioValue(sim.scenario);
  } catch { /* server may be restarting */ }
}, 5000);

async function changeScenario(value) {
  try {
    await client.setScenario(value);
    hud.setScenarioValue(value);
  } catch (err) {
    hud.showAlert(`SCENARIO CHANGE FAILED: ${err.message}`, 4000);
  }
}

$('scenario-select')?.addEventListener('change', (e) => changeScenario(e.target.value));
$('opt-scenario')?.addEventListener('change', (e) => changeScenario(e.target.value));

// ── Settings drawer ───────────────────────────────────────────────────

const drawer = $('settings');
const toggleDrawer = (open) => drawer.classList.toggle('open', open);

$('btn-settings').addEventListener('click', () => toggleDrawer(!drawer.classList.contains('open')));
$('btn-close-settings').addEventListener('click', () => toggleDrawer(false));

/** Bind one control to a scene option, with an optional live value readout. */
function bind(id, key, { type = 'range', valueId = null, transform = Number } = {}) {
  const el = $(id);
  if (!el) return;

  const initial = scene.opts[key];
  if (type === 'checkbox') el.checked = !!initial;
  else el.value = initial;

  const readout = valueId ? $(valueId) : null;
  const apply = () => {
    const v = type === 'checkbox' ? el.checked : transform(el.value);
    scene.opts[key] = v;
    if (readout) readout.textContent = typeof v === 'number' ? v.toFixed(2) : v;
    saveSettings(scene.opts);
  };
  el.addEventListener('input', apply);
  apply();
}

bind('opt-orbit', 'orbit', { type: 'checkbox' });
bind('opt-orbit-speed', 'orbitSpeed', { valueId: 'v-orbit-speed' });
bind('opt-fov', 'fov', { valueId: 'v-fov' });
bind('opt-plan', 'planView', { type: 'checkbox' });
bind('opt-room', 'showRoom', { type: 'checkbox' });
bind('opt-labels', 'showLabels', { type: 'checkbox' });
bind('opt-wall-h', 'wallHeight', { valueId: 'v-wall-h' });
bind('opt-shadows', 'shadows', { type: 'checkbox' });
bind('opt-light', 'lightLevel', { valueId: 'v-light' });
bind('opt-nodes', 'showNodes', { type: 'checkbox' });
bind('opt-waves', 'waves', { valueId: 'v-waves' });
bind('opt-field', 'fieldOpacity', { valueId: 'v-field' });
bind('opt-field-h', 'fieldHeight', { valueId: 'v-field-h' });
bind('opt-skeleton', 'showSkeleton', { type: 'checkbox' });
bind('opt-body', 'showBody', { type: 'checkbox' });
bind('opt-trails', 'showTrails', { type: 'checkbox' });
bind('opt-uncertainty', 'showUncertainty', { type: 'checkbox' });
bind('opt-bone', 'boneThickness', { valueId: 'v-bone' });
bind('opt-joint', 'jointSize', { valueId: 'v-joint' });
bind('opt-wire-color', 'wireColor', { transform: String });
bind('opt-joint-color', 'jointColor', { transform: String });
bind('opt-ramp', 'ramp', { transform: String });

// FOV needs a projection-matrix rebuild, not just an option write.
$('opt-fov').addEventListener('input', () => scene.resize());

// Dragging the view turns auto-orbit off; keep the checkbox honest about it.
scene.onOrbitDisabled = () => { $('opt-orbit').checked = false; };

$('btn-reset-view').addEventListener('click', () => {
  scene.resetView();
  $('opt-orbit').checked = true;
});

$('btn-calibrate').addEventListener('click', async () => {
  try {
    await client.recalibrate();
    hud.showAlert('CALIBRATING — LEAVE THE SPACE EMPTY', 8000);
  } catch (err) {
    hud.showAlert(`CALIBRATION FAILED: ${err.message}`, 5000);
  }
});

// ── Keyboard ──────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;

  switch (e.key.toLowerCase()) {
    case 'a':
      scene.opts.orbit = !scene.opts.orbit;
      $('opt-orbit').checked = scene.opts.orbit;
      break;
    case 'f':
      scene.opts.fieldOpacity = scene.opts.fieldOpacity > 0.05 ? 0 : 0.55;
      $('opt-field').value = scene.opts.fieldOpacity;
      break;
    case 'k':
      scene.opts.showSkeleton = !scene.opts.showSkeleton;
      $('opt-skeleton').checked = scene.opts.showSkeleton;
      break;
    case 'w':
      scene.opts.showRoom = !scene.opts.showRoom;
      $('opt-room').checked = scene.opts.showRoom;
      break;
    case 'l':
      scene.opts.showLabels = !scene.opts.showLabels;
      $('opt-labels').checked = scene.opts.showLabels;
      break;
    case 'p':
      scene.opts.planView = !scene.opts.planView;
      $('opt-plan').checked = scene.opts.planView;
      break;
    case 'h':
      // Snap between model height and full height rather than nudging.
      scene.opts.wallHeight = scene.opts.wallHeight > 2 ? 1.15 : 3.05;
      $('opt-wall-h').value = scene.opts.wallHeight;
      $('v-wall-h').textContent = scene.opts.wallHeight.toFixed(2);
      break;
    case 's':
      toggleDrawer(!drawer.classList.contains('open'));
      break;
    case 'r':
      scene.resetView();
      break;
    case 'escape':
      toggleDrawer(false);
      break;
    case ' ':
      e.preventDefault();
      scene.setPaused(!scene.paused);
      break;
    default:
      break;
  }
  saveSettings(scene.opts);
});

// ── Frame loop ────────────────────────────────────────────────────────

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  hud.tick(dt);
  scene.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Pause rendering when the tab is hidden — a 3D scene running in a
// background tab is pure battery drain.
document.addEventListener('visibilitychange', () => {
  scene.setPaused(document.hidden);
});

// Fail visibly rather than sitting on the splash screen forever.
setTimeout(() => {
  const loading = $('loading');
  if (loading && !loading.classList.contains('hidden')) {
    loading.querySelector('.txt').textContent =
      client.connected ? 'WAITING FOR DATA' : 'CANNOT REACH SERVER';
    if (client.connected) loading.classList.add('hidden');
  }
}, 6000);




