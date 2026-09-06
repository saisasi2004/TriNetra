#include "edge_processing.h"

#include <math.h>
#include <string.h>

#include "esp_log.h"

#include "dsp.h"

static const char *TAG = "tn_edge";

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

/* ── Tunables ─────────────────────────────────────────────────────────────
 * These are the numbers you will actually adjust for a given room. They are
 * deliberately gathered here rather than scattered through the code. */

#define BREATHING_MIN_HZ   0.10f   /*  6 BPM */
#define BREATHING_MAX_HZ   0.50f   /* 30 BPM */
#define HEART_MIN_HZ       0.67f   /* 40 BPM */
#define HEART_MAX_HZ       2.00f   /* 120 BPM */

#define BREATHING_MIN_BPM  6.0f
#define BREATHING_MAX_BPM  30.0f
#define HEART_MIN_BPM      40.0f
#define HEART_MAX_BPM      120.0f

/* Presence: motion energy must exceed baseline by this ratio. */
#define PRESENCE_ON_RATIO   2.4f
#define PRESENCE_OFF_RATIO  1.5f   /* hysteresis — prevents flapping */
#define PRESENCE_DEBOUNCE   4      /* consecutive frames before a transition */

/* Motion classification thresholds on normalised motion energy. */
#define MOTION_STILL_MAX    0.08f
#define MOTION_ACTIVE_MIN   0.28f

/* Frames a new posture must persist before it is adopted. At 20 Hz this is
 * ~0.75 s, far below any real posture change and far above the noise that
 * makes the raw classification flicker. */
#define POSTURE_DWELL_FRAMES 15

/* Fall: a fall is a large phase acceleration followed by stillness. */
#define FALL_ACCEL_SIGMA    6.0f   /* sigmas above the running phase-accel sd */
#define FALL_CONFIRM_FRAMES 3
#define FALL_STILLNESS_MS   1200   /* must go still within this window */
#define FALL_COOLDOWN_MS    5000

/* Baseline adaptation. Slow enough that a person sitting still for a minute
 * is not absorbed into "empty room", fast enough to track thermal drift. */
#define BASELINE_ALPHA      0.0025f
#define MOTION_EMA_ALPHA    0.18f

/* Apnea: no breathing detected for this long while presence holds. */
#define APNEA_SILENCE_MS    12000

/* ── State ────────────────────────────────────────────────────────────── */

typedef struct {
    float    ring[TN_EDGE_HISTORY];
    uint16_t head;
    uint16_t count;
} ring_t;

static void ring_push(ring_t *r, float v)
{
    r->ring[r->head] = v;
    r->head = (uint16_t)((r->head + 1) % TN_EDGE_HISTORY);
    if (r->count < TN_EDGE_HISTORY) r->count++;
}

/** Copy the ring into a linear, chronologically-ordered buffer. */
static uint16_t ring_linear(const ring_t *r, float *out)
{
    const uint16_t n = r->count;
    const uint16_t start = (uint16_t)((r->head + TN_EDGE_HISTORY - n) % TN_EDGE_HISTORY);
    for (uint16_t i = 0; i < n; ++i) {
        out[i] = r->ring[(start + i) % TN_EDGE_HISTORY];
    }
    return n;
}

static tn_edge_state_t s_state;

static ring_t s_phase_hist;      /* sensitive-subcarrier phase, sanitized */
static ring_t s_amp_hist;        /* mean amplitude */
static ring_t s_motion_hist;     /* per-frame motion metric */

static float  s_prev_amp[TN_MAX_SUBCARRIERS];
static bool   s_have_prev;

static tn_ema_t s_motion_ema;
static tn_ema_t s_baseline_ema;   /* slow ambient motion baseline */
static tn_ema_t s_rssi_ema;

static tn_median_ring_t s_br_med;
static tn_median_ring_t s_hr_med;
static tn_ema_t         s_br_ema;
static tn_ema_t         s_hr_ema;

static uint16_t s_presence_on_count;
static uint16_t s_presence_off_count;
static uint16_t s_posture_dwell;     /* frames a candidate posture has held */

static float    s_accel_mean, s_accel_var;   /* Welford running stats */
static uint32_t s_accel_n;
static uint16_t s_fall_candidate;
static uint32_t s_fall_candidate_ms;
static uint32_t s_fall_cooldown_until;

static uint32_t s_last_breath_ms;
static uint32_t s_calib_frames_left;
static float    s_calib_seconds;

