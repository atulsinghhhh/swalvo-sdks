package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A conversation's status. */
public enum ChatConversationStatus {
    @JsonProperty("ACTIVE")
    ACTIVE,
    @JsonProperty("ARCHIVED")
    ARCHIVED,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
