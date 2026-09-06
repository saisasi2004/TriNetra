---
name: Bug report
about: Something behaves differently than documented
labels: bug
---

**What happened, and what did you expect instead?**

**Reproduce it**

For sensing behaviour, a scenario and seed make it reproducible:

```bash
node tests/harness.js single_breathing 90
```

For hardware, please attach a serial log from `idf.py monitor`. A board that
flashes and then reboots is usually a runtime panic, and the backtrace is in
that log.

**Setup**
- TriNetra version / commit:
- Node version (`node -v`):
- Running simulated or live?
- If live: how many nodes, which board, and where are they placed?
- Room size passed to `--room-size`:
