/**
 * Per-node sensing state.
 *
 * Each ESP32 gets one of these. It holds the CSI history, the learned
 * ambient baseline, and everything derived from a single node's view:
 * features, presence, motion, vitals, falls.
 *
 * Multi-node reasoning (localisation, person separation) lives one level up
 * in engine.js — it needs several of these to compare.
 */

import {
  Ring, Ema, mean, variance, hampel, sanitizePhase, circularVariance,
  bandPower, bandStats, dominantFrequency, changePoints, clamp01,
} from '../dsp/stats.js';
import { VitalsExtractor } from '../dsp/vitals.js';

// ── Tunables. These are what you adjust per room. ──────────────────────
const PRESENCE_ON_RATIO = 2.4;
const PRESENCE_OFF_RATIO = 1.5;   // hysteresis stops presence flapping
const PRESENCE_DEBOUNCE = 4;

/**
 * Clearing presence needs the same window-aware treatment as setting it.
 *
 * At 12 frames (0.6 s) this was two orders of magnitude shorter than the
 * 12.8 s window the breathing evidence is computed over, so an ordinary dip
 * in a genuinely occupied room dropped presence — and re-acquiring then cost
 * a full breathing integration. The result was presence flapping on and off
 * over a motionless subject who had not moved at all: detected on 78% of
 * ticks but only 2 seeds in 5 happened to be showing it at any chosen
 * instant. Held for longer than a window, and integrated rather than
 * counted consecutively, presence stays put unless the evidence is really
 * gone.
 */
const PRESENCE_OFF_DEBOUNCE = 150;      // 7.5 s at 20 Hz

const MOTION_STILL_MAX = 0.08;
const MOTION_ACTIVE_MIN = 0.28;

const BASELINE_ALPHA = 0.0025;    // ~ 40 s time constant at 10 Hz
const MOTION_EMA_ALPHA = 0.18;

// Breathing-band presence. A seated or sleeping person produces almost no
// gross amplitude change — motion-energy presence simply cannot see them,
// which would make the system blind in exactly the cases that matter most
// (elderly care, sleep monitoring). But a living body ALWAYS modulates the
// phase at 0.1-0.5 Hz. Elevated breathing-band power against the empty-room
// baseline is therefore a second, independent presence path.
const BREATH_PRESENCE_RATIO = 4.0;
const BREATH_PRESENCE_OFF_RATIO = 2.0;
/** Below this ratio the room is quiet enough to re-learn the baseline fast. */
const BREATH_BASELINE_QUIET_RATIO = 1.5;
const BREATH_BASELINE_ALPHA = 0.005;

/** Excess coupling below which the room is quiet enough to track drift. */
const COUPLING_QUIET_EXCESS = 0.05;

/**
 * The breathing path's debounce must exceed the ANALYSIS WINDOW, not merely
 * be "longer than motion's".
 *
 * Consecutive frames are not independent evidence. breathPower is computed
 * over a sliding 12.8 s window (256 samples at 20 Hz), so a single noise
 * excursion anywhere in that window keeps the ratio elevated for the whole
 * 12.8 s that the window takes to slide past it. The old value of 25 frames
 * — 1.25 s — was therefore satisfied by about a tenth of one window's worth
 * of noise, and it showed: with nobody in the simulated room at all,
 * presence fired on 30% of ticks via this path, and breathRatio reached 23x
 * against a 4x trigger.
 *
 * Requiring the evidence to outlast a full window means it has to survive
 * being recomputed from genuinely fresh samples. This is the same reasoning
 * as SUBCARRIER_HOLD_FRAMES below: a hold shorter than the window does not
 * hold anything. The cost is latency on a sleeping subject, which is the
 * one case where latency does not matter.
 *
 * The count is a LEAKY INTEGRATOR (+1 when the evidence is present, -1 when
 * it is not) rather than a run of consecutive frames. A real breathing
 * signal clears the threshold most of the time but not every frame, so a
 * strict run is broken constantly by ordinary dips: requiring 300
 * consecutive frames detected a seated subject on 6% of ticks instead of
 * 70%. Integrating asks the question that actually matters — is the
 * evidence present MORE OFTEN THAN NOT over a window longer than the
 * analysis window — and an empty room, where it appears about a tenth of
 * the time, drains the accumulator instead of filling it.
 */
const BREATH_PRESENCE_DEBOUNCE = 120;

/**
 * Breathing must also look like a RHYTHM, not just elevated band power.
 *
 * Noise filtered into a narrow band still has band power, and the power of
 * noise in a narrow band is itself violently variable — which is why a ratio
 * test alone cannot be made reliable at any threshold. Peakedness measures
 * the shape of the spectrum instead of its size: one narrow line scores
 * high, energy smeared across the band scores near 1 no matter how much of
 * it there is. Overlap with the empty-room distribution is real, so this is
 * a supporting gate rather than the primary one.
 */
