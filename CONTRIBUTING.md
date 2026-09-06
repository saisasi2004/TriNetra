# Contributing to TriNetra

Thanks for taking an interest. This document is short because most of what
matters is one idea.

## The one rule

**Never let the system report something it did not measure.**

Every part of this codebase is built around that. Vitals are suppressed
rather than estimated while someone moves. Person counts undercount rather
than invent. Positions carry an uncertainty and an evidence score. Payloads
say `SIMULATED` when they are simulated and `pose_source: "kinematic-model"`
when the skeleton is a model rather than an inference.

A plausible-looking wrong number is worse than a blank, because a blank is
obviously unusable and a wrong number gets trusted. If you are tempted to
fill a gap with a guess, report `null` instead.

## Before you open a PR

```bash
npm install
npm test          # 59 tests, ~3 minutes
```

All tests must pass. If you change behaviour, change or add the test that
pins it — and say in the PR *why* the old expectation was wrong.

### If you change the DSP

`firmware/trinetra-csi-node/main/dsp.c` and `server/dsp/filters.js`
implement the same algorithms and **must be changed together**. They drifted
once, and the firmware silently published rates the server would have
refused. `tests/firmware-parity.test.js` now enforces agreement; keep it
passing rather than relaxing it.

### If you change the sensing pipeline

Claims about accuracy need numbers behind them. The simulator models bodies
and radio physics, never outputs, so you can measure a change end to end:

```bash
node tests/harness.js single_breathing 90
node tests/harness.js fall_event 60
```

Quote the before/after in the PR. "Feels better" is not reviewable.

## Style

- Match the surrounding code. No new dependencies without a strong reason —
  the server runs on `express` and `ws` and nothing else.
- Comments explain **why**, especially where the obvious approach is wrong.
  Several comments in this codebase document a bug that produced convincing
  output for a long time; that context is the point, so do not trim it.
- No build step for the browser UI. It is vanilla JS on purpose.

## Reporting bugs

Include what you expected, what happened, and how to reproduce it. For
sensing behaviour, the scenario and seed make it reproducible:

```bash
node tests/harness.js sleep_monitoring 90
```

For hardware issues, a serial log from `idf.py monitor` is worth more than a
description — a board that flashes and then reboots is usually a runtime
panic with a backtrace waiting in that log.

## Security

Please do not open public issues for security problems. See
[SECURITY.md](SECURITY.md).
