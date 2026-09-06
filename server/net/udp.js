/**
 * UDP ingest for ESP32 sensing frames.
 *
 * Security note, stated plainly: this data plane is NOT authenticated. UDP
 * has no handshake, and adding a shared secret to every frame would cost
 * more CPU on the MCU than the DSP does. Anything that can reach this port
 * can inject sensing frames.
 *
 * The mitigations are therefore network-level and on by default:
 *   - bind to loopback unless an operator explicitly says otherwise
 *   - optional source IP/CIDR allowlist
 *   - hard rate limit per source, so a flood cannot exhaust the event loop
 */

import dgram from 'node:dgram';

import { decodePacket } from './protocol.js';

const MAX_PACKETS_PER_SOURCE_PER_SEC = 400;

/** Parse "192.168.1.0/24" or a bare IP into a matcher. */
function parseCidr(entry) {
  const [addr, bitsRaw] = entry.trim().split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const octets = addr.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return null;
  }
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function ipToInt(ip) {
  const octets = ip.replace(/^::ffff:/, '').split('.').map(Number);
  if (octets.length !== 4) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export class UdpIngest {
  constructor(config, engine, log) {
    this.config = config;
    this.engine = engine;
    this.log = log('udp');
    this.socket = null;

    this.allow = (config.udpAllow ?? [])
      .map(parseCidr)
      .filter(Boolean);

    this.rate = new Map();          // srcIp -> { count, windowStart }
    this.stats = {
      received: 0, decoded: 0, rejected: 0, blocked: 0, rateLimited: 0, bytes: 0,
    };
    this.sources = new Map();       // srcIp -> { lastSeen, packets, nodeIds:Set }

    /**
     * nodeId -> Set of source IPs claiming it.
     *
     * Every board ships with the same CONFIG_TN_DEFAULT_NODE_ID of 1, and
     * the id only becomes unique once provision.py has written it to NVS. So
     * the single most likely way to bring up a multi-node install — flash
     * four boards, forget or fumble provisioning on three of them — makes
     * all four announce themselves as node 1. The server keys every piece of
     * per-node state on that id, so the four collapse into ONE NodeState:
     * the dashboard shows a single node, and the other three are invisible
     * rather than reported as broken.
     *
     * It is worse than losing them. Four radios' CSI is interleaved into one
     * phase history and one arrival-interval estimate, so the measured
     * sample rate reads about 4x high and every frequency derived from it —
     * breathing, heart rate — is wrong by the same factor, while looking
     * perfectly plausible.
     *
     * The collision is detectable: distinct source addresses sending the
     * same node id. Nothing was checking, so it is checked here.
     */
    this.nodeIdSources = new Map();
    this.duplicateNodeIds = new Set();
  }

  #allowed(ip) {
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    if (this.allow.length === 0) return true;
    const n = ipToInt(ip);
    if (n === null) return false;
    return this.allow.some(({ base, mask }) => ((n & mask) >>> 0) === base);
  }

  #rateOk(ip, nowMs) {
    let r = this.rate.get(ip);
    if (!r || nowMs - r.windowStart >= 1000) {
      r = { count: 0, windowStart: nowMs };
      this.rate.set(ip, r);
    }
    r.count++;
    return r.count <= MAX_PACKETS_PER_SOURCE_PER_SEC;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        this.log.error('socket error:', err.message);
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => this.#onMessage(msg, rinfo));

      this.socket.on('listening', () => {
        const a = this.socket.address();
        this.log.info(`listening on ${a.address}:${a.port}`);
        if (a.address !== '127.0.0.1') {
          this.log.warn(
            'UDP is bound to a routable address. The CSI data plane is ' +
            'unauthenticated — restrict it with --udp-allow <cidr>.',
          );
        }
        resolve();
      });

      this.socket.bind(this.config.udpPort, this.config.udpBind);
    });
  }

  /** Feed a packet in directly — used by the simulator, no socket involved. */
  injectBuffer(buf, nowMs = Date.now()) {
    const packet = decodePacket(buf);
    if (packet) {
      this.stats.decoded++;
      this.engine.ingest(packet, nowMs);
    } else {
      this.stats.rejected++;
    }
  }

  #onMessage(msg, rinfo) {
    const nowMs = Date.now();
    this.stats.received++;
    this.stats.bytes += msg.length;

    if (!this.#allowed(rinfo.address)) {
      this.stats.blocked++;
      return;
    }
    if (!this.#rateOk(rinfo.address, nowMs)) {
      this.stats.rateLimited++;
      return;
    }

    const packet = decodePacket(msg);
    if (!packet) { this.stats.rejected++; return; }

    this.stats.decoded++;

    let src = this.sources.get(rinfo.address);
    if (!src) {
      src = { packets: 0, nodeIds: new Set(), firstSeen: nowMs, lastSeen: nowMs };
      this.sources.set(rinfo.address, src);
      this.log.info(`new source ${rinfo.address} (node ${packet.nodeId})`);
    }
    src.packets++;
    src.lastSeen = nowMs;
    src.nodeIds.add(packet.nodeId);

    this.#checkNodeIdCollision(packet.nodeId, rinfo.address);

    this.engine.ingest(packet, nowMs);
  }

  /** Warn — once per id — when several boards claim the same node id. */
  #checkNodeIdCollision(nodeId, ip) {
    let ips = this.nodeIdSources.get(nodeId);
    if (!ips) { ips = new Set(); this.nodeIdSources.set(nodeId, ips); }
    if (ips.has(ip)) return;
    ips.add(ip);

    if (ips.size > 1 && !this.duplicateNodeIds.has(nodeId)) {
      this.duplicateNodeIds.add(nodeId);
      this.log.error(
        `node id ${nodeId} is being sent by ${ips.size} different addresses ` +
        `(${[...ips].join(', ')}). They are all being merged into one node, ` +
        'which corrupts its sample rate and therefore its vitals. Give each ' +
        'board a unique id: python provision.py --port <COM> --node-id <n>',
      );
    }
  }

  sourceList() {
    return [...this.sources.entries()].map(([ip, s]) => ({
      ip,
      packets: s.packets,
      node_ids: [...s.nodeIds],
      first_seen: s.firstSeen,
      last_seen: s.lastSeen,
    }));
  }

  /** Node ids claimed by more than one board, for the API and the UI. */
  nodeIdConflicts() {
    return [...this.duplicateNodeIds].map((nodeId) => ({
      node_id: nodeId,
      sources: [...(this.nodeIdSources.get(nodeId) ?? [])],
    }));
  }

  stop() {
    this.socket?.close();
    this.socket = null;
  }
}
