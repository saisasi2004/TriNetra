/**
 * Floor plan schema, geometry and validation — SHARED by the browser and
 * the server.
 *
 * It lives under public/ because the browser can only import what is served
 * statically, and the server can import from anywhere. One file, two
 * consumers, no duplication.
 *
 * That matters more here than it looks. A floor plan carries a coordinate
 * transform: rooms are authored in FEET with the origin at the plan's
 * top-left corner (which is how an architectural drawing is dimensioned),
 * while every sensing quantity is in METRES centred on the room's middle
 * (which is what the field grid and node positions use). If the editor and
 * the server each carried their own copy of that conversion, a change to one
 * would silently move every person on screen by half a room. This project
 * already fights exactly that failure between the firmware and server DSP —
 * see tests/firmware-parity.test.js — so the transform is defined once.
 *
 *   plan units:  x → right, z → down, origin top-left, feet by default
 *   world units: x → right, z → down, origin at the plan's CENTRE, metres
 */

export const FT = 0.3048;

/** Scale factor from a plan's authoring unit to metres. */
export const UNIT_SCALE = { ft: FT, m: 1 };

export const DEFAULT_WALL_HEIGHT_M = 3.05;

/** Room types. `type` drives floor tint, label colour and light temperature. */
export const ROOM_TYPES = ['room', 'wet', 'balcony'];

/** Nodes a plan may carry. Matches the server's 1..254 node id range. */
export const MAX_PLAN_NODES = 6;

// ── Geometry ───────────────────────────────────────────────────────────

/** Metres per plan unit. */
export function unitScale(plan) {
  return UNIT_SCALE[plan?.units] ?? FT;
}

/** Bounding box of every room, in plan units. Null when there are no rooms. */
export function planBounds(plan) {
  const rooms = plan?.rooms ?? [];
  if (rooms.length === 0) return null;

  return rooms.reduce((b, r) => ({
    x0: Math.min(b.x0, r.x0, r.x1), z0: Math.min(b.z0, r.z0, r.z1),
    x1: Math.max(b.x1, r.x0, r.x1), z1: Math.max(b.z1, r.z0, r.z1),
  }), { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity });
}

/** Overall plan footprint in METRES — what the server uses as `config.room`. */
export function planSizeMetres(plan) {
  const b = planBounds(plan);
  const u = unitScale(plan);
  if (!b) return { width: 6, depth: 5, height: DEFAULT_WALL_HEIGHT_M };

  return {
    width: round3((b.x1 - b.x0) * u),
    depth: round3((b.z1 - b.z0) * u),
    height: round3(plan.wall_height_m ?? DEFAULT_WALL_HEIGHT_M),
  };
}

/**
 * Plan coordinates → world metres, centred on the plan.
 *
 * `bounds` may be passed in when converting many points at once; recomputing
 * the bounding box per point is the difference between an editor that drags
 * smoothly and one that stutters on a large plan.
 */
export function toWorld(plan, x, z, bounds = null) {
  const b = bounds ?? planBounds(plan);
  const u = unitScale(plan);
  if (!b) return [0, 0];

  return [
    (x - (b.x0 + b.x1) / 2) * u,
    (z - (b.z0 + b.z1) / 2) * u,
  ];
}

/** World metres → plan coordinates. The exact inverse of toWorld. */
export function fromWorld(plan, wx, wz, bounds = null) {
  const b = bounds ?? planBounds(plan);
  const u = unitScale(plan);
  if (!b) return [0, 0];

  return [
    wx / u + (b.x0 + b.x1) / 2,
    wz / u + (b.z0 + b.z1) / 2,
  ];
}

/**
 * A room's extent in world metres as [x0, z0, x1, z1] — exactly the shape
 * the server's zone API takes, so a room can be registered as a zone with
 * no further conversion.
 */
export function roomBoundsMetres(plan, room, bounds = null) {
  const b = bounds ?? planBounds(plan);
  const [x0, z0] = toWorld(plan, Math.min(room.x0, room.x1), Math.min(room.z0, room.z1), b);
  const [x1, z1] = toWorld(plan, Math.max(room.x0, room.x1), Math.max(room.z0, room.z1), b);
  return [round3(x0), round3(z0), round3(x1), round3(z1)];
}

