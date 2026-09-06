/**
 * Floor plan schema, geometry and store.
 *
 * The plan is not decoration: its footprint becomes the sensing room, its
 * rooms become zones and its node placements become node positions. So the
 * tests that matter here are the ones asserting that a drawing and the
 * sensing space it produces stay in agreement — and that a malformed plan is
 * refused before it can reach the field grid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  validatePlan, sanitizePlan, planSizeMetres, planZones, planNodePositions,
  toWorld, fromWorld, roomIdAt, formatDim, blankPlan, feetInches,
} from '../public/js/lib/plan.js';
import { DEFAULT_FLAT } from '../public/js/lib/plans/default-flat.js';
import { PlanStore } from '../server/store/plans.js';
import { SensingEngine } from '../server/pipeline/engine.js';

const QUIET = () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} });

function baseConfig(dir) {
  return {
    room: { width: 6, depth: 5, height: 2.7 },
    fieldGrid: [24, 1, 20],
    historyFrames: 256,
    nodeTimeoutMs: 5000,
    calibrationSeconds: 30,
    tickHz: 10,
    plans: { dir, active: 'default-flat' },
    roomExplicit: false,
  };
}

async function tempStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trinetra-plans-'));
  const config = baseConfig(dir);
  const store = new PlanStore(config, QUIET);
  await store.init();
  return { store, config, dir };
}

// ── Schema ─────────────────────────────────────────────────────────────

test('the built-in flat is a valid plan with no warnings', () => {
  const { ok, errors, warnings } = validatePlan(DEFAULT_FLAT);
  assert.ok(ok, `errors: ${errors.join('; ')}`);
  assert.deepEqual(warnings, [],
    'the plan every install starts from must not ship with warnings');
});

test('a NaN coordinate is refused rather than repaired', () => {
  // This is the case the guard exists for: a NaN reaching SignalField makes
  // every likelihood in the grid NaN, so the field never peaks again and
  // nothing anywhere reports an error.
  const bad = structuredClone(DEFAULT_FLAT);
  bad.rooms[0].x1 = NaN;

  const { ok, errors } = validatePlan(bad);
  assert.equal(ok, false);
  assert.match(errors.join(' '), /finite numbers/);
});

test('duplicate node ids are an error, not a warning', () => {
  // The server keys per-node state on the id, so two boards sharing one are
  // merged into a single NodeState — which corrupts its measured sample rate
  // and therefore every frequency derived from it.
  const plan = structuredClone(DEFAULT_FLAT);
  plan.nodes[1].node_id = 1;

  const { ok, errors } = validatePlan(plan);
  assert.equal(ok, false);
  assert.match(errors.join(' '), /used more than once/);
});

test('a door that lines up with no wall warns but does not block saving', () => {
  const plan = structuredClone(DEFAULT_FLAT);
  plan.doors.push({ id: 'nowhere', x: 200, z: 200, w: 3, dir: 'h' });

  const { ok, warnings } = validatePlan(plan);
  assert.ok(ok, 'an unfinished doorway must not cost the user their drawing');
  assert.match(warnings.join(' '), /opens nothing/);
});

test('sanitize strips unknown keys', () => {
  const dirty = {
    ...blankPlan('x', 'X'),
    evil: 'payload',
    rooms: [{ id: 'r', label: 'R', type: 'room', x0: 0, z0: 0, x1: 5, z1: 5, extra: 1 }],
  };
  const clean = sanitizePlan(dirty);
  assert.equal(clean.evil, undefined);
  assert.equal(clean.rooms[0].extra, undefined);
  assert.equal(clean.rooms[0].id, 'r');
});

// ── Geometry ───────────────────────────────────────────────────────────

test('plan coordinates and world metres round-trip exactly', () => {
  // The editor authors in feet from the top-left; the sensing pipeline works
  // in metres from the centre. If these two disagree, every tracked person
  // lands in the wrong room — so the conversion is defined once and its
  // inverse is asserted here.
  for (const [x, z] of [[0, 0], [11, 15], [26.4, 35.65], [7.6, 24.4]]) {
    const [wx, wz] = toWorld(DEFAULT_FLAT, x, z);
    const [bx, bz] = fromWorld(DEFAULT_FLAT, wx, wz);
    assert.ok(Math.abs(bx - x) < 1e-9, `x round-trip ${x} -> ${bx}`);
    assert.ok(Math.abs(bz - z) < 1e-9, `z round-trip ${z} -> ${bz}`);
  }
});

test('the plan is centred on the world origin', () => {
  // Tolerance is a millimetre, not a float epsilon: planSizeMetres rounds to
  // 3 decimals so the wire payload does not carry sixteen digits of noise,
  // while toWorld does not round. The residual is sub-millimetre, which is
  // three orders of magnitude below anything this system can localise to.
  const size = planSizeMetres(DEFAULT_FLAT);
  const [x0, z0] = toWorld(DEFAULT_FLAT, 0, 0);
  assert.ok(Math.abs(x0 + size.width / 2) < 1e-3, `x0 ${x0} vs ${-size.width / 2}`);
  assert.ok(Math.abs(z0 + size.depth / 2) < 1e-3, `z0 ${z0} vs ${-size.depth / 2}`);
});

test('every room becomes a zone inside the room footprint', () => {
  const size = planSizeMetres(DEFAULT_FLAT);
  const zones = planZones(DEFAULT_FLAT);

  assert.equal(zones.length, DEFAULT_FLAT.rooms.length);
  for (const z of zones) {
    const [x0, zz0, x1, zz1] = z.bounds;
    assert.ok(x1 > x0 && zz1 > zz0, `${z.id} has an inside-out bounding box`);
    assert.ok(x0 >= -size.width / 2 - 1e-6 && x1 <= size.width / 2 + 1e-6,
      `${z.id} escapes the room in x`);
    assert.ok(zz0 >= -size.depth / 2 - 1e-6 && zz1 <= size.depth / 2 + 1e-6,
      `${z.id} escapes the room in z`);
  }
});

test('placed nodes resolve to the room they were drawn in', () => {
  const placed = planNodePositions(DEFAULT_FLAT);
  assert.deepEqual(placed.map((p) => p.room), ['hall', 'dining', 'bed2']);

  for (const p of placed) {
    assert.ok(p.position.every(Number.isFinite));
    assert.equal(p.position[1], 1.2, 'mount height should survive conversion');
  }
});

test('roomIdAt agrees with the drawn rectangles', () => {
  assert.equal(roomIdAt(DEFAULT_FLAT, 5, 5), 'bed1');
  assert.equal(roomIdAt(DEFAULT_FLAT, 20, 5), 'hall');
  assert.equal(roomIdAt(DEFAULT_FLAT, 20, 28), 'kitchen');
  assert.equal(roomIdAt(DEFAULT_FLAT, 1000, 1000), null);
});

test('printed dimensions win over computed ones', () => {
  // A plan's printed size legitimately differs from its drawn size: HALL is
  // dimensioned 14'4" but drawn to 15' so it meets its neighbours on a
  // shared wall. The label must show what the tape measure agrees with.
  const hall = DEFAULT_FLAT.rooms.find((r) => r.id === 'hall');
  assert.equal(formatDim(DEFAULT_FLAT, hall), "15'4\" × 14'4\"");

  const drawn = { x0: 0, z0: 0, x1: 11.25, z1: 12.5 };
  assert.equal(formatDim(DEFAULT_FLAT, drawn), `11'3" × 12'6"`);
});

test('feet-and-inches carries 12 inches into the foot', () => {
  assert.equal(feetInches(11.999), "12'0\"");
  assert.equal(feetInches(0), `0'0"`);
});

// ── Store ──────────────────────────────────────────────────────────────

test('built-in plans cannot be overwritten or deleted', async (t) => {
  const { store, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => store.save({ ...structuredClone(DEFAULT_FLAT), name: 'Hijacked' }),
    (err) => err.code === 'BUILTIN_READONLY',
  );
  await assert.rejects(
    () => store.remove('default-flat'),
    (err) => err.code === 'BUILTIN_READONLY',
  );
});

test('a saved plan survives a restart, and so does which one is active', async (t) => {
  const { store, config, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const mine = { ...structuredClone(DEFAULT_FLAT), id: 'mine', name: 'Mine' };
  await store.save(mine);
  await store.setActive('mine');

  // A restart must not silently revert the space to the built-in default:
  // every node position and zone would move and nothing would say why.
  const reopened = new PlanStore(config, QUIET);
  await reopened.init();

  assert.equal(reopened.activeId, 'mine');
  assert.equal(reopened.active().name, 'Mine');
  assert.ok(reopened.list().some((p) => p.id === 'mine' && !p.builtin));
});

test('deleting the active plan falls back to the built-in', async (t) => {
  const { store, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await store.save({ ...structuredClone(DEFAULT_FLAT), id: 'temp', name: 'Temp' });
  await store.setActive('temp');
  await store.remove('temp');

  assert.equal(store.activeId, 'default-flat');
  assert.ok(store.active(), 'there must always be an active plan to build a field from');
});

test('a corrupt plan file is skipped, not loaded', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trinetra-plans-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await fsp.writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8');
  await fsp.writeFile(path.join(dir, 'invalid.json'),
    JSON.stringify({ id: 'invalid', name: 'X', rooms: [] }), 'utf8');

  const store = new PlanStore(baseConfig(dir), QUIET);
  await store.init();

  assert.equal(store.list().filter((p) => !p.builtin).length, 0);
  assert.equal(store.activeId, 'default-flat');
});

// ── Engine integration ─────────────────────────────────────────────────

test('applying a plan resizes the room and registers its zones', async (t) => {
  const { store, config, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const engine = new SensingEngine(config, QUIET);
  engine.applyPlan(store.active());

  const size = planSizeMetres(DEFAULT_FLAT);
  assert.deepEqual(config.room, size);
  assert.equal(engine.zones.length, DEFAULT_FLAT.rooms.length);

  // The field must span the new footprint, or the sensing surface is painted
  // across the wrong room and every detection lands in the wrong place.
  const update = engine.update();
  assert.deepEqual(update.signal_field.room, [size.width, size.height, size.depth]);
  assert.equal(update.floorplan.id, 'default-flat');
});

test('nodes are placed where the plan drew them', async (t) => {
  const { store, config, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const engine = new SensingEngine(config, QUIET);
  engine.applyPlan(store.active());

  for (const placed of planNodePositions(DEFAULT_FLAT)) {
    const node = engine.nodes.get(placed.node_id);
    assert.ok(node, `node ${placed.node_id} should exist`);
    assert.deepEqual(node.position, placed.position);
    assert.equal(node.room, placed.room);
  }
});

test('an explicit --room-size beats the plan, but zones still apply', async (t) => {
  const { store, config, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  // An operator who passes a flag has to see it honoured, or they have no way
  // to tell why it was ignored.
  config.roomExplicit = true;
  const fixed = { width: 4, depth: 3, height: 2.5 };
  config.room = { ...fixed };

  const engine = new SensingEngine(config, QUIET);
  engine.applyPlan(store.active(), { adoptRoom: false });

  assert.deepEqual(config.room, fixed);
  assert.equal(engine.zones.length, DEFAULT_FLAT.rooms.length);
});

test('switching plans moves the room with it', async (t) => {
  const { store, config, dir } = await tempStore();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const engine = new SensingEngine(config, QUIET);
  engine.applyPlan(store.active());

  const studio = {
    id: 'studio', name: 'Studio', units: 'ft', wall_height_m: 2.8,
    rooms: [{ id: 'main', label: 'STUDIO', type: 'room', x0: 0, z0: 0, x1: 20, z1: 16 }],
    doors: [], nodes: [],
  };
  const { plan } = await store.save(studio);
  engine.applyPlan(plan);

  assert.deepEqual(config.room, planSizeMetres(studio));
  assert.deepEqual(engine.zones.map((z) => z.id), ['main']);
  assert.equal(engine.update().floorplan.id, 'studio');
});
