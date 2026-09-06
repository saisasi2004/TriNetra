/**
 * Person tracking: field peaks -> stable, identified tracks.
 *
 * Raw peaks appear, vanish and jump between ticks. This turns them into
 * tracks with persistent IDs, Kalman-smoothed positions, and a birth/death
 * policy that resists both flicker and ghosts.
 *
 * On counting, plainly: one antenna cannot separate two people. Superimposed
 * scattering from two bodies is underdetermined at 56 subcarriers, so the
 * count from a single node is a motion-energy bucket, not a measurement.
 * With several nodes the peaks genuinely separate and the count becomes
 * meaningful — which is why `count_method` travels with every payload.
 */

import { Kalman1D } from '../dsp/filters.js';
import { clamp01 } from '../dsp/stats.js';

const MAX_ASSOC_DISTANCE = 1.6;   // metres a person can plausibly move per tick
const BIRTH_FRAMES = 3;           // consecutive detections before a track exists
const DEATH_FRAMES = 12;          // missed detections before it is dropped
const MAX_TRACKS = 8;
/** Below this speed a "direction of travel" is just position noise. */
const HEADING_MIN_SPEED = 0.12;

let nextId = 1;

class Track {
  constructor(x, z, nowMs) {
    this.id = nextId++;
    this.kx = new Kalman1D(0.02, 0.4);
    this.kz = new Kalman1D(0.02, 0.4);
    this.x = this.kx.update(x);
    this.z = this.kz.update(z);
    this.confidence = 0.3;
    this.hits = 1;
    this.misses = 0;
    this.confirmed = false;
    this.bornAt = nowMs;
    this.lastSeenAt = nowMs;
    this.motionScore = 0;
    this.posture = 'unknown';
    this.zone = 'unknown';
    this.trail = [];
    this.velocity = 0;
    this.uncertainty = 1.5;
    /** Facing, radians. Consumed by pose.js, which had no source for it. */
    this.heading = 0;
  }

  update(x, z, value, dt, nowMs, uncertainty = 1.0) {
    this.uncertainty = uncertainty;
    const px = this.x, pz = this.z;
    this.x = this.kx.update(x, dt);
    this.z = this.kz.update(z, dt);
    this.velocity = dt > 0 ? Math.hypot(this.x - px, this.z - pz) / dt : 0;

    // Face the direction of travel. pose.js has always read `track.heading`,
    // but nothing ever wrote it, so it was permanently 0 and every figure
    // faced the same way regardless of where it was going — the moonwalk
    // that comment claimed to prevent. Only updated while genuinely moving:
    // deriving a heading from sub-centimetre jitter would spin the figure on
    // the spot.
    if (this.velocity > HEADING_MIN_SPEED) {
      this.heading = Math.atan2(this.x - px, this.z - pz);
    }
    this.hits++;
    this.misses = 0;
    this.lastSeenAt = nowMs;
    this.confidence = clamp01(this.confidence * 0.7 + value * 0.3 + 0.05);
    if (this.hits >= BIRTH_FRAMES) this.confirmed = true;

    this.trail.push([round2(this.x), round2(this.z)]);
    if (this.trail.length > 40) this.trail.shift();
  }

  miss(dt) {
    this.misses++;
    // Coast on the Kalman prediction — a person briefly occluded by
    // furniture should not vanish and be reborn with a new ID.
    this.x = this.kx.update(this.x, dt);
    this.z = this.kz.update(this.z, dt);
    this.confidence *= 0.85;
  }

  get dead() { return this.misses > DEATH_FRAMES || this.confidence < 0.05; }
}

export class PersonTracker {
  constructor({ room, zones = [] }) {
    this.room = room;
    this.zones = zones;
    this.tracks = [];
    this.lastTickAt = Date.now();
    this.countMethod = 'none';
  }

