package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** How an encoder pushes into a stream. */
public enum IngressProtocol {
    @JsonProperty("WHIP")
    WHIP,
    @JsonProperty("RTMP")
    RTMP,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
