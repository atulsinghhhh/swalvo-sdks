package com.swalvo.server;

import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.resources.ChatResource;
import com.swalvo.server.resources.ConnectionsResource;
import com.swalvo.server.resources.DiagnosticsResource;
import com.swalvo.server.resources.ErrorsResource;
import com.swalvo.server.resources.LiveStreamsResource;
import com.swalvo.server.resources.MetricsResource;
import com.swalvo.server.resources.ProjectsResource;
import com.swalvo.server.resources.RoomsResource;
import com.swalvo.server.resources.TokensResource;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Locale;

/**
 * Swalvo's server SDK. For your backend only; never a browser, desktop or mobile app.
 *
 * <p>Authenticates with a permanent project API key. Never expose that key, or an instance of this class,
 * to a client. The client gets a short-lived token that <i>this</i> SDK mints.
 *
 * <pre>{@code
 * Swalvo client = Swalvo.builder()
 *         .apiKey(System.getenv("SWALVO_API_KEY"))
 *         .baseUrl(System.getenv("SWALVO_API_URL")) // https://api.livqeno.com
 *         .build();
 * IssuedToken token = client.tokens().create(
 *         CreateTokenParams.builder().room(roomId).identity("user-42").build());
 * }</pre>
 *
 * <p>Instances are immutable and thread-safe; create one and share it.
 */
public final class Swalvo {

    /** This SDK's version. Kept in sync with {@code pom.xml} by hand. */
    public static final String VERSION = "0.1.0";

    /** Sent on every request. */
    public static final String USER_AGENT = "Swalvo-Server-SDK/" + VERSION + " (java)";

    private final HttpCore http;
    private final ProjectsResource projects;
    private final TokensResource tokens;
    private final RoomsResource rooms;
    private final ConnectionsResource connections;
    private final ErrorsResource errors;
    private final MetricsResource metrics;
    private final DiagnosticsResource diagnostics;
    private final ChatResource chat;
    private final LiveStreamsResource liveStreams;

