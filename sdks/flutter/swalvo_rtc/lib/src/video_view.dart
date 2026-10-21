import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import 'dart:async';

import 'internal/adaptive_layer.dart';
import 'room.dart';
import 'types.dart';

/// Renders a participant's video.
///
/// ```dart
/// SwalvoVideoView(participant: remote, room: room)
/// ```
///
/// Rebuilds by itself as tracks are published, muted, or resubscribed;
/// pass [room] and the widget listens for you. Without a room it renders
/// once and stays put, which is right for a static thumbnail and wrong
/// for a call.
///
/// A stateful widget instead of a plain builder, because the underlying
/// renderer holds a native texture that has to be created and disposed in
/// step with the widget's own lifecycle. Getting that wrong leaks a
/// native view per rebuild (spec §19).
class SwalvoVideoView extends StatefulWidget {
  const SwalvoVideoView({
    super.key,
    required this.participant,
    this.room,
    this.kind = SwalvoTrackKind.camera,
    this.fit = SwalvoVideoFit.cover,
    this.mirror,
    this.placeholder,
    this.visible = true,
  });

  /// Whose video to show. Local or remote: the widget doesn't care.
  final SwalvoParticipant? participant;

  /// Pass the room to make the widget follow track changes.
  final SwalvoRoom? room;

  /// `camera` (default) or `screenShare`.
  final SwalvoTrackKind kind;

  final SwalvoVideoFit fit;

  /// Mirrors horizontally. Defaults to true for the local camera, which
  /// is what a user expects of their own preview, and false otherwise.
  final bool? mirror;

  /// Shown when there is no video: camera off, muted, or not yet
  /// published. Defaults to a plain black surface.
  final Widget? placeholder;

  /// Whether this view is actually on screen. Defaults to true.
  ///
  /// Flutter has no built-in way for a widget to learn that it was scrolled
  /// out of a list, covered by another route, or sits in a tab that is not
  /// showing, so the app says so here — from a `visibility_detector`
  /// callback, a `PageView` index, an app-lifecycle listener, whatever it
  /// already has. A view laid out at zero size counts as hidden on its own.
  ///
  /// With `adaptiveStream` on, a remote video whose every view has been
  /// hidden for half a second is paused at the SFU (layer `off`,
  /// phase2-media-contracts §4) and resumes the moment one is shown again.
  /// The track stays subscribed throughout; only forwarding stops. If the
  /// same video is in several views, it keeps flowing while any of them is
  /// visible. Ignored for the local preview and with adaptive streaming off.
  final bool visible;

  @override
  State<SwalvoVideoView> createState() => _SwalvoVideoViewState();
}

enum SwalvoVideoFit { cover, contain }

class _SwalvoVideoViewState extends State<SwalvoVideoView> {
  SwalvoRenderableTrack? _track;

  /// The renderer owns a native texture, so it is created and disposed in
  /// step with this State, not per build. Rebuilding one per frame
  /// leaks a native view each time (spec §19).
  final _renderer = rtc.RTCVideoRenderer();
  bool _rendererReady = false;

  @override
  void initState() {
    super.initState();
    widget.room?.addListener(_syncTrack);
    _track = _resolveTrack();
    unawaited(_initRenderer());
  }

  Future<void> _initRenderer() async {
    await _renderer.initialize();
    if (!mounted) {
      await _renderer.dispose();
      return;
    }
    setState(() {
      _rendererReady = true;
      _renderer.srcObject = _track?.stream;
    });
  }

  @override
  void didUpdateWidget(SwalvoVideoView oldWidget) {
    super.didUpdateWidget(oldWidget);

    // The room can change when a screen is reused across calls. Moving
    // the listener is what stops the widget listening to a disposed room
    //, which throws on the next notification.
    if (oldWidget.room != widget.room) {
      oldWidget.room?.removeListener(_syncTrack);
      widget.room?.addListener(_syncTrack);
    }

    // Unconditional, deliberately. The obvious guard —
    // `oldWidget.participant != widget.participant` — is worse than no
    // guard at all here, because [SwalvoParticipant] compares by identity
    // alone: two snapshots of the same person are `==` however different
    // what they are publishing is. A rebuild carrying the snapshot in
    // which somebody's camera finally appears therefore looked like no
    // change, and the tile stayed on its placeholder until some unrelated
    // event happened to nudge it. [_syncTrack] is already a no-op when
    // the resolved track hasn't actually changed, so there is nothing to
    // save by guessing.
    _syncTrack();
    // `visible` can change with nothing else changing, and a view that has
    // just been hidden is not necessarily laid out again to notice.
    if (oldWidget.room != widget.room) _releaseVisibility(oldWidget.room);
    _reportVisibility();
  }

