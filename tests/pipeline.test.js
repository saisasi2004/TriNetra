/**
 * End-to-end pipeline tests.
 *
 * These drive the simulator into the real engine and assert on what comes
 * out. Because the simulator models BODIES and radio physics — never
 * outputs — a passing test here means the DSP genuinely recovered the
 * answer, not that a scenario asserted it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runScenario } from './harness.js';

/**
 * Seeds used for aggregate assertions.
 *
 * This pipeline is a stochastic estimator working near its detection limit,
 * so asserting on a single run tests luck rather than behaviour. Running a
 * fixed set of seeds and asserting on the SUCCESS RATE is both reproducible
 * and an honest description of what the system actually delivers.
 */
const SEEDS = [1, 7, 42, 99, 2024];

function acrossSeeds(scenario, seconds, fn) {
  return SEEDS.map((seed) => fn(runScenario(scenario, seconds, { seed })));
}

test('empty room never reports presence or people, on any seed', () => {
  // False positives are the failure that destroys trust in a sensing system,
  // so this one must hold on EVERY seed, not most of them.
  const results = acrossSeeds('empty_room', 60, ({ update }) => ({
    presence: update.classification.presence,
    people: update.estimated_persons,
    br: update.vital_signs.breathing_rate_bpm,
  }));

  for (const [i, r] of results.entries()) {
    assert.equal(r.presence, false, `seed ${SEEDS[i]}: false presence in an empty room`);
    assert.equal(r.people, 0, `seed ${SEEDS[i]}: invented ${r.people} people`);
    assert.equal(r.br, null, `seed ${SEEDS[i]}: reported breathing with nobody there`);
  }
});

test('a seated person is detected on every seed', () => {
  const detected = acrossSeeds('single_breathing', 80,
    ({ update }) => update.classification.presence);
  const hits = detected.filter(Boolean).length;
  assert.equal(hits, SEEDS.length,
    `presence detected in only ${hits}/${SEEDS.length} seeds`);
});

test('breathing is recovered within 5 BPM in most seeds', () => {
  // Measured behaviour for the hardest geometry we simulate: a seated
  // subject ~4 m diagonally from corner-mounted nodes, where the chest
  // signal is ~5% modulation depth. Closer nodes do considerably better.
  const errors = acrossSeeds('single_breathing', 80, ({ update, truth }) => {
    const br = update.vital_signs.breathing_rate_bpm;
    return br == null ? null : Math.abs(br - truth.people[0].breathing_bpm);
  });

  const good = errors.filter((e) => e != null && e < 5).length;
  assert.ok(good >= 3,
    `breathing within 5 BPM in only ${good}/${SEEDS.length} seeds: ${JSON.stringify(errors)}`);

  // Whatever it reports must never be wildly wrong — a confident bad number
  // is worse than no number.
  for (const [i, e] of errors.entries()) {
    if (e != null) {
      assert.ok(e < 9, `seed ${SEEDS[i]}: breathing off by ${e.toFixed(1)} BPM`);
    }
  }
});

test('the person count is never inflated beyond the truth', () => {
  // Undercounting is a limitation; overcounting is a fabrication. The count
  // may miss someone, but it must not invent anybody.
  const counts = acrossSeeds('single_breathing', 80,
    ({ update }) => update.estimated_persons);
  for (const [i, c] of counts.entries()) {
    assert.ok(c <= 2, `seed ${SEEDS[i]}: counted ${c} for a single occupant`);
  }
  assert.ok(counts.filter((c) => c === 1).length >= 2,
    `exactly-1 count in only ${counts.filter((c) => c === 1).length}/${SEEDS.length} seeds`);
});

test('presence fires for a still person via the breathing path', () => {
  // The point of the second presence path: a seated, still subject produces
  // almost no amplitude change, so motion-energy presence alone is blind to
  // exactly the cases that matter most.
  const { update } = runScenario('single_breathing', 80);
  const reasons = update.nodes.filter((n) => n.presence).map((n) => n.presence_reason);
  assert.ok(reasons.length > 0, 'no node reported presence');
  assert.ok(
    reasons.some((r) => r.includes('breathing')),
    `expected a breathing-based detection, got: ${reasons.join(', ')}`,
  );
});

test('two walkers are detected, and reported as at least one person', () => {
  // This test used to demand >= 2, and passed — but only because the field
  // was producing one artefact per node rather than per person, so the two
  // "people" it counted were both at fixed positions next to nodes and
  // neither corresponded to a walker. With the field actually solving for
  // position, the honest answer is that four monostatic single-antenna
  // nodes cannot separate two bodies: see the note in field.js for the
  // matching-pursuit attempt and why it was removed.
  //
  // So this asserts what the system genuinely delivers — both walkers are
  // DETECTED, and localised between them — and pins the undercount as
  // known behaviour rather than letting a regression pass unnoticed.
  const { update, truth } = runScenario('two_walking', 70);

  assert.equal(update.classification.presence, true);
  assert.ok(update.estimated_persons >= 1,
    `expected at least one person, got ${update.estimated_persons}`);
  assert.equal(update.count_method, 'multi-node-field-peaks');

  // Never MORE than the truth. This is the direction that must not break.
  assert.ok(update.estimated_persons <= truth.people.length,
    `counted ${update.estimated_persons} for ${truth.people.length} occupants`);

  // The reported position must lie within the room and be closer to one of
  // the walkers than a random guess would be.
  const p = update.persons[0];
  assert.ok(p, 'no person reported despite presence');
  const nearest = Math.min(...truth.people.map((t) =>
    Math.hypot(p.position[0] - t.position[0], p.position[2] - t.position[2])));
  assert.ok(nearest < 2.5,
    `reported position is ${nearest.toFixed(2)} m from the nearest walker`);
});

test('a fall raises a fall event', () => {
  // fall_detected is momentary (5 s cooldown), so watch the whole run
  // rather than the final tick.
  let sawFall = false;
  let sawAt = null;

  const { engine } = runScenario('fall_event', 45, {
    onTick: (update, t) => {
      if (update.fall_detected && !sawFall) { sawFall = true; sawAt = t; }
    },
  });

  const events = engine.recentEvents(200).filter((e) => e.type === 'fall');
  assert.ok(
    sawFall || events.length > 0,
    'no fall detected — the scripted fall at t=12s was missed entirely',
  );
  if (sawAt != null) {
    assert.ok(sawAt > 5, `fall reported implausibly early at t=${sawAt}s`);
  }
});

test('a sleeping subject produces slow regular breathing', () => {
  const readings = acrossSeeds('sleep_monitoring', 100,
    ({ update }) => update.vital_signs.breathing_rate_bpm);

  const got = readings.filter((b) => b != null);
  assert.ok(got.length >= 3,
    `breathing recovered in only ${got.length}/${SEEDS.length} seeds while asleep`);
  for (const br of got) {
    assert.ok(br < 24, `expected slow breathing while asleep, got ${br} BPM`);
  }
});

test('vitals are suppressed, not guessed, while walking', () => {
  // Chest displacement is millimetres; walking is centimetres. Reporting a
  // breathing rate through gross motion would be fabrication.
  const { update } = runScenario('two_walking', 60);
  const br = update.vital_signs.breathing_rate_bpm;
  const conf = update.vital_signs.breathing_confidence;
  assert.ok(
    br == null || conf < 0.5,
    `reported breathing ${br} BPM at confidence ${conf} through heavy motion`,
  );
});

test('every payload carries honest provenance', () => {
  const { update } = runScenario('single_breathing', 45);

  assert.equal(update.data_quality, 'SIMULATED',
    'simulated data must be labelled SIMULATED end to end');
  assert.equal(update.source, 'simulated');
  assert.equal(update.pose_source, 'kinematic-model',
    'skeletons must never be advertised as per-joint CSI inference');
  assert.ok(update.count_method, 'person count must state how it was derived');

  for (const p of update.persons) {
    assert.ok(p.position_uncertainty_m > 0,
      'positions must carry an uncertainty radius, not imply a point fix');
    assert.ok(['good', 'coarse', 'room-level'].includes(p.position_quality));
  }
});

