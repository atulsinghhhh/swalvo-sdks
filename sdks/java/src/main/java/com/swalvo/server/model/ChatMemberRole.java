package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A member's role in a conversation. */
public enum ChatMemberRole {
    @JsonProperty("MEMBER")
    MEMBER,
    @JsonProperty("MODERATOR")
    MODERATOR,
    @JsonProperty("ADMIN")
    ADMIN,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
