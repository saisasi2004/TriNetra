/**
 * TriNetra CSI sensing node — ESP32-S3 / ESP32-C6
 *
 * Pipeline:
 *   WiFi RX -> CSI callback -> ring buffer
 *          -> sensing task: hampel, phase sanitize, bandpass, autocorr
 *          -> UDP: raw CSI + vitals + events + status
 *
 * The node is designed to be useful with the server switched off: presence,
 * breathing, heart rate, and fall alerts are all computed here, on the MCU.
 * The server adds multi-node fusion, spatial localisation, and history.
 */

#include <stdio.h>
#include <string.h>

#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "csi_collector.h"
#include "dsp.h"
#include "edge_processing.h"
#include "node_config.h"
#include "stream_sender.h"
#include "trinetra_protocol.h"

static const char *TAG = "trinetra";

#define VITALS_INTERVAL_MS  500     /* 2 Hz */
#define STATUS_INTERVAL_MS  5000    /* 0.2 Hz */

/* Frames to process back-to-back before forcing a yield. See sensing_task. */
#define BURST_YIELD 8

static uint32_t s_event_seq;

static inline uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static void banner(void)
{
    esp_chip_info_t chip;
    esp_chip_info(&chip);

    /* CONFIG_IDF_TARGET is a build-time string that always exists. Switching
     * on the CHIP_ESP32Cx enums instead would fail to COMPILE on any IDF
     * version predating a given chip, which is a needless way to break the
     * build on an older but perfectly capable toolchain. */
    const char *model = CONFIG_IDF_TARGET;

    printf("\n");
    printf("  ##########################################\n");
    printf("  #   T R I N E T R A   sensing node       #\n");
    printf("  #   WiFi CSI -> presence, vitals, falls  #\n");
    printf("  ##########################################\n");
    printf("  chip   : %s, %d core(s), rev %d\n", model, chip.cores, chip.revision);
    printf("  heap   : %lu bytes\n", (unsigned long)esp_get_free_heap_size());
    printf("  fw     : %s\n", CONFIG_TN_FIRMWARE_VERSION);
    printf("\n");
}

/* ── Sensing task ─────────────────────────────────────────────────────── */

static void sensing_task(void *arg)
{
    tn_node_config_t *cfg = (tn_node_config_t *)arg;

    tn_csi_frame_t frame;
    uint32_t last_vitals = 0;
    uint32_t last_status = 0;
    uint32_t decim_count = 0;
    uint32_t no_frame_since = now_ms();

    ESP_LOGI(TAG, "sensing task running (node %u, room '%s')",
             (unsigned)cfg->node_id, cfg->room);

    /* Frames processed back-to-back without the queue ever going empty. */
    uint32_t burst = 0;

    for (;;) {
        /* Yield only when we are actually running hot.
         *
         * The starvation risk this guards against is real: tn_csi_receive
         * blocks only when the queue is EMPTY, so under a backlog it returns
         * immediately every time, the idle task never runs, and the task
         * watchdog fires — the busier the node, the less it yields.
         *
         * But the previous fix was an UNCONDITIONAL vTaskDelay(1) at the top
         * of the loop, and that is a latency floor on every frame, not just
         * the hot ones. At the default 100 Hz tick one tick is 10 ms, so
         * every CSI frame sat here for 10 ms before anything looked at it,
         * and the loop could not service more than 100 frames a second — a
         * hard ceiling below what a C6 can capture.
         *
         * Yielding once per BURST_YIELD frames gives the idle task exactly
         * the same guarantee (the loop can never run unbounded without
         * yielding) at 1/BURST_YIELD of the cost, and the common case — a
         * frame arriving into an empty queue — now goes straight through,
         * because blocking in tn_csi_receive is itself a yield. */
        if (tn_csi_receive(&frame, 200)) {
            no_frame_since = now_ms();

            if (++burst >= BURST_YIELD) { burst = 0; vTaskDelay(1); }

            tn_edge_event_t ev;
            const tn_edge_state_t *st = tn_edge_process(&frame, &ev);

            uint8_t flags = 0;
            if (st->presence)      flags |= TN_FLAG_PRESENCE;
            if (st->fall)          flags |= TN_FLAG_FALL;
            if (st->motion)        flags |= TN_FLAG_MOTION;
            if (st->calibrating)   flags |= TN_FLAG_CALIBRATING;
            if (tn_csi_is_mock())  flags |= TN_FLAG_MOCK_SOURCE;
            if (st->signal_quality < 0.25f) flags |= TN_FLAG_LOW_QUALITY;

            /* Raw CSI is the bandwidth hog: ~140 B at 20 Hz = 22 kbit/s per
             * node. Decimation lets a battery or mesh deployment keep the
             * cheap vitals stream while sending CSI at a lower rate. */
            if (cfg->send_raw_csi && tn_wifi_is_connected()) {
                if (++decim_count >= cfg->csi_decimation) {
                    decim_count = 0;
                    tn_stream_send_csi(&frame, cfg->node_id, flags);
                }
            }

            if (ev.type != 0 && tn_wifi_is_connected()) {
                tn_event_packet_t pkt = {
                    .magic       = TN_MAGIC_EVENT,
                    .version     = TN_PROTOCOL_VERSION,
                    .node_id     = cfg->node_id,
                    .event_type  = ev.type,
                    .severity    = ev.severity,
                    .confidence  = ev.confidence,
                    .value       = ev.value,
                    .timestamp_ms = now_ms(),
                    .sequence    = ++s_event_seq,
                };
                tn_stream_send_event(&pkt);

                if (ev.type == TN_EVENT_FALL) {
                    ESP_LOGW(TAG, "EVENT fall  conf=%.2f", (double)ev.confidence);
                } else if (ev.type == TN_EVENT_APNEA) {
                    ESP_LOGW(TAG, "EVENT apnea %.0fs", (double)ev.value);
                }
            }
        } else {
            /* We blocked in tn_csi_receive, so the idle task has already had
             * its turn — the burst counter starts fresh. */
            burst = 0;

            /* No CSI for a while means no traffic on the link. The radio is
             * fine; there is simply nothing to measure. Ping the gateway to
             * generate frames rather than sit blind. */
            if (now_ms() - no_frame_since > 3000) {
                ESP_LOGW(TAG, "no CSI for 3s — is there traffic on the link?");
                no_frame_since = now_ms();
            }
        }

        const uint32_t t = now_ms();

        if (t - last_vitals >= VITALS_INTERVAL_MS) {
            last_vitals = t;
            if (tn_wifi_is_connected()) {
                tn_vitals_packet_t v;
                tn_edge_fill_vitals(&v, cfg->node_id);
                v.timestamp_ms = t;
                tn_stream_send_vitals(&v);
            }

            const tn_edge_state_t *st = tn_edge_state();
            if (st->calibrating) {
                ESP_LOGI(TAG, "calibrating... %lu frames left",
                         (unsigned long)st->calib_remaining);
            } else {
                ESP_LOGI(TAG,
                    "pres=%d motion=%.2f br=%.1f(%.2f) hr=%.1f(%.2f) q=%.2f n=%u",
                    (int)st->presence, (double)st->motion_energy,
                    (double)st->breathing_bpm, (double)st->breathing_conf,
                    (double)st->heart_bpm, (double)st->heart_conf,
                    (double)st->signal_quality, (unsigned)st->n_persons);
            }
        }

        if (t - last_status >= STATUS_INTERVAL_MS) {
            last_status = t;
            if (tn_wifi_is_connected()) {
                tn_csi_stats_t cs;
                tn_csi_get_stats(&cs);
                const tn_edge_state_t *st = tn_edge_state();

                tn_status_packet_t s = {
                    .magic           = TN_MAGIC_STATUS,
                    .version         = TN_PROTOCOL_VERSION,
                    .node_id         = cfg->node_id,
                    .flags           = (uint8_t)((st->presence ? TN_FLAG_PRESENCE : 0) |
                                                 (st->calibrating ? TN_FLAG_CALIBRATING : 0) |
                                                 (tn_csi_is_mock() ? TN_FLAG_MOCK_SOURCE : 0)),
                    .channel         = 0,
                    .uptime_s        = t / 1000,
                    .free_heap       = esp_get_free_heap_size(),
                    .frames_captured = cs.frames_captured,
                    .frames_dropped  = cs.frames_dropped,
                    .rssi            = tn_wifi_rssi(),
                    .cpu_pct         = 0,
                    .rate_hz_x10     = (uint16_t)(cs.measured_rate_hz * 10.0f),
                    .timestamp_ms    = t,
                    .pos_x           = cfg->pos_x,
                    .pos_y           = cfg->pos_y,
                    .pos_z           = cfg->pos_z,
                };
                tn_stream_send_status(&s);
            }
        }
    }
}

