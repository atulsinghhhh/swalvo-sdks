package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The Control API's stored connection-record lifecycle, not a live RTCPeerConnection state. */
public enum ConnectionSummaryState {
    @JsonProperty("CONNECTING")
    CONNECTING,
    @JsonProperty("CONNECTED")
    CONNECTED,
    @JsonProperty("RECONNECTING")
    RECONNECTING,
    @JsonProperty("DISCONNECTED")
    DISCONNECTED,
    @JsonProperty("FAILED")
    FAILED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
