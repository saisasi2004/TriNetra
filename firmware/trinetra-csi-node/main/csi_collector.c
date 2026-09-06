#include "csi_collector.h"

#include <math.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "dsp.h"

static const char *TAG = "tn_csi";

/* Queue depth of 8: deep enough to ride out a slow processing tick, shallow
 * enough that we drop stale frames instead of accumulating latency. Sensing
 * data is only useful fresh. */
#define CSI_QUEUE_DEPTH 8

static QueueHandle_t   s_queue;
static tn_csi_stats_t  s_stats;
static bool            s_running;
static bool            s_mock;
static uint8_t         s_filter_mac[6];
static bool            s_use_filter;
static uint32_t        s_sequence;
static int64_t         s_last_us;
static float           s_rate_ema;
static float           s_interval_ema;
static TaskHandle_t    s_mock_task;

/* ── PPDU lock ───────────────────────────────────────────────────────────
 *
 * A WiFi 6 radio will hand us CSI from whatever format the AP happened to
 * transmit: an HE frame gives 242 tones, an HT frame 56, a legacy frame
 * fewer still. Downstream, every subcarrier index is a fixed spatial
 * channel whose phase is tracked across time — so a frame-to-frame flip in
 * tone count is not a smaller measurement, it is a DIFFERENT measurement
 * wearing the same name. The server would spend its life re-aligning
 * phase references and never hold a breathing estimate long enough to
 * resolve 0.25 Hz.
 *
 * So: vote over the first PPDU_LOCK_FRAMES frames, lock to whichever
 * format dominates, and reject the rest. If the locked format then stops
 * arriving entirely (AP reconfigured, we roamed to a different band), the
 * drought counter unlocks and we re-vote rather than going deaf.
 */
#define PPDU_LOCK_FRAMES   120   /* ~6 s at 20 Hz */
#define PPDU_DROUGHT_LIMIT 200   /* consecutive rejects before re-voting */

static int8_t   s_ppdu_lock = -1;
static uint16_t s_ppdu_votes[3];
static uint16_t s_ppdu_seen;
static uint16_t s_ppdu_drought;

/* Returns true if this frame's format should be accepted. */
static bool ppdu_gate(uint8_t ppdu, uint16_t n)
{
    if (ppdu > 2) return false;

    if (s_ppdu_lock < 0) {
        s_ppdu_votes[ppdu]++;
        if (++s_ppdu_seen >= PPDU_LOCK_FRAMES) {
            uint8_t best = 0;
            for (uint8_t i = 1; i < 3; ++i) {
                if (s_ppdu_votes[i] > s_ppdu_votes[best]) best = i;
            }
            s_ppdu_lock    = (int8_t)best;
            s_ppdu_drought = 0;
            ESP_LOGI(TAG, "PPDU locked to type %u (%u tones) after %u frames "
                          "[legacy/ht %u, he %u, vht %u]",
                     best, (unsigned)n, (unsigned)s_ppdu_seen,
                     (unsigned)s_ppdu_votes[0], (unsigned)s_ppdu_votes[1],
                     (unsigned)s_ppdu_votes[2]);
        }
        /* Accept everything while voting — a few mixed frames at startup are
         * harmless, and blocking them would starve the warm-up. */
        return true;
    }

    if (ppdu == (uint8_t)s_ppdu_lock) {
        s_ppdu_drought = 0;
        return true;
    }

    if (++s_ppdu_drought >= PPDU_DROUGHT_LIMIT) {
        ESP_LOGW(TAG, "locked PPDU type %d absent for %u frames — re-voting",
                 (int)s_ppdu_lock, (unsigned)s_ppdu_drought);
        s_ppdu_lock = -1;
        s_ppdu_seen = 0;
        s_ppdu_drought = 0;
        memset(s_ppdu_votes, 0, sizeof(s_ppdu_votes));
    }
    return false;
}

/* Scratch used only inside the callback (WiFi task context, single writer). */
static tn_csi_frame_t s_scratch;

