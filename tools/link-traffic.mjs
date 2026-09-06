#!/usr/bin/env node
/**
 * Link exciter — generates the RX traffic that CSI measurement depends on.
 *
 * WHY THIS EXISTS
 *
 * CSI is not sampled on a clock. The radio produces one channel estimate per
 * RECEIVED frame, so the sample rate of the entire sensing pipeline is
 * whatever the frame arrival rate happens to be. An associated but idle node
 * receives little more than beacons — on the order of 10 Hz, often far less
 * once the AP filters — and that is not enough to do the job:
 *
 *   - Heart rate lives at 0.8-2.0 Hz. Nyquist alone demands >4 Hz, and
 *     autocorrelation on a noisy band needs several times that to be stable.
 *   - node-state.js sizes its history windows assuming ~20 Hz.
 *
 * `ping -t` is the usual advice and it is not sufficient on Windows: the
 * built-in ping has no sub-second interval option, so it emits exactly one
 * packet per second. That yields ~1 Hz CSI — enough to prove the link works,
 * useless for vitals.
 *
 * This sends UDP to the node at a configurable rate. Nothing listens on the
 * far side; that is fine and intended. The frame is received by the WiFi
 * hardware — which is the only thing CSI cares about — before lwIP decides
 * there is no socket for it.
 *
 * USAGE
 *
 *   node tools/link-traffic.mjs                      <- auto-discover, use this
 *   node tools/link-traffic.mjs 192.168.0.14 192.168.0.15
 *
 * With no arguments it asks the running server which nodes are streaming to
 * it and excites exactly those, re-checking every few seconds so a newly
 * flashed node is picked up without restarting, and a DHCP address change
 * fixes itself.
 *
 * A subnet broadcast (192.168.0.255) looks like the obvious way to cover the
 * whole fleet with one destination, and it is NOT reliable: many consumer APs
 * drop or heavily rate-limit broadcast to wireless clients to save airtime.
 * Measured on the deployment network this was written for, broadcast
 * delivered 0 Hz to every node while unicast to the same nodes delivered
 * 20 Hz. Unicast per node is the form that works.
 *
 * Leave it running for as long as you want sensing to work. Ctrl+C to stop.
 */

import dgram from 'node:dgram';

/**
 * Above this the pipeline breaks, so warn.
 *
 * node-state.js gates breathing-band power on
 *     phaseHistory.length >= ceil(sampleRateHz * 8)
 * i.e. eight seconds of history, because resolving a 0.1-0.5 Hz band needs
 * to see several full cycles. But the ring is a fixed 256 FRAMES, not a
 * fixed duration. Above 32 Hz the eight-second requirement exceeds what the
 * ring can ever hold, the condition is never true, and breathing detection
 * silently never runs — no error, no warning, just permanently null vitals.
 */
const MAX_USEFUL_HZ = 32;

const DEFAULTS = {
  /** Packets per second per node.
   *
   *  Faster is NOT better here. The pipeline is designed around ~20 Hz:
   *  TN_FRAME_HISTORY is 256 frames, which at 20 Hz is 12.8 s — enough to
   *  resolve a 6 BPM breathing cycle with margin. Raising the rate shortens
   *  the window in TIME while leaving it fixed in FRAMES, so you trade away
   *  exactly the low-frequency resolution that breathing depends on.
   *
   *  20 Hz leaves headroom under MAX_USEFUL_HZ for beacons and other traffic
   *  that also generate CSI records. */
  rate: 20,
  /** Payload bytes. Small is fine — CSI depends on the frame arriving, not on
   *  how much it carries. Kept above the runt threshold so no AP drops it. */
  size: 64,
  /** Discard port (RFC 863). Deliberately a port with no listener. */
  port: 9,
  /** Where to ask which nodes exist, when no hosts are given explicitly. */
  server: 'http://localhost:8090',
};

/** How often to re-ask the server for the node list. */
const DISCOVER_INTERVAL_MS = 5000;

function parseArgs(argv) {
  const opts = { ...DEFAULTS, hosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rate') opts.rate = Number(argv[++i]);
    else if (a === '--size') opts.size = Number(argv[++i]);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--server') opts.server = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else opts.hosts.push(a);
  }
  return opts;
}

