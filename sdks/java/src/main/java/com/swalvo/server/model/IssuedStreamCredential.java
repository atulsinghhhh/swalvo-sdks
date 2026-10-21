package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** Credentials for a host, co-host or viewer of a stream. */
public record IssuedStreamCredential(
        /** The stream's id ({@code stream_...}). Forward it straight to {@code LiveStream.join()}. */
        String streamId,
        String identity,
        StreamCredentialRole role,
        /** Null on a BROADCAST viewer's playback credential (see {@code playback}). */
        IssuedToken rtc,
        IssuedChatToken chat,
        String chatRootMessageId,
        /** The stream's public id. Edge placement for a cascaded viewer is carried by the {@code rtc} token itself, never here. Null on a playback credential. */
        String rtcRoom,
        /** Set on a BROADCAST viewer's credential minted with {@code acceptPlayback}. */
        StreamPlayback playback) {
}