static float    s_prev_phase_mean;
static float    s_prev_phase_delta;

/* Scratch — static so we never touch the heap in the hot path. */
static float s_lin[TN_EDGE_HISTORY];
static float s_filt[TN_EDGE_HISTORY];
static float s_work[TN_MAX_SUBCARRIERS];
static float s_phase_work[TN_MAX_SUBCARRIERS];

/* ── Helpers ──────────────────────────────────────────────────────────── */

static float clamp01(float v)
{
    if (v < 0.0f) return 0.0f;
    if (v > 1.0f) return 1.0f;
    return v;
}

/**
 * Pick the subcarrier whose amplitude varies most over recent history.
 *
 * Not all subcarriers see the body. In a typical room only a handful carry
 * a strong body-reflected path; the rest are dominated by the static
 * line-of-sight component and contribute noise. Selecting the most
 * responsive one is worth more than any amount of filtering applied to a
 * blind average.
 */
static uint16_t select_sensitive_subcarrier(const tn_csi_frame_t *f)
{
    if (!s_have_prev) return (uint16_t)(f->n_subcarriers / 2);

    uint16_t best = (uint16_t)(f->n_subcarriers / 2);
    float    best_d = -1.0f;
    for (uint16_t i = 0; i < f->n_subcarriers; ++i) {
        const float d = fabsf(f->amplitude[i] - s_prev_amp[i]);
        if (d > best_d) { best_d = d; best = i; }
    }
    return best;
}

/* ── Public API ───────────────────────────────────────────────────────── */

void tn_edge_init(float calib_seconds)
{
    memset(&s_state, 0, sizeof(s_state));
    memset(&s_phase_hist, 0, sizeof(s_phase_hist));
    memset(&s_amp_hist, 0, sizeof(s_amp_hist));
    memset(&s_motion_hist, 0, sizeof(s_motion_hist));
    s_have_prev = false;

    tn_ema_init(&s_motion_ema,   MOTION_EMA_ALPHA);
    tn_ema_init(&s_baseline_ema, BASELINE_ALPHA);
    tn_ema_init(&s_rssi_ema,     0.05f);
    tn_ema_init(&s_br_ema,       0.10f);
    tn_ema_init(&s_hr_ema,       0.08f);
    tn_median_ring_init(&s_br_med, 9);
    tn_median_ring_init(&s_hr_med, 11);

    s_presence_on_count  = 0;
    s_presence_off_count = 0;
    s_posture_dwell = 0;
    s_accel_mean = 0.0f; s_accel_var = 0.0f; s_accel_n = 0;
    s_fall_candidate = 0; s_fall_candidate_ms = 0; s_fall_cooldown_until = 0;
    s_last_breath_ms = 0;
    s_prev_phase_mean = 0.0f;
    s_prev_phase_delta = 0.0f;

    s_calib_seconds     = calib_seconds;
    s_calib_frames_left = (uint32_t)(calib_seconds * 20.0f);  /* assume ~20 Hz */
    s_state.calibrating = true;
    s_state.posture     = TN_POSTURE_UNKNOWN;

    ESP_LOGI(TAG, "edge init, calibrating for %.0f s", (double)calib_seconds);
}

void tn_edge_recalibrate(void)
{
    tn_edge_init(s_calib_seconds);
}

const tn_edge_state_t *tn_edge_state(void) { return &s_state; }

