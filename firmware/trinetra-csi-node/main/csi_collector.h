/**
 * CSI capture from the ESP32 WiFi radio.
 *
 * The ESP-IDF hands us Channel State Information through an RX callback
 * that runs in the WiFi task context. That callback must be fast and must
 * not block — so it does nothing but copy into a ring buffer and signal a
 * queue. All real work happens in the processing task.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "trinetra_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

#define TN_MAX_SUBCARRIERS  TN_CSI_MAX_SUBCARRIERS
/** Frames retained for temporal analysis. 256 @ 20 Hz = 12.8 s, enough to
 *  resolve a 6 BPM breathing cycle (10 s period) with margin. */
#define TN_FRAME_HISTORY    256

/** One captured CSI frame, already converted to amplitude + phase. */
typedef struct {
    uint16_t n_subcarriers;
    uint8_t  ppdu_type;
    int8_t   rssi;
    int8_t   noise_floor;
    uint8_t  channel;
    uint16_t freq_mhz;
    uint32_t sequence;
    uint32_t timestamp_ms;
    float    amplitude[TN_MAX_SUBCARRIERS];
    float    phase[TN_MAX_SUBCARRIERS];
    int8_t   raw[2 * TN_MAX_SUBCARRIERS];   /* interleaved imag,real */
    uint16_t raw_len;
} tn_csi_frame_t;

typedef struct {
    uint32_t frames_captured;
    uint32_t frames_dropped;      /* queue full — processing not keeping up */
    uint32_t frames_rejected;     /* malformed / wrong length */
    float    measured_rate_hz;
    int8_t   last_rssi;
} tn_csi_stats_t;

/**
 * Install the CSI callback and start the capture pipeline.
 * Must be called after the WiFi driver is started and connected.
 *
 * @param filter_mac  If non-NULL, only frames from this transmitter are
 *                    kept. Filtering to your AP removes the flood of
 *                    unrelated beacon CSI that otherwise dominates and
 *                    makes the sample rate wildly irregular.
 */
bool tn_csi_start(const uint8_t *filter_mac);
void tn_csi_stop(void);

/**
 * Re-point the source filter, or pass NULL to accept every transmitter.
 *
 * The BSSID is not a constant. A dual-band router advertises one SSID from
 * two different BSSIDs, and a node that drops and reconnects can come back
 * on the other one. The filter is set at startup from whichever AP answered
 * first; without a way to update it, such a node keeps filtering for a BSSID
 * that is no longer transmitting to it and goes permanently deaf — logging
 * "CSI capture started" and then "no CSI" forever. Call this on every
 * (re)connection.
 */
void tn_csi_set_filter(const uint8_t *filter_mac);

/**
 * Block until the next frame is available, up to timeout_ms.
 * Returns false on timeout. `out` is filled by value.
 */
bool tn_csi_receive(tn_csi_frame_t *out, uint32_t timeout_ms);

void tn_csi_get_stats(tn_csi_stats_t *out);

/** Enable synthetic CSI when no radio traffic is available (bench/CI).
 *  Frames generated this way set TN_FLAG_MOCK_SOURCE so nothing
 *  downstream can mistake them for real measurements. */
void tn_csi_set_mock(bool enabled);
bool tn_csi_is_mock(void);

#ifdef __cplusplus
}
#endif
