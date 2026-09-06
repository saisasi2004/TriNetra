/**
 * Floor plan planner — page wiring.
 *
 * Talks to /api/v1/floorplan*, drives the canvas editor, and renders the
 * properties panel and the validation checks.
 *
 * Validation runs CLIENT-SIDE using the same ../lib/plan.js the server
 * validates with, so problems appear as you draw rather than as a rejection
 * after you press save. The server still validates independently — a browser
 * check is a convenience, never a guarantee, and this plan goes on to resize
 * the sensing field.
 */

import { PlanEditor } from './editor.js';
import {
  validatePlan, planSizeMetres, blankPlan, ROOM_TYPES, formatDim,
} from '../lib/plan.js';

const $ = (id) => document.getElementById(id);

/** Bearer token, if the server was started with TRINETRA_TOKEN. */
const TOKEN = new URLSearchParams(location.search).get('token');

const state = {
  plan: null,
  builtin: false,
  activeId: null,
  roomFromPlan: true,
  dirty: false,
};

const editor = new PlanEditor($('plan-canvas'), blankPlan());

// ── API ────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`/api/v1${path}`, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const err = new Error(data.error ?? `request failed (${res.status})`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

async function refreshList() {
  const { plans, active } = await api('/floorplans');
  state.activeId = active;

  const sel = $('plan-select');
  sel.innerHTML = plans.map((p) => {
    const marks = [p.builtin ? 'built-in' : null, p.active ? 'active' : null]
      .filter(Boolean).join(', ');
    return `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}${marks ? ` — ${marks}` : ''}</option>`;
  }).join('');

  sel.value = state.plan?.id ?? active;
}

async function openPlan(id) {
  const { plan, builtin } = await api(`/floorplans/${encodeURIComponent(id)}`);
  adopt(plan, builtin);
}

function adopt(plan, builtin) {
  state.plan = plan;
  state.builtin = !!builtin;

  editor.setPlan(plan);
  editor.setReadOnly(state.builtin);

  // Cleared AFTER the editor is loaded, not before. setPlan emits `change`
  // synchronously, so clearing the flag first meant every freshly opened plan
  // was immediately marked UNSAVED — which trains you to ignore the one
  // indicator that tells you whether your drawing is safe.
  state.dirty = false;

  $('f-name').value = plan.name;
  $('f-units').value = plan.units ?? 'ft';
  $('f-wall').value = plan.wall_height_m ?? 3.05;

  $('readonly-note').hidden = !state.builtin;
  showInSelect(plan);

  renderAll();
}

/**
 * Point the plan dropdown at this plan, adding a placeholder entry when it is
 * not saved yet.
 *
 * A duplicate exists only in the browser until it is saved, so it has no row
 * in the server's list — and setting a <select> to a value it has no option
 * for leaves it blank. The control then reads as "no plan open" at exactly
 * the moment the user has just made one.
 */