  @override
  void dispose() {
    // Without this the room keeps a reference to a dead State object,
    // and every scrolled-away tile stays subscribed forever.
    widget.room?.removeListener(_syncTrack);
    // A pending layer request outliving the widget would fire against a
    // disposed State and, worse, ask for a layer for a tile that is no
    // longer on screen.
    _resizeDebounce?.cancel();
    // The view is gone, so it no longer counts towards keeping the video
    // flowing. The last view of a track leaving pauses it (after the same
    // delay as hiding), which is what makes navigating away from a call
    // screen stop costing data.
    _releaseVisibility(widget.room);
    // Detached before disposing: a renderer disposed while still bound to
    // a live stream can outlive its texture on the platform side.
    _renderer.srcObject = null;
    unawaited(_renderer.dispose());
    super.dispose();
  }

  void _syncTrack() {
    if (!mounted) return;
    final next = _resolveTrack();
    if (next?.trackId == _track?.trackId) return;

    setState(() {
      _track = next;
      if (_rendererReady) {
        _renderer.srcObject = next?.stream;
      }
    });
    // A different track (or none): the old one loses this view's vote and
    // the new one gains it.
    _releaseVisibility(widget.room);
    _reportVisibility();
  }

  /// The subscription this view last reported visibility for, so it can
  /// withdraw from exactly that one.
  ({String participantId, String trackId})? _visibilityKey;
  bool? _reportedVisible;
  double? _laidOutWidth;

  /// Tells the room whether this view is showing its remote video.
  ///
  /// Visible means [SwalvoVideoView.visible] and a non-zero laid-out width.
  /// Only a change is reported, and never from inside a build: the room
  /// may send a signaling message as a result.
  void _reportVisibility() {
    final room = widget.room;
    final participant = _currentParticipant();
    final track = _track;
    if (room == null ||
        participant == null ||
        participant.isLocal ||
        track == null) {
      return;
    }
    final width = _laidOutWidth;
    final visible = widget.visible && (width == null || width > 0);
    final key = (participantId: participant.identity, trackId: track.trackId);
    if (key == _visibilityKey && visible == _reportedVisible) return;
    if (_visibilityKey != null && key != _visibilityKey) {
      _releaseVisibility(room);
    }
    _visibilityKey = key;
    _reportedVisible = visible;
    scheduleMicrotask(() {
      if (!mounted || _visibilityKey != key) return;
      room.setViewVisibility(key.participantId, key.trackId, this, visible);
    });
  }

  void _releaseVisibility(SwalvoRoom? room) {
    final key = _visibilityKey;
    if (key == null) return;
    _visibilityKey = null;
    _reportedVisible = null;
    room?.removeView(key.participantId, key.trackId, this);
  }

  SwalvoRenderableTrack? _resolveTrack() =>
      _currentParticipant()?.videoTrackFor(widget.kind);

