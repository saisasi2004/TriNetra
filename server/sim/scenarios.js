/**
 * Simulator scenarios.
 *
 * A scenario describes PEOPLE — where they are, how they move, how they
 * breathe. It does not describe outputs. The simulator turns these bodies
 * into CSI using a scattering model, and the real DSP pipeline then derives
 * presence, vitals, field peaks and tracks from that CSI exactly as it would
 * from a physical room.
 *
 * That indirection matters: if a scenario could set `presence: true`
 * directly, the demo would be theatre. Here, if the pipeline is broken, the
 * simulated room looks broken too.
 */

export const SCENARIOS = {
  empty_room: {
    label: 'Empty Room',
    description: 'No occupants. Baseline drift and thermal noise only.',
    group: 'Core Sensing',
    people: [],
  },

  single_breathing: {
    label: 'Vital Signs',
    description: 'One person seated and still. Breathing and heart rate resolve.',
    group: 'Core Sensing',
    people: [
      {
        name: 'seated',
        motion: 'still',
        position: [0.6, -0.4],
        posture: 'sitting',
        breathingBpm: 14.5,
        heartBpm: 68,
      },
    ],
  },

  two_walking: {
    label: 'Multi-Person',
    description: 'Two people walking separate paths. Tracking and separation.',
    group: 'Core Sensing',
    people: [
      { name: 'walker-a', motion: 'patrol', path: [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]], speed: 0.8, posture: 'walking', breathingBpm: 18 },
      { name: 'walker-b', motion: 'patrol', path: [[1.5, 1.8], [-1.5, 0.5], [1.5, -1.8]], speed: 0.6, posture: 'walking', breathingBpm: 17 },
    ],
  },

  fall_event: {
    label: 'Fall Detect',
    description: 'A person walks, falls at t=12s, then lies still.',
    group: 'Core Sensing',
    people: [
      {
        name: 'faller',
        motion: 'scripted',
        posture: 'walking',
        breathingBpm: 16,
        heartBpm: 78,
        script: [
          { at: 0,  action: 'walk', to: [1.5, 0.5], speed: 0.7 },
          { at: 6,  action: 'walk', to: [-1.0, -1.0], speed: 0.7 },
          { at: 12, action: 'fall' },
          { at: 13, action: 'lie', breathingBpm: 24, heartBpm: 105 },
          { at: 30, action: 'lie', breathingBpm: 20, heartBpm: 92 },
        ],
      },
    ],
  },

  sleep_monitoring: {
    label: 'Sleep Monitor',
    description: 'Sleeping subject with a simulated apnea event at t=25s.',
    group: 'Medical',
    people: [
      {
        name: 'sleeper',
        motion: 'scripted',
        position: [-1.2, 1.0],
        posture: 'lying',
        breathingBpm: 11,
        heartBpm: 54,
        script: [
          { at: 0,  action: 'lie', breathingBpm: 11.5, heartBpm: 55 },
          { at: 25, action: 'apnea', durationS: 14 },
          { at: 39, action: 'lie', breathingBpm: 19, heartBpm: 72 },
          { at: 50, action: 'lie', breathingBpm: 12, heartBpm: 57 },
        ],
      },
    ],
  },

  elderly_care: {
    label: 'Elderly Care',
    description: 'Slow, unsteady gait — the fall-risk signature.',
    group: 'Medical',
    people: [
      {
        name: 'resident',
        motion: 'patrol',
        path: [[-1.5, 1.2], [0.8, 0.9], [1.6, -0.8], [-0.6, -1.4]],
        speed: 0.22,
        jitter: 0.35,        // unsteady: high motion variance at low speed
        posture: 'walking',
        breathingBpm: 19,
        heartBpm: 82,
      },
    ],
  },

  fitness_tracking: {
    label: 'Fitness',
    description: 'Exercise: elevated breathing and heart rate, high motion.',
    group: 'Medical',
    people: [
      {
        name: 'athlete',
        motion: 'oscillate',
        position: [0, 0],
        amplitude: 0.5,
        frequency: 0.7,
        posture: 'standing',
        breathingBpm: 32,
        heartBpm: 148,
        motionScale: 2.4,
      },
    ],
  },

  intrusion_detect: {
    label: 'Intrusion',
    description: 'Empty room, then someone enters through the perimeter at t=8s.',
    group: 'Security',
    people: [
      {
        name: 'intruder',
        motion: 'scripted',
        position: [-2.8, -2.2],
        posture: 'walking',
        breathingBpm: 21,
        heartBpm: 96,
        script: [
          { at: 0,  action: 'hide' },
          { at: 8,  action: 'walk', to: [-1.0, -1.0], speed: 0.9 },
          { at: 14, action: 'walk', to: [1.2, 0.8], speed: 0.5 },
          { at: 22, action: 'stand' },
        ],
      },
    ],
  },

  security_patrol: {
    label: 'Security Patrol',
    description: 'Regular perimeter walk — the benign pattern to distinguish.',
    group: 'Security',
    people: [
      {
        name: 'guard',
        motion: 'patrol',
        path: [[-2.4, -1.9], [2.4, -1.9], [2.4, 1.9], [-2.4, 1.9]],
        speed: 1.1,
        posture: 'walking',
        breathingBpm: 18,
        heartBpm: 84,
      },
    ],
  },

  crowd_occupancy: {
    label: 'Crowd (4 people)',
    description: 'Four occupants. Counting and density under superposition.',
    group: 'Building',
    people: [
      { name: 'p1', motion: 'wander', position: [-1.8, -1.2], speed: 0.35, posture: 'walking', breathingBpm: 17 },
      { name: 'p2', motion: 'wander', position: [1.6, -0.9], speed: 0.28, posture: 'walking', breathingBpm: 16 },
      { name: 'p3', motion: 'still', position: [-0.9, 1.4], posture: 'sitting', breathingBpm: 14, heartBpm: 70 },
      { name: 'p4', motion: 'still', position: [1.9, 1.5], posture: 'sitting', breathingBpm: 15, heartBpm: 74 },
    ],
  },

  meeting_room: {
    label: 'Meeting Room',
    description: 'Three seated people — the meeting-in-progress semantic state.',
    group: 'Building',
    people: [
      { name: 'a', motion: 'still', position: [-1.0, -0.6], posture: 'sitting', breathingBpm: 14, heartBpm: 68 },
      { name: 'b', motion: 'still', position: [0.2, -0.9], posture: 'sitting', breathingBpm: 15, heartBpm: 72 },
      { name: 'c', motion: 'still', position: [1.1, -0.4], posture: 'sitting', breathingBpm: 13, heartBpm: 66 },
    ],
  },

  gesture_control: {
    label: 'Gesture Control',
    description: 'Seated subject making repeated arm gestures.',
    group: 'Building',
    people: [
      {
        name: 'gesturer',
        motion: 'oscillate',
        position: [0.3, 0.2],
        amplitude: 0.12,
        frequency: 1.4,
        posture: 'sitting',
        breathingBpm: 15,
        heartBpm: 72,
        motionScale: 0.8,
      },
    ],
  },

  search_rescue: {
    label: 'Search & Rescue',
    description: 'A motionless casualty behind an obstruction — weak, barely-there signal.',
    group: 'Tactical',
    people: [
      {
        name: 'casualty',
        motion: 'still',
        position: [2.1, 1.7],
        posture: 'lying',
        breathingBpm: 8.5,
        heartBpm: 46,
        attenuation: 0.35,      // through a wall: heavy signal loss
      },
    ],
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS);

/**
 * Look up a scenario, complaining loudly about an unknown one.
 *
 * The silent `?? SCENARIOS.single_breathing` fallback this replaces was
 * quietly dishonest: a typo'd or renamed id ran a DIFFERENT scenario while
 * `simulator.scenarioId` — and therefore the UI, the API and the recording
 * header — kept reporting the name that was asked for. Two scenarios then
 * produce byte-identical output and there is nothing on screen to say why.
 * Still falling back keeps the simulator running, but never silently.
 */
export function getScenario(id) {
  const scenario = SCENARIOS[id];
  if (scenario) return scenario;

  console.warn(
    `[sim] unknown scenario "${id}" — falling back to single_breathing. ` +
    `Available: ${SCENARIO_IDS.join(', ')}`,
  );
  return SCENARIOS.single_breathing;
}

/** Grouped list for the UI's scenario picker. */
export function scenarioCatalog() {
  const groups = new Map();
  for (const [id, s] of Object.entries(SCENARIOS)) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push({ id, label: s.label, description: s.description });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}
