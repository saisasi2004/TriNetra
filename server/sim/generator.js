/**
 * CSI simulator.
 *
 * Simulates BODIES and the radio physics around them, then emits CSI frames
 * in the real wire format. It does not simulate outputs — presence, vitals,
 * person tracks and semantic states are all derived by the same DSP that
 * processes hardware frames.
 *
 * The model, per (node, subcarrier):
 *
 *   - a static line-of-sight component (the empty room)
 *   - one reflected path per person, whose length changes with their
 *     position, and modulates with chest displacement at the breathing rate
 *     and a smaller cardiac component
 *   - path loss with distance, plus optional through-wall attenuation
 *   - subcarrier-dependent phase from the path-length difference, which is
 *     what makes different subcarriers respond differently
 *   - a hardware phase ramp (STO/CFO) and AGC noise, so the server's
 *     sanitisation code has something real to remove
 *
 * Chest displacement is ~5 mm, which at 2.4 GHz (lambda = 125 mm) is a phase
 * swing of 2*pi*2*0.005/0.125 ≈ 0.5 rad. That is the actual number the real
 * system works with, so it is the number used here.
 */

import { encodeCsi } from '../net/protocol.js';
import { getScenario, SCENARIO_IDS } from './scenarios.js';

const C = 299_792_458;
const CHEST_DISPLACEMENT_M = 0.005;
const HEART_DISPLACEMENT_M = 0.0004;   // ~0.4 mm, an order below breathing

