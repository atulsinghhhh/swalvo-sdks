package com.swalvo.server.internal;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.swalvo.server.SwalvoException;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.Set;

/**
 * The one place this SDK speaks HTTP to the Control API. Every resource goes through here; not one of them
 * builds a request of its own.
 *
 * <p><b>Internal.</b> Not part of the public API and may change in any release.
 *
 * <p>The API key lives in a private field and nowhere else. There's no getter, {@link #toString()} leaves it
 * out, and any error built from a response has the key scrubbed from its message and details.
 */
public final class HttpCore {

    public static final String DEFAULT_BASE_URL = "http://localhost:4100";
    public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(10);
    public static final int DEFAULT_MAX_RETRIES = 2;
    static final long BASE_RETRY_DELAY_MS = 300;
    private static final Set<Integer> RETRYABLE_STATUS_CODES = Set.of(429, 502, 503, 504);
    private static final String REDACTED = "[REDACTED]";

    /** Shared, fully configured mapper: unknown fields ignored, unknown enum values mapped to UNRECOGNIZED. */
    public static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .configure(DeserializationFeature.READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE, true)
            .configure(SerializationFeature.FAIL_ON_EMPTY_BEANS, false)
            .setDefaultPropertyInclusion(
                    // Unset request fields are left out, like JSON.stringify drops undefined; null values
                    // inside a metadata map are kept, exactly as given.
                    JsonInclude.Value.construct(JsonInclude.Include.NON_NULL, JsonInclude.Include.ALWAYS));

    private final String apiKey;
    private final String baseUrl;
    private final Duration timeout;
    private final int maxRetries;
    private final String userAgent;
    private final HttpClient http;

