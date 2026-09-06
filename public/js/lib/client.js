/**
 * TriNetra client — WebSocket stream + REST helpers.
 *
 * Reconnects with exponential backoff, measures round-trip latency, and
 * exposes a tiny event API. Deliberately dependency-free: this file must
 * work from a static server with no build step.
 */

export class TriNetraClient extends EventTarget {
  constructor({ url = null, token = null } = {}) {
    super();
    this.token = token ?? new URLSearchParams(location.search).get('token');
    this.url = url ?? this.#defaultUrl();
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 20000;
    this.lastUpdate = null;
    this.latencyMs = null;
    this.pingTimer = null;
    this.pingSentAt = 0;
    this.shouldReconnect = true;
  }

  #defaultUrl() {
    // Match the page protocol: https pages need wss, and forcing one or the
    // other breaks either local dev or a reverse-proxied deployment.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${proto}//${location.host}/ws/sensing`;
    return this.token ? `${base}?token=${encodeURIComponent(this.token)}` : base;
  }

  connect() {
    this.shouldReconnect = true;
    this.#open();
  }

  #open() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.#scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.dispatchEvent(new CustomEvent('open'));
      this.#startPing();
    });

    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'pong') {
        this.latencyMs = Math.round(performance.now() - this.pingSentAt);
        return;
      }
      if (msg.type === 'event') {
        this.dispatchEvent(new CustomEvent('sensing-event', { detail: msg }));
        return;
      }
      if (msg.type === 'sensing_update') {
        this.lastUpdate = msg;
        this.dispatchEvent(new CustomEvent('update', { detail: msg }));
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.#stopPing();
      this.dispatchEvent(new CustomEvent('close'));
      this.#scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent('error'));
    });
  }

  #scheduleReconnect() {
    if (!this.shouldReconnect) return;
    setTimeout(() => this.#open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, this.maxReconnectDelay);
  }

  #startPing() {
    this.#stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.pingSentAt = performance.now();
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 5000);
  }

  #stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.shouldReconnect = false;
    this.#stopPing();
    this.ws?.close();
  }

  // ── REST ───────────────────────────────────────────────────────────

  async api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await fetch(`/api/v1${path}`, { ...options, headers });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).error ?? detail; } catch { /* not json */ }
      throw new Error(`${res.status}: ${detail}`);
    }
    return res.json();
  }

  get(path) { return this.api(path); }
  post(path, body) {
    return this.api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  }

  recalibrate(nodeId = null) { return this.post('/calibrate', { node_id: nodeId }); }
  setScenario(scenario) { return this.post('/simulator/scenario', { scenario }); }
  info() { return this.get('/info'); }
  simulator() { return this.get('/simulator'); }
}

/* ── Small shared formatters ─────────────────────────────────────────── */

export const fmt = {
  bpm: (v) => (v == null ? '--' : v.toFixed(1)),
  int: (v) => (v == null ? '--' : String(Math.round(v))),
  pct: (v) => (v == null ? '--' : String(Math.round(v * 100))),
  dbm: (v) => (v == null ? '--' : `${v.toFixed(0)} dBm`),
  hz: (v) => (v == null ? '--' : `${v.toFixed(2)} Hz`),
  num: (v, d = 2) => (v == null ? '--' : v.toFixed(d)),
  duration: (s) => {
    if (!s || s < 1) return '';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  },
  title: (s) => (s ?? '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
};

/** Linear interpolation helper used by every animated readout. */
export const lerp = (a, b, t) => a + (b - a) * t;
