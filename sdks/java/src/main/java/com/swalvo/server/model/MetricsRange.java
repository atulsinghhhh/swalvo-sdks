package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The window {@code metrics().get(range)} aggregates over. */
public enum MetricsRange {
    @JsonProperty("15m")
    LAST_15_MINUTES,
    @JsonProperty("1h")
    LAST_HOUR,
    @JsonProperty("24h")
    LAST_24_HOURS,
    @JsonProperty("7d")
    LAST_7_DAYS,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