const tn_edge_state_t *tn_edge_process(const tn_csi_frame_t *frame,
                                       tn_edge_event_t *out_event)
{
    if (out_event) memset(out_event, 0, sizeof(*out_event));
    if (frame == NULL || frame->n_subcarriers == 0) return &s_state;

    const uint16_t N  = frame->n_subcarriers;
    const uint32_t ts = frame->timestamp_ms;

    /* Sample rate: measured, never assumed. Falls back to 20 Hz until the
     * collector has enough samples to estimate it. */
    float fs = s_state.sample_rate_hz;
    if (fs < 1.0f) fs = 20.0f;

    /* ── 1. Clean the amplitude vector ───────────────────────────────── */
    memcpy(s_work, frame->amplitude, sizeof(float) * N);
    tn_hampel(s_work, N, 2, 3.0f);

    const float amp_mean = tn_mean(s_work, N);
    const float amp_var  = tn_variance(s_work, N);

    /* ── 2. Sanitize phase (remove STO/CFO ramp) ─────────────────────── */
    memcpy(s_phase_work, frame->phase, sizeof(float) * N);
    tn_phase_sanitize(s_phase_work, N);

    const uint16_t sc = select_sensitive_subcarrier(frame);
    const float phase_sample = s_phase_work[sc < N ? sc : 0];

    /* ── 3. Per-frame motion metric ──────────────────────────────────────
     * Sum of absolute amplitude change across subcarriers, normalised by
     * the mean amplitude so it does not scale with link strength. A person
     * walking past changes many subcarriers at once; thermal noise does
     * not. */
    float motion_raw = 0.0f;
    if (s_have_prev) {
        for (uint16_t i = 0; i < N; ++i) {
            motion_raw += fabsf(s_work[i] - s_prev_amp[i]);
        }
        motion_raw /= ((float)N * (amp_mean > 1e-3f ? amp_mean : 1.0f));
    }
    memcpy(s_prev_amp, s_work, sizeof(float) * N);
    s_have_prev = true;

    const float motion_s = tn_ema_update(&s_motion_ema, motion_raw);

    ring_push(&s_phase_hist,  phase_sample);
    ring_push(&s_amp_hist,    amp_mean);
    ring_push(&s_motion_hist, motion_s);

    /* ── 4. Calibration ──────────────────────────────────────────────── */
    if (s_calib_frames_left > 0) {
        s_calib_frames_left--;
        tn_ema_update(&s_baseline_ema, motion_raw);
        tn_ema_update(&s_rssi_ema, (float)frame->rssi);
        s_state.calibrating     = true;
        s_state.calib_remaining = s_calib_frames_left;
        s_state.frames_processed++;
        s_state.sample_rate_hz  = fs;
        if (s_calib_frames_left == 0) {
            s_state.calibrating = false;
            ESP_LOGI(TAG, "calibration complete, baseline=%.5f",
                     (double)s_baseline_ema.value);
            if (out_event) {
                out_event->type       = TN_EVENT_CALIB_DONE;
                out_event->severity   = 0;
                out_event->confidence = 1.0f;
                out_event->value      = s_baseline_ema.value;
            }
        }
        return &s_state;
    }

    /* Baseline only adapts while nobody is detected — otherwise a person
     * sitting still is slowly absorbed into "empty room" and vanishes. */
    if (!s_state.presence) {
        tn_ema_update(&s_baseline_ema, motion_raw);
    }
    tn_ema_update(&s_rssi_ema, (float)frame->rssi);

    const float baseline = (s_baseline_ema.value > 1e-6f) ? s_baseline_ema.value : 1e-6f;
    const float ratio    = motion_s / baseline;

    /* ── 5. Presence with hysteresis + debounce ──────────────────────── */
    if (!s_state.presence) {
        if (ratio > PRESENCE_ON_RATIO) {
            if (++s_presence_on_count >= PRESENCE_DEBOUNCE) {
                s_state.presence = true;
                s_presence_on_count = 0;
                if (out_event && out_event->type == 0) {
                    out_event->type       = TN_EVENT_PRESENCE_ON;
                    out_event->confidence = clamp01(ratio / (PRESENCE_ON_RATIO * 2.0f));
                    out_event->value      = ratio;
                }
            }
        } else {
            s_presence_on_count = 0;
        }
    } else {
        if (ratio < PRESENCE_OFF_RATIO) {
            if (++s_presence_off_count >= PRESENCE_DEBOUNCE * 3) {
                s_state.presence = false;
                s_presence_off_count = 0;
                if (out_event && out_event->type == 0) {
                    out_event->type       = TN_EVENT_PRESENCE_OFF;
                    out_event->confidence = 0.8f;
                    out_event->value      = ratio;
                }
            }
        } else {
            s_presence_off_count = 0;
        }
    }

    const float motion_energy = clamp01(ratio / (PRESENCE_ON_RATIO * 3.0f));
    s_state.motion_energy  = motion_energy;
    s_state.presence_score = clamp01((ratio - PRESENCE_OFF_RATIO) /
                                     (PRESENCE_ON_RATIO * 2.0f));
    s_state.motion    = motion_energy > MOTION_STILL_MAX;
    s_state.variance  = amp_var;

    /* ── 6. Vital signs from the phase history ───────────────────────── */
    const uint16_t hn = ring_linear(&s_phase_hist, s_lin);

    float br = 0.0f, hr = 0.0f, br_conf = 0.0f, hr_conf = 0.0f;

    /* Vitals are the most expensive thing this firmware does, by a wide
     * margin, and until now they ran on EVERY frame.
     *
     * tn_bpm_autocorr is O(lags * window): with a 256-sample window and
     * lags out to n/2 that is ~33k multiply-accumulates per call, and it is
     * called twice (breathing, then heart rate after notching).
     *
     * On the original ESP32 that is affordable because the Xtensa LX6 has a
     * single-precision FPU. The ESP32-C6 does NOT — it is rv32imac, with no
     * `f` extension, so every one of those operations is a call into the
     * soft-float ROM routines (this is why the watchdog backtrace pointed at
     * __call__rvfp__addsf3). Roughly two orders of magnitude slower, on one
     * core at 160 MHz instead of two at 240 MHz.
     *
     * The result was the sensing task never yielding: IDLE starved, the task
     * watchdog fired, and the CSI queue overflowed so badly that the
     * effective frame rate collapsed to ~5 Hz.
     *
     * Recomputing a 0.1-0.5 Hz estimate 20 times a second was never useful
     * anyway — the underlying quantity cannot change that fast, and the
     * result is median-filtered and EMA-smoothed immediately afterwards. Once
     * a second is ample, and costs 1/20th the CPU. The values persist in
     * s_state between evaluations, so nothing downstream sees a gap. */
    static uint32_t s_vitals_countdown = 0;
    const uint16_t vitals_every = (uint16_t)(fs > 1.0f ? fs : 1.0f);
    const bool eval_vitals = (s_vitals_countdown == 0);
    s_vitals_countdown = eval_vitals ? vitals_every : (s_vitals_countdown - 1);

    if (eval_vitals && hn >= (uint16_t)(fs * 8.0f)) {   /* need >= 8 s of history */
        tn_hampel(s_lin, hn, 3, 3.0f);

        /* Breathing: bandpass then autocorrelation. Autocorrelation rather
         * than raw zero-crossing because the phase signal is not clean
         * enough for crossings to be reliable under any motion at all. */
        static tn_biquad_t bq_br;
        tn_biquad_bandpass(&bq_br, fs, BREATHING_MIN_HZ, BREATHING_MAX_HZ);
        tn_biquad_run(&bq_br, s_lin, s_filt, hn);

        br = tn_bpm_autocorr(s_filt, hn, fs,
                             BREATHING_MIN_BPM, BREATHING_MAX_BPM,
                             0.0f, 0.0f, &br_conf);

        /* Heart rate. Order matters: notch out breathing and its harmonics
         * FIRST, then bandpass to the cardiac range, then autocorrelate
         * with lag rejection as a final backstop.
         *
         * A 0.25 Hz breathing fundamental puts its 3rd harmonic at 0.75 Hz
         * = 45 BPM, indistinguishable from a resting heart rate and several
         * times stronger than the real cardiac signal. Rejecting those lags
         * alone does not work — the harmonic still dominates the whole
         * correlation and no genuine cardiac peak forms. It has to be
         * removed from the signal. */
        if (br > 1.0f && br_conf > 0.10f) {
            const float br_hz = br / 60.0f;

            memcpy(s_filt, s_lin, sizeof(float) * hn);
            tn_notch_harmonics(s_filt, hn, fs, br_hz, 4, 10.0f);

            static tn_biquad_t bq_hr;
            tn_biquad_bandpass(&bq_hr, fs, HEART_MIN_HZ, HEART_MAX_HZ);
            tn_biquad_run(&bq_hr, s_filt, s_filt, hn);

            hr = tn_bpm_autocorr(s_filt, hn, fs,
                                 HEART_MIN_BPM, HEART_MAX_BPM,
                                 br_hz, 0.06f, &hr_conf);
        }
    }

    /* Gate on stillness: a walking person's chest displacement is buried
     * under whole-body motion. Reporting a breathing rate while someone
     * strides across the room is fabrication, so we suppress it. */
    const bool still_enough = motion_energy < MOTION_ACTIVE_MIN;

    /* Only touch the vitals state on an evaluation frame. The decay branches
     * below are per-EVALUATION, not per-frame: applying 0.93 on every frame
     * while only computing a new estimate once a second would drive
     * confidence to zero between evaluations and vitals would never latch. */
    if (eval_vitals) {
        if (br > 0.0f && br_conf > 0.12f && still_enough && s_state.presence) {
            const float med = tn_median_ring_push(&s_br_med, br);
            s_state.breathing_bpm  = tn_ema_update(&s_br_ema, med);
            s_state.breathing_conf = clamp01(br_conf * 2.2f);
            s_last_breath_ms       = ts;
        } else {
            s_state.breathing_conf *= 0.93f;
            if (s_state.breathing_conf < 0.05f) {
                s_state.breathing_bpm  = 0.0f;
                s_state.breathing_conf = 0.0f;
            }
        }

        if (hr > 0.0f && hr_conf > 0.15f && still_enough && s_state.presence) {
            const float med = tn_median_ring_push(&s_hr_med, hr);
            s_state.heart_bpm  = tn_ema_update(&s_hr_ema, med);
            s_state.heart_conf = clamp01(hr_conf * 2.0f);
        } else {
            s_state.heart_conf *= 0.93f;
            if (s_state.heart_conf < 0.05f) {
                s_state.heart_bpm  = 0.0f;
                s_state.heart_conf = 0.0f;
            }
        }
    }

    /* ── 7. Fall detection ───────────────────────────────────────────────
     * A fall is characterised by a large second derivative of phase (the
     * body accelerating downward) followed by unusual stillness. The
     * stillness confirmation is what separates a fall from someone
     * sitting down quickly or a door slamming. */
    const float phase_mean  = tn_mean(s_phase_work, N);
    const float phase_delta = phase_mean - s_prev_phase_mean;
    const float phase_accel = fabsf(phase_delta - s_prev_phase_delta);
    s_prev_phase_mean  = phase_mean;
    s_prev_phase_delta = phase_delta;
    s_state.phase_accel = phase_accel;

    /* Welford running mean/variance for an adaptive threshold. */
    s_accel_n++;
    const float d1 = phase_accel - s_accel_mean;
    s_accel_mean += d1 / (float)s_accel_n;
    s_accel_var  += d1 * (phase_accel - s_accel_mean);
    const float accel_sd = (s_accel_n > 1)
                         ? sqrtf(s_accel_var / (float)(s_accel_n - 1))
                         : 0.0f;

    s_state.fall = false;
    if (ts > s_fall_cooldown_until && s_accel_n > 100 && accel_sd > 1e-6f) {
        const float z = (phase_accel - s_accel_mean) / accel_sd;

        if (z > FALL_ACCEL_SIGMA && s_state.presence) {
            if (s_fall_candidate == 0) s_fall_candidate_ms = ts;
            s_fall_candidate++;
        } else if (s_fall_candidate > 0) {
            const bool in_window = (ts - s_fall_candidate_ms) < FALL_STILLNESS_MS;
            if (s_fall_candidate >= FALL_CONFIRM_FRAMES && in_window &&
                motion_energy < MOTION_STILL_MAX) {
                /* Impact confirmed AND the subject has gone still. */
                s_state.fall          = true;
                s_fall_cooldown_until = ts + FALL_COOLDOWN_MS;
                s_fall_candidate      = 0;
                ESP_LOGW(TAG, "FALL detected (z=%.1f)", (double)z);
                if (out_event) {
                    out_event->type       = TN_EVENT_FALL;
                    out_event->severity   = 2;
                    out_event->confidence = clamp01(z / (FALL_ACCEL_SIGMA * 2.0f));
                    out_event->value      = z;
                }
            } else if (!in_window) {
                s_fall_candidate = 0;
            }
        }
    }

    /* ── 8. Posture ──────────────────────────────────────────────────────
     *
     * Coarse and honest: four buckets derived from motion energy and
     * breathing character. This is NOT skeletal pose. A single antenna with
     * one spatial channel cannot resolve limbs, and no amount of processing
     * downstream creates spatial information the radio never captured — see
     * the note at the top of this file.
     *
     * SCHMITT-TRIGGERED. The raw thresholds are crossed constantly by a
     * subject who is not actually changing posture: motion energy is a noisy
     * estimate, so a person sitting at motion 0.08 flips between SITTING and
     * STANDING several times a second, and the label is unusable even though
     * every individual decision was defensible. Requiring a margin to enter
     * a state, and a dwell before leaving one, costs nothing — nobody needs
     * sub-second latency on "are they sitting or standing" — and turns a
     * flickering readout into a stable one. */
    uint8_t want;
    if (!s_state.presence) {
        want = TN_POSTURE_ABSENT;
    } else if (motion_energy > MOTION_ACTIVE_MIN) {
        want = TN_POSTURE_WALKING;
    } else if (motion_energy > MOTION_STILL_MAX) {
        want = TN_POSTURE_STANDING;
    } else if (s_state.breathing_conf > 0.3f && s_state.breathing_bpm < 16.0f) {
        /* Slow, very regular breathing with near-zero motion reads as
         * recumbent — the signature of someone asleep or lying down. */
        want = TN_POSTURE_LYING;
    } else {
        want = TN_POSTURE_SITTING;
    }

    if (want == s_state.posture) {
        s_posture_dwell = 0;
    } else {
        /* Leaving ABSENT, or entering it, should be as quick as presence
         * itself — that transition is already debounced upstream and
         * double-debouncing it just adds lag to the one case that matters.
         * Everything else has to hold. */
        const uint16_t needed =
            (want == TN_POSTURE_ABSENT || s_state.posture == TN_POSTURE_ABSENT)
                ? 0 : POSTURE_DWELL_FRAMES;

        if (++s_posture_dwell >= needed) {
            s_state.posture = want;
            s_posture_dwell = 0;
        }
    }

    /* ── 9. Coarse person count ──────────────────────────────────────────
     * A single antenna genuinely cannot separate people. This is a motion-
     * energy bucket, reported as an estimate and nothing more. The server
     * refines it using multiple nodes, where it is actually tractable. */
    if (!s_state.presence)                 s_state.n_persons = 0;
    else if (motion_energy < 0.35f)        s_state.n_persons = 1;
    else if (motion_energy < 0.65f)        s_state.n_persons = 2;
    else                                   s_state.n_persons = 3;

    /* ── 10. Signal quality ──────────────────────────────────────────────
     * Combines link strength and phase coherence. Low quality invalidates
     * everything above, so it travels with the data rather than being
     * inferred later. */
    const float rssi_q  = clamp01(((float)frame->rssi + 90.0f) / 40.0f);
    const float coher   = 1.0f - tn_circular_variance(frame->phase, N);
    const float snr_q   = clamp01(((float)(frame->rssi - frame->noise_floor)) / 45.0f);
    s_state.signal_quality = clamp01(0.4f * rssi_q + 0.35f * coher + 0.25f * snr_q);

    /* ── 11. Apnea watch ─────────────────────────────────────────────── */
    if (out_event && out_event->type == 0 &&
        s_state.presence && s_state.posture == TN_POSTURE_LYING &&
        s_last_breath_ms > 0 && (ts - s_last_breath_ms) > APNEA_SILENCE_MS) {
        out_event->type       = TN_EVENT_APNEA;
        out_event->severity   = 2;
        out_event->confidence = 0.6f;
        out_event->value      = (float)(ts - s_last_breath_ms) / 1000.0f;
        s_last_breath_ms      = ts;   /* re-arm so we do not spam */
    }

    s_state.frames_processed++;
    s_state.sample_rate_hz = fs;
    return &s_state;
}

