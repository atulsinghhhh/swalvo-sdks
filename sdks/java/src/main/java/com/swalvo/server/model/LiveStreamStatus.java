package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A live stream's lifecycle. ENDED is terminal. */
public enum LiveStreamStatus {
    @JsonProperty("CREATED")
    CREATED,
    @JsonProperty("STARTING")
    STARTING,
    @JsonProperty("LIVE")
    LIVE,
    @JsonProperty("ENDING")
    ENDING,
    @JsonProperty("ENDED")
    ENDED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
