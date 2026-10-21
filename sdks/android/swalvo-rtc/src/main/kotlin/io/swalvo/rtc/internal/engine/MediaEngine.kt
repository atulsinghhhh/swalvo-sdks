package io.swalvo.rtc.internal.engine

import io.swalvo.rtc.E2eeState
import io.swalvo.rtc.LocalTrack
import io.swalvo.rtc.RemoteMediaHandle
import io.swalvo.rtc.RtcException

/** Peer-connection state in the stack's own vocabulary, reduced to what the room acts on. */
internal enum class PeerState { NEW, CONNECTING, CONNECTED, DISCONNECTED, FAILED, CLOSED }

/**
 * The media side of a room, as the (pure) [RoomController] sees it. The
 * production implementation is [PeerConnectionEngine] over libwebrtc; tests
 * use a fake. Every method is called on the room's confined scope, and every
 * [Listener] callback must be delivered on it too.
 */
internal interface MediaEngine {
    interface Listener {
        /** A remote track arrived. [trackId] is the SDP `msid` track id, null when the SDP did not say. */
        fun onRemoteMedia(trackId: String?, handle: RemoteMediaHandle)
        fun onPeerState(state: PeerState)
        /** A local track stopped being sent for a reason of its own (capture ended, screen share revoked). */
        fun onLocalTrackEnded(track: LocalTrack)
        fun onLocalTrackPublished(track: LocalTrack)
        fun onLocalTrackUnpublished(track: LocalTrack)
        fun onDataReceived(payload: ByteArray)
        fun onMediaError(error: RtcException)
        fun onE2eeState(participantId: String, state: E2eeState)
    }

    val peerState: PeerState
    val hasPeerConnection: Boolean
    val publishedTracks: List<LocalTrack>

    /** Answers an SFU offer (initial, renegotiation or ICE restart). Queued behind any negotiation in flight. */
    fun applyOffer(sdp: String)
    fun applyAnswer(sdp: String)
    /** Buffered until a remote description exists. */
    fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?)
    /** phase2 §5 dynacast: set `encodings[i].active` on the sender of [trackId]. */
    fun applyPublisherLayers(trackId: String, layers: List<Pair<String, Boolean>>)
    /** Drops the PeerConnection (a fresh, non-resumed session follows). Local tracks are kept for [restorePublications]. */
    fun discardConnection()
    /** Re-adds every local track to a new PeerConnection and re-declares it with `track.publish`. */
    fun restorePublications()
    suspend fun unpublish(track: LocalTrack)
    /** A remote track was attributed to [participantId] (used to attach E2EE decryption). */
    fun onSubscribed(handle: RemoteMediaHandle, participantId: String)
    /** phase7 §1.1: opens `raven-data` and `raven-data-lossy` (protocol `raven.v2`) unless already open. */
    fun openDataChannels()
    fun close()
}
