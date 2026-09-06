# Engineering notes

Why parts of TriNetra are built the way they are, and the bugs that shaped
them. None of this is required to *use* the system — start with the
[README](../README.md). It is here because every one of these produced
convincing output while being wrong, and that is worth writing down.

---

## The simulator is a physics model, not a script

Scenarios describe **bodies** — position, gait, breathing rate, chest
displacement — and the simulator turns them into CSI using a scattering
model: a static line-of-sight component, one reflected path per person whose
length modulates with a 5 mm chest displacement, path loss, subcarrier-
dependent phase, a hardware STO ramp, AGC noise and int8 quantisation.

Presence, vitals, tracks and semantic states are then derived by **the same
DSP that processes hardware frames**. No scenario can assert an output. If
the pipeline breaks, the simulated room breaks with it — which is the only
reason a demo is worth anything.

Runs are seeded, so a result can be reproduced exactly.

---

---

## Bugs worth knowing about

Every one of these produced plausible-looking output while being completely
wrong, which is why they survived as long as they did. Regression tests now
cover each.

Worth separating how they were caught. Bugs 1–4 were found by tests. Bugs
5–8 were not: they were found by comparing outputs against ground truth
while all 29 tests passed, and they passed *because* nothing in the suite
ever checked a reported position against where the person actually was, or a
reported vital against the previous tick. A test suite only defends the
properties it names, and the most important property of a localisation
system had no test at all.

**1. Autocorrelation length bias.** Normalising every lag by the full-window
energy favours short lags, because a long lag sums fewer overlapping terms.
The estimator railed at the top of the search band — every breathing rate came
back as exactly 30 BPM. Fixed with a normalised cross-correlation over the
overlapping segment only.

**2. Octave errors.** A periodic signal correlates with itself at its period
*and* at 2T, 3T… with near-identical scores, so the global maximum lands on an
arbitrary multiple and 15 BPM reads as 7.5. Fixed by taking the first
significant local peak, the standard pitch-tracking remedy.

**3. Heart rate locks onto breathing harmonics.** 0.25 Hz breathing puts its
3rd harmonic at 0.75 Hz ≈ 45 BPM — a perfectly plausible resting heart rate,
and stronger than the real cardiac signal. Excluding those lags is *not*
enough: the harmonic still dominates the whole correlation. The interfering
component must be notched out of the signal first.

**4. Fall detection watching a constant.** The detector took the mean of the
sanitized phase — but `sanitizePhase` subtracts a least-squares line, which
forces that mean to be identically zero. It was monitoring a quantity that is
always 0 and could never fire. Compounding it, the stillness confirmation used
an absolute threshold below the ambient noise floor, so it could never be
satisfied either. Both are now relative measures.

**5. The spatial field encoded the node layout, not the occupant.** Fusion
combined a per-node scalar `belief` with a Gaussian coverage weight — but
`belief` was constant across the grid, so the fused value at every cell was a
weighted average of constants, maximised wherever the highest-belief node
dominated the weighting. That is, at that node. A subject at (0, 0) was
reported at (−2.76, −1.56): 3.2 m out in a 6 m room, and the reported x was
always within 0.2 m of a node's, whatever the person did. Adding nodes bought
no localisation at all. Every one of the 29 tests passed throughout, because
none of them ever compared a reported position against the truth. Replaced
with range-based multilateration against an explicit path-loss model, and
regression-tested against ground truth.

**6. Presence fired on noise in an empty room.** The breathing path's
debounce counted 25 consecutive frames, but consecutive frames are not
independent evidence: band power is computed over a sliding 12.8 s window, so
a single noise excursion holds the ratio elevated for the whole 12.8 s the
window takes to slide past it. 25 frames is 1.25 s — a tenth of one window.
Presence fired on 30% of ticks with nobody in the room. The debounce now
integrates over longer than a window, and the clearing path — which had the
same bug at 0.6 s, and made presence flap over a motionless subject — was
given the same treatment.

**7. The vitals reading teleported between nodes.** The room-level figure was
the single most confident node's, chosen fresh every tick. The nodes disagree
by up to 14 BPM on the same subject, and their confidences are noisy and
frequently tied at the ceiling, so the argmax switched winner every few ticks
and the published number jumped — 13.4 BPM in a single tick was routine, none
of it the subject's breathing changing. Replaced with a confidence-weighted
consensus whose confidence falls when the nodes disagree, smoothed across
ticks.

**9. A stale reading faded on frame count, not on time.** The confidence
decay was a fixed factor applied once per CSI frame. At 20 Hz that is a 0.7 s
time constant on a value estimated from a 12.8 s window, so about three
seconds without a confident autocorrelation peak blanked the display for a
subject who was breathing steadily throughout — live, it went empty for over
a minute at a stretch. It was also frame-rate dependent, decaying four times
faster on an 80 Hz node than a 20 Hz one. Now a half-life in seconds.
Together with bug 7 this took the worst single-tick jump from 13.4 BPM to
0.7 BPM while *increasing* how often a reading is available.

**10. The payload contradicted itself about occupancy.** Posture came from
the geometrically nearest node whether or not that node detected anything, so
a tracked person beside a quiet node was labelled `absent` — the dashboard
displayed "PRESENCE YES / PEOPLE 1 / POSTURE Absent" at once. Posture is now
taken from the nearest node that is actually detecting, and reports `unknown`
rather than `absent` when a track is coasting.

**8. The coupling baseline was learned after calibration, not during it.**
The zero-point for the field's only range observable was skipped by the
calibration branch and primed from the first frame afterwards, then nudged
whenever presence happened to be off. Its value therefore depended on
presence *history*: tightening the presence debounce moved a subject's
reported position by 2 m without touching a line of field code. It is now
learned during calibration, when the room is guaranteed empty, and only
drift-corrected afterwards.

The firmware carries the same DSP fixes — `main/dsp.c` and
`server/dsp/filters.js` implement the same algorithms and must be changed
together. Bugs 5–8 are server-side only.

---