static inline uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/* ── Subcarrier extraction ───────────────────────────────────────────────
 *
 * ESP-IDF gives us len bytes of int8 pairs. Layout depends on the PPDU:
 *   HT-LTF 20 MHz  : 128 bytes -> 64 subcarriers, of which indices
 *                    [6..31] and [33..58] are active (52 data + 4 pilot).
 *   HE-LTF 20 MHz  : 512 bytes -> 256 subcarriers (ESP32-C6, IDF >= 5.1)
 *
 * The DC bin and the guard bands carry no useful energy — including them
 * just injects a constant that dilutes every variance metric. We keep the
 * active set only.
 */
typedef struct { uint16_t lo, hi; } band_t;

static uint16_t extract_active(const int8_t *raw, uint16_t raw_len,
                               float *amp, float *phase, int8_t *keep_raw,
                               uint8_t *out_ppdu)
{
    const uint16_t total = (uint16_t)(raw_len / 2);
    band_t bands[2];
    uint8_t n_bands;

    if (total >= 256) {
        /* HE20 (RU242): bin 128 is DC, so bin i carries subcarrier k=i-128.
         * The 802.11ax RU242 allocation is k in [-122,-2] and [+2,+122] —
         * note that k = +-1 are NULL tones in HE20, unlike HT20 where only
         * DC itself is null. Taking 6..127 / 129..250 would pull those two
         * dead bins in and feed two hard zeros into every variance and
         * coherence metric. 121 + 121 = 242 active tones. */
        *out_ppdu = TN_PPDU_HE_SU;
        bands[0] = (band_t){ 6, 126 };
        bands[1] = (band_t){ 130, 250 };
        n_bands = 2;
    } else if (total >= 64) {
        /* HT20 / non-HT: 56 active tones. */
        *out_ppdu = TN_PPDU_HT_LEGACY;
        bands[0] = (band_t){ 6, 31 };
        bands[1] = (band_t){ 33, 58 };
        n_bands = 2;
    } else {
        /* Legacy LLTF only (>= 26 tones). Take what is there. */
        *out_ppdu = TN_PPDU_HT_LEGACY;
        bands[0] = (band_t){ 0, (uint16_t)(total > 0 ? total - 1 : 0) };
        n_bands = 1;
    }

    uint16_t n = 0;
    for (uint8_t b = 0; b < n_bands; ++b) {
        for (uint16_t i = bands[b].lo; i <= bands[b].hi && i < total; ++i) {
            if (n >= TN_MAX_SUBCARRIERS) break;
            const int8_t im = raw[2 * i];
            const int8_t re = raw[2 * i + 1];

            amp[n]   = sqrtf((float)re * (float)re + (float)im * (float)im);
            phase[n] = atan2f((float)im, (float)re);

            keep_raw[2 * n]     = im;
            keep_raw[2 * n + 1] = re;
            n++;
        }
    }
    return n;
}

/* ── WiFi CSI callback (WiFi task context — keep it short) ───────────── */