test('nodes go offline when their packets stop', () => {
  const { engine } = runScenario('single_breathing', 40);
  // The harness runs on a virtual clock that is already ahead of wall time,
  // so the future must be measured from the engine's own last tick.
  const future = engine.lastTickAt + 60_000;
  const update = engine.update(future);
  assert.equal(update.nodes_online, 0);
  assert.equal(update.classification.presence, false);
  assert.equal(update.source, 'offline');
});

test('the room-active semantic state fires under sustained motion', () => {
  const { update } = runScenario('two_walking', 70);
  assert.equal(update.semantic_states.room_active.active, true);
  assert.ok(update.semantic_states.room_active.evidence.length > 0,
    'semantic states must explain themselves');
});

/**
 * Localisation regression tests.
 *
 * These exist because the whole suite passed for a long time while the
 * spatial field encoded only the NODE LAYOUT and nothing about the occupant:
 * a subject anywhere in the room was reported within 0.2 m of a node's
 * coordinate, error over 3 m in a 6 m room. Nothing caught it, because
 * nothing compared a reported position against the truth. The single most
 * important property of a localisation system had no test at all.
 */

/**
 * Place a still subject at a known spot and report the MEDIAN error over the
 * run rather than the error at one arbitrary tick.
 *
 * Single-tick sampling of a stochastic estimator tests luck, exactly as the
 * note on SEEDS above says: the same geometry that medians at 0.1 m produces
 * individual ticks past 2 m.
 */
function locateAt(x, z, seed = 12345) {
  const errors = [];
  let lastEvidence = 0;

  const { update } = runScenario({
    id: `probe_${x}_${z}`,
    label: 'probe',
    description: 'localisation probe',
    group: 'test',
    people: [{
      name: 'subject', motion: 'still', position: [x, z],
      posture: 'sitting', breathingBpm: 14.5, heartBpm: 68,
    }],
  }, 80, {
    seed,
    onTick: (u) => {
      lastEvidence = u.signal_field.evidence ?? 0;
      const p = u.persons[0] ?? (u.localization
        ? { position: u.localization.position } : null);
      if (p) errors.push(Math.hypot(p.position[0] - x, p.position[2] - z));
    },
  });

  errors.sort((a, b) => a - b);
  return {
    update,
    samples: errors.length,
    medianError: errors.length ? errors[errors.length >> 1] : Infinity,
    evidence: lastEvidence,
  };
}

test('reported position tracks the subject, not the nearest node', () => {
  // The decisive test: the person moves, the estimate must move WITH them.
  // A field that peaks on node positions passes every other test in this
  // file and fails this one.
  const NODES = [[-2.7, -2.2], [2.7, -2.2], [2.7, 2.2], [-2.7, 2.2]];

  // Each spot sits about 1 m from a different node, so an estimate that
  // tracks the layout instead of the person lands ~1 m out on every one of
  // them and is caught by the node-distance assertion below.
  const spots = [[-2, -1.5], [2, 1.5], [2, -1.5], [-2, 1.5]];

  for (const [x, z] of spots) {
    const { medianError, samples, update } = locateAt(x, z);

    assert.ok(samples > 50,
      `only ${samples} positions reported for a subject at [${x}, ${z}]`);
    assert.ok(medianError < 1.0,
      `subject at [${x}, ${z}] localised ${medianError.toFixed(2)} m away ` +
      '(median over the run)');

    // The decisive check. The old field peaked ON the nodes, so its estimate
    // was always ~0 m from one and ~1 m from the person. Requiring the
    // estimate to be nearer the person than the nearest node fails any
    // layout-tracking field regardless of how the error threshold is tuned.
    const p = update.persons[0] ?? { position: update.localization.position };
    const nodeDist = Math.min(...NODES.map(([nx, nz]) => Math.hypot(
      p.position[0] - nx, p.position[2] - nz)));
    assert.ok(nodeDist > 0.4,
      `estimate for [${x}, ${z}] sits ${nodeDist.toFixed(2)} m from a node — ` +
      'the field is reporting the node layout, not the occupant');
  }
});

