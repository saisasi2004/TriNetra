/**
 * Dashboard — tabular and time-series view of the same live stream.
 *
 * The Observatory answers "what is happening in the room". This answers
 * "what exactly is each node reporting, and how much should I trust it".
 */

import { TriNetraClient, fmt } from '../lib/client.js';

const $ = (id) => document.getElementById(id);

const client = new TriNetraClient();

const history = {
  hr: [], br: [], motion: [], people: [],
  maxPoints: 300,   // 5 min at 1 Hz
};
let lastHistoryAt = 0;
const events = [];

// ── Charts ────────────────────────────────────────────────────────────

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  return { ctx: canvas.getContext('2d'), dpr, w: canvas.width, h: canvas.height };
}

/**
 * Line series with GAPS where the value is null.
 *
 * The gaps are load-bearing: vitals are suppressed rather than guessed
 * while a subject moves, and drawing a straight line across that would
 * imply continuous measurement where there was none.
 */
function drawSeries(ctx, data, { w, h, dpr, min, max, colour, width = 1.6 }) {
  if (data.length < 2) return;
  const span = Math.max(1e-6, max - min);

  ctx.strokeStyle = colour;
  ctx.lineWidth = width * dpr;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  let drawing = false;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v == null) { drawing = false; continue; }
    const x = (i / (history.maxPoints - 1)) * w;
    const y = h - ((v - min) / span) * (h * 0.82) - h * 0.09;
    if (!drawing) { ctx.moveTo(x, y); drawing = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawGrid(ctx, w, h, dpr, labels) {
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1 * dpr;
  ctx.font = `${9 * dpr}px JetBrains Mono, monospace`;
  ctx.fillStyle = 'rgba(232,236,224,0.3)';

  for (let i = 0; i <= 4; i++) {
    const y = h * 0.09 + (i / 4) * h * 0.82;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    if (labels?.[i] != null) ctx.fillText(String(labels[i]), 3 * dpr, y - 3 * dpr);
  }
}

function renderVitalsChart() {
  const canvas = $('chart-vitals');
  const { ctx, dpr, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h, dpr, [130, 100, 70, 40, 10]);
  drawSeries(ctx, history.hr, { w, h, dpr, min: 10, max: 130, colour: '#ff4060' });
  drawSeries(ctx, history.br, { w, h, dpr, min: 10, max: 130, colour: '#2090ff' });
}

function renderMotionChart() {
  const canvas = $('chart-motion');
  const { ctx, dpr, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h, dpr, ['100%', '75%', '50%', '25%', '0']);
  drawSeries(ctx, history.motion.map((v) => (v == null ? null : v * 100)),
             { w, h, dpr, min: 0, max: 100, colour: '#00d878' });
  drawSeries(ctx, history.people.map((v) => (v == null ? null : v * 12.5)),
             { w, h, dpr, min: 0, max: 100, colour: '#ffb020', width: 1.2 });
}

/** 2D top-down field with nodes and people overlaid. */
function renderField(update) {
  const canvas = $('field-canvas');
  const { ctx, dpr, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const sf = update.signal_field;
  if (!sf) return;

  const [gx, , gz] = sf.grid_size;
  const [roomW, , roomD] = sf.room;
  const values = sf.values;

  const cw = w / gx;
  const ch = h / gz;

  for (let z = 0; z < gz; z++) {
    for (let x = 0; x < gx; x++) {
      const v = values[z * gx + x] ?? 0;
      const t = Math.max(0, Math.min(1, v));
      // Same ramp family as the 3D view so the two read as one system.
      const r = Math.round(10 + t * t * 150);
      const g = Math.round(25 + t * 195);
      const b = Math.round(30 + t * 90);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x * cw, z * ch, cw + 1, ch + 1);
    }
  }

  const toPx = (mx, mz) => [
    (mx / roomW + 0.5) * w,
    (mz / roomD + 0.5) * h,
  ];

  // Nodes
  for (const n of update.nodes ?? []) {
    const [px, py] = toPx(n.position[0], n.position[2]);
    ctx.beginPath();
    ctx.arc(px, py, 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = !n.online ? '#555' : n.presence ? '#3eff8a' : '#0a6b3a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();

    ctx.font = `${9 * dpr}px JetBrains Mono, monospace`;
    ctx.fillStyle = 'rgba(232,236,224,0.6)';
    ctx.fillText(`N${n.node_id}`, px + 8 * dpr, py + 3 * dpr);
  }

  // People, with uncertainty discs
  for (const p of update.persons ?? []) {
    const [px, py] = toPx(p.position[0], p.position[2]);
    const rPx = (p.position_uncertainty_m / roomW) * w;

    ctx.beginPath();
    ctx.arc(px, py, rPx, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,176,32,0.09)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,176,32,0.45)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(px - 6 * dpr, py); ctx.lineTo(px + 6 * dpr, py);
    ctx.moveTo(px, py - 6 * dpr); ctx.lineTo(px, py + 6 * dpr);
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();

    ctx.font = `${9 * dpr}px JetBrains Mono, monospace`;
    ctx.fillStyle = '#ffb020';
    ctx.fillText(`#${p.id}`, px + 9 * dpr, py - 8 * dpr);
  }

  $('badge-field').textContent = `${gx}×${gz} · ${roomW}×${roomD} m`;
}

// ── Rendering ─────────────────────────────────────────────────────────

function setPill(el, text, cls = '') {
  el.className = `pill ${cls}`;
  el.querySelector('span:last-child')
    ? (el.querySelector('span:last-child').textContent = text)
    : (el.textContent = text);
}

function renderSummary(u) {
  const present = u.classification.presence;
  const v = u.vital_signs ?? {};

  const pres = $('s-presence');
  pres.textContent = u.calibrating ? 'CALIB' : present ? 'YES' : 'NO';
  pres.className = `value ${present ? 'count' : 'dim'}`;
  $('s-presence-sub').textContent =
    `confidence ${Math.round((u.classification.confidence ?? 0) * 100)}%`;

  $('s-people').textContent = String(u.estimated_persons);
  $('s-count-method').textContent = (u.count_method ?? '').replace(/-/g, ' ');

  $('s-br').innerHTML = v.breathing_rate_bpm != null
    ? `${v.breathing_rate_bpm.toFixed(1)}<span class="unit">RPM</span>`
    : '--<span class="unit">RPM</span>';
  $('s-br-conf').textContent = v.breathing_rate_bpm != null
    ? `confidence ${Math.round(v.breathing_confidence * 100)}%`
    : 'suppressed';

  $('s-hr').innerHTML = v.heart_rate_bpm != null
    ? `${v.heart_rate_bpm.toFixed(1)}<span class="unit">BPM</span>`
    : '--<span class="unit">BPM</span>';
  $('s-hr-conf').textContent = v.heart_rate_bpm != null
    ? `confidence ${Math.round(v.heartbeat_confidence * 100)}%`
    : 'suppressed';

  $('s-posture').textContent = fmt.title(u.posture ?? '-');
  const motion = u.nodes.reduce((m, n) => Math.max(m, n.motion_energy ?? 0), 0);
  $('s-motion').textContent = `motion ${Math.round(motion * 100)}%`;

  $('s-quality').innerHTML =
    `${Math.round((u.signal_quality_score ?? 0) * 100)}<span class="unit">%</span>`;
  $('s-verdict').textContent = u.quality_verdict ?? '';

  $('s-nodes').textContent = `${u.nodes_online}/${u.node_count}`;
  $('s-uptime').textContent = `uptime ${fmt.duration(u.uptime_s)}`;

  $('badge-tick').textContent = `tick ${u.tick}`;
}

function renderNodes(u) {
  const rows = u.nodes.map((n) => {
    const status = !n.online ? '<span class="tag err">offline</span>'
      : n.calibrating ? '<span class="tag warn">calibrating</span>'
      : '<span class="tag on">online</span>';
    const presence = n.presence
      ? `<span class="tag on">${n.presence_reason}</span>`
      : '<span class="tag off">-</span>';
    return `<tr>
      <td>N${n.node_id}</td>
      <td>${status}</td>
      <td>${n.room ?? '-'}</td>
      <td>${n.position.map((p) => p.toFixed(1)).join(', ')}</td>
      <td>${n.rssi_dbm?.toFixed(0) ?? '-'}</td>
      <td>${n.sample_rate_hz?.toFixed(1) ?? '-'} Hz</td>
      <td>${n.subcarrier_count}</td>
      <td>${presence}</td>
      <td>${Math.round((n.motion_energy ?? 0) * 100)}%</td>
      <td>${n.breath_ratio?.toFixed(2) ?? '-'}×</td>
      <td>${n.posture}</td>
      <td>${n.vitals.breathing_rate_bpm ?? '-'}</td>
      <td>${n.vitals.heart_rate_bpm ?? '-'}</td>
      <td>${Math.round((n.signal_quality ?? 0) * 100)}%</td>
      <td>${n.frames}</td>
    </tr>`;
  });

  $('node-rows').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="15" class="empty">Waiting for nodes...</td></tr>';
  $('badge-nodes').textContent = `${u.nodes_online} online`;
}

function renderPeople(u) {
  const rows = (u.persons ?? []).map((p) => `<tr>
    <td>#${p.id}</td>
    <td>${p.position[0].toFixed(2)}, ${p.position[2].toFixed(2)}</td>
    <td>±${p.position_uncertainty_m} m</td>
    <td><span class="tag ${p.position_quality === 'good' ? 'on' : p.position_quality === 'coarse' ? 'warn' : 'off'}">${p.position_quality}</span></td>
    <td>${p.posture}</td>
    <td>${p.velocity_mps.toFixed(2)} m/s</td>
    <td>${p.motion_score}%</td>
    <td>${p.zone}</td>
    <td>${Math.round(p.confidence * 100)}%</td>
    <td>${fmt.duration(p.tracked_for_s)}</td>
  </tr>`);

  $('person-rows').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="10" class="empty">Nobody detected</td></tr>';
  $('badge-people').textContent = String(u.estimated_persons);
}

function renderStates(u) {
  const states = Object.values(u.semantic_states ?? {});
  const active = states.filter((s) => s.active);

  $('states-grid').innerHTML = states.map((s) => `
    <div class="state-card ${s.active ? 'active' : ''} ${s.severity}">
      <div class="name">${s.label}</div>
      <div class="meta">${s.active
        ? `${fmt.duration(s.duration_s) || 'just now'} · ${s.evidence}`
        : 'inactive'}</div>
    </div>`).join('');

  $('badge-states').textContent = `${active.length} active`;
}

function renderEvents() {
  const el = $('event-log');
  if (!events.length) {
    el.innerHTML = '<div class="empty">No events yet</div>';
    return;
  }
  el.innerHTML = events.slice(0, 60).map((e) => `
    <div class="event sev-${e.severity ?? 0}">
      <span class="time">${new Date(e.receivedAt ?? Date.now()).toLocaleTimeString()}</span>
      <span class="type">${fmt.title(e.type)} — node ${e.nodeId}</span>
      <span class="conf">${e.confidence != null ? `${Math.round(e.confidence * 100)}%` : ''}</span>
    </div>`).join('');
  $('badge-events').textContent = String(events.length);
}

function pushHistory(u) {
  const now = Date.now();
  if (now - lastHistoryAt < 1000) return;
  lastHistoryAt = now;

  const v = u.vital_signs ?? {};
  history.hr.push(v.heart_rate_bpm ?? null);
  history.br.push(v.breathing_rate_bpm ?? null);
  history.motion.push(u.nodes.reduce((m, n) => Math.max(m, n.motion_energy ?? 0), 0));
  history.people.push(u.estimated_persons ?? 0);

  for (const k of ['hr', 'br', 'motion', 'people']) {
    while (history[k].length > history.maxPoints) history[k].shift();
  }

  renderVitalsChart();
  renderMotionChart();
}

// ── Wiring ────────────────────────────────────────────────────────────

client.addEventListener('update', (e) => {
  const u = e.detail;

  const src = u.source ?? 'offline';
  const pill = $('pill-source');
  pill.className = `pill ${src === 'live' ? 'ok' : src === 'simulated' ? 'warn' : ''}`;
  pill.querySelector('.dot').className = `dot ${src === 'live' ? 'live' : ''}`;
  $('source-label').textContent = src;

  setPill($('pill-quality'), u.data_quality,
    u.data_quality === 'MEASURED' ? 'ok' : u.data_quality === 'SIMULATED' ? 'warn' : '');
  $('pill-latency').textContent = client.latencyMs != null ? `${client.latencyMs} ms` : '– ms';

  renderSummary(u);
  renderNodes(u);
  renderPeople(u);
  renderStates(u);
  renderField(u);
  pushHistory(u);
});

client.addEventListener('sensing-event', (e) => {
  events.unshift({ ...e.detail, receivedAt: Date.now() });
  if (events.length > 200) events.pop();
  renderEvents();
});

client.addEventListener('close', () => {
  setPill($('pill-source'), 'reconnecting', 'warn');
});

client.connect();

$('btn-calibrate').addEventListener('click', async () => {
  const btn = $('btn-calibrate');
  btn.disabled = true;
  btn.textContent = 'CALIBRATING...';
  try {
    await client.recalibrate();
  } catch (err) {
    alert(`Calibration failed: ${err.message}`);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'RECALIBRATE'; }, 4000);
});

window.addEventListener('resize', () => {
  renderVitalsChart();
  renderMotionChart();
  if (client.lastUpdate) renderField(client.lastUpdate);
});

// Load capabilities and honest limitations straight from the server, so the
// caveats can never drift out of sync with what the code actually does.
client.info().then((info) => {
  $('foot-info').textContent =
    `${info.mode} mode · room ${info.room.width}×${info.room.depth}×${info.room.height} m · ${info.tick_hz} Hz`;

  $('limits').innerHTML = Object.entries(info.limitations)
    .map(([k, v]) => `<dt>${fmt.title(k)}</dt><dd>${v}</dd>`)
    .join('');
}).catch(() => {
  $('limits').innerHTML = '<dt>Unavailable</dt><dd>Could not reach the server.</dd>';
});

// Backfill the event log on load so a refresh does not start from empty.
client.get('/events?limit=60').then((r) => {
  for (const ev of r.events ?? []) {
    events.push({ ...ev, receivedAt: ev.at ?? Date.now() });
  }
  renderEvents();
}).catch(() => {});
