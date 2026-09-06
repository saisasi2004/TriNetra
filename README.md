<div align="center">

# △ TriNetra

**Turn ordinary WiFi into a sensing system.**

Detect people, measure breathing and heart rate, catch falls and track room
occupancy — through walls, in the dark, with no cameras and nothing worn.

[![CI](https://github.com/saisasi2004/TriNetra/actions/workflows/ci.yml/badge.svg)](https://github.com/saisasi2004/TriNetra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-v5.1.2-red.svg)](https://docs.espressif.com/projects/esp-idf/)

</div>

---

```bash
git clone https://github.com/saisasi2004/TriNetra.git
cd TriNetra
npm install
npm run sim
# open http://localhost:8080
```

That runs the whole system against a physics-based radio simulator — no
hardware required. Everything you see is derived by the same signal
processing that runs on real CSI frames.

---

## Features

| Capability | How it works | Status |
|---|---|---|
| **Presence** | Motion energy against a learned ambient baseline, **plus** breathing-band power — a still or sleeping person is invisible to motion alone | Working |
| **Respiration** | Phase → STO/CFO removal → Hampel → Butterworth 0.1–0.5 Hz → autocorrelation → median → EMA | Working |
| **Heart rate** | Breathing harmonics *notched out*, then a 0.8–2.0 Hz band, then autocorrelation | Working when the subject is still and close |
| **Fall detection** | Motion-jerk z-score > 4.5σ, 2-frame confirm, **plus** a relative stillness collapse within 2.5 s | Working |
| **Localisation** | Range-based multilateration against a path-loss model, with blob segmentation | ~0.2 m near a node, ~0.9 m room-wide |
| **Person tracking** | Field segmentation → greedy association → Kalman tracks with birth/death | One person; two are merged into one |
| **Posture** | Coarse four-way label (lying / sitting / standing / walking), Schmitt-triggered | Coarse by design |
| **Semantic states** | 12 dwell-timed detectors — sleeping, bed exit, distress, apnea, intrusion … each reporting its own evidence | Working |
| **Floor plans** | Draw your own layout in the browser; it defines the room size, the zones and the node positions | Working |
| **Home Assistant** | MQTT auto-discovery, ~21 entities | Working |
| **Edge processing** | Presence, vitals and falls computed **on the MCU**, so a node keeps working with the server off | Working |

### What makes it different

**It refuses to guess.** Vitals are *suppressed* rather than estimated while
someone moves — chest displacement is millimetres and walking is
centimetres, so the small signal genuinely is not recoverable from under the
large one. Person counts undercount rather than invent. Every position
carries an uncertainty and an evidence score. Every payload says `SIMULATED`
when it is, and `pose_source: "kinematic-model"` because the on-screen
skeleton is a model driven by measured position and breathing rate, not
per-joint inference.

A plausible wrong number is worse than a blank, because a blank is obviously
unusable and a wrong number gets trusted.

---

## How it works

```
ESP32-C6 / S3 / WROOM  ──UDP:5005──►  Node.js server  ──WS──►  Browser
      (ESP-IDF C)                     (Express + ws)     (vanilla JS + three.js)

 CSI capture                    decode, per-node DSP     Observatory (3D)
 phase sanitisation             multi-node fusion        Dashboard (tables/charts)
 biquad + autocorrelation       spatial field            REST /api/v1
 presence / vitals / falls      person tracking          MQTT → Home Assistant
 UDP send                       semantic states
```

WiFi radios estimate **Channel State Information** — amplitude and phase per
subcarrier — in order to equalise incoming frames. A body in the room
perturbs those paths. A chest moving 5 mm at 2.4 GHz shifts the reflected
path phase by roughly 0.5 radians, which is measurable once you remove the
hardware artefacts sitting on top of it.

```
TriNetra/
├── firmware/trinetra-csi-node/   ESP-IDF C firmware
│   ├── main/trinetra_protocol.h  wire format — mirrored in server/net/protocol.js
│   ├── main/csi_collector.c      esp_wifi_set_csi_rx_cb, ring buffer, PPDU lock
│   ├── main/dsp.c                biquad, Hampel, NCC autocorrelation, notch
│   ├── main/edge_processing.c    presence, vitals, posture, falls
│   └── provision.py              writes credentials to NVS over serial
├── server/
│   ├── dsp/                      FFT, filters, vitals extraction
│   ├── pipeline/                 node state, field, tracking, pose, semantics
│   ├── net/                      protocol, UDP ingest, WebSocket, REST
│   ├── sim/                      physics-based CSI simulator + 13 scenarios
│   └── integrations/mqtt.js      Home Assistant discovery
├── public/                       Observatory + Dashboard + Planner (no build step)
│   └── js/lib/plan.js            floor plan schema + geometry, SHARED with the server
├── docs/                         deployment, accuracy, engineering notes
└── tests/                        59 tests: DSP, pipeline, plans, wire contract, parity
```

---

## Usage

### Simulated

```bash
npm run sim                                    # 3 simulated nodes
node server/index.js --simulate --scenario sleep_monitoring
node server/index.js --simulate --sim-nodes 4  # match the hardware you own
```

Thirteen scenarios ship with it — empty room, vital signs, two people
walking, a scripted fall, sleep with an apnea event, unsteady elderly gait,
intrusion, a meeting room, a casualty behind a wall. Pick them from the UI
or with the flag.

### Live, with hardware

```bash
npm run live                                   # UDP bound to 0.0.0.0
node server/index.js --udp-bind 0.0.0.0 --udp-allow 192.168.1.0/24
node server/index.js --room-size 7,6,2.8       # override the plan's footprint
node server/index.js --mqtt mqtt://homeassistant.local:1883
```

Port 8080 taken? `--http-port 8090`. Full flag list: `node server/index.js --help`.

### Hardware

| Board | Target | CSI resolution |
|---|---|---|
| ESP32-WROOM-32 (DevKit V1) | `esp32` | 56 active subcarriers |
| ESP32-S3-DevKitC | `esp32s3` | 56 active subcarriers |
| **ESP32-C6-DevKitC** | `esp32c6` | 242 tones with a WiFi 6 AP, else 56 |

Three nodes is the practical minimum: two range circles intersect in two
places and leave an ambiguity nothing resolves, so three is the first count
that yields a unique fix.

```bash
cd firmware/trinetra-csi-node
idf.py set-target esp32c6
idf.py build
idf.py -p COM9 flash monitor

pip install pyserial
python provision.py --port COM9 --ssid "YourWiFi" --target-ip 192.168.1.20 --node-id 1
```

Give **every board a different `--node-id`**. They all default to 1, and the
server keys per-node state on it, so unprovisioned boards silently collapse
into a single node. Placement matters more than node count — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Then run `npm run live`, and **calibrate with the room empty**. The baseline
learned in those 30 seconds *defines* what "nobody here" means.

---

## API

`GET /api/v1/…` — `info`, `health`, `status`, `metrics` (Prometheus),
`sensing/current`, `sensing/vitals`, `sensing/presence`, `sensing/persons`,
`sensing/field`, `sensing/semantic`, `nodes`, `nodes/:id`, `events`, `zones`,
`simulator`, `recordings`, `floorplan`, `floorplans`, `floorplans/:id`

`POST` (auth required) — `calibrate`, `nodes/:id/position`, `nodes/:id/room`,
`zones`, `simulator/scenario`, `security/arm`, `recording/start|stop`,
`floorplan`, `floorplan/activate`

`ws://host/ws/sensing` streams one `sensing_update` per tick, 10 Hz by
default. The payload shape is pinned by `tests/contract.test.js`, so a
renamed server field fails the build rather than silently blanking a UI
panel.

`GET /api/v1/info` returns a `limitations` object that the dashboard renders
verbatim, so the caveats cannot drift out of sync with the code.

---

## Your floor plan

The space is defined by a **floor plan**, not by a flag. TriNetra ships with
a real two-bedroom flat as the built-in default, and you draw your own at
**http://localhost:8080/planner.html** — rectangles for rooms, gaps for
doorways, and a puck for each node where it physically hangs.

Drawing it is not decoration. The active plan supplies three things the
sensing pipeline needs and previously had to be told separately:

- **the room footprint**, so `--room-size` no longer has to be kept in
  agreement with the 3D view by hand
- **the zones**, so a person is reported in `kitchen` rather than in the
  `north-west` quadrant fallback
- **the node positions**, which is what the field actually multilaterates
  against — a guessed layout produces a plausible-looking field that is
  wrong everywhere

Plans are stored under `data/plans/` (gitignored: a plan is a map of
someone's home). The built-in is read-only; duplicate it to make it yours.
Activate a plan and the live view follows without a reload.

```bash
node server/index.js --plan my-flat        # start on a specific plan
node server/index.js --room-size 7,6,2.8   # override just the footprint
```

---

## Accuracy, and what it cannot do

Read [docs/ACCURACY.md](docs/ACCURACY.md) before trusting any output. The
short version:

- **Localisation is metre-scale.** About 0.2 m beside a node and 0.9 m
  room-wide median with three well-placed nodes. Read the uncertainty and
  the evidence score, not the dot.
- **Counting tops out at one person.** Four nodes give four scalar range
  measurements against a six-parameter two-body fit. Matching pursuit was
  implemented, measured and removed: at every setting it either invented
  occupants or never fired. Two people are reported as one, positioned
  between them.
- **There is no skeletal pose, and there cannot be.** Per-joint inference
  needs spatial diversity; published WiFi pose work uses 3×3 MIMO research
  NICs against this hardware's single antenna.
- **Vitals require stillness**, and heart rate needs a close, still subject.
  `null` is a correct answer, not a bug.
- **Calibrate in an empty room.** Calibrate with someone in it and presence
  will never fire again.

---

## Development

```bash
npm test                              # 59 tests
node tests/harness.js fall_event 60   # headless scenario, ~5 s per 60 s simulated
```

The simulator models **bodies** — position, gait, breathing rate, chest
displacement — and turns them into CSI through a scattering model. It never
asserts outputs. If the pipeline breaks, the simulated room breaks with it,
which is the only reason a demo is worth anything. Runs are seeded, so a
result can be reproduced exactly.

`firmware/.../main/dsp.c` and `server/dsp/filters.js` implement the same
algorithms and must be changed together; `tests/firmware-parity.test.js`
enforces that they agree.

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md).

---

## Privacy

No cameras, no microphones, no images. The raw signal is a vector of complex
numbers per subcarrier and cannot be reconstructed into a picture of anyone.

That is not the same as harmless. Occupancy patterns reveal when a household
is home, asleep or away, and breathing and heart rate are health data.
Accordingly: recordings are gitignored and carry a header noting they hold
personal data; MQTT publishes presence and occupancy but **not** vitals
unless you explicitly enable `mqtt.publishVitals`; UDP ingest binds to
loopback until you deliberately open it; and nothing leaves your network by
default.

The UDP data plane is **not authenticated** — anything that can reach the
port can inject sensing frames. Restrict it with `--udp-allow <cidr>`. See
[SECURITY.md](SECURITY.md).

---

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) ©GSSV
