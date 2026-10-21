package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** HOST and CO_HOST get identical grants; the difference is bookkeeping, not permissions. */
public enum LiveStreamHostRole {
    @JsonProperty("HOST")
    HOST,
    @JsonProperty("CO_HOST")
    CO_HOST,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
