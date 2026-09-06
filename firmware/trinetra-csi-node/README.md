# TriNetra CSI Node — ESP-IDF firmware

Captures WiFi Channel State Information, computes presence / breathing /
heart rate / falls **on the MCU**, and streams both raw CSI and derived
vitals to the TriNetra sensing server over UDP.

The node is useful standalone. If the server is down, presence detection,
vital signs, and fall alerts keep running on the board.

## Hardware

| Board | Target | CSI | Notes |
|---|---|---|---|
| **ESP32-WROOM-32** (DevKit V1, 38-pin) | `esp32` | 56 active subcarriers (HT-LTF) | Cheapest, and the target this code most closely matches |
| **ESP32-S3-DevKitC** | `esp32s3` | 56 active subcarriers (HT-LTF) | Native USB, no serial-driver install |
| **ESP32-C6-DevKitC** | `esp32c6` | 242 (HE-LTF) *if* the AP is WiFi 6, else 56 | Ported and building. Console must be UART on IDF 5.1.x — see below |

The classic ESP32 and the S3 produce **identical CSI**. The sensing is the
same; only USB convenience and silicon age differ.

The C6 is the only part that can do better, and **only when paired with an
802.11ax access point**. Against a WiFi 4/5 router it associates as an HT
client and delivers the same 56 tones as everything else. The firmware
detects which format it is actually receiving and locks to it (see the PPDU
lock in `csi_collector.c`) rather than letting the tone count flip
frame-to-frame, which would make phase tracking meaningless.

Two C6-specific things are worth knowing:

- `wifi_csi_config_t` is a **different struct** on WiFi 6 parts — IDF
  typedefs it to `wifi_csi_acquire_config_t`, a bitfield selecting PPDU
  formats. `csi_collector.c` switches on `CONFIG_SOC_WIFI_HE_SUPPORT`, the
  same condition IDF's own header uses.
- On **ESP-IDF 5.1.x the console must be UART**. Selecting the USB-Serial-JTAG
  console breaks the build inside IDF itself: `sleep_modes.c` uses
  `CONFIG_ESP_CONSOLE_UART_BAUDRATE` unconditionally on any SoC with
  `SOC_PM_SUPPORT_TOP_PD`, but Kconfig only defines that symbol when the
  console is UART. Fixed upstream after 5.1.x.

## Build status

**Verified building clean on ESP-IDF v5.1.2**, from a wiped build directory,
with zero warnings:

| Target | Build dir | Size | App partition free |
|---|---|---|---|
| `esp32` | `build/` | 790 KB | 31% |
| `esp32c6` | `build-c6/` | 810 KB | 30% |

Not yet run on hardware — a clean build is not evidence that the sensing
works on real silicon. That requires a captured boot log from a real board.

### The C6 built clean and still could not boot

Worth stating plainly, because it is the trap this target sets. Until
recently the firmware **compiled without a single warning for `esp32c6` and
then panicked in `app_main`**, every time, on every board.

`main.c` created the sensing task with `xTaskCreatePinnedToCore(..., 1)`.
The C6 is a **single-core** RISC-V part, so IDF builds it with
`CONFIG_FREERTOS_UNICORE=1` and `configNUM_CORES == 1`. FreeRTOS asserts
`xCoreID < configNUM_CORES` in `tasks.c`, and assertions are enabled in
every default build — so the call aborted the moment it was reached.

Nothing caught it earlier because the core id is a **runtime integer**: the
compiler has no reason to object, and there is no build-time signal of any
kind. If you are debugging a board that flashes fine and then reboots in a
loop, this class of bug — a runtime assert in startup — is where to look,
and `idf.py monitor` will show you the panic and backtrace.

Fixed by using `tskNO_AFFINITY`, which is also correct on the dual-core S3.

## Build

Requires ESP-IDF v5.1 or newer. Each target has an overlay in
`sdkconfig.defaults.<target>` that is picked up automatically.

```bash
cd firmware/trinetra-csi-node

# ESP32-WROOM-32 / DevKit V1
idf.py set-target esp32
idf.py build
idf.py -p COM9 flash monitor

# ESP32-S3
idf.py set-target esp32s3 && idf.py build && idf.py -p COM9 flash monitor
```

`set-target` wipes `sdkconfig`, so run it once per board family — not before
every build.

## Provision

Credentials are **not** compiled in. They are written to NVS over the serial
console, so the firmware binary is safe to share.

You *can* set `CONFIG_TN_DEFAULT_SSID` and `CONFIG_TN_DEFAULT_PASSWORD` for a
throwaway bench setup — `sdkconfig` is gitignored — but anything set there
ends up in every binary you build and comes straight back out with
`strings`. Never commit it, and never publish a `.bin` built that way.

