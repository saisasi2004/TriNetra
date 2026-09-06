/**
 * Spatial signal field.
 *
 * Builds a floor-plane occupancy-likelihood grid by testing, for every cell,
 * how well "a reflector here" explains what the nodes actually measured —
 * then reads person positions off the peaks of that likelihood.
 *
 * How this actually works, and what it is not:
 *
 * The only spatial observable a monostatic single-antenna node provides is
 * RANGE-ish: how much its whole-comb coupling rose above the empty room.
 * There is no time-of-flight, no angle-of-arrival and no bistatic link, so
 * one node constrains the subject to a ring around itself and says nothing
 * about bearing. Two nodes leave the two-fold ambiguity where their rings
 * cross. Three or more genuinely intersect, and that is the point at which
 * "multilateration" stops being a euphemism.
 *
 * Accordingly the answer is a LIKELIHOOD SURFACE rather than a point, every
 * position carries the width of the region that fits, and `localization`
 * names which of those regimes produced it. Do not read a 1-node position
 * as a measurement.
 *
 * Measured against the simulator with four corner nodes in a 6x5 m room:
 * roughly 0.2 m error for a subject near any node, degrading to about 2 m
 * at the centre — which is where all four returns are weakest and most
 * nearly equal, and where `evidence` correspondingly falls to about 0.27.
 */

import { clamp01 } from '../dsp/stats.js';

/** Minimum strength of a secondary peak, relative to the strongest. */
const SECONDARY_PEAK_RATIO = 0.72;

/**
 * Level set at which the likelihood surface is segmented, as a fraction of
 * its own peak. Two people separate into two blobs only where the surface
 * between them falls below this; lower it and one broad region starts
 * fragmenting into phantom occupants.
 */
const SEGMENT_LEVEL = 0.60;

/**
 * Half-response range of the monostatic return, in metres.
 *
 * m(d) = 1/(1 + (d/D0)^2), so D0 is the distance at which a node's excess
 * coupling has fallen to half its close-range value. It is a property of the
 * RADIO, not of the room, so it does not scale with room size. 1.5 m matches
 * the simulator's 1/(1 + 0.45 d^2) path term and is a reasonable starting
 * point for a real node; it is the one number here worth re-fitting against
 * measured hardware.
 */
const RANGE_D0 = 1.5;

/**
 * Measurement noise on the normalised per-node response, 0..1 scale.
 *
 * Two components, because the error genuinely has two sources. The relative
 * term covers multipath and cross-section variation and scales with the
 * signal. The absolute term is the noise floor of the coupling estimate
 * itself, and because the responses are normalised by their own maximum it
 * blows up as that maximum shrinks: a subject in the middle of the room
 * returns roughly 0.01 excess coupling to every node, so the normalised
 * pattern is almost pure noise. Letting sigma grow there is what turns a
 * confidently-wrong fix into an honestly-vague one.
 */
const RESPONSE_SIGMA = 0.28;
const RESPONSE_NOISE_FLOOR = 0.012;

/** Below this excess coupling, no node is meaningfully responding. */
const MIN_RESPONSE = 0.01;

/** Excess coupling at which the array is considered fully responding. */
const STRONG_RESPONSE = 0.15;

/** Field peak below which no position is worth reporting at all. */
const MIN_LOCALIZE_CONFIDENCE = 0.15;

/**
 * A note on person SEPARATION, because its absence here is a deliberate
 * conclusion rather than an omission.
 *
 * Matching pursuit was implemented and measured: fit the strongest
 * reflector, subtract the response it predicts, and test whether the
 * residual still looks like a body. It does not work with this observable,
 * and the measurements say so unambiguously. Across the whole usable range
 * of gate settings there was no operating point that separated two people
 * without inventing occupants:
 *
 *   - loose enough to be sensitive, it reported 2-3 people for a single
 *     seated subject on 57% of ticks — one body's model mismatch leaves a
 *     residual as large as a second body's contribution
 *   - strict enough to be safe, it never fired at all
 *   - and at NO setting did it fire for two genuinely separate walkers,
 *     whose combined return happens to fit one intermediate position well
 *
 * That is the expected result rather than a tuning failure. A two-body fit
 * has six free parameters against four scalar measurements, and those four
 * carry range only — no time-of-flight, no angle-of-arrival, no bistatic
 * links. The system therefore UNDERCOUNTS: two people are reported as one,
 * positioned between them. Missing someone is a limitation; inventing
 * someone is a fabrication, and only one of those is acceptable.
 */

const round2 = (v) => Math.round(v * 100) / 100;

