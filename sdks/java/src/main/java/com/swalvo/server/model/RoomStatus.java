package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A room's status. {@code rooms().delete()} soft-closes to CLOSED. */
public enum RoomStatus {
    @JsonProperty("ACTIVE")
    ACTIVE,
    @JsonProperty("CLOSED")
    CLOSED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
