#include "node_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "csi_collector.h"
#include "edge_processing.h"
#include "stream_sender.h"

static const char *TAG   = "tn_cfg";
static const char *NVS_NS = "trinetra";

static tn_node_config_t s_cfg;

/**
 * Bounded string copy that ALWAYS null-terminates.
 *
 * strncpy() does not: when the source is at least as long as the limit it
 * copies exactly `n` bytes and leaves the destination unterminated, so every
 * later strlen/printf on it runs off the end. Relying on the destination
 * having been zeroed first works, but is invisible at the call site and the
 * compiler cannot verify it (-Werror=stringop-truncation, correctly).
 *
 * This copies at most dst_size-1 bytes and terminates unconditionally.
 */
static void copy_str(char *dst, size_t dst_size, const char *src)
{
    if (dst == NULL || dst_size == 0) return;
    if (src == NULL) { dst[0] = '\0'; return; }

    size_t n = strnlen(src, dst_size - 1);
    memcpy(dst, src, n);
    dst[n] = '\0';
}

/* ── NVS ──────────────────────────────────────────────────────────────── */

static void get_str(nvs_handle_t h, const char *key, char *out, size_t cap,
                    const char *fallback)
{
    size_t len = cap;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) {
        copy_str(out, cap, fallback);
    }
}

static uint16_t get_u16(nvs_handle_t h, const char *key, uint16_t fallback)
{
    uint16_t v;
    return (nvs_get_u16(h, key, &v) == ESP_OK) ? v : fallback;
}

static uint8_t get_u8(nvs_handle_t h, const char *key, uint8_t fallback)
{
    uint8_t v;
    return (nvs_get_u8(h, key, &v) == ESP_OK) ? v : fallback;
}

static float get_f32(nvs_handle_t h, const char *key, float fallback)
{
    uint32_t bits;
    if (nvs_get_u32(h, key, &bits) != ESP_OK) return fallback;
    float f;
    memcpy(&f, &bits, sizeof(f));
    return f;
}

static void set_f32(nvs_handle_t h, const char *key, float v)
{
    uint32_t bits;
    memcpy(&bits, &v, sizeof(bits));
    nvs_set_u32(h, key, bits);
}

void tn_config_load(tn_node_config_t *out)
{
    memset(&s_cfg, 0, sizeof(s_cfg));

    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGW(TAG, "no stored config, using build defaults");
        copy_str(s_cfg.ssid,      sizeof(s_cfg.ssid),      CONFIG_TN_DEFAULT_SSID);
        copy_str(s_cfg.password,  sizeof(s_cfg.password),  CONFIG_TN_DEFAULT_PASSWORD);
        copy_str(s_cfg.target_ip, sizeof(s_cfg.target_ip), CONFIG_TN_DEFAULT_TARGET_IP);
        copy_str(s_cfg.room,      sizeof(s_cfg.room),      "room-1");
        s_cfg.target_port    = CONFIG_TN_DEFAULT_TARGET_PORT;
        s_cfg.node_id        = CONFIG_TN_DEFAULT_NODE_ID;
        s_cfg.send_raw_csi   = true;
        s_cfg.csi_decimation = 1;
        s_cfg.calib_seconds  = 30.0f;
        s_cfg.mock_mode      = false;
        if (out) *out = s_cfg;
        return;
    }

    get_str(h, "ssid",   s_cfg.ssid,      TN_SSID_MAX, CONFIG_TN_DEFAULT_SSID);
    get_str(h, "pass",   s_cfg.password,  TN_PASS_MAX, CONFIG_TN_DEFAULT_PASSWORD);
    get_str(h, "target", s_cfg.target_ip, TN_IP_MAX,   CONFIG_TN_DEFAULT_TARGET_IP);
    get_str(h, "room",   s_cfg.room,      TN_ROOM_MAX, "room-1");

    s_cfg.target_port    = get_u16(h, "port",   CONFIG_TN_DEFAULT_TARGET_PORT);
    s_cfg.node_id        = get_u8 (h, "node",   CONFIG_TN_DEFAULT_NODE_ID);
    s_cfg.channel        = get_u8 (h, "chan",   0);
    s_cfg.send_raw_csi   = get_u8 (h, "rawcsi", 1) != 0;
    s_cfg.csi_decimation = get_u16(h, "decim",  1);
    s_cfg.mock_mode      = get_u8 (h, "mock",   0) != 0;
    s_cfg.calib_seconds  = get_f32(h, "calib",  30.0f);
    s_cfg.pos_x          = get_f32(h, "posx",   0.0f);
    s_cfg.pos_y          = get_f32(h, "posy",   0.0f);
    s_cfg.pos_z          = get_f32(h, "posz",   1.2f);

    nvs_close(h);

    if (s_cfg.csi_decimation == 0) s_cfg.csi_decimation = 1;
    if (out) *out = s_cfg;
}

