package com.swalvo.server.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Defensive, immutable copies for request objects. Null in, null out. */
final class Copies {
    private Copies() {}

    static <T> List<T> list(List<T> value) {
        return value == null ? null : List.copyOf(value);
    }

    /** Keeps null values: metadata maps go out exactly as given. */
    static Map<String, Object> map(Map<String, ?> value) {
        return value == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(value));
    }

    static <T> T required(T value, String name) {
        if (value == null) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
