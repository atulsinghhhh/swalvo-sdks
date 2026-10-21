package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** An ingest endpoint's status. */
public enum IngressStatus {
    @JsonProperty("IDLE")
    IDLE,
    @JsonProperty("CONNECTING")
    CONNECTING,
    @JsonProperty("PUBLISHING")
    PUBLISHING,
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
