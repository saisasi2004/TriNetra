#include "dsp.h"

#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

/* ══ Biquad ═══════════════════════════════════════════════════════════ */

void tn_biquad_reset(tn_biquad_t *bq)
{
    bq->z1 = 0.0f;
    bq->z2 = 0.0f;
}

void tn_biquad_bandpass(tn_biquad_t *bq, float fs, float f_lo, float f_hi)
{
    if (fs <= 0.0f || f_hi <= f_lo) {
        memset(bq, 0, sizeof(*bq));
        bq->b0 = 1.0f;
        return;
    }
    /* Clamp to just under Nyquist — a bandpass whose upper edge sits at or
     * above fs/2 produces a denominator that blows up. */
    const float nyq = fs * 0.5f;
    if (f_hi > nyq * 0.98f) f_hi = nyq * 0.98f;
    if (f_lo < 1e-4f)       f_lo = 1e-4f;
    if (f_lo >= f_hi)       f_lo = f_hi * 0.5f;

    const float f0 = sqrtf(f_lo * f_hi);          /* geometric centre */
    const float bw = f_hi - f_lo;
    const float q  = (bw > 1e-9f) ? (f0 / bw) : 1.0f;

    const float w0    = 2.0f * M_PI * f0 / fs;
    const float alpha = sinf(w0) / (2.0f * q);
    const float cosw0 = cosf(w0);

    const float b0 =  alpha;
    const float b1 =  0.0f;
    const float b2 = -alpha;
    const float a0 =  1.0f + alpha;
    const float a1 = -2.0f * cosw0;
    const float a2 =  1.0f - alpha;

    bq->b0 = b0 / a0;
    bq->b1 = b1 / a0;
    bq->b2 = b2 / a0;
    bq->a1 = a1 / a0;
    bq->a2 = a2 / a0;
    tn_biquad_reset(bq);
}

void tn_biquad_lowpass(tn_biquad_t *bq, float fs, float fc)
{
    const float nyq = fs * 0.5f;
    if (fc > nyq * 0.98f) fc = nyq * 0.98f;

    const float w0    = 2.0f * M_PI * fc / fs;
    const float cosw0 = cosf(w0);
    const float alpha = sinf(w0) / (2.0f * 0.70710678f); /* Q = 1/sqrt(2) */

    const float b0 = (1.0f - cosw0) * 0.5f;
    const float b1 =  1.0f - cosw0;
    const float b2 = (1.0f - cosw0) * 0.5f;
    const float a0 =  1.0f + alpha;
    const float a1 = -2.0f * cosw0;
    const float a2 =  1.0f - alpha;

    bq->b0 = b0 / a0; bq->b1 = b1 / a0; bq->b2 = b2 / a0;
    bq->a1 = a1 / a0; bq->a2 = a2 / a0;
    tn_biquad_reset(bq);
}

void tn_biquad_highpass(tn_biquad_t *bq, float fs, float fc)
{
    const float w0    = 2.0f * M_PI * fc / fs;
    const float cosw0 = cosf(w0);
    const float alpha = sinf(w0) / (2.0f * 0.70710678f);

    const float b0 =  (1.0f + cosw0) * 0.5f;
    const float b1 = -(1.0f + cosw0);
    const float b2 =  (1.0f + cosw0) * 0.5f;
    const float a0 =   1.0f + alpha;
    const float a1 =  -2.0f * cosw0;
    const float a2 =   1.0f - alpha;

    bq->b0 = b0 / a0; bq->b1 = b1 / a0; bq->b2 = b2 / a0;
    bq->a1 = a1 / a0; bq->a2 = a2 / a0;
    tn_biquad_reset(bq);
}

void tn_biquad_notch(tn_biquad_t *bq, float fs, float f0, float q)
{
    const float nyq = fs * 0.5f;
    if (f0 <= 0.0f || f0 >= nyq * 0.98f || q <= 0.0f) {
        memset(bq, 0, sizeof(*bq));
        bq->b0 = 1.0f;                /* pass-through */
        return;
    }

    const float w0    = 2.0f * M_PI * f0 / fs;
    const float cosw0 = cosf(w0);
    const float alpha = sinf(w0) / (2.0f * q);
    const float a0    = 1.0f + alpha;

    bq->b0 =  1.0f / a0;
    bq->b1 = (-2.0f * cosw0) / a0;
    bq->b2 =  1.0f / a0;
    bq->a1 = (-2.0f * cosw0) / a0;
    bq->a2 = (1.0f - alpha) / a0;
    tn_biquad_reset(bq);
}

