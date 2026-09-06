/**
 * Headless pipeline harness.
 *
 * Runs the simulator and the sensing engine in-process with time
 * accelerated, so a 90-second scenario evaluates in about a second. Used by
 * the pipeline tests and handy for tuning by hand:
 *
 *   node tests/harness.js single_breathing 90
 */

import { SensingEngine } from '../server/pipeline/engine.js';
import { CsiSimulator } from '../server/sim/generator.js';
import { decodePacket } from '../server/net/protocol.js';

const QUIET = () => ({
  error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
});

export function makeConfig(overrides = {}) {
  return {
    room: { width: 6.0, depth: 5.0, height: 2.7 },
    fieldGrid: [24, 1, 20],
    historyFrames: 256,
    nodeTimeoutMs: 5000,
    calibrationSeconds: 30,
    tickHz: 10,
    ...overrides,
  };
}

/**
 * Run a scenario headlessly.
 *
 * @param scenario   scenario id, or an inline { people: [...] } object for
 *                   tests that need a body at a specific place
 * @param seconds    simulated seconds AFTER calibration completes
 * @param opts.onTick(update, tSeconds) optional per-tick observer
 * @returns the final sensing update, plus the simulator's ground truth
 */
export function runScenario(scenario, seconds = 60, opts = {}) {
  const config = makeConfig(opts.config);
  const engine = new SensingEngine(config, QUIET);

  const { width, depth } = config.room;
  const nodes = opts.nodes ?? [
    { nodeId: 1, position: [-width / 2 + 0.3, 1.2, -depth / 2 + 0.3] },
    { nodeId: 2, position: [width / 2 - 0.3, 1.2, -depth / 2 + 0.3] },
    { nodeId: 3, position: [width / 2 - 0.3, 1.2, depth / 2 - 0.3] },
    { nodeId: 4, position: [-width / 2 + 0.3, 1.2, depth / 2 - 0.3] },
  ];

  for (const n of nodes) {
    engine.getNode(n.nodeId, { position: n.position, room: 'test-room' });
  }

  const sim = new CsiSimulator({
    room: config.room,
    nodes,
    scenario,
    rateHz: 20,
    warmupSeconds: config.calibrationSeconds + 1,
    // Fixed seed: a stochastic simulator makes every assertion a coin flip
    // and a real regression indistinguishable from bad luck.
    seed: opts.seed ?? 12345,
  });

  const csiHz = 20;
  const totalSeconds = config.calibrationSeconds + 1 + seconds;
  const totalFrames = Math.round(totalSeconds * csiHz);
  const framesPerTick = csiHz / config.tickHz;

  // Virtual clock: the engine's timeouts and dwell timers are wall-clock
  // based, so we advance a fake `now` rather than actually waiting.
  let now = Date.now();
  let last = null;

  for (let f = 0; f < totalFrames; f++) {
    now += 1000 / csiHz;
    for (const buf of sim.step()) {
      engine.ingest(decodePacket(buf), now);
    }
    if (f % framesPerTick === 0) {
      last = engine.update(now);
      opts.onTick?.(last, f / csiHz, sim);
    }
  }

  return { update: last, truth: sim.truth(), engine, sim };
}

// CLI use: node tests/harness.js <scenario> [seconds]
if (process.argv[1]?.endsWith('harness.js')) {
  const scenario = process.argv[2] ?? 'single_breathing';
  const seconds = Number(process.argv[3] ?? 60);

  const t0 = Date.now();
  const { update, truth } = runScenario(scenario, seconds);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nscenario: ${scenario}  (${seconds}s simulated in ${elapsed}s real)\n`);
  console.log('GROUND TRUTH');
  for (const p of truth.people) {
    console.log(`  ${p.name.padEnd(10)} pos=[${p.position[0]}, ${p.position[2]}]  ` +
                `${p.posture}  br=${p.breathing_bpm}  hr=${p.heart_bpm}`);
  }
  if (truth.people.length === 0) console.log('  (empty room)');

  console.log('\nDETECTED');
  console.log(`  presence      : ${update.classification.presence}`);
  console.log(`  motion level  : ${update.classification.motion_level}`);
  console.log(`  persons       : ${update.estimated_persons} (${update.count_method})`);
  console.log(`  posture       : ${update.posture}`);
  console.log(`  breathing     : ${update.vital_signs.breathing_rate_bpm} BPM ` +
              `(conf ${update.vital_signs.breathing_confidence})`);
  console.log(`  heart rate    : ${update.vital_signs.heart_rate_bpm} BPM ` +
              `(conf ${update.vital_signs.heartbeat_confidence})`);
  console.log(`  fall          : ${update.fall_detected}`);
  console.log(`  signal quality: ${update.signal_quality_score}`);

  for (const p of update.persons) {
    console.log(`  -> person ${p.id}: pos=[${p.position[0]}, ${p.position[2]}] ` +
                `${p.posture} conf=${p.confidence}`);
  }

  const active = update.active_states.filter((s) => s.active);
  if (active.length) {
    console.log('\nACTIVE STATES');
    for (const s of active) console.log(`  ${s.label} — ${s.evidence}`);
  }

  const field = update.signal_field.values;
  console.log(`\nfield: max=${Math.max(...field).toFixed(3)} ` +
              `mean=${(field.reduce((a, b) => a + b, 0) / field.length).toFixed(3)}`);
  console.log(`nodes online: ${update.nodes_online}/${update.node_count}`);
  for (const n of update.nodes) {
    console.log(`  n${n.node_id} presence=${n.presence}(${n.presence_reason}) ` +
                `breathR=${n.breath_ratio} motion=${n.motion_energy} ` +
                `br=${n.vitals.breathing_rate_bpm} hr=${n.vitals.heart_rate_bpm}`);
  }
}
