idf_component_register(
    SRCS
        "main.c"
        "dsp.c"
        "csi_collector.c"
        "edge_processing.c"
        "stream_sender.c"
        "node_config.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        esp_wifi
        esp_event
        esp_netif
        esp_timer
        nvs_flash
        lwip
        driver
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Wno-unused-parameter -ffast-math)
