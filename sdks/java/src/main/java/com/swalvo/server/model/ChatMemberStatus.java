package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A membership's status. */
public enum ChatMemberStatus {
    @JsonProperty("ACTIVE")
    ACTIVE,
    @JsonProperty("LEFT")
    LEFT,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
