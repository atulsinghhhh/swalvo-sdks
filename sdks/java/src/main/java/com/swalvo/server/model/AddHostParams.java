package com.swalvo.server.model;

/**
 * Parameters for {@code liveStreams().addHost()}.
 *
 * @param role HOST and CO_HOST get identical RTC and chat grants. Null lets the API default to CO_HOST.
 */
public record AddHostParams(String identity, LiveStreamHostRole role) {

    public AddHostParams {
        Copies.required(identity, "identity");
    }

    /** A CO_HOST (the API's default). */
    public static AddHostParams of(String identity) {
        return new AddHostParams(identity, null);
    }

    public static AddHostParams of(String identity, LiveStreamHostRole role) {
        return new AddHostParams(identity, role);
    }
}
