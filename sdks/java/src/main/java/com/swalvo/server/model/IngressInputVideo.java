package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** The video an encoder is sending, as observed. */
public record IngressInputVideo(
        String codec,
        Integer width,
        Integer height,
        Double fps,
        Integer bitrateKbps,
        Double keyframeIntervalSec) {
}
