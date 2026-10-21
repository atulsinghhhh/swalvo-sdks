package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** Project-scoped diagnostics: dependency health plus active connections. */
public record ProjectDiagnostics(
        ProjectRef project,
        /** Always {@code up}. */
        String api,
        /** Always {@code ok}. */
        String authentication,
        Dependencies dependencies,
        ActiveConnections connections) {

    /** The project these diagnostics are for. */
    public record ProjectRef(String id, String name) {}

    /** Health of each platform dependency. */
    public record Dependencies(DependencyStatus signaling, DependencyStatus sfu, DependencyStatus turn) {}

    /** This project's real active-connection count. */
    public record ActiveConnections(int active) {}
}
