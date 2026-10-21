package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The HLS audience path's status. RTC_ONLY streams always report NOT_APPLICABLE. */
public enum LiveStreamDeliveryStatus {
    @JsonProperty("NOT_APPLICABLE")
    NOT_APPLICABLE,
    @JsonProperty("NOT_STARTED")
    NOT_STARTED,
    @JsonProperty("STARTING")
    STARTING,
    @JsonProperty("READY")
    READY,
    @JsonProperty("FAILED")
    FAILED,
    @JsonProperty("ENDED")
    ENDED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