test('the field reports how much evidence a position rests on', () => {
  // A position with no evidence behind it must not look like a measurement.
  const near = locateAt(-2, -1.5);
  const centre = locateAt(0, 0);

  assert.ok(near.evidence > centre.evidence,
    'a subject beside a node must yield more evidence than one at the ' +
    `centre of the room (got ${near.evidence} vs ${centre.evidence})`);

  // And the weaker geometry must be the less accurate one, so a consumer
  // can trust evidence as a proxy for how much to believe the position.
  assert.ok(centre.medianError > near.medianError,
    `centre-of-room error ${centre.medianError.toFixed(2)} m should exceed ` +
    `near-node error ${near.medianError.toFixed(2)} m`);
});

test('fused vitals do not teleport between nodes', () => {
  // The "vitals fluctuate continuously" complaint, pinned. A per-tick argmax
  // over noisy per-node confidences switches winner every few ticks and the
  // published number jumps by 10+ BPM while the subject breathes steadily.
  const series = [];
  runScenario('single_breathing', 120, {
    onTick: (u) => {
      const v = u.vital_signs.breathing_rate_bpm;
      if (v != null) series.push(v);
    },
  });

  assert.ok(series.length > 100,
    `breathing reported on only ${series.length} ticks`);

  let worst = 0;
  for (let i = 1; i < series.length; i++) {
    worst = Math.max(worst, Math.abs(series[i] - series[i - 1]));
  }
  // Measured worst case is 0.7 BPM. The bound is set at 3 to leave room for
  // seed variation while still failing hard if the argmax fusion — or a
  // frame-rate-tied decay that blanks and re-acquires the reading — ever
  // comes back. Before the fix this was routinely above 13.
  assert.ok(worst <= 3,
    `breathing jumped ${worst.toFixed(1)} BPM between consecutive ticks`);

  // Stability must not have been bought by reporting a constant. The value
  // has to actually track the subject.
  const spread = Math.max(...series) - Math.min(...series);
  assert.ok(spread > 0.5,
    `breathing was pinned at ${series[0]} BPM for the whole run — stable ` +
    'but not a measurement');
});

test('a stale vital fades on wall-clock time, not on frame count', () => {
  // The decay used to be a fixed factor per CSI frame, so it ran four times
  // faster on a node sending at 80 Hz than at 20 Hz, and at either rate it
  // discarded a reading far sooner than the 12.8 s window it was drawn from.
  const { engine } = runScenario('single_breathing', 80);
  const node = [...engine.nodes.values()].find((n) => n.vitals.breathingConf > 0.3);
  assert.ok(node, 'precondition: some node has a confident reading');

  const before = node.vitals.breathingConf;
  const startedAt = node.vitals.lastUpdateMs;

  // Two seconds of dead air: half a half-life, so roughly 70% should survive.
  node.vitals.update(node.phaseHistory.toArray(), node.sampleRateHz, {
    motionEnergy: 0, presence: false, nowMs: startedAt + 2000, breathRatio: 0,
  });

  const after = node.vitals.breathingConf;
  assert.ok(after < before, 'confidence must decay when evidence stops');
  assert.ok(after > before * 0.4,
    `confidence fell from ${before.toFixed(2)} to ${after.toFixed(2)} in 2 s — ` +
    'faster than the 4 s half-life, so it is still frame-tied');
});

test('recalibration clears every learned baseline, not just motion', () => {
  const { engine } = runScenario('single_breathing', 60);
  const node = [...engine.nodes.values()][0];

  assert.ok(node.breathBaselineEma.primed, 'precondition: baseline was learned');

  engine.recalibrate();

  assert.equal(node.calibrating, true);
  assert.equal(node.breathBaselineEma.primed, false,
    'breathing baseline survived recalibration — it defines what "empty" ' +
    'means for a still person, so a stale one keeps the original fault');
  assert.equal(node.couplingBaseline.primed, false,
    'coupling baseline survived recalibration — the spatial field is built ' +
    'entirely from excess coupling against it');
  assert.equal(node.presence, false);
});

