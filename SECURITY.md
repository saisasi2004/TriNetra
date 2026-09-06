# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/saisasi2004/TriNetra/security/advisories/new)
rather than a public issue. I will acknowledge within a few days.

## What this system is, in security terms

TriNetra measures **people in their homes** — when they are present, when
they sleep, how they breathe. There is no camera and no microphone, and the
raw signal cannot be reconstructed into a picture of anyone. That is not the
same as harmless. Occupancy patterns reveal when a household is away, and
respiration and heart rate are health data.

Please treat findings here as you would findings in any other system that
handles personal data.

## Known, deliberate weaknesses

These are documented rather than hidden, because knowing about them is what
makes the deployment decisions correct.

**The UDP data plane is unauthenticated.** UDP has no handshake, and adding
a per-frame shared secret would cost more MCU time than the sensing DSP
does. Anything that can reach the ingest port can inject sensing frames.
Mitigations are network-level and on by default:

- the socket binds to loopback unless you explicitly pass `--udp-bind`
- `--udp-allow <cidr>` restricts source addresses
- a hard per-source rate limit stops a flood exhausting the event loop

If you open the port to a LAN, restrict it: `--udp-allow 192.168.1.0/24`.

**Mutating endpoints are loopback-only until you set a token.** Without
`TRINETRA_TOKEN`, `POST` routes (calibration, node positions, zones, arming)
are refused from non-loopback addresses, so an unconfigured install cannot be
reconfigured from the network. Set `TRINETRA_TOKEN` to require a bearer
token and allow remote administration.

**WebSocket auth uses a query-string token.** Browsers cannot set headers on
a WebSocket handshake, so when `TRINETRA_TOKEN` is set the token travels in
the URL, where it can land in proxy logs. This is why it is off by default.

## Credentials and firmware images

WiFi credentials belong in NVS, written over serial by `provision.py`. They
are deliberately **not** compiled in: anything set in `sdkconfig.defaults` or
Kconfig ends up in every built binary and is recoverable with `strings`.

`sdkconfig` is generated and gitignored for the same reason. If you set a
password there for a bench setup, it stays on your machine — do not commit
it, and do not publish a `.bin` built that way.

## Privacy defaults

- Recordings are gitignored and carry a header noting they hold personal data
- MQTT publishes presence and occupancy, but **not** vitals unless you
  explicitly enable `mqtt.publishVitals`
- Nothing is transmitted off the local network by default
