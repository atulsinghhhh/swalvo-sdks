package com.swalvo.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.Executors;

/** A scripted local HTTP server: queue responses, then inspect what the SDK sent. Never a real API. */
final class MockServer implements AutoCloseable {

    static final ObjectMapper JSON = new ObjectMapper();

    record Recorded(String method, String path, String rawQuery, Map<String, String> headers, String body) {
        String header(String name) {
            return headers.get(name.toLowerCase());
        }

        JsonNode json() {
            try {
                return body.isEmpty() ? null : JSON.readTree(body);
            } catch (IOException e) {
                throw new AssertionError("request body was not JSON: " + body, e);
            }
        }

        String pathAndQuery() {
            return rawQuery == null ? path : path + "?" + rawQuery;
        }
    }

    record Scripted(int status, String body, Map<String, String> headers, Duration delay) {}

    private final HttpServer server;
    private final ConcurrentLinkedDeque<Scripted> script = new ConcurrentLinkedDeque<>();
    private final List<Recorded> requests = Collections.synchronizedList(new ArrayList<>());

    MockServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "mock-server");
            t.setDaemon(true);
            return t;
        }));
        server.createContext("/", exchange -> {
            byte[] in = exchange.getRequestBody().readAllBytes();
            Map<String, String> headers = new LinkedHashMap<>();
            exchange.getRequestHeaders().forEach((k, v) -> headers.put(k.toLowerCase(), String.join(",", v)));
            requests.add(new Recorded(exchange.getRequestMethod(), exchange.getRequestURI().getRawPath(),
                    exchange.getRequestURI().getRawQuery(), headers, new String(in, StandardCharsets.UTF_8)));
            Scripted next = script.pollFirst();
            if (next == null) {
                next = new Scripted(500, "{\"code\":\"TEST_UNSCRIPTED\",\"message\":\"no response scripted\"}", Map.of(), Duration.ZERO);
            }
            try {
                if (!next.delay().isZero()) {
                    Thread.sleep(next.delay().toMillis());
                }
                next.headers().forEach((k, v) -> exchange.getResponseHeaders().add(k, v));
                if (next.status() == 204) {
                    exchange.sendResponseHeaders(204, -1);
                } else {
                    byte[] out = next.body() == null ? new byte[0] : next.body().getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().add("Content-Type", "application/json");
                    exchange.sendResponseHeaders(next.status(), out.length == 0 ? -1 : out.length);
                    if (out.length > 0) {
                        try (OutputStream os = exchange.getResponseBody()) {
                            os.write(out);
                        }
                    }
                }
            } catch (InterruptedException | IOException e) {
                // The client gave up (timeout test); nothing to do.
            } finally {
                exchange.close();
            }
        });
        server.start();
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    MockServer respond(int status, String body) {
        return respond(status, body, Map.of());
    }

    MockServer respond(int status, String body, Map<String, String> headers) {
        script.addLast(new Scripted(status, body, headers, Duration.ZERO));
        return this;
    }

    MockServer respondAfter(Duration delay, int status, String body) {
        script.addLast(new Scripted(status, body, Map.of(), delay));
        return this;
    }

    List<Recorded> requests() {
        synchronized (requests) {
            return List.copyOf(requests);
        }
    }

    Recorded last() {
        List<Recorded> all = requests();
        if (all.isEmpty()) throw new AssertionError("no request was made");
        return all.get(all.size() - 1);
    }

    Swalvo client() {
        return client("rvk_test.secret");
    }

    Swalvo client(String apiKey) {
        return Swalvo.builder().apiKey(apiKey).baseUrl(url()).build();
    }

    static JsonNode json(String raw) {
        try {
            return JSON.readTree(raw);
        } catch (IOException e) {
            throw new AssertionError(e);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
