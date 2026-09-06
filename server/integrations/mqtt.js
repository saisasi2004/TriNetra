/**
 * MQTT publisher with Home Assistant auto-discovery.
 *
 * Publishes one discovery config per entity, then streams state. Home
 * Assistant picks the entities up with no YAML; Google Home, Alexa and
 * SmartThings then inherit them through HA's own bridges.
 *
 * Privacy is the reason for the entity split. Presence and occupancy are
 * safe to expose to a whole-house automation bus. Heart rate is health
 * data, and someone's bedroom breathing pattern is not something to publish
 * by default — vitals are therefore opt-in via `publishVitals`.
 */

const DEVICE_CLASSES = {
  presence: { device_class: 'occupancy', component: 'binary_sensor' },
  motion: { device_class: 'motion', component: 'binary_sensor' },
  fall: { device_class: 'safety', component: 'binary_sensor' },
  persons: { unit: 'persons', icon: 'mdi:account-group', component: 'sensor' },
  breathing: { unit: 'BPM', icon: 'mdi:lungs', component: 'sensor' },
  heart: { unit: 'BPM', icon: 'mdi:heart-pulse', component: 'sensor' },
  motion_energy: { unit: '%', icon: 'mdi:motion-sensor', component: 'sensor' },
  signal_quality: { unit: '%', icon: 'mdi:signal', component: 'sensor' },
  posture: { icon: 'mdi:human', component: 'sensor' },
  rssi: { unit: 'dBm', device_class: 'signal_strength', component: 'sensor' },
};

const SEMANTIC_ENTITIES = [
  ['someone_sleeping', 'Someone Sleeping', 'mdi:sleep'],
  ['room_active', 'Room Active', 'mdi:home-analytics'],
  ['no_movement', 'No Movement', 'mdi:motion-sensor-off'],
  ['possible_distress', 'Possible Distress', 'mdi:alert'],
  ['fall_risk_elevated', 'Fall Risk Elevated', 'mdi:human-cane'],
  ['bed_exit', 'Bed Exit', 'mdi:bed-empty'],
  ['bathroom_occupied', 'Bathroom Occupied', 'mdi:shower'],
  ['meeting_in_progress', 'Meeting In Progress', 'mdi:account-group'],
  ['elderly_inactivity_anomaly', 'Inactivity Anomaly', 'mdi:clock-alert'],
  ['multi_room_transition', 'Room Transition', 'mdi:transit-connection'],
  ['apnea_suspected', 'Apnea Suspected', 'mdi:lungs'],
  ['intrusion', 'Intrusion', 'mdi:shield-alert'],
];

export class MqttBridge {
  constructor(config, engine, log) {
    this.config = config.mqtt;
    this.engine = engine;
    this.log = log('mqtt');
    this.client = null;
    this.connected = false;
    this.discoverySent = false;
    this.publishVitals = this.config.publishVitals ?? false;
    this.lastPublish = 0;
    this.publishIntervalMs = 1000;      // 1 Hz is plenty for home automation
    this.stats = { published: 0, errors: 0 };
  }

  get baseTopic() { return this.config.baseTopic; }
  get availabilityTopic() { return `${this.baseTopic}/status`; }

  async connect() {
    let mqtt;
    try {
      ({ default: mqtt } = await import('mqtt'));
    } catch {
      this.log.warn('mqtt package not installed — run `npm install mqtt`. MQTT disabled.');
      return false;
    }

    this.log.info(`connecting to ${this.config.url}`);

    this.client = mqtt.connect(this.config.url, {
      username: this.config.username ?? undefined,
      password: this.config.password ?? undefined,
      will: {
        topic: this.availabilityTopic,
        payload: 'offline',
        retain: true,
        qos: 1,
      },
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.log.info('connected');
      this.client.publish(this.availabilityTopic, 'online', { retain: true, qos: 1 });
      this.#sendDiscovery();
      this.client.subscribe(`${this.baseTopic}/cmd/#`);
    });

    this.client.on('message', (topic, payload) => this.#onCommand(topic, payload));
    this.client.on('error', (err) => {
      this.stats.errors++;
      this.log.warn('error:', err.message);
    });
    this.client.on('close', () => { this.connected = false; });

    return true;
  }

  #onCommand(topic, payload) {
    const cmd = topic.split('/').pop();
    const value = payload.toString();
    switch (cmd) {
      case 'calibrate':
        this.engine.recalibrate(value && value !== 'all' ? Number(value) : null);
        break;
      case 'arm':
        this.engine.semantic.setArmed(value === 'ON' || value === 'true');
        break;
      default:
        break;
    }
  }

