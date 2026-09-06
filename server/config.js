/**
 * Runtime configuration: defaults <- environment <- CLI flags.
 */

import { parseArgs } from 'node:util';

const DEFAULTS = {
  httpPort: 8080,
  wsPort: 8765,
  udpPort: 5005,

  // Loopback by default. The UDP data plane is unauthenticated — anything
  // on the LAN that can reach this port can inject sensing frames. Binding
  // to a routable address is an explicit operator decision.
  udpBind: '127.0.0.1',
  udpAllow: [],          // extra IP/CIDR allowed to send frames

  tickHz: 10,            // WebSocket broadcast rate
  simulate: false,
  scenario: 'auto',

  /**
   * How many nodes the simulator pretends to have.
   *
   * Three, because three is the smallest array that can multilaterate: two
   * range circles meet at two points and leave a mirror ambiguity, so three
   * is the first count that gives a unique fix. Simulating four when the
   * operator owns three flatters the geometry and hides the accuracy they
   * will actually see.
   */
  simNodes: 3,

  // Room geometry in metres. Drives the signal-field grid and person
  // positions; set it to match your actual space.
  room: { width: 6.0, depth: 5.0, height: 2.7 },
  fieldGrid: [24, 1, 20],   // x, y, z cells — y=1, the field is a floor plane

  nodeTimeoutMs: 5000,      // no frames for this long => node offline
  historyFrames: 256,       // per-node ring depth for temporal analysis

  calibrationSeconds: 30,

  mqtt: {
    enabled: false,
    url: 'mqtt://localhost:1883',
    username: null,
    password: null,
    discoveryPrefix: 'homeassistant',
    baseTopic: 'trinetra',
  },

  record: {
    enabled: false,
    dir: 'data/recordings',
  },

  plans: {
    dir: 'data/plans',
    // Which plan defines the sensing space. Overridden by whatever was last
    // activated through the API; this is only the first-run default.
    active: 'default-flat',
  },

  /**
   * True when --room-size was passed explicitly.
   *
   * The active floor plan normally defines the room footprint, which is the
   * whole point of drawing one. But an explicit flag has to beat a stored
   * file, or an operator who passes --room-size sees it silently ignored and
   * has no way to tell why.
   */
  roomExplicit: false,

  auth: {
    // When set, REST mutations and the WebSocket require this bearer token.
    token: process.env.TRINETRA_TOKEN || null,
  },

  logLevel: process.env.TRINETRA_LOG || 'info',
};

function parseCli() {
  const { values } = parseArgs({
    options: {
      'http-port':   { type: 'string' },
      'ws-port':     { type: 'string' },
      'udp-port':    { type: 'string' },
      'udp-bind':    { type: 'string' },
      'udp-allow':   { type: 'string', multiple: true },
      'tick-hz':     { type: 'string' },
      simulate:      { type: 'boolean' },
      scenario:      { type: 'string' },
      'sim-nodes':   { type: 'string' },   // how many nodes to simulate
      'room-size':   { type: 'string' },   // "W,D,H" in metres
      plan:          { type: 'string' },   // active floor plan id
      mqtt:          { type: 'string' },   // broker URL enables MQTT
      record:        { type: 'boolean' },
      'log-level':   { type: 'string' },
      help:          { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });
  return values;
}

const HELP = `
TriNetra sensing server

  node server/index.js [options]

  --simulate              Run the built-in CSI simulator (no hardware needed)
  --scenario <name>       Simulator scenario, or "auto" to cycle
  --sim-nodes <n>         Nodes to simulate, 1-6      (default 3)
                          Set this to how many you actually own — three is
                          the minimum that can multilaterate.
  --http-port <n>         HTTP + UI port          (default 8080)
  --ws-port <n>           WebSocket port          (default 8765)
  --udp-port <n>          ESP32 CSI ingest port   (default 5005)
  --udp-bind <addr>       UDP bind address        (default 127.0.0.1)
                          Use 0.0.0.0 to accept frames from real nodes.
  --udp-allow <ip/cidr>   Restrict which sources may send frames (repeatable)
  --tick-hz <n>           Broadcast rate          (default 10)
  --room-size <W,D,H>     Room dimensions in metres
                          Overrides the active floor plan's own footprint.
  --plan <id>             Floor plan defining the space (default default-flat)
                          Draw your own at /planner.html; the plan supplies
                          the room size, the zones and the node positions.
  --mqtt <url>            Publish to MQTT / Home Assistant discovery
  --record                Record every tick to JSONL under data/recordings
  --log-level <level>     error | warn | info | debug
  -h, --help              This message

Environment:
  TRINETRA_TOKEN          Bearer token required for mutations and WS access
`;

export function loadConfig() {
  const cli = parseCli();

  if (cli.help) {
    console.log(HELP);
    process.exit(0);
  }

  const cfg = structuredClone(DEFAULTS);

  if (cli['http-port']) cfg.httpPort = Number(cli['http-port']);
  if (cli['ws-port'])   cfg.wsPort   = Number(cli['ws-port']);
  if (cli['udp-port'])  cfg.udpPort  = Number(cli['udp-port']);
  if (cli['udp-bind'])  cfg.udpBind  = cli['udp-bind'];
  if (cli['udp-allow']) cfg.udpAllow = cli['udp-allow'];
  if (cli['tick-hz'])   cfg.tickHz   = Number(cli['tick-hz']);
  if (cli.simulate)     cfg.simulate = true;
  if (cli.scenario)     cfg.scenario = cli.scenario;

  if (cli['sim-nodes']) {
    const n = Number(cli['sim-nodes']);
    if (Number.isInteger(n) && n >= 1 && n <= 6) cfg.simNodes = n;
    else console.warn(`[config] --sim-nodes must be 1..6, keeping ${cfg.simNodes}`);
  }
  if (cli['log-level']) cfg.logLevel = cli['log-level'];
  if (cli.record)       cfg.record.enabled = true;

  if (cli.mqtt) {
    cfg.mqtt.enabled = true;
    cfg.mqtt.url = cli.mqtt;
  }

  if (cli['room-size']) {
    const [w, d, h] = String(cli['room-size']).split(',').map(Number);
    if ([w, d, h].every((v) => Number.isFinite(v) && v > 0)) {
      cfg.room = { width: w, depth: d, height: h };
      cfg.roomExplicit = true;
    }
  }

  if (cli.plan) cfg.plans.active = String(cli.plan);

  // Refuse to silently expose an unauthenticated ingest port to the LAN.
  if (cfg.udpBind !== '127.0.0.1' && cfg.udpAllow.length === 0) {
    console.warn(
      '[config] UDP bound to %s with no --udp-allow list. The CSI data plane ' +
      'is unauthenticated: anything that can reach this port can inject ' +
      'sensing frames. Add --udp-allow <cidr> to restrict it.',
      cfg.udpBind,
    );
  }

  return cfg;
}

/** Minimal levelled logger — no dependency, consistent prefixes. */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function makeLogger(level = 'info') {
  const threshold = LEVELS[level] ?? 2;
  const stamp = () => new Date().toISOString().slice(11, 23);
  const emit = (lvl, tag, args) => {
    if (LEVELS[lvl] > threshold) return;
    const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    fn(`${stamp()} ${lvl.toUpperCase().padEnd(5)} [${tag}]`, ...args);
  };
  return (tag) => ({
    error: (...a) => emit('error', tag, a),
    warn:  (...a) => emit('warn',  tag, a),
    info:  (...a) => emit('info',  tag, a),
    debug: (...a) => emit('debug', tag, a),
  });
}
