#include "stream_sender.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>

#include "esp_log.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"

static const char *TAG = "tn_stream";

static int                s_sock = -1;
static struct sockaddr_in s_target;
static tn_stream_stats_t  s_stats;
static uint8_t            s_txbuf[TN_CSI_MAX_PACKET];

bool tn_stream_init(const char *target_ip, uint16_t target_port)
{
    if (s_sock >= 0) tn_stream_deinit();

    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) {
        ESP_LOGE(TAG, "socket() failed: errno %d", errno);
        return false;
    }

    /* Non-blocking: a full transmit buffer must never stall the sensing
     * task. Dropping the frame is the correct behaviour. */
    int flags = fcntl(s_sock, F_GETFL, 0);
    fcntl(s_sock, F_SETFL, flags | O_NONBLOCK);

    memset(&s_stats, 0, sizeof(s_stats));
    return tn_stream_set_target(target_ip, target_port);
}

bool tn_stream_set_target(const char *target_ip, uint16_t target_port)
{
    if (target_ip == NULL || target_ip[0] == '\0') return false;

    memset(&s_target, 0, sizeof(s_target));
    s_target.sin_family = AF_INET;
    s_target.sin_port   = htons(target_port);

    if (inet_pton(AF_INET, target_ip, &s_target.sin_addr) != 1) {
        /* Not a literal address — try DNS. */
        struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM };
        struct addrinfo *res = NULL;
        if (getaddrinfo(target_ip, NULL, &hints, &res) != 0 || res == NULL) {
            ESP_LOGE(TAG, "cannot resolve target '%s'", target_ip);
            return false;
        }
        s_target.sin_addr = ((struct sockaddr_in *)res->ai_addr)->sin_addr;
        freeaddrinfo(res);
    }

    ESP_LOGI(TAG, "streaming to %s:%u", target_ip, (unsigned)target_port);
    return true;
}

void tn_stream_deinit(void)
{
    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
}

static bool send_raw(const void *buf, size_t len)
{
    if (s_sock < 0) return false;

    const int sent = sendto(s_sock, buf, len, 0,
                            (struct sockaddr *)&s_target, sizeof(s_target));
    if (sent < 0) {
        /* ENOMEM/EAGAIN under load is expected and not worth logging per
         * packet — it would flood the console at exactly the moment the
         * system is already struggling. */
        s_stats.send_errors++;
        return false;
    }
    s_stats.packets_sent++;
    s_stats.bytes_sent += (uint32_t)sent;
    return true;
}

bool tn_stream_send_csi(const tn_csi_frame_t *frame, uint8_t node_id, uint8_t flags)
{
    if (frame == NULL || frame->n_subcarriers == 0) return false;

    const uint16_t payload = frame->raw_len;
    const size_t   total   = TN_CSI_HEADER_LEN + payload;
    if (total > sizeof(s_txbuf)) return false;

    tn_csi_header_t h;
    memset(&h, 0, sizeof(h));
    h.magic         = TN_MAGIC_CSI;
    h.version       = TN_PROTOCOL_VERSION;
    h.node_id       = node_id;
    h.n_antennas    = 1;
    h.ppdu_type     = frame->ppdu_type;
    h.n_subcarriers = frame->n_subcarriers;
    h.freq_mhz      = frame->freq_mhz;
    h.sequence      = frame->sequence;
    h.rssi          = frame->rssi;
    h.noise_floor   = frame->noise_floor;
    h.timestamp_ms  = frame->timestamp_ms;
    h.flags         = flags;
    h.channel       = frame->channel;

    tn_csi_stats_t cs;
    tn_csi_get_stats(&cs);
    h.rate_hz_x10 = (uint16_t)(cs.measured_rate_hz * 10.0f);

    memcpy(s_txbuf, &h, TN_CSI_HEADER_LEN);
    memcpy(s_txbuf + TN_CSI_HEADER_LEN, frame->raw, payload);

    return send_raw(s_txbuf, total);
}

bool tn_stream_send_vitals(const tn_vitals_packet_t *pkt)
{
    return pkt ? send_raw(pkt, sizeof(*pkt)) : false;
}

bool tn_stream_send_status(const tn_status_packet_t *pkt)
{
    return pkt ? send_raw(pkt, sizeof(*pkt)) : false;
}

bool tn_stream_send_event(const tn_event_packet_t *pkt)
{
    return pkt ? send_raw(pkt, sizeof(*pkt)) : false;
}

void tn_stream_get_stats(tn_stream_stats_t *out)
{
    if (out) *out = s_stats;
}
