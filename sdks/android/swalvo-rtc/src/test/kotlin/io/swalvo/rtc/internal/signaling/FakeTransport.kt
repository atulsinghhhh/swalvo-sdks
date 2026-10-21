package io.swalvo.rtc.internal.signaling

import io.swalvo.rtc.internal.Base64Url
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A WebSocket the test plays the server side of. */
internal class FakeSocket(val url: String, private val listener: WebSocketTransport.Listener) : WebSocketTransport.Connection {
    val sent = mutableListOf<String>()
    var closedWith: Int? = null
    private var gone = false

    // --- server side ---
    fun open() = listener.onOpen()
    fun receive(json: String) = listener.onMessage(json)
    fun serverClose(code: Int, reason: String = "") {
        if (gone) return
        gone = true
        listener.onClosed(code, reason)
    }
    fun drop() {
        if (gone) return
        gone = true
        listener.onFailure(java.io.IOException("connection reset"))
    }

    // --- client side ---
    override fun send(text: String): Boolean {
        if (gone) return false
        sent += text
        return true
    }

    override fun close(code: Int, reason: String) {
        closedWith = code
        if (gone) return
        gone = true
        listener.onClosed(code, reason) // OkHttp reports our own close back through onClosed
    }

    fun sentObjects(): List<JsonObject> = sent.map { Json.parseToJsonElement(it).jsonObject }
    fun sentTypes(): List<String> = sentObjects().map { it["type"]!!.jsonPrimitive.content }
    val token: String get() = java.net.URLDecoder.decode(url.substringAfter("token="), "UTF-8")
}

internal class FakeTransport : WebSocketTransport {
    val sockets = mutableListOf<FakeSocket>()
    val last: FakeSocket get() = sockets.last()

    override fun open(url: String, listener: WebSocketTransport.Listener): WebSocketTransport.Connection =
        FakeSocket(url, listener).also { sockets += it }
}

/** An unsigned JWT-shaped RTC token. The client only ever reads claims, never verifies. */
internal fun testToken(sub: String = "me", rid: String = "room_123", exp: Long? = null, extra: String = ""): String {
    val header = Base64Url.encode("""{"alg":"HS256","typ":"JWT"}""".toByteArray())
    val expPart = exp?.let { ""","exp":$it""" } ?: ""
    val payload = Base64Url.encode("""{"sub":"$sub","rid":"$rid","rnm":"standup"$expPart$extra}""".toByteArray())
    return "$header.$payload.sig"
}