/**
 * Seeded PRNG (mulberry32).
 *
 * The simulator must be reproducible. An unseeded Math.random() makes every
 * run a different room, which turns any assertion about the output into a
 * coin flip and makes a real regression indistinguishable from bad luck. A
 * seed also lets a user replay the exact scenario that produced a result.
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SimPerson {
  constructor(spec, room, rng = Math.random) {
    this.spec = spec;
    this.room = room;
    this.rng = rng;
    this.name = spec.name ?? 'person';
    this.x = spec.position?.[0] ?? 0;
    this.z = spec.position?.[1] ?? 0;
    this.posture = spec.posture ?? 'standing';
    this.breathingBpm = spec.breathingBpm ?? 15;
    this.heartBpm = spec.heartBpm ?? 70;
    this.attenuation = spec.attenuation ?? 1.0;
    this.motionScale = spec.motionScale ?? 1.0;
    this.visible = true;
    this.apneaUntil = 0;

    this.breathPhase = this.rng() * Math.PI * 2;
    this.heartPhase = this.rng() * Math.PI * 2;
    this.pathIndex = 0;
    this.t = 0;
    this.impulse = 0;              // transient from a fall
    this.targetX = this.x;
    this.targetZ = this.z;
    this.speed = spec.speed ?? 0.6;
    this.jitter = spec.jitter ?? 0;
    this.scriptIndex = 0;
  }

  step(dt) {
    this.t += dt;

    // Breathing / heart phase advance at their own rates.
    if (this.t >= this.apneaUntil) {
      this.breathPhase += dt * (this.breathingBpm / 60) * Math.PI * 2;
    }
    this.heartPhase += dt * (this.heartBpm / 60) * Math.PI * 2;
    this.impulse *= 0.82;

    switch (this.spec.motion) {
      case 'patrol':   this.#stepPatrol(dt); break;
      case 'wander':   this.#stepWander(dt); break;
      case 'oscillate': this.#stepOscillate(dt); break;
      case 'scripted': this.#stepScript(dt); break;
      case 'still':
      default:         this.#stepStill(dt); break;
    }

    // Keep everyone inside the room.
    const hw = this.room.width / 2 - 0.2;
    const hd = this.room.depth / 2 - 0.2;
    this.x = Math.max(-hw, Math.min(hw, this.x));
    this.z = Math.max(-hd, Math.min(hd, this.z));
  }

  #stepStill(dt) {
    // Even a "still" person sways slightly. Without this the simulated
    // signal is unnaturally clean and presence detection looks better than
    // it ever is in a real room.
    this.x += (this.rng() - 0.5) * 0.004;
    this.z += (this.rng() - 0.5) * 0.004;
    void dt;
  }

  #stepPatrol(dt) {
    const path = this.spec.path ?? [[0, 0]];
    const [tx, tz] = path[this.pathIndex % path.length];
    const dx = tx - this.x, dz = tz - this.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.15) {
      this.pathIndex = (this.pathIndex + 1) % path.length;
      return;
    }
    const step = this.speed * dt;
    this.x += (dx / dist) * step + (this.rng() - 0.5) * this.jitter * dt;
    this.z += (dz / dist) * step + (this.rng() - 0.5) * this.jitter * dt;
  }

  #stepWander(dt) {
    if (Math.hypot(this.targetX - this.x, this.targetZ - this.z) < 0.2) {
      this.targetX = (this.rng() - 0.5) * (this.room.width - 1);
      this.targetZ = (this.rng() - 0.5) * (this.room.depth - 1);
    }
    const dx = this.targetX - this.x, dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz) || 1;
    this.x += (dx / dist) * this.speed * dt;
    this.z += (dz / dist) * this.speed * dt;
  }

  #stepOscillate(dt) {
    const a = this.spec.amplitude ?? 0.3;
    const f = this.spec.frequency ?? 0.6;
    const base = this.spec.position ?? [0, 0];
    this.x = base[0] + Math.sin(this.t * f * Math.PI * 2) * a;
    this.z = base[1] + Math.cos(this.t * f * Math.PI * 2 * 0.7) * a * 0.4;
    void dt;
  }

  #stepScript(dt) {
    const script = this.spec.script ?? [];
    while (this.scriptIndex < script.length && script[this.scriptIndex].at <= this.t) {
      const step = script[this.scriptIndex];
      this.#applyScriptStep(step);
      this.scriptIndex++;
    }

    // Walk toward the current scripted target.
    const dx = this.targetX - this.x, dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.08) {
      this.x += (dx / dist) * this.speed * dt;
      this.z += (dz / dist) * this.speed * dt;
    }
  }

  #applyScriptStep(step) {
    switch (step.action) {
      case 'walk':
        this.visible = true;
        this.posture = 'walking';
        this.targetX = step.to[0];
        this.targetZ = step.to[1];
        this.speed = step.speed ?? 0.7;
        break;
      case 'stand':
        this.posture = 'standing';
        this.targetX = this.x; this.targetZ = this.z;
        break;
      case 'fall':
        // A fall is a large, brief displacement impulse followed by
        // stillness — precisely what the detector's phase-acceleration
        // plus stillness-confirmation logic looks for.
        this.posture = 'lying';
        this.impulse = 6.0;
        this.targetX = this.x; this.targetZ = this.z;
        break;
      case 'lie':
        this.posture = 'lying';
        this.targetX = this.x; this.targetZ = this.z;
        if (step.breathingBpm) this.breathingBpm = step.breathingBpm;
        if (step.heartBpm) this.heartBpm = step.heartBpm;
        break;
      case 'apnea':
        this.apneaUntil = this.t + (step.durationS ?? 12);
        break;
      case 'hide':
        this.visible = false;
        break;
      default:
        break;
    }
    if (step.action !== 'hide') this.visible = true;
  }

  /** Chest surface displacement in metres at this instant. */
  displacement() {
    const inApnea = this.t < this.apneaUntil;
    const breath = inApnea ? 0 : Math.sin(this.breathPhase) * CHEST_DISPLACEMENT_M;
    const heart = Math.sin(this.heartPhase) * HEART_DISPLACEMENT_M;
    return breath + heart;
  }

  /** Reflection cross-section: a standing body reflects more than a lying one. */
  crossSection() {
    const base = this.posture === 'lying' ? 0.55
      : this.posture === 'sitting' ? 0.75
      : 1.0;
    return base * this.attenuation;
  }
}