export class SignalField {
  constructor({ room, grid }) {
    this.room = room;
    this.gx = grid[0];
    this.gy = grid[1];
    this.gz = grid[2];
    this.cells = this.gx * this.gy * this.gz;
    this.values = new Float64Array(this.cells);
    this.smoothed = new Float64Array(this.cells);
    this.alpha = 0.35;      // temporal smoothing — raw fields flicker badly
    /** 0..1 — how strongly the array is responding, independent of WHERE. */
    this.evidence = 0;
  }

  cellToWorld(ix, iz) {
    return [
      (ix / (this.gx - 1) - 0.5) * this.room.width,
      0,
      (iz / (this.gz - 1) - 0.5) * this.room.depth,
    ];
  }

  worldToCell(x, z) {
    return [
      Math.round((x / this.room.width + 0.5) * (this.gx - 1)),
      Math.round((z / this.room.depth + 0.5) * (this.gz - 1)),
    ];
  }

  /**
   * Rebuild the field from the current node states.
   *
   * This is range-based multilateration against an explicit MEASUREMENT
   * MODEL, and that distinction matters more than any other choice here.
   *
   * The previous implementation fused a per-node scalar `belief` using a
   * Gaussian coverage weight. Because `belief` was CONSTANT across the grid,
   * the fused value at every cell was a weighted average of constants, which
   * is maximised wherever the highest-belief node dominates the weighting —
   * that is, at that node. Measured against the simulator, the tracked
   * position sat within 0.2 m of a node's x-coordinate no matter where the
   * subject actually was: a person at (0, 0) was reported at (-2.76, -1.56),
   * an error of 3.2 m in a 6 m room. The field encoded the node layout and
   * nothing about the occupant, so adding nodes bought no localisation.
   *
   * What replaces it: every node reports how far its whole-comb coupling has
   * risen above its own empty-room baseline. For a monostatic node the
   * reflected return falls with range as
   *
   *     m(d) = 1 / (1 + (d / D0)^2)
   *
   * so the hypothesis "the reflector is at cell c" PREDICTS a response for
   * every node. Scoring cells by how well the predicted pattern matches the
   * observed one is what actually intersects range constraints: three nodes
   * that each report "close" agree only at their mutual intersection, not at
   * any one of them.
   *
   * Both the observed and the predicted vectors are normalised by their own
   * maximum before comparison. That is deliberate: it cancels the reflector's
   * unknown cross-section — a nuisance parameter we cannot calibrate — and
   * leaves only the RATIOS between nodes, which is exactly the part that
   * carries position.
   */
  update(nodes) {
    this.values.fill(0);

    const active = nodes.filter((n) => n.online && !n.calibrating);
    if (active.length === 0) {
      this.evidence = 0;
      this.#decay();
      return;
    }

    const obs = active.map((n) => ({
      x: n.position[0],
      z: n.position[2],
      // couplingExcess, NOT proximity: proximity clamps to zero beyond about
      // 2 m, which makes every distant node look identical and is precisely
      // how the range information was being thrown away.
      e: Math.max(0, n.couplingExcess ?? 0),
      w: Math.max(0.15, n.signalQuality),
    }));

    const eMax = Math.max(...obs.map((o) => o.e));

    // Nothing is responding above its empty-room baseline, so there is
    // nothing to localise. Decay rather than manufacturing a peak from the
    // noise floor.
    if (!(eMax > MIN_RESPONSE)) {
      this.evidence = 0;
      this.#decay();
      return;
    }

    for (const o of obs) o.hat = o.e / eMax;

    // How hard the array as a whole is responding.
    //
    // This is deliberately kept OUT of the field values and reported
    // separately. The field answers "where, if anyone", and must stay a
    // pure likelihood surface: folding the evidence into it dims every cell
    // for a distant subject until no peak clears the detection threshold,
    // so a person standing in the middle of the room — the weakest return
    // geometry there is — produces presence but no track at all. Whether
    // anyone is there is presence's job, and the engine already gates peaks
    // on it.
    this.evidence = clamp01(eMax / STRONG_RESPONSE);

    // Effective noise on the normalised responses (see RESPONSE_SIGMA).
    const noiseRel = clamp01(RESPONSE_NOISE_FLOOR / eMax);
    const sigma = RESPONSE_SIGMA + noiseRel;
    const twoSigma2 = 2 * sigma * sigma;

    const pred = new Float64Array(obs.length);

    for (let iz = 0; iz < this.gz; iz++) {
      for (let ix = 0; ix < this.gx; ix++) {
        const [wx, , wz] = this.cellToWorld(ix, iz);

        // Response pattern this cell would produce.
        let pMax = 0;
        for (let i = 0; i < obs.length; i++) {
          const d2 = (wx - obs[i].x) ** 2 + (wz - obs[i].z) ** 2;
          const p = 1 / (1 + d2 / (RANGE_D0 * RANGE_D0));
          pred[i] = p;
          if (p > pMax) pMax = p;
        }

        // Gaussian likelihood of the observed pattern under that hypothesis.
        //
        // Both sides are floored at the noise level first. Without it the fit
        // is biased onto the nodes themselves: a distant node's excess
        // coupling clips at zero, and "sitting on top of node 1" predicts
        // smaller far-node returns than the true position does, so it scores
        // better. Flooring makes every sub-noise prediction indistinguishable,
        // which is the truth — those nodes are reporting nothing, and nothing
        // cannot discriminate between two hypotheses.
        let chi2 = 0, wSum = 0;
        for (let i = 0; i < obs.length; i++) {
          const o = Math.max(obs[i].hat, noiseRel);
          const p = Math.max(pred[i] / pMax, noiseRel);
          chi2 += obs[i].w * (o - p) * (o - p);
          wSum += obs[i].w;
        }

        this.values[iz * this.gx + ix] = Math.exp(-chi2 / (wSum * twoSigma2));
      }
    }

    // NO percentile stretch. The likelihood is already a calibrated 0..1
    // confidence, and rescaling it against its own percentiles every tick
    // would map an empty room's noise floor onto full scale — which is how a
    // relative normalisation manufactures a confident peak out of nothing.
    // An absolute field also lets findPeaks' threshold mean what it says.
    for (let i = 0; i < this.cells; i++) {
      this.smoothed[i] += this.alpha * (this.values[i] - this.smoothed[i]);
    }
  }

