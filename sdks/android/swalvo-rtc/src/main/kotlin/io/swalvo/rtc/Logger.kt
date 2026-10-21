package io.swalvo.rtc

public enum class LogLevel { VERBOSE, DEBUG, INFO, WARN, ERROR, SILENT }

/** Where SDK logs go. Defaults to logcat; replace to route them elsewhere. */
public fun interface LogSink {
    public fun log(level: LogLevel, message: String, throwable: Throwable?)
}

internal class Logger(private val level: LogLevel, private val sink: LogSink) {
    fun d(message: String) = emit(LogLevel.DEBUG, message, null)
    fun i(message: String) = emit(LogLevel.INFO, message, null)
    fun w(message: String, t: Throwable? = null) = emit(LogLevel.WARN, message, t)
    fun e(message: String, t: Throwable? = null) = emit(LogLevel.ERROR, message, t)

    private fun emit(at: LogLevel, message: String, t: Throwable?) {
        if (level == LogLevel.SILENT || at.ordinal < level.ordinal) return
        sink.log(at, message, t)
    }

    companion object {
        val SILENT = Logger(LogLevel.SILENT) { _, _, _ -> }

        /** Logcat, resolved reflectively-free but guarded so JVM unit tests (stubbed android.jar) never crash. */
        val LOGCAT: LogSink = LogSink { level, message, t ->
            try {
                when (level) {
                    LogLevel.VERBOSE -> android.util.Log.v(TAG, message, t)
                    LogLevel.DEBUG -> android.util.Log.d(TAG, message, t)
                    LogLevel.INFO -> android.util.Log.i(TAG, message, t)
                    LogLevel.WARN -> android.util.Log.w(TAG, message, t)
                    LogLevel.ERROR -> android.util.Log.e(TAG, message, t)
                    LogLevel.SILENT -> Unit
                }
            } catch (_: Throwable) {
                // Not on a device.
            }
        }

        const val TAG = "SwalvoRTC"
    }
}
