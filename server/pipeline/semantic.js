/**
 * Semantic states — the layer that turns numbers into things a person
 * (or an automation) can act on.
 *
 * Every detector here is a small state machine with explicit dwell times.
 * The dwell times are the whole point: "someone is sleeping" is not a
 * threshold on one frame, it is a pattern sustained over minutes. Firing
 * these instantly would make every one of them useless.
 *
 * Each state reports { active, since, confidence, evidence } so a UI or an
 * automation can explain WHY it fired, not just that it did.
 */

const MIN = 60_000;

class Detector {
  constructor(id, { label, onDwellMs = 0, offDwellMs = 0, severity = 'info' }) {
    this.id = id;
    this.label = label;
    this.onDwellMs = onDwellMs;
    this.offDwellMs = offDwellMs;
    this.severity = severity;

    this.active = false;
    this.since = null;
    this.candidateSince = null;
    this.clearSince = null;
    this.confidence = 0;
    this.evidence = '';
  }

  /** @param cond { met: boolean, confidence: number, evidence: string } */
  evaluate(cond, nowMs) {
    const { met, confidence = 0.5, evidence = '' } = cond;

    if (met) {
      this.clearSince = null;
      if (!this.candidateSince) this.candidateSince = nowMs;
      if (!this.active && nowMs - this.candidateSince >= this.onDwellMs) {
        this.active = true;
        this.since = nowMs;
      }
      this.confidence = confidence;
      this.evidence = evidence;
    } else {
      this.candidateSince = null;
      if (this.active) {
        if (!this.clearSince) this.clearSince = nowMs;
        if (nowMs - this.clearSince >= this.offDwellMs) {
          this.active = false;
          this.since = null;
          this.confidence = 0;
          this.evidence = '';
        }
      }
    }
    return this.toJSON(nowMs);
  }

  toJSON(nowMs = Date.now()) {
    return {
      id: this.id,
      label: this.label,
      active: this.active,
      severity: this.severity,
      confidence: Math.round(this.confidence * 100) / 100,
      duration_s: this.since ? Math.round((nowMs - this.since) / 1000) : 0,
      evidence: this.evidence,
    };
  }
}

export class SemanticEngine {
  constructor() {
    this.detectors = {
      someone_sleeping: new Detector('someone_sleeping', {
        label: 'Someone sleeping', onDwellMs: 5 * MIN, offDwellMs: 60_000,
      }),
      room_active: new Detector('room_active', {
        label: 'Room active', onDwellMs: 3_000, offDwellMs: 30_000,
      }),
      no_movement: new Detector('no_movement', {
        label: 'No movement', onDwellMs: 10 * MIN, offDwellMs: 5_000, severity: 'warn',
      }),
      possible_distress: new Detector('possible_distress', {
        label: 'Possible distress', onDwellMs: 15_000, offDwellMs: 60_000, severity: 'alert',
      }),
      fall_risk_elevated: new Detector('fall_risk_elevated', {
        label: 'Fall risk elevated', onDwellMs: 20_000, offDwellMs: 2 * MIN, severity: 'warn',
      }),
      bed_exit: new Detector('bed_exit', {
        label: 'Bed exit', onDwellMs: 2_000, offDwellMs: 30_000, severity: 'warn',
      }),
      bathroom_occupied: new Detector('bathroom_occupied', {
        label: 'Bathroom occupied', onDwellMs: 5_000, offDwellMs: 20_000,
      }),
      meeting_in_progress: new Detector('meeting_in_progress', {
        label: 'Meeting in progress', onDwellMs: 2 * MIN, offDwellMs: 3 * MIN,
      }),
      elderly_inactivity_anomaly: new Detector('elderly_inactivity_anomaly', {
        label: 'Inactivity anomaly', onDwellMs: 30 * MIN, offDwellMs: 60_000, severity: 'alert',
      }),
      multi_room_transition: new Detector('multi_room_transition', {
        label: 'Multi-room transition', onDwellMs: 1_000, offDwellMs: 10_000,
      }),
      apnea_suspected: new Detector('apnea_suspected', {
        label: 'Apnea suspected', onDwellMs: 10_000, offDwellMs: 60_000, severity: 'alert',
      }),
      intrusion: new Detector('intrusion', {
        label: 'Intrusion', onDwellMs: 3_000, offDwellMs: 60_000, severity: 'alert',
      }),
    };

    this.armed = false;              // intrusion detection only means something when armed
    this.lastPresenceRoom = null;
    this.movedFrom = null;
    this.roomChangeAt = 0;
    this.wasLying = false;
    this.lyingSince = null;
  }

