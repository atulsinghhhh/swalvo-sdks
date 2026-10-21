import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import type { LocalParticipant, RemoteParticipant, Room, Track, TrackKind } from '@swalvo/rtc';
import { reportViewVisibility, withdrawView } from './internal/view-visibility';

export interface SwalvoVideoViewProps {
  /** Whose video to show. Local or remote; the component doesn't care. */
  participant?: LocalParticipant | RemoteParticipant;
  /**
   * The room, if you want the view keeping itself up to date as tracks get
   * published, unpublished, muted or resubscribed. Without it the view
   * renders whatever the participant held at mount and never follows
   * changes. Fine for a static thumbnail, wrong for a call.
   */
  room?: Room;
  /** `'camera'` (default) or `'screenShare'`. */
  source?: Extract<TrackKind, 'camera' | 'screenShare'>;
  style?: ViewStyle;
  /** `'cover'` (default) crops to fill, `'contain'` letterboxes. */
  objectFit?: 'cover' | 'contain';
  /**
   * Mirrors horizontally. True by default for the local camera, since
   * that's what people expect of their own preview, false for everyone
   * else.
   */
  mirror?: boolean;
  /** Stacking hint. Use 1 for a local preview floating over remote video. */
  zOrder?: number;
  /** Rendered when there's no video: muted, not published yet, or camera off. */
  placeholder?: React.ReactNode;
  /**
   * Whether this view is on screen. Defaults to true. Set it false for a
   * tile scrolled out of a `FlatList` (from `onViewableItemsChanged`), a
   * minimised call, or a screen pushed behind another. A remote video
   * nobody can see is then paused at the SFU after a short debounce and
   * costs no bandwidth or decoding; it resumes the moment the view is
   * visible again. React Native gives the SDK no way to observe this
   * itself, which the web SDK does from the `<video>` element.
   *
   * A view laid out at zero size counts as hidden too. Ignored for your own
   * camera, and when the client was created with `adaptiveStream: false`.
   */
  visible?: boolean;
}

/**
 * Renders a participant's video.
 *
 * The one part of the SDK that couldn't be shared with web. A browser
 * attaches a track to a `<video>` element; React Native has no DOM, and
 * video has to end up in a native `SurfaceView` on Android or `UIView` on
 * iOS. So `SwalvoVideoView` takes the very same `participant` object a web
 * app would hand `<ParticipantView>` and routes it to the native renderer
 * instead.
 *
 * ```tsx
 * <SwalvoVideoView participant={remote} room={room} style={{ flex: 1 }} />
 * <SwalvoVideoView participant={local} room={room} style={styles.pip} zOrder={1} />
 * ```
 *
 * No WebRTC types in the props, and none needed in your code either
 * (spec §2).
 */
export function SwalvoVideoView({
  participant,
  room,
  source = 'camera',
  style,
  objectFit = 'cover',
  mirror,
  zOrder,
  placeholder,
  visible = true,
}: SwalvoVideoViewProps) {
  // A counter, not the track itself. The SDK mutates track objects in
  // place, so storing one in state and comparing references misses updates.
  // Bumping a version on every relevant room event forces the re-read
  // below to run again.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!room) {
      return undefined;
    }

    const rerender = () => setRevision((value) => value + 1);

    // Every event that can change what ought to be on screen. Miss one and
    // you get a frozen or blank tile that only fixes itself on the next
    // unrelated render. The classic mobile video bug.
    room.on('trackSubscribed', rerender);
    room.on('trackUnsubscribed', rerender);
    room.on('trackPublished', rerender);
    room.on('trackUnpublished', rerender);
    room.on('trackMuted', rerender);
    room.on('trackUnmuted', rerender);
    room.on('localTrackPublished', rerender);
    room.on('localTrackUnpublished', rerender);
    room.on('participantJoined', rerender);
    room.on('participantLeft', rerender);

    return () => {
      // Unsubscribing on unmount is what stops a scrolled-away tile
      // holding the participant alive and re-rendering forever (spec §19).
      room.off('trackSubscribed', rerender);
      room.off('trackUnsubscribed', rerender);
      room.off('trackPublished', rerender);
      room.off('trackUnpublished', rerender);
      room.off('trackMuted', rerender);
      room.off('trackUnmuted', rerender);
      room.off('localTrackPublished', rerender);
      room.off('localTrackUnpublished', rerender);
      room.off('participantJoined', rerender);
      room.off('participantLeft', rerender);
    };
  }, [room]);

  const streamUrl = useMemo(() => {
    const track = findVideoTrack(participant, source);
    if (!track || track.isMuted) {
      return undefined;
    }
    return toStreamUrl(track);
    // `revision` is the dependency that matters. See the comment above.
  }, [participant, source, revision]);

  // Visibility for adaptive streaming. Reported per view and aggregated per
  // track (internal/view-visibility.ts), so a track shown in a grid tile and
  // a spotlight stays on while either is visible.
  const viewId = useRef<object>({}).current;
  const [hasSize, setHasSize] = useState(true);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setHasSize(width > 0 && height > 0);
  };
  const visibilityTrack = useMemo(() => findVideoTrack(participant, source), [participant, source, revision]);
  useEffect(() => {
    if (!visibilityTrack) return undefined;
    reportViewVisibility(visibilityTrack, viewId, visible && hasSize);
    return undefined;
  }, [visibilityTrack, viewId, visible, hasSize]);
  useEffect(() => {
    if (!visibilityTrack) return undefined;
    return () => withdrawView(visibilityTrack, viewId);
  }, [visibilityTrack, viewId]);

  // Identity against the room, not a type check. LocalParticipant and
  // RemoteParticipant are structurally identical, and `instanceof` can't be
  // trusted in a monorepo where Metro might resolve two copies of
  // @swalvo/rtc. With no room we can't know, so we don't guess.
  const shouldMirror = mirror ?? (source === 'camera' && room?.localParticipant === participant);

  if (!streamUrl) {
    return (
      <View style={[styles.container, style]} onLayout={onLayout}>
        {placeholder ?? null}
      </View>
    );
  }

  return (
    <RTCView
      // Keyed by the stream, so a participant swapping cameras, or a track
      // being replaced on reconnect, tears the native view down instead of
      // trying to rebind a surface that's already gone.
      key={streamUrl}
      streamURL={streamUrl}
      style={[styles.container, style]}
      objectFit={objectFit}
      mirror={shouldMirror}
      zOrder={zOrder}
      onLayout={onLayout}
    />
  );
}

function findVideoTrack(
  participant: LocalParticipant | RemoteParticipant | undefined,
  source: 'camera' | 'screenShare',
): Track | undefined {
  return participant?.tracks.find((track) => track.kind === source);
}

/**
 * Bridges a Swalvo track to the native renderer.
 *
 * `track.mediaStream` is public API on `@swalvo/rtc`, and under React
 * Native it holds a `react-native-webrtc` `MediaStream`, which carries the
 * `toURL()` the native view binds to. Going through the public surface is
 * what keeps `@swalvo/rtc` unmodified. The cast covers the one method
 * React Native adds that the DOM type never declares.
 */
function toStreamUrl(track: Track): string | undefined {
  const stream = track.mediaStream as (MediaStream & { toURL?: () => string }) | undefined;
  return typeof stream?.toURL === 'function' ? stream.toURL() : undefined;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#000',
    overflow: 'hidden',
  },
});
