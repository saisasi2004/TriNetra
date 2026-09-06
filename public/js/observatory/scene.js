/**
 * Observatory 3D scene.
 *
 * Renders an actual room — walls, floor, trim, a door, a window and
 * furniture — with the sensing data laid over it: the signal field glowing
 * on the floor, wall-mounted nodes, and a figure per tracked person.
 *
 * The room is deliberately real-looking because scale is information. A
 * person "1.8 m from the sofa" means something; a dot on a grid does not.
 * But everything that represents MEASURED data stays visually distinct from
 * the set dressing — data glows, furniture doesn't.
 */

import * as THREE from 'three';
import { Floorplan, planSizeMetres, DEFAULT_FLAT } from './floorplan.js';

const SKELETON_EDGES = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [0, 1], [0, 2], [1, 3], [2, 4], [0, 5], [0, 6],
];

const RAMPS = {
  green:   [[0.0, 0x000000], [0.35, 0x063a20], [0.65, 0x00d878], [1.0, 0xa8ffcf]],
  thermal: [[0.0, 0x000000], [0.35, 0x3a0d5c], [0.65, 0xff6020], [1.0, 0xffe9a0]],
  ice:     [[0.0, 0x000000], [0.35, 0x08284f], [0.65, 0x2090ff], [1.0, 0xd6ecff]],
  mono:    [[0.0, 0x000000], [0.5, 0x555555], [1.0, 0xffffff]],
};

function sampleRamp(ramp, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < ramp.length - 1; i++) {
    const [t0, c0] = ramp[i];
    const [t1, c1] = ramp[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return new THREE.Color(c0).lerp(new THREE.Color(c1), f);
    }
  }
  return new THREE.Color(ramp[ramp.length - 1][1]);
}

export class ObservatoryScene {
  /** Warn once, not once per tick, if the server's room size disagrees. */
  #warnedMismatch = false;

  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.opts = {
      orbit: true,
      orbitSpeed: 0.10,
      fov: 50,
      showRoom: true,
      showLabels: true,
      planView: false,
      wallHeight: 1.15,
      showNodes: true,
      showSkeleton: true,
      showBody: true,
      showTrails: true,
      showUncertainty: true,
      fieldOpacity: 0.7,
      fieldHeight: 0.28,
      waves: 0.5,
      boneThickness: 0.022,
      jointSize: 0.038,
      wireColor: '#00d878',
      jointColor: '#ff4060',
      ramp: 'green',
      lightLevel: 0.75,
      shadows: true,
      ...options,
    };

    // The plan defines the space, not the server. The server adopts the
    // active plan's footprint as its room size, so the two now agree by
    // construction rather than by the operator remembering --room-size.
    this.planData = this.opts.plan ?? DEFAULT_FLAT;
    this.dims = planSizeMetres(this.planData);
    this.figures = new Map();
    this.nodeMeshes = new Map();
    this.waveRings = [];
    this.clock = new THREE.Clock();
    this.orbitAngle = 0.75;
    this.paused = false;

    this.#initRenderer();
    this.#initScene();
    this.#initLights();