const BREATH_PEAK_RATIO_MIN = 3.0;

const BREATH_EVAL_EVERY = 4;      // frames between (costly) FFT evaluations

// The sensitive-subcarrier choice must be STABLE for LONGER THAN THE
// ANALYSIS WINDOW.
//
// Re-picking it every frame splices together samples from different
// subcarriers, each with its own static phase offset, and destroys the time
// series the vitals extractor depends on. But holding it for merely "a
// while" is not enough either: with a 256-sample history at 20 Hz, the
// window spans 12.8 s, so a 2-second hold still stitches six different
// subcarriers into every estimate. The hold has to exceed the window, and
// a switch has to be clearly worth it.
const SUBCARRIER_HOLD_FRAMES = 320;      // 16 s at 20 Hz, > the 12.8 s window
const SUBCARRIER_SWITCH_MARGIN = 1.3;    // new pick must be 30% more responsive

const FALL_SIGMA = 4.5;
const FALL_CONFIRM_FRAMES = 2;
const FALL_STILLNESS_MS = 2500;
const FALL_COOLDOWN_MS = 5000;

// Stillness after impact is measured RELATIVE to the motion just before it,
// not against a fixed threshold. Ambient motion energy in a real room sits
// well above any absolute "still" constant you would pick, so an absolute
// gate can never be satisfied and the confirmation step silently disables
// fall detection entirely. What actually characterises a fall is the
// *collapse* in motion after the impact.
const FALL_STILLNESS_DROP = 0.55;

export class NodeState {
  constructor(nodeId, { historyFrames = 256, calibrationSeconds = 30, position = null } = {}) {
    this.nodeId = nodeId;
    this.position = position ?? [0, 0, 0];
    this.room = null;

    // Rings sized for the longest thing we need to see: one full breath
    // cycle at 6 BPM is 10 s, so 256 frames at ~20 Hz gives comfortable margin.
    this.phaseHistory = new Ring(historyFrames);
    this.ampHistory = new Ring(historyFrames);
    this.motionHistory = new Ring(historyFrames);
    this.rssiHistory = new Ring(120);
    this.varianceHistory = new Ring(historyFrames);

    this.prevAmplitude = null;
    this.motionEma = new Ema(MOTION_EMA_ALPHA);
    this.baselineEma = new Ema(BASELINE_ALPHA);
    this.breathBaselineEma = new Ema(BREATH_BASELINE_ALPHA);
    this.couplingBaseline = new Ema(BASELINE_ALPHA * 2);
    this.rssiEma = new Ema(0.05);
    this.coupling = 0;
    this.proximity = 0;
    /**
     * Coupling excess: (current whole-comb coupling / empty-room coupling) - 1.
     *
     * This — NOT `proximity` — is what the spatial field consumes, because it
     * is the only per-node quantity that varies smoothly and monotonically
     * with distance across the whole room. Measured against the simulator it
     * spans 0.53 at 0.4 m down to 0.02 at 6 m: more than an order of
     * magnitude of usable range information.
     *
     * `proximity` compresses that into 0..1 and clamps, which drives every
     * node beyond ~2 m to exactly 0 and throws the range information away.
     * It is kept only as a bounded display value.
     */
    this.couplingExcess = 0;

    // Per-subcarrier sensitivity, accumulated over time rather than judged
    // frame by frame.
    this.scSensitivity = null;
    this.selectedSubcarrier = 0;
    this.subcarrierAge = 0;
    this.phaseOffset = 0;
    this.lastPushedPhase = 0;
    this.lastPhaseVector = null;
    this.breathPower = 0;
    /** Spectral peakedness in the breathing band — rhythm vs noise. */
    this.breathPeakRatio = 0;
    this.breathRatio = 0;
    this.presenceReason = 'none';

    this.vitals = new VitalsExtractor();

    this.presence = false;
    this.presenceScore = 0;
    this.motionEnergy = 0;
    this.detectionStrength = 0;
    this.strengthPeak = 0;
    this.normalizedStrength = 0;
    this.motionLevel = 'none';
    this.posture = 'unknown';
    this.fall = false;
    this.signalQuality = 0;

    this.presenceOnCount = 0;
    this.motionOnCount = 0;
    this.breathOnCount = 0;
    this.presenceOffCount = 0;

    // Welford accumulators for the adaptive fall threshold.
    this.accelMean = 0; this.accelM2 = 0; this.accelN = 0;
    this.fallCandidate = 0; this.fallCandidateAt = 0; this.fallCooldownUntil = 0;
    /** When an edge-reported fall stops being current. 0 = none pending. */
    this.fallExpiresAt = 0;
    this.fallPreMotion = 0.1;
    this.prevMotionRaw = 0; this.prevMotionDelta = 0;
    this.phaseAccel = 0;

    this.sampleRateHz = 20;
    /** EMA of the frame-to-frame INTERVAL in seconds. Averaging intervals and
     *  inverting once is unbiased; averaging 1/dt is not. */
    this.intervalEma = new Ema(0.05);
    this.lastFrameAt = 0;
    this.lastPacketAt = 0;
    this.online = false;
    this.mock = false;

    this.calibrationSeconds = calibrationSeconds;
    this.calibrating = true;
    this.calibrationFrames = Math.round(calibrationSeconds * 20);
    this.framesSeen = 0;
    this.framesTotal = 0;
    this.sequenceGaps = 0;
    this.lastSequence = null;

    this.subcarrierCount = 0;
    this.lastAmplitude = null;
    this.edgeVitals = null;
    this.edgeStatus = null;
    this.events = [];

    this.features = emptyFeatures();
  }

