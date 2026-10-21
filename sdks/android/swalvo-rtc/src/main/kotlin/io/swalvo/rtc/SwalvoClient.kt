package io.swalvo.rtc

import android.content.Context
import io.swalvo.rtc.internal.TokenClaims
import io.swalvo.rtc.internal.media.RtcFactory
import org.webrtc.Camera2Enumerator
import org.webrtc.EglBase

/**
 * The SDK's entry point (phase5 §4: `SwalvoClient` → `connect(token, endpoint)` → `Room`).
 *
 * ```kotlin
 * val client = SwalvoClient(applicationContext, SwalvoClientOptions(refreshToken = { backend.freshToken() }))
 * val room = client.connect(grant.token, grant.endpoint, grant.iceServers)
 * room.enableMicrophone()
 * room.enableCamera()
 * ```
 *
 * `token`, `endpoint` and `iceServers` come straight from your backend's
 * token-mint response. Never mint a token in the app.
 */
public class SwalvoClient(
    context: Context,
    public val options: SwalvoClientOptions = SwalvoClientOptions(),
) {
    private val appContext: Context = context.applicationContext

    /** The shared EGL context. Pass it to `SurfaceViewRenderer.init(...)` so frames render without copies. */
    public val eglBaseContext: EglBase.Context get() = RtcFactory.eglBase().eglBaseContext

    /** Camera2 device names, for [CameraOptions.deviceName]. */
    public fun cameraDevices(): List<String> = Camera2Enumerator(appContext).deviceNames.toList()

    /**
     * Joins the room [token] was minted for and returns once the server has
     * confirmed the join (`room.joined`). Media connects right after; await
     * [Room.waitUntilConnected] or watch [RoomEvent.Connected].
     *
     * [roomId] is optional because the token names its room; if given it
     * must match the token's room id or name.
     */
    public suspend fun connect(
        token: String,
        endpoint: String,
        iceServers: List<IceServer> = emptyList(),
        roomId: String? = null,
    ): Room {
        val claims = TokenClaims.decode(token)
        claims.expiresAtEpochSeconds?.let { exp ->
            if (exp * 1000 <= System.currentTimeMillis()) throw RtcException(RtcErrorCode.TOKEN_EXPIRED, "RTC token has already expired")
        }
        val tokenRoom = claims.roomId
            ?: throw RtcException(RtcErrorCode.INVALID_TOKEN, "RTC token does not name a room (no rid claim)")
        if (roomId != null && roomId != tokenRoom && roomId != claims.roomName) {
            throw RtcException(RtcErrorCode.ROOM_NOT_FOUND, "This token was minted for room $tokenRoom, not $roomId")
        }
        require(endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
            "endpoint must be the ws(s):// URL from the token-mint response"
        }
        val room = Room(appContext, options, token, endpoint, iceServers, tokenRoom, claims)
        room.connect()
        return room
    }
}