    this.plan = new Floorplan(this.scene, {
      wallHeight: this.opts.wallHeight,
      plan: this.planData,
    });
    this.#buildField();
    this.#buildRoomLights();
    this.#positionLights();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.#initPointerControls();
  }

  // ── Setup ──────────────────────────────────────────────────────────

  #initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x070a10, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  #initScene() {
    this.scene = new THREE.Scene();
    // Very light fog: enough to sink the far corners into shadow, not enough
    // to wash out the field.
    this.scene.fog = new THREE.FogExp2(0x070a10, 0.022);

    this.camera = new THREE.PerspectiveCamera(this.opts.fov, 1, 0.05, 200);
    this.cameraTarget = new THREE.Vector3(0, 1.0, 0);
    this.cameraRadius = 8.0;
    this.cameraHeight = 3.4;
    this.#updateCamera();

    // Straight-down orthographic view, for comparing the model against the
    // architectural drawing 1:1. Perspective makes walls lean and distances
    // read wrong, which is exactly the wrong tool for checking a layout.
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.orthoCamera.position.set(0, 30, 0);
    this.orthoCamera.up.set(0, 0, -1);      // plan "up" = the plan's top edge
    this.orthoCamera.lookAt(0, 0, 0);
  }

  #initLights() {
    // Ambient bounce: cool from above, near-black from the floor.
    this.hemi = new THREE.HemisphereLight(0x2c3f55, 0x080c12, 0.75);
    this.scene.add(this.hemi);

    // One ceiling fixture per room is built later, once the floor plan
    // exists — see #buildRoomLights().
    this.roomLights = [];

    // Cool daylight from outside, opposing the warm interior. The colour
    // contrast between the two is what stops the render looking flat.
    this.windowLight = new THREE.DirectionalLight(0x6ea8ff, 0.45);
    this.windowLight.position.set(8, 6, 3);
    this.windowLight.target.position.set(0, 0, 0);
    this.scene.add(this.windowLight);
    this.scene.add(this.windowLight.target);

    // Faint green bounce from the sensing field itself.
    this.fieldGlow = new THREE.PointLight(0x00d878, 1.2, 7, 2);
    this.fieldGlow.position.set(0, 0.25, 0);
    this.scene.add(this.fieldGlow);
  }

  /**
   * The server tells us how big it thinks the space is. The PLAN is the
   * truth about geometry, so we only use the server's dimensions to size the
   * sensing field — and complain loudly if they disagree, because a field
   * scaled to 6x5 m painted across an 8x11 m flat puts every detection in
   * the wrong room.
   */
  setRoom(width, height, depth) {
    if (this.#warnedMismatch) return;

    const dw = Math.abs(width - this.dims.width);
    const dd = Math.abs(depth - this.dims.depth);

    if (dw > 0.3 || dd > 0.3) {
      this.#warnedMismatch = true;
      const p = planSizeMetres(this.planData);
      console.warn(
        `[TriNetra] Server room is ${width}x${depth} m but the floor plan is ` +
        `${p.width.toFixed(2)}x${p.depth.toFixed(2)} m. Positions will not ` +
        `line up. This normally means the server was started with an ` +
        `explicit --room-size, which overrides the active plan. Either drop ` +
        `that flag and let the plan define the space, or pass:\n` +
        `  --room-size ${p.width.toFixed(2)},${p.depth.toFixed(2)},${p.height}`,
      );
    }
  }

  /**
   * Swap the layout the scene is drawn around.
   *
   * Everything sized from the plan has to be rebuilt together: the walls, the
   * field mesh that spans the footprint, the per-room ceiling lights, and the
   * camera distance. Rebuilding only some of them is how you get a field
   * painted across the wrong footprint, which puts every detection in the
   * wrong room — the exact failure `setRoom` above exists to shout about.
   */
  setPlan(plan) {
    if (!plan) return;

    // The live payload names the active plan on every tick. Rebuilding the
    // whole scene ten times a second would make the view unusable, so only a
    // genuine change gets through.
    if (plan.id && plan.id === this.planData?.id &&
        (plan.rooms?.length ?? 0) === (this.planData?.rooms?.length ?? 0)) {
      return;
    }

    this.planData = plan;
    this.dims = planSizeMetres(plan);
    this.#warnedMismatch = false;

    this.plan.setPlan(plan);
    this.#buildField();
    this.#buildRoomLights();
    this.#positionLights();
    this.resetView();
  }

  /**
   * A ceiling fixture in every room.
   *
   * Point-light falloff is quadratic, so one central light bright enough to
   * reach the far bedroom would blow out the room it hangs in. Each room
   * gets its own, with range tied to that room's diagonal and colour to its
   * use — warm tungsten for living spaces, cool white for wet rooms, and a
   * dim blue-grey for balconies so they read as outside.
   *
   * Exactly one fixture casts shadows: the largest living room. Nine shadow
   * maps would cost roughly nine times the fill rate for detail nobody is
   * examining, on a laptop that is also running the sensing server.
   */
  #buildRoomLights() {
    for (const l of this.roomLights) {
      this.scene.remove(l.light);
      l.light.dispose?.();
    }
    this.roomLights.length = 0;

    const anchors = this.plan.roomAnchors();
    const biggest = anchors
      .filter((a) => a.type === 'room')
      .sort((a, b) => b.w * b.d - a.w * a.d)[0];

    const PROFILE = {
      room:    { colour: 0xffe0b8, base: 5.0, height: 2.45 },
      wet:     { colour: 0xdcecff, base: 3.0, height: 2.30 },
      balcony: { colour: 0x9fc4e8, base: 2.0, height: 2.30 },
    };

    for (const a of anchors) {
      const p = PROFILE[a.type] ?? PROFILE.room;

      // Range must clear the far corner, or the room's own edges go black.
      const range = a.diagonal * 0.95 + 1.4;
      const light = new THREE.PointLight(p.colour, p.base, range, 1.8);
      light.position.set(a.x, Math.min(p.height, this.dims.height - 0.25), a.z);

      if (biggest && a.id === biggest.id) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.bias = -0.004;
        light.shadow.camera.near = 0.3;
        light.shadow.camera.far = range;
      }

      this.scene.add(light);
      this.roomLights.push({ light, anchor: a, base: p.base });
    }
    // No visible fixture geometry: with the ceiling off, a disc at ceiling
    // height has nothing to sit against and reads as a grey ellipse floating
    // in mid-air. The light itself is the only cue that belongs here.
  }

  #positionLights() {
    const { width: w, depth: d, height: h } = this.dims;
    this.windowLight.position.set(w, h * 2, d * 0.3);
    this.cameraRadius = Math.max(7, Math.max(w, d) * 1.25);
    this.cameraHeight = Math.max(4, Math.max(w, d) * 0.6);
  }

  /**
   * The signal field: a subdivided plane just above the floor whose vertex
   * colours and heights come from the server grid.
   *
   * Height as well as colour, because a flat heatmap reads as a texture
   * painted on the floor whereas a surface reads as a measurement sitting
   * in the room. Kept low so it never obscures the furniture.
   */
  #buildField() {
    if (this.fieldMesh) {
      this.scene.remove(this.fieldMesh);
      this.fieldMesh.geometry.dispose();
      this.fieldMesh.material.dispose();
    }

    this.fieldSegX = 55;
    this.fieldSegZ = 47;

    const geo = new THREE.PlaneGeometry(
      this.dims.width * 0.995, this.dims.depth * 0.995,
      this.fieldSegX, this.fieldSegZ,
    );
    geo.rotateX(-Math.PI / 2);

    const count = geo.attributes.position.count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this.opts.fieldOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.fieldMesh = new THREE.Mesh(geo, mat);
    this.fieldMesh.position.y = 0.012;
    this.fieldMesh.renderOrder = 2;
    this.scene.add(this.fieldMesh);
  }

  #initPointerControls() {
    let dragging = false;
    let lastX = 0, lastY = 0;

    const pos = (e) => ({
      x: e.clientX ?? e.touches?.[0]?.clientX,
      y: e.clientY ?? e.touches?.[0]?.clientY,
    });

    const down = (e) => {
      const p = pos(e);
      if (p.x == null) return;
      dragging = true; lastX = p.x; lastY = p.y;
    };
    const move = (e) => {
      if (!dragging) return;
      const p = pos(e);
      if (p.x == null) return;
      this.orbitAngle -= (p.x - lastX) * 0.006;
      this.cameraHeight = Math.max(0.35, Math.min(12, this.cameraHeight + (p.y - lastY) * 0.02));
      lastX = p.x; lastY = p.y;
      // Manual interaction stops auto-orbit; fighting the camera is the
      // fastest way to make a 3D view feel broken.
      this.opts.orbit = false;
      this.onOrbitDisabled?.();
    };
    const up = () => { dragging = false; };

    this.canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    this.canvas.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cameraRadius = Math.max(1.5, Math.min(24, this.cameraRadius + e.deltaY * 0.006));
    }, { passive: false });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.fov = this.opts.fov;
    this.camera.updateProjectionMatrix();

    // Fit the whole plan with a small margin, preserving aspect so nothing
    // is stretched — a distorted plan view is worse than none.
    const margin = 1.12;
    const planW = this.dims.width * margin;
    const planD = this.dims.depth * margin;
    const scale = Math.max(planW / w, planD / h);

    this.orthoCamera.left = (-w * scale) / 2;
    this.orthoCamera.right = (w * scale) / 2;
    this.orthoCamera.top = (h * scale) / 2;
    this.orthoCamera.bottom = (-h * scale) / 2;
    this.orthoCamera.updateProjectionMatrix();
  }

  resetView() {
    this.orbitAngle = 0.75;
    this.cameraRadius = Math.max(6, Math.max(this.dims.width, this.dims.depth) * 1.5);
    this.cameraHeight = 3.4;
    this.opts.orbit = true;
  }

  #updateCamera() {
    const r = this.cameraRadius;
    this.camera.position.set(
      Math.sin(this.orbitAngle) * r,
      this.cameraHeight,
      Math.cos(this.orbitAngle) * r,
    );
    this.camera.lookAt(this.cameraTarget);
  }

  // ── Data in ────────────────────────────────────────────────────────

  update(payload) {
    if (!payload) return;

    const sf = payload.signal_field;
    if (sf?.room) this.setRoom(sf.room[0], sf.room[1], sf.room[2]);
    if (sf) this.#updateField(sf);

    this.#updateNodes(payload.nodes ?? []);
    this.#updateFigures(payload.persons ?? []);
  }

  #updateField(sf) {
    if (!this.fieldMesh) return;

    const [gx, , gz] = sf.grid_size;
    const values = sf.values;
    if (!values?.length) return;

    const geo = this.fieldMesh.geometry;
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    const ramp = RAMPS[this.opts.ramp] ?? RAMPS.green;

    const vx = this.fieldSegX + 1;
    const vz = this.fieldSegZ + 1;
    let peak = 0, peakX = 0, peakZ = 0;

    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        // Bilinear sample of the server grid into the render mesh, so the
        // surface stays smooth when the two resolutions differ.
        const fx = (i / (vx - 1)) * (gx - 1);
        const fz = (j / (vz - 1)) * (gz - 1);
        const x0 = Math.floor(fx), z0 = Math.floor(fz);
        const x1 = Math.min(gx - 1, x0 + 1), z1 = Math.min(gz - 1, z0 + 1);
        const tx = fx - x0, tz = fz - z0;

        const v = (values[z0 * gx + x0] * (1 - tx) + values[z0 * gx + x1] * tx) * (1 - tz)
                + (values[z1 * gx + x0] * (1 - tx) + values[z1 * gx + x1] * tx) * tz;

        const idx = j * vx + i;
        // Cubed so weak ambient values stay flat on the floor and only
        // genuine detections lift — a linear map makes noise look like data.
        pos.setY(idx, v * v * v * this.opts.fieldHeight);

        const c = sampleRamp(ramp, v);
        col.setXYZ(idx, c.r, c.g, c.b);

        if (v > peak) {
          peak = v;
          peakX = (i / (vx - 1) - 0.5) * this.dims.width;
          peakZ = (j / (vz - 1) - 0.5) * this.dims.depth;
        }
      }
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.fieldMesh.material.opacity = this.opts.fieldOpacity;
    this.fieldMesh.visible = this.opts.fieldOpacity > 0.01;

    // Let the field cast a faint coloured bounce into the room.
    this.fieldGlow.position.set(peakX, 0.3, peakZ);
    this.fieldGlow.intensity = peak * 2.2;
  }

  /** Nodes as small wall-mounted enclosures with a status LED. */
  #makeNode() {
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.052, 0.028),
      new THREE.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.55 }),
    );
    body.castShadow = true;
    group.add(body);

    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x00d878 }),
    );
    led.position.set(0.026, 0.014, 0.016);
    group.add(led);

    // Soft halo that swells with motion energy — the node's own readout.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 14, 14),
      new THREE.MeshBasicMaterial({
        color: 0x00d878, transparent: true, opacity: 0.1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    group.add(halo);

    const bracket = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.02, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x4a5460, roughness: 0.6 }),
    );
    bracket.position.z = -0.026;
    group.add(bracket);

    this.scene.add(group);
    return { group, body, led, halo };
  }

  #updateNodes(nodes) {
    const seen = new Set();
    const { width: w, depth: d } = this.dims;

    for (const n of nodes) {
      seen.add(n.node_id);
      let mesh = this.nodeMeshes.get(n.node_id);
      if (!mesh) {
        mesh = this.#makeNode();
        this.nodeMeshes.set(n.node_id, mesh);
      }

      const [x, y, z] = n.position;
      // Pull the enclosure flush to whichever wall it is nearest, and face it
      // into the room. Nodes floating in mid-air look like a diagram; nodes
      // on walls look installed.
      const dxWall = Math.min(Math.abs(x - w / 2), Math.abs(x + w / 2));
      const dzWall = Math.min(Math.abs(z - d / 2), Math.abs(z + d / 2));

      let px = x, pz = z, ry = 0;
      if (dxWall < dzWall) {
        px = Math.sign(x) * (w / 2 - 0.02);
        ry = -Math.sign(x) * Math.PI / 2;
      } else {
        pz = Math.sign(z) * (d / 2 - 0.02);
        ry = z > 0 ? Math.PI : 0;
      }

      mesh.group.position.set(px, y, pz);
      mesh.group.rotation.y = ry;
      mesh.group.visible = this.opts.showNodes;

      const colour = !n.online ? 0x445060
        : n.calibrating ? 0xffb020
        : n.presence ? 0x3eff8a : 0x0e7a44;

      mesh.led.material.color.setHex(colour);
      mesh.halo.material.color.setHex(colour);
      mesh.halo.material.opacity = 0.05 + (n.motion_energy ?? 0) * 0.22;
      mesh.halo.scale.setScalar(0.8 + (n.motion_energy ?? 0) * 1.4);
    }

    for (const [id, mesh] of this.nodeMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh.group);
        this.nodeMeshes.delete(id);
      }
    }
  }

  #makeFigure() {
    const group = new THREE.Group();

    const jointGeo = new THREE.SphereGeometry(1, 10, 10);
    const joints = [];
    for (let i = 0; i < 17; i++) {
      const j = new THREE.Mesh(jointGeo, new THREE.MeshBasicMaterial({
        color: this.opts.jointColor, transparent: true,
      }));
      group.add(j);
      joints.push(j);
    }

    const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
    const bones = [];
    for (let i = 0; i < SKELETON_EDGES.length; i++) {
      const b = new THREE.Mesh(boneGeo, new THREE.MeshBasicMaterial({
        color: this.opts.wireColor,
      }));
      group.add(b);
      bones.push(b);
    }

    // Translucent body volume. The skeleton alone reads as floating dots;
    // a soft silhouette around it reads as a person standing in the room.
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.26, 1.05, 6, 14),
      new THREE.MeshStandardMaterial({
        color: 0x9fe8c4, transparent: true, opacity: 0.14,
        roughness: 1.0, depthWrite: false,
      }),
    );
    group.add(body);

    // Contact shadow — a person with no shadow floats. This one is fake and
    // cheap, but it plants the figure on the floor better than a real shadow
    // map at this size would.
    const contact = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false,
      }),
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = 0.006;
    group.add(contact);

    const disc = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffb020, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    group.add(disc);

    const discFill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffb020, transparent: true, opacity: 0.05,
        side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    discFill.rotation.x = -Math.PI / 2;
    discFill.position.y = 0.016;
    group.add(discFill);

    const trail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.5 }),
    );
    group.add(trail);

    this.scene.add(group);
    return { group, joints, bones, body, contact, disc, discFill, trail };
  }

  #updateFigures(persons) {
    const seen = new Set();

    for (const p of persons) {
      seen.add(p.id);
      let fig = this.figures.get(p.id);
      if (!fig) {
        fig = this.#makeFigure();
        this.figures.set(p.id, fig);
      }

      const kp = p.keypoints ?? [];
      const hasPose = kp.length === 17;
      const showSkeleton = this.opts.showSkeleton && hasPose;
      const [px, , pz] = p.position;

      for (let i = 0; i < fig.joints.length; i++) {
        const j = fig.joints[i];
        if (!showSkeleton) { j.visible = false; continue; }
        const [x, y, z, c] = kp[i];
        j.visible = true;
        j.position.set(x, y, z);
        j.scale.setScalar(this.opts.jointSize);
        j.material.color.set(this.opts.jointColor);
        j.material.opacity = 0.45 + c * 0.55;
      }

      for (let i = 0; i < fig.bones.length; i++) {
        const b = fig.bones[i];
        if (!showSkeleton) { b.visible = false; continue; }

        const [a, bIdx] = SKELETON_EDGES[i];
        const pa = new THREE.Vector3(kp[a][0], kp[a][1], kp[a][2]);
        const pb = new THREE.Vector3(kp[bIdx][0], kp[bIdx][1], kp[bIdx][2]);
        const mid = pa.clone().add(pb).multiplyScalar(0.5);
        const dir = pb.clone().sub(pa);
        const len = dir.length();

        b.visible = true;
        b.position.copy(mid);
        b.scale.set(this.opts.boneThickness, len, this.opts.boneThickness);
        b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        b.material.color.set(this.opts.wireColor);
      }

      // Body volume, posed to match the coarse posture we actually measure.
      const lying = p.posture === 'lying';
      const sitting = p.posture === 'sitting';
      fig.body.visible = this.opts.showBody;
      fig.body.material.color.set(this.opts.wireColor);
      if (lying) {
        fig.body.rotation.set(Math.PI / 2, 0, 0);
        fig.body.position.set(px, 0.28, pz);
        fig.body.scale.set(1, 1, 1);
      } else if (sitting) {
        fig.body.rotation.set(0, 0, 0);
        fig.body.position.set(px, 0.72, pz);
        fig.body.scale.set(1, 0.68, 1);
      } else {
        fig.body.rotation.set(0, 0, 0);
        fig.body.position.set(px, 0.92, pz);
        fig.body.scale.set(1, 1, 1);
      }

      fig.contact.position.set(px, 0.006, pz);
      fig.contact.scale.setScalar(lying ? 1.5 : 1);
      fig.contact.material.opacity = 0.2 + (p.confidence ?? 0) * 0.3;

      const r = Math.max(0.25, p.position_uncertainty_m ?? 1.0);
      fig.disc.position.set(px, 0.02, pz);
      fig.disc.scale.setScalar(r);
      fig.discFill.position.set(px, 0.016, pz);
      fig.discFill.scale.setScalar(r);

      const discColour = p.position_quality === 'good' ? 0x00d878
        : p.position_quality === 'coarse' ? 0xffb020 : 0xff6a3a;
      fig.disc.material.color.setHex(discColour);
      fig.discFill.material.color.setHex(discColour);
      fig.disc.visible = this.opts.showUncertainty;
      fig.discFill.visible = this.opts.showUncertainty;

      if (this.opts.showTrails && p.trail?.length > 1) {
        const pts = p.trail.map(([tx, tz]) => new THREE.Vector3(tx, 0.03, tz));
        fig.trail.geometry.dispose();
        fig.trail.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        fig.trail.visible = true;
      } else {
        fig.trail.visible = false;
      }
    }

    for (const [id, fig] of this.figures) {
      if (!seen.has(id)) {
        this.scene.remove(fig.group);
        fig.trail.geometry.dispose();
        this.figures.delete(id);
      }
    }
  }

  emitWave(x, z, colour = 0x00d878) {
    if (this.opts.waves < 0.02) return;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.11, 40),
      new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.35 * this.opts.waves,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.05, z);
    ring.userData.age = 0;
    this.scene.add(ring);
    this.waveRings.push(ring);
  }

  #updateWaves(dt) {
    for (let i = this.waveRings.length - 1; i >= 0; i--) {
      const ring = this.waveRings[i];
      ring.userData.age += dt;
      const a = ring.userData.age;
      ring.scale.setScalar(1 + a * 11);
      ring.material.opacity = Math.max(0, (0.35 - a * 0.14) * this.opts.waves);
      if (a > 2.6) {
        this.scene.remove(ring);
        ring.geometry.dispose();
        ring.material.dispose();
        this.waveRings.splice(i, 1);
      }
    }
  }

  // ── Frame loop ─────────────────────────────────────────────────────

  render() {
    const dt = this.clock.getDelta();
    if (this.paused) { this.renderer.render(this.scene, this.camera); return; }

    if (this.opts.orbit) this.orbitAngle += dt * this.opts.orbitSpeed;
    this.#updateCamera();
    this.#updateWaves(dt);

    this.plan.setVisibility({
      walls: this.opts.showRoom,
      labels: this.opts.showLabels,
    });
    if (Math.abs(this.plan.wallHeight - this.opts.wallHeight) > 0.01) {
      this.plan.setWallHeight(this.opts.wallHeight);
    }

    // Plan view flattens everything: a drawing you are checking dimensions
    // against should carry no depth cues at all.
    const plan = this.opts.planView;
    const L = this.opts.lightLevel;

    this.hemi.intensity = plan ? 1.8 : 0.28 + L * 0.5;
    this.windowLight.intensity = plan ? 0.35 : 0.10 + L * 0.45;

    for (const entry of this.roomLights) {
      entry.light.intensity = plan ? 0 : entry.base * (0.35 + L * 1.3);
    }

    this.renderer.shadowMap.enabled = this.opts.shadows && !plan;

    this.renderer.render(this.scene, plan ? this.orthoCamera : this.camera);
  }

  setPaused(v) { this.paused = v; }

  dispose() {
    this.plan.dispose();
    this.renderer.dispose();
  }
}
