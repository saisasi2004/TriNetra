# Deploying TriNetra

Placing the nodes, configuring the room, and the failure that most often
makes a new install look broken.

---

## Where to put the nodes

Three nodes is the minimum that can multilaterate at all — two range circles
meet at two points and leave a mirror ambiguity no processing resolves — so
three is both the common case and the one most worth placing carefully.

Candidate layouts, measured against the simulator over 9 subject positions ×
3 seeds in a 6×5 m room:

| Layout | Median | p90 | Worst |
|---|---|---|---|
| **3 nodes, one per wall, well spread** | 0.92 m | **1.68 m** | 1.93 m |
| 3 nodes, L-shape (2 back + 1 far corner) | 0.92 m | 2.12 m | 3.21 m |
| 3 nodes, 2 back corners + front middle | 0.93 m | 2.43 m | 2.45 m |
| 3 nodes clustered in a narrow triangle | 1.21 m | 3.32 m | 3.48 m |
| 4 nodes, same spread rule | 0.79 m | 1.50 m | 2.00 m |

Two things fall out of that, and both matter more than buying a fourth node:

**Placement beats count.** A well-placed three-node array is within 0.2 m of
a four-node one at p90. A badly-placed three-node array is more than twice
as bad. If you have three nodes, spend the effort on where they go.

**The differences live in the tail, not the median.** Every layout medians
around 0.9 m. What separates them is the awkward corners — which is exactly
where a sensing system gets judged, and exactly what a median hides.

The rule that won: **put each node on a different wall, spread so the
triangle between them contains the middle of the room.** Do not cluster them
on two adjacent walls, which is what "one in each corner" degenerates into
when you only have three — that leaves the far side outside the triangle,
where the range circles cross at shallow angles and a small range error
swings the fix a long way. That is geometric dilution of precision, and it
is a property of where you hang the boxes, not of the code.

Also, mount them at roughly torso height (~1.2 m, the default), not at floor
or ceiling level: the signal you want is a chest moving millimetres, and the
node should be in its plane.

The server places unprovisioned nodes on this rule automatically, scaled to
`--room-size`. The easiest way to set real positions is to draw them: open
`/planner.html`, place a node puck in each room where the board actually
hangs, and save — the plan supplies the footprint, the zones and the
positions together. To set them from the command line instead:

```bash
node server/index.js --simulate --sim-nodes 3 --room-size 7,6,2.8
```

```bash
curl -X POST localhost:8080/api/v1/nodes/1/position -H 'content-type: application/json' -d '{"x":0,"y":1.2,"z":-2.2}'
```

Coordinates are metres from the room centre: `x` across the width, `z` along
the depth, `y` height. Getting these right matters — the field solves for
position by comparing each node's response against a model of where that
node *is*, so a node reported in the wrong place drags every estimate.

---

---

## If only node 1 shows up

Every board ships with `CONFIG_TN_DEFAULT_NODE_ID = 1`, and the id only
becomes unique once `provision.py` has written it to NVS. Flash four boards
and skip (or fumble) provisioning on three, and all four announce themselves
as node 1. The server keys every piece of per-node state on that id, so the
four collapse into **one** node: the dashboard shows a single node and the
other three are invisible rather than reported as broken.

It is worse than losing them. Four radios' CSI is interleaved into one phase
history and one arrival-interval estimate, so the measured sample rate reads
about 4× high and every frequency derived from it — breathing, heart rate —
is wrong by the same factor while looking entirely plausible.

The server now detects this (distinct source addresses sending the same node
id), logs an error, and reports it in `GET /api/v1/health` as
`node_id_conflicts`. The fix is to give each board its own id:

```bash
python provision.py --port COM9 --ssid "YourWiFi" --target-ip 192.168.1.20 --node-id 2
```

---