void tn_notch_harmonics(float *x, uint16_t n, float fs, float f0,
                        uint8_t harmonics, float q)
{
    if (f0 <= 0.0f || n == 0) return;

    static float scratch[512];
    if (n > 512) return;

    for (uint8_t k = 1; k <= harmonics; ++k) {
        const float f = f0 * (float)k;
        if (f >= fs * 0.475f) break;

        tn_biquad_t bq;
        tn_biquad_notch(&bq, fs, f, q);
        tn_biquad_run(&bq, x, scratch, n);
        memcpy(x, scratch, sizeof(float) * n);
    }
}

float tn_biquad_process(tn_biquad_t *bq, float x)
{
    const float y = bq->b0 * x + bq->z1;
    bq->z1 = bq->b1 * x - bq->a1 * y + bq->z2;
    bq->z2 = bq->b2 * x - bq->a2 * y;
    return y;
}

void tn_biquad_run(tn_biquad_t *bq, const float *in, float *out, uint16_t n)
{
    tn_biquad_reset(bq);
    /* Prime with the first sample so the filter does not spend the first
     * ~1/fc seconds decaying from zero — that transient is otherwise
     * mistaken for a large low-frequency oscillation. */
    for (int i = 0; i < 8; ++i) {
        (void)tn_biquad_process(bq, in[0]);
    }
    for (uint16_t i = 0; i < n; ++i) {
        out[i] = tn_biquad_process(bq, in[i]);
    }
}

/* ══ EMA ══════════════════════════════════════════════════════════════ */

void tn_ema_init(tn_ema_t *e, float alpha)
{
    e->value  = 0.0f;
    e->alpha  = alpha;
    e->primed = false;
}

float tn_ema_update(tn_ema_t *e, float x)
{
    if (!e->primed) {
        e->value  = x;
        e->primed = true;
    } else {
        e->value += e->alpha * (x - e->value);
    }
    return e->value;
}

/* ══ Statistics ═══════════════════════════════════════════════════════ */

float tn_mean(const float *x, uint16_t n)
{
    if (n == 0) return 0.0f;
    float s = 0.0f;
    for (uint16_t i = 0; i < n; ++i) s += x[i];
    return s / (float)n;
}

float tn_variance(const float *x, uint16_t n)
{
    if (n < 2) return 0.0f;
    const float m = tn_mean(x, n);
    float s = 0.0f;
    for (uint16_t i = 0; i < n; ++i) {
        const float d = x[i] - m;
        s += d * d;
    }
    return s / (float)(n - 1);
}

float tn_stddev(const float *x, uint16_t n)
{
    return sqrtf(tn_variance(x, n));
}

/* Quickselect — O(n) average, no recursion depth concerns at our sizes. */
static float select_kth(float *a, uint16_t n, uint16_t k)
{
    uint16_t lo = 0, hi = (uint16_t)(n - 1);
    while (lo < hi) {
        const float pivot = a[(lo + hi) / 2];
        uint16_t i = lo, j = hi;
        while (i <= j) {
            while (a[i] < pivot) i++;
            while (a[j] > pivot) j--;
            if (i <= j) {
                const float t = a[i]; a[i] = a[j]; a[j] = t;
                i++;
                if (j == 0) break;
                j--;
            }
        }
        if (k <= j)      hi = j;
        else if (k >= i) lo = i;
        else             break;
    }
    return a[k];
}

float tn_median(float *scratch, uint16_t n)
{
    if (n == 0) return 0.0f;
    if (n == 1) return scratch[0];
    return select_kth(scratch, n, (uint16_t)(n / 2));
}

void tn_hampel(float *buf, uint16_t n, uint16_t half, float n_sigma)
{
    if (n == 0 || half == 0 || n <= half * 2) return;

    static float win[64];
    const uint16_t wlen = (uint16_t)(half * 2 + 1);
    if (wlen > 64) return;

    /* Work on a copy so replacements do not feed forward into later
     * windows and cascade a single spike across the whole buffer. */
    static float src[512];
    if (n > 512) return;
    memcpy(src, buf, sizeof(float) * n);

    for (uint16_t i = half; i + half < n; ++i) {
        memcpy(win, &src[i - half], sizeof(float) * wlen);
        const float med = tn_median(win, wlen);

        /* MAD -> robust sigma via the 1.4826 consistency constant. */
        for (uint16_t j = 0; j < wlen; ++j) {
            win[j] = fabsf(src[i - half + j] - med);
        }
        const float mad   = tn_median(win, wlen);
        const float sigma = 1.4826f * mad;

        if (sigma > 1e-9f && fabsf(src[i] - med) > n_sigma * sigma) {
            buf[i] = med;
        }
    }
}

