package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** An ICE server to hand to the client SDK untouched. */
public record IceServer(
        String urls,
        String username,
        String credential) {
}
