/**
 * Floor plan renderer.
 *
 * Draws whatever plan it is handed — rooms, doorway openings and labels — as
 * an architect's model: walls at partial height so every room stays visible
 * and labelled from above. Full-height walls are available, but they turn a
 * plan view into a maze of blind boxes.
 *
 * The layout itself is DATA, not code. It arrives from the server's active
 * plan (GET /api/v1/floorplan) and is drawn by the planner at
 * /planner.html, so changing the space means editing a drawing rather than
 * editing this file. The default flat is one plan among others.
 *
 * Geometry conversion lives in ../lib/plan.js and is shared with the server,
 * because the plan's feet-from-the-top-left coordinates and the sensing
 * pipeline's metres-from-the-centre coordinates have to agree exactly or
 * every tracked person lands in the wrong room.
 */

import * as THREE from 'three';

import {
  FT, planBounds, planSizeMetres, toWorld, formatDim,
} from '../lib/plan.js';
import { DEFAULT_FLAT } from '../lib/plans/default-flat.js';

export { FT, planSizeMetres, DEFAULT_FLAT };

const TINT = {
  room:    0x1a2431,
  wet:     0x16202b,
  balcony: 0x121a24,
};

const LABEL_COLOUR = {
  room:    '#7af7bf',
  wet:     '#62b4ff',
  balcony: '#ffbb4d',
};

export class Floorplan {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.plan = opts.plan ?? DEFAULT_FLAT;
    this.group = new THREE.Group();
    this.wallGroup = new THREE.Group();
    this.labelGroup = new THREE.Group();
    this.group.add(this.wallGroup, this.labelGroup);
    scene.add(this.group);

