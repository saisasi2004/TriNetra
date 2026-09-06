/**
 * TriNetra sensing server — entry point.
 *
 *   ESP32 (UDP :5005) ─┐
 *                      ├─► SensingEngine ─► WebSocket :8765 ─► browser
 *   Simulator ─────────┘         │           REST /api/v1
 *                                ├────────► MQTT / Home Assistant
 *                                └────────► JSONL recorder
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { loadConfig, makeLogger } from './config.js';
import { SensingEngine } from './pipeline/engine.js';
import { UdpIngest } from './net/udp.js';
import { WsHub } from './net/ws.js';
import { createApi } from './net/rest.js';
import { CsiSimulator } from './sim/generator.js';
import { MqttBridge } from './integrations/mqtt.js';
import { Recorder } from './store/recorder.js';
import { PlanStore } from './store/plans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function main() {
  const config = loadConfig();
  const log = makeLogger(config.logLevel);
  const logger = log('server');

  // ── Core ─────────────────────────────────────────────────────────────
  const engine = new SensingEngine(config, log);

  const recorder = new Recorder(config, log);
  await recorder.init();

  // ── Floor plan ───────────────────────────────────────────────────────
  //
  // Loaded before anything reads the geometry. The active plan supplies the
  // room footprint, the zones and the node positions, so applying it after
  // the simulator had already been built would leave the simulated room and
  // the sensing field describing two different spaces.
  const plans = new PlanStore(config, log);
  await plans.init();
  engine.applyPlan(plans.active(), { adoptRoom: !config.roomExplicit });

  if (config.roomExplicit) {
    logger.info(
      `--room-size given, so the plan's own footprint is ignored ` +
      `(zones and node positions still come from it)`,
    );
  }

  // Printed once the room is settled, so it shows the size actually in use
  // rather than the default the plan is about to replace.
  banner(config, plans.activeId);

  const udp = new UdpIngest(config, engine, log);

  // ── Simulator ────────────────────────────────────────────────────────
  let simulator = null;
  if (config.simulate) {
    // Simulate however many nodes the operator actually owns, laid out by
    // the same rule the live path uses — so the simulator models THEIR
    // install rather than an idealised four-corner one they do not have.
    const simNodes = Array.from({ length: config.simNodes }, (_, i) => {
      const nodeId = i + 1;
      const node = engine.getNode(nodeId, { room: 'simulated-room' });
      return { nodeId, position: node.position };
    });

    simulator = new CsiSimulator({
      room: config.room,
      nodes: simNodes,
      scenario: config.scenario,
      rateHz: 20,
      // Keep the simulated room empty until the nodes finish calibrating,
      // plus a second of margin. Same rule as a real deployment: leave the
      // space during calibration or the baseline learns you as furniture.
      warmupSeconds: config.calibrationSeconds + 1,
    });

    // The simulator runs at the CSI rate (20 Hz), independently of the
    // broadcast rate. Frames go in through the same decoder the radio uses,
    // so nothing downstream can tell the difference — which is the point.
    setInterval(() => {
      for (const buf of simulator.step()) udp.injectBuffer(buf);
    }, 1000 / 20).unref();

    logger.info(`simulator running — scenario "${simulator.scenarioId}"`);
    logger.warn('All output is SIMULATED and labelled as such in every payload.');
  }

  // ── MQTT ─────────────────────────────────────────────────────────────
  // Connected before the API router is built so /api/v1/status can report
  // its real state instead of a placeholder.
  let mqtt = null;
  if (config.mqtt.enabled) {
    mqtt = new MqttBridge(config, engine, log);
    const ok = await mqtt.connect();
    if (!ok) mqtt = null;
  }

  // ── HTTP + static UI ─────────────────────────────────────────────────
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const ws = new WsHub(config, engine, log);

  app.use('/api/v1', createApi({
    config, engine, udp, ws, simulator, recorder, mqtt, plans, log,
  }));

  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // Everything else falls through to the observatory.
  app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  const server = http.createServer(app);
  ws.attach(server);
  ws.startHeartbeat();

  // ── The tick ─────────────────────────────────────────────────────────
  const tickMs = 1000 / config.tickHz;
  const ticker = setInterval(() => {
    try {
      const update = engine.update();
      ws.broadcast(update);
      mqtt?.publish(update);
      recorder.write(update);
    } catch (err) {
      logger.error('tick failed:', err.stack ?? err.message);
    }
  }, tickMs);

  engine.on('event', (event) => {
    // Events bypass the tick — a fall alert waiting 100 ms for the next
    // broadcast is 100 ms of someone lying on the floor.
    ws.broadcastEvent(event);
    mqtt?.publishEvent(event);
    if (event.severity >= 2) {
      logger.warn(`ALERT ${event.type} from node ${event.nodeId} (conf ${event.confidence?.toFixed?.(2)})`);
    }
  });

  // ── Listen ───────────────────────────────────────────────────────────
  await udp.start();

  await new Promise((resolve) => server.listen(config.httpPort, resolve));

  logger.info(`HTTP + UI   http://localhost:${config.httpPort}`);
  logger.info(`WebSocket   ws://localhost:${config.httpPort}/ws/sensing`);
  logger.info(`REST        http://localhost:${config.httpPort}/api/v1/info`);
  logger.info(`Floor plan  http://localhost:${config.httpPort}/planner.html`);
  logger.info(`UDP ingest  ${config.udpBind}:${config.udpPort}`);
  if (!config.simulate) {
    logger.info('Waiting for ESP32 nodes. No hardware? Restart with --simulate');
  }

  // ── Shutdown ─────────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(ticker);
    ws.stop();
    udp.stop();
    await recorder.stop();
    await mqtt?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection:', err?.stack ?? err);
  });
}

function banner(config, planId) {
  const mode = config.simulate ? 'SIMULATOR' : 'LIVE';
  console.log(`
  ████████╗██████╗ ██╗███╗   ██╗███████╗████████╗██████╗  █████╗
  ╚══██╔══╝██╔══██╗██║████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗
     ██║   ██████╔╝██║██╔██╗ ██║█████╗     ██║   ██████╔╝███████║
     ██║   ██╔══██╗██║██║╚██╗██║██╔══╝     ██║   ██╔══██╗██╔══██║
     ██║   ██║  ██║██║██║ ╚████║███████╗   ██║   ██║  ██║██║  ██║
     ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝

  WiFi CSI spatial sensing · ${mode} · plan "${planId}"
  room ${config.room.width}×${config.room.depth}×${config.room.height} m
`);
}

main().catch((err) => {
  console.error('fatal:', err.stack ?? err);
  process.exit(1);
});
