package io.swalvo.rtc.internal.signaling

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * The seam between the signaling state machine and a real socket, so the
 * state machine can be driven by a fake in JVM tests.
 *
 * Callbacks may arrive on any thread; [SignalingClient] hops them onto its
 * own confined dispatcher.
 */
internal interface WebSocketTransport {
    fun open(url: String, listener: Listener): Connection

    interface Connection {
        /** Returns false if the frame could not be queued (socket closing or closed). */
        fun send(text: String): Boolean
        fun close(code: Int, reason: String)
    }

    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        /** The socket closed, cleanly or otherwise. Called at most once, never after [onFailure]. */
        fun onClosed(code: Int, reason: String)
        /** The socket failed: before opening (unreachable) or after (dropped, 1006). */
        fun onFailure(error: Throwable)
    }
}

/** OkHttp-backed transport. One client per SDK client, reused across reconnects. */
internal class OkHttpWebSocketTransport(
    private val client: OkHttpClient = defaultClient(),
) : WebSocketTransport {

    override fun open(url: String, listener: WebSocketTransport.Listener): WebSocketTransport.Connection {
        val request = Request.Builder().url(url).build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // Complete the closing handshake; onClosed follows.
                webSocket.close(1000, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onFailure(t)
        })
        return object : WebSocketTransport.Connection {
            override fun send(text: String): Boolean = socket.send(text)
            override fun close(code: Int, reason: String) {
                if (!socket.close(code, reason)) socket.cancel()
            }
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            // The server pings every 30 s; our own pings detect a dead
            // network sooner than TCP would on a phone.
            .pingInterval(15, TimeUnit.SECONDS)
            .build()
    }
}
