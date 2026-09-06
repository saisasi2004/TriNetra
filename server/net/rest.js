/**
 * REST API — /api/v1
 *
 * Read endpoints are open. Anything that mutates state (calibration, node
 * positions, scenario changes, arming the system) requires the bearer token
 * when TRINETRA_TOKEN is set, and is rejected outright from non-loopback
 * addresses when it is not — so an unconfigured install cannot be
 * reconfigured by anything else on the LAN.
 */

import express from 'express';

import { scenarioCatalog, SCENARIO_IDS } from '../sim/scenarios.js';
import { validatePlan, blankPlan } from '../../public/js/lib/plan.js';

export function createApi({
  config, engine, udp, ws, simulator, recorder, mqtt, plans, log,
}) {
  const api = express.Router();
  const logger = log('api');

  api.use(express.json({ limit: '256kb' }));

  // ── Guard for mutating routes ────────────────────────────────────────
  const requireAuth = (req, res, next) => {
    const token = config.auth.token;

    if (token) {
      const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') ||
        req.query.token;
      if (provided !== token) {
        return res.status(401).json({ error: 'unauthorized', hint: 'set Authorization: Bearer <TRINETRA_TOKEN>' });
      }
      return next();
    }

    // No token configured: only loopback may mutate.
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    if (ip === '::1' || ip.endsWith('127.0.0.1')) return next();

    return res.status(403).json({
      error: 'forbidden',
      detail: 'Mutating endpoints are loopback-only until TRINETRA_TOKEN is set.',
    });
  };

  // ── Info & health ────────────────────────────────────────────────────

  api.get('/info', (req, res) => {
    res.json({
      name: 'TriNetra',
      version: '1.0.0',
      description: 'WiFi CSI spatial sensing',
      mode: config.simulate ? 'simulator' : 'live',
      room: config.room,
      field_grid: config.fieldGrid,
      tick_hz: config.tickHz,
      endpoints: {
        websocket: `/ws/sensing`,
        rest: '/api/v1',
      },
      capabilities: [
        'presence', 'motion', 'breathing_rate', 'heart_rate', 'fall_detection',
        'posture', 'person_tracking', 'signal_field', 'semantic_states',
      ],
      limitations: {
        pose: 'Skeletons are a kinematic model driven by measured position, ' +
              'posture and breathing rate — not per-joint CSI inference. ' +
              'A single-antenna 56-subcarrier stream cannot resolve limbs.',
        person_count: 'ONE person. Four monostatic single-antenna nodes ' +
              'cannot separate two bodies: the observable is range only, and ' +
              'a two-body fit is underdetermined against it. Two occupants ' +
              'are reported as one, positioned between them. The count ' +
              'undercounts by design and never inflates.',
        localization: 'Range-based multilateration against a path-loss ' +
              'model. Simulated median error is about 0.2 m near a node and ' +
              '0.7 m at the centre of a 6x5 m room, where every return is ' +
              'weakest. Read position_uncertainty_m and signal_field.evidence ' +
              'rather than the point.',
        vitals: 'Require stillness. Suppressed rather than estimated while ' +
              'the subject is moving. The room-level figure is a ' +
              'confidence-weighted consensus across nodes; node_agreement ' +
              'reports how much the nodes actually agreed.',
      },
    });
  });

  api.get('/health', (req, res) => {
    const snapshot = engine.lastUpdate;
    const healthy = snapshot != null;
    const conflicts = udp?.nodeIdConflicts() ?? [];
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'starting',
      uptime_s: Math.round(process.uptime()),
      nodes_online: snapshot?.nodes_online ?? 0,
      source: snapshot?.source ?? 'offline',
      data_quality: snapshot?.data_quality ?? 'NO_DATA',
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      // Surfaced in health, not just logged: several boards sharing a node
      // id is silent by nature — the fleet simply appears smaller than it
      // is — so it has to be somewhere an operator will actually look.
      node_id_conflicts: conflicts,
      warnings: conflicts.length
        ? [`node id ${conflicts.map((c) => c.node_id).join(', ')} claimed by ` +
           'multiple boards; provision each with a unique --node-id']
        : [],
    });
  });

  api.get('/status', (req, res) => {
    res.json({
      source: engine.lastUpdate?.source ?? 'offline',
      tick: engine.tick,
      nodes: engine.nodes.size,
      nodes_online: [...engine.nodes.values()].filter((n) => n.online).length,
      simulator: simulator
        ? { running: true, ...simulator.truth() }
        : { running: false },
      udp: udp?.stats ?? null,
      websocket: { clients: ws?.clients.size ?? 0, ...(ws?.stats ?? {}) },
      mqtt: mqtt?.status() ?? { enabled: false },
      recording: recorder?.status() ?? { enabled: false },
    });
  });

  api.get('/metrics', (req, res) => {
    // Prometheus text format — drop-in for the monitoring stack.
    const s = engine.lastUpdate;
    const lines = [
      '# HELP trinetra_nodes_online Nodes currently reporting',
      '# TYPE trinetra_nodes_online gauge',
      `trinetra_nodes_online ${s?.nodes_online ?? 0}`,
      '# HELP trinetra_presence Presence detected',
      '# TYPE trinetra_presence gauge',
      `trinetra_presence ${s?.classification?.presence ? 1 : 0}`,
      '# HELP trinetra_persons Estimated person count',
      '# TYPE trinetra_persons gauge',
      `trinetra_persons ${s?.estimated_persons ?? 0}`,
      '# HELP trinetra_breathing_bpm Breathing rate',
      '# TYPE trinetra_breathing_bpm gauge',
      `trinetra_breathing_bpm ${s?.vital_signs?.breathing_rate_bpm ?? 0}`,
      '# HELP trinetra_heart_bpm Heart rate',
      '# TYPE trinetra_heart_bpm gauge',
      `trinetra_heart_bpm ${s?.vital_signs?.heart_rate_bpm ?? 0}`,
      '# HELP trinetra_signal_quality Mean signal quality 0-1',
      '# TYPE trinetra_signal_quality gauge',
      `trinetra_signal_quality ${s?.signal_quality_score ?? 0}`,
      '# HELP trinetra_udp_packets_total UDP packets decoded',
      '# TYPE trinetra_udp_packets_total counter',
      `trinetra_udp_packets_total ${udp?.stats.decoded ?? 0}`,
      '# HELP trinetra_ws_clients Connected WebSocket clients',
      '# TYPE trinetra_ws_clients gauge',
      `trinetra_ws_clients ${ws?.clients.size ?? 0}`,
    ];
    res.type('text/plain').send(lines.join('\n') + '\n');
  });

  // ── Sensing state ────────────────────────────────────────────────────

  api.get('/sensing/current', (req, res) => {
    res.json(engine.snapshot());
  });

  api.get('/sensing/vitals', (req, res) => {
    const s = engine.snapshot();
    res.json({
      timestamp: s.timestamp,
      data_quality: s.data_quality,
      ...s.vital_signs,
    });
  });

  api.get('/sensing/presence', (req, res) => {
    const s = engine.snapshot();
    res.json({
      presence: s.classification.presence,
      confidence: s.classification.confidence,
      motion_level: s.classification.motion_level,
      persons: s.estimated_persons,
      count_method: s.count_method,
      posture: s.posture,
      data_quality: s.data_quality,
    });
  });

  api.get('/sensing/field', (req, res) => {
    res.json(engine.snapshot().signal_field);
  });

  api.get('/sensing/persons', (req, res) => {
    const s = engine.snapshot();
    res.json({
      count: s.estimated_persons,
      count_method: s.count_method,
      pose_source: s.pose_source,
      persons: s.persons,
    });
  });

  api.get('/sensing/semantic', (req, res) => {
    const s = engine.snapshot();
    res.json({ states: s.semantic_states, active: s.active_states });
  });

  api.get('/events', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 50);
    res.json({ events: engine.recentEvents(limit) });
  });

  // ── Nodes ────────────────────────────────────────────────────────────

  api.get('/nodes', (req, res) => {
    res.json({
      nodes: [...engine.nodes.values()].map((n) => n.toJSON()),
      sources: udp?.sourceList() ?? [],
      node_id_conflicts: udp?.nodeIdConflicts() ?? [],
    });
  });

  api.get('/nodes/:id', (req, res) => {
    const node = engine.nodes.get(Number(req.params.id));
    if (!node) return res.status(404).json({ error: 'node not found' });
    res.json({
      ...node.toJSON(),
      features: node.features,
      edge_status: node.edgeStatus,
      edge_vitals: node.edgeVitals,
    });
  });

  api.post('/nodes/:id/position', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const { x, y = 1.2, z } = req.body ?? {};
    if (![x, y, z].every((v) => Number.isFinite(v))) {
      return res.status(400).json({ error: 'x, y, z must be finite numbers (metres)' });
    }
    const node = engine.setNodePosition(id, [x, y, z]);
    logger.info(`node ${id} repositioned to [${x}, ${y}, ${z}]`);
    res.json(node.toJSON());
  });

  api.post('/nodes/:id/room', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const { room } = req.body ?? {};
    if (typeof room !== 'string' || !room) {
      return res.status(400).json({ error: 'room must be a non-empty string' });
    }
    res.json(engine.setNodeRoom(id, room).toJSON());
  });

  // ── Calibration ──────────────────────────────────────────────────────

  api.post('/calibrate', requireAuth, (req, res) => {
    const nodeId = req.body?.node_id ?? null;
    engine.recalibrate(nodeId === null ? null : Number(nodeId));
    res.json({
      status: 'calibrating',
      seconds: config.calibrationSeconds,
      node_id: nodeId,
      note: 'Leave the space empty for the duration — the baseline learned ' +
            'here defines what "no one is here" means.',
    });
  });

  api.get('/calibrate/status', (req, res) => {
    const nodes = [...engine.nodes.values()];
    res.json({
      calibrating: nodes.some((n) => n.calibrating),
      nodes: nodes.map((n) => ({
        node_id: n.nodeId,
        calibrating: n.calibrating,
        frames_remaining: Math.max(0, n.calibrationFrames),
      })),
    });
  });

  // ── Zones ────────────────────────────────────────────────────────────

  api.get('/zones', (req, res) => {
    const persons = engine.snapshot().persons;
    res.json({
      zones: engine.zones.map((z) => ({
        ...z,
        occupancy: persons.filter((p) => p.zone === z.id).length,
      })),
    });
  });

  api.post('/zones', requireAuth, (req, res) => {
    const zones = req.body?.zones;
    if (!Array.isArray(zones)) {
      return res.status(400).json({ error: 'body must be { zones: [...] }' });
    }
    for (const z of zones) {
      if (!z.id || !Array.isArray(z.bounds) || z.bounds.length !== 4) {
        return res.status(400).json({
          error: 'each zone needs { id, bounds: [x0, z0, x1, z1] } in metres',
        });
      }
    }
    engine.setZones(zones);
    res.json({ zones: engine.zones });
  });

  // ── Simulator control ────────────────────────────────────────────────

  api.get('/simulator', (req, res) => {
    if (!simulator) return res.json({ running: false, scenarios: scenarioCatalog() });
    res.json({ running: true, ...simulator.truth(), scenarios: scenarioCatalog() });
  });

  api.post('/simulator/scenario', requireAuth, (req, res) => {
    if (!simulator) return res.status(409).json({ error: 'simulator not running' });

    const { scenario, auto_cycle } = req.body ?? {};
    if (typeof auto_cycle === 'boolean') simulator.setAutoCycle(auto_cycle);

    if (scenario === 'auto') {
      simulator.setAutoCycle(true);
    } else if (scenario) {
      if (!SCENARIO_IDS.includes(scenario)) {
        return res.status(400).json({ error: 'unknown scenario', available: SCENARIO_IDS });
      }
      simulator.setAutoCycle(false);
      simulator.setScenario(scenario);
    }
    res.json(simulator.truth());
  });

  // ── Floor plans ──────────────────────────────────────────────────────
  //
  // The active plan defines the sensing space: its footprint is the room, its
  // rooms are the zones, and its node placements are the node positions. That
  // is why saving one is a mutation guarded like any other, and why an
  // invalid plan is refused outright rather than repaired — a NaN coordinate
  // reaching the field grid produces a surface that never peaks again, with
  // nothing anywhere to explain it.

  api.get('/floorplans', (req, res) => {
    if (!plans) return res.status(503).json({ error: 'plan store unavailable' });
    res.json({ plans: plans.list(), active: plans.activeId });
  });

  api.get('/floorplan', (req, res) => {
    if (!plans) return res.status(503).json({ error: 'plan store unavailable' });
    const plan = plans.active();
    res.json({
      plan,
      builtin: plans.isBuiltin(plan.id),
      // Says whether editing this plan's size will actually move anything.
      // With --room-size passed, the plan still supplies zones and node
      // positions but no longer sets the footprint, and a UI that did not
      // know that would show a size control which silently does nothing.
      room_from_plan: !config.roomExplicit,
      room: config.room,
    });
  });

  api.get('/floorplans/new', (req, res) => {
    // A starting point for the editor, generated server-side so the blank
    // plan's shape can never drift from what the validator accepts.
    res.json({ plan: blankPlan(`plan-${Date.now().toString(36)}`, 'New plan') });
  });

  api.get('/floorplans/:id', (req, res) => {
    if (!plans) return res.status(503).json({ error: 'plan store unavailable' });
    const plan = plans.get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    res.json({ plan, builtin: plans.isBuiltin(plan.id) });
  });

  api.post('/floorplan/validate', (req, res) => {
    // Unauthenticated on purpose: it reads nothing and changes nothing, and
    // the editor calls it on every edit to show problems as you draw.
    res.json(validatePlan(req.body?.plan ?? req.body));
  });

  api.post('/floorplan', requireAuth, async (req, res) => {
    if (!plans) return res.status(503).json({ error: 'plan store unavailable' });

    const incoming = req.body?.plan ?? req.body;
    const activate = req.body?.activate !== false;

    try {
      const { plan, warnings } = await plans.save(incoming);

      if (activate) {
        await plans.setActive(plan.id);
        engine.applyPlan(plan, { adoptRoom: !config.roomExplicit });
      }

      logger.info(`plan "${plan.id}" saved${activate ? ' and activated' : ''}`);
      res.json({
        plan,
        active: plans.activeId,
        warnings,
        room: config.room,
      });
    } catch (err) {
      if (err.code === 'INVALID_PLAN') {
        return res.status(400).json({ error: 'invalid plan', errors: err.errors });
      }
      if (err.code === 'BUILTIN_READONLY') {
        return res.status(409).json({ error: err.message });
      }
      logger.error('plan save failed:', err.message);
      res.status(500).json({ error: 'could not save plan' });
    }
  });

  api.post('/floorplan/activate', requireAuth, async (req, res) => {
    if (!plans) return res.status(503).json({ error: 'plan store unavailable' });

    const id = req.body?.id;
    if (typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'body must be { id: "<plan id>" }' });
    }

    const plan = await plans.setActive(id);
    if (!plan) return res.status(404).json({ error: 'plan not found' });

    engine.applyPlan(plan, { adoptRoom: !config.roomExplicit });
    res.json({ active: plans.activeId, plan, room: config.room });
  });

  api.delete('/floorplans/:id', requireAuth, async (req, res) => {
    if (!plans) return res.status(503).json({ error: 'plan store unavailable' });
    try {
      const removed = await plans.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: 'plan not found' });

      // Deleting the active plan falls back to the built-in, so the engine
      // has to be told: otherwise the field keeps the deleted plan's
      // footprint and every position stays scaled to a room that is gone.
      engine.applyPlan(plans.active(), { adoptRoom: !config.roomExplicit });
      res.json({ deleted: req.params.id, active: plans.activeId });
    } catch (err) {
      if (err.code === 'BUILTIN_READONLY') {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: 'could not delete plan' });
    }
  });

  // ── Security arming (drives the intrusion semantic state) ────────────

  api.post('/security/arm', requireAuth, (req, res) => {
    const armed = req.body?.armed !== false;
    engine.semantic.setArmed(armed);
    res.json({ armed });
  });

  // ── Recording ────────────────────────────────────────────────────────

  api.post('/recording/start', requireAuth, async (req, res) => {
    if (!recorder) return res.status(409).json({ error: 'recorder unavailable' });
    const name = req.body?.name;
    const file = await recorder.start(name);
    res.json({ recording: true, file });
  });

  api.post('/recording/stop', requireAuth, async (req, res) => {
    if (!recorder) return res.status(409).json({ error: 'recorder unavailable' });
    const result = await recorder.stop();
    res.json(result);
  });

  api.get('/recording', (req, res) => {
    res.json(recorder?.status() ?? { enabled: false });
  });

  api.get('/recordings', async (req, res) => {
    res.json({ recordings: (await recorder?.list()) ?? [] });
  });

  // ── 404 inside the API namespace ─────────────────────────────────────
  api.use((req, res) => {
    res.status(404).json({ error: 'not found', path: req.originalUrl });
  });

  return api;
}
