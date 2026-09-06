/**
 * TriNetra wire protocol — ESP32 node -> sensing server (UDP)
 *
 * All multi-byte fields are LITTLE-ENDIAN (native ESP32 / x86 ordering).
 * Every packet begins with a 4-byte magic so a single UDP socket can
 * demultiplex packet types without a separate port per stream.
 *
 * This header is mirrored byte-for-byte by server/net/protocol.js.
 * If you change a struct here, change it there in the same commit.
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Magics ──────────────────────────────────────────────────────────── */
#define TN_MAGIC_CSI     0x544E0001u  /* raw CSI frame            */
#define TN_MAGIC_VITALS  0x544E0002u  /* edge-computed vitals     */
#define TN_MAGIC_STATUS  0x544E0003u  /* node heartbeat / health  */
#define TN_MAGIC_EVENT   0x544E0004u  /* discrete edge event      */

#define TN_PROTOCOL_VERSION 1

/* ── PPDU type (which symbol grid the CSI was sampled on) ────────────── */
/* CSI from different PPDU types is NOT comparable bin-for-bin: an HT-LTF
 * grid and an HE-LTF grid have different subcarrier spacing and count.
 * The server keys its rolling baselines on (n_subcarriers, ppdu_type). */
typedef enum {
    TN_PPDU_HT_LEGACY = 0,  /* 802.11n HT-LTF, 20 MHz, 64 bins (56 active) */
    TN_PPDU_HE_SU     = 1,  /* 802.11ax HE-LTF, 20 MHz, 256 bins (242 active) */
    TN_PPDU_VHT       = 2,  /* 802.11ac VHT-LTF */
} tn_ppdu_type_t;

/* ── Node flags (status + csi header) ────────────────────────────────── */
#define TN_FLAG_PRESENCE     (1u << 0)
#define TN_FLAG_FALL         (1u << 1)
#define TN_FLAG_MOTION       (1u << 2)
#define TN_FLAG_CALIBRATING  (1u << 3)
#define TN_FLAG_LOW_QUALITY  (1u << 4)
#define TN_FLAG_MOCK_SOURCE  (1u << 5)  /* synthetic CSI, not real radio */

/* ── CSI frame ───────────────────────────────────────────────────────────
 *
 *  offset  size  field
 *  ------  ----  -------------------------------------------------------
 *     0      4   magic          = TN_MAGIC_CSI
 *     4      1   version        = TN_PROTOCOL_VERSION
 *     5      1   node_id        1..254 (0 reserved, 255 = broadcast)
 *     6      1   n_antennas     1 for ESP32 (single RX chain)
 *     7      1   ppdu_type      tn_ppdu_type_t
 *     8      2   n_subcarriers  count of int8 I/Q PAIRS that follow
 *    10      2   freq_mhz       centre frequency, e.g. 2437
 *    12      4   sequence       monotonic per node, wraps at 2^32
 *    16      1   rssi           dBm, signed
 *    17      1   noise_floor    dBm, signed
 *    18      2   rate_hz        actual CSI sample rate x10 (e.g. 200 = 20.0 Hz)
 *    20      4   timestamp_ms   ms since node boot
 *    24      1   flags          TN_FLAG_*
 *    25      1   channel        WiFi channel 1..14
 *    26      2   reserved       zero
 *  ------  ----
 *    28   2*N    payload        int8 pairs: [imag0, real0, imag1, real1, ...]
 *
 * ESP-IDF delivers CSI as signed 8-bit imaginary/real interleaved pairs.
 * We forward them raw — the server derives amplitude = hypot(re, im) and
 * phase = atan2(im, re). Sending raw keeps the packet at 28 + 112 = 140 B
 * for a 56-subcarrier HT frame, comfortably inside one MTU.
 */
#define TN_CSI_HEADER_LEN 28
#define TN_CSI_MAX_SUBCARRIERS 256
#define TN_CSI_MAX_PACKET (TN_CSI_HEADER_LEN + 2 * TN_CSI_MAX_SUBCARRIERS)

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t  version;
    uint8_t  node_id;
    uint8_t  n_antennas;
    uint8_t  ppdu_type;
    uint16_t n_subcarriers;
    uint16_t freq_mhz;
    uint32_t sequence;
    int8_t   rssi;
    int8_t   noise_floor;
    uint16_t rate_hz_x10;
    uint32_t timestamp_ms;
    uint8_t  flags;
    uint8_t  channel;
    uint16_t reserved;
} tn_csi_header_t;