bool tn_config_save(const tn_node_config_t *cfg)
{
    if (cfg == NULL) return false;

    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;

    nvs_set_str(h, "ssid",   cfg->ssid);
    nvs_set_str(h, "pass",   cfg->password);
    nvs_set_str(h, "target", cfg->target_ip);
    nvs_set_str(h, "room",   cfg->room);
    nvs_set_u16(h, "port",   cfg->target_port);
    nvs_set_u8 (h, "node",   cfg->node_id);
    nvs_set_u8 (h, "chan",   cfg->channel);
    nvs_set_u8 (h, "rawcsi", cfg->send_raw_csi ? 1 : 0);
    nvs_set_u16(h, "decim",  cfg->csi_decimation);
    nvs_set_u8 (h, "mock",   cfg->mock_mode ? 1 : 0);
    set_f32(h, "calib", cfg->calib_seconds);
    set_f32(h, "posx",  cfg->pos_x);
    set_f32(h, "posy",  cfg->pos_y);
    set_f32(h, "posz",  cfg->pos_z);

    const esp_err_t err = nvs_commit(h);
    nvs_close(h);

    if (err == ESP_OK) {
        s_cfg = *cfg;
        ESP_LOGI(TAG, "config saved");
        return true;
    }
    return false;
}

bool tn_config_erase(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_erase_all(h);
    const esp_err_t err = nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK;
}

tn_node_config_t *tn_config_get(void) { return &s_cfg; }

/* ── WiFi ─────────────────────────────────────────────────────────────── */

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

static EventGroupHandle_t s_wifi_events;
static bool               s_connected;
static uint8_t            s_bssid[6];
static esp_netif_t       *s_netif;
static int                s_retry;
static esp_timer_handle_t s_reconnect_timer;

