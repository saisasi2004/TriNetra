/**
 * Vital-sign extraction from a CSI phase time series.
 *
 * Chain: sanitized phase -> Hampel -> bandpass -> autocorrelation -> median
 *        -> EMA, gated on stillness and presence.
 *
 * Every gate here exists to make the output refuse to lie. A breathing rate
 * reported while someone walks across the room is fabrication: chest
 * displacement is millimetres, walking is centimetres, and the small signal
 * is simply not recoverable from under the large one. We report nothing
 * rather than something plausible.
 */

import { Biquad, bpmAutocorr, notchHarmonics } from './filters.js';
import { Ema, MedianRing, hampel, clamp01 } from './stats.js';

export const BANDS = {
  breathing: { minHz: 0.1, maxHz: 0.5, minBpm: 6, maxBpm: 30 },
  heart:     { minHz: 0.67, maxHz: 2.0, minBpm: 40, maxBpm: 120 },
};

const MIN_SECONDS = 8;          // shortest window that resolves 6 BPM
const STILLNESS_MAX = 0.30;     // above this motion energy, vitals are void
const BR_CONF_GATE = 0.12;
const HR_CONF_GATE = 0.15;
/**
 * Half-life of a stale reading, in SECONDS of wall clock.
 *
 * This was a fixed 0.93 applied once per update() — that is, once per CSI
 * frame. At 20 Hz that is a 0.7 s time constant on a quantity estimated from
 * a 12.8 s window, so roughly three seconds without a confident
 * autocorrelation peak drove the confidence to zero and blanked the reading,
 * for a subject who was breathing steadily the whole time. Live, the display
 * went empty for over a minute at a stretch.
 *
 * Two things are wrong with a per-frame constant. It is tied to the frame
 * rate, so the same code decays four times faster on a node sending at 80 Hz
 * than at 20 Hz. And it is far shorter than the window the estimate is drawn
 * from, so it discards a measurement long before that measurement has
 * actually gone stale. Expressed as a half-life in seconds, the behaviour is
 * the same on any node, and 4 s is short enough that a subject leaving the
 * room clears within a few seconds while riding out the ordinary gaps where
 * the autocorrelation momentarily loses its peak.
 *
 * Note this does NOT hide apnea: `apneaSeconds` is measured from
 * lastBreathAt, which only advances on a genuinely confident estimate.
 */
const CONF_HALFLIFE_S = 4;
const BREATH_EVIDENCE_RATIO = 2.5;   // band power vs empty-room baseline

export class VitalsExtractor {
  constructor() {
    this.brMedian = new MedianRing(9);
    this.hrMedian = new MedianRing(11);
    this.brEma = new Ema(0.12);
    this.hrEma = new Ema(0.09);

    this.breathingBpm = 0;
    this.heartBpm = 0;
    this.breathingConf = 0;
    this.heartConf = 0;
    this.signalQuality = 0;

    this.lastBreathAt = 0;
    this.apneaSeconds = 0;
    this.brHistory = [];        // for trend / variability
    this.hrHistory = [];

    /**
     * Smoothed breathing-band evidence.
     *
     * The gate below must not be driven by the instantaneous ratio. Band
     * power over a sliding window is extremely variable frame to frame, so
     * an instantaneous test flickers across the threshold several times a
     * second; each dip decays the confidence and the reading
     * blanks even though the subject never moved. Averaging first asks
     * whether the evidence is there, rather than whether it happened to be
     * there on this particular frame.
     */
    this.evidenceEma = new Ema(0.05);
    this.lastUpdateMs = 0;
  }

  reset() {
    this.brMedian.clear(); this.hrMedian.clear();
    this.brEma.reset(); this.hrEma.reset();
    this.evidenceEma.reset();
    this.breathingBpm = 0; this.heartBpm = 0;
    this.breathingConf = 0; this.heartConf = 0;
    this.apneaSeconds = 0; this.lastBreathAt = 0;
    this.brHistory.length = 0; this.hrHistory.length = 0;
  }

