/**
 * Persistent node configuration in NVS + WiFi station management.
 *
 * Credentials live in NVS, never in source. `provision.py` writes them over
 * the serial console so the firmware binary itself is safe to share.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>   /* size_t — used by tn_wifi_get_ip() below */
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TN_SSID_MAX     33
#define TN_PASS_MAX     65
#define TN_IP_MAX       46
#define TN_ROOM_MAX     33

typedef struct {
    char     ssid[TN_SSID_MAX];
    char     password[TN_PASS_MAX];
    char     target_ip[TN_IP_MAX];
    uint16_t target_port;
    uint8_t  node_id;
    char     room[TN_ROOM_MAX];
    float    pos_x, pos_y, pos_z;    /* metres, for server-side localisation */
    uint8_t  channel;                /* 0 = follow AP */
    bool     send_raw_csi;           /* false = vitals/events only (low bw) */
    uint16_t csi_decimation;         /* send 1 of every N CSI frames */
    float    calib_seconds;
    bool     mock_mode;
} tn_node_config_t;

/** Load config from NVS, falling back to Kconfig defaults. */
void tn_config_load(tn_node_config_t *out);
/** Persist config to NVS. */
bool tn_config_save(const tn_node_config_t *cfg);
/** Erase stored config (factory reset). */
bool tn_config_erase(void);
tn_node_config_t *tn_config_get(void);

/* ── WiFi ─────────────────────────────────────────────────────────────── */

/** Bring up the station interface and connect. Blocks up to timeout_ms.
 *  Returns false on timeout — the caller decides whether to keep sensing
 *  offline or reboot. */
bool tn_wifi_connect(const tn_node_config_t *cfg, uint32_t timeout_ms);
bool tn_wifi_is_connected(void);
/** BSSID of the connected AP, for CSI source filtering. NULL if not up. */
const uint8_t *tn_wifi_ap_bssid(void);
void tn_wifi_get_ip(char *out, size_t len);
int8_t tn_wifi_rssi(void);

/**
 * Serial provisioning console. Reads newline-terminated commands on stdin:
 *   SET ssid <value> | SET pass <value> | SET target <ip> | SET port <n>
 *   SET node <n>     | SET room <name>  | SET pos <x> <y> <z>
 *   SET mock <0|1>   | SET rawcsi <0|1> | SET decim <n>
 *   SHOW | SAVE | ERASE | REBOOT | RECAL
 * Runs as its own task; safe to leave enabled in production since it
 * requires physical USB access.
 */
void tn_console_start(void);

#ifdef __cplusplus
}
#endif
