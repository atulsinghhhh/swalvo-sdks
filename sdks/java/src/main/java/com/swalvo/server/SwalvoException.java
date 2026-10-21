package com.swalvo.server;

/**
 * The only exception type this SDK throws for API, transport and configuration failures.
 *
 * <p>Built purely from the parsed response body ({@code {"message", "code"}}, matching {@code AppError} on
 * the API side) plus response metadata. Never from anything that carries the API key, and the client
 * additionally scrubs the key out of the message and details should a server ever echo it back. It never
 * carries a server stack trace, a database error, or TURN/RTC credentials.
 *
 * <p>Branch on {@link #getCode()}, never on the message:
 *
 * <pre>{@code
 * try {
 *     client.rooms().get(roomId);
 * } catch (SwalvoException e) {
 *     if ("RAVEN_ROOM_NOT_FOUND".equals(e.getCode())) { ... }
 * }
 * }</pre>
 *
 * <p>Codes produced by the SDK itself: {@code RAVEN_INVALID_CONFIG}, {@code RAVEN_TIMEOUT},
 * {@code RAVEN_NETWORK_ERROR}. When a proxy strips the JSON body, the code is derived from the HTTP status:
 * {@code RAVEN_AUTH_ERROR} (401), {@code RAVEN_PERMISSION_DENIED} (403), {@code RAVEN_NOT_FOUND} (404),
 * {@code RAVEN_RATE_LIMITED} (429), {@code RAVEN_INTERNAL_ERROR} (5xx), otherwise {@code VALIDATION_ERROR}.
 */
public class SwalvoException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String code;
    private final Integer statusCode;
    private final String requestId;
    private final transient Object details;

    public SwalvoException(String message, String code) {
        this(message, code, null, null, null, null);
    }

    public SwalvoException(
            String message, String code, Integer statusCode, String requestId, Object details, Throwable cause) {
        super(message, cause);
        this.code = code != null ? code : "RAVEN_UNKNOWN_ERROR";
        this.statusCode = statusCode;
        this.requestId = requestId;
        this.details = details;
    }

    /** The API's error code, e.g. {@code RAVEN_ROOM_NOT_FOUND}. Never null. */
    public String getCode() {
        return code;
    }

    /** The HTTP status, or {@code null} for config, timeout and network errors. */
    public Integer getStatusCode() {
        return statusCode;
    }

    /** The {@code x-request-id} the API sent, for a bug report. May be null. */
    public String getRequestId() {
        return requestId;
    }

    /**
     * The parsed error body as plain Java values ({@code Map}, {@code List}, {@code String}, numbers,
     * booleans), or {@code null} when there was no JSON body.
     */
    public Object getDetails() {
        return details;
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("SwalvoException[code=").append(code);
        if (statusCode != null) {
            sb.append(", status=").append(statusCode);
        }
        if (requestId != null) {
            sb.append(", requestId=").append(requestId);
        }
        return sb.append("]: ").append(getMessage()).toString();
    }
}