/* Goertzel single-bin magnitude-squared. */
static float goertzel_power(const float *x, uint16_t n, float fs, float f)
{
    if (n == 0 || fs <= 0.0f) return 0.0f;
    const float w  = 2.0f * M_PI * f / fs;
    const float c  = 2.0f * cosf(w);
    float s0 = 0.0f, s1 = 0.0f, s2 = 0.0f;
    for (uint16_t i = 0; i < n; ++i) {
        s0 = x[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return (s1 * s1) + (s2 * s2) - (c * s1 * s2);
}

float tn_band_power(const float *x, uint16_t n, float fs, float f_lo, float f_hi)
{
    if (n < 4 || fs <= 0.0f) return 0.0f;
    const float df = fs / (float)n;      /* native bin spacing */
    if (df <= 0.0f) return 0.0f;

    float total = 0.0f;
    int   bins  = 0;
    for (float f = f_lo; f <= f_hi; f += df) {
        total += goertzel_power(x, n, fs, f);
        bins++;
    }
    if (bins == 0) return 0.0f;
    return total / ((float)bins * (float)n * (float)n);
}

/* ══ Phase ════════════════════════════════════════════════════════════ */

void tn_phase_unwrap(float *phase, uint16_t n)
{
    if (n < 2) return;
    float offset = 0.0f;
    for (uint16_t i = 1; i < n; ++i) {
        const float d = (phase[i] + offset) - phase[i - 1];
        if      (d >  M_PI) offset -= 2.0f * M_PI;
        else if (d < -M_PI) offset += 2.0f * M_PI;
        phase[i] += offset;
    }
}

void tn_phase_sanitize(float *phase, uint16_t n)
{
    if (n < 3) return;

    tn_phase_unwrap(phase, n);

    /* Least-squares line across the subcarrier index. The slope is the
     * Sampling Time Offset, the intercept the Carrier Frequency Offset —
     * both are receiver artefacts that swamp the millimetre-scale body
     * motion we actually want. Removing them is what makes ESP32 phase
     * usable at all. */
    float sx = 0.0f, sy = 0.0f, sxx = 0.0f, sxy = 0.0f;
    for (uint16_t i = 0; i < n; ++i) {
        const float xi = (float)i;
        sx  += xi;
        sy  += phase[i];
        sxx += xi * xi;
        sxy += xi * phase[i];
    }
    const float nn    = (float)n;
    const float denom = nn * sxx - sx * sx;
    if (fabsf(denom) < 1e-9f) return;

    const float slope     = (nn * sxy - sx * sy) / denom;
    const float intercept = (sy - slope * sx) / nn;

    for (uint16_t i = 0; i < n; ++i) {
        phase[i] -= (slope * (float)i + intercept);
    }
}

float tn_circular_variance(const float *phase, uint16_t n)
{
    if (n == 0) return 1.0f;
    float cs = 0.0f, sn = 0.0f;
    for (uint16_t i = 0; i < n; ++i) {
        cs += cosf(phase[i]);
        sn += sinf(phase[i]);
    }
    const float r = sqrtf(cs * cs + sn * sn) / (float)n;
    return 1.0f - r;
}

/* ══ Rate estimation ══════════════════════════════════════════════════ */

float tn_bpm_zero_crossing(const float *x, uint16_t n, float fs)
{
    if (n < 8 || fs <= 0.0f) return 0.0f;

    uint16_t crossings   = 0;
    int      first_idx   = -1;
    int      last_idx    = -1;

    for (uint16_t i = 1; i < n; ++i) {
        if (x[i - 1] <= 0.0f && x[i] > 0.0f) {
            if (first_idx < 0) first_idx = (int)i;
            last_idx = (int)i;
            crossings++;
        }
    }
    if (crossings < 2 || first_idx < 0 || last_idx <= first_idx) return 0.0f;

    const float span_s  = (float)(last_idx - first_idx) / fs;
    const float periods = (float)(crossings - 1);
    if (span_s <= 0.0f) return 0.0f;

    return 60.0f * periods / span_s;
}

/**
 * Normalised cross-correlation at one lag, over the OVERLAPPING segment.
 *
 * The naive form — sum the overlap and divide by the full-window energy —
 * is biased toward short lags, because a long lag sums fewer terms against
 * the same denominator. The estimator then rails at `lag_min`, reporting
 * the top of the BPM search band no matter what the input is. Dividing by
 * the geometric mean of the two overlapping segments' own energies removes
 * the bias.
 */
static float ncc(const float *x, uint16_t n, float mean, int lag)
{
    const int count = (int)n - lag;
    if (count < 8) return 0.0f;

    float num = 0.0f, ea = 0.0f, eb = 0.0f;
    for (int i = 0; i < count; ++i) {
        const float a = x[i] - mean;
        const float b = x[i + lag] - mean;
        num += a * b;
        ea  += a * a;
        eb  += b * b;
    }
    const float denom = sqrtf(ea * eb);
    return (denom > 1e-12f) ? (num / denom) : 0.0f;
}

/**
 * True when this lag coincides with a harmonic of `reject_hz`.
 *
 * Harmonics k = 1..4 only. Above the 4th, breathing harmonics carry
 * negligible energy while their rejection notches are wide enough to
 * swallow real heart rates — a 0.25 Hz fundamental puts its 5th harmonic
 * at 75 BPM, and an 8% notch there blocks every heart rate from 69 to 81.
 * k <= 4 still kills the 3rd harmonic, which is the failure that occurs.
 */
static bool is_blocked_lag(float fs, int lag, float reject_hz, float reject_tol)
{
    if (reject_hz <= 1e-6f || lag <= 0) return false;

    const float lag_hz = fs / (float)lag;
    for (int k = 1; k <= 4; ++k) {
        const float harm = reject_hz * (float)k;
        if (harm < 1e-6f) continue;
        if (fabsf(lag_hz - harm) / harm < reject_tol) return true;
    }
    return false;
}

/* Largest lag the correlation cache holds. Lags are bounded by n/2, and the
 * longest series anyone feeds this is TN_EDGE_HISTORY (256) samples. */
#define TN_AUTOCORR_MAX_LAG 128

float tn_bpm_autocorr(const float *x, uint16_t n, float fs,
                      float bpm_min, float bpm_max,
                      float reject_hz, float reject_tol,
                      float *out_conf)
{
    if (out_conf) *out_conf = 0.0f;
    if (n < 16 || fs <= 0.0f || bpm_max <= bpm_min) return 0.0f;

    const float mean = tn_mean(x, n);

    /* Lag bounds from the BPM search window. High BPM -> short lag. */
    int lag_min = (int)floorf(fs * 60.0f / bpm_max);
    int lag_max = (int)ceilf (fs * 60.0f / bpm_min);
    if (lag_min < 1)          lag_min = 1;
    if (lag_max > n / 2)      lag_max = n / 2;
    if (lag_min >= lag_max)   return 0.0f;

    float energy = 0.0f;
    for (uint16_t i = 0; i < n; ++i) {
        const float d = x[i] - mean;
        energy += d * d;
    }
    if (energy < 1e-12f) return 0.0f;

    /* Evaluate every admissible lag ONCE into a cache.
     *
     * ncc() is O(n), and the previous shape called it about four times per
     * lag: once to find the global maximum, three more (r, prev, next) per
     * lag while hunting the first local peak, again for the fallback scan,
     * and twice more for the parabolic fit. Across the breathing band at
     * 20 Hz that is roughly 350 evaluations of a 256-sample inner loop,
     * repeated for the heart band, on a 160 MHz core with no FPU to spare.
     * Caching costs 129 floats of stack and removes three quarters of the
     * work — the single largest CPU cost in the sensing path.
     *
     * Indexed by lag directly; lag_max is bounded by n/2 <= 128 above. */
    if (lag_max > TN_AUTOCORR_MAX_LAG) lag_max = TN_AUTOCORR_MAX_LAG;
    if (lag_min >= lag_max) return 0.0f;

    float r_of[TN_AUTOCORR_MAX_LAG + 2];
    bool  ok_of[TN_AUTOCORR_MAX_LAG + 2];

    float global_max = -1e30f;
    float sum_r      = 0.0f;
    int   n_lags     = 0;

    for (int lag = lag_min; lag <= lag_max; ++lag) {
        /* Harmonic rejection: skip lags that correspond to k*reject_hz. */
        if (is_blocked_lag(fs, lag, reject_hz, reject_tol)) {
            ok_of[lag] = false;
            r_of[lag]  = 0.0f;
            continue;
        }
        const float r = ncc(x, n, mean, lag);
        ok_of[lag] = true;
        r_of[lag]  = r;

        sum_r += r;
        n_lags++;
        if (r > global_max) global_max = r;
    }

    if (n_lags == 0 || global_max <= 0.0f) return 0.0f;

    /* Absolute significance floor.
     *
     * A relative threshold alone is not enough, and this is the gap that
     * separated this function from the server's. On pure noise the "global
     * maximum" is itself noise; 85% of it is trivially reached by the first
     * ripple near lag_min, and the estimator then reports bpm_max with
     * apparent confidence. A genuine periodicity correlates with itself at
     * r >= 0.3. Below that, reporting nothing is far more useful than a
     * plausible fabricated number. */
    const float MIN_SIGNIFICANT_R = 0.30f;
    if (global_max < MIN_SIGNIFICANT_R) return 0.0f;

    /* First local peak at >= 85% of the global maximum.
     *
     * Taking the global maximum directly produces octave errors: a periodic
     * signal correlates with itself at its period T and equally well at 2T,
     * 3T, ..., so 15 BPM comes back as 7.5. Walking up from the shortest lag
     * and stopping at the first clearly-significant peak is the standard
     * remedy from autocorrelation pitch tracking. */
    const float OCTAVE_THRESHOLD = 0.85f;
    const float floor_r = (global_max * OCTAVE_THRESHOLD > MIN_SIGNIFICANT_R)
                          ? global_max * OCTAVE_THRESHOLD : MIN_SIGNIFICANT_R;
    int   best_lag = -1;
    float best_r   = -1e30f;

    for (int lag = lag_min + 1; lag < lag_max; ++lag) {
        if (!ok_of[lag] || r_of[lag] < floor_r) continue;

        const float r    = r_of[lag];
        const float prev = ok_of[lag - 1] ? r_of[lag - 1] : -1e30f;
        const float next = ok_of[lag + 1] ? r_of[lag + 1] : -1e30f;

        if (r >= prev && r > next) {
            best_lag = lag;
            best_r   = r;
            break;
        }
    }

    /* No qualifying local peak (short or very noisy window): fall back to
     * the global maximum, which already clears the significance floor. */
    if (best_lag < 0) {
        for (int lag = lag_min; lag <= lag_max; ++lag) {
            if (ok_of[lag] && r_of[lag] > best_r) {
                best_r   = r_of[lag];
                best_lag = lag;
            }
        }
    }
    if (best_lag < 0) return 0.0f;

    /* Reject estimates pinned to the edge of the search band.
     *
     * A real physiological rate almost never lands exactly on 6.0 or 30.0
     * BPM. A peak sitting on the boundary means either the true period is
     * outside the band or there is no periodicity and the correlation is
     * simply sloping — both failures, and both producing a stable,
     * plausible-looking number. */
    if (best_lag <= lag_min + 1 || best_lag >= lag_max - 1) return 0.0f;

    /* Parabolic interpolation around the peak for sub-sample lag accuracy.
     * Without it the BPM quantises visibly at low sample rates. */
    float refined_lag = (float)best_lag;
    {
        const float rm = ok_of[best_lag - 1] ? r_of[best_lag - 1] : best_r;
        const float rp = ok_of[best_lag + 1] ? r_of[best_lag + 1] : best_r;
        const float denom = (rm - 2.0f * best_r + rp);
        if (fabsf(denom) > 1e-9f) {
            const float delta = 0.5f * (rm - rp) / denom;
            if (delta > -1.0f && delta < 1.0f) refined_lag += delta;
        }
    }

    if (out_conf) {
        /* Prominence: how far the peak stands above the mean correlation.
         * A periodic signal gives a sharp isolated peak; noise gives a
         * flat field where peak ~= mean. */
        const float avg  = sum_r / (float)n_lags;
        float       prom = best_r - avg;
        if (prom < 0.0f) prom = 0.0f;
        if (prom > 1.0f) prom = 1.0f;
        *out_conf = prom;
    }

    if (refined_lag <= 0.0f) return 0.0f;
    return 60.0f * fs / refined_lag;
}

/* ══ Median ring ══════════════════════════════════════════════════════ */

void tn_median_ring_init(tn_median_ring_t *r, uint16_t n)
{
    if (n > TN_MEDIAN_RING_MAX) n = TN_MEDIAN_RING_MAX;
    if (n < 1) n = 1;
    memset(r, 0, sizeof(*r));
    r->n = n;
}

float tn_median_ring_push(tn_median_ring_t *r, float x)
{
    r->ring[r->head] = x;
    r->head = (uint16_t)((r->head + 1) % r->n);
    if (r->count < r->n) r->count++;

    float scratch[TN_MEDIAN_RING_MAX];
    memcpy(scratch, r->ring, sizeof(float) * r->count);
    return tn_median(scratch, r->count);
}
