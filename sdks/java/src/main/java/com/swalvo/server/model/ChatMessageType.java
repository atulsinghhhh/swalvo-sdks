package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A chat message's type. {@code SYSTEM} can only be sent server-side. */
public enum ChatMessageType {
    @JsonProperty("text")
    TEXT,
    @JsonProperty("system")
    SYSTEM,
    @JsonProperty("event")
    EVENT,
    @JsonProperty("attachment")
    ATTACHMENT,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