  #device() {
    return {
      identifiers: ['trinetra'],
      name: 'TriNetra',
      model: 'WiFi CSI Sensing',
      manufacturer: 'TriNetra',
      sw_version: '1.0.0',
    };
  }

  #publishDiscovery(component, objectId, config) {
    const topic = `${this.config.discoveryPrefix}/${component}/trinetra/${objectId}/config`;
    this.client.publish(topic, JSON.stringify({
      ...config,
      unique_id: `trinetra_${objectId}`,
      availability_topic: this.availabilityTopic,
      device: this.#device(),
    }), { retain: true, qos: 1 });
  }

  #sendDiscovery() {
    if (this.discoverySent) return;
    const state = `${this.baseTopic}/state`;

    const entity = (id, name, key, extra = {}) => {
      const meta = DEVICE_CLASSES[key] ?? {};
      const { component = 'sensor', unit, ...rest } = meta;
      this.#publishDiscovery(component, id, {
        name,
        state_topic: state,
        value_template: `{{ value_json.${extra.path ?? id} }}`,
        ...(unit ? { unit_of_measurement: unit } : {}),
        ...(component === 'binary_sensor'
          ? { payload_on: 'true', payload_off: 'false' } : {}),
        ...rest,
        ...(extra.config ?? {}),
      });
    };

    entity('presence', 'Presence', 'presence');
    entity('motion', 'Motion', 'motion');
    entity('fall', 'Fall Detected', 'fall');
    entity('persons', 'Person Count', 'persons');
    entity('motion_energy', 'Motion Energy', 'motion_energy');
    entity('signal_quality', 'Signal Quality', 'signal_quality');
    entity('posture', 'Posture', 'posture');
    entity('rssi', 'Signal Strength', 'rssi');

    if (this.publishVitals) {
      entity('breathing', 'Breathing Rate', 'breathing');
      entity('heart', 'Heart Rate', 'heart');
    } else {
      this.log.info(
        'vitals entities NOT published — heart rate and breathing are health ' +
        'data. Enable with mqtt.publishVitals when you actually want them on the bus.',
      );
    }

    for (const [id, name, icon] of SEMANTIC_ENTITIES) {
      this.#publishDiscovery('binary_sensor', id, {
        name,
        state_topic: `${this.baseTopic}/semantic`,
        value_template: `{{ value_json.${id} }}`,
        payload_on: 'true',
        payload_off: 'false',
        icon,
      });
    }

    this.#publishDiscovery('button', 'calibrate', {
      name: 'Recalibrate',
      command_topic: `${this.baseTopic}/cmd/calibrate`,
      payload_press: 'all',
      icon: 'mdi:tune',
    });

    this.discoverySent = true;
    this.log.info(`discovery published (${SEMANTIC_ENTITIES.length + 9} entities)`);
  }

  publish(update) {
    if (!this.connected || !this.client) return;

    const now = Date.now();
    if (now - this.lastPublish < this.publishIntervalMs) return;
    this.lastPublish = now;

    const v = update.vital_signs ?? {};
    const state = {
      presence: update.classification.presence,
      motion: update.classification.motion_level !== 'none' &&
              update.classification.motion_level !== 'still',
      fall: update.fall_detected,
      persons: update.estimated_persons,
      motion_energy: Math.round(
        (update.nodes.find((n) => n.online)?.motion_energy ?? 0) * 100,
      ),
      signal_quality: Math.round((update.signal_quality_score ?? 0) * 100),
      posture: update.posture,
      rssi: Math.round(update.features.mean_rssi),
      data_quality: update.data_quality,
      count_method: update.count_method,
    };

    if (this.publishVitals) {
      state.breathing = v.breathing_rate_bpm ?? 0;
      state.heart = v.heart_rate_bpm ?? 0;
    }

    this.client.publish(`${this.baseTopic}/state`, JSON.stringify(state), { retain: true });

    const semantic = {};
    for (const [key, det] of Object.entries(update.semantic_states ?? {})) {
      semantic[key] = det.active;
    }
    this.client.publish(`${this.baseTopic}/semantic`, JSON.stringify(semantic), { retain: true });

    this.stats.published += 2;
  }

  /** Events go out immediately — a fall alert must not wait for the next tick. */
  publishEvent(event) {
    if (!this.connected || !this.client) return;
    this.client.publish(
      `${this.baseTopic}/event/${event.type}`,
      JSON.stringify(event),
      { qos: 1 },
    );
    this.stats.published++;
  }

  status() {
    return {
      enabled: true,
      connected: this.connected,
      url: this.config.url,
      vitals_published: this.publishVitals,
      ...this.stats,
    };
  }

  async stop() {
    if (!this.client) return;
    this.client.publish(this.availabilityTopic, 'offline', { retain: true });
    await new Promise((r) => this.client.end(false, {}, r));
  }
}
