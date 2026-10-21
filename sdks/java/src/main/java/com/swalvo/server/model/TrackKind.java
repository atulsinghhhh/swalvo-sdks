package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A live track's media kind. */
public enum TrackKind {
    @JsonProperty("audio")
    AUDIO,
    @JsonProperty("video")
    VIDEO,
    @JsonProperty("unknown")
    UNKNOWN,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