/* ── Entry point ──────────────────────────────────────────────────────── */

void app_main(void)
{
    banner();

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    static tn_node_config_t cfg;
    tn_config_load(&cfg);

    tn_console_start();

    tn_edge_init(cfg.calib_seconds);
    tn_csi_set_mock(cfg.mock_mode);

    const bool wifi_ok = tn_wifi_connect(&cfg, 20000);
    if (!wifi_ok) {
        ESP_LOGE(TAG, "WiFi connect failed — sensing continues offline.");
        ESP_LOGE(TAG, "Provision over serial: SET ssid <x>, SET pass <y>, SAVE, REBOOT");
    } else {
        char ip[TN_IP_MAX];
        tn_wifi_get_ip(ip, sizeof(ip));
        ESP_LOGI(TAG, "online at %s -> streaming to %s:%u",
                 ip, cfg.target_ip, (unsigned)cfg.target_port);
        tn_stream_init(cfg.target_ip, cfg.target_port);
    }

    /* Filter CSI to our own AP. Without this every neighbouring beacon
     * produces a CSI callback, the effective sample rate becomes wildly
     * irregular, and every frequency estimate downstream is garbage. */
    const uint8_t *bssid = tn_wifi_ap_bssid();
    if (!tn_csi_start(cfg.mock_mode ? NULL : bssid)) {
        ESP_LOGE(TAG, "CSI start failed");
    }

    /* tskNO_AFFINITY, not core 1.
     *
     * This is the difference between a board that runs and a board that
     * boot-loops. The ESP32-C6 is a SINGLE-core RISC-V part, so IDF builds it
     * with CONFIG_FREERTOS_UNICORE=1 and configNUM_CORES == 1. FreeRTOS
     * asserts `xCoreID < configNUM_CORES` (tasks.c), and with assertions
     * enabled — which they are in every default build — pinning to core 1
     * aborts the moment app_main reaches this line.
     *
     * Nothing catches it earlier: the code COMPILES cleanly for the C6,
     * because xTaskCreatePinnedToCore takes a runtime integer and the
     * toolchain has no reason to object. The failure is a boot panic, not a
     * build error, which is exactly why it survived a clean build.
     *
     * tskNO_AFFINITY is also the right answer on the dual-core S3: there is
     * one sensing task and letting the scheduler place it costs nothing. */
    xTaskCreatePinnedToCore(sensing_task, "tn_sense", 16384, &cfg, 5, NULL,
                            tskNO_AFFINITY);
}
