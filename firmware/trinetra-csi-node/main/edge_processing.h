/**
 * On-node sensing: presence, motion, breathing, heart rate, posture, falls.
 *
 * This is the layer that makes a TriNetra node useful with the server
 * switched off. Everything here is deterministic DSP over the CSI phase
 * and amplitude time series — no model weights, no inference.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "csi_collector.h"
#include "trinetra_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Length of the per-subcarrier phase/amplitude history ring.
 *  256 samples at ~20 Hz = 12.8 s — two full cycles of the slowest
 *  breathing rate we claim to detect (6 BPM). */
#define TN_EDGE_HISTORY 256

typedef struct {
    bool     presence;
    bool     motion;
    bool     fall;
    bool     calibrating;
    uint8_t  posture;            /* tn_posture_t */
    uint8_t  n_persons;

    float    breathing_bpm;      /* 0 if no confident estimate */
    float    heart_bpm;
    float    breathing_conf;     /* 0..1 */
    float    heart_conf;         /* 0..1 */

    float    motion_energy;      /* 0..1 */
    float    presence_score;     /* 0..1 */
    float    signal_quality;     /* 0..1 */
    float    variance;           /* raw amplitude variance */
    float    phase_accel;        /* |d2 phase / dt2|, drives fall detection */
    float    sample_rate_hz;

    uint32_t frames_processed;
    uint32_t calib_remaining;
} tn_edge_state_t;

/** Event emitted by the processing step, or type 0 for none. */
typedef struct {
    uint8_t type;                /* tn_event_type_t, 0 = none */
    uint8_t severity;
    float   confidence;
    float   value;
} tn_edge_event_t;

/**
 * @param calib_seconds  Ambient calibration window. During this period the
 *                       node learns the empty-room baseline and reports
 *                       calibrating=true. ~30 s is the practical minimum.
 */
void tn_edge_init(float calib_seconds);

/** Discard the learned baseline and re-enter calibration. */
void tn_edge_recalibrate(void);

/**
 * Feed one CSI frame. Returns the updated state. `out_event` receives a
 * discrete event if one fired this frame (type 0 otherwise).
 */
const tn_edge_state_t *tn_edge_process(const tn_csi_frame_t *frame,
                                       tn_edge_event_t *out_event);

const tn_edge_state_t *tn_edge_state(void);

/** Fill a wire-format vitals packet from the current state. */
void tn_edge_fill_vitals(tn_vitals_packet_t *pkt, uint8_t node_id);

#ifdef __cplusplus
}
#endif
