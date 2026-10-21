package io.swalvo.rtc

/**
 * Every event a [Room] emits, collected from [Room.events]. Names match the
 * web SDK's `room.on(...)` events one for one
 * (apps/docs/content/rtc/events.mdx), plus [E2eeStateChanged] (phase5 §3.2).
 */
public sealed class RoomEvent {
    // Connection
    public data class ConnectionStateChanged(val state: ConnectionState) : RoomEvent()
    public data object Connected : RoomEvent()
    /** The connection ended and will not be reconnected. Never rejoin automatically after REMOVED or ROOM_CLOSED. */
    public data class Disconnected(val reason: DisconnectReason) : RoomEvent()
    public data object Reconnecting : RoomEvent()
    /** Back. Your tracks are already being sent again; nothing to redo. */
    public data object Reconnected : RoomEvent()
    public data class Warning(val warning: RtcWarning) : RoomEvent()

    // Participants (other people only)
    public data class ParticipantJoined(val participant: RemoteParticipant) : RoomEvent()
    public data class ParticipantLeft(val participant: RemoteParticipant) : RoomEvent()

    // Other people's tracks
    public data class TrackPublished(val kind: TrackKind, val participant: RemoteParticipant) : RoomEvent()
    public data class TrackUnpublished(val kind: TrackKind, val participant: RemoteParticipant) : RoomEvent()
    /** Media has arrived: render it now (not on [TrackPublished]). */
    public data class TrackSubscribed(val track: RemoteTrack, val participant: RemoteParticipant) : RoomEvent()
    public data class TrackUnsubscribed(val track: RemoteTrack, val participant: RemoteParticipant) : RoomEvent()
    public data class TrackMuted(val kind: TrackKind, val participant: RemoteParticipant) : RoomEvent()
    public data class TrackUnmuted(val kind: TrackKind, val participant: RemoteParticipant) : RoomEvent()

    // Speaking, quality, paused video (phase2)
    /** Loudest first, at most 8, possibly including you. Empty means silence. */
    public data class ActiveSpeakersChanged(val speakers: List<Participant>) : RoomEvent()
    public data class ConnectionQualityChanged(val participant: Participant, val quality: ConnectionQuality) : RoomEvent()
    /** Read `track.subscriptionState` and `track.layer`. */
    public data class TrackSubscriptionStateChanged(val track: RemoteTrack, val participant: RemoteParticipant) : RoomEvent()

    // Your own tracks
    public data class LocalTrackPublished(val track: LocalTrack) : RoomEvent()
    public data class LocalTrackUnpublished(val track: LocalTrack) : RoomEvent()
    /** The server muted one of your tracks; it is already muted locally. Unmuting stays the user's call. */
    public data class LocalTrackMutedByServer(val track: LocalTrack) : RoomEvent()
    public data class PermissionsChanged(val permissions: ParticipantPermissions) : RoomEvent()

    /** phase7 §2: someone's (or your own) metadata or attributes changed. [previousMetadata] and [previousAttributes] are the old values. */
    public data class ParticipantMetadataChanged(
        val participant: Participant,
        val previousMetadata: String?,
        val previousAttributes: Map<String, String>,
    ) : RoomEvent()

    // Data and errors
    /**
     * A data message (phase7 §1). [participant] is the sender as the SFU
     * stamped it, or null for a message from the server
     * (`POST /v1/rooms/:roomId/data`), from an older server that does not
     * stamp senders, or from someone who has already left. [topic] is null
     * when the sender gave none.
     */
    public class DataReceived(
        public val payload: ByteArray,
        public val participant: RemoteParticipant?,
        public val topic: String? = null,
    ) : RoomEvent()

    /** phase7 §1.4: the SFU dropped some of your data messages on [channel] for going over the rate limit. */
    public data class DataThrottled(val channel: DataChannelKind) : RoomEvent()
    public data class Error(val error: RtcException) : RoomEvent()

    // E2EE
    public data class E2eeStateChanged(val participant: Participant, val state: E2eeState) : RoomEvent()

    // Live transcription and AI voice agents (phase6 §4, §8)
    /**
     * A live caption (web: `transcriptionSegment`). Interim segments share a
     * `segmentId` and replace each other; the final one closes it. An empty
     * final means "clear the interim".
     */
    public data class TranscriptionSegment(val segment: io.swalvo.rtc.TranscriptionSegment) : RoomEvent()
    /** The room's transcription changed status (web: `transcriptionStateChanged`). */
    public data class TranscriptionStateChanged(val state: TranscriptionState) : RoomEvent()
    /**
     * An AI voice agent is listening, thinking, speaking, or has ended (web:
     * `agentStateChanged`). Also readable as [Participant.agentState]. A state
     * that arrives before the agent's `participant.joined` is held and
     * delivered right after [ParticipantJoined].
     */
    public data class AgentStateChanged(val participant: Participant, val state: AgentState) : RoomEvent()
}
