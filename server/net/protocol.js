/**
 * TriNetra wire protocol decoder.
 *
 * Mirrors firmware/trinetra-csi-node/main/trinetra_protocol.h byte for byte.
 * If you change one, change the other in the same commit.
 */

export const MAGIC = {
  CSI:    0x544e0001,
  VITALS: 0x544e0002,
  STATUS: 0x544e0003,
  EVENT:  0x544e0004,
};

export const PROTOCOL_VERSION = 1;

export const CSI_HEADER_LEN = 28;
export const VITALS_LEN = 40;
/** Status without the trailing position triple — accepted from older nodes. */
export const STATUS_LEN_BASE = 32;
/** Current status length: 32 base + 3 float32 of node position. */
export const STATUS_LEN = 44;
export const EVENT_LEN = 24;

export const PPDU = { 0: 'ht_legacy', 1: 'he_su', 2: 'vht' };

export const FLAG = {
  PRESENCE:    1 << 0,
  FALL:        1 << 1,
  MOTION:      1 << 2,
  CALIBRATING: 1 << 3,
  LOW_QUALITY: 1 << 4,
  MOCK_SOURCE: 1 << 5,
};

export const POSTURE = {
  0: 'unknown', 1: 'absent', 2: 'lying', 3: 'sitting', 4: 'standing', 5: 'walking',
};

export const EVENT_TYPE = {
  1: 'fall', 2: 'presence_on', 3: 'presence_off', 4: 'motion_burst',
  5: 'apnea', 6: 'gesture', 7: 'calibration_done',
};

function decodeFlags(flags) {
  return {
    presence:    (flags & FLAG.PRESENCE) !== 0,
    fall:        (flags & FLAG.FALL) !== 0,
    motion:      (flags & FLAG.MOTION) !== 0,
    calibrating: (flags & FLAG.CALIBRATING) !== 0,
    lowQuality:  (flags & FLAG.LOW_QUALITY) !== 0,
    mock:        (flags & FLAG.MOCK_SOURCE) !== 0,
  };
}

/**
 * Decode a CSI frame.
 *
 * The payload is interleaved signed 8-bit [imag, real] pairs, exactly as
 * the ESP32 radio produces them. We derive amplitude and phase here rather
 * than on the MCU so the node spends its cycles on sensing, not on maths
 * the server can do for free.
 */
function decodeCsi(buf) {
  if (buf.length < CSI_HEADER_LEN) return null;

  const nSubcarriers = buf.readUInt16LE(8);
  const expected = CSI_HEADER_LEN + nSubcarriers * 2;
  if (nSubcarriers === 0 || nSubcarriers > 256 || buf.length < expected) return null;

  const amplitude = new Float64Array(nSubcarriers);
  const phase = new Float64Array(nSubcarriers);

  for (let i = 0; i < nSubcarriers; i++) {
    const im = buf.readInt8(CSI_HEADER_LEN + 2 * i);
    const re = buf.readInt8(CSI_HEADER_LEN + 2 * i + 1);
    amplitude[i] = Math.hypot(re, im);
    phase[i] = Math.atan2(im, re);
  }

  return {
    kind: 'csi',
    version: buf.readUInt8(4),
    nodeId: buf.readUInt8(5),
    nAntennas: buf.readUInt8(6),
    ppduType: PPDU[buf.readUInt8(7)] ?? 'ht_legacy',
    nSubcarriers,
    freqMhz: buf.readUInt16LE(10),
    sequence: buf.readUInt32LE(12),
    rssi: buf.readInt8(16),
    noiseFloor: buf.readInt8(17),
    rateHz: buf.readUInt16LE(18) / 10,
    timestampMs: buf.readUInt32LE(20),
    flags: decodeFlags(buf.readUInt8(24)),
    channel: buf.readUInt8(25),
    amplitude,
    phase,
  };
}

function decodeVitals(buf) {
  if (buf.length < VITALS_LEN) return null;
  return {
    kind: 'vitals',
    version: buf.readUInt8(4),
    nodeId: buf.readUInt8(5),
    flags: decodeFlags(buf.readUInt8(6)),
    nPersons: buf.readUInt8(7),
    breathingBpm: buf.readUInt16LE(8) / 100,
    heartBpm: buf.readUInt16LE(10) / 100,
    motionEnergy: buf.readFloatLE(12),
    presenceScore: buf.readFloatLE(16),
    breathingConf: buf.readFloatLE(20),
    heartConf: buf.readFloatLE(24),
    signalQuality: buf.readFloatLE(28),
    rssi: buf.readInt8(32),
    posture: POSTURE[buf.readUInt8(33)] ?? 'unknown',
    timestampMs: buf.readUInt32LE(36),
  };
}