Beyond credentials, one setting decides whether anything works at all:
`CONFIG_TN_DEFAULT_TARGET_IP` must be the machine running the server, on the
subnet the node joins. A wrong value fails in the most confusing way
available — the node associates, the console says `online`, and it streams
UDP to an address that does not exist. UDP is unacknowledged, so nothing
reports an error anywhere; the server just shows no nodes.

That address usually comes from DHCP and moves on its own, so give the
server machine a static lease on your router if nodes start going quiet for
no reason.

To provision properly instead:

```bash
pip install pyserial
python provision.py --port COM9 --ssid "YourWiFi" --target-ip 192.168.1.20 --node-id 1 --room "living-room" --position 0 0 1.2
```

**Give every board a different `--node-id`.** The build default is `1` for
all of them, and the server keys all per-node state on that value, so
unprovisioned boards collapse into a single node — the fleet appears
smaller rather than broken, and the merged node's sample rate reads several
times high, which corrupts every vital sign derived from it. The server
detects the collision and reports it in `GET /api/v1/health`.

You will be prompted for the password without echo. To inspect a node:

```bash
python provision.py --port COM9 --show
```

You can also drive the console by hand in `idf.py monitor`:

```
SET ssid MyNetwork
SET target 192.168.1.20
SET node 2
SAVE
REBOOT
```

`RECAL` restarts the 30-second ambient calibration without a reboot — use it
after moving furniture or the node itself.

## No hardware yet?

```bash
python provision.py --port COM9 --mock
```

Mock mode generates physically-shaped synthetic CSI (15 BPM breathing,
69 BPM heart rate, realistic phase ramp and noise) so you can exercise the
whole pipeline on a bench. Every packet it emits carries `TN_FLAG_MOCK_SOURCE`,
and the server labels the data **SIMULATED** end to end — it cannot be
mistaken for a measurement.

## Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `ssid` / `pass` | — | WiFi station credentials |
| `target` / `port` | `192.168.1.20:5005` | Sensing server UDP endpoint |
| `node` | 1 | Node ID, unique per deployment (1–254) |
| `room` | `room-1` | Room label used by the server |
| `pos` | `0 0 1.2` | Node position in metres, for multi-node localisation |
| `calib` | 30 | Ambient calibration seconds |
| `rawcsi` | 1 | Send raw CSI frames (0 = vitals/events only) |
| `decim` | 1 | Send 1 of every N CSI frames |
| `mock` | 0 | Synthetic CSI |

## Two settings that will ruin your data if you change them

Both are pre-set in `sdkconfig.defaults`, and both fail silently rather than
loudly:

1. **`CONFIG_ESP_WIFI_PS_NONE=y`** — with power save on, the radio wakes only
   for beacons. The CSI rate collapses to ~10 Hz with heavy jitter, which is
   below the Nyquist requirement for the 2.0 Hz upper edge of the heart-rate
   band. You still get numbers; they are just wrong.
2. **BSSID filtering** (`tn_csi_start(bssid)`) — without it every neighbouring
   AP's beacon triggers a CSI callback. The effective sample rate becomes
   irregular and every frequency estimate downstream is meaningless.

## What the node computes, and how

| Output | Method |
|---|---|
| Presence | Amplitude-delta motion energy vs learned ambient baseline, 2.4x on / 1.5x off hysteresis, 4-frame debounce |
| Motion energy | Mean absolute per-subcarrier amplitude change, normalised by link strength |
| Breathing | Phase → STO/CFO removal → Hampel → Butterworth 0.1–0.5 Hz → autocorrelation peak → median → EMA |
| Heart rate | Same chain at 0.8–2.0 Hz, **with explicit rejection of breathing harmonics** |
| Fall | Phase acceleration > 6σ, 3-frame confirm, **plus** a stillness check within 1.2 s, 5 s cooldown |
| Posture | Coarse four-way label from motion energy + breathing regularity, Schmitt-triggered with a 15-frame dwell so it does not flicker at a threshold |
| Person count | Motion-energy bucket — an estimate, not a measurement |
| Signal quality | 0.4·RSSI + 0.35·phase coherence + 0.25·SNR |

### The heart-rate trap

Zero-crossing heart-rate estimation on CSI phase does not work, and it fails
in a way that looks like success. Breathing at 0.25 Hz puts its 3rd harmonic
at 0.75 Hz ≈ 45 BPM — a perfectly plausible resting heart rate. The estimate
locks there and stays rock steady while being entirely wrong.

The fix is in `tn_bpm_autocorr()`: estimate breathing first, then search the
HR autocorrelation while explicitly rejecting lags within 8% of any harmonic
`k × f_breathing` for k=1..6. If you rewrite this function, keep the rejection.

### Latency

Capture-to-UDP is dominated by scheduling, not by the DSP. Three things
were costing far more than the arithmetic:

- **The sensing loop yielded on every frame.** `vTaskDelay(1)` at the top of
  the loop was there to stop the task starving the idle task under a queue
  backlog, which is a real hazard — but it applied on every frame, not just
  the busy ones. At the default 100 Hz tick that is a **10 ms floor on every
  frame** and a hard ceiling of 100 loop iterations per second, below what a
  C6 can capture. Now it yields once per 8 frames, which gives the idle task
  the same guarantee at an eighth of the cost, and the common case — a frame
  arriving into an empty queue — goes straight through, because blocking on
  the queue is itself a yield.
- **The scheduler tick was 10 ms.** `CONFIG_FREERTOS_HZ=1000` makes the
  smallest pause anything can take 1 ms instead of 10. The cost is more timer
  interrupts, which is not measurable here but would matter on a battery
  deployment, since a 1 ms tick blocks long light-sleep windows.
- **The autocorrelator recomputed itself about four times over.**
  `tn_bpm_autocorr` called the O(n) `ncc()` once to find the global maximum,
  three more times per lag while hunting the first local peak, again for the
  fallback scan, and twice for the parabolic fit — roughly 350 evaluations of
  a 256-sample inner loop per band, twice per vitals update, on a core with
  no FPU headroom to spare. Now evaluated once per lag into a 129-float
  cache, for about a 4× reduction in the largest CPU cost in the path.

`esp_wifi_set_ps(WIFI_PS_NONE)` was already correct and matters more than
all of the above: with modem sleep on, the radio wakes only for beacons and
the CSI rate collapses to ~10 Hz with heavy jitter.

### Honest limits

- **Person count above 1 is not achievable, here or on the server.** One
  antenna cannot separate two people; superimposed scattering is
  underdetermined. Adding nodes does not rescue it either — four nodes give
  four scalar range measurements against a six-parameter two-body fit. The
  server implemented and measured matching pursuit for exactly this and
  removed it: at every setting it either invented occupants or never fired.
  The node's `n_persons` is a motion-energy bucket and is labelled as one.
- **There is no skeletal pose here, and there cannot be.** This is a
  physical limit, not a missing feature, and no amount of firmware work
  moves it. Per-joint pose requires spatial diversity — published WiFi pose
  work uses 3×3 MIMO research NICs, nine spatial channels against this
  part's one, trained against paired camera ground truth. A single antenna
  captures one complex number per subcarrier per frame; which limb produced
  a given reflection is simply not in the data, so any 17-keypoint output
  from one ESP32 is generated, not measured.

  What the C6 *does* add over the classic ESP32 is frequency resolution —
  242 tones instead of 56, and only against an 802.11ax AP. That is finer
  delay-domain resolution, which helps range. It is not spatial diversity
  and does not help limb inference.

  What you get is `posture`: a coarse four-way label (lying / sitting /
  standing / walking), now Schmitt-triggered so it stays put instead of
  flickering at a threshold. The 17 keypoints the UI draws come from the
  server's kinematic body model, driven by measured position, posture and
  breathing rate, and every payload says `pose_source: "kinematic-model"`.
- **Vitals require stillness.** Chest displacement is millimetres; walking is
  centimetres. While someone moves, breathing is suppressed rather than
  guessed — `breathing_conf` decays to zero and the reading clears.
- **Range is a few metres and depends on geometry.** Through-wall works, but
  attenuation and Fresnel-zone position dominate. Measure it in your space.

## Wire protocol

All packets are little-endian, prefixed with a 4-byte magic, defined in
[`main/trinetra_protocol.h`](main/trinetra_protocol.h) and mirrored in
`server/net/protocol.js`.

| Magic | Packet | Size | Rate |
|---|---|---|---|
| `0x544E0001` | CSI frame | 28 + 2N bytes | up to 20 Hz |
| `0x544E0002` | Vitals | 40 bytes | 2 Hz |
| `0x544E0003` | Status | 32 bytes | 0.2 Hz |
| `0x544E0004` | Event | 24 bytes | on occurrence |

## Bandwidth

Raw CSI at 20 Hz is ~22 kbit/s per node (S3) or ~82 kbit/s (C6 HE frames).
For battery or large mesh deployments, `SET rawcsi 0` keeps the 2 Hz vitals
stream at well under 1 kbit/s, or use `SET decim 4` to keep CSI at 5 Hz.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no CSI for 3s` | No traffic on the link. CSI only arrives when a frame is received — ping the node from a laptop, or run iperf against the AP |
| Heart rate parked at ~45 BPM | Breathing-harmonic lock. Verify `reject_hz` is being passed to `tn_bpm_autocorr` |
| Presence never triggers | Calibration captured a room that already had someone in it. Leave the room and `RECAL` |
| Presence always on | Fan, AC, curtains, or a pet. Raise `PRESENCE_ON_RATIO` in `edge_processing.c` |
| Erratic BPM | Sample rate too low or too jittery. Check `rate_hz` in the status packet — you want a steady 15–20 Hz |
| `queue alloc failed` | Not enough heap for the CSI ring. Reduce `CSI_QUEUE_DEPTH` or `TN_MAX_SUBCARRIERS` |
