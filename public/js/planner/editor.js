/**
 * Floor plan editor — 2D canvas, top-down.
 *
 * Two-dimensional on purpose. A floor plan is a set of axis-aligned
 * rectangles on one level, and dragging a corner in a top-down view maps
 * exactly onto that; doing the same in a perspective 3D view means solving
 * "which of the three axes did the user mean" on every drag, and getting it
 * wrong half the time. The 3D view already exists in the observatory, and it
 * is a far better *viewer* than it would be an editor.
 *
 * Coordinates here are PLAN units (feet by default), origin at the plan's
 * top-left, x → right, z → down — the same convention an architectural
 * drawing is dimensioned in, and the same one ../lib/plan.js converts to
 * sensing metres. The editor never deals in metres; that conversion belongs
 * in exactly one place and this is not it.
 */

import { formatDim, planBounds, roomIdAt, MAX_PLAN_NODES } from '../lib/plan.js';

const GRID_MINOR = 1;      // plan units
const GRID_MAJOR = 5;

/** Pixels within which a click counts as hitting a handle or a wall line. */
const HANDLE_PX = 9;
const WALL_HIT_PX = 10;
const NODE_PX = 11;

const COLOURS = {
  bg: '#080c12',
  gridMinor: 'rgba(122, 247, 191, 0.05)',
  gridMajor: 'rgba(122, 247, 191, 0.11)',
  roomFill: { room: '#1a2431', wet: '#16202b', balcony: '#121a24' },
  roomEdge: '#59677a',
  roomLabel: { room: '#7af7bf', wet: '#62b4ff', balcony: '#ffbb4d' },
  selected: '#7af7bf',
  door: '#ffbb4d',
  node: '#ff4060',
  nodeRing: 'rgba(255, 64, 96, 0.38)',
  ghost: 'rgba(122, 247, 191, 0.35)',
};

let uid = 0;
const nextId = (prefix) => `${prefix}${Date.now().toString(36)}${(uid++).toString(36)}`;

/**
 * A room's id becomes its ZONE id in the sensing API, which is what the
 * dashboard prints when it says which zone somebody is in. So it has to be
 * readable: `kitchen` is a useful thing to see in a person's `zone` field,
 * `roommtpf8c4b0` is not.
 */
const slug = (label) => (String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 24) || 'room');

export class PlanEditor extends EventTarget {
  constructor(canvas, plan) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plan = plan;

    this.tool = 'select';
    this.selection = null;      // { kind: 'room'|'door'|'node', id }
    this.snap = 0.5;
    this.snapEnabled = true;
    this.readOnly = false;

    this.scale = 20;            // pixels per plan unit
    this.offset = { x: 40, y: 40 };

    this.drag = null;
    this.hover = null;
    this.cursor = { x: 0, z: 0 };