  /**
   * Relearn what "nobody is here" means.
   *
   * This must reset EVERY learned baseline, not just the motion one. It
   * previously left `breathBaselineEma` and `couplingBaseline` untouched,
   * which quietly made the operation a half-measure: breathing is the
   * primary presence path for a still or sleeping person, and coupling is
   * the sole range observable the spatial field is built from. Recalibrating
   * a room after moving furniture — or after calibrating with someone in it,
   * which is the mistake this endpoint exists to undo — therefore left both
   * of those still carrying the bad baseline, and the symptom that prompted
   * the recalibration survived it.
   */
  recalibrate() {
    this.calibrating = true;
    this.calibrationFrames = Math.round(this.calibrationSeconds * this.sampleRateHz);

    this.baselineEma.reset();
    this.breathBaselineEma.reset();
    this.breathBaselineEma.alpha = BREATH_BASELINE_ALPHA;
    this.couplingBaseline.reset();
    this.motionEma.reset();

    this.vitals.reset();
    this.phaseHistory.clear();
    this.ampHistory.clear();
    this.motionHistory.clear();
    this.varianceHistory.clear();

    // Per-subcarrier sensitivity is a learned property of the room too, and
    // a stale pick keeps the node staring at a subcarrier chosen for the old
    // geometry.
    this.scSensitivity = null;
    this.subcarrierAge = 0;
    this.phaseOffset = 0;
    this.prevAmplitude = null;

    this.accelMean = 0; this.accelM2 = 0; this.accelN = 0;
    this.fallCandidate = 0;

    this.breathPower = 0;
    this.breathRatio = 0;
    this.breathPeakRatio = 0;
    this.coupling = 0;
    this.couplingExcess = 0;
    this.proximity = 0;
    this.strengthPeak = 0;
    this.normalizedStrength = 0;
    this.detectionStrength = 0;

    this.presence = false;
    this.presenceReason = 'none';
    this.presenceOnCount = 0;
    this.motionOnCount = 0;
    this.breathOnCount = 0;
    this.presenceOffCount = 0;
  }

