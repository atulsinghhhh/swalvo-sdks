package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A chat token scope. Scopes only ever narrow what the user's role allows. */
public enum ChatScope {
    @JsonProperty("chat:read")
    READ,
    @JsonProperty("chat:send")
    SEND,
    @JsonProperty("chat:moderate")
    MODERATE,
    @JsonProperty("chat:manage")
    MANAGE,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