export class CsiSimulator {
  /**
   * @param nodes  [{ nodeId, position: [x,y,z] }]
   */
  constructor({
    room, nodes, scenario = 'auto', cycleSeconds = 30, rateHz = 20,
    warmupSeconds = 0, seed = null,
  }) {
    this.room = room;
    this.nodes = nodes;
    this.rateHz = rateHz;
    this.seed = seed;
    // A null seed means "different every run", which is what a live demo
    // wants; tests pass an explicit seed so failures are reproducible.
    this.rng = seed == null ? Math.random : makeRng(seed);
    this.nSubcarriers = 56;
    this.freqMhz = 2437;
    this.cycleSeconds = cycleSeconds;

    // The room must be EMPTY while the nodes learn their ambient baseline.
    // If people are present during calibration, the baseline absorbs them,
    // "occupied" becomes the definition of normal, and presence can never
    // fire again. This is the single most common way a real WiFi-sensing
    // install is broken on day one, so the simulator reproduces the correct
    // procedure rather than papering over it.
    this.warmupSeconds = warmupSeconds;

    this.autoCycle = scenario === 'auto';
    this.scenarioStartedAt = 0;
    this.t = 0;
    this.sequence = 0;
    this.people = [];

    this.setScenario(this.autoCycle ? 'single_breathing' : scenario);
  }

  /**
   * @param id  a scenario id, or an inline scenario object. The inline form
   *            lets a test place a body at a chosen spot without registering
   *            a global scenario, which is what localisation tests need.
   */
  setScenario(id) {
    const inline = id && typeof id === 'object' && Array.isArray(id.people);
    const scenario = inline ? id : getScenario(id);

    // Report the scenario that is actually RUNNING, not the one that was
    // requested. Keeping the requested name after a fallback makes the UI,
    // the API and every recording header claim something untrue.
    this.scenarioId = inline ? (id.id ?? 'inline')
      : SCENARIO_IDS.includes(id) ? id
      : 'single_breathing';
    this.scenario = scenario;
    this.people = scenario.people.map((p) => new SimPerson(p, this.room, this.rng));
    this.scenarioStartedAt = this.t;
  }

  setAutoCycle(enabled) { this.autoCycle = enabled; }

  /** True while the nodes are still learning their empty-room baseline. */
  get warmup() { return this.t < this.warmupSeconds; }

  get scenarioIds() {
    return SCENARIO_IDS;
  }

  /**
   * Advance the world and produce one CSI frame per node.
   * @returns Buffer[] ready to feed straight into the packet decoder
   */
  step(dt = 1 / this.rateHz) {
    this.t += dt;

    if (this.warmup) {
      // Empty room. Emit calibration frames with no bodies in them, and hold
      // the scenario clock at zero so the scenario starts from its first
      // second once calibration completes.
      this.sequence++;
      this.scenarioStartedAt = this.t;
      return this.nodes.map((node) =>
        this.#frameForNode(node, Math.round(this.t * 1000), true),
      );
    }

    if (this.autoCycle && this.t - this.scenarioStartedAt > this.cycleSeconds) {
      const idx = SCENARIO_IDS.indexOf(this.scenarioId);
      this.setScenario(SCENARIO_IDS[(idx + 1) % SCENARIO_IDS.length]);
    }

    for (const p of this.people) p.step(dt);

    this.sequence++;
    const timestampMs = Math.round(this.t * 1000);

    return this.nodes.map((node) =>
      this.#frameForNode(node, timestampMs, false),
    );
  }

  #frameForNode(node, timestampMs, empty = false) {
    const N = this.nSubcarriers;
    const amplitude = new Float64Array(N);
    const phase = new Float64Array(N);

    const [nx, , nz] = node.position;

    // Subcarrier centre frequencies: 20 MHz channel, 312.5 kHz spacing.
    const f0 = this.freqMhz * 1e6;
    const spacing = 312.5e3;

