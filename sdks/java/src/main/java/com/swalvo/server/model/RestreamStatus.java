package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** An RTMP/RTMPS destination's status. */
public enum RestreamStatus {
    @JsonProperty("IDLE")
    IDLE,
    @JsonProperty("CONNECTING")
    CONNECTING,
    @JsonProperty("ACTIVE")
    ACTIVE,
    @JsonProperty("RETRYING")
    RETRYING,
    @JsonProperty("FAILED")
    FAILED,
    @JsonProperty("STOPPED")
    STOPPED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