/** Fires off-thread so the event loop is never blocked by a retry backoff. */
static void reconnect_cb(void *arg)
{
    (void)arg;
    esp_wifi_connect();
}

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *e =
            (const wifi_event_sta_disconnected_t *)data;
        s_connected = false;

        /* Log WHY. Without this, every failure looks identical from the
         * console — "connecting..." then silence — and a wrong password is
         * indistinguishable from being out of range or from the AP being
         * full. The reason code is the single most useful diagnostic the
         * WiFi stack produces and it was being discarded. */
        if (e != NULL) {
            const char *why;
            switch (e->reason) {
                case WIFI_REASON_AUTH_EXPIRE:      why = "auth expired"; break;
                case WIFI_REASON_AUTH_LEAVE:       why = "auth leave"; break;
                case WIFI_REASON_ASSOC_EXPIRE:     why = "assoc expired"; break;
                case WIFI_REASON_ASSOC_TOOMANY:    why = "AP FULL — too many clients"; break;
                case WIFI_REASON_NOT_AUTHED:       why = "not authenticated"; break;
                case WIFI_REASON_NOT_ASSOCED:      why = "not associated"; break;
                /* This — not 202 — is what a wrong PSK looks like. With
                 * WPA2-PSK the password is not used until the 4-way
                 * handshake, which happens AFTER association succeeds. */
                case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
                                                   why = "WRONG PASSWORD (4-way handshake failed)"; break;
                case WIFI_REASON_NO_AP_FOUND:      why = "SSID NOT FOUND (wrong name, or 5 GHz only)"; break;
                /* 802.11 authentication is Open System under WPA2 — it does
                 * not check the password at all. Being refused here means the
                 * AP declined this STATION, so look at MAC filtering, access
                 * control / parental blocks, or a client limit. Re-typing the
                 * password will not help. */
                case WIFI_REASON_AUTH_FAIL:        why = "AP REFUSED THIS MAC (filter/access-control/client-limit — NOT the password)"; break;
                case WIFI_REASON_ASSOC_FAIL:       why = "association refused by AP"; break;
                case WIFI_REASON_HANDSHAKE_TIMEOUT:why = "handshake timeout (weak signal?)"; break;
                case WIFI_REASON_CONNECTION_FAIL:  why = "connection failed"; break;
                case WIFI_REASON_BEACON_TIMEOUT:   why = "beacon timeout (moved out of range?)"; break;
                default:                           why = "see esp_wifi_types.h"; break;
            }
            /* Only log the first few and then every 10th: a node parked out
             * of range would otherwise fill the console forever. */
            if (s_retry < 3 || (s_retry % 10) == 0) {
                ESP_LOGW(TAG, "wifi disconnected: reason %d — %s (attempt %d)",
                         (int)e->reason, why, s_retry + 1);
            }
        }

        /* Reconnect forever with a short backoff. A sensing node that gives
         * up on a transient AP reboot is a node that silently stops
         * protecting whoever is in the room.
         *
         * The backoff is scheduled, NOT slept. This handler runs in the
         * esp_event loop task, which dispatches every WiFi and IP event in
         * the system — including IP_EVENT_STA_GOT_IP. Blocking it for 5 s
         * stalls the entire event pipeline, so a connection that succeeds
         * during the sleep cannot report itself until the sleep ends. */
        if (s_retry < 20) {
            s_retry++;
        } else {
            xEventGroupSetBits(s_wifi_events, WIFI_FAIL_BIT);
            s_retry = 0;
        }
        if (s_reconnect_timer != NULL) {
            const uint64_t delay_us = (s_retry == 0) ? 5000000ULL : 500000ULL;
            esp_timer_stop(s_reconnect_timer);          /* no-op if not armed */
            esp_timer_start_once(s_reconnect_timer, delay_us);
        } else {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        const wifi_event_sta_connected_t *e = (const wifi_event_sta_connected_t *)data;
        memcpy(s_bssid, e->bssid, 6);
        /* Re-point the CSI filter at whoever we actually associated with.
         * Set-once-at-boot leaves a node that reconnected to the router's
         * other band filtering for a BSSID that never transmits to it. */
        tn_csi_set_filter(s_bssid);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = (const ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "got ip " IPSTR, IP2STR(&e->ip_info.ip));
        s_retry     = 0;
        s_connected = true;
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

bool tn_wifi_connect(const tn_node_config_t *cfg, uint32_t timeout_ms)
{
    if (cfg == NULL || cfg->ssid[0] == '\0') {
        ESP_LOGE(TAG, "no SSID configured — run provision.py");
        return false;
    }

    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    const esp_timer_create_args_t rc_args = {
        .callback = &reconnect_cb,
        .name     = "tn_reconnect",
    };
    ESP_ERROR_CHECK(esp_timer_create(&rc_args, &s_reconnect_timer));

    wifi_config_t wc = { 0 };
    copy_str((char *)wc.sta.ssid,     sizeof(wc.sta.ssid),     cfg->ssid);
    copy_str((char *)wc.sta.password, sizeof(wc.sta.password), cfg->password);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable    = true;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    /* Power save MUST be off. With modem sleep enabled the radio wakes only
     * for beacons, which collapses the CSI sample rate to ~10 Hz with huge
     * jitter — well below what a 2 Hz heart-rate band needs. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "connecting to '%s'...", cfg->ssid);

    const EventBits_t bits = xEventGroupWaitBits(
        s_wifi_events, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));

    return (bits & WIFI_CONNECTED_BIT) != 0;
}

bool tn_wifi_is_connected(void) { return s_connected; }

const uint8_t *tn_wifi_ap_bssid(void)
{
    return s_connected ? s_bssid : NULL;
}

void tn_wifi_get_ip(char *out, size_t len)
{
    if (out == NULL || len == 0) return;
    out[0] = '\0';
    if (!s_connected || s_netif == NULL) return;

    esp_netif_ip_info_t ip;
    if (esp_netif_get_ip_info(s_netif, &ip) == ESP_OK) {
        snprintf(out, len, IPSTR, IP2STR(&ip.ip));
    }
}

int8_t tn_wifi_rssi(void)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) return (int8_t)ap.rssi;
    return 0;
}

/* ── Serial provisioning console ──────────────────────────────────────── */

static void print_config(void)
{
    char ip[TN_IP_MAX];
    tn_wifi_get_ip(ip, sizeof(ip));

    printf("\n--- TriNetra node config ---\n");
    printf("  node_id     : %u\n",       (unsigned)s_cfg.node_id);
    printf("  room        : %s\n",       s_cfg.room);
    printf("  position    : %.2f, %.2f, %.2f m\n",
           (double)s_cfg.pos_x, (double)s_cfg.pos_y, (double)s_cfg.pos_z);
    printf("  ssid        : %s\n",       s_cfg.ssid);
    printf("  password    : %s\n",       s_cfg.password[0] ? "<set>" : "<empty>");
    printf("  target      : %s:%u\n",    s_cfg.target_ip, (unsigned)s_cfg.target_port);
    printf("  raw csi     : %s (1/%u)\n", s_cfg.send_raw_csi ? "yes" : "no",
           (unsigned)s_cfg.csi_decimation);
    printf("  calibration : %.0f s\n",   (double)s_cfg.calib_seconds);
    printf("  mock mode   : %s\n",       s_cfg.mock_mode ? "YES (synthetic)" : "no");
    printf("  wifi        : %s  ip=%s  rssi=%d\n",
           s_connected ? "connected" : "down", ip, (int)tn_wifi_rssi());
    printf("----------------------------\n\n");
}

static void console_task(void *arg)
{
    (void)arg;
    char line[160];

    printf("\nTriNetra console ready. Type SHOW for config, HELP for commands.\n");

    for (;;) {
        int i = 0;
        int c;
        while ((c = getchar()) != '\n' && c != '\r') {
            if (c == EOF) { vTaskDelay(pdMS_TO_TICKS(50)); continue; }
            if (i < (int)sizeof(line) - 1) line[i++] = (char)c;
        }
        line[i] = '\0';
        if (i == 0) continue;

        char key[24] = {0}, val[96] = {0};

        if (strncmp(line, "SET ", 4) == 0) {
            if (sscanf(line + 4, "%23s %95[^\n]", key, val) >= 1) {
                if      (!strcmp(key, "ssid"))   copy_str(s_cfg.ssid, sizeof(s_cfg.ssid), val);
                else if (!strcmp(key, "pass"))   copy_str(s_cfg.password, sizeof(s_cfg.password), val);
                else if (!strcmp(key, "target")) copy_str(s_cfg.target_ip, sizeof(s_cfg.target_ip), val);
                else if (!strcmp(key, "room"))   copy_str(s_cfg.room, sizeof(s_cfg.room), val);
                else if (!strcmp(key, "port"))   s_cfg.target_port = (uint16_t)atoi(val);
                else if (!strcmp(key, "node"))   s_cfg.node_id = (uint8_t)atoi(val);
                else if (!strcmp(key, "decim"))  s_cfg.csi_decimation = (uint16_t)(atoi(val) > 0 ? atoi(val) : 1);
                else if (!strcmp(key, "rawcsi")) s_cfg.send_raw_csi = atoi(val) != 0;
                else if (!strcmp(key, "mock"))   s_cfg.mock_mode = atoi(val) != 0;
                else if (!strcmp(key, "calib"))  s_cfg.calib_seconds = (float)atof(val);
                else if (!strcmp(key, "pos")) {
                    float x = 0, y = 0, z = 0;
                    if (sscanf(val, "%f %f %f", &x, &y, &z) == 3) {
                        s_cfg.pos_x = x; s_cfg.pos_y = y; s_cfg.pos_z = z;
                    }
                } else {
                    printf("ERR unknown key '%s'\n", key);
                    continue;
                }
                printf("OK %s\n", key);
            }
        } else if (!strcmp(line, "SHOW")) {
            print_config();
        } else if (!strcmp(line, "SAVE")) {
            printf(tn_config_save(&s_cfg) ? "OK saved\n" : "ERR save failed\n");
        } else if (!strcmp(line, "ERASE")) {
            printf(tn_config_erase() ? "OK erased, REBOOT to apply\n" : "ERR\n");
        } else if (!strcmp(line, "RECAL")) {
            tn_edge_recalibrate();
            printf("OK recalibrating\n");
        } else if (!strcmp(line, "REBOOT")) {
            printf("OK rebooting\n");
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        } else if (!strcmp(line, "HELP")) {
            printf("SET <ssid|pass|target|port|node|room|pos|decim|rawcsi|mock|calib> <v>\n"
                   "SHOW | SAVE | ERASE | RECAL | REBOOT\n");
        } else {
            printf("ERR unknown command (try HELP)\n");
        }
    }
}

void tn_console_start(void)
{
    xTaskCreate(console_task, "tn_console", 4096, NULL, 2, NULL);
}
