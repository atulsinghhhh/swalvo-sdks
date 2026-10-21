package com.swalvo.server.model;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import com.fasterxml.jackson.annotation.JsonProperty;

/** How Swalvo classifies an RTC error. Never a raw SFU or coturn error code. */
public enum ErrorCategory {
    @JsonProperty("AUTHENTICATION_ERROR")
    AUTHENTICATION_ERROR,
    @JsonProperty("AUTHORIZATION_ERROR")
    AUTHORIZATION_ERROR,
    @JsonProperty("TOKEN_ERROR")
    TOKEN_ERROR,
    @JsonProperty("SIGNALING_ERROR")
    SIGNALING_ERROR,
    @JsonProperty("ICE_ERROR")
    ICE_ERROR,
    @JsonProperty("TURN_ERROR")
    TURN_ERROR,
    @JsonProperty("SFU_ERROR")
    SFU_ERROR,
    @JsonProperty("NETWORK_ERROR")
    NETWORK_ERROR,
    @JsonProperty("CLIENT_ERROR")
    CLIENT_ERROR,
    @JsonProperty("UNKNOWN_ERROR")
    UNKNOWN_ERROR,
    /** A value added to the API after this SDK version; upgrade the SDK to see it. Never send it. */
    @JsonEnumDefaultValue
    UNRECOGNIZED
}
