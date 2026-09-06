/**
 * Skeleton rendering model.
 *
 * READ THIS BEFORE USING THE OUTPUT.
 *
 * These 17 keypoints are NOT inferred per-joint from CSI. A single-antenna,
 * 56-subcarrier stream does not carry the spatial information limb tracking
 * needs — the published research that does per-joint WiFi pose uses 3x3 MIMO
 * research NICs (9 spatial channels against our 1), and even then only after
 * training on paired camera ground truth.
 *
 * What this actually does: takes the four quantities we DO measure —
 * position, posture class, motion energy, breathing phase — and drives a
 * kinematic body model with them. The torso genuinely rises and falls with
 * the measured breathing rate. The body genuinely stands where the field
 * peak is, and lies down when the posture classifier says lying.
 *
 * Every keypoint carries `derived: true` and the payload carries
 * `pose_source: "kinematic-model"`, so nothing downstream can mistake it for
 * per-joint inference. If you later train a real model, swap this module and
 * set pose_source accordingly — do not quietly relabel this one.
 */

const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];

export const SKELETON_EDGES = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [0, 1], [0, 2], [1, 3], [2, 4], [0, 5], [0, 6],
];

/** Metres, roughly 50th-percentile adult, relative to the hip centre. */
const STANDING = {
  nose:           [0.00, 0.72, 0.02],
  left_eye:       [-0.03, 0.75, 0.06],
  right_eye:      [0.03, 0.75, 0.06],
  left_ear:       [-0.08, 0.73, 0.00],
  right_ear:      [0.08, 0.73, 0.00],
  left_shoulder:  [-0.19, 0.52, 0.00],
  right_shoulder: [0.19, 0.52, 0.00],
  left_elbow:     [-0.24, 0.24, 0.02],
  right_elbow:    [0.24, 0.24, 0.02],
  left_wrist:     [-0.26, -0.04, 0.04],
  right_wrist:    [0.26, -0.04, 0.04],
  left_hip:       [-0.11, 0.00, 0.00],
  right_hip:      [0.11, 0.00, 0.00],
  left_knee:      [-0.12, -0.44, 0.01],
  right_knee:     [0.12, -0.44, 0.01],
  left_ankle:     [-0.12, -0.86, 0.02],
  right_ankle:    [0.12, -0.86, 0.02],
};

const HIP_HEIGHT = { standing: 0.95, walking: 0.95, sitting: 0.55, lying: 0.20, unknown: 0.95, absent: 0 };

export class PoseModel {
  constructor() {
    this.phase = new Map();   // per-track gait / breathing phase accumulators
  }

  /**
   * Build 17 keypoints for one tracked person.
   *
   * @param track   person track { id, x, z, posture, motionScore, velocity }
   * @param ctx     { breathingBpm, heartBpm, dt, confidence }
   * @returns [[x, y, z, confidence], ...] in the wire format the UI expects
   */
  build(track, ctx = {}) {
    const {
      breathingBpm = 0,
      dt = 0.1,
      confidence = 0.5,
      posture = track.posture ?? 'standing',
    } = ctx;

    let st = this.phase.get(track.id);
    if (!st) { st = { gait: 0, breath: 0, lean: 0 }; this.phase.set(track.id, st); }

    // Gait phase advances with actual measured velocity — a person standing
    // still does not swing their arms.
    const speed = track.velocity ?? 0;
    st.gait = (st.gait + dt * (1.6 + speed * 1.8) * Math.min(1, speed / 0.4)) % (Math.PI * 2);

    // Breathing phase advances at the MEASURED rate. This is the one part
    // of the skeleton that is driven by a real physiological measurement.
    const breathHz = breathingBpm > 0 ? breathingBpm / 60 : 0;
    st.breath = (st.breath + dt * breathHz * Math.PI * 2) % (Math.PI * 2);

    const hipY = HIP_HEIGHT[posture] ?? 0.95;
    const lying = posture === 'lying';
    const sitting = posture === 'sitting';

    const swing = Math.sin(st.gait) * Math.min(1, speed / 0.6);
    const breathLift = breathingBpm > 0 ? Math.sin(st.breath) * 0.012 : 0;

    // Face the direction of travel so the figure does not moonwalk.
    const heading = track.heading ?? 0;
    const cosH = Math.cos(heading), sinH = Math.sin(heading);

    const out = [];
    for (const name of KEYPOINT_NAMES) {
      let [dx, dy, dz] = STANDING[name];

      if (lying) {
        // Rotate the body onto the floor plane: vertical extent becomes
        // horizontal extent along the heading.
        const along = dy;
        dy = Math.abs(dx) * 0.35;
        dz = dz + along * 0.9;
      } else if (sitting) {
        // Fold at hip and knee.
        if (name.includes('knee')) { dy = -0.06; dz = 0.30; }
        else if (name.includes('ankle')) { dy = -0.46; dz = 0.34; }
        else if (dy > 0) dy *= 0.92;
      }

      // Limb swing, scaled by measured speed.
      if (name === 'left_wrist' || name === 'left_elbow') dz += swing * 0.12;
      if (name === 'right_wrist' || name === 'right_elbow') dz -= swing * 0.12;
      if (name === 'left_ankle' || name === 'left_knee') dz -= swing * 0.14;
      if (name === 'right_ankle' || name === 'right_knee') dz += swing * 0.14;

      // Chest rise driven by the measured breathing rate.
      if (name.includes('shoulder') || name === 'nose' || name.includes('ear') || name.includes('eye')) {
        dy += breathLift;
      }

      const rx = dx * cosH - dz * sinH;
      const rz = dx * sinH + dz * cosH;

      // Confidence is deliberately uniform and modest. We have no per-joint
      // evidence, so claiming that a wrist is more certain than an ankle
      // would be invented precision.
      out.push([
        round3(track.x + rx),
        round3(hipY + dy),
        round3(track.z + rz),
        round2(confidence * 0.6),
      ]);
    }
    return out;
  }

  buildNamed(track, ctx) {
    return this.build(track, ctx).map(([x, y, z, c], i) => ({
      name: KEYPOINT_NAMES[i], x, y, z, confidence: c, derived: true,
    }));
  }

  forget(trackId) { this.phase.delete(trackId); }

  gc(activeIds) {
    for (const id of this.phase.keys()) {
      if (!activeIds.has(id)) this.phase.delete(id);
    }
  }
}

export { KEYPOINT_NAMES };

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