_Static_assert(sizeof(tn_csi_header_t) == TN_CSI_HEADER_LEN,
               "tn_csi_header_t must be exactly 28 bytes");

/* ── Vitals packet (edge-computed, 40 bytes) ─────────────────────────────
 *
 * Emitted at ~2 Hz. This is what makes the node useful standalone: even
 * with the server down, these are the numbers that matter, computed on
 * the MCU from the phase time series.
 *
 * breathing_bpm_x100 : breaths/min * 100  (0 = no estimate)
 * heart_bpm_x100     : beats/min  * 100  (0 = no estimate)
 */
typedef struct __attribute__((packed)) {
    uint32_t magic;              /* TN_MAGIC_VITALS */
    uint8_t  version;
    uint8_t  node_id;
    uint8_t  flags;              /* TN_FLAG_* */
    uint8_t  n_persons;          /* coarse edge estimate, 0..7 */
    uint16_t breathing_bpm_x100;
    uint16_t heart_bpm_x100;
    float    motion_energy;      /* 0..1 normalised motion-band power */
    float    presence_score;     /* 0..1 */
    float    breathing_conf;     /* 0..1 */
    float    heart_conf;         /* 0..1 */
    float    signal_quality;     /* 0..1 */
    int8_t   rssi;
    uint8_t  posture;            /* tn_posture_t */
    uint16_t reserved;
    uint32_t timestamp_ms;
} tn_vitals_packet_t;

_Static_assert(sizeof(tn_vitals_packet_t) == 40,
               "tn_vitals_packet_t must be exactly 40 bytes");

typedef enum {
    TN_POSTURE_UNKNOWN  = 0,
    TN_POSTURE_ABSENT   = 1,
    TN_POSTURE_LYING    = 2,
    TN_POSTURE_SITTING  = 3,
    TN_POSTURE_STANDING = 4,
    TN_POSTURE_WALKING  = 5,
} tn_posture_t;

/* ── Status / heartbeat (44 bytes) ───────────────────────────────────── */
typedef struct __attribute__((packed)) {
    uint32_t magic;              /* TN_MAGIC_STATUS */
    uint8_t  version;
    uint8_t  node_id;
    uint8_t  flags;
    uint8_t  channel;
    uint32_t uptime_s;
    uint32_t free_heap;
    uint32_t frames_captured;
    uint32_t frames_dropped;
    int8_t   rssi;
    uint8_t  cpu_pct;
    uint16_t rate_hz_x10;
    uint32_t timestamp_ms;
    /* Where this node is, in metres from room centre, as provisioned into
     * NVS. Carried in the heartbeat because the server otherwise has no way
     * to learn it: it would fall back to guessing a perimeter slot, and the
     * whole point of the field fusion is that it triangulates from KNOWN
     * node positions. A guessed layout produces a plausible-looking field
     * that is wrong everywhere. Repeated every heartbeat rather than sent
     * once so a server restart re-learns the layout without touching the
     * nodes. */
    float    pos_x;
    float    pos_y;
    float    pos_z;
} tn_status_packet_t;

_Static_assert(sizeof(tn_status_packet_t) == 44,
               "tn_status_packet_t must be exactly 44 bytes");

/* ── Discrete event (24 bytes) ───────────────────────────────────────── */
typedef enum {
    TN_EVENT_FALL          = 1,
    TN_EVENT_PRESENCE_ON   = 2,
    TN_EVENT_PRESENCE_OFF  = 3,
    TN_EVENT_MOTION_BURST  = 4,
    TN_EVENT_APNEA         = 5,
    TN_EVENT_GESTURE       = 6,
    TN_EVENT_CALIB_DONE    = 7,
} tn_event_type_t;

typedef struct __attribute__((packed)) {
    uint32_t magic;              /* TN_MAGIC_EVENT */
    uint8_t  version;
    uint8_t  node_id;
    uint8_t  event_type;         /* tn_event_type_t */
    uint8_t  severity;           /* 0=info 1=warn 2=alert */
    float    confidence;         /* 0..1 */
    float    value;              /* event-specific magnitude */
    uint32_t timestamp_ms;
    uint32_t sequence;
} tn_event_packet_t;

_Static_assert(sizeof(tn_event_packet_t) == 24,
               "tn_event_packet_t must be exactly 24 bytes");

#ifdef __cplusplus
}
#endif
