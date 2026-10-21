package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** The audio an encoder is sending, as observed. */
public record IngressInputAudio(
        String codec,
        Integer sampleRate,
        Integer channels,
        Integer bitrateKbps) {
}
