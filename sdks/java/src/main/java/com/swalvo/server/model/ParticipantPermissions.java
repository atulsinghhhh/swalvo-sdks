package com.swalvo.server.model;

/** A connected participant's merged live permissions, as {@code rooms().participants().updatePermissions()} returns them. */
public record ParticipantPermissions(
        boolean subscribe,
        boolean publish,
        boolean publishAudio,
        boolean publishVideo,
        boolean publishScreen,
        boolean publishData) {
}