    // Static line-of-sight component — the empty room.
    // Set near the top of the int8 range on purpose. CSI travels as signed
    // 8-bit I/Q pairs, so the finest phase the receiver can express is about
    // 1/|amplitude| radians. At amplitude 26 that is 0.038 rad — larger than
    // the ~0.048 rad phase swing a breathing chest produces, so quantisation
    // noise alone buries the vital signs. A real receiver's AGC targets full
    // scale for exactly this reason; the simulator must do the same or it
    // models a radio nobody ships.
    const losAmp = 88;

    let totalReflected = 0;

    for (let i = 0; i < N; i++) {
      const f = f0 + (i - N / 2) * spacing;
      const lambda = C / f;

      // Start from the static component with a small subcarrier-dependent
      // fade, so the empty room is not perfectly flat.
      let re = losAmp * Math.cos(i * 0.03);
      let im = losAmp * Math.sin(i * 0.03);

      for (const person of empty ? [] : this.people) {
        if (!person.visible) continue;

        // Two-segment reflected path: node -> body -> node (monostatic).
        const d = Math.hypot(person.x - nx, person.z - nz);
        const pathLen = 2 * Math.max(0.4, d) + person.displacement() * 2;

        // Free-space path loss, with the body's cross-section and any
        // through-wall attenuation folded in.
        // Scaled with losAmp so the MODULATION DEPTH stays physical (~5-10%
        // of the static component); only the quantisation headroom improves.
        const gain = (40 * person.crossSection()) / (1 + d * d * 0.45);

        // Fall impulse: a brief large phase excursion.
        const impulse = person.impulse * 0.35;

        const ph = (-2 * Math.PI * pathLen) / lambda + impulse;
        re += gain * Math.cos(ph);
        im += gain * Math.sin(ph);
        totalReflected += gain;
      }

      // Hardware artefacts the server's sanitizePhase() exists to remove:
      // a linear STO ramp across subcarriers plus a constant CFO offset.
      const stoRamp = 0.11 * i + 0.4;

      // AGC / thermal noise. Amplitude noise is multiplicative, phase noise
      // additive — matching how the real radio misbehaves.
      const ampNoise = 1 + (this.rng() - 0.5) * 0.06;
      const phNoise = (this.rng() - 0.5) * 0.05;

      const a = Math.hypot(re, im) * ampNoise;
      const p = Math.atan2(im, re) + stoRamp + phNoise;

      // Occasional AGC spike — this is what the Hampel filter is for. Leaving
      // it out would make the pipeline look more robust than it is.
      const spike = this.rng() < 0.004 ? 2.2 : 1;

      amplitude[i] = Math.min(120, a * spike);
      phase[i] = Math.atan2(Math.sin(p), Math.cos(p));
    }

    // RSSI tracks the total energy arriving at this node.
    const rssi = -58 + Math.min(12, totalReflected * 0.06) + (this.rng() - 0.5) * 1.5;

    return encodeCsi({
      nodeId: node.nodeId,
      nSubcarriers: N,
      amplitude,
      phase,
      rssi,
      noiseFloor: -96,
      sequence: this.sequence,
      freqMhz: this.freqMhz,
      channel: 6,
      rateHz: this.rateHz,
      timestampMs,
      flags: 1 << 5,          // TN_FLAG_MOCK_SOURCE — never let this look real
    });
  }

  /** Ground truth, for the UI's "simulated" overlay and for testing. */
  truth() {
    return {
      scenario: this.scenarioId,
      label: this.scenario.label,
      description: this.scenario.description,
      elapsed_s: Math.round((this.t - this.scenarioStartedAt) * 10) / 10,
      auto_cycle: this.autoCycle,
      warmup: this.warmup,
      warmup_remaining_s: Math.max(0, Math.round(this.warmupSeconds - this.t)),
      people: (this.warmup ? [] : this.people).filter((p) => p.visible).map((p) => ({
        name: p.name,
        position: [Math.round(p.x * 100) / 100, 0, Math.round(p.z * 100) / 100],
        posture: p.posture,
        breathing_bpm: Math.round(p.breathingBpm * 10) / 10,
        heart_bpm: Math.round(p.heartBpm),
        in_apnea: p.t < p.apneaUntil,
      })),
    };
  }
}

