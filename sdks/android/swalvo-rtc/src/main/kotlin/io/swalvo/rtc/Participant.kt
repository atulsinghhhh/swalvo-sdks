package io.swalvo.rtc

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** Per-participant events, for UI that only cares about one person (web: `participant.on(...)`). */
public sealed class ParticipantEvent {
    public data class IsSpeakingChanged(val speaking: Boolean) : ParticipantEvent()
    public data class ConnectionQualityChanged(val quality: ConnectionQuality) : ParticipantEvent()
    /** phase7 §2: [Participant.metadata] or [Participant.attributes] changed; these are the old values. */
    public data class MetadataChanged(
        val previousMetadata: String?,
        val previousAttributes: Map<String, String>,
    ) : ParticipantEvent()
}

public abstract class Participant internal constructor(identity: String) {
    private var identityValue: String = identity

    /** The `sub` claim of this participant's token. */
    public val identity: String get() = identityValue

    private val speaking = MutableStateFlow(false)
    private val level = MutableStateFlow(0f)
    private val quality = MutableStateFlow(ConnectionQuality.UNKNOWN)
    private val eventFlow = MutableSharedFlow<ParticipantEvent>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    public val isSpeakingFlow: StateFlow<Boolean> = speaking.asStateFlow()
    public val audioLevelFlow: StateFlow<Float> = level.asStateFlow()
    public val connectionQualityFlow: StateFlow<ConnectionQuality> = quality.asStateFlow()
    public val events: SharedFlow<ParticipantEvent> = eventFlow.asSharedFlow()

    public val isSpeaking: Boolean get() = speaking.value
    /** 0..1, from the SFU's active-speaker detection. */
    public val audioLevel: Float get() = level.value
    public val connectionQuality: ConnectionQuality get() = quality.value

    private val metadataState = MutableStateFlow<String?>(null)
    private val attributesState = MutableStateFlow<Map<String, String>>(emptyMap())

    /** phase7 §2: opaque application data (at most 4 KiB), from the token and later updates. Null when unset. */
    public val metadata: String? get() = metadataState.value
    /** phase7 §2: key/value application data (at most 32 keys). Empty when unset. */
    public val attributes: Map<String, String> get() = attributesState.value
    public val metadataFlow: StateFlow<String?> = metadataState.asStateFlow()
    public val attributesFlow: StateFlow<Map<String, String>> = attributesState.asStateFlow()

    /**
     * Applies new values (null leaves a field as it is). Returns the old
     * values when something actually changed, else null. Emits
     * [ParticipantEvent.MetadataChanged] on a change.
     */
    internal fun applyMetadata(metadata: String?, clearMetadata: Boolean, attributes: Map<String, String>?): Pair<String?, Map<String, String>>? {
        val previous = metadataState.value to attributesState.value
        val nextMetadata = if (clearMetadata) null else metadata ?: previous.first
        val nextAttributes = attributes ?: previous.second
        if (nextMetadata == previous.first && nextAttributes == previous.second) return null
        metadataState.value = nextMetadata
        attributesState.value = nextAttributes.toMap()
        eventFlow.tryEmit(ParticipantEvent.MetadataChanged(previous.first, previous.second))
        return previous
    }

    /** phase6 §1: an AI voice agent the platform put in the room (identity prefix `agent-`). */
    public val isAgent: Boolean get() = identityValue.startsWith(AGENT_IDENTITY_PREFIX)

    /** phase6 §1: the platform's transcriber bot (identity prefix `transcriber-`). It never publishes. */
    public val isTranscriber: Boolean get() = identityValue.startsWith(TRANSCRIBER_IDENTITY_PREFIX)

    private val agentStateValue = MutableStateFlow<AgentState?>(null)

    /** phase6 §4.2: an agent's last reported state; null for anyone who is not an agent, or before the first report. */
    public val agentState: AgentState? get() = agentStateValue.value
    public val agentStateFlow: StateFlow<AgentState?> = agentStateValue.asStateFlow()

    internal fun setAgentState(state: AgentState) {
        agentStateValue.value = state
    }

    internal fun setIdentity(value: String) {
        identityValue = value
    }

    internal fun setSpeaking(isSpeaking: Boolean, audioLevel: Float) {
        level.value = audioLevel
        if (speaking.value != isSpeaking) {
            speaking.value = isSpeaking
            eventFlow.tryEmit(ParticipantEvent.IsSpeakingChanged(isSpeaking))
        }
    }

    /** Returns true when the score actually changed. */
    internal fun setConnectionQuality(value: ConnectionQuality): Boolean {
        if (quality.value == value) return false
        quality.value = value
        eventFlow.tryEmit(ParticipantEvent.ConnectionQualityChanged(value))
        return true
    }

    override fun toString(): String = "${this::class.simpleName}($identity)"
}

public class LocalParticipant internal constructor(identity: String) : Participant(identity) {
    internal val trackList = mutableListOf<LocalTrack>()
    public val tracks: List<LocalTrack> get() = trackList.toList()

    /** Set by the room: sends `participant.update`. */
    internal var updater: (suspend (metadata: String?, attributes: Map<String, String>?) -> Unit)? = null

    /**
     * Replaces this participant's metadata for everyone in the room
     * (phase7 §2), at most 4 KiB of UTF-8. Needs the token grant
     * `perms.updateOwnMetadata`; throws [RtcErrorCode.PERMISSION_DENIED]
     * without it and [RtcErrorCode.INVALID_ARGUMENT] past the limit.
     *
     * Not applied optimistically: [metadata] changes (and
     * [RoomEvent.ParticipantMetadataChanged] fires) when the server's
     * `participant.updated` comes back.
     */
    public suspend fun setMetadata(metadata: String) {
        val send = updater ?: throw RtcException(RtcErrorCode.CONNECTION_FAILED, "setMetadata() requires a connected room")
        send(metadata, null)
    }

    /**
     * Sets these attribute keys for everyone in the room (phase7 §2);
     * keys not named keep their values. At most 32 keys, 64-character keys
     * and 1 KiB values. Same permission and timing rules as [setMetadata].
     */
    public suspend fun setAttributes(attributes: Map<String, String>) {
        val send = updater ?: throw RtcException(RtcErrorCode.CONNECTION_FAILED, "setAttributes() requires a connected room")
        send(null, attributes)
    }
}

public class RemoteParticipant internal constructor(identity: String) : Participant(identity) {
    internal val trackList = mutableListOf<RemoteTrack>()
    public val tracks: List<RemoteTrack> get() = trackList.toList()
}
