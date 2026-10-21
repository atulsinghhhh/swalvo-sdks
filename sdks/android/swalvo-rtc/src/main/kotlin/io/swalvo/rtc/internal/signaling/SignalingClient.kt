package io.swalvo.rtc.internal.signaling

import io.swalvo.rtc.DisconnectReason
import io.swalvo.rtc.Logger
import io.swalvo.rtc.RtcErrorCode
import io.swalvo.rtc.RtcException
import io.swalvo.rtc.RtcWarning
import io.swalvo.rtc.RtcWarningCode
import io.swalvo.rtc.internal.TokenClaims
import io.swalvo.rtc.internal.protocol.ClientMessage
import io.swalvo.rtc.internal.protocol.CloseCodes
import io.swalvo.rtc.internal.protocol.ProtocolJson
import io.swalvo.rtc.internal.protocol.ResumeRequest
import io.swalvo.rtc.internal.protocol.ServerMessage
import io.swalvo.rtc.internal.protocol.SignalingErrorCodes
import io.swalvo.rtc.internal.protocol.WireParticipant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.net.URLEncoder
import kotlin.math.min
import kotlin.random.Random

/** What the room learns from a completed `room.joined`. */
internal data class JoinedPayload(
    val roomId: String,
    val participants: List<WireParticipant>,
    val rtcServer: String?,
    val region: String?,
    val clientRegion: String?,
    /** True only when this join asked to resume **and** the server said it did (signaling.md "Session resume"). */
    val resumed: Boolean,
    val e2ee: Boolean,
    /** phase7 §1.6: e.g. `data.v2`. Empty from older servers. */
    val capabilities: List<String> = emptyList(),
)

internal sealed class SignalingEvent {
    data class Joined(val payload: JoinedPayload) : SignalingEvent()
    /** Every server frame the signaling layer does not consume itself. */
    data class Message(val message: ServerMessage) : SignalingEvent()
    data class Reconnecting(val resuming: Boolean) : SignalingEvent()
    /** Terminal: the session could not continue. No reconnect follows. */
    data class Failed(val error: RtcException, val reason: DisconnectReason) : SignalingEvent()
    /** Terminal: the server ended the session on purpose (removed, room closed, replaced). */
    data class Ended(val reason: DisconnectReason) : SignalingEvent()
    /** The socket closed after [SignalingClient.close] or after a terminal event. */
    data object Closed : SignalingEvent()
    data class Warning(val warning: RtcWarning) : SignalingEvent()
}

internal class JoinFailedException(
    val error: RtcException,
    val serverCode: String? = null,
    val closeCode: Int? = null,
) : Exception(error.message, error)

/**
 * The signaling state machine: one WebSocket at a time to `/v1/rtc`,
 * `room.join` (with `resume` on a reconnect), reconnect with full-jitter
 * exponential backoff, close-code handling and live token refresh.
 *
 * A faithful port of packages/sdk/src/internal/signaling/signaling-client.ts,
 * plus the close codes the web client folds into its default path
 * (4002 "replaced" never reconnects; 4004 "node lost" reconnects without
 * resume).
 *
 * Threading: every method and every transport callback runs on [scope],
 * which must be confined to one thread (or be a test dispatcher). Transport
 * callbacks are re-posted onto it, so the state below is never touched
 * concurrently.
 */
