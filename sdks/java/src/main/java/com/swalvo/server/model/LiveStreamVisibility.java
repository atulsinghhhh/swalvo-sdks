package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Who may watch a stream. */
public enum LiveStreamVisibility {
    @JsonProperty("PUBLIC")
    PUBLIC,
    @JsonProperty("PRIVATE")
    PRIVATE,
    @JsonProperty("AUTHENTICATED")
    AUTHENTICATED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