  /// The room's *current* snapshot of whoever [SwalvoVideoView.participant]
  /// names, rather than the snapshot the caller happened to pass.
  ///
  /// [SwalvoParticipant] is a value object: it records what someone was
  /// publishing at one moment and never updates. That is fine for the
  /// widget's own build, which the application re-runs with a fresh
  /// roster, but [_syncTrack] also runs from the room's own
  /// [ChangeNotifier] — and [SwalvoRoom] notifies *synchronously*, before
  /// the microtask that delivers the new roster on `participantChanges`
  /// has run. So at that moment `widget.participant` is still the previous
  /// snapshot, with no camera track on it, and resolving from it found
  /// nothing at exactly the instant there was finally something to find.
  ///
  /// Re-reading from the room closes that window: the roster behind
  /// `room.participants` is already updated by the time listeners are
  /// notified, so the track is visible on the first notification rather
  /// than whenever the next unrelated one happens to arrive.
  ///
  /// Returns null once the room no longer lists them — they have left, and
  /// a tile that kept rendering their last frame would be claiming
  /// somebody is still in the call.
  SwalvoParticipant? _currentParticipant() {
    final participant = widget.participant;
    final room = widget.room;
    if (participant == null || room == null) return participant;

    for (final current in room.participants) {
      if (current.identity == participant.identity &&
          current.isLocal == participant.isLocal) {
        return current;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final track = _track;

    if (track == null || !_rendererReady) {
      return widget.placeholder ?? const ColoredBox(color: Colors.black);
    }

    final mirror = widget.mirror ??
        (widget.kind == SwalvoTrackKind.camera &&
            (widget.participant?.isLocal ?? false));

    // Reports its own size to the room so adaptive streaming can ask for
    // a layer that matches what is actually on screen: the "viewport"
    // input spec §15 lists. A thumbnail asking for 1080p is the exact
    // waste this avoids.
    return LayoutBuilder(
      builder: (context, constraints) {
        _requestLayerFor(constraints);
        final width = constraints.maxWidth;
        if (width.isFinite && width != _laidOutWidth) {
          _laidOutWidth = width;
          _reportVisibility();
        }
        return rtc.RTCVideoView(
          _renderer,
          // Keyed by the track id so replacing a track (a camera switch,
          // or a resubscribe after reconnect) builds a fresh view rather
          // than rebinding a texture that has already gone.
          key: ValueKey(track.trackId),
          objectFit: widget.fit == SwalvoVideoFit.cover
              ? rtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitCover
              : rtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
          mirror: mirror,
        );
      },
    );
  }

  /// Asks for the smallest layer that still covers this view.
  ///
  /// A preference, not a command: the SFU will not hand over a layer the
  /// publisher is not sending. Only sent for remote tracks: asking for a
  /// layer of your own camera would be asking the server to change what
  /// you are sending.
  ///
  /// Measured in logical pixels, the same unit the web SDK measures an
  /// element in, so a tile of a given size picks the same layer on both.
  void _requestLayerFor(BoxConstraints constraints) {
    final room = widget.room;
    // The room's current snapshot, for the same reason [_resolveTrack]
    // uses it: `requestLayerAutomatically` looks the track up on whatever
    // participant it is handed, so a stale one finds no track and the
    // request is silently dropped.
    final participant = _currentParticipant();
    if (room == null || participant == null || participant.isLocal) return;

    final width = constraints.maxWidth;
    if (!width.isFinite || width <= 0) return;

    final layer = adaptiveLayerFor(
      logicalPixels: width,
      current: _requestedLayer,
    );
    if (layer == _requestedLayer) return;

    // Debounced rather than sent from the layout pass. A resize animation,
    // a rotation, or a grid reflowing as somebody joins all produce a burst
    // of constraint changes, and a message per frame is both pointless and
    // a real step towards the connection's rate limit. Layout must also
    // stay free of side effects: sending from inside build() is how a
    // "setState during build" lands on somebody's screen.
    _pendingLayer = layer;
    _resizeDebounce?.cancel();
    _resizeDebounce = Timer(_layerChangeDebounce, () {
      if (!mounted) return;
      final next = _pendingLayer;
      if (next == null || next == _requestedLayer) return;
      // Resolved again rather than captured: a quarter of a second is
      // long enough for the roster to have moved on, and the snapshot
      // taken during layout would by then find no track to ask about.
      final target = _currentParticipant();
      if (target == null) return;
      _requestedLayer = next;
      room.requestLayerAutomatically(target, widget.kind, next);
    });
  }

  SwalvoVideoLayer? _requestedLayer;
  SwalvoVideoLayer? _pendingLayer;
  Timer? _resizeDebounce;
}

/// How long a tile has to hold its new size before the layer request goes
/// out. Long enough to swallow a resize animation, short enough that a
/// genuine layout change is served well inside a second.
const _layerChangeDebounce = Duration(milliseconds: 250);