static void csi_rx_cb(void *ctx, wifi_csi_info_t *info)
{
    (void)ctx;
    if (!s_running || info == NULL || info->buf == NULL) return;

    if (s_use_filter && memcmp(info->mac, s_filter_mac, 6) != 0) {
        return;
    }
    if (info->len < 52 || info->len > 2 * TN_MAX_SUBCARRIERS) {
        s_stats.frames_rejected++;
        return;
    }

    uint8_t ppdu = TN_PPDU_HT_LEGACY;
    const uint16_t n = extract_active(info->buf, (uint16_t)info->len,
                                      s_scratch.amplitude, s_scratch.phase,
                                      s_scratch.raw, &ppdu);
    if (n == 0) {
        s_stats.frames_rejected++;
        return;
    }
    if (!ppdu_gate(ppdu, n)) {
        s_stats.frames_rejected++;
        return;
    }

    s_scratch.n_subcarriers = n;
    s_scratch.raw_len       = (uint16_t)(n * 2);
    s_scratch.ppdu_type     = ppdu;
    s_scratch.rssi          = info->rx_ctrl.rssi;
    s_scratch.noise_floor   = (int8_t)info->rx_ctrl.noise_floor;
    s_scratch.channel       = (uint8_t)info->rx_ctrl.channel;
    s_scratch.freq_mhz      = (uint16_t)(2407 + 5 * info->rx_ctrl.channel);
    s_scratch.sequence      = ++s_sequence;
    s_scratch.timestamp_ms  = now_ms();

    /* Measure the true arrival rate. CSI is event-driven — it arrives when
     * a frame is received, not on a clock. Every downstream frequency
     * estimate depends on knowing the real fs, so we track it rather than
     * assuming a nominal value. */
    const int64_t t = esp_timer_get_time();
    if (s_last_us != 0) {
        const float dt = (float)(t - s_last_us) * 1e-6f;
        /* Average the INTERVAL, then invert once. Averaging instantaneous
         * rates (1/dt) instead is biased upward — by Jensen's inequality
         * E[1/dt] >= 1/E[dt] — and the error grows with burstiness, which
         * is exactly what CSI arrivals are. Against a steady 20 Hz source
         * the old form reported ~53 Hz.
         *
         * The upper bound is 5 s rather than 1 s so that a genuinely slow
         * link is reported as slow instead of being excluded from the
         * average, which used to make an idle node look healthy. */
        if (dt > 1e-4f && dt < 5.0f) {
            s_interval_ema = (s_interval_ema <= 0.0f)
                ? dt
                : s_interval_ema + 0.02f * (dt - s_interval_ema);
            if (s_interval_ema > 0.0f) s_rate_ema = 1.0f / s_interval_ema;
        }
    }
    s_last_us = t;
    s_stats.measured_rate_hz = s_rate_ema;
    s_stats.last_rssi        = s_scratch.rssi;

    if (xQueueSend(s_queue, &s_scratch, 0) != pdTRUE) {
        /* Drop the OLDEST, keep the newest: stale CSI is worthless. */
        tn_csi_frame_t discard;
        if (xQueueReceive(s_queue, &discard, 0) == pdTRUE) {
            s_stats.frames_dropped++;
        }
        if (xQueueSend(s_queue, &s_scratch, 0) != pdTRUE) {
            s_stats.frames_dropped++;
            return;
        }
    }
    s_stats.frames_captured++;
}

/* ── Mock generator ──────────────────────────────────────────────────────
 * Physically-shaped synthetic CSI so the whole pipeline can be exercised
 * on a bench with no traffic. Models a breathing chest as a slow phase
 * modulation on a subset of subcarriers plus a faster cardiac component. */