    public HttpCore(String apiKey, String baseUrl, Duration timeout, int maxRetries, String userAgent, HttpClient http) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        this.userAgent = userAgent;
        this.http = http != null
                ? http
                : HttpClient.newBuilder()
                        .connectTimeout(timeout)
                        // HTTP/1.1 only: over plain http the default HTTP/2 client sends an
                        // "Upgrade: h2c" request, which the API's WebSocket upgrade handler
                        // takes and drops, so every call failed as a network error.
                        .version(HttpClient.Version.HTTP_1_1)
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .build();
    }

    public String baseUrl() {
        return baseUrl;
    }

    /** Never returns the API key, so this object is safe to log. */
    @Override
    public String toString() {
        return "SwalvoHttpClient(" + baseUrl + ")";
    }

    public <T> T get(String path, Map<String, ?> query, JavaType type) {
        return request("GET", path, query, null, type, true);
    }

    public <T> T send(String method, String path, Object body, JavaType type) {
        return request(method, path, null, body, type, true);
    }

    /**
     * Sends one request, retrying network errors, timeouts and 429/502/503/504 with exponential backoff from
     * 300 ms, up to {@code maxRetries} times. Pass {@code retryable=false} for a request that must never be
     * retried, transient failure or not.
     *
     * @param type the response type, or {@code null} to discard the body
     * @return the decoded body, or {@code null} for a 204 or when {@code type} is null
     */
    public <T> T request(String method, String path, Map<String, ?> query, Object body, JavaType type, boolean retryable) {
        URI uri = URI.create(baseUrl + path + encodeQuery(query));
        HttpRequest.BodyPublisher publisher;
        try {
            publisher = body == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofByteArray(MAPPER.writeValueAsBytes(body));
        } catch (JsonProcessingException e) {
            throw new SwalvoException("Could not serialize the request body", "RAVEN_INVALID_REQUEST", null, null, null, e);
        }
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(timeout)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header("User-Agent", userAgent)
                .method(method, publisher)
                .build();

        int attempt = 0;
        while (true) {
            HttpResponse<byte[]> response;
            try {
                response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
            } catch (IOException e) {
                boolean isTimeout = e instanceof HttpTimeoutException;
                if (retryable && attempt < maxRetries) {
                    sleep(BASE_RETRY_DELAY_MS << attempt);
                    attempt++;
                    continue;
                }
                throw new SwalvoException(
                        isTimeout ? "Request timed out after " + timeout.toMillis() + "ms" : "Could not reach the Swalvo API",
                        isTimeout ? "RAVEN_TIMEOUT" : "RAVEN_NETWORK_ERROR",
                        null, null, null, e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new SwalvoException("Request was interrupted", "RAVEN_NETWORK_ERROR", null, null, null, e);
            }

            int status = response.statusCode();
            String requestId = response.headers().firstValue("x-request-id").orElse(null);

            if (status == 204) {
                return null;
            }

            JsonNode payload = parse(response.body());

            if (status >= 200 && status < 300) {
                if (type == null || payload == null || payload.isNull() || type.getRawClass() == Void.class) {
                    return null;
                }
                try {
                    return MAPPER.convertValue(payload, type);
                } catch (IllegalArgumentException e) {
                    throw new SwalvoException(
                            "Could not decode the Swalvo API response", "RAVEN_INVALID_RESPONSE", status, requestId, null, e);
                }
            }

            if (retryable && RETRYABLE_STATUS_CODES.contains(status) && attempt < maxRetries) {
                sleep(BASE_RETRY_DELAY_MS << attempt);
                attempt++;
                continue;
            }

            throw mapErrorResponse(status, payload, requestId);
        }
    }

    private SwalvoException mapErrorResponse(int status, JsonNode payload, String requestId) {
        JsonNode safe = redact(payload);
        String message = extractMessage(safe);
        if (message == null) {
            message = "Request failed with status " + status;
        }
        String code = extractCode(safe);
        if (code == null) {
            code = codeForStatus(status);
        }
        Object details = safe == null ? null : MAPPER.convertValue(safe, Object.class);
        return new SwalvoException(message, code, status, requestId, details, null);
    }

    /** Same names the API returns, so a 401 is RAVEN_AUTH_ERROR whether the code came from the body or here. */
    static String codeForStatus(int status) {
        if (status == 401) return "RAVEN_AUTH_ERROR";
        if (status == 403) return "RAVEN_PERMISSION_DENIED";
        if (status == 404) return "RAVEN_NOT_FOUND";
        if (status == 429) return "RAVEN_RATE_LIMITED";
        if (status >= 500) return "RAVEN_INTERNAL_ERROR";
        return "VALIDATION_ERROR";
    }

    private static String extractMessage(JsonNode payload) {
        if (payload == null || !payload.isObject()) return null;
        JsonNode message = payload.get("message");
        if (message == null) return null;
        if (message.isTextual()) return message.asText();
        if (message.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode item : message) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(item.isTextual() ? item.asText() : item.toString());
            }
            return sb.toString();
        }
        return null;
    }

    private static String extractCode(JsonNode payload) {
        if (payload == null || !payload.isObject()) return null;
        JsonNode code = payload.get("code");
        return code != null && code.isTextual() ? code.asText() : null;
    }

    /** Belt and braces: should a server ever echo the key back, it never reaches an exception. */
    private JsonNode redact(JsonNode payload) {
        if (payload == null) return null;
        String raw = payload.toString();
        if (!raw.contains(apiKey)) return payload;
        String escapedKey = MAPPER.getNodeFactory().textNode(apiKey).toString();
        escapedKey = escapedKey.substring(1, escapedKey.length() - 1);
        try {
            return MAPPER.readTree(raw.replace(escapedKey, REDACTED).replace(apiKey, REDACTED));
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static JsonNode parse(byte[] body) {
        if (body == null || body.length == 0) return null;
        try {
            return MAPPER.readTree(body);
        } catch (IOException e) {
            return null;
        }
    }

    /** {@code application/x-www-form-urlencoded}, the same encoding {@code URLSearchParams} produces. Nulls are omitted. */
    static String encodeQuery(Map<String, ?> query) {
        if (query == null || query.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, ?> entry : query.entrySet()) {
            Object value = entry.getValue();
            if (value == null) continue;
            sb.append(sb.length() == 0 ? '?' : '&')
                    .append(URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(wireString(value), StandardCharsets.UTF_8));
        }
        return sb.toString();
    }

    /** Enums go out as their JSON wire value (e.g. {@code 15m}), everything else via {@code toString()}. */
    static String wireString(Object value) {
        if (value instanceof Enum<?>) {
            return MAPPER.convertValue(value, String.class);
        }
        return String.valueOf(value);
    }

    /**
     * Percent-encodes one path segment exactly like JavaScript's {@code encodeURIComponent}: everything but
     * {@code A-Z a-z 0-9 - _ . ! ~ * ' ( )} is escaped as UTF-8.
     */
    public static String segment(String value) {
        if (value == null) {
            throw new IllegalArgumentException("path parameter must not be null");
        }
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder(bytes.length);
        for (byte b : bytes) {
            int c = b & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\''
                    || c == '(' || c == ')') {
                sb.append((char) c);
            } else {
                sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
            }
        }
        return sb.toString();
    }

    public static JavaType type(Class<?> raw) {
        return MAPPER.getTypeFactory().constructType(raw);
    }

    public static JavaType listOf(Class<?> element) {
        return MAPPER.getTypeFactory().constructCollectionType(java.util.List.class, element);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SwalvoException("Request was interrupted", "RAVEN_NETWORK_ERROR", null, null, null, e);
        }
    }
}