function showInSelect(plan) {
  const sel = $('plan-select');
  if (!Array.from(sel.options).some((o) => o.value === plan.id)) {
    const opt = document.createElement('option');
    opt.value = plan.id;
    opt.textContent = `${plan.name} — unsaved`;
    sel.append(opt);
  }
  sel.value = plan.id;
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderAll() {
  renderBadge();
  renderStats();
  renderProps();
  renderIssues();
}

function renderBadge() {
  const badge = $('plan-badge');
  const bits = [];
  if (state.builtin) bits.push('BUILT-IN');
  if (state.plan?.id === state.activeId) bits.push('ACTIVE');
  if (state.dirty) bits.push('UNSAVED');
  badge.textContent = bits.join(' · ');
  badge.className = `badge${state.dirty ? ' warn' : ''}`;
}

function renderStats() {
  const p = state.plan;
  if (!p) return;
  const size = planSizeMetres(p);

  $('plan-stats').innerHTML = `
    <dt>Footprint</dt><dd>${size.width.toFixed(2)} × ${size.depth.toFixed(2)} m</dd>
    <dt>Rooms</dt><dd>${p.rooms.length}</dd>
    <dt>Doorways</dt><dd>${p.doors.length}</dd>
    <dt>Nodes</dt><dd>${p.nodes.length}</dd>
  `;

  $('st-size').textContent = `${size.width.toFixed(2)} × ${size.depth.toFixed(2)} m`;
}

function renderProps() {
  const title = $('props-title');
  const body = $('props-body');
  const sel = editor.selection;

  if (!sel || state.builtin) {
    title.textContent = state.builtin ? 'Read-only' : 'Nothing selected';
    body.className = 'props-empty';
    body.innerHTML = state.builtin
      ? 'Duplicate this plan to edit its rooms, doorways and node positions.'
      : 'Click a room, doorway or node to edit it. Draw a new room with <b>R</b>, ' +
        'add a doorway with <b>D</b>, place a node with <b>N</b>.';
    return;
  }

  body.className = '';

  if (sel.kind === 'room') return renderRoomProps(title, body);
  if (sel.kind === 'door') return renderDoorProps(title, body);
  if (sel.kind === 'node') return renderNodeProps(title, body);
}

function renderRoomProps(title, body) {
  const r = editor.selectedRoom;
  if (!r) return;
  title.textContent = 'Room';

  body.innerHTML = `
    <label class="field"><span>Label</span>
      <input type="text" id="p-label" maxlength="40" value="${escapeAttr(r.label)}"></label>
    <label class="field"><span>Type</span>
      <select id="p-type">${ROOM_TYPES.map((t) =>
        `<option value="${t}"${t === (r.type ?? 'room') ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <div class="row">
      <label class="field"><span>x0</span><input type="number" id="p-x0" step="0.25" value="${r.x0}"></label>
      <label class="field"><span>z0</span><input type="number" id="p-z0" step="0.25" value="${r.z0}"></label>
    </div>
    <div class="row">
      <label class="field"><span>x1</span><input type="number" id="p-x1" step="0.25" value="${r.x1}"></label>
      <label class="field"><span>z1</span><input type="number" id="p-z1" step="0.25" value="${r.z1}"></label>
    </div>
    <p class="hint">Size ${escapeHtml(formatDim(state.plan, r))}</p>
    <button class="btn danger wide" id="p-delete"><i class="bx bx-trash"></i> Delete room</button>
  `;

  bind('p-label', 'input', (el) => editor.renameRoom(r, el.value));
  bind('p-type', 'change', (el) => { r.type = el.value; editor.commit(); });
  for (const k of ['x0', 'z0', 'x1', 'z1']) {
    bind(`p-${k}`, 'change', (el) => {
      const v = Number(el.value);
      if (Number.isFinite(v)) { r[k] = v; editor.commit({ structural: true }); }
    });
  }
  bind('p-delete', 'click', () => editor.deleteSelection());
}

function renderDoorProps(title, body) {
  const d = editor.selectedDoor;
  if (!d) return;
  title.textContent = 'Doorway';

  body.innerHTML = `
    <div class="row">
      <label class="field"><span>Width</span>
        <input type="number" id="p-w" step="0.25" min="0.5" value="${d.w}"></label>
      <label class="field"><span>Wall</span>
        <input type="text" value="${d.dir === 'h' ? 'horizontal' : 'vertical'}" disabled></label>
    </div>
    <div class="row">
      <label class="field"><span>x</span><input type="number" id="p-dx" step="0.25" value="${d.x}"></label>
      <label class="field"><span>z</span><input type="number" id="p-dz" step="0.25" value="${d.z}"></label>
    </div>
    <p class="hint">
      One opening serves both sides: every wall passing through it is broken,
      so the rooms either side open together.
    </p>
    <button class="btn danger wide" id="p-delete"><i class="bx bx-trash"></i> Delete doorway</button>
  `;

  bind('p-w', 'change', (el) => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) { d.w = v; editor.commit({ structural: true }); }
  });
  bind('p-dx', 'change', (el) => { d.x = Number(el.value) || 0; editor.commit({ structural: true }); });
  bind('p-dz', 'change', (el) => { d.z = Number(el.value) || 0; editor.commit({ structural: true }); });
  bind('p-delete', 'click', () => editor.deleteSelection());
}

function renderNodeProps(title, body) {
  const n = editor.selectedNode;
  if (!n) return;
  title.textContent = `Node ${n.node_id}`;
  const room = editor.roomOf(n);

  body.innerHTML = `
    <label class="field"><span>Node ID</span>
      <input type="number" id="p-nid" min="1" max="254" step="1" value="${n.node_id}"></label>
    <div class="row">
      <label class="field"><span>x</span><input type="number" id="p-nx" step="0.25" value="${n.x}"></label>
      <label class="field"><span>z</span><input type="number" id="p-nz" step="0.25" value="${n.z}"></label>
    </div>
    <label class="field"><span>Mount height (m)</span>
      <input type="number" id="p-nh" step="0.05" min="0" max="10" value="${n.height_m ?? 1.2}"></label>
    <p class="hint">In ${room ? `<b>${escapeHtml(room.label)}</b>` : '<b>no room</b>'}.
      This must match where the board physically hangs — the field
      multilaterates against known positions, so a guessed layout produces a
      plausible-looking field that is wrong everywhere.</p>
    <button class="btn danger wide" id="p-delete"><i class="bx bx-trash"></i> Remove node</button>
  `;

  bind('p-nid', 'change', (el) => {
    const v = parseInt(el.value, 10);
    if (!Number.isInteger(v) || v < 1 || v > 254) return;
    // The id is the selection key, so it has to be re-selected after a change
    // or the panel would keep editing a node that no longer answers to it.
    n.node_id = v;
    editor.select('node', v);
    editor.commit({ structural: true });
  });
  bind('p-nx', 'change', (el) => { n.x = Number(el.value) || 0; editor.commit({ structural: true }); });
  bind('p-nz', 'change', (el) => { n.z = Number(el.value) || 0; editor.commit({ structural: true }); });
  bind('p-nh', 'change', (el) => { n.height_m = Number(el.value) || 1.2; editor.commit(); });
  bind('p-delete', 'click', () => editor.deleteSelection());
}

/**
 * Validation, shown continuously rather than on save.
 *
 * Errors block saving. Warnings do not: a door that lines up with no wall or
 * a plan with fewer than three nodes is a legitimate work-in-progress, and
 * refusing to save it would mean losing an afternoon's drawing because one
 * doorway is not finished yet.
 */
function renderIssues() {
  if (!state.plan) return;
  const { ok, errors, warnings } = validatePlan(state.plan);

  const el = $('issues');
  if (ok && warnings.length === 0) {
    el.innerHTML = '<div class="issue good"><i class="bx bx-check"></i> No problems found</div>';
  } else {
    el.innerHTML = [
      ...errors.map((e) => `<div class="issue err"><i class="bx bx-x-circle"></i>${escapeHtml(e)}</div>`),
      ...warnings.map((w) => `<div class="issue warn"><i class="bx bx-error"></i>${escapeHtml(w)}</div>`),
    ].join('');
  }

  $('btn-save').disabled = !ok || state.builtin;
}

// ── Actions ────────────────────────────────────────────────────────────

async function save() {
  if (state.builtin) return toast('Built-in plans are read-only — duplicate first.', 'warn');

  state.plan.name = $('f-name').value.trim() || state.plan.name;
  state.plan.units = $('f-units').value;
  state.plan.wall_height_m = Number($('f-wall').value) || 3.05;

  try {
    const res = await api('/floorplan', {
      method: 'POST',
      body: JSON.stringify({ plan: state.plan, activate: true }),
    });

    state.dirty = false;
    state.activeId = res.active;
    await refreshList();
    renderAll();

    const room = res.room;
    toast(
      `Saved and activated. Sensing room is now ${room.width} × ${room.depth} m.` +
      (res.warnings?.length ? ` ${res.warnings.length} warning(s).` : ''),
      'ok',
    );
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      toast(
        'Not authorised. Mutations are loopback-only unless TRINETRA_TOKEN is ' +
        'set — open this page from the server machine, or add ?token=…',
        'err',
      );
    } else {
      toast(err.detail?.errors?.join('; ') ?? err.message, 'err');
    }
  }
}

function duplicate() {
  const src = state.plan;
  const copy = structuredClone(src);
  copy.id = `${src.id.replace(/-copy\d*$/, '')}-copy${Math.floor(Math.random() * 900 + 100)}`;
  copy.name = `${src.name} (copy)`;
  adopt(copy, false);
  state.dirty = true;
  renderBadge();
  toast('Duplicated. Save to keep it.', 'ok');
}

async function createNew() {
  const { plan } = await api('/floorplans/new');
  adopt(plan, false);
  state.dirty = true;
  renderBadge();
}

async function remove() {
  if (state.builtin) return toast('Built-in plans cannot be deleted.', 'warn');
  if (!confirm(`Delete "${state.plan.name}"? This cannot be undone.`)) return;

  try {
    await api(`/floorplans/${encodeURIComponent(state.plan.id)}`, { method: 'DELETE' });
    await refreshList();
    await openPlan(state.activeId);
    toast('Plan deleted.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────

editor.addEventListener('change', (e) => {
  state.dirty = true;
  renderBadge();
  renderStats();
  renderIssues();
  if (e.detail?.structural) renderProps();
});

editor.addEventListener('select', () => renderProps());
editor.addEventListener('notice', (e) => toast(e.detail, 'warn'));
editor.addEventListener('tool', (e) => {
  for (const b of document.querySelectorAll('.tool[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === e.detail);
  }
});

editor.addEventListener('cursor', (e) => {
  const u = state.plan?.units === 'm' ? 'm' : 'ft';
  $('st-cursor').textContent = `${e.detail.x.toFixed(2)}, ${e.detail.z.toFixed(2)} ${u}`;
});

for (const b of document.querySelectorAll('.tool[data-tool]')) {
  b.addEventListener('click', () => editor.setTool(b.dataset.tool));
}

$('btn-fit').addEventListener('click', () => editor.fit());
$('btn-save').addEventListener('click', save);
$('btn-duplicate').addEventListener('click', duplicate);
$('btn-dup-inline').addEventListener('click', duplicate);
$('btn-new').addEventListener('click', createNew);
$('btn-delete').addEventListener('click', remove);

$('plan-select').addEventListener('change', async (e) => {
  if (state.dirty && !confirm('Discard unsaved changes?')) {
    e.target.value = state.plan.id;
    return;
  }
  await openPlan(e.target.value);
});

$('f-name').addEventListener('input', () => {
  state.plan.name = $('f-name').value;
  state.dirty = true;
  renderBadge();
});
$('f-units').addEventListener('change', () => {
  // Units are a LABEL on the existing numbers, not a conversion. Rescaling
  // the geometry on a unit change would silently turn a 26-foot flat into a
  // 26-metre one; saying what the numbers mean is the honest operation.
  state.plan.units = $('f-units').value;
  state.dirty = true;
  editor.commit({ structural: true });
});
$('f-wall').addEventListener('change', () => {
  state.plan.wall_height_m = Number($('f-wall').value) || 3.05;
  state.dirty = true;
  renderStats();
});

$('opt-snap').addEventListener('change', (e) => { editor.snapEnabled = e.target.checked; });
$('opt-snap-size').addEventListener('change', (e) => { editor.snap = Number(e.target.value); });

window.addEventListener('keydown', (ev) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;

  const TOOLS = { v: 'select', r: 'room', d: 'door', n: 'node' };
  const key = ev.key.toLowerCase();

  if (TOOLS[key]) { editor.setTool(TOOLS[key]); return; }
  if (key === 'f') { editor.fit(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    editor.deleteSelection();
    return;
  }
  if (ev.key === 'Escape') editor.select(null);
  if (key === 's' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
});

// Leaving with unsaved work is nearly always a mistake, and a floor plan is
// twenty minutes of fiddly drawing.
window.addEventListener('beforeunload', (ev) => {
  if (!state.dirty) return;
  ev.preventDefault();
  ev.returnValue = '';
});

// ── Helpers ────────────────────────────────────────────────────────────

function bind(id, event, fn) {
  const el = $(id);
  if (el) el.addEventListener(event, () => fn(el));
}

let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const escapeAttr = escapeHtml;

// ── Boot ───────────────────────────────────────────────────────────────

(async function boot() {
  try {
    const { plan, builtin, room_from_plan: fromPlan } = await api('/floorplan');
    state.roomFromPlan = fromPlan;
    await refreshList();
    adopt(plan, builtin);

    if (!fromPlan) {
      toast(
        'The server was started with --room-size, so this plan supplies zones ' +
        'and node positions but not the room footprint.',
        'warn',
      );
    }
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, 'err');
    adopt(blankPlan(), false);
  }
})();