    this.wallHeight = opts.wallHeight ?? 1.15;
    this.build();
  }

  /**
   * Swap in a different layout.
   *
   * Everything derived from the plan — bounds, walls, labels — is rebuilt,
   * so a plan activated in the planner takes effect in the live view without
   * a reload.
   */
  setPlan(plan) {
    if (!plan) return;
    this.plan = plan;
    this.build();
  }

  /** Centre the plan on the world origin so the sensing field lines up. */
  #toWorld(x, z) {
    return toWorld(this.plan, x, z, this.bounds);
  }

  build() {
    this.bounds = planBounds(this.plan);
    this.dispose(false);

    if (!this.bounds) return;

    for (const room of this.plan.rooms ?? []) {
      this.#buildFloor(room);
      this.#buildWalls(room);
      this.#buildLabel(room);
    }
  }

  #buildFloor(room) {
    const [x0, z0] = this.#toWorld(room.x0, room.z0);
    const [x1, z1] = this.#toWorld(room.x1, room.z1);
    const w = Math.abs(x1 - x0);
    const d = Math.abs(z1 - z0);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w - 0.03, d - 0.03),
      new THREE.MeshStandardMaterial({
        color: TINT[room.type] ?? TINT.room,
        roughness: 0.95,
        metalness: 0.02,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((x0 + x1) / 2, 0.002, (z0 + z1) / 2);
    floor.receiveShadow = true;
    floor.userData.roomId = room.id;
    this.group.add(floor);
  }

  /**
   * Subtract a set of gaps from a run, returning the solid spans that remain.
   *
   * @param a0,a1  run extent along its axis, in feet
   * @param gaps   [[g0, g1], ...] in feet, unsorted, possibly overlapping
   */
  #solidSpans(a0, a1, gaps) {
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);

    const clipped = gaps
      .map(([g0, g1]) => [Math.max(lo, Math.min(g0, g1)), Math.min(hi, Math.max(g0, g1))])
      .filter(([g0, g1]) => g1 > g0)
      .sort((p, q) => p[0] - q[0]);

    const spans = [];
    let cursor = lo;
    for (const [g0, g1] of clipped) {
      if (g0 > cursor) spans.push([cursor, g0]);
      cursor = Math.max(cursor, g1);
    }
    if (cursor < hi) spans.push([cursor, hi]);

    // Drop slivers — a 2 cm stub of wall beside a doorway is z-fighting
    // noise, not architecture.
    return spans.filter(([s0, s1]) => s1 - s0 > 0.08);
  }

  /** Doorway gaps that fall on a given wall line, in feet. */
  #gapsOn(dir, fixedFt) {
    const TOL = 0.15;   // feet — walls are shared, so coordinates must match
    return (this.plan.doors ?? [])
      .filter((d) => d.dir === dir && Math.abs(d[dir === 'h' ? 'z' : 'x'] - fixedFt) < TOL)
      .map((d) => {
        const c = dir === 'h' ? d.x : d.z;
        return [c - d.w / 2, c + d.w / 2];
      });
  }

  /**
   * Four wall runs per room, each split around any doorway crossing it.
   *
   * Adjacent rooms produce coincident walls at the same position, which is
   * harmless — they render identically. It is also exactly why doorways are
   * declared globally rather than per-room: one entry opens both sides,
   * with no chance of punching a hole in one room's wall and forgetting the
   * neighbour's.
   */
  #buildWalls(room) {
    const t = 0.075;                       // wall thickness ~ 3 inches
    const isBalcony = room.type === 'balcony';
    const h = isBalcony ? this.wallHeight * 0.62 : this.wallHeight;

    const mat = new THREE.MeshStandardMaterial({
      color: isBalcony ? 0x3a4654 : 0x59677a,
      roughness: 0.85,
      metalness: 0.05,
    });

    const addSegment = (sx, sz, ex, ez) => {
      const [wx0, wz0] = this.#toWorld(sx, sz);
      const [wx1, wz1] = this.#toWorld(ex, ez);
      const w = Math.abs(wx1 - wx0) || t;
      const d = Math.abs(wz1 - wz0) || t;

      const m = new THREE.Mesh(new THREE.BoxGeometry(w + t * 0.5, h, d + t * 0.5), mat);
      m.position.set((wx0 + wx1) / 2, h / 2, (wz0 + wz1) / 2);
      m.castShadow = true;
      m.receiveShadow = true;
      this.wallGroup.add(m);
    };

    // Horizontal runs (top and bottom edges)
    for (const zFt of [room.z0, room.z1]) {
      for (const [s0, s1] of this.#solidSpans(room.x0, room.x1, this.#gapsOn('h', zFt))) {
        addSegment(s0, zFt, s1, zFt);
      }
    }

    // Vertical runs (left and right edges)
    for (const xFt of [room.x0, room.x1]) {
      for (const [s0, s1] of this.#solidSpans(room.z0, room.z1, this.#gapsOn('v', xFt))) {
        addSegment(xFt, s0, xFt, s1);
      }
    }
  }

  /**
   * Room name and dimensions as a camera-facing sprite.
   *
   * depthTest is off so a label is never swallowed by the wall in front of
   * it — an annotation you have to orbit around to read is not doing its job.
   */
  #buildLabel(room) {
    const [x0, z0] = this.#toWorld(room.x0, room.z0);
    const [x1, z1] = this.#toWorld(room.x1, room.z1);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 512, 192);

    // Pill background so the text stays legible over any floor tint.
    ctx.fillStyle = 'rgba(6, 11, 18, 0.72)';
    ctx.strokeStyle = LABEL_COLOUR[room.type] ?? LABEL_COLOUR.room;
    ctx.lineWidth = 3;
    const r = 26;
    ctx.beginPath();
    ctx.moveTo(14 + r, 34);
    ctx.arcTo(498, 34, 498, 158, r);
    ctx.arcTo(498, 158, 14, 158, r);
    ctx.arcTo(14, 158, 14, 34, r);
    ctx.arcTo(14, 34, 498, 34, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = LABEL_COLOUR[room.type] ?? LABEL_COLOUR.room;
    ctx.font = '600 46px Inter, system-ui, sans-serif';
    ctx.fillText(room.label, 256, 92);

    ctx.fillStyle = 'rgba(237, 245, 242, 0.62)';
    ctx.font = '400 30px "JetBrains Mono", monospace';
    ctx.fillText(formatDim(this.plan, room), 256, 136);

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));

    // Scale with the room so a toilet's label does not overflow it.
    const w = Math.abs(x1 - x0);
    const s = Math.max(0.9, Math.min(2.0, w * 0.62));
    sprite.scale.set(s, s * 0.375, 1);
    sprite.position.set((x0 + x1) / 2, this.wallHeight + 0.42, (z0 + z1) / 2);
    sprite.renderOrder = 20;
    sprite.userData.roomId = room.id;

    this.labelGroup.add(sprite);
  }

  /** This plan's footprint in metres — what the sensing field must span. */
  sizeMetres() {
    return planSizeMetres(this.plan);
  }

  setWallHeight(h) {
    this.wallHeight = h;
    this.build();
  }

  setVisibility({ walls = true, labels = true } = {}) {
    this.wallGroup.visible = walls;
    this.labelGroup.visible = labels;
  }

  /**
   * World-space centre and size of every room, for placing one ceiling
   * fixture per room.
   *
   * A single light at the middle of the flat leaves eight rooms in shadow —
   * point-light falloff is quadratic, so a fixture bright enough to reach
   * the far bedroom would blow out the dining room it sits in. Real rooms
   * each have their own light, and so does this model.
   */
  roomAnchors() {
    return (this.plan.rooms ?? []).map((room) => {
      const [x0, z0] = this.#toWorld(room.x0, room.z0);
      const [x1, z1] = this.#toWorld(room.x1, room.z1);
      return {
        id: room.id,
        type: room.type,
        x: (x0 + x1) / 2,
        z: (z0 + z1) / 2,
        w: Math.abs(x1 - x0),
        d: Math.abs(z1 - z0),
        diagonal: Math.hypot(x1 - x0, z1 - z0),
      };
    });
  }

  /** Which room contains this world-space point, or null. */
  roomAt(x, z) {
    for (const room of this.plan.rooms ?? []) {
      const [x0, z0] = this.#toWorld(room.x0, room.z0);
      const [x1, z1] = this.#toWorld(room.x1, room.z1);
      if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1) &&
          z >= Math.min(z0, z1) && z <= Math.max(z0, z1)) {
        return room;
      }
    }
    return null;
  }

  dispose(removeGroup = true) {
    const kill = (obj) => {
      obj.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) { m.map?.dispose(); m.dispose(); }
        }
      });
    };

    for (const child of [...this.group.children]) {
      if (child === this.wallGroup || child === this.labelGroup) continue;
      kill(child);
      this.group.remove(child);
    }
    for (const g of [this.wallGroup, this.labelGroup]) {
      for (const child of [...g.children]) kill(child);
      g.clear();
    }

    if (removeGroup) this.scene.remove(this.group);
  }
}