void tn_edge_fill_vitals(tn_vitals_packet_t *pkt, uint8_t node_id)
{
    if (pkt == NULL) return;
    memset(pkt, 0, sizeof(*pkt));

    pkt->magic   = TN_MAGIC_VITALS;
    pkt->version = TN_PROTOCOL_VERSION;
    pkt->node_id = node_id;

    uint8_t flags = 0;
    if (s_state.presence)    flags |= TN_FLAG_PRESENCE;
    if (s_state.fall)        flags |= TN_FLAG_FALL;
    if (s_state.motion)      flags |= TN_FLAG_MOTION;
    if (s_state.calibrating) flags |= TN_FLAG_CALIBRATING;
    if (s_state.signal_quality < 0.25f) flags |= TN_FLAG_LOW_QUALITY;
    pkt->flags = flags;

    pkt->n_persons          = s_state.n_persons;
    pkt->breathing_bpm_x100 = (uint16_t)(s_state.breathing_bpm * 100.0f);
    pkt->heart_bpm_x100     = (uint16_t)(s_state.heart_bpm * 100.0f);
    pkt->motion_energy      = s_state.motion_energy;
    pkt->presence_score     = s_state.presence_score;
    pkt->breathing_conf     = s_state.breathing_conf;
    pkt->heart_conf         = s_state.heart_conf;
    pkt->signal_quality     = s_state.signal_quality;
    pkt->rssi               = (int8_t)s_rssi_ema.value;
    pkt->posture            = s_state.posture;
    pkt->timestamp_ms       = (uint32_t)(s_state.frames_processed);
}