/**
 * Every room as a server zone.
 *
 * This is the payload difference between a floor plan that is decoration and
 * one that is wired in: with zones registered, PersonTracker reports a person
 * in `kitchen` instead of falling back to its `north-west` quadrant label.
 */
export function planZones(plan) {
  const b = planBounds(plan);
  return (plan.rooms ?? []).map((room) => ({
    id: room.id,
    label: room.label,
    type: room.type ?? 'room',
    bounds: roomBoundsMetres(plan, room, b),
  }));
}

/** Node positions as the server wants them: [x, y, z] in world metres. */
export function planNodePositions(plan) {
  const b = planBounds(plan);
  return (plan.nodes ?? []).map((n) => {
    const [wx, wz] = toWorld(plan, n.x, n.z, b);
    return {
      node_id: n.node_id,
      room: roomIdAt(plan, n.x, n.z),
      position: [round3(wx), round3(n.height_m ?? 1.2), round3(wz)],
    };
  });
}

/** Which room contains a point given in PLAN units, or null. */
export function roomIdAt(plan, x, z) {
  for (const r of plan.rooms ?? []) {
    if (x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) &&
        z >= Math.min(r.z0, r.z1) && z <= Math.max(r.z0, r.z1)) {
      return r.id;
    }
  }
  return null;
}

// ── Formatting ─────────────────────────────────────────────────────────

/** 11.25 ft → `11'3"`. Inches are rounded, and 12" carries into the foot. */
export function feetInches(value) {
  const total = Math.round(value * 12);
  const ft = Math.floor(total / 12);
  const inches = total % 12;
  return `${ft}'${inches}"`;
}

/**
 * A room's printed dimension string.
 *
 * `room.dim` wins when present, because a plan's PRINTED size and its DRAWN
 * size legitimately differ — a room dimensioned 14'4" may be drawn to 15' so
 * that it meets its neighbour on a shared wall, and the printed number is the
 * one the tape measure agrees with. Rooms created in the editor have no
 * printed size, so theirs is computed.
 */
export function formatDim(plan, room) {
  if (room.dim) return room.dim;

  const w = Math.abs(room.x1 - room.x0);
  const d = Math.abs(room.z1 - room.z0);

  return plan.units === 'm'
    ? `${w.toFixed(2)} × ${d.toFixed(2)} m`
    : `${feetInches(w)} × ${feetInches(d)}`;
}

// ── Validation ─────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const MAX_ROOMS = 60;
const MAX_DOORS = 120;
/** Plan-unit extent beyond which this is not a dwelling but a typo. */
const MAX_EXTENT = 400;

/**
 * Validate a plan.
 *
 * Run on BOTH sides. The editor uses it to show problems before saving; the
 * REST handler uses it because a plan arrives over the network and is then
 * used to resize the sensing field and reposition nodes — a NaN reaching
 * `SignalField` would produce a grid of NaN likelihoods and a field that
 * never peaks again, with no error anywhere to explain it.
 *
 * @returns { ok, errors: string[], warnings: string[] }
 */
export function validatePlan(plan) {
  const errors = [];
  const warnings = [];

  if (!plan || typeof plan !== 'object') {
    return { ok: false, errors: ['plan must be an object'], warnings };
  }
  if (!ID_RE.test(plan.id ?? '')) {
    errors.push('id must be 1-32 chars of letters, digits, dash or underscore');
  }
  if (typeof plan.name !== 'string' || !plan.name.trim()) {
    errors.push('name must be a non-empty string');
  }
  if (plan.units !== undefined && !UNIT_SCALE[plan.units]) {
    errors.push(`units must be one of: ${Object.keys(UNIT_SCALE).join(', ')}`);
  }

  const rooms = plan.rooms;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    errors.push('a plan needs at least one room');
    return { ok: false, errors, warnings };
  }
  if (rooms.length > MAX_ROOMS) errors.push(`at most ${MAX_ROOMS} rooms`);

  const seenRoom = new Set();
  for (const [i, r] of rooms.entries()) {
    const where = `room ${i + 1} (${r?.id ?? 'no id'})`;

    if (!ID_RE.test(r?.id ?? '')) { errors.push(`${where}: invalid id`); continue; }
    if (seenRoom.has(r.id)) errors.push(`${where}: duplicate id`);
    seenRoom.add(r.id);

    if (typeof r.label !== 'string' || !r.label.trim()) {
      errors.push(`${where}: label must be a non-empty string`);
    }
    if (r.type !== undefined && !ROOM_TYPES.includes(r.type)) {
      errors.push(`${where}: type must be one of ${ROOM_TYPES.join(', ')}`);
    }

    const coords = [r.x0, r.z0, r.x1, r.z1];
    if (!coords.every((v) => Number.isFinite(v))) {
      errors.push(`${where}: x0/z0/x1/z1 must be finite numbers`);
      continue;
    }
    if (coords.some((v) => Math.abs(v) > MAX_EXTENT)) {
      errors.push(`${where}: coordinates beyond ±${MAX_EXTENT} ${plan.units ?? 'ft'}`);
    }
    if (Math.abs(r.x1 - r.x0) < 0.5 || Math.abs(r.z1 - r.z0) < 0.5) {
      errors.push(`${where}: must be at least 0.5 ${plan.units ?? 'ft'} on each side`);
    }
  }

  // Overlaps are a warning, not an error. Rooms that share a wall have
  // coincident edges by design, and an L-shaped space is legitimately
  // modelled as two overlapping rectangles — but a room sitting ON TOP of
  // another is nearly always a drawing mistake, and it doubles that floor's
  // brightness in the 3D view, so it is worth saying out loud.
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];
      const ox = overlap(a.x0, a.x1, b.x0, b.x1);
      const oz = overlap(a.z0, a.z1, b.z0, b.z1);
      if (ox > 0.25 && oz > 0.25) {
        warnings.push(`${a.id} and ${b.id} overlap by ${ox.toFixed(1)}×${oz.toFixed(1)}`);
      }
    }
  }

  const doors = plan.doors ?? [];
  if (!Array.isArray(doors)) errors.push('doors must be an array');
  else {
    if (doors.length > MAX_DOORS) errors.push(`at most ${MAX_DOORS} doors`);
    const seenDoor = new Set();
    for (const [i, d] of doors.entries()) {
      const where = `door ${i + 1} (${d?.id ?? 'no id'})`;
      if (!ID_RE.test(d?.id ?? '')) { errors.push(`${where}: invalid id`); continue; }
      if (seenDoor.has(d.id)) errors.push(`${where}: duplicate id`);
      seenDoor.add(d.id);

      if (d.dir !== 'h' && d.dir !== 'v') {
        errors.push(`${where}: dir must be 'h' or 'v'`);
      }
      if (![d.x, d.z, d.w].every((v) => Number.isFinite(v))) {
        errors.push(`${where}: x/z/w must be finite numbers`);
        continue;
      }
      if (d.w <= 0) errors.push(`${where}: width must be positive`);

      // A door that lands on no wall punches no hole — it silently does
      // nothing, which is the hardest kind of mistake to see in a 3D view.
      if (!doorTouchesWall(plan, d)) {
        warnings.push(`${where}: does not line up with any wall, so it opens nothing`);
      }
    }
  }

  const nodes = plan.nodes ?? [];
  if (!Array.isArray(nodes)) errors.push('nodes must be an array');
  else {
    if (nodes.length > MAX_PLAN_NODES) {
      errors.push(`at most ${MAX_PLAN_NODES} nodes may be placed on a plan`);
    }
    const seenNode = new Set();
    for (const [i, n] of nodes.entries()) {
      const where = `node ${i + 1}`;
      if (!Number.isInteger(n?.node_id) || n.node_id < 1 || n.node_id > 254) {
        errors.push(`${where}: node_id must be an integer 1..254`);
        continue;
      }
      // The server keys every piece of per-node state on this id, so two
      // boards sharing one are merged into a single NodeState — which
      // corrupts its measured sample rate and therefore its vitals. The
      // same collision is detectable here, before it ever happens.
      if (seenNode.has(n.node_id)) {
        errors.push(`${where}: node_id ${n.node_id} is used more than once`);
      }
      seenNode.add(n.node_id);

      if (![n.x, n.z].every((v) => Number.isFinite(v))) {
        errors.push(`${where}: x/z must be finite numbers`);
        continue;
      }
      if (n.height_m !== undefined &&
          (!Number.isFinite(n.height_m) || n.height_m < 0 || n.height_m > 10)) {
        errors.push(`${where}: height_m must be between 0 and 10`);
      }
      if (!roomIdAt(plan, n.x, n.z)) {
        warnings.push(`${where} (id ${n.node_id}) sits outside every room`);
      }
    }

    // Three is the smallest array that can multilaterate: two range circles
    // meet at two points and leave a mirror ambiguity nothing resolves.
    if (nodes.length > 0 && nodes.length < 3) {
      warnings.push(
        `${nodes.length} node(s) placed — three is the minimum for a unique ` +
        'position fix; below that the field reports range only',
      );
    }
  }

  if (plan.wall_height_m !== undefined &&
      (!Number.isFinite(plan.wall_height_m) ||
       plan.wall_height_m < 1 || plan.wall_height_m > 10)) {
    errors.push('wall_height_m must be between 1 and 10');
  }

  return { ok: errors.length === 0, errors, warnings };
}

function overlap(a0, a1, b0, b1) {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, hi - lo);
}

/** True when a door lies on some room edge and within that edge's run. */
function doorTouchesWall(plan, d, tol = 0.2) {
  for (const r of plan.rooms ?? []) {
    if (d.dir === 'h') {
      const onEdge = Math.abs(d.z - r.z0) < tol || Math.abs(d.z - r.z1) < tol;
      if (onEdge && overlap(d.x - d.w / 2, d.x + d.w / 2, r.x0, r.x1) > 0.05) return true;
    } else {
      const onEdge = Math.abs(d.x - r.x0) < tol || Math.abs(d.x - r.x1) < tol;
      if (onEdge && overlap(d.z - d.w / 2, d.z + d.w / 2, r.z0, r.z1) > 0.05) return true;
    }
  }
  return false;
}

/**
 * Strip a plan down to exactly the fields the schema defines.
 *
 * Applied to anything arriving over the network before it is stored, so a
 * client cannot smuggle extra keys into a file the server later re-reads and
 * hands back to every browser.
 */
export function sanitizePlan(plan) {
  const out = {
    id: String(plan.id),
    name: String(plan.name).slice(0, 80),
    units: UNIT_SCALE[plan.units] ? plan.units : 'ft',
    wall_height_m: Number.isFinite(plan.wall_height_m)
      ? plan.wall_height_m : DEFAULT_WALL_HEIGHT_M,
    rooms: (plan.rooms ?? []).map((r) => ({
      id: String(r.id),
      label: String(r.label).slice(0, 40),
      type: ROOM_TYPES.includes(r.type) ? r.type : 'room',
      x0: +r.x0, z0: +r.z0, x1: +r.x1, z1: +r.z1,
      ...(r.dim ? { dim: String(r.dim).slice(0, 40) } : {}),
    })),
    doors: (plan.doors ?? []).map((d) => ({
      id: String(d.id),
      x: +d.x, z: +d.z, w: +d.w,
      dir: d.dir === 'v' ? 'v' : 'h',
    })),
    nodes: (plan.nodes ?? []).map((n) => ({
      node_id: n.node_id | 0,
      x: +n.x, z: +n.z,
      height_m: Number.isFinite(n.height_m) ? n.height_m : 1.2,
    })),
  };
  return out;
}

/** An empty plan to draw into — one small room so the view has a subject. */
export function blankPlan(id = 'untitled', name = 'Untitled plan') {
  return {
    id,
    name,
    units: 'ft',
    wall_height_m: DEFAULT_WALL_HEIGHT_M,
    rooms: [
      { id: 'room1', label: 'ROOM', type: 'room', x0: 0, z0: 0, x1: 14, z1: 12 },
    ],
    doors: [],
    nodes: [],
  };
}

const round3 = (v) => Math.round(v * 1000) / 1000;