  /** Ingest one decoded CSI frame. */
  ingestCsi(frame, nowMs = Date.now()) {
    // Measure the arrival interval BEFORE overwriting lastFrameAt.
    const prevFrameAt = this.lastFrameAt;
    this.lastFrameAt = nowMs;
    this.lastPacketAt = nowMs;
    this.online = true;
    this.mock = frame.flags?.mock ?? false;
    this.subcarrierCount = frame.nSubcarriers;
    this.framesTotal++;

    if (this.lastSequence !== null) {
      const gap = (frame.sequence - this.lastSequence + 0x100000000) % 0x100000000;
      if (gap > 1 && gap < 1000) this.sequenceGaps += gap - 1;
    }
    this.lastSequence = frame.sequence;

    // Measure the arrival rate OURSELVES rather than believing the node.
    //
    // CSI is event-driven — it arrives when a frame is received, not on a
    // clock — so this number cannot be assumed, and EVERY frequency estimate
    // downstream scales directly with it. Get it wrong by 2.6x and 15 BPM
    // breathing is reported as 40 BPM.
    //
    // The node's own figure is not trustworthy for two independent reasons:
    //
    //   1. It averages INSTANTANEOUS rates (1/dt). By Jensen's inequality
    //      E[1/dt] >= 1/E[dt], so bursty arrivals bias it upward, and it
    //      discards intervals longer than 1 s outright, so idle stretches
    //      never pull it back down. Fed a steady 20 Hz source it reports
    //      about 53 Hz.
    //   2. Even a perfect node-side figure describes what the NODE captured.
    //      The DSP here runs on what the SERVER received, and the transport
    //      is unacknowledged UDP.
    //
    // Averaging the interval and inverting once at the end avoids the same
    // trap the firmware fell into.
    if (prevFrameAt > 0) {
      const dt = (nowMs - prevFrameAt) / 1000;
      // Ignore absurd intervals: sub-2 ms is two packets in one batch rather
      // than a real 500 Hz link, and >5 s is a dead link resuming, not a rate.
      if (dt >= 0.002 && dt <= 5) {
        const meanInterval = this.intervalEma.update(dt);
        if (meanInterval > 0) {
          this.sampleRateHz = Math.min(200, Math.max(1, 1 / meanInterval));
        }
      }
    }

    const amp = hampel(frame.amplitude, 2, 3);
    const phase = sanitizePhase(frame.phase);
    this.lastAmplitude = amp;

    const ampMean = mean(amp);
    const ampVar = variance(amp);

    // ── Motion: mean absolute per-subcarrier amplitude change, normalised
    // by link strength so it does not scale with how close the node is.
    const prev = this.prevAmplitude;

    let motionRaw = 0;
    if (prev && prev.length === amp.length) {
      let s = 0;
      for (let i = 0; i < amp.length; i++) s += Math.abs(amp[i] - prev[i]);
      motionRaw = s / (amp.length * (ampMean > 1e-3 ? ampMean : 1));
    }

    const motionSmoothed = this.motionEma.update(motionRaw);

    // The selector needs this frame's phase vector to re-reference the offset
    // when it switches subcarrier.
    this.lastPhaseVector = phase;
    const sc = this.#selectSensitiveSubcarrier(amp, prev);
    this.prevAmplitude = amp;

    const phaseSample = (phase[sc] ?? 0) + this.phaseOffset;
    this.lastPushedPhase = phaseSample;
    this.phaseHistory.push(phaseSample);
    this.ampHistory.push(ampMean);
    this.motionHistory.push(motionSmoothed);
    this.varianceHistory.push(ampVar);
    this.rssiHistory.push(frame.rssi);
    this.rssiEma.update(frame.rssi);

    // ── Breathing-band power, evaluated periodically (it costs an FFT) ──
    if (this.framesSeen % BREATH_EVAL_EVERY === 0 &&
        this.phaseHistory.length >= Math.ceil(this.sampleRateHz * 8)) {
      const bs = bandStats(this.phaseHistory.toArray(), this.sampleRateHz, 0.1, 0.5);
      this.breathPower = bs.power;
      this.breathPeakRatio = bs.peakRatio;
    }

    // ── Calibration ──
    if (this.calibrating) {
      this.baselineEma.update(motionRaw);
      if (this.breathPower > 0) this.breathBaselineEma.update(this.breathPower);

      // The coupling baseline MUST be learned here, during the one period
      // the room is guaranteed empty.
      //
      // It was previously skipped by this early return and primed instead on
      // the first frame after calibration, then nudged only while presence
      // happened to be off. That made the zero-point of the spatial field's
      // only range observable depend on presence HISTORY rather than on the
      // empty room: change how quickly presence latches and every node's
      // coupling excess shifts underneath the field. Tightening the presence
      // debounce moved a subject's reported position by 2 m without touching
      // a line of field code, which is how the coupling showed up.
      this.couplingBaseline.update(this.coupling);

      if (--this.calibrationFrames <= 0) this.calibrating = false;
      this.framesSeen++;
      this.#updateSignalQuality(frame, phase);
      return;
    }

    // Both baselines only adapt while nobody is present. Otherwise a person
    // sitting still for a minute is slowly absorbed into "empty room" and
    // disappears — the classic WiFi-sensing failure.
    // Baselines adapt only when the room genuinely looks quiet.
    //
    // "Not presence" is NOT the same as "quiet". Once presence drops for any
    // reason, a still-breathing occupant would otherwise be absorbed into
    // the baseline within a minute, the ratio collapses to 1, and the node
    // can never detect them again — a sleeping person silently disappears
    // and never comes back. Requiring the breathing evidence itself to be
    // low before adapting closes that trap.
    if (!this.presence) {
      this.baselineEma.update(motionRaw);

      if (this.breathPower > 0) {
        // Two-speed adaptation. Never freezing entirely matters: a baseline
        // that can be locked low by a noise excursion drifts into permanent
        // false positives. But adapting at full speed while a real breathing
        // signal is present absorbs a sleeping person within a minute and
        // loses them for good. Fast when the room looks quiet, ~15x slower
        // otherwise, gives both properties.
        const quiet = this.breathRatio < BREATH_BASELINE_QUIET_RATIO;
        this.breathBaselineEma.alpha = quiet
          ? BREATH_BASELINE_ALPHA
          : BREATH_BASELINE_ALPHA / 15;
        this.breathBaselineEma.update(this.breathPower);
      }
    }

    const baseline = Math.max(this.baselineEma.value, 1e-6);
    const ratio = motionSmoothed / baseline;

    const breathBaseline = Math.max(this.breathBaselineEma.value, 1e-12);
    this.breathRatio = this.breathPower / breathBaseline;

    this.#updatePresence(ratio, this.breathRatio, this.breathPeakRatio);

    this.motionEnergy = clamp01(ratio / (PRESENCE_ON_RATIO * 3));

    // Detection strength is what the spatial field consumes. It must NOT be
    // motion energy alone: a sleeping person has near-zero motion energy, so
    // a motion-only field would place no one in the room while presence is
    // firing — the map and the state would contradict each other.
    const breathStrength = clamp01(
      (this.breathRatio - 1) / (BREATH_PRESENCE_RATIO * 2),
    );
    this.detectionStrength = Math.max(this.motionEnergy, breathStrength);

    // Per-node auto-gain.
    //
    // Nodes differ wildly in how strongly they couple to the room: antenna
    // orientation, what furniture sits in the Fresnel zone, which multipath
    // components dominate. Two nodes equidistant from the same person can
    // report detection strengths that differ by 3x for reasons that have
    // nothing to do with distance. Feeding those raw numbers to the spatial
    // field drags every position estimate toward whichever node happens to
    // be best coupled.
    //
    // Dividing by each node's own slowly-decaying peak makes the nodes
    // comparable, so the field reflects the current geometry instead of
    // fixed hardware differences.
    this.strengthPeak = Math.max(this.detectionStrength, this.strengthPeak * 0.9995);
    this.normalizedStrength = this.strengthPeak > 1e-4
      ? clamp01(this.detectionStrength / this.strengthPeak)
      : 0;

    // Proximity: how far this node's whole-comb coupling has risen above its
    // own empty-room baseline. A node with a body nearby sees a much larger
    // rise than one across the room, so this — unlike single-subcarrier
    // breathing power — is genuinely monotonic in distance.
    // Drift correction only. The baseline itself was established during
    // calibration; this tracks slow thermal and furniture drift while the
    // room is quiet, and must be slow enough that it cannot re-learn a
    // stationary occupant as scenery.
    if (!this.presence && this.couplingExcess < COUPLING_QUIET_EXCESS) {
      this.couplingBaseline.update(this.coupling);
    }
    const cb = Math.max(this.couplingBaseline.value, 1e-6);
    this.couplingExcess = Math.max(0, this.coupling / cb - 1);
    // Bounded restatement of the same quantity, for display only. The field
    // must use couplingExcess: this clamp is exactly what destroyed the range
    // information it needs.
    this.proximity = clamp01(this.couplingExcess / 0.5);

    this.presenceScore = clamp01(
      Math.max(
        (ratio - PRESENCE_OFF_RATIO) / (PRESENCE_ON_RATIO * 2),
        (this.breathRatio - BREATH_PRESENCE_OFF_RATIO) / (BREATH_PRESENCE_RATIO * 2),
      ),
    );
    this.motionLevel = !this.presence ? 'none'
      : this.motionEnergy > MOTION_ACTIVE_MIN ? 'high'
      : this.motionEnergy > MOTION_STILL_MAX ? 'low'
      : 'still';

    this.#updateFall(motionRaw, nowMs);
    this.#updateSignalQuality(frame, phase);
    this.#updateFeatures();

    this.vitals.update(this.phaseHistory.toArray(), this.sampleRateHz, {
      motionEnergy: this.motionEnergy,
      presence: this.presence,
      breathRatio: this.breathRatio,
      nowMs,
    });
    this.vitals.signalQuality = this.signalQuality;

    this.#updatePosture();
    this.framesSeen++;
  }

