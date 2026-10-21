package com.swalvo.server.internal;

import java.util.LinkedHashMap;
import java.util.Map;

/** <b>Internal.</b> Builds ordered JSON objects for request bodies and queries, dropping null values. */
public final class Bodies {
    private Bodies() {}

    /** {@code of("a", 1, "b", null)} is {@code {"a": 1}}. */
    public static Map<String, Object> of(Object... keysAndValues) {
        if (keysAndValues.length % 2 != 0) {
            throw new IllegalArgumentException("keysAndValues must come in pairs");
        }
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            Object value = keysAndValues[i + 1];
            if (value != null) {
                map.put((String) keysAndValues[i], value);
            }
        }
        return map;
    }
}