  /** Relax the field toward empty when there is nothing to place. */
  #decay() {
    for (let i = 0; i < this.cells; i++) {
      this.smoothed[i] += this.alpha * (0 - this.smoothed[i]);
    }
  }

  /**
   * Segment the likelihood surface into blobs, one per candidate person.
   *
   * This is connected-component labelling of the region above a level set,
   * NOT local-maximum detection, and the difference decides whether the
   * count is trustworthy.
   *
   * The likelihood surface is frequently a broad PLATEAU: when one node
   * clearly dominates and the rest are at their noise floor, every cell in a
   * wide region explains the observation equally well, and that is the
   * honest shape of the answer. A local-maximum finder sees a plateau as
   * dozens of tied maxima — with tie-tolerant comparison they all qualify —
   * and non-maximum suppression by distance alone then keeps several of
   * them, spread across the plateau. Measured, a single person in the middle
   * of the room produced five "people" that way. Inventing occupants is the
   * one failure this system must not have.
   *
   * Two people only become two components when the surface between them
   * genuinely dips below the level set. That is the same criterion a human
   * would apply to the heat map, and it degrades the right way: as evidence
   * weakens the blobs merge and the count falls, rather than fragmenting and
   * climbing.
   *
   * Each blob reports its likelihood-weighted centroid — not its argmax —
   * so a plateau yields the middle of the compatible region instead of
   * whichever corner cell happened to win by a rounding error.
   */
  findPeaks({ maxPeaks = 6, threshold = 0.35, minSeparation = 1.0 } = {}) {
    const cellW = this.room.width / (this.gx - 1);
    const cellD = this.room.depth / (this.gz - 1);

    let globalMax = 0;
    for (let i = 0; i < this.cells; i++) {
      if (this.smoothed[i] > globalMax) globalMax = this.smoothed[i];
    }
    if (globalMax < threshold) return [];

    // Cut the surface at a level relative to its own peak as well as the
    // caller's absolute floor. The relative part is what separates two
    // genuine modes; the absolute part keeps a noise-floor surface from
    // being segmented at all.
    const level = Math.max(threshold, globalMax * SEGMENT_LEVEL);

    const labels = new Int32Array(this.cells).fill(-1);
    const blobs = [];
    const stack = [];

    for (let start = 0; start < this.cells; start++) {
      if (labels[start] !== -1 || this.smoothed[start] < level) continue;

      const id = blobs.length;
      const blob = { value: 0, wsum: 0, cx: 0, cz: 0, cells: 0 };
      labels[start] = id;
      stack.push(start);

      while (stack.length) {
        const i = stack.pop();
        const ix = i % this.gx, iz = (i / this.gx) | 0;
        const v = this.smoothed[i];

        blob.cells++;
        blob.wsum += v;
        blob.cx += v * ix;
        blob.cz += v * iz;
        if (v > blob.value) blob.value = v;

        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const jx = ix + dx, jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= this.gx || jz >= this.gz) continue;
            const j = jz * this.gx + jx;
            if (labels[j] !== -1 || this.smoothed[j] < level) continue;
            labels[j] = id;
            stack.push(j);
          }
        }
      }
      blobs.push(blob);
    }

    // Second pass for the spread, now that every centroid is known.
    const m2 = new Float64Array(blobs.length);
    for (let iz = 0; iz < this.gz; iz++) {
      for (let ix = 0; ix < this.gx; ix++) {
        const i = iz * this.gx + ix;
        const id = labels[i];
        if (id < 0) continue;
        const b = blobs[id];
        m2[id] += this.smoothed[i] *
          (((ix - b.cx / b.wsum) * cellW) ** 2 + ((iz - b.cz / b.wsum) * cellD) ** 2);
      }
    }

    const peaks = blobs.map((b, id) => {
      const fx = b.cx / b.wsum;
      const fz = b.cz / b.wsum;

      // Uncertainty is the blob's own radius of gyration: a tight blob means
      // the nodes agree closely, a sprawling one means the field only knows
      // "somewhere over here". Reporting it is the difference between an
      // honest estimate and false precision — four monostatic single-antenna
      // nodes have no time-of-flight, no angle-of-arrival and no bistatic
      // links, so metre-level accuracy is not physically recoverable.
      const spread = Math.sqrt(m2[id] / b.wsum);

      return {
        value: b.value,
        x: (fx / (this.gx - 1) - 0.5) * this.room.width,
        z: (fz / (this.gz - 1) - 0.5) * this.room.depth,
        uncertainty: Math.round(Math.max(cellW, spread) * 100) / 100,
      };
    });

    peaks.sort((a, b) => b.value - a.value);

    const out = [];
    const strongest = peaks[0]?.value ?? 0;

    for (const c of peaks) {
      if (out.length >= maxPeaks) break;

      // Two blob centroids closer than their own uncertainty are not two
      // people; they are one region the level set happened to pinch.
      const tooClose = out.some((p) => {
        const needed = Math.max(
          minSeparation,
          (p.uncertainty ?? 0) * 0.9,
          (c.uncertainty ?? 0) * 0.9,
        );
        return Math.hypot(p.x - c.x, p.z - c.z) < needed;
      });
      if (tooClose) continue;

      // A genuine second person produces a mode of comparable strength. A
      // shoulder on one person's blob produces a markedly weaker one, so
      // secondary modes must reach a decent fraction of the strongest to be
      // believed. Erring toward undercounting is deliberate: missing someone
      // is a limitation, inventing someone is a fabrication.
      if (out.length > 0 && c.value < strongest * SECONDARY_PEAK_RATIO) continue;

      out.push(c);
    }

    return out;
  }

  /**
   * Best single position estimate, read off the likelihood field.
   *
   * This used to be a detection-strength-weighted centroid of the NODE
   * positions, which is a broken estimator by construction: a convex
   * combination of node coordinates can never leave the nodes' convex hull,
   * and with a symmetric layout it collapses toward the centroid regardless
   * of where the person is. It reported roughly the middle of the room for
   * every input and labelled the result "multilateration".
   *
   * The field already computes the answer, so read it from there — the
   * likelihood-weighted centroid over cells near the maximum. That estimate
   * can land anywhere in the room, including outside the node hull, because
   * it comes from range consistency rather than from averaging fixed points.
   */
  localize(nodes) {
    const active = nodes.filter((n) => n.online && !n.calibrating);
    if (active.length === 0) return null;

    if (this.evidence <= 0) return null;

    // Reuse the same segmentation the tracker consumes. Computing this a
    // second, different way is how `localization` and `persons` end up
    // disagreeing on screen about where the same person is.
    const [top] = this.findPeaks({ maxPeaks: 1, threshold: MIN_LOCALIZE_CONFIDENCE });
    if (!top) return null;

    // The regime label describes what the GEOMETRY can support. One node
    // yields a range ring with no bearing at all; two leave a two-fold
    // ambiguity; three or more genuinely intersect.
    const localization =
      active.length >= 3 ? 'multilateration'
      : active.length === 2 ? 'bilateration'
      : 'single-node-range-only';

    return {
      position: [round2(top.x), 0, round2(top.z)],
      nodeCount: active.length,
      localization,
      uncertainty_m: top.uncertainty,
      // One node cannot triangulate. Cap the confidence by the geometry
      // rather than letting a strong single reading look like a fix.
      confidence: clamp01(
        top.value * this.evidence *
        (active.length >= 3 ? 1 : active.length === 2 ? 0.6 : 0.3),
      ),
    };
  }

  /** Downsampled grid for the wire — the UI does not need full resolution. */
  toJSON() {
    return {
      grid_size: [this.gx, this.gy, this.gz],
      room: [this.room.width, this.room.height, this.room.depth],
      values: Array.from(this.smoothed, (v) => Math.round(v * 1000) / 1000),
      // The values are a position likelihood, normalised over the room. This
      // says how much signal the surface was built from, so a UI can dim a
      // confident-looking shape that rests on almost no evidence.
      evidence: Math.round(this.evidence * 1000) / 1000,
    };
  }
}
