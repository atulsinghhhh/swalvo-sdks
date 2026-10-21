package io.swalvo.rtc.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * A foreground service that keeps an ongoing call alive while the app is in
 * the background: without one, Android stops camera and microphone capture
 * (and, from Android 14, refuses MediaProjection) once the activity leaves
 * the screen.
 *
 * Declared in the SDK manifest with `foregroundServiceType`
 * `camera|microphone|mediaProjection|phoneCall`. Start it before publishing,
 * stop it after `room.leave()`:
 *
 * ```kotlin
 * SwalvoCallService.start(context, SwalvoCallService.Config(title = "Call with Ada", camera = true, microphone = true))
 * // …
 * SwalvoCallService.stop(context)
 * ```
 *
 * Start it with `screenShare = true` **before** calling
 * `room.enableScreenShare(...)` on Android 14+.
 */
public class SwalvoCallService : Service() {

    /** What the notification says and which foreground-service types to claim. */
    public data class Config(
        val title: String = "Call in progress",
        val text: String = "",
        val smallIcon: Int = android.R.drawable.sym_call_outgoing,
        val camera: Boolean = false,
        val microphone: Boolean = true,
        val screenShare: Boolean = false,
        /** Shown when the user taps the notification. */
        val contentIntent: android.app.PendingIntent? = null,
        val channelId: String = DEFAULT_CHANNEL,
        val channelName: String = "Calls",
    )

    public companion object {
        // legacy: notification channel id kept so existing installs keep the user's channel settings.
        public const val DEFAULT_CHANNEL: String = "livqeno_calls"
        public const val NOTIFICATION_ID: Int = 0x4C51
        private var pendingConfig: Config = Config()

        public fun start(context: Context, config: Config = Config()) {
            pendingConfig = config
            ContextCompat.startForegroundService(context, Intent(context, SwalvoCallService::class.java))
        }

        public fun stop(context: Context) {
            context.stopService(Intent(context, SwalvoCallService::class.java))
        }

        internal fun serviceTypes(config: Config): Int {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
            var types = 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                if (config.camera) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                if (config.microphone) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (config.screenShare) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
            return types
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val config = pendingConfig
        ensureChannel(config)
        val notification: Notification = NotificationCompat.Builder(this, config.channelId)
            .setContentTitle(config.title)
            .setContentText(config.text)
            .setSmallIcon(config.smallIcon)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(config.contentIntent)
            .build()
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes(config))
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun ensureChannel(config: Config) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(config.channelId) == null) {
            manager.createNotificationChannel(
                NotificationChannel(config.channelId, config.channelName, NotificationManager.IMPORTANCE_LOW),
            )
        }
    }
}