  /** Ingest an edge-computed vitals packet. */
  ingestVitals(pkt, nowMs = Date.now()) {
    this.lastPacketAt = nowMs;
    this.online = true;
    this.edgeVitals = pkt;
    this.mock = pkt.flags?.mock ?? this.mock;

    this.vitals.mergeEdge(pkt);

    // If the node sends vitals but no raw CSI (low-bandwidth mode), its
    // packet is the only source of truth we have.
    if (!this.lastAmplitude) {
      this.presence = pkt.flags.presence;
      this.motionEnergy = pkt.motionEnergy;
      this.presenceScore = pkt.presenceScore;
      this.posture = pkt.posture;
      this.signalQuality = pkt.signalQuality;
      this.calibrating = pkt.flags.calibrating;
      this.motionLevel = !this.presence ? 'none'
        : pkt.motionEnergy > MOTION_ACTIVE_MIN ? 'high'
        : pkt.motionEnergy > MOTION_STILL_MAX ? 'low' : 'still';
    }
    // A fall is a MOMENT, not a state. `fall` is recomputed (and cleared)
    // every CSI frame, but a node in low-bandwidth mode sends no CSI — so
    // latching it here left fall_detected true forever, and the alert could
    // never be cleared without restarting the server. Give the edge-reported
    // fall the same cooldown the locally detected one gets, and let it
    // expire on its own.
    if (pkt.flags.fall) {
      this.fall = true;
      this.fallExpiresAt = nowMs + FALL_COOLDOWN_MS;
    } else if (this.fallExpiresAt && nowMs > this.fallExpiresAt) {
      this.fall = false;
      this.fallExpiresAt = 0;
    }
  }

