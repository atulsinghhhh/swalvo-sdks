package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** What kind of conversation this is. */
public enum ChatConversationType {
    @JsonProperty("ROOM")
    ROOM,
    @JsonProperty("CHANNEL")
    CHANNEL,
    @JsonProperty("DIRECT")
    DIRECT,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