function decodeStatus(buf) {
  if (buf.length < STATUS_LEN_BASE) return null;
  const out = {
    kind: 'status',
    version: buf.readUInt8(4),
    nodeId: buf.readUInt8(5),
    flags: decodeFlags(buf.readUInt8(6)),
    channel: buf.readUInt8(7),
    uptimeS: buf.readUInt32LE(8),
    freeHeap: buf.readUInt32LE(12),
    framesCaptured: buf.readUInt32LE(16),
    framesDropped: buf.readUInt32LE(20),
    rssi: buf.readInt8(24),
    cpuPct: buf.readUInt8(25),
    rateHz: buf.readUInt16LE(26) / 10,
    timestampMs: buf.readUInt32LE(28),
    position: null,
  };

  // Position was added after the first deployment, so it is optional: a node
  // running older firmware sends 32 bytes and we simply learn nothing about
  // where it is. Reading it conditionally means a mixed fleet keeps working
  // rather than every old node's heartbeat being rejected outright.
  if (buf.length >= STATUS_LEN) {
    const x = buf.readFloatLE(32);
    const y = buf.readFloatLE(36);
    const z = buf.readFloatLE(40);
    // All-zero means "never provisioned", which is not a claim about
    // location — treat it as absent so the server's guess still applies
    // rather than stacking every unprovisioned node at the room's centre.
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
        !(x === 0 && y === 0 && z === 0)) {
      out.position = [x, y, z];
    }
  }
  return out;
}

function decodeEvent(buf) {
  if (buf.length < EVENT_LEN) return null;
  return {
    kind: 'event',
    version: buf.readUInt8(4),
    nodeId: buf.readUInt8(5),
    type: EVENT_TYPE[buf.readUInt8(6)] ?? 'unknown',
    severity: buf.readUInt8(7),
    confidence: buf.readFloatLE(8),
    value: buf.readFloatLE(12),
    timestampMs: buf.readUInt32LE(16),
    sequence: buf.readUInt32LE(20),
  };
}

/**
 * Decode any TriNetra packet. Returns null for anything unrecognised —
 * a UDP port receives all kinds of stray traffic and none of it should
 * be able to throw.
 */
export function decodePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;

  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt8(4);
  if (version !== PROTOCOL_VERSION) return null;

  switch (magic) {
    case MAGIC.CSI:    return decodeCsi(buf);
    case MAGIC.VITALS: return decodeVitals(buf);
    case MAGIC.STATUS: return decodeStatus(buf);
    case MAGIC.EVENT:  return decodeEvent(buf);
    default:           return null;
  }
}

/** Encode a CSI frame — used by the simulator and the replay tool. */
export function encodeCsi({
  nodeId = 1, nSubcarriers = 56, amplitude, phase, rssi = -55,
  noiseFloor = -96, sequence = 0, freqMhz = 2437, channel = 6,
  rateHz = 20, timestampMs = 0, flags = 0, ppduType = 0,
}) {
  const buf = Buffer.alloc(CSI_HEADER_LEN + nSubcarriers * 2);
  buf.writeUInt32LE(MAGIC.CSI, 0);
  buf.writeUInt8(PROTOCOL_VERSION, 4);
  buf.writeUInt8(nodeId, 5);
  buf.writeUInt8(1, 6);
  buf.writeUInt8(ppduType, 7);
  buf.writeUInt16LE(nSubcarriers, 8);
  buf.writeUInt16LE(freqMhz, 10);
  buf.writeUInt32LE(sequence >>> 0, 12);
  buf.writeInt8(Math.max(-128, Math.min(127, Math.round(rssi))), 16);
  buf.writeInt8(noiseFloor, 17);
  buf.writeUInt16LE(Math.round(rateHz * 10), 18);
  buf.writeUInt32LE(timestampMs >>> 0, 20);
  buf.writeUInt8(flags, 24);
  buf.writeUInt8(channel, 25);

  for (let i = 0; i < nSubcarriers; i++) {
    const a = amplitude[i];
    const p = phase[i];
    const im = Math.max(-128, Math.min(127, Math.round(a * Math.sin(p))));
    const re = Math.max(-128, Math.min(127, Math.round(a * Math.cos(p))));
    buf.writeInt8(im, CSI_HEADER_LEN + 2 * i);
    buf.writeInt8(re, CSI_HEADER_LEN + 2 * i + 1);
  }
  return buf;
}