  /**
   * @param phaseSeries  chronological sanitized phase samples
   * @param fs           measured sample rate in Hz
   * @param opts.motionEnergy 0..1 — vitals are gated on stillness
   * @param opts.presence     no person, no vitals
   */
  update(phaseSeries, fs, {
    motionEnergy = 0, presence = true, nowMs = Date.now(), breathRatio = Infinity,
  } = {}) {
    const n = phaseSeries.length;
    const enoughData = n >= Math.ceil(fs * MIN_SECONDS);
    const still = motionEnergy < STILLNESS_MAX;

    // Wall-clock decay, so the fade-out rate does not depend on how fast the
    // node happens to be sending frames.
    const dt = this.lastUpdateMs ? Math.min(2, (nowMs - this.lastUpdateMs) / 1000) : 0;
    this.lastUpdateMs = nowMs;
    const decay = dt > 0 ? Math.pow(0.5, dt / CONF_HALFLIFE_S) : 1;

    // Spectral evidence gate.
    //
    // Autocorrelation alone cannot tell "a real 15 BPM rhythm" from "noise
    // that has been bandpassed to 0.1-0.5 Hz". Filtering makes noise
    // narrowband, so it correlates with itself strongly at the filter's own
    // centre period and the estimator confidently reports a number — usually
    // pinned to an edge of the search band. Requiring the breathing-band
    // power to be genuinely elevated over the learned empty-room baseline is
    // what separates signal from well-shaped noise.
    const evidence = Number.isFinite(breathRatio)
      ? this.evidenceEma.update(breathRatio)
      : Infinity;
    const hasSpectralEvidence = evidence > BREATH_EVIDENCE_RATIO;

    let br = 0, brConf = 0, hr = 0, hrConf = 0;

    if (enoughData) {
      const clean = hampel(phaseSeries, 3, 3);

      const brBand = BANDS.breathing;
      const brFiltered = Biquad.bandpass(fs, brBand.minHz, brBand.maxHz).run(clean);
      ({ bpm: br, confidence: brConf } =
        bpmAutocorr(brFiltered, fs, brBand.minBpm, brBand.maxBpm));

      // Heart rate is only attempted once breathing is known, because the
      // breathing fundamental is what must be removed first.
      //
      // Order matters: notch out breathing and its harmonics, THEN bandpass
      // to the cardiac range, THEN autocorrelate with lag rejection as a
      // final backstop. Skipping the notch leaves the 3rd breathing harmonic
      // dominating the band, and no real cardiac peak ever forms.
      if (br > 1 && brConf > 0.1) {
        const brHz = br / 60;
        const hrBand = BANDS.heart;

        const notched = notchHarmonics(clean, fs, brHz, 4, 10);
        const hrFiltered = Biquad.bandpass(fs, hrBand.minHz, hrBand.maxHz).run(notched);

        ({ bpm: hr, confidence: hrConf } =
          bpmAutocorr(hrFiltered, fs, hrBand.minBpm, hrBand.maxBpm, brHz, 0.06));
      }
    }

    // ── Breathing ──
    if (br > 0 && brConf > BR_CONF_GATE && still && presence && hasSpectralEvidence) {
      this.breathingBpm = this.brEma.update(this.brMedian.push(br));
      this.breathingConf = clamp01(brConf * 2.2);
      this.lastBreathAt = nowMs;
      this.apneaSeconds = 0;
      this.#pushHistory(this.brHistory, this.breathingBpm);
    } else {
      this.breathingConf *= decay;
      if (this.breathingConf < 0.05) { this.breathingBpm = 0; this.breathingConf = 0; }
      if (presence && this.lastBreathAt) {
        this.apneaSeconds = (nowMs - this.lastBreathAt) / 1000;
      }
    }

    // ── Heart rate ──
    if (hr > 0 && hrConf > HR_CONF_GATE && still && presence && hasSpectralEvidence) {
      this.heartBpm = this.hrEma.update(this.hrMedian.push(hr));
      this.heartConf = clamp01(hrConf * 2.0);
      this.#pushHistory(this.hrHistory, this.heartBpm);
    } else {
      this.heartConf *= decay;
      if (this.heartConf < 0.05) { this.heartBpm = 0; this.heartConf = 0; }
    }

    return this.snapshot();
  }

  /** Merge an edge-computed vitals packet from a node. The MCU has the
   *  full-rate phase series; we only ever see decimated CSI, so when the
   *  node reports a confident value it wins. */
  mergeEdge(pkt) {
    if (!pkt) return;
    if (pkt.breathingConf > this.breathingConf && pkt.breathingBpm > 0) {
      this.breathingBpm = pkt.breathingBpm;
      this.breathingConf = pkt.breathingConf;
      this.lastBreathAt = Date.now();
      this.#pushHistory(this.brHistory, pkt.breathingBpm);
    }
    if (pkt.heartConf > this.heartConf && pkt.heartBpm > 0) {
      this.heartBpm = pkt.heartBpm;
      this.heartConf = pkt.heartConf;
      this.#pushHistory(this.hrHistory, pkt.heartBpm);
    }
    if (pkt.signalQuality > 0) this.signalQuality = pkt.signalQuality;
  }

  #pushHistory(arr, v) {
    arr.push(v);
    if (arr.length > 600) arr.shift();   // ~10 min at 1 Hz
  }

  /** Breathing variability — elevated values track restless or disturbed sleep. */
  get breathingVariability() {
    const h = this.brHistory;
    if (h.length < 10) return 0;
    const recent = h.slice(-60);
    const m = recent.reduce((a, b) => a + b, 0) / recent.length;
    const v = recent.reduce((a, b) => a + (b - m) ** 2, 0) / recent.length;
    return Math.sqrt(v);
  }

  snapshot() {
    return {
      breathing_rate_bpm: this.breathingBpm > 0 ? round1(this.breathingBpm) : null,
      heart_rate_bpm: this.heartBpm > 0 ? round1(this.heartBpm) : null,
      breathing_confidence: round2(this.breathingConf),
      heartbeat_confidence: round2(this.heartConf),
      breathing_variability: round2(this.breathingVariability),
      apnea_seconds: round1(this.apneaSeconds),
      signal_quality: round2(this.signalQuality),
    };
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
