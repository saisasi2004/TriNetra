/**
 * Sensing engine — the orchestrator.
 *
 * Owns every node's state, runs the per-tick fusion, and produces the single
 * `SensingUpdate` object that the WebSocket broadcasts and the REST API
 * serves. Everything the UI knows comes from here.
 */

import { EventEmitter } from 'node:events';

import { NodeState } from './node-state.js';
import { SignalField } from './field.js';
import { PersonTracker } from './persons.js';
import { PoseModel } from './pose.js';
import { SemanticEngine } from './semantic.js';
import { clamp01, mean, median, Ema, MedianRing } from '../dsp/stats.js';
import {
  planSizeMetres, planZones, planNodePositions,
} from '../../public/js/lib/plan.js';

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Confidence below which a vital sign is reported as null rather than shown.
 *
 * 0.30 is where the autocorrelation peak stops being distinguishable from the
 * best peak in noise. Displaying 16%-confidence numbers is what makes the
 * readout appear to "fluctuate continuously": each evaluation picks a
 * different noise peak, so the value jumps by 10 BPM while measuring nothing.
 * A blank reading is honest; a wandering number is not.
 */
const MIN_DISPLAY_CONFIDENCE = 0.30;

/**
 * Confidence a single node must reach before it may vote on a vital sign.
 * Below this it is reporting the best peak in noise, and including it in the
 * consensus only widens the apparent disagreement.
 */
const MIN_VOTER_CONFIDENCE = 0.25;

/** Room a node belongs to until an operator says otherwise. */
const DEFAULT_ROOM = 'main';

/**
 * BPM spread across nodes at which agreement is considered zero.
 *
 * Two nodes watching the same chest should land within a couple of BPM of
 * each other. Ten BPM apart means at least one of them is tracking something
 * that is not the subject's breathing, and the fused confidence should say so.
 */
const AGREEMENT_TOLERANCE_BPM = 8;

/**
 * Cross-node consensus for one vital sign, smoothed over time.
 *
 * Kept as a small class because breathing and heart rate need exactly the
 * same treatment with different tuning, and because the temporal state has
 * to persist across ticks.
 */
class VitalConsensus {
  constructor({ emaAlpha, medianWindow }) {
    this.median = new MedianRing(medianWindow);
    this.ema = new Ema(emaAlpha);
    this.confEma = new Ema(0.2);
    this.value = 0;
    this.confidence = 0;
  }

  reset() {
    this.median.clear();
    this.ema.reset();
    this.confEma.reset();
    this.value = 0;
    this.confidence = 0;
  }

  /** @param votes [{ v: bpm|null, c: confidence }] */
  update(votes) {
    const usable = votes
      .filter((s) => s.v != null && s.v > 0 && (s.c ?? 0) >= MIN_VOTER_CONFIDENCE)
      .sort((a, b) => a.v - b.v);

    if (usable.length === 0) {
      // Decay rather than snapping to zero, so a single barren tick in an
      // otherwise good stretch does not blank the display.
      this.confidence = this.confEma.update(0);
      if (this.confidence < 0.02) { this.reset(); }
      return { value: this.value, confidence: this.confidence, contributors: 0, agreement: 0 };
    }

    // Confidence-weighted median: the value at which half the confidence
    // mass lies below. Robust to one node locked onto a harmonic in a way
    // that a weighted mean is not.
    const total = usable.reduce((s, x) => s + x.c, 0);
    let acc = 0, med = usable[usable.length - 1].v;
    for (const s of usable) {
      acc += s.c;
      if (acc >= total / 2) { med = s.v; break; }
    }

    // Agreement: the median absolute deviation of the voters about that
    // consensus, expressed as 0..1.
    const mad = median(usable.map((s) => Math.abs(s.v - med)));
    const agreement = usable.length === 1
      ? SINGLE_VOTER_AGREEMENT
      : clamp01(1 - mad / AGREEMENT_TOLERANCE_BPM);

    this.value = this.ema.update(this.median.push(med));

    const raw = Math.max(...usable.map((s) => s.c)) * (0.4 + 0.6 * agreement);
    this.confidence = this.confEma.update(clamp01(raw));

    return {
      value: this.value,
      confidence: this.confidence,
      contributors: usable.length,
      agreement,
    };
  }
}

