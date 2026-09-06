/**
 * HUD controller — every DOM readout in the Observatory.
 *
 * Numbers are eased toward their targets rather than snapped, because a
 * heart-rate figure that flickers between 68 and 71 every 100 ms is
 * unreadable even when both values are correct.
 */

import { fmt, lerp } from '../lib/client.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      sourceDot: $('source-dot'),
      sourceLabel: $('source-label'),
      scenarioSelect: $('scenario-select'),
      optScenario: $('opt-scenario'),

      hrValue: $('hr-value'), hrBar: $('hr-bar'),
      brValue: $('br-value'), brBar: $('br-bar'),
      confValue: $('conf-value'), confBar: $('conf-bar'),
      vitalsQuality: $('vitals-quality'),

      rssi: $('rssi-value'), variance: $('var-value'), motion: $('motion-value'),
      freq: $('freq-value'), persons: $('persons-value'), personDots: $('person-dots'),
      signalVerdict: $('signal-verdict'),

      presenceState: $('presence-state'), presenceReason: $('presence-reason'),
      statesList: $('states-list'), statesCount: $('states-count'),
      alertBanner: $('alert-banner'),
      nodeStrip: $('node-strip'),

      qualityFlag: $('quality-flag'), qualityDetail: $('quality-detail'),
      qualityRight: $('quality-right'),

      capPresence: $('cap-presence'), capVitals: $('cap-vitals'),
      capTracking: $('cap-tracking'), capFall: $('cap-fall'),

      wsStatus: $('ws-status'), wsTick: $('ws-tick'),
      wsLatency: $('ws-latency'), wsNodes: $('ws-nodes'),

      sparkline: $('sparkline'),
    };

    // Eased display values.
    this.display = { hr: 0, br: 0, conf: 0, rssi: -70, motion: 0 };
    this.rssiHistory = [];
    this.alertTimer = null;

    this.#initSparkline();
  }

  #initSparkline() {
    const c = this.el.sparkline;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const resize = () => {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, r.width * dpr);
      c.height = Math.max(1, r.height * dpr);
    };
    resize();
    window.addEventListener('resize', resize);
    this.sparkCtx = c.getContext('2d');
    this.sparkDpr = dpr;
  }

  /** Called every animation frame — eases values toward their targets. */
  tick(dt) {
    const k = Math.min(1, dt * 5);
    const u = this.lastUpdate;
    if (!u) return;

    const v = u.vital_signs ?? {};
    const targetHr = v.heart_rate_bpm ?? 0;
    const targetBr = v.breathing_rate_bpm ?? 0;
    const targetConf = Math.max(v.breathing_confidence ?? 0, v.heartbeat_confidence ?? 0);

    this.display.hr = lerp(this.display.hr, targetHr, k);
    this.display.br = lerp(this.display.br, targetBr, k);
    this.display.conf = lerp(this.display.conf, targetConf, k);

    const hasHr = targetHr > 0;
    const hasBr = targetBr > 0;

    this.#setVital(this.el.hrValue, this.el.hrBar, hasHr,
      this.display.hr, 'BPM', (this.display.hr - 40) / 90);
    this.#setVital(this.el.brValue, this.el.brBar, hasBr,
      this.display.br, 'RPM', (this.display.br - 5) / 30);
    this.#setVital(this.el.confValue, this.el.confBar, targetConf > 0.02,
      this.display.conf * 100, '%', this.display.conf, 0);

    this.#drawSparkline();
  }

  #setVital(valueEl, barEl, has, value, unit, fill, decimals = 1) {
    if (!valueEl) return;
    valueEl.classList.toggle('stale', !has);
    valueEl.innerHTML = has
      ? `${value.toFixed(decimals)}<span class="unit">${unit}</span>`
      : `--<span class="unit">${unit}</span>`;
    if (barEl) {
      barEl.style.width = has ? `${Math.max(0, Math.min(1, fill)) * 100}%` : '0%';
    }
  }

  #drawSparkline() {
    const ctx = this.sparkCtx;
    if (!ctx) return;

    const c = this.el.sparkline;
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    const data = this.rssiHistory;
    if (data.length < 2) return;

    const min = Math.min(...data) - 1;
    const max = Math.max(...data) + 1;
    const span = Math.max(1, max - min);

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((data[i] - min) / span) * h * 0.85 - h * 0.08;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }

    ctx.strokeStyle = 'rgba(0, 216, 120, 0.85)';
    ctx.lineWidth = 1.5 * this.sparkDpr;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Fill under the curve.
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0, 216, 120, 0.22)');
    grad.addColorStop(1, 'rgba(0, 216, 120, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  /** Called on each sensing update. */
  update(u) {
    this.lastUpdate = u;

    // ── Source / provenance ──
    const src = u.source ?? 'offline';
    this.el.sourceDot.className = `dot dot--${src === 'live' ? 'live' : src === 'simulated' ? 'simulated' : 'offline'}`;
    this.el.sourceLabel.textContent = src.toUpperCase();

    const q = u.data_quality ?? 'NO_DATA';
    const flagClass = q === 'MEASURED' ? 'measured' : q === 'SIMULATED' ? 'simulated' : 'nodata';
    this.el.qualityFlag.className = `flag flag--${flagClass}`;
    this.el.qualityFlag.textContent = q.replace('_', ' ');

    this.el.qualityDetail.textContent = [
      `${u.nodes_online}/${u.node_count} nodes`,
      u.calibrating ? 'CALIBRATING' : null,
      `count: ${(u.count_method ?? '').replace(/-/g, ' ')}`,
      `pose: ${u.pose_source}`,
    ].filter(Boolean).join('  ·  ');

    this.el.qualityRight.textContent =
      `signal ${Math.round((u.signal_quality_score ?? 0) * 100)}%  ·  ${u.quality_verdict ?? ''}`;

    // ── Signal panel ──
    const f = u.features ?? {};
    this.el.rssi.textContent = fmt.dbm(f.mean_rssi);
    this.el.variance.textContent = fmt.num(f.variance, 3);
    this.el.freq.textContent = fmt.hz(f.dominant_freq_hz);

    const motionPct = Math.round(
      (u.nodes.reduce((m, n) => Math.max(m, n.motion_energy ?? 0), 0)) * 100,
    );
    this.el.motion.textContent = `${motionPct}%`;
    this.el.signalVerdict.textContent = u.quality_verdict ?? '';

    if (f.mean_rssi) {
      this.rssiHistory.push(f.mean_rssi);
      if (this.rssiHistory.length > 90) this.rssiHistory.shift();
    }

    // ── Presence ──
    const present = u.classification?.presence ?? false;
    this.el.presenceState.className =
      `presence-state presence--${present ? 'present' : 'absent'}`;
    this.el.presenceState.textContent = u.calibrating
      ? 'CALIBRATING'
      : present ? 'PRESENT' : 'ABSENT';

    const reasons = [...new Set(
      u.nodes.filter((n) => n.presence).map((n) => n.presence_reason),
    )].filter((r) => r && r !== 'none');
    this.el.presenceReason.textContent = reasons.length ? `via ${reasons.join(', ')}` : '';

    // ── Persons ──
    const n = u.estimated_persons ?? 0;
    this.el.persons.textContent = String(n);
    this.el.personDots.innerHTML = '<i></i>'.repeat(Math.min(n, 8));

    // ── Capabilities ──
    this.#setCap(this.el.capPresence, present);
    this.#setCap(this.el.capVitals, (u.vital_signs?.breathing_rate_bpm ?? 0) > 0);
    this.#setCap(this.el.capTracking, n > 0);
    this.#setCap(this.el.capFall, u.fall_detected);

    // ── Node chips ──
    this.el.nodeStrip.innerHTML = u.nodes.map((node) => {
      const cls = !node.online ? '' : node.calibrating ? 'calibrating'
        : node.presence ? 'present' : 'online';
      const detail = node.calibrating
        ? `cal ${Math.ceil(node.calibration_remaining / 20)}s`
        : `${Math.round((node.motion_energy ?? 0) * 100)}%`;
      return `<div class="node-chip ${cls}" title="${node.room ?? ''} · ${node.sample_rate_hz} Hz · q ${node.signal_quality}">N${node.node_id} ${detail}</div>`;
    }).join('');

    // ── Semantic states ──
    const active = (u.active_states ?? []).filter((s) => s.active);
    this.el.statesCount.textContent = active.length ? String(active.length) : '';
    this.el.statesList.innerHTML = active.length
      ? active.map((s) => `
        <div class="state">
          <span class="state-dot ${s.severity}"></span>
          <span class="state-text">
            <span class="state-label">${s.label}</span>
            <span class="state-evidence">${s.evidence}</span>
          </span>
          <span class="state-time">${fmt.duration(s.duration_s)}</span>
        </div>`).join('')
      : '<div class="states-empty">Nothing detected</div>';

    // ── Connection block ──
    this.el.wsTick.textContent = String(u.tick ?? '-');
    this.el.wsNodes.textContent = `${u.nodes_online}/${u.node_count}`;

    if (u.fall_detected) this.showAlert('FALL DETECTED');
  }

  /**
   * Swap the Boxicons class rather than rewriting textContent.
   *
   * The previous version substituted one Unicode glyph for another inside
   * the label text, which meant the icon lived in the string — and any tool
   * that mangled the file's encoding turned it into mojibake. Icon state as
   * a CSS class is pure ASCII and cannot be corrupted that way.
   */
  #setCap(el, on) {
    if (!el) return;
    el.classList.toggle('on', !!on);
    const icon = el.querySelector('i');
    if (icon) icon.className = on ? 'bx bxs-circle' : 'bx bx-radio-circle';
  }

  showAlert(text, ms = 6000) {
    const el = this.el.alertBanner;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.alertTimer);
    this.alertTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  setConnection(state, latency) {
    this.el.wsStatus.textContent = state;
    this.el.wsLatency.textContent = latency != null ? `${latency} ms` : '-';
    if (state !== 'connected') {
      this.el.sourceDot.className = 'dot dot--offline';
      this.el.sourceLabel.textContent = state.toUpperCase();
    }
  }

  /** Populate both scenario pickers from the server catalogue. */
  setScenarios(catalog, current) {
    const html = ['<option value="auto">Auto-Cycle</option>']
      .concat(catalog.map((g) => `
        <optgroup label="${g.group}">
          ${g.items.map((i) => `<option value="${i.id}">${i.label}</option>`).join('')}
        </optgroup>`))
      .join('');

    for (const sel of [this.el.scenarioSelect, this.el.optScenario]) {
      if (!sel) continue;
      sel.innerHTML = html;
      sel.value = current ?? 'auto';
    }
  }

  setScenarioValue(id) {
    for (const sel of [this.el.scenarioSelect, this.el.optScenario]) {
      if (sel && sel.value !== id) sel.value = id;
    }
  }
}