    this.#bindEvents();
    this.resize();
  }

  // ── Plan lifecycle ───────────────────────────────────────────────────

  setPlan(plan, { fit = true } = {}) {
    this.plan = plan;
    this.selection = null;
    this.drag = null;
    if (fit) this.fit();
    this.#changed({ structural: true });
  }

  setTool(tool) {
    this.tool = tool;
    // The drawing tools keep whatever they just created selected, so the
    // properties panel is already showing it and can be edited immediately.
    if (tool !== 'select') this.selection = null;
    this.draw();
    this.dispatchEvent(new CustomEvent('tool', { detail: tool }));
  }

  setReadOnly(v) {
    this.readOnly = !!v;
    if (this.readOnly) this.selection = null;
    this.draw();
  }

  /** Fit the whole plan in view with a margin. */
  fit() {
    const b = planBounds(this.plan);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!b || !width) return;

    const pad = 48;
    const w = Math.max(1, b.x1 - b.x0);
    const d = Math.max(1, b.z1 - b.z0);

    this.scale = Math.max(4, Math.min((width - pad * 2) / w, (height - pad * 2) / d));
    this.offset = {
      x: (width - w * this.scale) / 2 - b.x0 * this.scale,
      y: (height - d * this.scale) / 2 - b.z0 * this.scale,
    };
    this.draw();
  }

  // ── Transforms ───────────────────────────────────────────────────────

  toScreen(x, z) {
    return [x * this.scale + this.offset.x, z * this.scale + this.offset.y];
  }

  toPlan(px, py) {
    return [(px - this.offset.x) / this.scale, (py - this.offset.y) / this.scale];
  }

  #snapValue(v) {
    if (!this.snapEnabled || this.snap <= 0) return Math.round(v * 100) / 100;
    return Math.round(v / this.snap) * this.snap;
  }

  #pointerPlan(ev) {
    const r = this.canvas.getBoundingClientRect();
    return this.toPlan(ev.clientX - r.left, ev.clientY - r.top);
  }

  // ── Selection helpers ────────────────────────────────────────────────

  get selectedRoom() {
    return this.selection?.kind === 'room'
      ? this.plan.rooms.find((r) => r.id === this.selection.id) : null;
  }

  get selectedDoor() {
    return this.selection?.kind === 'door'
      ? this.plan.doors.find((d) => d.id === this.selection.id) : null;
  }

  get selectedNode() {
    return this.selection?.kind === 'node'
      ? this.plan.nodes.find((n) => n.node_id === this.selection.id) : null;
  }

  select(kind, id) {
    this.selection = kind ? { kind, id } : null;
    this.draw();
    this.dispatchEvent(new CustomEvent('select', { detail: this.selection }));
  }

  // ── Mutation ─────────────────────────────────────────────────────────

  /**
   * Sort a room's corners so x0 < x1 and z0 < z1.
   *
   * Deliberately does NOT touch the printed `dim` string. A printed dimension
   * is what the architect's drawing says, and it is allowed to differ from
   * the drawn rectangle — the default flat has a room printed 14'4" but drawn
   * to 15' so that it meets its neighbour on a shared wall. Dropping it
   * belongs with an actual geometry CHANGE (see the move and resize handlers,
   * and `commit`), not with normalisation, which also runs after a click that
   * moved nothing. Conflating the two silently replaced the printed size of
   * whichever room you last clicked on.
   */
  #normaliseRoom(room, { stripDim = false } = {}) {
    const x0 = Math.min(room.x0, room.x1);
    const x1 = Math.max(room.x0, room.x1);
    const z0 = Math.min(room.z0, room.z1);
    const z1 = Math.max(room.z0, room.z1);
    Object.assign(room, { x0, x1, z0, z1 });
    if (stripDim) delete room.dim;
  }

  /** A free id based on `base`, suffixed only if it is already taken. */
  uniqueRoomId(base, exceptId = null) {
    const taken = new Set(this.plan.rooms
      .filter((r) => r.id !== exceptId).map((r) => r.id));
    let id = slug(base);
    let n = 2;
    while (taken.has(id)) id = `${slug(base)}-${n++}`;
    return id;
  }

  /**
   * Rename a room, keeping its id in step with its label.
   *
   * The id only follows while it still matches the OLD label's slug — that
   * is, while the user has not deliberately set an id of their own. Renaming
   * a room you just drew should give you `study`, not leave you with `room`
   * forever; renaming one whose id you chose should leave your id alone.
   */
  renameRoom(room, label) {
    const wasDerived = room.id === slug(room.label);
    room.label = label;
    if (wasDerived) room.id = this.uniqueRoomId(label, room.id);
    this.#changed({ structural: true });
  }

  addRoom(x0, z0, x1, z1) {
    const room = {
      id: this.uniqueRoomId('ROOM'),
      label: 'ROOM',
      type: 'room',
      x0, z0, x1, z1,
    };
    this.#normaliseRoom(room);
    this.plan.rooms.push(room);
    this.select('room', room.id);
    this.#changed({ structural: true });
    return room;
  }

  /**
   * Place a door on the wall nearest the click.
   *
   * A door is stored as a position on a wall LINE rather than as a member of
   * a room, because a doorway between two rooms is one opening: the renderer
   * punches every wall passing through it, so both sides open together and
   * neither can be forgotten. Snapping to an existing wall is what makes
   * that work — a door floating in open space punches nothing at all, which
   * is why validatePlan warns about exactly that case.
   */
  addDoorAt(px, pz) {
    const wall = this.#nearestWall(px, pz);
    if (!wall) return null;

    const door = {
      id: nextId('door'),
      dir: wall.dir,
      x: wall.dir === 'h' ? this.#snapValue(px) : wall.at,
      z: wall.dir === 'h' ? wall.at : this.#snapValue(pz),
      w: 3,
    };
    this.plan.doors.push(door);
    this.select('door', door.id);
    this.#changed({ structural: true });

    // One placement per arming. Leaving the tool active means every
    // subsequent click — including one meant to select what you just
    // placed — silently adds another, and you discover the pile only when
    // the checks panel starts complaining.
    this.setTool('select');
    return door;
  }

  addNodeAt(px, pz) {
    const used = new Set(this.plan.nodes.map((n) => n.node_id));
    let id = 1;
    while (used.has(id)) id++;
    if (id > MAX_PLAN_NODES || this.plan.nodes.length >= MAX_PLAN_NODES) {
      this.dispatchEvent(new CustomEvent('notice', {
        detail: `At most ${MAX_PLAN_NODES} nodes can be placed on a plan.`,
      }));
      return null;
    }

    const node = {
      node_id: id,
      x: this.#snapValue(px),
      z: this.#snapValue(pz),
      height_m: 1.2,
    };
    this.plan.nodes.push(node);
    this.select('node', id);
    this.#changed({ structural: true });
    this.setTool('select');
    return node;
  }

  deleteSelection() {
    if (!this.selection || this.readOnly) return;
    const { kind, id } = this.selection;

    if (kind === 'room') {
      this.plan.rooms = this.plan.rooms.filter((r) => r.id !== id);
    } else if (kind === 'door') {
      this.plan.doors = this.plan.doors.filter((d) => d.id !== id);
    } else if (kind === 'node') {
      this.plan.nodes = this.plan.nodes.filter((n) => n.node_id !== id);
    }

    this.selection = null;
    this.#changed({ structural: true });
    this.dispatchEvent(new CustomEvent('select', { detail: null }));
  }

  /** Called by the properties panel after editing a field directly. */
  commit({ structural = false } = {}) {
    const room = this.selectedRoom;
    // `structural` means a coordinate was typed into the panel, which IS a
    // geometry change, so the printed size no longer describes the room.
    if (room) this.#normaliseRoom(room, { stripDim: structural });
    this.#changed({ structural });
  }

  #changed(detail = {}) {
    this.draw();
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  // ── Hit testing ──────────────────────────────────────────────────────

  /** Resize handles for a room, as [name, x, z] in plan units. */
  #handles(room) {
    const { x0, z0, x1, z1 } = room;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    return [
      ['nw', x0, z0], ['n', mx, z0], ['ne', x1, z0],
      ['w', x0, mz], ['e', x1, mz],
      ['sw', x0, z1], ['s', mx, z1], ['se', x1, z1],
    ];
  }

  #hitTest(px, pz) {
    const tol = (pxDist) => pxDist / this.scale;

    // Nodes first: they are small, sit on top of rooms, and are the thing a
    // user most often wants to nudge.
    for (const n of this.plan.nodes ?? []) {
      if (Math.hypot(n.x - px, n.z - pz) < tol(NODE_PX)) {
        return { kind: 'node', id: n.node_id };
      }
    }

    for (const d of this.plan.doors ?? []) {
      const along = d.dir === 'h' ? Math.abs(px - d.x) : Math.abs(pz - d.z);
      const across = d.dir === 'h' ? Math.abs(pz - d.z) : Math.abs(px - d.x);
      if (along < d.w / 2 + tol(4) && across < tol(WALL_HIT_PX)) {
        return { kind: 'door', id: d.id };
      }
    }

    // Handles of the SELECTED room only. Showing handles for every room at
    // once makes a dense plan unclickable — every room body is covered by
    // its neighbours' handles.
    const sel = this.selectedRoom;
    if (sel) {
      for (const [name, hx, hz] of this.#handles(sel)) {
        if (Math.hypot(hx - px, hz - pz) < tol(HANDLE_PX)) {
          return { kind: 'handle', id: sel.id, handle: name };
        }
      }
    }

    // Room bodies, smallest first, so a bathroom inside a bedroom's bounds
    // is still reachable.
    const rooms = [...(this.plan.rooms ?? [])].sort(
      (a, b) => area(a) - area(b),
    );
    for (const r of rooms) {
      if (px >= r.x0 && px <= r.x1 && pz >= r.z0 && pz <= r.z1) {
        return { kind: 'room', id: r.id };
      }
    }
    return null;
  }

  /** Nearest room edge to a point, as { dir, at, dist }. */
  #nearestWall(px, pz) {
    let best = null;
    const consider = (dir, at, lo, hi, along) => {
      // Only count the wall where the point is actually beside it, not off
      // the end of the run.
      if (along < lo - 0.5 || along > hi + 0.5) return;
      const dist = Math.abs((dir === 'h' ? pz : px) - at);
      if (!best || dist < best.dist) best = { dir, at, dist };
    };

    for (const r of this.plan.rooms ?? []) {
      consider('h', r.z0, r.x0, r.x1, px);
      consider('h', r.z1, r.x0, r.x1, px);
      consider('v', r.x0, r.z0, r.z1, pz);
      consider('v', r.x1, r.z0, r.z1, pz);
    }

    if (!best) return null;
    return best.dist * this.scale < WALL_HIT_PX * 3 ? best : null;
  }

  // ── Interaction ──────────────────────────────────────────────────────

  #bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (ev) => this.#onDown(ev));
    c.addEventListener('pointermove', (ev) => this.#onMove(ev));
    c.addEventListener('pointerup', (ev) => this.#onUp(ev));
    c.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });

    c.addEventListener('wheel', (ev) => this.#onWheel(ev), { passive: false });
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());

    window.addEventListener('resize', () => this.resize());
  }

  #onDown(ev) {
    this.canvas.setPointerCapture(ev.pointerId);
    const [px, pz] = this.#pointerPlan(ev);

    // Middle button or space-drag pans regardless of tool — a pan that is
    // only available on one tool means constantly switching tools to look
    // around, which is the fastest way to make an editor tiring.
    if (ev.button === 1 || ev.button === 2 || this.tool === 'pan' || ev.shiftKey) {
      this.drag = { mode: 'pan', startX: ev.clientX, startY: ev.clientY, origin: { ...this.offset } };
      return;
    }

    if (this.readOnly) {
      this.dispatchEvent(new CustomEvent('notice', {
        detail: 'This is a built-in plan. Duplicate it to make changes.',
      }));
      return;
    }

    if (this.tool === 'room') {
      const x = this.#snapValue(px), z = this.#snapValue(pz);
      this.drag = { mode: 'create', x0: x, z0: z, x1: x, z1: z };
      return;
    }
    if (this.tool === 'door') { this.addDoorAt(px, pz); return; }
    if (this.tool === 'node') { this.addNodeAt(px, pz); return; }

    const hit = this.#hitTest(px, pz);

    if (!hit) { this.select(null); return; }

    if (hit.kind === 'handle') {
      const room = this.plan.rooms.find((r) => r.id === hit.id);
      this.drag = { mode: 'resize', handle: hit.handle, room, before: rect(room) };
      return;
    }

    this.select(hit.kind, hit.id);

    if (hit.kind === 'room') {
      const room = this.plan.rooms.find((r) => r.id === hit.id);
      this.drag = { mode: 'move-room', room, grabX: px - room.x0, grabZ: pz - room.z0,
        w: room.x1 - room.x0, d: room.z1 - room.z0, before: rect(room) };
    } else if (hit.kind === 'door') {
      this.drag = { mode: 'move-door', door: this.plan.doors.find((d) => d.id === hit.id) };
    } else if (hit.kind === 'node') {
      this.drag = { mode: 'move-node', node: this.plan.nodes.find((n) => n.node_id === hit.id) };
    }
  }

  #onMove(ev) {
    const [px, pz] = this.#pointerPlan(ev);
    this.cursor = { x: px, z: pz };
    this.dispatchEvent(new CustomEvent('cursor', { detail: this.cursor }));

    if (!this.drag) {
      this.hover = this.readOnly ? null : this.#hitTest(px, pz);
      this.#updateCursorStyle();
      this.draw();
      return;
    }

    const d = this.drag;

    if (d.mode === 'pan') {
      this.offset = {
        x: d.origin.x + (ev.clientX - d.startX),
        y: d.origin.y + (ev.clientY - d.startY),
      };
      this.draw();
      return;
    }

    if (d.mode === 'create') {
      d.x1 = this.#snapValue(px);
      d.z1 = this.#snapValue(pz);
      this.draw();
      return;
    }

    if (d.mode === 'move-room') {
      const nx = this.#snapValue(px - d.grabX);
      const nz = this.#snapValue(pz - d.grabZ);
      Object.assign(d.room, { x0: nx, z0: nz, x1: nx + d.w, z1: nz + d.d });
      delete d.room.dim;
      this.#changed();
      return;
    }

    if (d.mode === 'resize') {
      const h = d.handle;
      if (h.includes('w')) d.room.x0 = this.#snapValue(px);
      if (h.includes('e')) d.room.x1 = this.#snapValue(px);
      if (h.includes('n')) d.room.z0 = this.#snapValue(pz);
      if (h.includes('s')) d.room.z1 = this.#snapValue(pz);
      delete d.room.dim;
      this.#changed();
      return;
    }

    if (d.mode === 'move-door') {
      // A door slides ALONG its wall and re-snaps across it, so dragging one
      // toward a different wall moves it there rather than lifting it off
      // into space where it would open nothing.
      const wall = this.#nearestWall(px, pz);
      if (wall) {
        d.door.dir = wall.dir;
        if (wall.dir === 'h') { d.door.z = wall.at; d.door.x = this.#snapValue(px); }
        else { d.door.x = wall.at; d.door.z = this.#snapValue(pz); }
      }
      this.#changed();
      return;
    }

    if (d.mode === 'move-node') {
      d.node.x = this.#snapValue(px);
      d.node.z = this.#snapValue(pz);
      this.#changed();
    }
  }

  #onUp(ev) {
    try { this.canvas.releasePointerCapture(ev.pointerId); } catch { /* already released */ }

    const d = this.drag;
    this.drag = null;
    if (!d) return;

    if (d.mode === 'create') {
      // Ignore a click that was not really a drag, so a stray click with the
      // room tool selected does not litter the plan with slivers.
      if (Math.abs(d.x1 - d.x0) >= 1 && Math.abs(d.z1 - d.z0) >= 1) {
        this.addRoom(d.x0, d.z0, d.x1, d.z1);
        this.setTool('select');
      } else {
        this.draw();
      }
      return;
    }

    if (d.mode === 'resize' || d.mode === 'move-room') {
      // A click that selected a room without dragging it is not an edit.
      // Treating it as one marked the plan unsaved and threw away the room's
      // printed dimension, purely for looking at it.
      if (rect(d.room) === d.before) { this.draw(); return; }
      this.#normaliseRoom(d.room, { stripDim: true });
    }
    if (d.mode !== 'pan') this.#changed({ structural: true });
  }

  #onWheel(ev) {
    ev.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const [bx, bz] = this.toPlan(mx, my);

    const factor = Math.exp(-ev.deltaY * 0.0015);
    this.scale = Math.max(3, Math.min(160, this.scale * factor));

    // Keep the point under the cursor fixed — anything else makes zooming
    // feel like the plan is running away from you.
    this.offset = { x: mx - bx * this.scale, y: my - bz * this.scale };
    this.draw();
  }

  #updateCursorStyle() {
    const CURSORS = {
      nw: 'nwse-resize', se: 'nwse-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    };
    let style = 'default';
    if (this.tool === 'pan') style = 'grab';
    else if (this.tool === 'room') style = 'crosshair';
    else if (this.tool === 'door' || this.tool === 'node') style = 'copy';
    else if (this.hover?.kind === 'handle') style = CURSORS[this.hover.handle] ?? 'pointer';
    else if (this.hover) style = 'move';
    this.canvas.style.cursor = style;
  }

  // ── Rendering ────────────────────────────────────────────────────────

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width) return;

    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(0, 0, width, height);

    this.#drawGrid(width, height);

    for (const room of this.plan.rooms ?? []) this.#drawRoom(room);
    for (const door of this.plan.doors ?? []) this.#drawDoor(door);
    for (const node of this.plan.nodes ?? []) this.#drawNode(node);

    if (this.drag?.mode === 'create') {
      const [sx, sy] = this.toScreen(this.drag.x0, this.drag.z0);
      const [ex, ey] = this.toScreen(this.drag.x1, this.drag.z1);
      ctx.strokeStyle = COLOURS.ghost;
      ctx.fillStyle = 'rgba(122, 247, 191, 0.08)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.fillRect(sx, sy, ex - sx, ey - sy);
      ctx.strokeRect(sx, sy, ex - sx, ey - sy);
      ctx.setLineDash([]);
    }

    if (this.selectedRoom) this.#drawHandles(this.selectedRoom);
  }

  #drawGrid(width, height) {
    const ctx = this.ctx;
    const [left, top] = this.toPlan(0, 0);
    const [right, bottom] = this.toPlan(width, height);

    // Skip the minor grid when it would be denser than the eye can use —
    // at low zoom it turns into a flat wash that hides the plan.
    const drawMinor = GRID_MINOR * this.scale > 6;

    const line = (x0, y0, x1, y1, colour) => {
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };

    ctx.lineWidth = 1;
    for (const [step, colour, on] of [
      [GRID_MINOR, COLOURS.gridMinor, drawMinor],
      [GRID_MAJOR, COLOURS.gridMajor, true],
    ]) {
      if (!on) continue;
      for (let x = Math.floor(left / step) * step; x <= right; x += step) {
        const [sx] = this.toScreen(x, 0);
        line(sx, 0, sx, height, colour);
      }
      for (let z = Math.floor(top / step) * step; z <= bottom; z += step) {
        const [, sy] = this.toScreen(0, z);
        line(0, sy, width, sy, colour);
      }
    }
  }

  #drawRoom(room) {
    const ctx = this.ctx;
    const [x0, z0] = this.toScreen(room.x0, room.z0);
    const [x1, z1] = this.toScreen(room.x1, room.z1);
    const w = x1 - x0, h = z1 - z0;

    const isSel = this.selection?.kind === 'room' && this.selection.id === room.id;
    const isHover = this.hover?.kind === 'room' && this.hover.id === room.id;

    ctx.fillStyle = COLOURS.roomFill[room.type] ?? COLOURS.roomFill.room;
    ctx.fillRect(x0, z0, w, h);

    ctx.strokeStyle = isSel ? COLOURS.selected : isHover ? '#8494a8' : COLOURS.roomEdge;
    ctx.lineWidth = isSel ? 2.5 : 1.5;
    ctx.strokeRect(x0, z0, w, h);

    // Labels vanish below the size where they would overflow the room and
    // overlap its neighbours' labels into an unreadable pile.
    if (Math.abs(w) < 46 || Math.abs(h) < 26) return;

    const cx = x0 + w / 2, cy = z0 + h / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = COLOURS.roomLabel[room.type] ?? COLOURS.roomLabel.room;
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.fillText(room.label, cx, cy - 2);

    ctx.fillStyle = 'rgba(237, 245, 242, 0.55)';
    ctx.font = '400 10px "JetBrains Mono", monospace';
    ctx.fillText(formatDim(this.plan, room), cx, cy + 12);
  }

  #drawDoor(door) {
    const ctx = this.ctx;
    const isSel = this.selection?.kind === 'door' && this.selection.id === door.id;

    const half = door.w / 2;
    const [ax, ay] = door.dir === 'h'
      ? this.toScreen(door.x - half, door.z)
      : this.toScreen(door.x, door.z - half);
    const [bx, by] = door.dir === 'h'
      ? this.toScreen(door.x + half, door.z)
      : this.toScreen(door.x, door.z + half);

    // Drawn as a break in the wall — the gap IS the door, which is exactly
    // what the 3D renderer builds from it.
    ctx.strokeStyle = COLOURS.bg;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.stroke();

    ctx.strokeStyle = isSel ? COLOURS.selected : COLOURS.door;
    ctx.lineWidth = isSel ? 4 : 2.5;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.stroke();
  }

  #drawNode(node) {
    const ctx = this.ctx;
    const [x, y] = this.toScreen(node.x, node.z);
    const isSel = this.selection?.kind === 'node' && this.selection.id === node.node_id;

    // A faint dashed ring at roughly the range where this node's return has
    // fallen off — an orientation aid for spacing nodes out, nothing more.
    //
    // Deliberately a thin outline rather than a filled disc. A solid blob
    // reads as a coverage footprint with an edge, and a monostatic
    // single-antenna node has no such edge: its observable is range-only and
    // decays smoothly, so a hard boundary would be claiming precision the
    // physics does not have. It also has to stay out of the way of the room
    // labels underneath it, which a filled disc does not.
    ctx.strokeStyle = COLOURS.nodeRing;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(14, 4.9 * this.scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = COLOURS.node;
    ctx.strokeStyle = isSel ? COLOURS.selected : '#0b1119';
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#edf5f2';
    ctx.font = '700 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`N${node.node_id}`, x, y - 12);
  }

  #drawHandles(room) {
    const ctx = this.ctx;
    for (const [, hx, hz] of this.#handles(room)) {
      const [x, y] = this.toScreen(hx, hz);
      ctx.fillStyle = COLOURS.selected;
      ctx.strokeStyle = COLOURS.bg;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** The room a node sits in, for the properties panel. */
  roomOf(node) {
    const id = roomIdAt(this.plan, node.x, node.z);
    return this.plan.rooms.find((r) => r.id === id) ?? null;
  }
}

function area(r) {
  return Math.abs(r.x1 - r.x0) * Math.abs(r.z1 - r.z0);
}

/** A room's extent as a comparable string, for "did this actually change". */
function rect(r) {
  return `${r.x0}:${r.z0}:${r.x1}:${r.z1}`;
}