/**
 * A lone voter cannot be corroborated, so it is neither trusted like a
 * consensus nor discarded — one node is the normal case in a small install.
 */
const SINGLE_VOTER_AGREEMENT = 0.6;

/** Node positions arrive as float32, so compare with a tolerance rather than
 *  by equality — otherwise float32->float64 widening makes every heartbeat
 *  look like a position change and spams the log. 1 mm is far below any
 *  accuracy this system can claim. */
function samePosition(a, b) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < 1e-3 &&
         Math.abs(a[1] - b[1]) < 1e-3 &&
         Math.abs(a[2] - b[2]) < 1e-3;
}

export class SensingEngine extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log('engine');

    this.nodes = new Map();
    this.field = new SignalField({ room: config.room, grid: config.fieldGrid });
    this.tracker = new PersonTracker({ room: config.room, zones: [] });
    this.pose = new PoseModel();
    this.semantic = new SemanticEngine();

    // Room-level fused vitals, distinct from any single node's. Heart rate
    // gets a longer median and slower EMA: the cardiac signal is far weaker
    // than respiration, so its per-node estimates are noisier and need more
    // averaging to be worth showing at all.
    this.breathFused = new VitalConsensus({ emaAlpha: 0.15, medianWindow: 9 });
    this.heartFused = new VitalConsensus({ emaAlpha: 0.10, medianWindow: 13 });

    this.tick = 0;
    this.startedAt = Date.now();
    this.lastUpdate = null;
    this.lastTickAt = Date.now();
    this.source = 'offline';
    this.plan = null;
    this.zones = [];
    this.eventLog = [];
    this.stats = { packets: 0, csi: 0, vitals: 0, status: 0, events: 0, rejected: 0 };
  }

  // ── Node lifecycle ─────────────────────────────────────────────────────

  getNode(nodeId, hint = {}) {
    let node = this.nodes.get(nodeId);
    if (!node) {
      node = new NodeState(nodeId, {
        historyFrames: this.config.historyFrames,
        calibrationSeconds: this.config.calibrationSeconds,
        position: hint.position ?? this.#defaultPosition(nodeId),
      });
      // Default every node into ONE room, not into a room of its own.
      //
      // `room-${nodeId}` made a four-node single-room install look like four
      // separate rooms, so the multi_room_transition detector fired every
      // time presence happened to be strongest on a different node — which,
      // for a person sitting still between two of them, is constantly. A
      // multi-room deployment is the configured case (POST /nodes/:id/room);
      // one room is the default one, and it should be the default here.
      node.room = hint.room ?? DEFAULT_ROOM;
      this.nodes.set(nodeId, node);
      this.log.info(`node ${nodeId} registered at [${node.position.join(', ')}]`);
      this.emit('node:added', node);
    }
    return node;
  }

  /**
   * Default placement for a node that never told us where it is.
   *
   * The ORDER matters, and it is chosen for a three-node install because
   * that is the smallest array that can multilaterate at all — two range
   * circles intersect in two points, so two nodes leave a mirror ambiguity
   * that no amount of processing resolves. Three is the first count that
   * yields a unique fix, which makes it the layout most worth getting right.
   *
   * The ordering below is the one that MEASURED best, which is not the one
   * that looked best on paper. Candidate three-node layouts were run against
   * the simulator over 9 subject positions x 3 seeds:
   *
   *   one node per wall, well spread   median 0.92 m   p90 1.68 m
   *   L-shape (2 back + 1 far corner)  median 0.92 m   p90 2.12 m
   *   isoceles (2 back + front mid)    median 0.93 m   p90 2.43 m
   *   wide triangle (3 corners)        median 1.21 m   p90 3.32 m
   *   -- four corners, for reference   median 0.94 m   p90 1.41 m
   *
   * Two things fall out of that, and both are worth knowing before hanging
   * any hardware. Every layout has a similar MEDIAN — the differences live
   * entirely in the tail, which is to say in the awkward corners, which is
   * exactly where a sensing system gets judged. And a well-placed three-node
   * array is within 0.27 m of a four-node one at p90, while a badly-placed
   * one is more than twice as bad. Placement matters more than count.
   *
   * The winning arrangement spreads the nodes across three DIFFERENT walls
   * so their triangle contains the middle of the room. Clustering them on
   * two adjacent walls — which is what walking the corners in order gives
   * you — leaves the far side outside the triangle, where range circles meet
   * at shallow angles and a small range error swings the fix a long way.
   * That is geometric dilution of precision, and it is a property of where
   * you hang the boxes, not of the code.
   *
   * A guessed layout still beats stacking everything at the origin, but it
   * IS a guess — provision real positions for anything you care about.
   */
  #defaultPosition(nodeId) {
    const { width, depth } = this.config.room;
    const x = width / 2 - 0.3;
    const z = depth / 2 - 0.3;
    const slots = [
      [0, 1.2, -z],    // 1: back wall, centred
      [x, 1.2, 0],     // 2: right wall, centred
      [-x, 1.2, z],    // 3: front-left  — completes a room-spanning triangle
      [x, 1.2, z],     // 4: front-right
      [-x, 1.2, -z],   // 5: back-left
      [0, 1.2, z],     // 6: front wall, centred
    ];
    return slots[(nodeId - 1) % slots.length];
  }

  setNodePosition(nodeId, position) {
    const node = this.getNode(nodeId);
    node.position = position;
    return node;
  }

  setNodeRoom(nodeId, room) {
    const node = this.getNode(nodeId);
    node.room = room;
    return node;
  }

  recalibrate(nodeId = null) {
    if (nodeId === null) {
      for (const n of this.nodes.values()) n.recalibrate();
      this.log.info('recalibrating all nodes');
    } else {
      this.nodes.get(nodeId)?.recalibrate();
      this.log.info(`recalibrating node ${nodeId}`);
    }
  }

  setZones(zones) {
    this.zones = zones;
    this.tracker.zones = zones;
  }

  /**
   * Adopt a floor plan as the definition of the sensing space.
   *
   * Three things follow from a plan, and they are the whole reason a drawn
   * layout is worth more than a picture:
   *
   *   FOOTPRINT. The field grid spans `config.room`. Until now that came from
   *   --room-size and had to be kept in agreement with the drawing by hand —
   *   the observatory literally warns you when they disagree, because a
   *   mismatch puts every tracked person in the wrong place. Taking it from
   *   the plan removes the opportunity to get it wrong.
   *
   *   ZONES. Rooms become zones, so a person is reported in `kitchen` rather
   *   than in the `north-west` quadrant fallback. That is what makes zone
   *   automations and the bathroom_occupied detector mean anything.
   *
   *   NODE POSITIONS. The field multilaterates against KNOWN node positions;
   *   a guessed layout produces a plausible-looking field that is wrong
   *   everywhere. Placing nodes on the drawing is the least error-prone way
   *   to tell the server where they physically hang.
   *
   * Node positions provisioned into a node's own NVS still win: those arrive
   * on every heartbeat and are applied in `ingest`, which runs far more often
   * than this does. The plan supplies the positions of nodes that never told
   * us where they are, which is the common case for a fleet flashed before
   * anyone decided where they would go.
   *
   * @param opts.adoptRoom  false when the operator passed --room-size
   *                        explicitly; an explicit flag always beats a file.
   */
  applyPlan(plan, { adoptRoom = true } = {}) {
    if (!plan) return null;
    this.plan = plan;

    if (adoptRoom) {
      const size = planSizeMetres(plan);
      const changed = size.width !== this.config.room.width ||
                      size.depth !== this.config.room.depth;

      this.config.room = size;

      // The field's grid is baked in at construction, so a footprint change
      // means a new field rather than a resized one. Its smoothed values are
      // discarded, which is correct: they described a different room.
      if (changed) {
        this.field = new SignalField({ room: size, grid: this.config.fieldGrid });
        this.tracker.room = size;
        this.log.info(`room -> ${size.width}×${size.depth}×${size.height} m (from plan "${plan.id}")`);
      }
    }

    this.setZones(planZones(plan));

    for (const { node_id: nodeId, position, room } of planNodePositions(plan)) {
      const node = this.getNode(nodeId, { position, room: room ?? DEFAULT_ROOM });
      node.position = position;
      if (room) node.room = room;
    }

    this.log.info(
      `plan "${plan.id}" applied: ${this.zones.length} zones, ` +
      `${plan.nodes?.length ?? 0} node position(s)`,
    );

    return plan;
  }

  /** Compact description of the active plan, for the wire payload. */
  planSummary() {
    if (!this.plan) return null;
    return {
      id: this.plan.id,
      name: this.plan.name,
      units: this.plan.units ?? 'ft',
      rooms: this.plan.rooms?.length ?? 0,
    };
  }

  // ── Ingest ─────────────────────────────────────────────────────────────

  ingest(packet, nowMs = Date.now()) {
    if (!packet) { this.stats.rejected++; return; }
    this.stats.packets++;

    // A status packet may carry the node's provisioned position. Pass it as a
    // registration hint so a node that has never been seen is placed correctly
    // on its very first packet, rather than being registered at a guessed
    // perimeter slot and silently keeping that guess forever.
    const node = this.getNode(packet.nodeId,
      packet.position ? { position: packet.position } : {});

    // Also apply it on every heartbeat, so re-provisioning a node's position
    // takes effect without restarting the server.
    if (packet.position && !samePosition(node.position, packet.position)) {
      this.log.info(
        `node ${packet.nodeId} position ${node.position.map(round2).join(', ')} ` +
        `-> ${packet.position.map(round2).join(', ')} (from node)`);
      node.position = packet.position;
    }

    switch (packet.kind) {
      case 'csi':
        this.stats.csi++;
        node.ingestCsi(packet, nowMs);
        this.source = packet.flags?.mock ? 'simulated' : 'live';
        break;
      case 'vitals':
        this.stats.vitals++;
        node.ingestVitals(packet, nowMs);
        if (this.source === 'offline') this.source = packet.flags?.mock ? 'simulated' : 'live';
        break;
      case 'status':
        this.stats.status++;
        node.ingestStatus(packet, nowMs);
        break;
      case 'event':
        this.stats.events++;
        node.ingestEvent(packet, nowMs);
        this.#logEvent({ ...packet, source: `node-${packet.nodeId}` }, nowMs);
        this.emit('event', packet);
        break;
      default:
        this.stats.rejected++;
    }
  }

  #logEvent(ev, nowMs) {
    this.eventLog.push({ ...ev, at: nowMs });
    if (this.eventLog.length > 500) this.eventLog.shift();
  }

  // ── Per-tick fusion ────────────────────────────────────────────────────

  update(nowMs = Date.now()) {
    const dt = Math.max(0.01, (nowMs - this.lastTickAt) / 1000);
    this.lastTickAt = nowMs;
    this.tick++;

    const nodes = [...this.nodes.values()];

    for (const n of nodes) {
      n.expireFall(nowMs);
      if (n.checkTimeout(nowMs, this.config.nodeTimeoutMs)) {
        this.log.warn(`node ${n.nodeId} went offline`);
        this.emit('node:offline', n);
      }
    }

    const online = nodes.filter((n) => n.online);
    if (online.length === 0) this.source = 'offline';

    // ── Fused room-level state ──
    const presence = online.some((n) => n.presence);
    const motionEnergy = online.length
      ? Math.max(...online.map((n) => n.motionEnergy))
      : 0;
    const fall = online.some((n) => n.fall);

    // ── Spatial field and person tracks ──
    this.field.update(nodes);

    // Peaks only become people when presence is actually detected. The field
    // always has SOME maximum — ambient noise has a shape — so feeding peaks
    // to the tracker unconditionally invents a person in an empty room.
    // Presence is the gate; the field only says where.
    // Cap the peak count by the evidence available. With one node there is
    // no directional information at all, so claiming to resolve several
    // separate people from it would be invention; two nodes give a coarse
    // intersection; only three or more support a genuine multi-person
    // count. The cap is deliberately stricter than the field's resolution.
    const maxPeaks = online.length >= 3 ? 5 : online.length === 2 ? 2 : 1;

    const peaks = presence
      ? this.field.findPeaks({ maxPeaks, threshold: 0.55, minSeparation: 1.5 })
      : [];
    this.tracker.update(peaks, { nodes, nowMs, presence });

    // Vitals come from whichever node has the most confident reading. Not an
    // average: averaging a confident reading with a node that sees nothing
    // just drags a good number toward zero.
    const bestVitals = this.#bestVitals(online, presence);

    // ── Person payload with kinematic skeletons ──
    const activeIds = new Set(this.tracker.confirmed.map((t) => t.id));
    this.pose.gc(activeIds);

    const persons = this.tracker.toJSON((track) =>
      this.pose.build(track, {
        breathingBpm: bestVitals.breathing_rate_bpm ?? 0,
        dt,
        confidence: track.confidence,
        posture: track.posture,
      }),
    );

    const localization = this.field.localize(nodes);

    // ── Semantics ──
    const semantic = this.semantic.update({
      nodes, persons, vitals: bestVitals, presence, motionEnergy, fall, nowMs,
    });

    for (const n of nodes) {
      while (n.events.length) {
        const ev = n.events.shift();
        this.#logEvent({ ...ev, source: `node-${n.nodeId}` }, nowMs);
        this.emit('event', ev);
      }
    }

    // ── Aggregate features ──
    const features = this.#aggregateFeatures(online);

    const classification = {
      motion_level: !presence ? 'none'
        : motionEnergy > 0.28 ? 'high'
        : motionEnergy > 0.08 ? 'low'
        : 'still',
      presence,
      confidence: clamp01(
        online.length
          ? mean(online.map((n) => (n.presence ? n.presenceScore : 1 - n.presenceScore)))
          : 0,
      ),
    };

    const calibrating = online.some((n) => n.calibrating);
    const anyMock = nodes.some((n) => n.mock);

    const update = {
      type: 'sensing_update',
      timestamp: nowMs / 1000,
      tick: this.tick,
      uptime_s: Math.round((nowMs - this.startedAt) / 1000),

      // Provenance travels with every payload. A UI must never have to guess
      // whether it is looking at a measurement or a simulation.
      source: this.source,
      data_quality: anyMock ? 'SIMULATED' : online.length ? 'MEASURED' : 'NO_DATA',
      calibrating,

      nodes: nodes.map((n) => n.toJSON()),
      node_count: nodes.length,
      nodes_online: online.length,

      features,
      classification,
      signal_field: this.field.toJSON(),

      // Which layout the geometry above refers to. The observatory renders
      // the plan client-side, so it has to know when the active plan changes
      // underneath it — otherwise it keeps drawing the old flat around
      // correctly-placed people.
      floorplan: this.planSummary(),

      vital_signs: bestVitals,
      persons,
      estimated_persons: persons.length,
      count_method: this.tracker.countMethod,

      localization,
      pose_source: 'kinematic-model',
      posture: persons[0]?.posture ?? (presence ? 'unknown' : 'absent'),

      fall_detected: fall,
      semantic_states: semantic,
      active_states: this.semantic.active(nowMs),

      signal_quality_score: online.length
        ? Math.round(mean(online.map((n) => n.signalQuality)) * 100) / 100
        : 0,
      quality_verdict: this.#qualityVerdict(online),

      stats: { ...this.stats },
    };

    this.lastUpdate = update;
    this.emit('update', update);
    return update;
  }

  /**
   * Fuse the nodes' vital signs into one room-level reading.
   *
   * This used to take the single most confident node's snapshot. That is the
   * direct cause of the reading "fluctuating continuously", and the mechanism
   * is worth stating because it is not obvious: the nodes disagree —
   * measured, by up to 14 BPM at the same instant on the same subject — and
   * their confidences are noisy and frequently tied at the ceiling. A
   * per-tick argmax over near-equal noisy scores therefore switches winner
   * every few ticks, and the published number teleports from one node's
   * estimate to another's. Single-tick jumps of 13.4 BPM were routine. None
   * of that is the subject's breathing changing; it is the fusion rule
   * resampling a different node.
   *
   * Three changes, each addressing a distinct failure:
   *
   *   AGREEMENT, not argmax. A confidence-weighted median asks what the
   *   nodes collectively say. One node locked onto a harmonic can no longer
   *   drag the room reading with it just by being confident about it.
   *
   *   DISAGREEMENT LOWERS CONFIDENCE. When the nodes cluster tightly the
   *   result is trustworthy; when they are scattered across 10 BPM, no
   *   single one of them has found the truth, and the honest response is a
   *   low confidence that falls under the display gate — not a coin flip
   *   between them presented at full confidence.
   *
   *   TEMPORAL CONTINUITY. Breathing rate is a physiological quantity that
   *   changes over seconds, so the published value is smoothed across ticks.
   *   A step that survives smoothing is a real change; one that does not was
   *   never a measurement.
   *
   * The two suppression gates are unchanged and still absolute. PRESENCE: a
   * heart rate for an empty room is not a low-confidence reading, it is a
   * reading of nothing. CONFIDENCE: below MIN_DISPLAY_CONFIDENCE the
   * autocorrelation has not found a periodicity it can defend, and null is
   * the correct answer.
   */
  #bestVitals(online, presence) {
    const blank = {
      breathing_rate_bpm: null, heart_rate_bpm: null,
      breathing_confidence: 0, heartbeat_confidence: 0,
      breathing_variability: 0, apnea_seconds: 0, signal_quality: 0,
      contributing_nodes: 0, node_agreement: 0,
    };

    if (!presence) {
      this.breathFused.reset();
      this.heartFused.reset();
      return blank;
    }

    const snaps = online.map((n) => n.vitals.snapshot());

    const br = this.breathFused.update(
      snaps.map((v) => ({ v: v.breathing_rate_bpm, c: v.breathing_confidence })),
    );
    const hr = this.heartFused.update(
      snaps.map((v) => ({ v: v.heart_rate_bpm, c: v.heartbeat_confidence })),
    );

    // Ancillary fields come from whichever node actually contributed most.
    const lead = snaps.reduce(
      (a, b) => ((b.breathing_confidence ?? 0) > (a?.breathing_confidence ?? -1) ? b : a),
      null,
    ) ?? {};

    return {
      // Suppress each channel independently: breathing is a far stronger
      // signal than the cardiac component, so respiration is often
      // trustworthy while heart rate is not. Zeroing both together would
      // throw away a good measurement to punish a bad one.
      breathing_rate_bpm: br.confidence >= MIN_DISPLAY_CONFIDENCE ? round1(br.value) : null,
      breathing_confidence: br.confidence >= MIN_DISPLAY_CONFIDENCE ? round2(br.confidence) : 0,
      heart_rate_bpm: hr.confidence >= MIN_DISPLAY_CONFIDENCE ? round1(hr.value) : null,
      heartbeat_confidence: hr.confidence >= MIN_DISPLAY_CONFIDENCE ? round2(hr.confidence) : 0,

      breathing_variability: lead.breathing_variability ?? 0,
      apnea_seconds: lead.apnea_seconds ?? 0,
      signal_quality: lead.signal_quality ?? 0,

      // How the number was arrived at, so a UI never has to guess whether it
      // is looking at a consensus or at one node's opinion.
      contributing_nodes: br.contributors,
      node_agreement: round2(br.agreement),
    };
  }

  #aggregateFeatures(online) {
    if (online.length === 0) {
      return {
        mean_rssi: 0, variance: 0, motion_band_power: 0, breathing_band_power: 0,
        dominant_freq_hz: 0, change_points: 0, spectral_power: 0,
      };
    }
    const f = online.map((n) => n.features);
    const avg = (key) => Math.round(mean(f.map((x) => x[key])) * 10000) / 10000;
    return {
      mean_rssi: Math.round(mean(f.map((x) => x.mean_rssi)) * 10) / 10,
      variance: avg('variance'),
      motion_band_power: avg('motion_band_power'),
      breathing_band_power: avg('breathing_band_power'),
      dominant_freq_hz: Math.round(mean(f.map((x) => x.dominant_freq_hz)) * 1000) / 1000,
      change_points: Math.round(mean(f.map((x) => x.change_points))),
      spectral_power: avg('spectral_power'),
    };
  }

  #qualityVerdict(online) {
    if (online.length === 0) return 'no_data';
    const q = mean(online.map((n) => n.signalQuality));
    if (q > 0.7) return 'good';
    if (q > 0.45) return 'fair';
    if (q > 0.2) return 'poor';
    return 'unusable';
  }

  snapshot() {
    return this.lastUpdate ?? this.update();
  }

  recentEvents(limit = 50) {
    return this.eventLog.slice(-limit).reverse();
  }
}