static void mock_task(void *arg)
{
    (void)arg;
    const uint16_t N  = 56;
    const float    fs = 20.0f;
    float t = 0.0f;
    uint32_t rnd = 0x12345678u;

    while (s_running && s_mock) {
        tn_csi_frame_t f;
        memset(&f, 0, sizeof(f));
        f.n_subcarriers = N;
        f.raw_len       = (uint16_t)(N * 2);
        f.ppdu_type     = TN_PPDU_HT_LEGACY;
        f.rssi          = (int8_t)(-52 + (int)(3.0f * sinf(t * 0.3f)));
        f.noise_floor   = -96;
        f.channel       = 6;
        f.freq_mhz      = 2437;
        f.sequence      = ++s_sequence;
        f.timestamp_ms  = now_ms();

        const float breath = sinf(2.0f * (float)M_PI * 0.25f * t);  /* 15 BPM */
        const float heart  = sinf(2.0f * (float)M_PI * 1.15f * t);  /* 69 BPM */

        for (uint16_t i = 0; i < N; ++i) {
            rnd = rnd * 1664525u + 1013904223u;
            const float noise = ((float)((rnd >> 16) & 0xFFFF) / 32768.0f - 1.0f);

            /* Subcarriers near the middle of the band see the strongest
             * body-reflected path in a typical short link. */
            const float sens = expf(-powf(((float)i - (float)N * 0.5f) / 14.0f, 2.0f));

            const float amp = 22.0f + 6.0f * sens * breath + 1.2f * noise;
            const float ph  = 0.9f * sens * (breath * 0.8f + heart * 0.06f)
                            + 0.02f * noise
                            + 0.11f * (float)i;   /* hardware phase ramp (STO) */

            f.amplitude[i] = amp;
            f.phase[i]     = atan2f(sinf(ph), cosf(ph));
            f.raw[2 * i]     = (int8_t)(amp * sinf(ph));
            f.raw[2 * i + 1] = (int8_t)(amp * cosf(ph));
        }

        s_stats.frames_captured++;
        s_stats.measured_rate_hz = fs;
        s_stats.last_rssi        = f.rssi;

        if (xQueueSend(s_queue, &f, 0) != pdTRUE) {
            tn_csi_frame_t discard;
            if (xQueueReceive(s_queue, &discard, 0) == pdTRUE) s_stats.frames_dropped++;
            (void)xQueueSend(s_queue, &f, 0);
        }

        t += 1.0f / fs;
        vTaskDelay(pdMS_TO_TICKS((int)(1000.0f / fs)));
    }
    s_mock_task = NULL;
    vTaskDelete(NULL);
}

/* ── Public API ──────────────────────────────────────────────────────── */

bool tn_csi_start(const uint8_t *filter_mac)
{
    if (s_running) return true;

    s_queue = xQueueCreate(CSI_QUEUE_DEPTH, sizeof(tn_csi_frame_t));
    if (s_queue == NULL) {
        ESP_LOGE(TAG, "queue alloc failed (need %u bytes)",
                 (unsigned)(CSI_QUEUE_DEPTH * sizeof(tn_csi_frame_t)));
        return false;
    }

    memset(&s_stats, 0, sizeof(s_stats));
    s_sequence = 0;
    s_last_us  = 0;
    s_rate_ema = 0.0f;
    s_interval_ema = 0.0f;

    s_ppdu_lock    = -1;
    s_ppdu_seen    = 0;
    s_ppdu_drought = 0;
    memset(s_ppdu_votes, 0, sizeof(s_ppdu_votes));

    if (filter_mac != NULL) {
        memcpy(s_filter_mac, filter_mac, 6);
        s_use_filter = true;
        ESP_LOGI(TAG, "filtering CSI to %02x:%02x:%02x:%02x:%02x:%02x",
                 filter_mac[0], filter_mac[1], filter_mac[2],
                 filter_mac[3], filter_mac[4], filter_mac[5]);
    } else {
        s_use_filter = false;
    }

    s_running = true;

    if (s_mock) {
        ESP_LOGW(TAG, "MOCK CSI ENABLED — output is synthetic, not measured");
        xTaskCreate(mock_task, "tn_mock", 8192, NULL, 4, &s_mock_task);
        return true;
    }

    /* The CSI config struct is NOT the same shape on every target. On parts
     * with a WiFi 6 radio, esp_wifi_types.h typedefs wifi_csi_config_t to
     * wifi_csi_acquire_config_t — a bitfield struct selecting which PPDU
     * formats to acquire — and none of the classic field names exist. The
     * switch is on SOC_WIFI_HE_SUPPORT, which is exactly the condition IDF
     * itself uses, so this tracks the header rather than guessing by target. */
#if CONFIG_SOC_WIFI_HE_SUPPORT
    wifi_csi_config_t cfg = {
        .enable                 = 1,
        .acquire_csi_legacy     = 1,  /* L-LTF from 11g frames  */
        .acquire_csi_ht20       = 1,  /* HT-LTF from 11n frames */
        .acquire_csi_ht40       = 1,
        .acquire_csi_su         = 1,  /* HE-LTF, 242 tones — the reason for C6 */
        .acquire_csi_mu         = 1,
        /* DCM repeats each symbol across two tones, so a DCM frame's CSI is
         * not comparable to a normal one. Beamformed frames carry the AP's
         * steering matrix folded into the measurement, which is a property
         * of the AP's decision, not of the room. Both would show up as
         * spurious channel change. Excluded. */
        .acquire_csi_dcm        = 0,
        .acquire_csi_beamformed = 0,
        .acquire_csi_he_stbc    = 0,  /* always the complete HE-LTF1 */
        .val_scale_cfg          = 0,  /* automatic scaling */
    };
#else
    wifi_csi_config_t cfg = {
        .lltf_en           = true,
        .htltf_en          = true,
        .stbc_htltf2_en    = true,
        .ltf_merge_en      = true,
        .channel_filter_en = true,
        .manu_scale        = false,
        .shift             = 0,
    };
#endif

    esp_err_t err = esp_wifi_set_csi_config(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_config: %s", esp_err_to_name(err));
        s_running = false;
        return false;
    }
    err = esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_rx_cb: %s", esp_err_to_name(err));
        s_running = false;
        return false;
    }
    err = esp_wifi_set_csi(true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi: %s", esp_err_to_name(err));
        s_running = false;
        return false;
    }

    ESP_LOGI(TAG, "CSI capture started");
    return true;
}

