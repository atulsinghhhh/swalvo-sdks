package io.swalvo.rtc

/*
 * Live transcription and AI voice agents (phase6-contracts.md §4, §8).
 * Mirrors the web SDK's `transcriptionSegment`, `transcriptionStateChanged`
 * and `agentStateChanged` room events.
 */

/** Identity prefix of an AI voice agent the platform put in the room (phase6 §1). */
internal const val AGENT_IDENTITY_PREFIX: String = "agent-"

/** Identity prefix of the platform's transcriber bot (phase6 §1). */
internal const val TRANSCRIBER_IDENTITY_PREFIX: String = "transcriber-"

/**
 * One live caption (phase6 §4.1), delivered with [RoomEvent.TranscriptionSegment].
 *
 * Interim segments ([isFinal] false) share a [segmentId] and replace each
 * other; the final one for that id closes it. A final with an empty [text]
 * means the provider withdrew the interim: clear it and show nothing.
 */
public data class TranscriptionSegment(
    /** The transcription this segment belongs to; null for an agent's own speech when no transcription runs. */
    val transcriptionId: String?,
    /** Set when the segment is an AI agent's own speech. */
    val agentId: String?,
    /** Who was speaking (an agent's identity for its own speech). */
    val participantId: String,
    val segmentId: String,
    val text: String,
    /** The wire's `final`. */
    val isFinal: Boolean,
    val language: String,
    /** Milliseconds from the transcription's start. */
    val startMs: Long,
    val endMs: Long,
)

/** A transcription's lifecycle status (phase6 §4.3). */
public enum class TranscriptionStatus(public val wire: String) {
    STARTING("STARTING"), ACTIVE("ACTIVE"), STOPPING("STOPPING"), ENDED("ENDED"), FAILED("FAILED");

    public companion object {
        internal fun fromWire(value: String): TranscriptionStatus? = entries.firstOrNull { it.wire == value }
    }
}

/** The room's transcription changed status (phase6 §4.3), delivered with [RoomEvent.TranscriptionStateChanged]. */
public data class TranscriptionState(
    val transcriptionId: String,
    val status: TranscriptionStatus,
    val language: String,
)

/** What an AI voice agent is doing (phase6 §4.2). */
public enum class AgentState(public val wire: String) {
    LISTENING("listening"), THINKING("thinking"), SPEAKING("speaking"), ENDED("ended");

    public companion object {
        internal fun fromWire(value: String): AgentState? = entries.firstOrNull { it.wire == value }
    }
}