test('the payload never contradicts itself about occupancy', () => {
  // The dashboard showed "PRESENCE YES / PEOPLE 1 / POSTURE Absent" at the
  // same time, because posture was taken from the geometrically nearest node
  // whether or not that node was detecting anything. A reading that argues
  // with itself is one a user stops trusting, whichever half is right.
  let checked = 0;

  runScenario('single_breathing', 90, {
    onTick: (u) => {
      checked++;

      // A reported person may never be described as absent.
      for (const p of u.persons) {
        assert.notEqual(p.posture, 'absent',
          `tracked person #${p.id} reported with posture "absent"`);
      }

      // Room posture must agree with room presence.
      if (u.persons.length > 0) {
        assert.notEqual(u.posture, 'absent',
          `${u.persons.length} people tracked but room posture is "absent"`);
      }
      if (!u.classification.presence) {
        assert.equal(u.persons.length, 0,
          'people reported while presence is false');
      }

      // Vitals may never be published for an empty room.
      if (!u.classification.presence) {
        assert.equal(u.vital_signs.breathing_rate_bpm, null,
          'breathing reported with no presence');
        assert.equal(u.vital_signs.heart_rate_bpm, null,
          'heart rate reported with no presence');
      }
    },
  });

  assert.ok(checked > 500, `only ${checked} ticks checked`);
});

/**
 * Three-node deployment.
 *
 * Three is the smallest array that can multilaterate at all: two range
 * circles meet at two points and leave a mirror ambiguity that no processing
 * resolves. It is also the common real-world count, and every other test in
 * this file runs on four — so without this, the configuration most likely to
 * be deployed is the one configuration nothing checks.
 */
const THREE_NODES = [
  { nodeId: 1, position: [0, 1.2, -2.2] },     // back wall, centred
  { nodeId: 2, position: [2.7, 1.2, 0] },      // right wall, centred
  { nodeId: 3, position: [-2.7, 1.2, 2.2] },   // front-left
];

test('three nodes still detect, localise and count honestly', () => {
  const errors = [];
  let counted = 0, ticks = 0;

  const { update } = runScenario('single_breathing', 90, {
    nodes: THREE_NODES,
    onTick: (u, t, sim) => {
      if (u.calibrating) return;
      ticks++;
      if (u.estimated_persons > 1) counted++;
      const truth = sim.truth().people[0];
      const p = u.persons[0];
      if (truth && p) {
        errors.push(Math.hypot(p.position[0] - truth.position[0],
                               p.position[2] - truth.position[2]));
      }
    },
  });

  assert.equal(update.classification.presence, true, 'no presence with three nodes');
  assert.equal(update.count_method, 'multi-node-field-peaks',
    'three nodes should still qualify as multi-node');
  assert.equal(counted, 0,
    `count exceeded one occupant on ${counted}/${ticks} ticks`);

  assert.ok(errors.length > 100, `only ${errors.length} positions reported`);
  errors.sort((a, b) => a - b);
  const median = errors[errors.length >> 1];

  // Measured across layouts and seeds, a well-placed three-node array
  // medians ~0.9 m and reaches ~1.7 m at p90. The bound here is deliberately
  // loose enough to survive seed variation and tight enough to fail if the
  // field ever goes back to tracking the node layout instead of the person.
  assert.ok(median < 1.6,
    `three-node median position error ${median.toFixed(2)} m`);
});

test('two nodes report their own ambiguity rather than hiding it', () => {
  // Two range circles intersect in two places. The system may still detect
  // and estimate, but it must not claim the same confidence as a real fix.
  const { update } = runScenario('single_breathing', 80, {
    nodes: THREE_NODES.slice(0, 2),
  });

  assert.equal(update.count_method, 'two-node-field-peaks',
    'two nodes must be labelled as such, not as multilateration');
  if (update.localization) {
    assert.notEqual(update.localization.localization, 'multilateration',
      'two nodes cannot multilaterate and must not say they did');
  }
});
