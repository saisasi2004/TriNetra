/**
 * WebSocket hub — the live sensing stream.
 *
 * Clients connect to /ws/sensing and receive one `sensing_update` per tick.
 * Payloads are sizeable (a full signal field plus per-node amplitude
 * vectors), so the hub applies backpressure: a client whose socket is
 * already congested gets skipped rather than queued. Sensing data is only
 * useful fresh, and a growing send buffer is how a Node process quietly
 * runs out of memory.
 */

import { WebSocketServer } from 'ws';

const MAX_BUFFERED_BYTES = 1 << 20;   // 1 MB — skip a client above this

export class WsHub {
  constructor(config, engine, log) {
    this.config = config;
    this.engine = engine;
    this.log = log('ws');
    this.wss = null;
    this.clients = new Set();
    this.stats = { connections: 0, sent: 0, skipped: 0, bytes: 0 };
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname !== '/ws/sensing' && url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Optional bearer auth. Browsers cannot set headers on a WebSocket
      // handshake, so a query-string token is the practical option — which
      // is why it is off unless TRINETRA_TOKEN is set.
      const token = this.config.auth.token;
      if (token) {
        const provided = url.searchParams.get('token') ??
          (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (provided !== token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    this.log.info('websocket endpoint ready at /ws/sensing');
  }

  #onConnection(ws, req) {
    const ip = req.socket.remoteAddress;
    this.clients.add(ws);
    this.stats.connections++;
    this.log.info(`client connected from ${ip} (${this.clients.size} total)`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Send the current state immediately so a fresh page is not blank until
    // the next tick.
    const snapshot = this.engine.lastUpdate;
    if (snapshot) this.#sendTo(ws, snapshot);

    ws.on('message', (raw) => this.#onMessage(ws, raw));

    ws.on('close', () => {
      this.clients.delete(ws);
      this.log.info(`client disconnected (${this.clients.size} remaining)`);
    });

    ws.on('error', (err) => {
      this.log.warn('client error:', err.message);
      this.clients.delete(ws);
    });
  }

  #onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() / 1000 }));
        break;
      case 'subscribe':
        // Field data is by far the largest part of the payload. A client
        // that only wants vitals can opt out of it.
        ws.wantsField = msg.field !== false;
        ws.wantsAmplitude = msg.amplitude !== false;
        ws.send(JSON.stringify({ type: 'subscribed', field: ws.wantsField }));
        break;
      case 'recalibrate':
        this.engine.recalibrate(msg.node_id ?? null);
        break;
      default:
        break;
    }
  }

  #sendTo(ws, update) {
    if (ws.readyState !== ws.OPEN) return false;

    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.stats.skipped++;
      return false;
    }

    let payload = update;
    if (ws.wantsField === false || ws.wantsAmplitude === false) {
      payload = { ...update };
      if (ws.wantsField === false) delete payload.signal_field;
      if (ws.wantsAmplitude === false) {
        payload.nodes = payload.nodes.map((n) => ({ ...n, amplitude: [] }));
      }
    }

    const json = JSON.stringify(payload);
    ws.send(json);
    this.stats.sent++;
    this.stats.bytes += json.length;
    return true;
  }

  broadcast(update) {
    for (const ws of this.clients) this.#sendTo(ws, update);
  }

  /** Push a discrete event out-of-band, ahead of the next tick. */
  broadcastEvent(event) {
    const json = JSON.stringify({ type: 'event', ...event });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  startHeartbeat(intervalMs = 30000) {
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) { ws.terminate(); this.clients.delete(ws); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }, intervalMs);
  }

  stop() {
    clearInterval(this.heartbeat);
    for (const ws of this.clients) ws.close();
    this.wss?.close();
  }
}