void tn_csi_stop(void)
{
    if (!s_running) return;
    s_running = false;
    if (!s_mock) {
        esp_wifi_set_csi(false);
    }
    ESP_LOGI(TAG, "CSI capture stopped");
}

bool tn_csi_receive(tn_csi_frame_t *out, uint32_t timeout_ms)
{
    if (s_queue == NULL) return false;
    return xQueueReceive(s_queue, out, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void tn_csi_get_stats(tn_csi_stats_t *out)
{
    if (out == NULL) return;
    *out = s_stats;

    /* The rate EMA only advances inside the RX callback. When frames stop
     * arriving it does not fall — it freezes at whatever it last saw and
     * keeps reporting a healthy rate indefinitely. That turns the single
     * most useful diagnostic into a lie at exactly the moment something is
     * wrong: a node with a dead link will insist it is capturing at 60 Hz.
     *
     * Bound the reported value by what the observed silence can possibly
     * support: if nothing has arrived for T seconds the true rate cannot
     * exceed 1/T. */
    if (s_last_us != 0) {
        const float idle_s = (float)(esp_timer_get_time() - s_last_us) * 1e-6f;
        if (idle_s > 0.5f) {
            const float ceiling = 1.0f / idle_s;
            if (ceiling < out->measured_rate_hz) out->measured_rate_hz = ceiling;
        }
    }
}

void tn_csi_set_filter(const uint8_t *filter_mac)
{
    if (filter_mac == NULL) {
        if (s_use_filter) ESP_LOGW(TAG, "CSI filter cleared — accepting all sources");
        s_use_filter = false;
        return;
    }
    if (s_use_filter && memcmp(s_filter_mac, filter_mac, 6) == 0) return;

    memcpy(s_filter_mac, filter_mac, 6);
    s_use_filter = true;
    ESP_LOGI(TAG, "CSI filter -> %02x:%02x:%02x:%02x:%02x:%02x",
             filter_mac[0], filter_mac[1], filter_mac[2],
             filter_mac[3], filter_mac[4], filter_mac[5]);

    /* The tone count can differ between bands and APs, so a filter change is
     * also a reason to stop trusting the old PPDU decision. */
    s_ppdu_lock    = -1;
    s_ppdu_seen    = 0;
    s_ppdu_drought = 0;
    memset(s_ppdu_votes, 0, sizeof(s_ppdu_votes));
}

void tn_csi_set_mock(bool enabled) { s_mock = enabled; }
bool tn_csi_is_mock(void)          { return s_mock; }