function usage() {
  console.log(`
Link exciter — keeps CSI flowing by giving the nodes frames to receive.

  node tools/link-traffic.mjs [options] [node-ip ...]

  --rate <hz>     packets per second per node  (default ${DEFAULTS.rate})
  --size <n>      payload bytes                (default ${DEFAULTS.size})
  --port <n>      destination UDP port         (default ${DEFAULTS.port})
  --server <url>  where to auto-discover nodes (default ${DEFAULTS.server})

With no node IPs, it asks the running server which nodes are streaming to it
and excites those, re-checking every ${DISCOVER_INTERVAL_MS / 1000}s. Flash another node and it
joins automatically; a DHCP address change corrects itself.

Do not raise --rate above ${MAX_USEFUL_HZ}. The pipeline's history ring is a fixed
256 frames, so a higher rate shortens the window in TIME and breaks the
low-frequency resolution that breathing depends on.

Do not use a broadcast address. Many consumer APs drop broadcast to wireless
clients; measured on a real deployment it delivered 0 Hz while unicast to the
same nodes delivered 20 Hz.
`);
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  usage();
  process.exit(0);
}
if (!Number.isFinite(opts.rate) || opts.rate <= 0 || opts.rate > 1000) {
  console.error('--rate must be between 1 and 1000');
  process.exit(1);
}
if (opts.rate > MAX_USEFUL_HZ) {
  console.warn(
    `\n!! ${opts.rate} Hz is above the ${MAX_USEFUL_HZ} Hz ceiling.\n` +
    `!! Breathing detection needs 8 s of history but the ring holds only 256\n` +
    `!! frames, so above ${MAX_USEFUL_HZ} Hz that condition can never be met and\n` +
    `!! breathing/heart rate stay null forever — silently. Use --rate 20.\n`
  );
}

const sock = dgram.createSocket('udp4');
const payload = Buffer.alloc(opts.size, 0x5a);
const intervalMs = 1000 / opts.rate;

let sent = 0;
let errors = 0;
const startedAt = Date.now();

sock.on('error', (err) => {
  console.error(`socket error: ${err.message}`);
  sock.close();
  process.exit(1);
});

const isBroadcast = (h) => h === '255.255.255.255' || h.endsWith('.255');

/** Hosts we are currently exciting. Replaced wholesale by discovery. */
let targets = [...opts.hosts];
const discovering = opts.hosts.length === 0;

/**
 * Ask the server which nodes are actually streaming to it.
 *
 * The server already records the source address of every node that sends it a
 * packet, so it is the one place that always knows the current fleet. Polling
 * it means a node flashed ten minutes from now starts getting traffic without
 * anyone editing a command line, and a DHCP renewal repairs itself.
 */
async function discover() {
  try {
    const r = await fetch(`${opts.server}/api/v1/nodes`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const ips = (j.sources ?? [])
      .filter((s) => (s.node_ids ?? []).length > 0)
      .map((s) => s.ip)
      .filter((ip) => !isBroadcast(ip));
    const next = [...new Set(ips)].sort();

    if (next.length && next.join() !== targets.join()) {
      const added = next.filter((x) => !targets.includes(x));
      const gone = targets.filter((x) => !next.includes(x));
      targets = next;
      process.stdout.write(
        `\n  targets -> ${next.join(', ')}` +
        `${added.length ? `  (+${added.join(', ')})` : ''}` +
        `${gone.length ? `  (-${gone.join(', ')})` : ''}\n`
      );
    }
  } catch {
    // Server not up yet, or restarting. Keep exciting whatever we had.
  }
}

sock.bind(async () => {
  if (targets.some(isBroadcast)) {
    sock.setBroadcast(true);
    console.warn(
      `\n!! ${targets.filter(isBroadcast).join(', ')} is a broadcast address.\n` +
      `!! Many consumer APs silently drop broadcast to wireless clients — on a\n` +
      `!! real deployment this delivered 0 Hz while unicast delivered 20 Hz.\n` +
      `!! If frames do not arrive, pass the node IPs instead, or no arguments\n` +
      `!! at all to discover them from the server.\n`
    );
  }

  if (discovering) {
    console.log(`Discovering nodes from ${opts.server} ...`);
    await discover();
    setInterval(discover, DISCOVER_INTERVAL_MS);
    if (targets.length === 0) {
      console.log('  none yet — will keep checking. Is the server running?');
    }
  }

  console.log(
    `Exciting at ${opts.rate} Hz per node ` +
    `(${opts.size} B -> UDP/${opts.port}). Ctrl+C to stop.\n` +
    `Nothing listens on the far side — that is expected. The frame only has\n` +
    `to be RECEIVED for the radio to produce a CSI record.\n`
  );

  setInterval(() => {
    for (const host of targets) {
      sock.send(payload, opts.port, host, (err) => {
        if (err) errors++;
        else sent++;
      });
    }
  }, intervalMs);

  setInterval(() => {
    const secs = (Date.now() - startedAt) / 1000;
    // Per-node rate is only meaningful against the CURRENT target count; if
    // nodes joined partway through, this reads low until the average catches
    // up. Showing the count makes that visible rather than confusing.
    const perNode = targets.length ? sent / targets.length / secs : 0;
    process.stdout.write(
      `\r  ${targets.length} node(s)  sent ${sent}  (~${perNode.toFixed(1)} Hz/node)` +
      `${errors ? `  errors ${errors}` : ''}   `
    );
  }, 1000);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    const secs = (Date.now() - startedAt) / 1000;
    console.log(
      `\n\nStopped after ${secs.toFixed(0)}s — ${sent} packets, ${errors} errors.`
    );
    sock.close();
    process.exit(0);
  });
}
