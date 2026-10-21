package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** The role a stream credential was minted for. */
public enum StreamCredentialRole {
    @JsonProperty("HOST")
    HOST,
    @JsonProperty("CO_HOST")
    CO_HOST,
    @JsonProperty("VIEWER")
    VIEWER,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