  /**
   * @param peaks  field peaks: [{ x, z, value }]
   * @param ctx    { nodes, fieldConfidence, nowMs }
   */
  update(peaks, { nodes = [], nowMs = Date.now(), presence = true } = {}) {
    const dt = Math.max(0.02, (nowMs - this.lastTickAt) / 1000);
    this.lastTickAt = nowMs;

    // Hard invariant: no presence, no people. Tracks coast through brief
    // missed detections by design, but that must never outlive presence
    // itself — reporting an occupant while the system says the room is
    // empty is a self-contradiction, and it is the reading a user would
    // rightly never trust again.
    if (!presence) {
      this.tracks.length = 0;
      this.countMethod = nodes.some((n) => n.online) ? this.countMethod : 'none';
      return [];
    }

    const activeNodes = nodes.filter((n) => n.online && !n.calibrating);
    this.countMethod =
      activeNodes.length >= 3 ? 'multi-node-field-peaks'
      : activeNodes.length === 2 ? 'two-node-field-peaks'
      : activeNodes.length === 1 ? 'single-node-motion-bucket'
      : 'none';

    // ── Greedy nearest-neighbour association ────────────────────────────
    // Hungarian would be optimal, but with <= 8 tracks and <= 6 peaks the
    // greedy result is identical often enough that the complexity is not
    // worth it.
    const unmatchedPeaks = [...peaks];
    const matched = new Set();

    const pairs = [];
    for (const track of this.tracks) {
      for (let i = 0; i < unmatchedPeaks.length; i++) {
        const p = unmatchedPeaks[i];
        const d = Math.hypot(track.x - p.x, track.z - p.z);
        if (d <= MAX_ASSOC_DISTANCE) pairs.push({ track, peakIdx: i, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const usedTracks = new Set();
    for (const { track, peakIdx, d } of pairs) {
      if (usedTracks.has(track) || matched.has(peakIdx)) continue;
      usedTracks.add(track);
      matched.add(peakIdx);
      const pk = unmatchedPeaks[peakIdx];
      track.update(pk.x, pk.z, pk.value, dt, nowMs, pk.uncertainty ?? 1.0);
      void d;
    }

    for (const track of this.tracks) {
      if (!usedTracks.has(track)) track.miss(dt);
    }

    // ── Births ──
    for (let i = 0; i < unmatchedPeaks.length; i++) {
      if (matched.has(i)) continue;
      if (this.tracks.length >= MAX_TRACKS) break;
      this.tracks.push(new Track(unmatchedPeaks[i].x, unmatchedPeaks[i].z, nowMs));
    }

    // ── Deaths ──
    this.tracks = this.tracks.filter((t) => !t.dead);

    // ── Per-track context from the nearest node that can actually see ──
    //
    // "Nearest active node" is not good enough. `active` only means online
    // and past calibration, and a node that detects nothing reports posture
    // 'absent' — so a track sitting next to a quiet node was labelled absent
    // while presence was true and the person was on screen. The dashboard
    // showed "PRESENCE YES / PEOPLE 1 / POSTURE Absent" simultaneously,
    // which is precisely the self-contradiction that makes a reading
    // untrustworthy. Posture must come from a node that is actually
    // detecting somebody.
    const detecting = activeNodes.filter((n) => n.presence);
    for (const t of this.tracks) {
      const witness = nearestNode(detecting, t.x, t.z);
      if (witness) {
        t.motionScore = Math.round(witness.motionEnergy * 100);
        t.posture = witness.posture;
      } else {
        // Nobody is detecting: the track is coasting on the Kalman
        // prediction. Say we do not know, rather than asserting 'absent'
        // about a person we are still reporting.
        const nearest = nearestNode(activeNodes, t.x, t.z);
        if (nearest) t.motionScore = Math.round(nearest.motionEnergy * 100);
        t.posture = 'unknown';
      }
      t.zone = this.#zoneAt(t.x, t.z);
    }

    return this.confirmed;
  }

  get confirmed() {
    return this.tracks.filter((t) => t.confirmed);
  }

  get count() {
    return this.confirmed.length;
  }

  #zoneAt(x, z) {
    for (const zone of this.zones) {
      const [x0, z0, x1, z1] = zone.bounds;
      if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1) &&
          z >= Math.min(z0, z1) && z <= Math.max(z0, z1)) {
        return zone.id;
      }
    }
    // Fall back to a quadrant label so the UI always has something to show.
    const ew = x < 0 ? 'west' : 'east';
    const ns = z < 0 ? 'north' : 'south';
    return `${ns}-${ew}`;
  }

  toJSON(poseBuilder = null) {
    return this.confirmed.map((t) => ({
      id: t.id,
      confidence: round2(t.confidence),
      position: [round2(t.x), 0, round2(t.z)],
      // Draw this as a disc, never a point. Position is room-level, not
      // metre-level: see the note in field.js findPeaks().
      position_uncertainty_m: round2(t.uncertainty),
      position_quality: t.uncertainty < 0.8 ? 'good'
        : t.uncertainty < 1.6 ? 'coarse' : 'room-level',
      velocity_mps: round2(t.velocity),
      motion_score: t.motionScore,
      posture: t.posture,
      zone: t.zone,
      trail: t.trail,
      tracked_for_s: round1((Date.now() - t.bornAt) / 1000),
      bbox: bboxFor(t),
      keypoints: poseBuilder ? poseBuilder(t) : [],
    }));
  }
}

function nearestNode(nodes, x, z) {
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.position[0] - x, n.position[2] - z);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/** Screen-space-ish bounding box, derived from the tracked position. */
function bboxFor(t) {
  const w = 0.55, h = t.posture === 'lying' ? 0.5 : 1.75;
  return {
    x: round2(t.x - w / 2),
    y: 0,
    width: round2(w),
    height: round2(h),
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