    private Swalvo(HttpCore http) {
        this.http = http;
        this.projects = new ProjectsResource(http);
        this.tokens = new TokensResource(http);
        this.rooms = new RoomsResource(http);
        this.connections = new ConnectionsResource(http);
        this.errors = new ErrorsResource(http);
        this.metrics = new MetricsResource(http);
        this.diagnostics = new DiagnosticsResource(http);
        this.chat = new ChatResource(http);
        this.liveStreams = new LiveStreamsResource(http);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** The project this API key belongs to. */
    public ProjectsResource projects() {
        return projects;
    }

    /** Mint short-lived RTC tokens. */
    public TokensResource tokens() {
        return tokens;
    }

    public RoomsResource rooms() {
        return rooms;
    }

    public ConnectionsResource connections() {
        return connections;
    }

    public ErrorsResource errors() {
        return errors;
    }

    public MetricsResource metrics() {
        return metrics;
    }

    public DiagnosticsResource diagnostics() {
        return diagnostics;
    }

    /** Swalvo Chat: mint browser tokens, manage conversations, post server-side messages. */
    public ChatResource chat() {
        return chat;
    }

    /** Swalvo Live Streaming: create streams, register hosts, mint viewer credentials. */
    public LiveStreamsResource liveStreams() {
        return liveStreams;
    }

    /** {@link #liveStreams()} under the shorter name. The very same object, not a wrapper. */
    public LiveStreamsResource live() {
        return liveStreams;
    }

    /** The API host this client talks to. */
    public String baseUrl() {
        return http.baseUrl();
    }

    /** Never includes the API key, so the client is safe to log. */
    @Override
    public String toString() {
        return "Swalvo(" + http.baseUrl() + ")";
    }

    /** Builds a {@link Swalvo} client. Only {@link #apiKey(String)} is required. */
    public static final class Builder {
        private String apiKey;
        private String baseUrl;
        private Duration timeout = HttpCore.DEFAULT_TIMEOUT;
        private int maxRetries = HttpCore.DEFAULT_MAX_RETRIES;
        private HttpClient httpClient;

        private Builder() {}

        /**
         * Required. A project API key ({@code rvk_....secret}). Never hardcode it; read it from your own
         * configuration. The SDK never reads it from the environment implicitly.
         */
        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        /**
         * Defaults to {@code http://localhost:4100} (local dev). Override it for any real deployment.
         * Required in production: see {@link #build()}.
         */
        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        /** Per-attempt request timeout, default 10 s. Nothing here hangs forever. */
        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        /** Max retry attempts for transient failures (network errors, timeouts, 429/502/503/504). Default 2. */
        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        /**
         * Optional: your own {@link HttpClient}, e.g. to configure a proxy or an executor. Configure it not to
         * follow redirects, so the {@code Authorization} header never goes to another host.
         */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        /**
         * @throws SwalvoException {@code RAVEN_INVALID_CONFIG} when the API key is missing, the timeout or
         *     retry count is invalid, or {@code baseUrl} is omitted in production. Production means any of
         *     the {@code swalvo.env} system property, or the {@code SWALVO_ENV} (legacy: {@code RAVEN_ENV},
         *     {@code LIVQENO_ENV}) or {@code NODE_ENV} environment variables, is {@code production}.
         */
        public Swalvo build() {
            if (apiKey == null || apiKey.isBlank()) {
                throw new SwalvoException(
                        "apiKey is required; pass your Swalvo project API key, e.g. .apiKey(System.getenv(\"SWALVO_API_KEY\"))",
                        "RAVEN_INVALID_CONFIG");
            }
            boolean hasBaseUrl = baseUrl != null && !baseUrl.isBlank();
            if (!hasBaseUrl && isProduction()) {
                throw new SwalvoException(
                        "baseUrl is required outside local development. Pass your Swalvo API host, e.g. "
                                + ".baseUrl(\"https://api.livqeno.com\") (or your self-hosted deployment's URL); "
                                + "omitting it defaults to " + HttpCore.DEFAULT_BASE_URL
                                + ", which does not exist in production.",
                        "RAVEN_INVALID_CONFIG");
            }
            if (timeout == null || timeout.isZero() || timeout.isNegative()) {
                throw new SwalvoException("timeout must be a positive duration", "RAVEN_INVALID_CONFIG");
            }
            if (maxRetries < 0) {
                throw new SwalvoException("maxRetries must be 0 or more", "RAVEN_INVALID_CONFIG");
            }
            String url = hasBaseUrl ? baseUrl.trim() : HttpCore.DEFAULT_BASE_URL;
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                throw new SwalvoException("baseUrl must start with http:// or https://", "RAVEN_INVALID_CONFIG");
            }
            url = url.replaceAll("/+$", "");
            return new Swalvo(new HttpCore(apiKey, url, timeout, maxRetries, USER_AGENT, httpClient));
        }

        /** Never echoes the API key. */
        @Override
        public String toString() {
            return "Swalvo.Builder(" + (baseUrl == null ? HttpCore.DEFAULT_BASE_URL : baseUrl) + ")";
        }

        private static boolean isProduction() {
            String property = System.getProperty("swalvo.env");
            if (property == null) {
                property = System.getProperty("livqeno.env"); // legacy pre-rename property name
            }
            return isProd(property) || isProd(envWithLegacyFallback("ENV")) || isProd(System.getenv("NODE_ENV"));
        }

        /**
         * Reads {@code SWALVO_<name>}, falling back to the pre-rename {@code RAVEN_<name>} and then
         * {@code LIVQENO_<name>}; using a legacy name prints one deprecation notice per process.
         */
        private static String envWithLegacyFallback(String name) {
            String value = System.getenv("SWALVO_" + name);
            if (value != null && !value.isEmpty()) return value;
            for (String legacy : new String[] {"RAVEN_" + name, "LIVQENO_" + name}) {
                value = System.getenv(legacy);
                if (value != null && !value.isEmpty()) {
                    if (LEGACY_ENV_WARNED.compareAndSet(false, true)) {
                        System.err.println("swalvo: " + legacy + " is deprecated; set SWALVO_" + name + " instead");
                    }
                    return value;
                }
            }
            return null;
        }

        private static final java.util.concurrent.atomic.AtomicBoolean LEGACY_ENV_WARNED =
                new java.util.concurrent.atomic.AtomicBoolean();

        private static boolean isProd(String value) {
            return value != null && value.trim().toLowerCase(Locale.ROOT).equals("production");
        }
    }
}