  /**
   * @param ctx {
   *   nodes, persons, vitals, presence, motionEnergy, fall, nowMs,
   *   quietHours
   * }
   */
  update(ctx) {
    const {
      nodes = [], persons = [], vitals = {}, presence = false,
      motionEnergy = 0, fall = false, nowMs = Date.now(),
    } = ctx;

    const d = this.detectors;
    const br = vitals.breathing_rate_bpm ?? 0;
    const brConf = vitals.breathing_confidence ?? 0;
    const hr = vitals.heart_rate_bpm ?? 0;
    const lying = persons.some((p) => p.posture === 'lying');
    const anyMoving = persons.some((p) => p.velocity_mps > 0.15);
    const count = persons.length;

    // ── Sleeping: lying, still, with regular slow breathing sustained for
    // minutes. All three conditions matter — lying still with no breathing
    // signal is much more likely to be an empty bed than a sleeping person.
    d.someone_sleeping.evaluate({
      met: lying && motionEnergy < 0.06 && br > 6 && br < 18 && brConf > 0.3,
      confidence: Math.min(0.9, brConf),
      evidence: `lying, motion ${motionEnergy.toFixed(2)}, breathing ${br.toFixed(1)} BPM`,
    }, nowMs);

    d.room_active.evaluate({
      met: presence && motionEnergy > 0.15,
      confidence: Math.min(0.95, motionEnergy * 2),
      evidence: `motion energy ${motionEnergy.toFixed(2)}`,
    }, nowMs);

    d.no_movement.evaluate({
      met: presence && motionEnergy < 0.04,
      confidence: 0.7,
      evidence: 'presence held with near-zero motion for 10 min',
    }, nowMs);

    // ── Distress: a fall, OR vitals outside physiological normals while
    // the person is still. Elevated HR alone while walking is exercise.
    const vitalsAbnormal =
      (br > 0 && (br > 26 || br < 8) && brConf > 0.35) ||
      (hr > 0 && (hr > 115 || hr < 42));
    d.possible_distress.evaluate({
      met: fall || (presence && !anyMoving && vitalsAbnormal),
      confidence: fall ? 0.9 : 0.6,
      evidence: fall
        ? 'fall detected'
        : `breathing ${br.toFixed(1)}, heart ${hr.toFixed(0)} while still`,
    }, nowMs);

    // ── Fall risk: unsteady gait signature — present, moving, but with
    // high motion variance and low velocity (shuffling, hesitant).
    const unsteady = persons.some(
      (p) => p.velocity_mps > 0.05 && p.velocity_mps < 0.35 && p.motion_score > 40,
    );
    d.fall_risk_elevated.evaluate({
      met: unsteady,
      confidence: 0.55,
      evidence: 'slow movement with high motion variance (unsteady gait)',
    }, nowMs);

    // ── Bed exit: was lying, now standing or walking, within a short window.
    const nowLying = lying;
    const exited = this.wasLying && !nowLying && presence &&
                   persons.some((p) => p.posture === 'standing' || p.posture === 'walking');
    d.bed_exit.evaluate({
      met: exited,
      confidence: 0.7,
      evidence: 'posture transitioned from lying to upright',
    }, nowMs);
    if (nowLying !== this.wasLying) {
      this.wasLying = nowLying;
      this.lyingSince = nowLying ? nowMs : null;
    }

    d.bathroom_occupied.evaluate({
      met: persons.some((p) => /bath|toilet|wc/i.test(p.zone ?? '')),
      confidence: 0.75,
      evidence: 'person tracked inside a bathroom zone',
    }, nowMs);

    // ── Meeting: several people, present for minutes, mostly seated.
    const seated = persons.filter((p) => p.posture === 'sitting').length;
    d.meeting_in_progress.evaluate({
      met: count >= 2 && seated >= Math.max(2, Math.floor(count * 0.6)),
      confidence: 0.6,
      evidence: `${count} people, ${seated} seated`,
    }, nowMs);

    d.elderly_inactivity_anomaly.evaluate({
      met: presence && motionEnergy < 0.03 && !lying,
      confidence: 0.6,
      evidence: 'present and upright but motionless for 30 min',
    }, nowMs);

    // ── Multi-room transition ──
    // The room with the STRONGEST evidence, not merely the first node in
    // array order that happens to report presence. With several nodes seeing
    // the same person, `find` returns whichever was registered first among
    // those currently firing, so the answer flips as presence flickers
    // between them and a stationary occupant appears to change rooms.
    const activeRoom = nodes
      .filter((n) => n.presence && n.room)
      .reduce((best, n) => (
        !best || n.detectionStrength > best.detectionStrength ? n : best
      ), null)?.room ?? null;
    if (activeRoom && activeRoom !== this.lastPresenceRoom) {
      // A transition needs somewhere to have come FROM. Firing on the first
      // presence of the session treats "someone arrived" as "someone moved
      // between rooms", which in a single-room install — the default — is
      // the only way this detector could ever fire, and it fired every time
      // the room became occupied.
      if (this.lastPresenceRoom !== null) {
        this.roomChangeAt = nowMs;
        this.movedFrom = this.lastPresenceRoom;
      }
      this.lastPresenceRoom = activeRoom;
    }
    d.multi_room_transition.evaluate({
      met: this.roomChangeAt > 0 && nowMs - this.roomChangeAt < 5_000,
      confidence: 0.6,
      evidence: `presence moved from ${this.movedFrom} to ${activeRoom}`,
    }, nowMs);

    d.apnea_suspected.evaluate({
      met: lying && (vitals.apnea_seconds ?? 0) > 12 && presence,
      confidence: 0.6,
      evidence: `no breathing signal for ${(vitals.apnea_seconds ?? 0).toFixed(0)}s while lying`,
    }, nowMs);

    d.intrusion.evaluate({
      met: this.armed && presence && motionEnergy > 0.2,
      confidence: 0.8,
      evidence: 'motion detected while system armed',
    }, nowMs);

    return this.toJSON(nowMs);
  }

  setArmed(v) { this.armed = !!v; }

  toJSON(nowMs = Date.now()) {
    const states = {};
    for (const [k, det] of Object.entries(this.detectors)) {
      states[k] = det.toJSON(nowMs);
    }
    return states;
  }

  /** Only the states that are currently firing — what a UI banner wants. */
  active(nowMs = Date.now()) {
    return Object.values(this.detectors)
      .filter((d) => d.active)
      .map((d) => d.toJSON(nowMs))
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }
}

function severityRank(s) {
  return s === 'alert' ? 2 : s === 'warn' ? 1 : 0;
}
