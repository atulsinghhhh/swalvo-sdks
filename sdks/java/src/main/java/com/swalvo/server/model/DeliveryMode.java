package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** How the audience receives a stream: {@code RTC_ONLY} over WebRTC, {@code BROADCAST} over HLS. */
public enum DeliveryMode {
    @JsonProperty("RTC_ONLY")
    RTC_ONLY,
    @JsonProperty("BROADCAST")
    BROADCAST,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
