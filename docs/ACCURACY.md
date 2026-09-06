# Measured behaviour and limits

Numbers first, caveats immediately after. Everything here is measured
against the simulator and labelled `SIMULATED` in every payload — it
describes whether the signal processing works, not what your room will do.

---

## Measured behaviour

From `tests/pipeline.test.js`, over 5 fixed seeds, in the hardest geometry
simulated (subject ~4 m diagonally from corner-mounted nodes):

| Check | Result |
|---|---|
| Empty room → no presence, no people, no vitals | **5/5 seeds** |
| Seated person detected | **5/5 seeds** |
| Breathing within 5 BPM of truth | 3–5 of 5 seeds; error never exceeds 9 BPM |
| Person count inflated above truth | **never**, in any scenario |
| Sleeping subject: presence | **5/5**, breathing 11.3–12.5 BPM vs 11.5 truth |
| Scripted fall raised as an event | detected |
| Vitals reported while walking | **never** (suppressed, not guessed) |
| Position error, subject beside a node | **0.20–0.23 m** median |
| Position error, subject mid-room | **0.5–0.7 m** median |
| Position error, 3 nodes, across the room | **0.92 m** median, 1.68 m p90 |
| Position error, 4 nodes, across the room | **0.79 m** median, 1.50 m p90 |
| Position estimate pinned to node layout | **never** (regression-tested) |
| Breathing rate jump between consecutive ticks | **0.7 BPM** worst, 0 jumps above 1 BPM in 1058 |
| Breathing error, seated subject | 1.2 BPM mean, 3.6 BPM worst |
| Payload contradicting itself (person + "absent") | **never** (regression-tested) |

These numbers are for **simulated** data and are labelled `SIMULATED` in
every payload. They describe whether the signal processing works, not what
your room will do.

---

---

## Limits — read before trusting any of it

**Localisation is metre-scale, and its accuracy varies across the room.**
Four monostatic single-antenna nodes have no time-of-flight, no
angle-of-arrival and no bistatic links. The one spatial observable is
range — how far each node's coupling rose above the empty room — so the
answer is a likelihood surface, not a point. Simulated median error is about
0.2 m for a subject near any node and about 0.7 m at the centre of a 6×5 m
room, which is where all four returns are weakest and most nearly equal.
Every person carries `position_uncertainty_m` and `position_quality`,
`signal_field.evidence` says how much signal the surface rests on, and the
UI draws a disc rather than a point. Do not read the dot as a fix.

**The skeleton is a kinematic model, not per-joint inference.** A
single-antenna 56-subcarrier stream does not carry the spatial information
limb tracking needs; published WiFi pose work uses 3×3 MIMO research NICs —
nine spatial channels against our one — trained on paired camera ground
truth. What is real: the figure stands where the field peak is, lies down
when the posture classifier says lying, and its chest rises at the *measured*
breathing rate. Every payload says `pose_source: "kinematic-model"`.

**Counting tops out at one person, and this is a physics result, not a
todo.** Superimposed scattering at 56 subcarriers is underdetermined for one
node, and adding nodes does not fix it: four nodes yield four scalar range
measurements, while a two-body fit needs six parameters. Matching pursuit
was implemented and measured against the simulator — at every gate setting
it either invented occupants for a single subject (2–3 people on 57% of
ticks) or never fired, and it never once separated two genuine walkers. It
was removed rather than shipped as a plausible-looking guess; the reasoning
and the numbers are in `server/pipeline/field.js`.

So two people are reported as **one**, positioned between them. Every
payload carries `count_method`, and the count never exceeds the truth in any
scenario tested. Missing someone is a limitation; inventing someone is a
fabrication.

**Vitals require stillness.** Chest displacement is millimetres; walking is
centimetres. While someone moves, breathing is *suppressed* — confidence
decays and the reading clears — rather than estimated. Heart rate needs a
close, still subject and will often return `null`; that is the correct answer,
not a bug.

**Calibration must happen in an empty room.** The baseline learned during
those 30 seconds *defines* what "nobody here" means. Calibrate with someone in
the room and presence will never fire again.

---
