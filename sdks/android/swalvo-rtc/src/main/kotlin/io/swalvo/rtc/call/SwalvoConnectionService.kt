package io.swalvo.rtc.call

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.annotation.RequiresApi
import androidx.annotation.RequiresPermission
import java.util.concurrent.ConcurrentHashMap

/**
 * Integrates Swalvo calls with the system's Telecom stack as a
 * *self-managed* ConnectionService (API 26+): the OS then knows a call is in
 * progress (audio focus, Bluetooth/car controls, other apps' calls put on
 * hold, the lock-screen incoming-call UI on some devices).
 *
 * The SDK provides the plumbing; your app decides what answering means
 * (usually `SwalvoClient.connect(...)`). Declare the service in **your**
 * manifest; it is not merged in automatically, because binding it makes the
 * app a Telecom participant, which is the app's call. The SDK manifest
 * already merges in `MANAGE_OWN_CALLS`; the line below is harmless if kept:
 *
 * ```xml
 * <uses-permission android:name="android.permission.MANAGE_OWN_CALLS" />
 * <service
 *     android:name="io.swalvo.rtc.call.SwalvoConnectionService"
 *     android:exported="true"
 *     android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE">
 *     <intent-filter><action android:name="android.telecom.ConnectionService" /></intent-filter>
 * </service>
 * ```
 */
@RequiresApi(Build.VERSION_CODES.O)
public open class SwalvoConnectionService : ConnectionService() {

    override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest): Connection =
        createConnection(request, incoming = false)

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest): Connection =
        createConnection(request, incoming = true)

    override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        request?.extras?.getString(SwalvoCallManager.EXTRA_CALL_ID)?.let { SwalvoCallManager.listener?.onCallFailed(it) }
    }

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        request?.extras?.getString(SwalvoCallManager.EXTRA_CALL_ID)?.let { SwalvoCallManager.listener?.onCallFailed(it) }
    }

    private fun createConnection(request: ConnectionRequest, incoming: Boolean): Connection {
        val extras = request.extras ?: Bundle.EMPTY
        val callId = extras.getString(SwalvoCallManager.EXTRA_CALL_ID) ?: "call"
        val connection = SwalvoConnection(callId).apply {
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            audioModeIsVoip = true
            setCallerDisplayName(extras.getString(SwalvoCallManager.EXTRA_DISPLAY_NAME) ?: callId, TelecomManager.PRESENTATION_ALLOWED)
            setAddress(request.address ?: Uri.fromParts("swalvo", callId, null), TelecomManager.PRESENTATION_ALLOWED)
            if (extras.getBoolean(SwalvoCallManager.EXTRA_VIDEO)) setVideoState(android.telecom.VideoProfile.STATE_BIDIRECTIONAL)
            if (incoming) setRinging() else setDialing()
        }
        SwalvoCallManager.connections[callId] = connection
        SwalvoCallManager.listener?.onConnectionCreated(callId, incoming)
        return connection
    }
}

/** One Telecom call, forwarding user actions to [SwalvoCallManager.listener]. */
@RequiresApi(Build.VERSION_CODES.O)
public class SwalvoConnection internal constructor(public val callId: String) : Connection() {
    override fun onAnswer() {
        setActive()
        SwalvoCallManager.listener?.onAnswer(callId)
    }

    override fun onAnswer(videoState: Int): Unit = onAnswer()

    override fun onReject() {
        end(DisconnectCause.REJECTED)
        SwalvoCallManager.listener?.onReject(callId)
    }

    override fun onDisconnect() {
        end(DisconnectCause.LOCAL)
        SwalvoCallManager.listener?.onHangUp(callId)
    }

    override fun onAbort(): Unit = onDisconnect()

    override fun onHold() {
        setOnHold()
        SwalvoCallManager.listener?.onHold(callId, true)
    }

    override fun onUnhold() {
        setActive()
        SwalvoCallManager.listener?.onHold(callId, false)
    }

    internal fun end(cause: Int) {
        setDisconnected(DisconnectCause(cause))
        destroy()
        SwalvoCallManager.connections.remove(callId)
    }
}

/**
 * Registers the self-managed phone account and places / reports calls.
 *
 * ```kotlin
 * val calls = SwalvoCallManager(context, "Swalvo")
 * calls.register()
 * SwalvoCallManager.listener = object : SwalvoCallManager.Listener { override fun onAnswer(callId: String) { joinRoom(callId) } }
 * calls.reportIncomingCall("room_123", "Ada Lovelace", video = true)
 * // when the room connects: calls.setActive("room_123"); when it ends: calls.endCall("room_123")
 * ```
 */
@RequiresApi(Build.VERSION_CODES.O)
public class SwalvoCallManager(
    context: Context,
    private val label: String,
    serviceClass: Class<out SwalvoConnectionService> = SwalvoConnectionService::class.java,
) {
    public interface Listener {
        public fun onConnectionCreated(callId: String, incoming: Boolean) {}
        public fun onAnswer(callId: String) {}
        public fun onReject(callId: String) {}
        public fun onHangUp(callId: String) {}
        public fun onHold(callId: String, onHold: Boolean) {}
        public fun onCallFailed(callId: String) {}
    }

    public companion object {
        public const val EXTRA_CALL_ID: String = "io.swalvo.rtc.CALL_ID"
        public const val EXTRA_DISPLAY_NAME: String = "io.swalvo.rtc.DISPLAY_NAME"
        public const val EXTRA_VIDEO: String = "io.swalvo.rtc.VIDEO"

        @Volatile public var listener: Listener? = null
        internal val connections = ConcurrentHashMap<String, SwalvoConnection>()
    }

    private val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    private val handle = PhoneAccountHandle(ComponentName(context, serviceClass), "swalvo")

    /** Registers the self-managed account. Needs `MANAGE_OWN_CALLS`. */
    @Suppress("DEPRECATION") // CAPABILITY_SELF_MANAGED: still the way to declare a self-managed account below API 34's Core-Telecom.
    public fun register() {
        val account = PhoneAccount.builder(handle, label)
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED or PhoneAccount.CAPABILITY_VIDEO_CALLING or PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING)
            .build()
        telecom.registerPhoneAccount(account)
    }

    private fun extras(callId: String, displayName: String, video: Boolean) = Bundle().apply {
        putString(EXTRA_CALL_ID, callId)
        putString(EXTRA_DISPLAY_NAME, displayName)
        putBoolean(EXTRA_VIDEO, video)
    }

    /** Shows the system incoming-call flow; [Listener.onAnswer] fires when the user answers. */
    @Throws(SecurityException::class)
    public fun reportIncomingCall(callId: String, displayName: String, video: Boolean = false) {
        telecom.addNewIncomingCall(handle, extras(callId, displayName, video))
    }

    /** Tells Telecom the user started a call. Requires `MANAGE_OWN_CALLS`. */
    @Throws(SecurityException::class)
    @RequiresPermission(Manifest.permission.MANAGE_OWN_CALLS)
    public fun placeOutgoingCall(callId: String, displayName: String, video: Boolean = false) {
        val bundle = Bundle().apply {
            putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, extras(callId, displayName, video))
        }
        telecom.placeCall(Uri.fromParts("swalvo", callId, null), bundle)
    }

    /** The room connected: the call is live. */
    public fun setActive(callId: String) {
        connections[callId]?.setActive()
    }

    /** The room ended (left, removed, or failed). */
    public fun endCall(callId: String, remote: Boolean = false) {
        connections[callId]?.end(if (remote) DisconnectCause.REMOTE else DisconnectCause.LOCAL)
    }
}