internal class SignalingClient(
    private val options: Options,
    private val transport: WebSocketTransport,
    private val scope: CoroutineScope,
    private val logger: Logger,
    private val random: Random = Random.Default,
    private val clock: () -> Long = System::currentTimeMillis,
    private val listener: (SignalingEvent) -> Unit,
) {
    data class Options(
        /** The `endpoint` from the token-mint response, e.g. `wss://api.example.com/v1/rtc`. */
        val endpoint: String,
        val token: String,
        val roomId: String,
        val region: String? = null,
        val autoReconnect: Boolean = true,
        val refreshToken: (suspend () -> String)? = null,
        val autoSubscribe: Boolean = true,
    )

    companion object {
        const val OPEN_TIMEOUT_MS = 10_000L
        const val JOIN_TIMEOUT_MS = 15_000L
        const val RECONNECT_BASE_MS = 300L
        const val RECONNECT_MAX_MS = 10_000L
        const val RECONNECT_MAX_ATTEMPTS = 12
        /** 1012: reconnect "now", after a random 0–2 s jitter instead of the backoff (signaling.md "Graceful shutdown"). */
        const val SERVICE_RESTART_JITTER_MS = 2_000L
        /** 4029: back off at least this long before trying again. */
        const val RATE_LIMITED_MIN_DELAY_MS = 2_000L
        /** A resume token is valid for 120 s server-side; leave a margin. */
        const val RESUME_TOKEN_MAX_AGE_MS = 110_000L
        /** Refresh a token before a reconnect when it expires within this. */
        const val TOKEN_REFRESH_SKEW_MS = 30_000L
    }

    private inner class Socket(val isReconnect: Boolean) : WebSocketTransport.Listener {
        lateinit var connection: WebSocketTransport.Connection
        val opened = CompletableDeferred<Unit>()
        val joinResult = CompletableDeferred<JoinedPayload>()
        var joinSettled = false
        var joinedOnThisSocket = false
        var sentResume = false
        var gone = false

        override fun onOpen() { scope.launch { if (!opened.isCompleted) opened.complete(Unit) } }
        override fun onMessage(text: String) { scope.launch { handleFrame(this@Socket, text) } }
        override fun onClosed(code: Int, reason: String) { scope.launch { handleSocketGone(this@Socket, code) } }
        override fun onFailure(error: Throwable) {
            scope.launch {
                logger.d("signaling socket failure: ${error.message}")
                handleSocketGone(this@Socket, CloseCodes.ABNORMAL)
            }
        }
    }

    private var token: String = options.token
    private var current: Socket? = null
    private var reconnectAttempts = 0
    private var reconnectJob: Job? = null
    private var wake: CompletableDeferred<Unit>? = null
    private var closedByCaller = false
    private var joined = false
    private var resume: Pair<String, Long>? = null
    private var endedReason: DisconnectReason? = null
    private var expiredAwaitingRefresh = false
    private var pendingRefreshToken: String? = null
    private var liveRefreshInFlight = false

    val isJoined: Boolean get() = joined
    val isReconnecting: Boolean get() = !closedByCaller && !joined && reconnectAttempts > 0
    val currentToken: String get() = token
    /** The resume token held right now, if still usable. Exposed for diagnostics and tests. */
    val heldResumeToken: String? get() = usableResumeToken()
    val reconnectCount: Int get() = reconnectAttempts

    /** Opens the socket and joins. Throws [RtcException] if the first join fails; nothing is retried then. */
    suspend fun connect(): JoinedPayload {
        closedByCaller = false
        endedReason = null
        try {
            return openAndJoin(isReconnect = false)
        } catch (e: JoinFailedException) {
            closedByCaller = true
            throw e.error
        }
    }

    /** Sends a frame if the socket is open. Returns false (and drops it) otherwise, as the web SDK does. */
    fun send(message: ClientMessage): Boolean {
        val socket = current
        if (socket == null || socket.gone || !socket.opened.isCompleted) {
            logger.d("dropping signaling message, socket not open: ${message::class.simpleName}")
            return false
        }
        return socket.connection.send(ProtocolJson.encode(message))
    }

    /** Leaves for good: `room.leave`, close 1000, no reconnect. */
    fun close() {
        closedByCaller = true
        clearResume()
        reconnectJob?.cancel()
        reconnectJob = null
        val socket = current
        if (socket != null && !socket.gone && socket.opened.isCompleted) {
            send(ClientMessage.RoomLeave)
            socket.connection.close(CloseCodes.NORMAL, "client left")
        }
        joined = false
    }

    /**
     * Drops the session so the next join is a fresh one, not a resume. Used
     * when the media connection failed: resuming would hand back the same
     * dead PeerConnection.
     */
    fun rejoin() {
        if (closedByCaller) return
        clearResume()
        val socket = current
        if (joined && socket != null && !socket.gone) {
            socket.connection.close(CloseCodes.NORMAL, "client rejoin")
        }
    }

    /** Skips the remaining backoff of a pending reconnect (e.g. the network just came back). */
    fun reconnectNow() {
        wake?.complete(Unit)
    }

    // --- Connect / join -------------------------------------------------------

    private suspend fun openAndJoin(isReconnect: Boolean): JoinedPayload {
        val socket = Socket(isReconnect)
        current = socket
        socket.connection = transport.open(buildUrl(), socket)

        try {
            withTimeout(OPEN_TIMEOUT_MS) { socket.opened.await() }
        } catch (e: TimeoutCancellationException) {
            socket.gone = true
            socket.connection.close(CloseCodes.NORMAL, "open timeout")
            throw JoinFailedException(RtcException(RtcErrorCode.TIMEOUT, "Signaling connection to ${options.endpoint} timed out"))
        }

        val resumeToken = if (isReconnect) usableResumeToken() else null
        socket.sentResume = resumeToken != null
        send(
            ClientMessage.RoomJoin(
                roomId = options.roomId,
                region = options.region,
                resume = resumeToken?.let { ResumeRequest(it) },
                autoSubscribe = if (options.autoSubscribe) null else false,
            ),
        )

        return try {
            withTimeout(JOIN_TIMEOUT_MS) { socket.joinResult.await() }
        } catch (e: TimeoutCancellationException) {
            failJoin(socket, JoinFailedException(RtcException(RtcErrorCode.TIMEOUT, "The server did not confirm the room join")))
            throw JoinFailedException(RtcException(RtcErrorCode.TIMEOUT, "The server did not confirm the room join"))
        }
    }

    private fun failJoin(socket: Socket, failure: JoinFailedException) {
        if (socket.joinSettled) return
        socket.joinSettled = true
        socket.joinResult.completeExceptionally(failure)
        if (!socket.gone) {
            socket.gone = true
            socket.connection.close(CloseCodes.NORMAL, "join failed")
        }
    }

    private fun handleFrame(socket: Socket, text: String) {
        val message = ProtocolJson.decodeServer(text)
        if (message == null) {
            logger.w("ignoring unparseable signaling frame")
            return
        }
        if (!socket.joinSettled) {
            when (message) {
                is ServerMessage.RoomJoined -> {
                    socket.joinSettled = true
                    socket.joinedOnThisSocket = true
                    val payload = JoinedPayload(
                        roomId = message.roomId,
                        participants = message.participants,
                        rtcServer = message.rtcServer,
                        region = message.region,
                        clientRegion = message.clientRegion,
                        resumed = socket.isReconnect && socket.sentResume && message.resumed == true,
                        e2ee = message.e2ee == true,
                        capabilities = message.capabilities.orEmpty(),
                    )
                    storeResumeToken(message.resumeToken)
                    joined = true
                    reconnectAttempts = 0
                    logger.i((if (payload.resumed) "resumed room session " else "joined room ") + message.roomId)
                    socket.joinResult.complete(payload)
                    listener(SignalingEvent.Joined(payload))
                    return
                }
                is ServerMessage.Error -> {
                    failJoin(
                        socket,
                        JoinFailedException(toError(message.code, message.message), serverCode = message.code),
                    )
                    return
                }
                else -> Unit // e.g. a pong: fall through
            }
        }
        if (socket !== current) return
        handleMessage(message)
    }

    private fun handleSocketGone(socket: Socket, code: Int) {
        if (!socket.opened.isCompleted) {
            socket.gone = true
            socket.opened.completeExceptionally(
                JoinFailedException(
                    RtcException(RtcErrorCode.NETWORK_ERROR, "Could not reach the signaling endpoint at ${options.endpoint}"),
                    closeCode = code,
                ),
            )
            return
        }
        if (!socket.joinedOnThisSocket) {
            failJoin(
                socket,
                JoinFailedException(
                    RtcException(RtcErrorCode.SIGNALING_ERROR, "The signaling connection closed before the room was joined (code $code)"),
                    closeCode = code,
                ),
            )
            socket.gone = true
            return
        }
        if (socket.gone) return
        socket.gone = true
        if (socket !== current) return
        joined = false
        handleClose(code)
    }

    // --- Messages ---------------------------------------------------------------

    private fun handleMessage(message: ServerMessage) {
        when (message) {
            is ServerMessage.Error -> if (handleErrorFrame(message.code, message.message)) return
            is ServerMessage.RoomResumeToken -> {
                storeResumeToken(message.resumeToken)
                return
            }
            is ServerMessage.TokenExpiring -> {
                scope.launch { refreshLiveToken(message.expiresAt) }
                return
            }
            is ServerMessage.TokenRefreshed -> {
                pendingRefreshToken?.let { token = it }
                pendingRefreshToken = null
                logger.d("rtc token refreshed; session now expires at ${message.expiresAt}")
                return
            }
            is ServerMessage.RoomLeft -> handleRoomLeft(message.reason)
            is ServerMessage.Unknown -> {
                logger.d("ignoring unknown signaling message ${message.type}")
                return
            }
            else -> Unit
        }
        listener(SignalingEvent.Message(message))
    }

    /** Returns true when the error frame was consumed here. */
    private fun handleErrorFrame(code: String, text: String): Boolean {
        val canRefresh = options.refreshToken != null && options.autoReconnect
        when {
            code == SignalingErrorCodes.TOKEN_INVALID -> {
                // A refused token.refresh. Not fatal: the session carries on under the old token.
                pendingRefreshToken = null
                logger.w("the server refused the refreshed rtc token: $text")
                listener(SignalingEvent.Warning(RtcWarning(RtcWarningCode.TOKEN_REFRESH_FAILED, text)))
                return true
            }
            code == SignalingErrorCodes.ROOM_CLOSED -> {
                endedReason = DisconnectReason.ROOM_CLOSED
                return true
            }
            (code == SignalingErrorCodes.TOKEN_EXPIRED || code == SignalingErrorCodes.TOKEN_REVOKED) && canRefresh -> {
                expiredAwaitingRefresh = true
                logger.w("rtc token $code on the server; will refresh and reconnect")
                return true
            }
            code in SignalingErrorCodes.FATAL -> {
                logger.w("fatal signaling error $code: $text")
                closedByCaller = true
                clearResume()
                listener(SignalingEvent.Failed(toError(code, text), reasonForFatal(code)))
                current?.let { if (!it.gone) it.connection.close(CloseCodes.NORMAL, "fatal error") }
                return true
            }
            else -> {
                logger.w("signaling error $code: $text")
                return false
            }
        }
    }

    private fun handleRoomLeft(reason: String?) {
        if (reason == null) return // the answer to our own room.leave
        val canRefresh = options.refreshToken != null && options.autoReconnect
        if ((reason == "TOKEN_EXPIRED" || reason == "TOKEN_REVOKED") && canRefresh) {
            expiredAwaitingRefresh = true
            return
        }
        endedReason = when (reason) {
            "ROOM_CLOSED" -> DisconnectReason.ROOM_CLOSED
            "TOKEN_EXPIRED", "TOKEN_REVOKED" -> DisconnectReason.TOKEN_EXPIRED
            else -> DisconnectReason.REMOVED
        }
        clearResume()
        current?.let { if (!it.gone) it.connection.close(CloseCodes.NORMAL, "session ended by server") }
    }

    // --- Close handling and reconnect -------------------------------------------

    private fun handleClose(code: Int) {
        if (closedByCaller) {
            listener(SignalingEvent.Closed)
            return
        }

        val ended = endedReason
        if (ended != null || code == CloseCodes.REMOVED) {
            endedReason = null
            closedByCaller = true
            clearResume()
            val reason = ended ?: DisconnectReason.REMOVED
            logger.i("the server ended this session: $reason")
            listener(SignalingEvent.Ended(reason))
            return
        }

        if (code == CloseCodes.REPLACED) {
            // Another connection for this identity took over. Reconnecting would evict it.
            closedByCaller = true
            clearResume()
            listener(SignalingEvent.Ended(DisconnectReason.REPLACED))
            return
        }

        val authFailed = code == CloseCodes.AUTH_FAILED || expiredAwaitingRefresh
        if (authFailed) clearResume()
        if (code == CloseCodes.NODE_LOST) clearResume() // the SFU node is gone; nothing to resume

        if (!options.autoReconnect) {
            closedByCaller = true
            listener(
                SignalingEvent.Failed(
                    if (authFailed) {
                        RtcException(RtcErrorCode.TOKEN_EXPIRED, "The signaling connection was closed because the RTC token expired")
                    } else {
                        RtcException(RtcErrorCode.NETWORK_ERROR, "The signaling connection closed (code $code)")
                    },
                    if (authFailed) DisconnectReason.TOKEN_EXPIRED else DisconnectReason.CONNECTION_FAILED,
                ),
            )
            return
        }

        if (authFailed) {
            expiredAwaitingRefresh = false
            if (options.refreshToken == null) {
                closedByCaller = true
                listener(
                    SignalingEvent.Failed(
                        RtcException(RtcErrorCode.TOKEN_EXPIRED, "The RTC token expired. Pass refreshToken to keep long sessions alive"),
                        DisconnectReason.TOKEN_EXPIRED,
                    ),
                )
                return
            }
            scheduleReconnect(refreshFirst = true)
            return
        }

        when (code) {
            CloseCodes.SERVICE_RESTART -> {
                logger.i("signaling server restarting; reconnecting with resume")
                scheduleReconnect(serviceRestart = true)
            }
            CloseCodes.RATE_LIMITED -> scheduleReconnect(rateLimited = true)
            else -> scheduleReconnect()
        }
    }

    private fun scheduleReconnect(refreshFirst: Boolean = false, serviceRestart: Boolean = false, rateLimited: Boolean = false) {
        if (closedByCaller) return
        if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            closedByCaller = true
            listener(
                SignalingEvent.Failed(
                    RtcException(RtcErrorCode.CONNECTION_FAILED, "Could not re-establish signaling after $RECONNECT_MAX_ATTEMPTS attempts"),
                    DisconnectReason.CONNECTION_FAILED,
                ),
            )
            return
        }
        reconnectAttempts++
        val attempt = reconnectAttempts
        listener(SignalingEvent.Reconnecting(resuming = usableResumeToken() != null))

        reconnectJob = scope.launch {
            if (refreshFirst || tokenExpiresSoon()) {
                val refreshed = tryRefreshToken()
                if (closedByCaller) return@launch
                if (!refreshed && refreshFirst) logger.w("reconnecting without a fresh token; the server may reject it again")
            }

            val delayMs = reconnectDelayMs(attempt, serviceRestart, rateLimited)
            logger.i("signaling reconnect attempt $attempt in ${delayMs}ms")
            val signal = CompletableDeferred<Unit>()
            wake = signal
            withTimeoutOrNull(delayMs) { signal.await() }
            wake = null
            if (closedByCaller) return@launch

            try {
                openAndJoin(isReconnect = true)
                if (closedByCaller) current?.connection?.close(CloseCodes.NORMAL, "client left")
            } catch (e: CancellationException) {
                throw e
            } catch (e: JoinFailedException) {
                handleReconnectFailure(e)
            }
        }
    }

    /** Full jitter: anywhere in [0, backoff), so a fleet of clients does not reconnect in lockstep. */
    internal fun reconnectDelayMs(attempt: Int, serviceRestart: Boolean, rateLimited: Boolean): Long {
        if (serviceRestart) return (random.nextDouble() * SERVICE_RESTART_JITTER_MS).toLong()
        val ceiling = min(RECONNECT_BASE_MS * (1L shl (attempt - 1).coerceIn(0, 20)), RECONNECT_MAX_MS)
        val jittered = (random.nextDouble() * ceiling).toLong()
        return if (rateLimited) maxOf(jittered, RATE_LIMITED_MIN_DELAY_MS) else jittered
    }

    private fun handleReconnectFailure(error: JoinFailedException) {
        if (closedByCaller) return
        logger.w("signaling reconnect failed: ${error.message}")
        val code = error.serverCode
        when {
            (code == SignalingErrorCodes.TOKEN_EXPIRED || code == SignalingErrorCodes.TOKEN_REVOKED) && options.refreshToken != null ->
                scheduleReconnect(refreshFirst = true)
            code != null && code in SignalingErrorCodes.FATAL -> {
                closedByCaller = true
                listener(SignalingEvent.Failed(error.error, reasonForFatal(code)))
            }
            error.closeCode == CloseCodes.REMOVED || code == SignalingErrorCodes.ROOM_CLOSED -> {
                closedByCaller = true
                listener(
                    SignalingEvent.Ended(
                        if (code == SignalingErrorCodes.ROOM_CLOSED) DisconnectReason.ROOM_CLOSED else DisconnectReason.REMOVED,
                    ),
                )
            }
            error.closeCode == CloseCodes.REPLACED -> {
                closedByCaller = true
                listener(SignalingEvent.Ended(DisconnectReason.REPLACED))
            }
            else -> scheduleReconnect(
                serviceRestart = error.closeCode == CloseCodes.SERVICE_RESTART,
                rateLimited = error.closeCode == CloseCodes.RATE_LIMITED || code == SignalingErrorCodes.RATE_LIMITED,
            )
        }
    }

    // --- Tokens -------------------------------------------------------------------

    private suspend fun refreshLiveToken(expiresAt: String) {
        val refresh = options.refreshToken
        if (refresh == null) {
            logger.w("rtc token expiring at $expiresAt and no refreshToken is configured")
            listener(
                SignalingEvent.Warning(
                    RtcWarning(RtcWarningCode.TOKEN_EXPIRING, "The RTC token expires at $expiresAt and no refreshToken is configured", expiresAt),
                ),
            )
            return
        }
        if (liveRefreshInFlight) return
        liveRefreshInFlight = true
        try {
            val fresh = refresh()
            pendingRefreshToken = fresh
            send(ClientMessage.TokenRefresh(fresh))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.w("rtc token refresh failed: ${e.message}")
            listener(
                SignalingEvent.Warning(
                    RtcWarning(RtcWarningCode.TOKEN_REFRESH_FAILED, "refreshToken() failed: ${e.message}", expiresAt, e),
                ),
            )
        } finally {
            liveRefreshInFlight = false
        }
    }

    private suspend fun tryRefreshToken(): Boolean {
        val refresh = options.refreshToken ?: return false
        return try {
            token = refresh()
            pendingRefreshToken = null
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            listener(SignalingEvent.Warning(RtcWarning(RtcWarningCode.TOKEN_REFRESH_FAILED, "refreshToken() failed: ${e.message}", cause = e)))
            false
        }
    }

    private fun tokenExpiresSoon(): Boolean {
        val exp = TokenClaims.decodeOrNull(token)?.expiresAtEpochSeconds ?: return false
        return exp * 1000 - clock() < TOKEN_REFRESH_SKEW_MS
    }

    private fun storeResumeToken(value: String?) {
        if (!value.isNullOrEmpty()) resume = value to clock()
    }

    private fun usableResumeToken(): String? {
        val (value, receivedAt) = resume ?: return null
        return if (clock() - receivedAt > RESUME_TOKEN_MAX_AGE_MS) null else value
    }

    private fun clearResume() {
        resume = null
    }

    private fun buildUrl(): String {
        val base = options.endpoint.trimEnd('/')
        val sep = if (base.contains('?')) '&' else '?'
        return "$base${sep}token=${URLEncoder.encode(token, "UTF-8")}"
    }

    private fun reasonForFatal(code: String): DisconnectReason =
        if (code == SignalingErrorCodes.TOKEN_EXPIRED || code == SignalingErrorCodes.TOKEN_REVOKED) {
            DisconnectReason.TOKEN_EXPIRED
        } else {
            DisconnectReason.CONNECTION_FAILED
        }

    private fun toError(code: String, message: String): RtcException = RtcException(
        when (code) {
            SignalingErrorCodes.INVALID_TOKEN -> RtcErrorCode.INVALID_TOKEN
            SignalingErrorCodes.TOKEN_EXPIRED -> RtcErrorCode.TOKEN_EXPIRED
            SignalingErrorCodes.TOKEN_REVOKED -> RtcErrorCode.TOKEN_REVOKED
            SignalingErrorCodes.USAGE_LIMIT_EXCEEDED -> RtcErrorCode.USAGE_LIMIT_EXCEEDED
            SignalingErrorCodes.ROOM_NOT_FOUND -> RtcErrorCode.ROOM_NOT_FOUND
            SignalingErrorCodes.UNAUTHORIZED, SignalingErrorCodes.PERMISSION_DENIED, SignalingErrorCodes.ORIGIN_NOT_ALLOWED -> RtcErrorCode.PERMISSION_DENIED
            SignalingErrorCodes.ROOM_FULL, SignalingErrorCodes.NO_RTC_CAPACITY, SignalingErrorCodes.RTC_SERVER_UNREACHABLE -> RtcErrorCode.CONNECTION_FAILED
            SignalingErrorCodes.RATE_LIMITED -> RtcErrorCode.NETWORK_ERROR
            else -> RtcErrorCode.SIGNALING_ERROR
        },
        message.ifEmpty { code },
    )
}
