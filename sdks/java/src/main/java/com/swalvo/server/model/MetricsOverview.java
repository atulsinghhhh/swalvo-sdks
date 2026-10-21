package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** Real aggregate metrics for one range. Null rates mean there's no data yet, not zero. */
public record MetricsOverview(
        String range,
        int activeRooms,
        int activeParticipants,
        int connections,
        Double connectionSuccessRate,
        Double reconnectionRate,
        Double averageConnectionDurationMs,
        int errors) {
}
