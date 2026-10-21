package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A project's lifecycle status. */
public enum ProjectStatus {
    @JsonProperty("ACTIVE")
    ACTIVE,
    @JsonProperty("ARCHIVED")
    ARCHIVED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
