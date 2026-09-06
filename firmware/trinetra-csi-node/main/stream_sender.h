/**
 * UDP transmit path: CSI frames, vitals, status, events -> sensing server.
 *
 * Fire-and-forget UDP by design. Sensing data is a real-time stream: a
 * retransmitted frame from 400 ms ago is worse than useless, it is
 * misleading. Loss is handled by the receiver interpolating, not by us
 * resending.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "csi_collector.h"
#include "trinetra_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t packets_sent;
    uint32_t bytes_sent;
    uint32_t send_errors;
} tn_stream_stats_t;

bool tn_stream_init(const char *target_ip, uint16_t target_port);
void tn_stream_deinit(void);

/** Retarget at runtime (server moved / provisioning update). */
bool tn_stream_set_target(const char *target_ip, uint16_t target_port);

bool tn_stream_send_csi(const tn_csi_frame_t *frame, uint8_t node_id, uint8_t flags);
bool tn_stream_send_vitals(const tn_vitals_packet_t *pkt);
bool tn_stream_send_status(const tn_status_packet_t *pkt);
bool tn_stream_send_event(const tn_event_packet_t *pkt);

void tn_stream_get_stats(tn_stream_stats_t *out);

#ifdef __cplusplus
}
#endif
