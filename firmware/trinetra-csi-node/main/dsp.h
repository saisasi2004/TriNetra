/**
 * TriNetra edge DSP primitives.
 *
 * Fixed-size, allocation-free, float32. Everything here runs in a normal
 * FreeRTOS task on the ESP32 — no ISR-unsafe calls, no malloc after init.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Biquad IIR (Direct Form II transposed) ──────────────────────────── */
typedef struct {
    float b0, b1, b2, a1, a2;
    float z1, z2;
} tn_biquad_t;

/** 2nd-order Butterworth bandpass. fs/f_lo/f_hi in Hz. */
void tn_biquad_bandpass(tn_biquad_t *bq, float fs, float f_lo, float f_hi);
/** 2nd-order Butterworth lowpass. */
void tn_biquad_lowpass(tn_biquad_t *bq, float fs, float fc);
/** 2nd-order Butterworth highpass. */
void tn_biquad_highpass(tn_biquad_t *bq, float fs, float fc);
/** Narrow band-stop at f0. Higher q = narrower notch. */
void tn_biquad_notch(tn_biquad_t *bq, float fs, float f0, float q);

/**
 * Remove a fundamental and its first `harmonics` multiples, in place.
 *
 * This is what makes contactless heart rate work. Breathing is 5-10x
 * stronger than the cardiac component and its 3rd harmonic lands inside
 * the heart-rate band — 0.25 Hz breathing puts energy at 0.75 Hz = 45 BPM,
 * larger than the heartbeat itself. Merely excluding those lags from the
 * autocorrelation search is not enough: the harmonic still dominates the
 * correlation everywhere and no genuine cardiac peak ever forms. The
 * interfering component must be filtered OUT, not searched around.
 */
void tn_notch_harmonics(float *x, uint16_t n, float fs, float f0,
                        uint8_t harmonics, float q);
void  tn_biquad_reset(tn_biquad_t *bq);
float tn_biquad_process(tn_biquad_t *bq, float x);
/** Filter a whole buffer out-of-place; state is reset first. */
void  tn_biquad_run(tn_biquad_t *bq, const float *in, float *out, uint16_t n);

/* ── Exponential moving average ──────────────────────────────────────── */
typedef struct {
    float value;
    float alpha;
    bool  primed;
} tn_ema_t;

void  tn_ema_init(tn_ema_t *e, float alpha);
float tn_ema_update(tn_ema_t *e, float x);

/* ── Hampel outlier filter (median + MAD) ────────────────────────────────
 * Replaces samples more than n_sigma robust-sigmas from the local median.
 * Operates in place over a window of `half`*2+1. This is the single most
 * important preprocessing step for ESP32 CSI: the radio occasionally
 * emits wild amplitude spikes on AGC changes that will otherwise
 * dominate every downstream variance metric. */
void tn_hampel(float *buf, uint16_t n, uint16_t half, float n_sigma);

/* ── Robust statistics ───────────────────────────────────────────────── */
float tn_mean(const float *x, uint16_t n);
float tn_variance(const float *x, uint16_t n);
float tn_stddev(const float *x, uint16_t n);
/** Destructive: partially sorts scratch. */
float tn_median(float *scratch, uint16_t n);
/** Band power between f_lo and f_hi via Goertzel bin sweep. */
float tn_band_power(const float *x, uint16_t n, float fs, float f_lo, float f_hi);

/* ── Phase handling ──────────────────────────────────────────────────────
 * Raw atan2 phase wraps at ±pi. Unwrapping in place is mandatory before
 * any temporal filtering, otherwise every wrap looks like a 2pi impulse. */
void tn_phase_unwrap(float *phase, uint16_t n);
/** Linear-fit removal of Sampling Time Offset / Carrier Frequency Offset
 * across the subcarrier axis. Removes the dominant hardware phase ramp
 * that is unrelated to body motion. */
void tn_phase_sanitize(float *phase, uint16_t n_subcarriers);
/** Circular variance of a wrapped phase set; 0 = coherent, 1 = uniform. */
float tn_circular_variance(const float *phase, uint16_t n);

/* ── Rate estimation ─────────────────────────────────────────────────── */
/**
 * BPM from positive-going zero crossings. Cheap, but noisy under motion.
 * Returns 0 if fewer than 2 crossings.
 */
float tn_bpm_zero_crossing(const float *x, uint16_t n, float fs);

/**
 * BPM by autocorrelation peak, searching lags in [bpm_min, bpm_max].
 *
 * `reject_hz` (>0) suppresses lags coinciding with harmonics k*reject_hz
 * for k=1..6 within `reject_tol` fractional tolerance.
 *
 * This exists because zero-crossing heart-rate estimation locks onto
 * breathing harmonics: a 0.25 Hz breathing fundamental puts its 3rd
 * harmonic at 0.75 Hz = 45 BPM, indistinguishable from a resting heart
 * rate. Pass the measured breathing frequency as reject_hz when
 * estimating HR and the failure mode disappears.
 *
 * `out_conf` (optional) receives normalised peak prominence 0..1.
 */
float tn_bpm_autocorr(const float *x, uint16_t n, float fs,
                      float bpm_min, float bpm_max,
                      float reject_hz, float reject_tol,
                      float *out_conf);

/* ── Median smoother over a small ring ───────────────────────────────── */
#define TN_MEDIAN_RING_MAX 15
typedef struct {
    float    ring[TN_MEDIAN_RING_MAX];
    uint16_t n;
    uint16_t head;
    uint16_t count;
} tn_median_ring_t;

void  tn_median_ring_init(tn_median_ring_t *r, uint16_t n);
float tn_median_ring_push(tn_median_ring_t *r, float x);

#ifdef __cplusplus
}
#endif