  ingestStatus(pkt, nowMs = Date.now()) {
    this.lastPacketAt = nowMs;
    this.online = true;
    this.edgeStatus = pkt;
    // Deliberately does NOT touch sampleRateHz. The node's figure is biased
    // high and describes its capture rate, not our arrival rate; letting a
    // heartbeat overwrite the locally measured value every 500 ms would undo
    // the measurement in ingestCsi. Kept on edgeStatus for diagnostics only.
  }

  ingestEvent(pkt, nowMs = Date.now()) {
    this.lastPacketAt = nowMs;
    this.online = true;
    this.events.push({ ...pkt, receivedAt: nowMs });
    if (this.events.length > 50) this.events.shift();
    if (pkt.type === 'fall') {
      this.fall = true;
      this.fallExpiresAt = nowMs + FALL_COOLDOWN_MS;
      this.fallCooldownUntil = nowMs + FALL_COOLDOWN_MS;
    }
  }

  /**
   * Expire a latched fall.
   *
   * Called once per tick so that a node which reports falls but sends no
   * CSI still has its alert cleared — `#updateFall` only runs on a CSI
   * frame, and for a low-bandwidth node that never happens.
   */
  expireFall(nowMs) {
    if (this.fall && this.fallExpiresAt && nowMs > this.fallExpiresAt) {
      this.fall = false;
      this.fallExpiresAt = 0;
    }
  }

  checkTimeout(nowMs, timeoutMs) {
    if (this.online && nowMs - this.lastPacketAt > timeoutMs) {
      this.online = false;
      this.presence = false;
      this.motionEnergy = 0;
      this.motionLevel = 'none';
      this.posture = 'unknown';
      this.vitals.reset();
      return true;
    }
    return false;
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Track which subcarriers actually respond to the body, and hold the
   * choice steady.
   *
   * Only a handful of subcarriers carry a strong body-reflected path; the
   * rest are dominated by the static line-of-sight component. But the
   * selection must be stable over time — switching subcarrier mid-series
   * splices together samples with different static phase offsets, which
   * looks like a step change and buries the millimetre-scale breathing
   * signal we are trying to recover.
   */
  #selectSensitiveSubcarrier(amp, prev) {
    const n = amp.length;

    if (!this.scSensitivity || this.scSensitivity.length !== n) {
      this.scSensitivity = new Float64Array(n);
      this.selectedSubcarrier = Math.floor(n / 2);
      this.subcarrierAge = 0;
    }

    if (prev && prev.length === n) {
      // Accumulate each subcarrier's responsiveness as an EMA of its own
      // absolute frame-to-frame change.
      for (let i = 0; i < n; i++) {
        this.scSensitivity[i] += 0.02 * (Math.abs(amp[i] - prev[i]) - this.scSensitivity[i]);
      }
    }

    // Total responsiveness across ALL subcarriers, normalised by link
    // strength. This is the closest thing to a range proxy a single-antenna
    // node has: reflected energy falls with distance, and summing over the
    // whole comb averages out the per-subcarrier interference lottery that
    // makes any single subcarrier's response wildly non-monotonic in range.
    let total = 0;
    for (let i = 2; i < n - 2; i++) total += this.scSensitivity[i];
    this.coupling = total / Math.max(1, n - 4);

    if (++this.subcarrierAge >= SUBCARRIER_HOLD_FRAMES) {
      this.subcarrierAge = 0;

      // Skip the outermost bins: guard-band edges are noisy and carry no
      // useful path information.
      let best = this.selectedSubcarrier, bestV = -1;
      for (let i = 2; i < n - 2; i++) {
        if (this.scSensitivity[i] > bestV) { bestV = this.scSensitivity[i]; best = i; }
      }

      // Only switch when the new candidate is clearly better. Swapping for a
      // marginal gain costs a full window of continuity and is a net loss.
      const currentV = this.scSensitivity[this.selectedSubcarrier] ?? 0;
      if (best !== this.selectedSubcarrier && bestV > currentV * SUBCARRIER_SWITCH_MARGIN) {
        // The new subcarrier has a different static phase offset, so naively
        // appending its samples injects a step change straight into the
        // breathing band. Discarding the history avoids that but costs a
        // full window (12.8 s) of vitals every switch — which showed up as
        // heart rate going permanently null.
        //
        // Instead, re-reference the new subcarrier to the old one's last
        // value. Continuity is preserved and no data is thrown away; only
        // the arbitrary constant offset changes, and the bandpass removes
        // constants anyway.
        this.phaseOffset += (this.lastPushedPhase - (this.lastPhaseVector?.[best] ?? 0));
        this.selectedSubcarrier = best;
      }
    }

    return this.selectedSubcarrier;
  }

