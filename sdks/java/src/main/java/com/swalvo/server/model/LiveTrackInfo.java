package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** One track a live participant is publishing. */
public record LiveTrackInfo(
        String sid,
        TrackKind kind,
        String name,
        boolean muted) {
}