  /**
   * Presence via two independent paths, either of which is sufficient:
   *
   *   motion  — gross movement changes many subcarriers at once
   *   breath  — a still body still modulates phase at 0.1-0.5 Hz
   *
   * Requiring both would miss a sleeping person; requiring only motion is
   * the same blindness. Either-or, with hysteresis and debounce on the
   * combined decision, covers the walking case and the sleeping case
   * without doubling the false-positive rate.
   */
  #updatePresence(motionRatio, breathRatio, breathPeakRatio = Infinity) {
    const motionSays = motionRatio > PRESENCE_ON_RATIO;
    const breathSays = breathRatio > BREATH_PRESENCE_RATIO &&
                       breathPeakRatio > BREATH_PEAK_RATIO_MIN;

    if (!this.presence) {
      if (motionSays) this.motionOnCount++; else this.motionOnCount = 0;

      // Motion may fire on a short run — a body moving is unambiguous within
      // a few frames. Breathing integrates instead (see the constant), so a
      // dip costs one frame of progress rather than all of it.
      this.breathOnCount = Math.max(0, Math.min(
        BREATH_PRESENCE_DEBOUNCE,
        this.breathOnCount + (breathSays ? 1 : -1),
      ));

      const motionConfirmed = this.motionOnCount >= PRESENCE_DEBOUNCE;
      const breathConfirmed = this.breathOnCount >= BREATH_PRESENCE_DEBOUNCE;

      if (motionConfirmed || breathConfirmed) {
        this.presence = true;
        this.motionOnCount = 0;
        this.breathOnCount = 0;
        this.presenceReason = motionConfirmed && breathConfirmed ? 'motion+breathing'
          : motionConfirmed ? 'motion' : 'breathing';
      }
    } else {
      const clear = motionRatio < PRESENCE_OFF_RATIO &&
                    breathRatio < BREATH_PRESENCE_OFF_RATIO;

      this.presenceOffCount = Math.max(0, Math.min(
        PRESENCE_OFF_DEBOUNCE,
        this.presenceOffCount + (clear ? 1 : -1),
      ));

      if (this.presenceOffCount >= PRESENCE_OFF_DEBOUNCE) {
        this.presence = false;
        this.presenceOffCount = 0;
        this.breathOnCount = 0;
        this.motionOnCount = 0;
        this.presenceReason = 'none';
      }
    }
  }

  /**
   * A fall is a large, abrupt disturbance FOLLOWED BY stillness. The
   * stillness confirmation is what separates a real fall from someone
   * sitting down hard or a door slamming — without it this detector cries
   * wolf constantly.
   *
   * The trigger signal is the raw motion metric, NOT the mean of the
   * sanitized phase. sanitizePhase() subtracts a least-squares line across
   * the subcarrier axis, which makes the residual's mean identically zero
   * by construction — a detector watching it would see a flat zero forever
   * and never fire at all.
   */
  #updateFall(motionRaw, nowMs) {
    const delta = motionRaw - this.prevMotionRaw;
    const accel = Math.abs(delta - this.prevMotionDelta);
    this.prevMotionRaw = motionRaw;
    this.prevMotionDelta = delta;
    this.phaseAccel = accel;

    this.accelN++;
    const d1 = accel - this.accelMean;
    this.accelMean += d1 / this.accelN;
    this.accelM2 += d1 * (accel - this.accelMean);
    const sd = this.accelN > 1 ? Math.sqrt(this.accelM2 / (this.accelN - 1)) : 0;

    this.fall = false;
    if (nowMs <= this.fallCooldownUntil || this.accelN < 100 || sd < 1e-9) return;

    const z = (accel - this.accelMean) / sd;

    if (z > FALL_SIGMA && this.presence) {
      if (this.fallCandidate === 0) {
        this.fallCandidateAt = nowMs;
        // Remember how much motion there was going INTO the impact; the
        // confirmation is a drop relative to this, not an absolute level.
        this.fallPreMotion = Math.max(this.motionEnergy, 0.02);
      }
      this.fallCandidate++;
    } else if (this.fallCandidate > 0) {
      const inWindow = nowMs - this.fallCandidateAt < FALL_STILLNESS_MS;
      const wentStill = this.motionEnergy < this.fallPreMotion * FALL_STILLNESS_DROP;
      if (this.fallCandidate >= FALL_CONFIRM_FRAMES && inWindow && wentStill) {
        this.fall = true;
        this.fallCooldownUntil = nowMs + FALL_COOLDOWN_MS;
        this.fallCandidate = 0;
        this.events.push({
          kind: 'event', nodeId: this.nodeId, type: 'fall', severity: 2,
          confidence: clamp01(z / (FALL_SIGMA * 2)), value: z, receivedAt: nowMs,
        });
      } else if (!inWindow) {
        this.fallCandidate = 0;
      }
    }
  }

  #updateSignalQuality(frame, phase) {
    const rssiQ = clamp01((frame.rssi + 90) / 40);
    const snrQ = clamp01((frame.rssi - frame.noiseFloor) / 45);
    const coherence = 1 - circularVariance(frame.phase);
    this.signalQuality = clamp01(0.4 * rssiQ + 0.35 * coherence + 0.25 * snrQ);
  }

  #updateFeatures() {
    const motion = this.motionHistory.toArray();
    const amps = this.ampHistory.toArray();
    const fs = this.sampleRateHz;

    if (motion.length < 8) { this.features = emptyFeatures(); return; }

    const dom = dominantFrequency(motion, fs, 0.05, Math.min(3, fs / 2 - 0.01));

    this.features = {
      mean_rssi: round2(this.rssiEma.value),
      variance: round4(variance(amps)),
      motion_band_power: round4(bandPower(motion, fs, 0.5, 3.0)),
      breathing_band_power: round4(bandPower(this.phaseHistory.toArray(), fs, 0.1, 0.5)),
      dominant_freq_hz: round3(dom.freq),
      change_points: changePoints(motion),
      spectral_power: round4(bandPower(motion, fs, 0.05, Math.min(4, fs / 2 - 0.01))),
    };
  }

  /**
   * Coarse posture. This is NOT skeletal pose — a single antenna cannot
   * resolve limbs, and anything claiming otherwise from one ESP32 is
   * overselling. Four honest buckets is what the physics supports.
   */
  #updatePosture() {
    if (!this.presence) { this.posture = 'absent'; return; }
    if (this.motionEnergy > MOTION_ACTIVE_MIN) { this.posture = 'walking'; return; }
    if (this.motionEnergy > MOTION_STILL_MAX) { this.posture = 'standing'; return; }
    if (this.vitals.breathingConf > 0.3 && this.vitals.breathingBpm > 0 &&
        this.vitals.breathingBpm < 16) { this.posture = 'lying'; return; }
    this.posture = 'sitting';
  }

  /** Wire representation for the WebSocket payload. */
  toJSON() {
    const amp = this.lastAmplitude;
    return {
      node_id: this.nodeId,
      online: this.online,
      room: this.room,
      rssi_dbm: round1(this.rssiEma.value),
      position: this.position,
      amplitude: amp ? Array.from(amp, (v) => Math.round(v * 100) / 100) : [],
      subcarrier_count: this.subcarrierCount,
      sample_rate_hz: round1(this.sampleRateHz),
      presence: this.presence,
      presence_reason: this.presenceReason,
      breath_ratio: round2(this.breathRatio),
      selected_subcarrier: this.selectedSubcarrier,
      motion_energy: round3(this.motionEnergy),
      motion_level: this.motionLevel,
      posture: this.posture,
      signal_quality: round2(this.signalQuality),
      calibrating: this.calibrating,
      calibration_remaining: Math.max(0, this.calibrationFrames),
      mock: this.mock,
      frames: this.framesTotal,
      sequence_gaps: this.sequenceGaps,
      vitals: this.vitals.snapshot(),
    };
  }
}

function emptyFeatures() {
  return {
    mean_rssi: 0, variance: 0, motion_band_power: 0, breathing_band_power: 0,
    dominant_freq_hz: 0, change_points: 0, spectral_power: 0,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;


